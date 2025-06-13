// background.js

const ANTHROPIC_API_KEY = 'enter-your-key-here';

async function getSummary(text, tab) {
  return new Promise(async (resolve) => {
    try {
      // If we have a tab, ensure content.js is loaded (optional if always loaded)
      if (tab) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
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
          model: 'claude-3-5-haiku-latest', // or your preferred model
          max_tokens: 8192,
          messages: [
            {
              role: 'user',
              content: `Summarize:\n\n${text}`,
            },
          ],
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
              if (data.type === 'content_block_delta') {
                summary += data.delta.text;

                // Stream partial updates back to the content script
                if (tab) {
                  await chrome.tabs.sendMessage(tab.id, {
                    action: 'updateSummary',
                    summary: summary,
                  });
                }
              }
            } catch (e) {
              // ignore parse errors on lines that aren't valid JSON
            }
          }
        }
      }

      resolve(summary);
    } catch (error) {
      console.error('Error:', error);
      resolve('Summary generation failed.');
    }
  });
}

async function getDraftResponse(text, tab, instructions = '') {
  return new Promise(async (resolve) => {
    try {
      // If we have a tab, ensure content.js is loaded
      if (tab) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js'],
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
          model: 'claude-3-7-sonnet-latest',
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

    // Use existing summary function with native response
    return getSummary(nativeResponse.text, tab);
  } catch (error) {
    console.error('Error:', error);
    return 'Failed to get video information. Make sure the native host is installed and running.';
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
});
