// background.js
//
// Job-store architecture: the service worker OWNS every summary's state and persistence.
// Content scripts are thin renderers. Because accumulation + saving happen here (not in the
// page), a summary keeps generating and gets persisted even after you navigate away from the
// tab that started it — and any page can rehydrate its panel by asking for the job state.

// Try to load config.js (Claude API key etc. — no longer required now that drafts are gone,
// but importScripts is kept so an existing config.js doesn't break anything).
try {
  importScripts('config.js');
} catch (e) {
  console.warn('config.js not found. Using default values.');
}

// AI Config (loaded from ai-config.json)
let aiConfig = null;
let configLoaded = false;
let pendingRequests = [];

// Load AI config at startup
async function loadAIConfig() {
  try {
    const response = await fetch(chrome.runtime.getURL('ai-config.json'));
    aiConfig = await response.json();

    // Validate config
    if (!aiConfig.models || !Array.isArray(aiConfig.models) || aiConfig.models.length === 0) {
      throw new Error('ai-config.json must have a non-empty "models" array');
    }

    // alternateModels render no tab of their own; they are only selectable targets for the
    // model picker / "Regenerate with...". Validate them identically so a typo fails at load.
    for (const model of [...aiConfig.models, ...(aiConfig.alternateModels || [])]) {
      if (!model.id || !model.litellm_model) {
        throw new Error(`Model missing required fields: ${JSON.stringify(model)}`);
      }
      if (!model.litellm_model.includes('/')) {
        throw new Error(`Invalid litellm_model format "${model.litellm_model}" - must be "provider/model-name"`);
      }
    }

    const ids = [...aiConfig.models, ...(aiConfig.alternateModels || [])].map(m => m.id);
    if (new Set(ids).size !== ids.length) {
      throw new Error(`Duplicate model id across models/alternateModels: ${ids.join(', ')}`);
    }

    configLoaded = true;
    console.log('AI config loaded:', aiConfig.models.map(m => m.id));

    // Process any queued requests
    pendingRequests.forEach(({ request, sender, sendResponse }) => {
      handleRequest(request, sender, sendResponse);
    });
    pendingRequests = [];

  } catch (error) {
    console.error('Failed to load ai-config.json:', error);
    chrome.tabs.query({}, (tabs) => {
      tabs.forEach(tab => {
        chrome.tabs.sendMessage(tab.id, {
          action: 'configError',
          error: error.message
        }).catch(() => {});
      });
    });
  }
}

loadAIConfig();

// Helper to safely send a message to a tab. Best-effort: a summary continues in the job store
// even when there is no live tab to receive the delta (that's the whole point of this design).
async function safeSend(tab, msg) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Ignore (tab navigated, closed, or the content script isn't listening). The job keeps
    // running; the next content script to load this URL rehydrates via getPageState.
  }
}

// ===========================================================================================
// Model helpers
// ===========================================================================================

// Every model that can generate: the picker's primary models plus the alternates.
function allModels() {
  if (!aiConfig) return [];
  return [...(aiConfig.models || []), ...(aiConfig.alternateModels || [])];
}

// Resolve a model id against all models.
function findModel(id) {
  return allModels().find(m => m.id === id) || null;
}

// The default ("best") model — first entry of models[]. Used when neither an explicit modelId
// nor a remembered preference resolves.
function defaultModelId() {
  return aiConfig?.models?.[0]?.id || null;
}

// Resolve which model to summarize with. Priority: explicit request > remembered pref (set by
// the panel's model picker, stored under `pref:defaultModel`) > config default. Both the
// selection FAB and YouTube's Summarize button omit modelId, so the remembered pick applies
// everywhere without either entry point needing to know it.
async function resolvePreferredModel(explicit) {
  if (explicit && findModel(explicit)) return explicit;
  try {
    const d = await chrome.storage.local.get('pref:defaultModel');
    const pref = d['pref:defaultModel'];
    if (pref && findModel(pref)) return pref;
  } catch (e) { /* storage unavailable — fall through to default */ }
  return defaultModelId();
}

