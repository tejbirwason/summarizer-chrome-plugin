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

// Helper functions for summary storage
async function saveSummary(summaryKey, summaryData) {
  await chrome.storage.local.set({ [summaryKey]: summaryData });
}

async function getSummaryCache(summaryKey) {
  const result = await chrome.storage.local.get(summaryKey);
  return result[summaryKey];
}

async function clearSummaryCache(summaryKey) {
  await chrome.storage.local.remove(summaryKey);
}

// Helper functions for conversation continuations (finds summary by conversationId)
async function getConversation(conversationId) {
  // Search through all summaries to find one matching this conversationId
  const allItems = await chrome.storage.local.get(null);
  for (const key in allItems) {
    if (key.startsWith('summary:')) {
      const summary = allItems[key];
      if (summary.conversationId === conversationId) {
        return summary;
      }
    }
  }
  return null;
}

async function saveConversation(conversationId, conversation) {
  // Find and update the summary with this conversationId
  const allItems = await chrome.storage.local.get(null);
  for (const key in allItems) {
    if (key.startsWith('summary:')) {
      const existing = allItems[key];
      if (existing && existing.conversationId === conversationId) {
        // Merge to preserve summary, transcript, timestamp, etc.
        const merged = {
          ...existing,
          messages: Array.isArray(conversation?.messages) ? conversation.messages : (existing.messages || []),
        };
        await chrome.storage.local.set({ [key]: merged });
        return;
      }
    }
  }
}

async function clearAllSummaries() {
  const allItems = await chrome.storage.local.get(null);
  const keysToRemove = Object.keys(allItems).filter(key => 
    key.startsWith('summary:yt:') || key.startsWith('summary:page:')
  );
  if (keysToRemove.length > 0) {
    await chrome.storage.local.remove(keysToRemove);
  }
}

function normalizeUrl(url) {
  try {
    const urlObj = new URL(url);
    const host = urlObj.hostname.toLowerCase();
    urlObj.hash = '';
    const normalized = `${urlObj.protocol}//${host}${urlObj.port ? ':' + urlObj.port : ''}${urlObj.pathname}${urlObj.search}`;
    return normalized;
  } catch (e) {
    return url;
  }
}

// Clean up old summaries (older than 30 days)
async function cleanupOldSummaries() {
  const allItems = await chrome.storage.local.get(null);
  const thirtyDaysAgo = Date.now() - (30 * 24 * 60 * 60 * 1000);
  
  for (const key in allItems) {
    if (key.startsWith('summary:')) {
      const summary = allItems[key];
      if (summary.timestamp && summary.timestamp < thirtyDaysAgo) {
        await chrome.storage.local.remove(key);
      }
    }
  }
}

// Clean up on startup
cleanupOldSummaries();

// Helper to safely send messages to tabs (prevents crashes on navigation)
async function safeSend(tab, msg) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, msg);
  } catch (e) {
    // Ignore errors (tab navigated, closed, or no listener)
  }
}

