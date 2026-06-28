// background.js

// Try to load config.js
try {
  importScripts('config.js');
} catch (e) {
  console.warn('config.js not found. Using default values.');
}

// Load API configuration from config.js
let YOUTUBE_TRANSCRIPT_API_URL = '';
let YOUTUBE_TRANSCRIPT_API_KEY = '';

// Check if CONFIG is defined and has the required keys
if (typeof CONFIG !== 'undefined') {
  YOUTUBE_TRANSCRIPT_API_URL = CONFIG.YOUTUBE_TRANSCRIPT_API_URL || '';
  YOUTUBE_TRANSCRIPT_API_KEY = CONFIG.YOUTUBE_TRANSCRIPT_API_KEY || '';
} else {
  console.error('CONFIG not found. Please create config.js from config.example.js');
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

    for (const model of aiConfig.models) {
      if (!model.id || !model.litellm_model) {
        throw new Error(`Model missing required fields: ${JSON.stringify(model)}`);
      }
      if (!model.litellm_model.includes('/')) {
        throw new Error(`Invalid litellm_model format "${model.litellm_model}" - must be "provider/model-name"`);
      }
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

// Call on extension load
loadAIConfig();

// Helper to safely send messages to tabs
async function safeSend(tab, msg) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Ignore errors (tab navigated, closed, or no listener)
  }
}

// Clean up old summaries (older than 30 days)
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

// Clean up on startup
cleanupOldSummaries();

// Dual summary using config-driven models
async function getDualSummary(text, tab, transcript = null) {
  // Tell content script to initialize state with config
  await safeSend(tab, {
    action: 'initSummary',
    originalText: text,
    transcript: transcript,
    config: aiConfig
  });

  // Fire all models in parallel
  aiConfig.models.forEach(modelConfig => {
    const port = chrome.runtime.connectNative('com.localai');

    // Use per-model prompt with fallback to defaultPrompt
    const prompt = modelConfig.prompt || aiConfig.defaultPrompt;
    const userContent = transcript
      ? `${prompt}[Transcript]\n${transcript}`
      : `${prompt}${text}`;

    const initialMessage = { role: 'user', content: userContent };

    // Send initial message to content script for this model
    safeSend(tab, {
      action: 'setInitialMessage',
      modelId: modelConfig.id,
      initialMessage: initialMessage
    });

    port.onMessage.addListener(async (response) => {
      if (response.type === 'delta') {
        await safeSend(tab, {
          action: 'updateSummary',
          modelId: response.modelId,
          delta: response.delta
        });
      } else if (response.type === 'complete') {
        await safeSend(tab, {
          action: 'summaryComplete',
          modelId: response.modelId,
          duration: response.duration_ms,
          response: response.response
        });
        port.disconnect();
      } else if (response.type === 'error') {
        await safeSend(tab, {
          action: 'summaryError',
          modelId: response.modelId,
          error: response.error
        });
        port.disconnect();
      }
    });

    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        console.error('Native messaging error:', chrome.runtime.lastError);
      }
    });

    port.postMessage({
      action: 'summarize',
      modelId: modelConfig.id,
      modelConfig: modelConfig,
      messages: [initialMessage]
    });
  });
}

// Handle follow-up request
async function handleFollowup(request, sender) {
  const tab = sender.tab;
  const modelConfig = aiConfig.models.find(m => m.id === request.modelId);

  if (!modelConfig) {
    await safeSend(tab, {
      action: 'summaryError',
      modelId: request.modelId,
      error: `Model ${request.modelId} not found in config`
    });
    return;
  }

  const port = chrome.runtime.connectNative('com.localai');

  port.onMessage.addListener(async (response) => {
    if (response.type === 'delta') {
      await safeSend(tab, {
        action: 'updateSummary',
        modelId: response.modelId,
        delta: response.delta
      });
    } else if (response.type === 'complete') {
      await safeSend(tab, {
        action: 'summaryComplete',
        modelId: response.modelId,
        duration: response.duration_ms,
        response: response.response
      });
      port.disconnect();
    } else if (response.type === 'error') {
      await safeSend(tab, {
        action: 'summaryError',
        modelId: response.modelId,
        error: response.error
      });
      port.disconnect();
    }
  });

  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError) {
      console.error('Native messaging error:', chrome.runtime.lastError);
    }
  });

  port.postMessage({
    action: 'followup',
    modelId: request.modelId,
    modelConfig: modelConfig,
    messages: request.messages
  });
}

