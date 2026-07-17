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

// ===========================================================================================
// Cloud Worker. Summarization, poster generation and durable storage all live in a Cloudflare
// Worker + Durable Object now, so no native-messaging host is required to run this extension.
// The endpoint + token are set once in the options page.
// ===========================================================================================

const WORKER_DEFAULTS = { base: 'https://summarizer.goldenoreo.workers.dev', token: '' };

async function workerCreds() {
  const s = await chrome.storage.local.get(['worker:base', 'worker:token']);
  return {
    base: (s['worker:base'] || WORKER_DEFAULTS.base).replace(/\/$/, ''),
    token: s['worker:token'] || WORKER_DEFAULTS.token,
  };
}

async function api(path, opts = {}) {
  const { base, token } = await workerCreds();
  if (!base || !token) throw new Error('Worker endpoint/token not configured (see extension options)');
  const res = await fetch(`${base}${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
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
// Deltas now arrive from the Worker's SSE stream rather than a native port. Everything
// downstream is unchanged: this function still accumulates into the job cache and relays the
// same updateSummary / summaryComplete / summaryError messages, so content-dual.js is
// untouched. The DURABLE copy of the generation lives in the Durable Object — this local job
// is only a render cache now, and the summary completes and persists in D1 even if this
// service worker is torn down mid-stream.
async function streamModel(job, tab, modelId, { isFollowup, prompt } = {}) {
  const modelConfig = findModel(modelId);
  const m = ensureModel(job, modelId);
  m.inProgress = true;
  m.complete = false;
  m.usedModel = metaOf(modelConfig);
  job.activeModelId = modelId;

  const { base, token } = await workerCreds();
  if (!base || !token) {
    m.inProgress = false;
    await safeSend(tab, { action: 'summaryError', url: job.url, modelId,
      error: 'Worker not configured — set the endpoint and token in the extension options.' });
    return;
  }

  const jobId = encodeURIComponent(job.url);
  const started = Date.now();

  try {
    // Kick the job off (or continue it), then subscribe. The POST returns as soon as the DO
    // has started work — it does NOT wait for the generation, which is what lets the summary
    // survive this tab (or this whole service worker) going away.
    if (isFollowup) {
      const last = m.messages[m.messages.length - 1];
      await api(`/api/job/${jobId}/followup`, { method: 'POST',
        body: JSON.stringify({ question: last?.content ?? '' }) });
    } else if (job.startedRemote) {
      await api(`/api/job/${jobId}/regenerate`, { method: 'POST',
        body: JSON.stringify({ modelId, prompt: prompt ?? job.prompt }) });
    } else {
      await api('/api/summarize', { method: 'POST', body: JSON.stringify({
        url: job.fullUrl || job.url, title: job.title,
        kind: job.isTranscript ? 'video' : 'page', videoId: job.videoId,
        text: job.sourceText, modelId, prompt: prompt ?? job.prompt,
      }) });
      job.startedRemote = true;
    }

    const res = await fetch(`${base}/api/job/${jobId}/stream`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok || !res.body) throw new Error(`stream ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';

      for (const f of frames) {
        const ev = /^event: (.+)$/m.exec(f)?.[1];
        const dataLine = /^data: (.+)$/m.exec(f)?.[1];
        if (!ev || !dataLine) continue;
        let d; try { d = JSON.parse(dataLine); } catch { continue; }

        if (ev === 'snapshot') {
          // Reconnect: adopt whatever the DO already has so a panel that attaches late
          // isn't missing the head of the summary.
          if (d.content && d.content.length > m.streaming.length) m.streaming = d.content;
        } else if (ev === 'delta' && d.modelId === modelId) {
          m.streaming += d.text;
          schedulePersist(job.url);
          await safeSend(tab, { action: 'updateSummary', url: job.url, modelId,
            delta: d.text, streamingLength: m.streaming.length });
        } else if (ev === 'complete' && d.modelId === modelId) {
          m.inProgress = false;
          m.complete = true;
          m.duration = d.durationMs ?? Date.now() - started;
          if (d.usedModel) m.usedModel = d.usedModel;
          m.messages.push({ role: 'assistant', content: d.content });
          m.streaming = '';
          await persistJob(job.url);
          await safeSend(tab, { action: 'summaryComplete', url: job.url, modelId,
            message: { role: 'assistant', content: d.content }, duration: m.duration });
          reader.cancel().catch(() => {});
          return;
        } else if (ev === 'error' && d.modelId === modelId) {
          throw new Error(d.error);
        } else if (ev === 'poster' && d.state === 'complete') {
          job.posterKey = d.key;
          await persistJob(job.url);
          await safeSend(tab, { action: 'posterReady', url: job.url, key: d.key });
        }
      }
    }
  } catch (e) {
    m.inProgress = false;
    m.streaming = '';
    // On a failed followup, drop the user turn we optimistically pushed so a retry is clean.
    if (isFollowup && m.messages.length && m.messages[m.messages.length - 1].role === 'user') {
      m.messages.pop();
    }
    await persistJob(job.url);
    await safeSend(tab, { action: 'summaryError', url: job.url, modelId, error: String(e.message || e) });
  }
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
    // The transcript comes from the PAGE, not a native host. YouTube blocks transcript
    // fetching by ASN, so this could never run in the Worker — but it never needed the
    // laptop's Python host either: the content script is the real YouTube web client, with
    // the session and residential IP that make the request legitimate. If the caller already
    // scraped it (the common case — youtube-content.js extracts before messaging), use that.
    const transcript = request.transcript || await requestTranscriptFromTab(tab, videoId);
    if (!transcript || !transcript.trim()) throw new Error('Empty transcript');
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
      error: `Couldn't read this video's transcript: ${error.message}`
    });
  }
}

