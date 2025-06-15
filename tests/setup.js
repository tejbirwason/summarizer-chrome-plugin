// Mock Chrome API
global.chrome = {
  runtime: {
    sendMessage: jest.fn(),
    onMessage: {
      addListener: jest.fn()
    },
    sendNativeMessage: jest.fn()
  },
  tabs: {
    sendMessage: jest.fn()
  },
  scripting: {
    executeScript: jest.fn()
  }
};

// Mock fetch for API calls
global.fetch = jest.fn();

// Mock TextDecoder and TextEncoder for streaming responses
global.TextDecoder = class {
  decode(buffer) {
    if (typeof buffer === 'string') {
      return buffer;
    }
    const decoder = new (require('util').TextDecoder)('utf-8');
    return decoder.decode(buffer);
  }
};

global.TextEncoder = class {
  encode(str) {
    const encoder = new (require('util').TextEncoder)();
    return encoder.encode(str);
  }
};