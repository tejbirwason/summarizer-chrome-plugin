// Mock streaming response for OpenAI
function createOpenAIStreamMock(text) {
  const chunks = [
    `data: {"choices":[{"delta":{"content":"${text.slice(0, 10)}"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"${text.slice(10, 20)}"}}]}\n\n`,
    `data: {"choices":[{"delta":{"content":"${text.slice(20)}"}}]}\n\n`,
    'data: [DONE]\n\n'
  ];
  
  let index = 0;
  
  return {
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (index < chunks.length) {
            const chunk = chunks[index];
            index++;
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(chunk)
            });
          }
          return Promise.resolve({ done: true });
        })
      })
    }
  };
}

// Mock streaming response for Anthropic
function createAnthropicStreamMock(text) {
  const chunks = [
    `data: {"type":"content_block_delta","delta":{"text":"${text.slice(0, 10)}"}}\n\n`,
    `data: {"type":"content_block_delta","delta":{"text":"${text.slice(10, 20)}"}}\n\n`,
    `data: {"type":"content_block_delta","delta":{"text":"${text.slice(20)}"}}\n\n`,
    `data: {"type":"message_stop"}\n\n`
  ];
  
  let index = 0;
  
  return {
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (index < chunks.length) {
            const chunk = chunks[index];
            index++;
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(chunk)
            });
          }
          return Promise.resolve({ done: true });
        })
      })
    }
  };
}

// Mock error responses
function createErrorResponse(status, statusText) {
  return Promise.resolve({
    ok: false,
    status,
    statusText,
    body: {
      getReader: () => ({
        read: () => Promise.resolve({ done: true })
      })
    }
  });
}

// Helper to wait for async operations
const waitFor = (callback, timeout = 1000) => {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timeout waiting for condition'));
    }, timeout);
    
    const interval = setInterval(() => {
      try {
        if (callback()) {
          clearInterval(interval);
          clearTimeout(timer);
          resolve();
        }
      } catch (error) {
        clearInterval(interval);
        clearTimeout(timer);
        reject(error);
      }
    }, 50);
  });
};

// Mock streaming response for Hetzner API (NDJSON format)
function createHetznerStreamMock(text) {
  const lines = [
    `{"delta":"${text.slice(0, 10)}"}\n`,
    `{"delta":"${text.slice(10, 20)}"}\n`,
    `{"delta":"${text.slice(20)}"}\n`,
    `{"done":true}\n`
  ];

  let index = 0;

  return {
    ok: true,
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (index < lines.length) {
            const line = lines[index];
            index++;
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(line)
            });
          }
          return Promise.resolve({ done: true });
        })
      })
    }
  };
}

// Mock streaming response for Hetzner API (SSE format with data: prefix for dual mode)
function createHetznerSSEStreamMock(text) {
  const lines = [
    `data: {"delta":"${text.slice(0, 10)}"}\n`,
    `data: {"delta":"${text.slice(10, 20)}"}\n`,
    `data: {"delta":"${text.slice(20)}"}\n`,
    `data: [DONE]\n`
  ];

  let index = 0;

  return {
    ok: true,
    body: {
      getReader: () => ({
        read: jest.fn().mockImplementation(() => {
          if (index < lines.length) {
            const line = lines[index];
            index++;
            return Promise.resolve({
              done: false,
              value: new TextEncoder().encode(line)
            });
          }
          return Promise.resolve({ done: true });
        })
      })
    }
  };
}

module.exports = {
  createOpenAIStreamMock,
  createAnthropicStreamMock,
  createErrorResponse,
  createHetznerStreamMock,
  createHetznerSSEStreamMock,
  waitFor
};