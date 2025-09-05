// background.js

// Try to load config.js
try {
  importScripts('config.js');
} catch (e) {
  console.warn('config.js not found. Using default values.');
}

// Load API keys from config.js
let OPENAI_API_KEY = '';
let ANTHROPIC_API_KEY = '';

// Check if CONFIG is defined and has the required keys
if (typeof CONFIG !== 'undefined') {
  OPENAI_API_KEY = CONFIG.OPENAI_API_KEY || '';
  ANTHROPIC_API_KEY = CONFIG.ANTHROPIC_API_KEY || '';
} else {
  console.error('CONFIG not found. Please create config.js from config.example.js');
}

// Helper functions for conversation storage
async function saveConversation(conversationId, conversation) {
  const key = `conversation_${conversationId}`;
  await chrome.storage.local.set({ [key]: conversation });
}

async function getConversation(conversationId) {
  const key = `conversation_${conversationId}`;
  const result = await chrome.storage.local.get(key);
  return result[key];
}

// Clean up old conversations (older than 7 days)
async function cleanupOldConversations() {
  const allItems = await chrome.storage.local.get(null);
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  
  for (const key in allItems) {
    if (key.startsWith('conversation_')) {
      const conversation = allItems[key];
      if (conversation.timestamp && conversation.timestamp < sevenDaysAgo) {
        await chrome.storage.local.remove(key);
      }
    }
  }
}

// Clean up on startup
cleanupOldConversations();

async function getSummary(text, tab) {
  return new Promise(async (resolve) => {
    try {
      // Check if API key is configured
      if (!OPENAI_API_KEY || OPENAI_API_KEY === 'your-openai-api-key-here') {
        const errorMsg = 'OpenAI API key not configured. Please create config.js from config.example.js and add your API key.';
        console.error(errorMsg);
        if (tab) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'displaySummary',
            summary: errorMsg
          });
        }
        resolve(errorMsg);
        return;
      }
      
      // Create conversation ID and initialize conversation
      const conversationId = crypto.randomUUID();
      const messages = [
        {
          role: 'system',
          content: 'You are a helpful assistant. When asked to summarize, provide a clear and concise summary. Answer any follow-up questions based on the context provided.'
        },
        {
          role: 'user',
          content: `Summarize:\n\n${text}`
        }
      ];
      
      // Store conversation
      await saveConversation(conversationId, {
        originalText: text,
        messages: messages,
        timestamp: Date.now()
      });
      // Content script should already be loaded via manifest

      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'o3',
          messages: messages,
          reasoning_effort: 'high',
          stream: true,
        }),
      });

      let summary = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
                summary += data.choices[0].delta.content;

                // Stream partial updates back to the content script
                if (tab) {
                  await chrome.tabs.sendMessage(tab.id, {
                    action: 'updateSummary',
                    summary: summary,
                    conversationId: conversationId,
                  });
                }
              }
            } catch (e) {
              // ignore parse errors on lines that aren't valid JSON
            }
          }
        }
      }
      
      // Add assistant's response to conversation
      const conversation = await getConversation(conversationId);
      conversation.messages.push({
        role: 'assistant',
        content: summary
      });
      
      // Save updated conversation
      await saveConversation(conversationId, conversation);
      
      // Send completion message to re-enable the summarize button
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'summaryComplete',
          conversationId: conversationId,
        });
      }

      resolve(summary);
    } catch (error) {
      console.error('Error:', error);
      
      // Send error message and re-enable button
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'displaySummary',
          summary: 'Summary generation failed.'
        });
        
        // Send completion message to re-enable the summarize button
        await chrome.tabs.sendMessage(tab.id, {
          action: 'summaryComplete'
        });
      }
      
      resolve('Summary generation failed.');
    }
  });
}

async function continueConversation(conversationId, userMessage, tab) {
  return new Promise(async (resolve) => {
    try {
      const conversation = await getConversation(conversationId);
      if (!conversation) {
        const errorMsg = 'Conversation not found.';
        if (tab) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'conversationError',
            error: errorMsg
          });
        }
        resolve(errorMsg);
        return;
      }
      
      // Add user message to conversation
      conversation.messages.push({
        role: 'user',
        content: userMessage
      });
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'o3',
          max_completion_tokens: 8192,
          messages: conversation.messages,
          reasoning_effort: 'medium',
          stream: true,
        }),
      });

      let assistantResponse = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
                assistantResponse += data.choices[0].delta.content;

                // Stream partial updates back to the content script
                if (tab) {
                  await chrome.tabs.sendMessage(tab.id, {
                    action: 'updateConversation',
                    response: assistantResponse,
                    conversationId: conversationId,
                  });
                }
              }
            } catch (e) {
              // ignore parse errors on lines that aren't valid JSON
            }
          }
        }
      }
      
      // Add assistant's response to conversation
      conversation.messages.push({
        role: 'assistant',
        content: assistantResponse
      });
      
      // Save updated conversation
      await saveConversation(conversationId, conversation);
      
      // Send final message to indicate streaming is complete
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'conversationComplete',
          response: assistantResponse,
          conversationId: conversationId,
        });
      }

      resolve(assistantResponse);
    } catch (error) {
      console.error('Error:', error);
      resolve('Response generation failed.');
    }
  });
}