// Resolve the summarization prompt. Priority: explicit > remembered pref (set when the user
// edits the prompt in the panel) > null (startSummary then falls back to the model's own prompt
// / defaultPrompt). Returns null rather than '' so an empty pref never shadows the config prompt.
async function resolvePreferredPrompt(explicit) {
  if (explicit) return explicit;
  try {
    const d = await chrome.storage.local.get('pref:defaultPrompt');
    const pref = d['pref:defaultPrompt'];
    if (pref) return pref;
  } catch (e) { /* ignore */ }
  return null;
}

// Compact display meta for a model — the trio the UI needs to caption a summary.
function metaOf(modelConfig) {
  if (!modelConfig) return null;
  return { id: modelConfig.id, name: modelConfig.name, icon: modelConfig.icon };
}

// ===========================================================================================
// Job store — the heart of the design. One job per normalized URL, held in memory while the
// service worker is alive and mirrored to chrome.storage.local so it survives SW eviction and
// page navigation. Storage key is `summary:<origin><pathname>`.
// ===========================================================================================

const jobs = {};        // normUrl -> job
const saveTimers = {};   // normUrl -> throttle timer id

function normUrl(u) {
  try {
    const url = new URL(u);
    let key = `${url.origin}${url.pathname}`;
    // YouTube watch pages share one pathname (/watch); the video id lives in ?v=, so it must be
    // part of the key or every video would collide on one summary.
    if (/(^|\.)youtube\.com$/.test(url.hostname) && url.pathname === '/watch') {
      const v = url.searchParams.get('v');
      if (v) key += `?v=${v}`;
    }
    return key;
  } catch (e) {
    return u || '';
  }
}

function storeKey(nurl) {
  return `summary:${nurl}`;
}

// A per-model slot inside a job. `messages` is the authoritative turn list
// ([instruction, assistant-summary, user-followup, assistant, ...]); `streaming` holds the
// partial assistant text while a turn is in flight (empty when idle).
function ensureModel(job, modelId) {
  if (!job.models[modelId]) {
    job.models[modelId] = {
      messages: [],
      streaming: '',
      inProgress: false,
      complete: false,
      usedModel: metaOf(findModel(modelId)),
      duration: null
    };
  }
  return job.models[modelId];
}

function newJob({ url, fullUrl, title, sourceText, isTranscript, prompt, videoId }) {
  return {
    url,                                   // normalized (origin+pathname) — the storage key body
    fullUrl: fullUrl || url,               // exact URL, for "open page" links in history
    title: title || '',
    sourceText: (sourceText || '').slice(0, 120000),  // raw text/transcript, for regenerate & prompt-edit
    isTranscript: Boolean(isTranscript),
    videoId: videoId || '',                // set for YouTube — join key for the generated poster
    prompt: prompt || '',                  // the (possibly user-edited) summarization instruction
    activeModelId: null,                   // model currently shown / most recently generated
    models: {},                            // modelId -> per-model slot
    createdAt: Date.now(),
    timestamp: Date.now()
  };
}

// Load a job from storage into memory (used when a content script asks about a URL whose job
// isn't live — e.g. after the SW was evicted, or when browsing history from another page).
// A job reaches this path only when it's NOT in the live `jobs` map, which means no port in
// THIS worker is producing it — so any `inProgress` flag is stale (the generating worker died).
// Clear it, otherwise a rehydrated panel would spin on "Generating…" with nothing streaming.
async function loadJob(nurl) {
  const key = storeKey(nurl);
  const data = await chrome.storage.local.get(key);
  const j = data[key];
  if (!j) return null;
  Object.values(j.models || {}).forEach(m => {
    if (m.inProgress) {
      m.inProgress = false;
      // Keep a partial stream as a visible (if truncated) answer rather than dropping it.
      if (m.streaming && !(m.messages || []).some(x => x.role === 'assistant')) {
        m.messages = m.messages || [];
        m.messages.push({ role: 'assistant', content: m.streaming });
      }
      m.streaming = '';
    }
  });
  jobs[nurl] = j;
  return j;
}

async function persistJob(nurl) {
  const job = jobs[nurl];
  if (!job) return;
  job.timestamp = Date.now();
  await chrome.storage.local.set({ [storeKey(nurl)]: job });
}

// Throttle writes during streaming so a fast token stream doesn't hammer storage. A flush
// always follows on `complete`, so the throttled tail is never lost.
function schedulePersist(nurl) {
  if (saveTimers[nurl]) return;
  saveTimers[nurl] = setTimeout(() => {
    delete saveTimers[nurl];
    persistJob(nurl);
  }, 800);
}