async function getSummary(text, tab) {
  return new Promise(async (resolve) => {
    try {
      // Check if API URL is configured
      if (!YOUTUBE_TRANSCRIPT_API_URL || !YOUTUBE_TRANSCRIPT_API_KEY) {
        const errorMsg = 'API not configured. Please set YOUTUBE_TRANSCRIPT_API_URL and YOUTUBE_TRANSCRIPT_API_KEY in config.js';
        console.error(errorMsg);
        await safeSend(tab, {
          action: 'displaySummary',
          summary: errorMsg
        });
        resolve(errorMsg);
        return;
      }

      // Create cache key based on page URL
      const pageUrl = tab?.url || 'unknown';
      const normalizedPageUrl = normalizeUrl(pageUrl);
      const summaryKey = `summary:page:${normalizedPageUrl}`;
      
      // Check cache first
      const cachedSummary = await getSummaryCache(summaryKey);
      if (cachedSummary) {
        // Return cached summary immediately
        await safeSend(tab, {
          action: 'displaySummary',
          summary: cachedSummary.summary,
          conversationId: cachedSummary.conversationId,
          fromCache: true
        });
        await safeSend(tab, {
          action: 'summaryComplete',
          conversationId: cachedSummary.conversationId
        });
        resolve(cachedSummary.summary);
        return;
      }

      // Create conversation ID
      const conversationId = crypto.randomUUID();

      // Call Hetzner /summarize endpoint
      const response = await fetch(`${YOUTUBE_TRANSCRIPT_API_URL}/summarize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': YOUTUBE_TRANSCRIPT_API_KEY,
        },
        body: JSON.stringify({ text: text }),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      let summary = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            // Handle both SSE format ("data: {...}") and raw JSON
            let jsonStr = line.trim();
            if (jsonStr.startsWith('data: ')) {
              jsonStr = jsonStr.slice(6).trim();
              if (jsonStr === '[DONE]') {
                buffer = '';
                break;
              }
            }

            const data = JSON.parse(jsonStr);

            if (data.error) {
              throw new Error(data.error);
            }

            if (data.delta) {
              summary += data.delta;

              // Stream partial updates back to the content script
              await safeSend(tab, {
                action: 'updateSummary',
                summary: summary,
                conversationId: conversationId,
              });
            }

            if (data.done) {
              buffer = '';
              break;
            }
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }

      // Save summary to cache
      await saveSummary(summaryKey, {
        summary: summary,
        pageContent: text,
        conversationId: conversationId,
        messages: [],
        timestamp: Date.now(),
        url: pageUrl
      });

      // Send completion message to re-enable the summarize button
      await safeSend(tab, {
        action: 'summaryComplete',
        conversationId: conversationId,
      });

      resolve(summary);
    } catch (error) {
      console.error('Error:', error);

      // Send error message and re-enable button
      await safeSend(tab, {
        action: 'displaySummary',
        summary: 'Summary generation failed.'
      });

      // Send completion message to re-enable the summarize button
      await safeSend(tab, {
        action: 'summaryComplete'
      });

      resolve('Summary generation failed.');
    }
  });
}

async function continueConversation(conversationId, userMessage, tab) {
  return new Promise(async (resolve) => {
    try {
      // Check if API URL is configured
      if (!YOUTUBE_TRANSCRIPT_API_URL || !YOUTUBE_TRANSCRIPT_API_KEY) {
        const errorMsg = 'API not configured. Please set YOUTUBE_TRANSCRIPT_API_URL and YOUTUBE_TRANSCRIPT_API_KEY in config.js';
        console.error(errorMsg);
        await safeSend(tab, {
          action: 'conversationError',
          error: errorMsg
        });
        resolve(errorMsg);
        return;
      }

      const conversation = await getConversation(conversationId);
      if (!conversation) {
        const errorMsg = 'Conversation not found.';
        await safeSend(tab, {
          action: 'conversationError',
          error: errorMsg
        });
        resolve(errorMsg);
        return;
      }

      // Call Hetzner /continue endpoint
      const response = await fetch(`${YOUTUBE_TRANSCRIPT_API_URL}/continue`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': YOUTUBE_TRANSCRIPT_API_KEY,
        },
        body: JSON.stringify({
          conversation_history: conversation.messages || [],
          message: userMessage
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      let assistantResponse = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);

            if (data.error) {
              throw new Error(data.error);
            }

            if (data.delta) {
              assistantResponse += data.delta;

              // Stream partial updates back to the content script
              await safeSend(tab, {
                action: 'updateConversation',
                response: assistantResponse,
                conversationId: conversationId,
              });
            }

            if (data.done) {
              break;
            }
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }

      // Add user message to conversation
      conversation.messages.push({
        role: 'user',
        content: userMessage
      });

      // Add assistant's response to conversation
      conversation.messages.push({
        role: 'assistant',
        content: assistantResponse
      });

      // Save updated conversation
      await saveConversation(conversationId, conversation);

      // Send final message to indicate streaming is complete
      await safeSend(tab, {
        action: 'conversationComplete',
        response: assistantResponse,
        conversationId: conversationId,
      });

      resolve(assistantResponse);
    } catch (error) {
      console.error('Error:', error);
      await safeSend(tab, {
        action: 'conversationError',
        error: 'Response generation failed.'
      });
      resolve('Response generation failed.');
    }
  });
}

async function continueDraftConversation(conversationId, userMessage, history, tab, originalThread = '') {
  return new Promise(async (resolve) => {
    try {
      // Check if API URL is configured
      if (!YOUTUBE_TRANSCRIPT_API_URL || !YOUTUBE_TRANSCRIPT_API_KEY) {
        const errorMsg = 'API not configured. Please set YOUTUBE_TRANSCRIPT_API_URL and YOUTUBE_TRANSCRIPT_API_KEY in config.js';
        console.error(errorMsg);
        await safeSend(tab, {
          action: 'conversationError',
          error: errorMsg
        });
        resolve(errorMsg);
        return;
      }

      // Call Hetzner /continue-draft endpoint
      const response = await fetch(`${YOUTUBE_TRANSCRIPT_API_URL}/continue-draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': YOUTUBE_TRANSCRIPT_API_KEY,
        },
        body: JSON.stringify({
          conversation_history: history || [],
          message: userMessage,
          original_thread: originalThread || ''
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      let assistantResponse = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);

            if (data.error) {
              throw new Error(data.error);
            }

            if (data.delta) {
              assistantResponse += data.delta;

              // Stream partial updates back to the content script
              await safeSend(tab, {
                action: 'draftConversationUpdate',
                response: assistantResponse,
                conversationId: conversationId,
              });
            }

            if (data.done) {
              break;
            }
          } catch (e) {
            console.error('Parse error:', e);
          }
        }
      }

      // Send final message to indicate streaming is complete
      await safeSend(tab, {
        action: 'draftConversationComplete',
        response: assistantResponse,
        conversationId: conversationId,
      });

      resolve(assistantResponse);
    } catch (error) {
      console.error('Error:', error);
      await safeSend(tab, {
        action: 'conversationError',
        error: 'Response generation failed.'
      });
      resolve('Response generation failed.');
    }
  });
}

