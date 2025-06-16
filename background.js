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

// Store conversations in memory
const conversations = new Map();

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
      conversations.set(conversationId, {
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
          max_completion_tokens: 8192,
          messages: messages,
          reasoning_effort: 'medium',
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
      const conversation = conversations.get(conversationId);
      conversation.messages.push({
        role: 'assistant',
        content: summary
      });

      resolve(summary);
    } catch (error) {
      console.error('Error:', error);
      resolve('Summary generation failed.');
    }
  });
}

async function continueConversation(conversationId, userMessage, tab) {
  return new Promise(async (resolve) => {
    try {
      const conversation = conversations.get(conversationId);
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

async function getDraftResponse(text, tab, instructions = '') {
  return new Promise(async (resolve) => {
    try {
      // Check if API key is configured
      if (!ANTHROPIC_API_KEY || ANTHROPIC_API_KEY === 'your-anthropic-api-key-here') {
        const errorMsg = 'Anthropic API key not configured. Please create config.js from config.example.js and add your API key.';
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
      // Content script should already be loaded via manifest

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
                    action: 'updateSummary',
                    summary: draft,
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

    // Use existing summary function with native response
    return getSummary(nativeResponse.text, tab);
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
        action: 'displaySummary',
        summary: draft,
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
});