function buildUserContent(prompt, job) {
  return job.isTranscript
    ? `${prompt}[Transcript]\n${job.sourceText}`
    : `${prompt}${job.sourceText}`;
}

// ===========================================================================================
// Streaming — connect a native port, accumulate into the job, relay best-effort to the tab.
// ===========================================================================================

// `tab` is only the *relay* target; the job accumulates regardless of whether the relay lands.
function streamModel(job, tab, modelId, { isFollowup }) {
  const modelConfig = findModel(modelId);
  const m = ensureModel(job, modelId);
  m.inProgress = true;
  m.complete = false;
  m.usedModel = metaOf(modelConfig);
  job.activeModelId = modelId;

  const port = chrome.runtime.connectNative('com.localai');

  // Idle watchdog: a stuck LiteLLM/OpenRouter call (seen in the wild — the native process blocks
  // on completion() and never yields a chunk) would otherwise spin the panel forever. Reset on
  // every delta so a slow-but-progressing generation is never killed; only true silence trips it.
  // The window is generous because a reasoning model legitimately emits nothing for 20–40s first.
  const IDLE_MS = 150000;
  let watchdog = null;
  const disarm = () => { if (watchdog) { clearTimeout(watchdog); watchdog = null; } };
  const arm = () => { disarm(); watchdog = setTimeout(onHang, IDLE_MS); };
  const onHang = async () => {
    watchdog = null;
    m.inProgress = false;
    m.streaming = '';
    if (isFollowup && m.messages.length && m.messages[m.messages.length - 1].role === 'user') m.messages.pop();
    await persistJob(job.url);
    await safeSend(tab, { action: 'summaryError', url: job.url, modelId, error: 'The model did not respond in time. Please try again.' });
    try { port.disconnect(); } catch (e) {}
  };
  arm();

  port.onMessage.addListener(async (response) => {
    if (response.type === 'delta') {
      arm();
      m.streaming += response.delta;
      schedulePersist(job.url);
      await safeSend(tab, {
        action: 'updateSummary',
        url: job.url,
        modelId,
        delta: response.delta,
        streamingLength: m.streaming.length   // lets a reconnecting panel detect gaps
      });
    } else if (response.type === 'complete') {
      disarm();
      m.inProgress = false;
      m.complete = true;
      m.duration = response.duration_ms;
      m.messages.push({ role: 'assistant', content: response.response });
      m.streaming = '';
      await persistJob(job.url);
      await safeSend(tab, {
        action: 'summaryComplete',
        url: job.url,
        modelId,
        message: { role: 'assistant', content: response.response },
        duration: response.duration_ms
      });
      port.disconnect();
    } else if (response.type === 'error') {
      disarm();
      m.inProgress = false;
      m.streaming = '';
      // On a failed followup, drop the user turn we optimistically pushed so a retry is clean.
      if (isFollowup && m.messages.length && m.messages[m.messages.length - 1].role === 'user') {
        m.messages.pop();
      }
      await persistJob(job.url);
      await safeSend(tab, {
        action: 'summaryError',
        url: job.url,
        modelId,
        error: response.error
      });
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    disarm();
    if (chrome.runtime.lastError) console.error('Native messaging error:', chrome.runtime.lastError);
  });

  port.postMessage({
    action: isFollowup ? 'followup' : 'summarize',
    modelId,
    modelConfig,
    messages: m.messages
  });
}

// Start (or restart) a page's summary from scratch. Creates a fresh job, so re-summarizing a
// page replaces its prior job for that URL.
function startSummary({ url, title, sourceText, isTranscript, videoId, tab, modelId, prompt }) {
  const nurl = normUrl(url);
  const model = findModel(modelId) || aiConfig.models[0];
  modelId = model.id;
  prompt = prompt || model.prompt || aiConfig.defaultPrompt;

  const job = newJob({ url: nurl, fullUrl: url, title, sourceText, isTranscript, prompt, videoId });
  jobs[nurl] = job;

  const m = ensureModel(job, modelId);
  m.messages = [{ role: 'user', content: buildUserContent(prompt, job) }];
  m.streaming = '';
  m.inProgress = true;
  m.complete = false;
  job.activeModelId = modelId;

  safeSend(tab, {
    action: 'initSummary',
    url: nurl,
    title: job.title,
    modelId,
    prompt,
    usedModel: metaOf(model),
    config: aiConfig
  });

  streamModel(job, tab, modelId, { isFollowup: false });
  persistJob(nurl);   // persist at once so an in-progress summary shows in history immediately
}

// Regenerate the active summary with a (possibly different) model and/or a (possibly edited)
// prompt. Reuses the job's stored source text.
async function handleRegenerate(request, tab) {
  const nurl = normUrl(request.url || tab?.url);
  const job = jobs[nurl] || await loadJob(nurl);
  if (!job || !job.sourceText) {
    await safeSend(tab, { action: 'summaryError', url: nurl, modelId: request.modelId, error: 'Nothing to regenerate — re-run the summary.' });
    return;
  }

  const model = findModel(request.modelId) || findModel(job.activeModelId) || aiConfig.models[0];
  const modelId = model.id;
  const prompt = (request.prompt != null && request.prompt !== '') ? request.prompt : (job.prompt || aiConfig.defaultPrompt);
  job.prompt = prompt;

  const m = ensureModel(job, modelId);
  m.messages = [{ role: 'user', content: buildUserContent(prompt, job) }];
  m.streaming = '';
  m.inProgress = true;
  m.complete = false;
  job.activeModelId = modelId;

  await safeSend(tab, { action: 'regenStart', url: nurl, modelId, prompt, usedModel: metaOf(model) });
  streamModel(job, tab, modelId, { isFollowup: false });
  schedulePersist(nurl);
}

// Follow-up question against the active model's conversation.
async function handleFollowup(request, tab) {
  const nurl = normUrl(request.url || tab?.url);
  const job = jobs[nurl] || await loadJob(nurl);
  if (!job) return;

  const modelId = findModel(request.modelId)?.id || job.activeModelId || defaultModelId();
  const m = ensureModel(job, modelId);
  m.messages.push({ role: 'user', content: request.question });
  m.streaming = '';
  m.inProgress = true;
  m.complete = false;
  job.activeModelId = modelId;

  await safeSend(tab, { action: 'followupStart', url: nurl, modelId, question: request.question });
  streamModel(job, tab, modelId, { isFollowup: true });
  schedulePersist(nurl);
}

// Return a URL's full job state so a freshly-loaded panel can rehydrate (features: resume live
// stream, "this page is already summarized", reopen saved summary).
async function handleGetPageState(request, sendResponse) {
  const nurl = normUrl(request.url);
  const job = jobs[nurl] || await loadJob(nurl);
  if (!job) {
    sendResponse({ exists: false });
    return;
  }
  sendResponse({
    exists: true,
    url: job.url,
    fullUrl: job.fullUrl,
    title: job.title,
    prompt: job.prompt,
    activeModelId: job.activeModelId,
    isTranscript: job.isTranscript,
    videoId: job.videoId,
    hasSource: Boolean(job.sourceText),
    models: job.models,
    timestamp: job.timestamp
  });
}

// List every saved summary for the history view.
async function handleListSummaries(sendResponse) {
  const all = await chrome.storage.local.get(null);
  const summaries = Object.entries(all)
    .filter(([k]) => k.startsWith('summary:'))
    .map(([k, v]) => {
      const activeId = v.activeModelId;
      const am = v.models?.[activeId];
      const summaryMsg = (am?.messages || []).find(x => x.role === 'assistant');
      return {
        url: v.url || k.slice('summary:'.length),
        fullUrl: v.fullUrl,
        title: v.title,
        timestamp: v.timestamp,
        activeModelId: activeId,
        modelName: am?.usedModel?.name,
        modelIcon: am?.usedModel?.icon,
        snippet: (summaryMsg?.content || '').replace(/[#*`>_]/g, '').slice(0, 140).trim(),
        videoId: v.videoId,
        isTranscript: v.isTranscript,
        inProgress: Boolean(am?.inProgress)
      };
    })
    .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  sendResponse({ summaries });
}

// ===========================================================================================
// YouTube transcript fetching (unchanged native protocol) + Claude Code opener (unchanged).
// ===========================================================================================

async function getVideoTranscriptAndSummarize(request, tab) {
  const videoId = request.videoId;
  const url = request.url || tab?.url;
  const nurl = normUrl(url);
  const model = findModel(request.modelId) || aiConfig.models[0];
  const prompt = request.prompt || model.prompt || aiConfig.defaultPrompt;
  const title = request.title || tab?.title || '';

  // Create + persist a placeholder job right away (before the transcript exists) so the item
  // shows up in history immediately as "generating", and open the panel in a "fetching" state so
  // there's no dead time between the click and visible feedback.
  const early = newJob({ url: nurl, fullUrl: url, title, sourceText: '', isTranscript: true, prompt, videoId });
  const em = ensureModel(early, model.id);
  em.inProgress = true;
  early.activeModelId = model.id;
  jobs[nurl] = early;
  persistJob(nurl);

  await safeSend(tab, {
    action: 'initSummary',
    url: nurl,
    title,
    modelId: model.id,
    prompt,
    usedModel: metaOf(model),
    config: aiConfig,
    phase: 'transcript'
  });

  try {
    const nativeResponse = await chrome.runtime.sendNativeMessage('com.ytsummary', { video_id: videoId });
    const transcript = extractTranscriptText(nativeResponse);
    // Replaces the placeholder job for this URL with the real one (same key), now with source.
    startSummary({ url, title, sourceText: transcript, isTranscript: true, videoId, tab, modelId: model.id, prompt });
  } catch (error) {
    console.error('Error fetching video transcript:', error);
    // Drop the placeholder so a failed fetch doesn't leave a frozen "generating" item in history.
    delete jobs[nurl];
    chrome.storage.local.remove(storeKey(nurl));
    await safeSend(tab, {
      action: 'summaryError',
      url: nurl,
      modelId: model.id,
      error: `Failed to get video transcript. Error: ${error.message}\n\nMake sure:\n1. Native host is installed\n2. Extension ID matches\n3. Python script has correct permissions`
    });
  }
}

// Open in Claude Code (via Superconductor / Ghostty fallback in the native host).
async function openInClaudeCode(text, tab, title = '', videoId = '', channel = '', url = '') {
  const port = chrome.runtime.connectNative('com.localai');
  port.onMessage.addListener(async (response) => {
    if (response.type === 'complete' && response.action === 'openInCC') {
      await safeSend(tab, { action: 'openInCCComplete', filepath: response.filepath });
      port.disconnect();
    } else if (response.type === 'error') {
      await safeSend(tab, { action: 'openInCCError', error: response.error });
      port.disconnect();
    }
  });
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) console.error('Native messaging error:', chrome.runtime.lastError);
  });
  port.postMessage({ action: 'openInCC', text, title, video_id: videoId, channel, url });
}