async function continueDraftConversation(conversationId, userMessage, history, tab, originalThread = '') {
  return new Promise(async (resolve) => {
    try {
      // Check if API key is configured
      if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === 'your-anthropic-api-key-here') {
        const errorMsg = 'Anthropic API key not configured.';
        console.error(errorMsg);
        if (tab) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'conversationError',
            error: errorMsg
          });
        }
        resolve(errorMsg);
        return;
      }
      
      // Build messages array from history
      const messages = [];
      
      // If we have the original thread and this is the first follow-up
      if (originalThread && history.length === 1 && history[0].role === 'assistant') {
        // Add the original context
        messages.push({
          role: 'user',
          content: `I'm drafting a response to this thread:\n\n"${originalThread}"\n\nHere's my current draft:\n\n${history[0].content}\n\n${userMessage}`
        });
      } else {
        // Normal conversation flow
        messages.push(...history);
        messages.push({
          role: 'user',
          content: userMessage
        });
      }
      
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-latest',
          max_tokens: 8192,
          messages: messages,
          stream: true,
        }),
      });

      let assistantResponse = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content_block_delta') {
                assistantResponse += data.delta.text;

                // Stream partial updates back to the content script
                if (tab) {
                  await chrome.tabs.sendMessage(tab.id, {
                    action: 'draftConversationUpdate',
                    response: assistantResponse,
                    conversationId: conversationId,
                  });
                }
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }
      
      // Send final message to indicate streaming is complete
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'draftConversationComplete',
          response: assistantResponse,
          conversationId: conversationId,
        });
      }

      resolve(assistantResponse);
    } catch (error) {
      console.error('Error:', error);
      if (tab) {
        chrome.tabs.sendMessage(tab.id, {
          action: 'conversationError',
          error: 'Response generation failed.'
        });
      }
      resolve('Response generation failed.');
    }
  });
}

async function getDraftResponse(text, tab, instructions = '') {
  return new Promise(async (resolve) => {
    try {
      // Check if API key is configured
      if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === 'your-anthropic-api-key-here') {
        const errorMsg = 'Anthropic API key not configured. Please create config.js from config.example.js and add your API key.';
        console.error(errorMsg);
        if (tab) {
          chrome.tabs.sendMessage(tab.id, {
            action: 'displayDraft',
            draft: errorMsg
          });
        }
        resolve(errorMsg);
        return;
      }
      // Content script should already be loaded via manifest
      
      // Send initial message to show the draft window
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'displayDraft',
          draft: '',
        });
      }

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model: 'claude-3-5-sonnet-latest',
          max_tokens: 8192,
          messages: [
            {
              role: 'user',
              content: `Draft a concise response to the following thread:

"${text}"

Additional instructions:
${instructions}

Notes:
- My name is Tj
- If the thread is related to recruiting, remember that I'm the applicant
- Tone should be friendly and informal yet still professional`,
            },
          ],
          stream: true,
        }),
      });

      let draft = '';
      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === 'content_block_delta') {
                draft += data.delta.text;

                // Stream partial updates
                if (tab) {
                  await chrome.tabs.sendMessage(tab.id, {
                    action: 'updateDraft',
                    draft: draft,
                  });
                }
              }
            } catch (e) {
              // ignore parse error
            }
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

async function getSummaryWithTranscript(text, tab) {
  return new Promise(async (resolve) => {
    try {
      const conversationId = 'summary-' + Date.now();
      
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: 'o3',
          messages: [
            {
              role: 'user',
              content: 'Summarize:\n\n' + text,
            },
          ],
          stream: true,
        }),
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let summary = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices && data.choices[0] && data.choices[0].delta && data.choices[0].delta.content) {
                summary += data.choices[0].delta.content;

                // Stream partial updates with transcript
                if (tab) {
                  await chrome.tabs.sendMessage(tab.id, {
                    action: 'updateSummary',
                    summary: summary,
                    transcript: text,
                    conversationId: conversationId,
                  });
                }
              }
            } catch (e) {
              // ignore parse errors
            }
          }
        }
      }

      // Send final summary with transcript
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'displaySummary',
          summary: summary,
          transcript: text,
          conversationId: conversationId,
        });
      }

      resolve(summary);
    } catch (error) {
      console.error('Error:', error);
      const errorMsg = 'Summary generation failed.';
      const conversationId = 'summary-' + Date.now();
      if (tab) {
        await chrome.tabs.sendMessage(tab.id, {
          action: 'displaySummary',
          summary: errorMsg,
          transcript: text,
          conversationId: conversationId,
        });
      }
      resolve(errorMsg);
    }
  });
}

async function getVideoSummary(videoId, tab) {
  try {
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
    
    // Get summary with custom handler to include transcript
    return getSummaryWithTranscript(transcript, tab);
  } catch (error) {
    console.error('Native messaging error:', error);
    // Send error message to content script
    if (tab) {
      chrome.tabs.sendMessage(tab.id, {
        action: 'displaySummary',
        summary: `Failed to get video transcript. Error: ${error.message}\n\nMake sure:\n1. Native host is installed at ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/\n2. Extension ID in com.ytsummary.json matches your extension\n3. Python script has correct permissions`
      });
    }
    return;
  }
}

// 4) Listen for messages from the content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const tab = sender.tab;

  if (request.action === 'summarize') {
    getSummary(request.text, tab).then((summary) => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'displaySummary',
        summary: summary,
      });
    });
    return true; // async
  }

  if (request.action === 'draft') {
    getDraftResponse(request.text, tab, request.instructions).then((draft) => {
      chrome.tabs.sendMessage(tab.id, {
        action: 'displayDraft',
        draft: draft,
      });
    });
    return true; // async
  }

  if (request.action === 'summarizeVideo') {
    getVideoSummary(request.videoId, tab);
    return true;
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
