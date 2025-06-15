# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome extension that provides AI-powered text summarization and response drafting capabilities. It integrates with OpenAI's o3 model for summarization and Claude for drafting responses. The extension also includes special YouTube video transcript summarization functionality via native messaging.

## Key Commands

```bash
# Run tests
npm test

# Run tests in watch mode  
npm run test:watch

# Run tests with coverage
npm run test:coverage
```

## Architecture

### Core Components

1. **background.js** - Service worker that handles:
   - OpenAI o3 API calls for summarization
   - Claude API calls for response drafting
   - Native messaging for YouTube transcripts
   - Streaming responses back to content scripts

2. **content.js** - Main content script injected on all pages:
   - Creates floating action buttons (FABs) for summarize (✨) and draft (✒️)
   - Shows/hides buttons based on text selection
   - Displays streaming results in a dark-themed overlay
   - Handles user input for draft instructions

3. **youtube-content.js** - YouTube-specific content script:
   - Adds summarize button to YouTube video pages
   - Integrates with native messaging host

4. **yt-summary.py** - Native messaging host:
   - Fetches YouTube transcripts using youtube_transcript_api
   - Communicates with extension via stdio protocol

### Message Flow

1. User selects text → FAB appears → User clicks FAB
2. Content script sends message to background script
3. Background script calls appropriate API (OpenAI/Claude)
4. Streaming responses sent back to content script
5. Content script updates UI in real-time

### YouTube Transcript Generation Flow

1. **Button Creation**: When user navigates to YouTube video page, `youtube-content.js` detects the page change and adds a "✨ Summarize" button
2. **User Clicks Button**: Button extracts video ID from URL and sends `summarizeVideo` message to background script
3. **Native Messaging**: Background script sends video ID to Python native host (`yt-summary.py`) via Chrome's native messaging API
4. **Transcript Fetching**: Python script uses `youtube_transcript_api` to fetch video transcript, concatenates all segments
5. **Response Processing**: Native host sends transcript back using stdio protocol (4-byte length header + JSON payload)
6. **AI Summarization**: Background script passes transcript to OpenAI o3 API for summarization
7. **Streaming Display**: Summary streams back through background script to content script, updating UI in real-time

#### Native Messaging Setup Requirements

1. **Install Native Host Manifest**: Copy `com.ytsummary.json` to Chrome's NativeMessagingHosts directory:
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/`
   - Windows: Registry entry required

2. **Python Dependencies**: Install `youtube-transcript-api` package:
   ```bash
   pip install youtube-transcript-api
   ```

3. **Path Configuration**: Ensure `yt-summary.py` path in manifest matches actual location and has execute permissions

#### Native Messaging Protocol Details

- Communication uses stdio (stdin/stdout) with 4-byte little-endian length prefix
- Messages are JSON encoded: `{"video_id": "xxx"}` → `{"text": "transcript..."}`
- Debug logs written to `/tmp/native-host-test.txt` for troubleshooting
- Error handling includes user-friendly messages with setup instructions

### Key Implementation Details

- Uses Chrome Extension Manifest V3
- Implements proper streaming for both OpenAI and Claude APIs
- All UI updates use `textContent` to prevent XSS
- Native messaging for YouTube functionality requires manual setup
- Tests are comprehensive with mocked Chrome APIs

## Security Notes

- API keys are currently hardcoded in background.js (should be moved to secure storage)
- Extension uses `anthropic-dangerous-direct-browser-access` header for Claude API
- All user inputs are sanitized before display

## Testing

The project includes unit and integration tests for all major components:
- `tests/background.test.js` - API integration tests
- `tests/content.test.js` - UI component tests  
- `tests/integration.test.js` - End-to-end flow tests

Tests use Jest with jsdom environment and comprehensive Chrome API mocks.