/**
 * Ask a tab's content script to open YouTube's transcript panel and scrape it.
 * If the tab isn't the watch page for this video (the feed-tile case), open the video in a
 * background tab, scrape, and close it. This is the least elegant part of the design and it
 * is unavoidable: the transcript is lazy-loaded when YouTube's own player opens the panel and
 * mints a proof-of-origin token, so you have to actually BE on the watch page. The upside is
 * that the job then runs entirely in the cloud, so a feed-tile click means "queue this" and
 * you read it on the dashboard.
 */
async function requestTranscriptFromTab(tab, videoId) {
  const onWatchPage = tab?.url?.includes(`watch?v=${videoId}`);
  if (onWatchPage && tab?.id) return scrapeFromTab(tab.id);

  const bg = await chrome.tabs.create({ url: `https://www.youtube.com/watch?v=${videoId}`, active: false });
  try {
    await waitForTabReady(bg.id);
    return await scrapeFromTab(bg.id);
  } finally {
    chrome.tabs.remove(bg.id).catch(() => {});
  }
}

async function scrapeFromTab(tabId) {
  const r = await chrome.tabs.sendMessage(tabId, { action: 'extractTranscript' });
  if (!r?.ok) {
    throw new Error(r?.reason === 'no-captions'
      ? 'This video has no captions'
      : (r?.detail || 'transcript extraction failed'));
  }
  return r.text;
}

function waitForTabReady(tabId, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { chrome.tabs.onUpdated.removeListener(fn); reject(new Error('Timed out loading the video page')); }, timeoutMs);
    const fn = (id, info) => {
      if (id !== tabId || info.status !== 'complete') return;
      clearTimeout(t);
      chrome.tabs.onUpdated.removeListener(fn);
      // The content script still has to register its listener after 'complete'.
      setTimeout(resolve, 800);
    };
    chrome.tabs.onUpdated.addListener(fn);
  });
}

// NOTE: openInClaudeCode / openVideoInClaudeCode / extractTranscriptText were deleted with the
// native hosts. Claude Code was only ever the runtime that could reach fal to render the
// explain-viz poster; the Worker now calls fal directly, so the 🖥️ button has no job left and
// the two buttons collapse into one ✨.

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

  // Posters are plain HTTPS URLs off R2 now — no native call, no data-URL round trip, and no
  // sips downscale (that existed only to squeeze a 4K image under the ~1MB native-message cap).
  if (request.action === 'getPoster') {
    (async () => {
      try {
        const { base } = await workerCreds();
        const nurl = normUrl(request.url || '');
        const job = jobs[nurl] || await loadJob(nurl);
        const key = request.key || job?.posterKey;
        if (!key) { sendResponse({ type: 'none' }); return; }
        sendResponse({ type: 'poster', url: `${base}/poster/${encodeURIComponent(key)}` });
      } catch (e) { sendResponse({ type: 'error', error: String(e.message || e) }); }
    })();
    return true; // async
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