/** Parse com.ytsummary response; throw if host returned a failure string. */
function extractTranscriptText(nativeResponse) {
  const text = nativeResponse?.text;
  if (!text || typeof text !== 'string') {
    throw new Error('No transcript received');
  }
  // Host prefixes all failures with "Error:" (also accept legacy "yt-dlp error:").
  const trimmed = text.trim();
  if (
    trimmed.startsWith('Error:') ||
    trimmed.startsWith('Error ') ||
    trimmed.startsWith('yt-dlp error:') ||
    /^No subtitles available/i.test(trimmed) ||
    /^Could not extract transcript/i.test(trimmed)
  ) {
    throw new Error(trimmed);
  }
  if (trimmed.length < 20) {
    throw new Error(`Transcript too short (${trimmed.length} chars) — video may lack captions`);
  }
  return text;
}

async function openVideoInClaudeCode(videoId, tab, title = '', channel = '', url = '') {
  try {
    const nativeResponse = await chrome.runtime.sendNativeMessage('com.ytsummary', { video_id: videoId });
    const transcript = extractTranscriptText(nativeResponse);
    await openInClaudeCode(transcript, tab, title, videoId, channel, url);
  } catch (error) {
    console.error('Error fetching video transcript for CC:', error);
    await safeSend(tab, { action: 'openInCCError', error: `Failed to get transcript: ${error.message}` });
  }
}