async function getDraftResponse(text, tab, instructions = '') {
  return new Promise(async (resolve) => {
    try {
      // Check if API URL is configured
      if (!YOUTUBE_TRANSCRIPT_API_URL || !YOUTUBE_TRANSCRIPT_API_KEY) {
        const errorMsg = 'API not configured. Please set YOUTUBE_TRANSCRIPT_API_URL and YOUTUBE_TRANSCRIPT_API_KEY in config.js';
        console.error(errorMsg);
        await safeSend(tab, {
          action: 'displayDraft',
          draft: errorMsg
        });
        resolve(errorMsg);
        return;
      }

      // Send initial message to show the draft window
      await safeSend(tab, {
        action: 'displayDraft',
        draft: '',
      });

      // Call Hetzner /draft endpoint
      const response = await fetch(`${YOUTUBE_TRANSCRIPT_API_URL}/draft`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': YOUTUBE_TRANSCRIPT_API_KEY,
        },
        body: JSON.stringify({
          text: text,
          instructions: instructions
        }),
      });

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status}`);
      }

      let draft = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            const data = JSON.parse(line);

            if (data.error) {
              throw new Error(data.error);
            }

            if (data.delta) {
              draft += data.delta;

              // Stream partial updates
              await safeSend(tab, {
                action: 'updateDraft',
                draft: draft,
              });
            }

            if (data.done) {
              break;
            }
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

async function getVideoTranscriptAndSummarize(videoId, tab) {
  try {
    // Use native messaging to get transcript from local Python script
    // This runs on user's machine (residential IP) - bypasses YouTube cloud IP blocking
    const nativeResponse = await chrome.runtime.sendNativeMessage(
      'com.ytsummary',
      { video_id: videoId }
    );

    // Check if we got a valid transcript
    if (!nativeResponse.text || nativeResponse.text.startsWith('Error')) {
      throw new Error(nativeResponse.text || 'No transcript received');
    }

    // Store the transcript for later use
    const transcript = nativeResponse.text;

    // Now use dual-mode summarization (fast + deep)
    // Pass transcript so it can be stored for copy button
    await getDualSummary(transcript, tab, transcript);
  } catch (error) {
    console.error('Error fetching video transcript:', error);
    // Send error message to content script
    await safeSend(tab, {
      action: 'summaryError',
      mode: 'fast',
      error: `Failed to get video transcript. Error: ${error.message}\n\nMake sure:\n1. Native host is installed at ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/\n2. Extension ID in com.ytsummary.json matches your extension\n3. Python script has correct permissions`
    });
  }
}

// Store active requests for cancellation
const activeRequests = new Map();

async function getDualSummary(text, tab, transcript = null) {
  // Send transcript to content script if provided (for YouTube videos)
  if (transcript) {
    await safeSend(tab, {
      action: 'setTranscript',
      transcript: transcript,
    });
  }

  // Start both fast and deep requests concurrently
  const fastPromise = getSummaryMode(text, tab, 'fast');
  const deepPromise = getSummaryMode(text, tab, 'deep');

  await Promise.all([fastPromise, deepPromise]);
}

async function getSummaryMode(text, tab, mode) {
  try {

    // Connect to local AI handler via native messaging
    const port = chrome.runtime.connectNative('com.localai');
    let summary = '';

    // Set up message listener
    port.onMessage.addListener(async (response) => {
      if (response.type === 'delta') {
        summary = response.summary || summary;

        // Stream partial updates back to the content script
        await safeSend(tab, {
          action: mode === 'fast' ? 'updateFastSummary' : 'updateDeepSummary',
          summary: summary,
        });
      } else if (response.type === 'complete') {
        // Notify completion for deep mode
        if (mode === 'deep') {
          await safeSend(tab, {
            action: 'deepSummaryComplete',
          });
        }

        port.disconnect();
      } else if (response.type === 'error') {
        throw new Error(response.error);
      }
    });

    // Handle disconnection
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError) {
        console.error('Native messaging error:', chrome.runtime.lastError);
      }
    });

    // Send summarization request
    port.postMessage({
      action: 'summarize',
      text: text,
      mode: mode
    });

  } catch (error) {
    console.error(`Error in ${mode} summary:`, error);

    if (error.name === 'AbortError') {
      console.log(`${mode} summary cancelled`);
      return;
    }

    // Send error message
    await safeSend(tab, {
      action: 'summaryError',
      error: error.message || 'Summary generation failed',
      mode: mode
    });

    // Clean up
    activeRequests.delete(`${tab.id}-${mode}`);
  }
}

// 4) Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tab = sender.tab;

  if (request.action === 'summarizeDual') {
    getDualSummary(request.text, tab);
    return true; // async
  }

  if (request.action === 'cancelDeepAnalysis') {
    // Cancel deep request if still running
    const requestId = `${tab.id}-deep`;
    const abortController = activeRequests.get(requestId);
    if (abortController) {
      abortController.abort();
      activeRequests.delete(requestId);
    }
    return true;
  }

  if (request.action === 'summarize') {
    // Use dual-mode summary for content-dual.js
    getDualSummary(request.text, tab);
    return true; // async
  }

  if (request.action === 'draft') {
    getDraftResponse(request.text, tab, request.instructions).then((draft) => {
      safeSend(tab, {
        action: 'displayDraft',
        draft: draft,
      });
    });
    return true; // async
  }

  if (request.action === 'summarizeVideo') {
    // Fetch transcript first, then use dual-mode summarization
    getVideoTranscriptAndSummarize(request.videoId, tab);
    return true;
  }
  
  if (request.action === 'clearSummary') {
    // Determine if this is YouTube or regular page
    if (!tab || !tab.url) {
      sendResponse({ success: false, error: 'No tab URL available' });
      return true;
    }

    try {
      const urlObj = new URL(tab.url);
      let summaryKey;

      if (urlObj.hostname.includes('youtube.com') && urlObj.searchParams.get('v')) {
        // YouTube video
        const videoId = urlObj.searchParams.get('v');
        summaryKey = `summary:yt:${videoId}`;
      } else {
        // Regular page
        const normalizedUrl = normalizeUrl(tab.url);
        summaryKey = `summary:page:${normalizedUrl}`;
      }

      clearSummaryCache(summaryKey).then(() => {
        sendResponse({ success: true });
      });
    } catch (error) {
      console.error('Error parsing URL in clearSummary:', error);
      sendResponse({ success: false, error: 'Invalid URL' });
    }
    return true; // async
  }

  if (request.action === 'clearAllSummaries') {
    clearAllSummaries().then(() => {
      sendResponse({ success: true, message: 'All summaries cleared' });
    });
    return true; // async
  }
  
  if (request.action === 'continueConversation') {
    continueConversation(request.conversationId, request.message, tab).then((response) => {
      // Response is already streamed via updateConversation
    });
    return true; // async
  }
  
  if (request.action === 'continueDraftConversation') {
    continueDraftConversation(request.conversationId, request.message, request.history, tab, request.originalThread).then((response) => {
      // Response is already streamed
    });
    return true; // async
  }
});
