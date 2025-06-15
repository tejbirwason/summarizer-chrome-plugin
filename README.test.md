# Testing Guide for Chrome Extension

## Test Structure

The test suite includes:

1. **Unit Tests for Background Script** (`tests/background.test.js`)
   - Tests OpenAI o3 API integration for summarization
   - Tests Claude API integration for draft responses
   - Tests streaming response handling
   - Tests error handling and fallbacks

2. **Unit Tests for Content Script** (`tests/content.test.js`)
   - Tests UI components (FABs, summary display)
   - Tests user interactions (button clicks, modal)
   - Tests message passing between scripts

3. **Integration Tests** (`tests/integration.test.js`)
   - Tests complete user flows
   - Tests error scenarios
   - Tests security aspects

## Running Tests

```bash
# Run all tests
npm test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Test Coverage Areas

### API Integration
- ✅ OpenAI o3-mini API calls with correct parameters
- ✅ Claude API calls with proper headers
- ✅ Streaming response parsing for both APIs
- ✅ Error handling (network errors, API errors)
- ✅ Retry logic and fallback messages

### User Interface
- ✅ FAB button creation and styling
- ✅ Button visibility based on text selection
- ✅ Summary container creation and management
- ✅ Modal dialog for draft instructions
- ✅ Keyboard shortcuts (Enter/Escape)

### Message Passing
- ✅ Content script to background communication
- ✅ Background to content script updates
- ✅ Streaming updates during API calls

### Security
- ✅ XSS prevention through textContent usage
- ✅ No HTML injection vulnerabilities
- ✅ API key validation

## Known Test Limitations

1. **Chrome API Mocking**: Tests use mocked Chrome APIs rather than real extension APIs
2. **Native Messaging**: YouTube functionality tests are excluded as requested
3. **Real API Calls**: Tests use mocked responses instead of real API calls

## Adding New Tests

When adding new features, ensure to:
1. Add unit tests for new functions
2. Add integration tests for new user flows
3. Update mocks if new Chrome APIs are used
4. Test error scenarios and edge cases

## Debugging Failed Tests

1. Run tests with verbose output: `npm test -- --verbose`
2. Check that all Chrome APIs are properly mocked in `tests/setup.js`
3. Verify that streaming response mocks match actual API formats
4. Use `console.log` in tests to debug intermediate values