// Clean up summaries older than 30 days on startup.
async function cleanupOldSummaries() {
  const allItems = await chrome.storage.local.get(null);
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  for (const key in allItems) {
    if (key.startsWith('summary:') || key.startsWith('session:')) {
      const item = allItems[key];
      if (item.timestamp && item.timestamp < thirtyDaysAgo) {
        await chrome.storage.local.remove(key);
      }
    }
  }
}
cleanupOldSummaries();

// ===========================================================================================
// Message routing
// ===========================================================================================

function handleRequest(request, sender, sendResponse) {
  const tab = sender.tab;

  if (request.action === 'summarizeDual' || request.action === 'summarize') {
    Promise.all([resolvePreferredModel(request.modelId), resolvePreferredPrompt(request.prompt)])
      .then(([modelId, prompt]) => {
        startSummary({
          url: request.url || tab?.url,
          title: request.title || tab?.title || '',
          sourceText: request.text,
          isTranscript: false,
          tab,
          modelId,
          prompt
        });
      });
    return true;
  }

  if (request.action === 'summarizeVideo') {
    Promise.all([resolvePreferredModel(request.modelId), resolvePreferredPrompt(request.prompt)])
      .then(([modelId, prompt]) => {
        getVideoTranscriptAndSummarize({ ...request, modelId, prompt }, tab);
      });
    return true;
  }

  if (request.action === 'followup') {
    handleFollowup(request, tab);
    return true;
  }

  if (request.action === 'regenerate') {
    handleRegenerate(request, tab);
    return true;
  }

  if (request.action === 'getPageState') {
    handleGetPageState(request, sendResponse);
    return true; // async
  }

  if (request.action === 'listSummaries') {
    handleListSummaries(sendResponse);
    return true; // async
  }

  // Return a job's raw source text (selection / transcript) so the panel's copy button can copy
  // it — the content script no longer holds it, the job store does.
  if (request.action === 'getSource') {
    (async () => {
      const nurl = normUrl(request.url);
      const job = jobs[nurl] || await loadJob(nurl);
      sendResponse({ text: (job && job.sourceText) || '', isTranscript: Boolean(job && job.isTranscript) });
    })();
    return true; // async
  }

  if (request.action === 'deleteSummary') {
    const nurl = normUrl(request.url);
    delete jobs[nurl];
    chrome.storage.local.remove(storeKey(nurl), () => sendResponse({ ok: true }));
    return true; // async
  }

  if (request.action === 'openInCC') {
    openInClaudeCode(request.text, tab, request.title || '', request.videoId || '', request.channel || '', request.url || '');
    return true;
  }

  if (request.action === 'openVideoInCC') {
    openVideoInClaudeCode(request.videoId, tab, request.title || '', request.channel || '', request.url || '');
    return true;
  }

  // Which videos are already summarized / have a graphic (one-shot native call).
  if (request.action === 'getSummaryStatus') {
    chrome.runtime.sendNativeMessage('com.localai', { action: 'status' }, (resp) => {
      sendResponse(resp && resp.type === 'status' ? resp : { summarized: [], graphics: {} });
    });
    return true; // async
  }

  // Fetch a generated poster as a data URL so the panel can show it inline. Pass the native
  // response through unchanged so the panel sees `too_large` + `path` (for its open-in-Preview
  // fallback), not just a bare error.
  if (request.action === 'getPoster') {
    chrome.runtime.sendNativeMessage('com.localai', {
      action: 'getGraphic',
      video_id: request.videoId || '',
      graphic_path: request.graphicPath || ''
    }, (resp) => {
      if (chrome.runtime.lastError || !resp) { sendResponse({ type: 'error', error: 'native_error' }); return; }
      sendResponse(resp);
    });
    return true; // async
  }

  // Open a previously-generated graphic in the OS viewer (Preview on macOS).
  if (request.action === 'openGraphic') {
    chrome.runtime.sendNativeMessage('com.localai', { action: 'openGraphic', graphic_path: request.graphicPath }, () => {
      if (chrome.runtime.lastError) console.error('openGraphic native error:', chrome.runtime.lastError);
    });
    return false;
  }

  if (request.action === 'getConfig') {
    sendResponse({ config: aiConfig });
    return true;
  }

  return false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!configLoaded) {
    // Queue until config loads, then replay.
    pendingRequests.push({ request, sender, sendResponse });
    return true;
  }
  return handleRequest(request, sender, sendResponse);
});

// Toolbar icon → open the panel on the active tab (its own summary if the page has one, else the
// history list). This is the always-available entry point to past summaries; the content script
// decides what to show.
chrome.action.onClicked.addListener((tab) => {
  safeSend(tab, { action: 'togglePanel' });
});