// Get video transcript and summarize
async function getVideoTranscriptAndSummarize(videoId, tab) {
  try {
    const nativeResponse = await chrome.runtime.sendNativeMessage(
      'com.ytsummary',
      { video_id: videoId }
    );

    if (!nativeResponse.text || nativeResponse.text.startsWith('Error')) {
      throw new Error(nativeResponse.text || 'No transcript received');
    }

    const transcript = nativeResponse.text;
    await getDualSummary(transcript, tab, transcript);
  } catch (error) {
    console.error('Error fetching video transcript:', error);
    await safeSend(tab, {
      action: 'summaryError',
      modelId: aiConfig?.models?.[0]?.id || 'unknown',
      error: `Failed to get video transcript. Error: ${error.message}\n\nMake sure:\n1. Native host is installed\n2. Extension ID matches\n3. Python script has correct permissions`
    });
  }
}

// Open in Claude Code (via Ghostty)
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
    if (chrome.runtime.lastError) {
      console.error('Native messaging error:', chrome.runtime.lastError);
    }
  });

  port.postMessage({ action: 'openInCC', text: text, title: title, video_id: videoId, channel: channel, url: url });
}

// Open YouTube video transcript in Claude Code
async function openVideoInClaudeCode(videoId, tab, title = '', channel = '', url = '') {
  try {
    const nativeResponse = await chrome.runtime.sendNativeMessage(
      'com.ytsummary',
      { video_id: videoId }
    );

    if (!nativeResponse.text || nativeResponse.text.startsWith('Error')) {
      throw new Error(nativeResponse.text || 'No transcript received');
    }

    await openInClaudeCode(nativeResponse.text, tab, title, videoId, channel, url);
  } catch (error) {
    console.error('Error fetching video transcript for CC:', error);
    await safeSend(tab, {
      action: 'openInCCError',
      error: `Failed to get transcript: ${error.message}`
    });
  }
}

// Draft response handling (unchanged - still uses Hetzner API)
async function getDraftResponse(text, tab, instructions = '') {
  return new Promise(async (resolve) => {
    try {
      if (!YOUTUBE_TRANSCRIPT_API_URL || !YOUTUBE_TRANSCRIPT_API_KEY) {
        const errorMsg = 'API not configured for drafts';
        await safeSend(tab, { action: 'displayDraft', draft: errorMsg });
        resolve(errorMsg);
        return;
      }

      await safeSend(tab, { action: 'displayDraft', draft: '' });

      const response = await fetch(`${YOUTUBE_TRANSCRIPT_API_URL}/draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': YOUTUBE_TRANSCRIPT_API_KEY,
        },
        body: JSON.stringify({ text: text, instructions: instructions }),
      });

      if (!response.ok) throw new Error(`API request failed: ${response.status}`);

      let draft = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const data = JSON.parse(line);
            if (data.error) throw new Error(data.error);
            if (data.delta) {
              draft += data.delta;
              await safeSend(tab, { action: 'updateDraft', draft: draft });
            }
            if (data.done) break;
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }

      resolve(draft);
    } catch (error) {
      console.error('Error:', error);
      resolve('Draft generation failed.');
    }
  });
}

// Handle all message requests
function handleRequest(request, sender, sendResponse) {
  const tab = sender.tab;

  if (request.action === 'summarizeDual') {
    getDualSummary(request.text, tab);
    return true;
  }

  if (request.action === 'summarize') {
    getDualSummary(request.text, tab);
    return true;
  }

  if (request.action === 'followup') {
    handleFollowup(request, sender);
    return true;
  }

  if (request.action === 'summarizeVideo') {
    getVideoTranscriptAndSummarize(request.videoId, tab);
    return true;
  }

  if (request.action === 'openInCC') {
    openInClaudeCode(request.text, tab);
    return true;
  }

  if (request.action === 'openVideoInCC') {
    openVideoInClaudeCode(request.videoId, tab, request.title || '', request.channel || '', request.url || '');
    return true;
  }

  if (request.action === 'draft') {
    getDraftResponse(request.text, tab, request.instructions).then((draft) => {
      safeSend(tab, { action: 'displayDraft', draft: draft });
    });
    return true;
  }

  if (request.action === 'getConfig') {
    sendResponse({ config: aiConfig });
    return true;
  }

  return false;
}

// Main message listener
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!configLoaded) {
    // Queue request until config loads
    pendingRequests.push({ request, sender, sendResponse });
    return true;
  }
  return handleRequest(request, sender, sendResponse);
});
