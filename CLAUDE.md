# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension providing AI-powered text summarization and response drafting. Features dual-mode summarization (fast + deep) via local Python handler using OpenAI models, Claude-powered response drafting, and YouTube video transcript summarization. All powered by native messaging architecture.

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
   - Claude API calls for response drafting
   - Native messaging orchestration (com.localai, com.ytsummary)
   - Streaming responses back to content scripts
   - Message routing between content scripts and native hosts

2. **content-dual.js** - Main content script injected on all pages:
   - Creates floating action buttons (FABs) for summarize (✨) and draft (✒️)
   - Shows/hides buttons based on text selection
   - Displays dual-mode streaming results in dark-themed overlay
   - Handles user input for draft instructions

3. **youtube-content.js** - YouTube-specific content script:
   - Adds "✨ Summarize" + "🖥️ Open in Claude Code" buttons to YouTube video pages (`/watch`)
   - Initiates dual-mode video summarization
   - **Feed-tile buttons**: also injects a hover-revealed 🖥️ "Open in Claude Code" button onto every regular-video thumbnail across the feed / search results / watch-page sidebar, so a transcript can be opened in Claude Code without navigating into the video. Reuses the existing `openVideoInCC` message flow — no `background.js` or native-host changes. Implementation notes:
     - **Two layouts must both be handled** — YouTube ships them simultaneously: the old Polymer markup (search results, watch sidebar) uses `a#thumbnail` inside `ytd-thumbnail`; the new view-model markup (home + channel grids) uses `a.ytLockupViewModelContentImage` (no `id`) inside `div.ytLockupViewModelHost`. The selector matches both; missing the new one is why buttons never showed on the home feed. Ads/Shorts/playlists are skipped (hrefs lack `watch?v=`); `videoId` is read from the anchor href **at click time** (tiles are virtualized/recycled, so caching the ID would summarize the wrong video).
     - The button is appended to the **thumbnail box** — `ytd-thumbnail` (old) or `.ytLockupViewModelHost` (new) — both `position: relative` and whose top-left coincides with the thumbnail in every renderer. Positioned top-left (clear of the inline-preview mute/CC controls at top-right and the duration badge at bottom-right) at `z-index: 2019` — above the content-level preview but below the sticky masthead (`z-index: 2020`) so buttons never bleed over the search bar when a tile scrolls up.
     - **Reveal is JS pointer-tracking, NOT CSS `:hover`.** When the inline hover-preview plays, YouTube floats a shared `#video-preview` element (parented at `ytd-app`) over the thumbnail, so the cursor's hit-test target becomes the preview, not the tile — the tile loses `:hover` and a CSS-revealed button vanishes exactly when you're looking at it. A throttled `mousemove` handler uses `document.elementsFromPoint(x, y)` (which sees *through* the overlay to the card beneath) to resolve the card under the cursor and toggle that card's button visible. An in-flight (loading) button stays visible even when un-hovered.
     - A `MutationObserver` (throttled ~250ms) re-injects as infinite scroll adds tiles; idempotency is by button-presence check (not a flag) so recycled tiles that get their children wiped get a fresh button.
     - On success a green toast ("✅ Opened in Claude Code") slides up and the clicked button briefly shows ✅; the completion listener is guarded by `activeCCTileBtn` so the watch-page fixed button's flow is untouched. Only one open is tracked at a time.

4. **local-ai-handler.py** - Native messaging host for summarization:
   - Dual-mode AI summarization (fast + deep)
   - Uses OpenAI models (configurable via ai-config.json)
   - Supports streaming responses
   - Handles both text and transcript summarization

5. **yt-summary.py** - Native messaging host for YouTube:
   - Fetches YouTube transcripts using youtube_transcript_api
   - Communicates via stdio protocol
   - Returns full transcript to background script

### Message Flow

**Text Summarization (Dual-Mode):**
1. User selects text → FAB appears → User clicks ✨
2. content-dual.js sends `summarizeSelection` to background.js
3. background.js forwards to local-ai-handler.py via native messaging
4. local-ai-handler.py generates fast summary (streams back)
5. local-ai-handler.py generates deep summary (streams back)
6. content-dual.js updates dual-mode overlay in real-time

**Response Drafting:**
1. User selects text → clicks ✒️ → enters instructions
2. content-dual.js sends `draftResponse` to background.js
3. background.js calls Claude API directly
4. Streaming response updates content-dual.js overlay

**YouTube Summarization:**
1. youtube-content.js adds button → user clicks
2. yt-summary.py fetches transcript via native messaging
3. Transcript sent to local-ai-handler.py for dual-mode summarization
4. Results stream to youtube-content.js overlay

### YouTube Transcript Summarization Flow

1. **Button Creation**: youtube-content.js detects YouTube page, adds "✨ Summarize" button
2. **User Clicks**: Extracts video ID, sends `summarizeVideo` to background.js
3. **Transcript Fetching**: background.js → yt-summary.py (native messaging) → youtube_transcript_api
4. **Transcript Return**: yt-summary.py returns full transcript via stdio protocol (4-byte length + JSON)
5. **Dual-Mode Summarization**: background.js → local-ai-handler.py → generates fast + deep summaries
6. **Streaming Display**: Summaries stream back to youtube-content.js, updating dual-mode overlay in real-time

#### Native Messaging Setup Requirements

1. **Install Native Host Manifests**: Copy both to Chrome's NativeMessagingHosts directory:
   - `com.ytsummary.json` (YouTube transcripts)
   - `com.localai.json` (dual-mode summarization)
   - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`
   - Linux: `~/.config/google-chrome/NativeMessagingHosts/`
   - Windows: Registry entry required

2. **Python Dependencies**:
   ```bash
   pip install -r requirements.txt
   ```

3. **Environment Setup**: Create `.env` with `OPENAI_API_KEY`

4. **Path Configuration**: Ensure Python scripts are executable and paths in manifests match actual locations

See `NATIVE_MESSAGING_SETUP.md` for detailed setup and troubleshooting.

#### Native Messaging Protocol Details

- Communication uses stdio (stdin/stdout) with 4-byte little-endian length prefix
- Messages are JSON encoded
- Debug logs:
  - yt-summary.py → `/tmp/native-host-test.txt`
  - local-ai-handler.py → `/tmp/local-ai-handler.log`
- Error handling includes user-friendly messages with setup instructions

### Key Implementation Details

- Chrome Extension Manifest V3
- Dual-mode summarization (fast + deep) via native messaging
- Streaming responses for all AI interactions
- All UI updates use `textContent` to prevent XSS
- Native messaging requires manual setup (both hosts)
- Configurable AI models via `ai-config.json`
- Tests use Jest with jsdom and mocked Chrome APIs

## Security Notes

- API keys stored locally:
  - Claude API key in `config.js` (gitignored)
  - OpenAI API key in `.env` (gitignored)
- Extension uses `anthropic-dangerous-direct-browser-access` header for Claude API
- All user inputs sanitized before display (textContent, no innerHTML)
- Native messaging requires explicit manifest setup

## Debugging

**Log files:**
- `tail -f /tmp/local-ai-handler.log` - AI summarization (models, errors, API calls)
- `tail -f /tmp/native-host-test.txt` - YouTube transcript fetching

**Common issues:**
- Model param errors (reasoning/verbosity) → check ai-config.json values match model requirements
- `gpt-5.2-chat-latest` only supports `reasoning: "medium"` and `verbosity: "medium"`
- `gpt-5.2` supports full range (`none`/`low`/`medium`/`high` for reasoning)

## Testing

The project includes unit and integration tests for major components:
- `tests/background.test.js` - Background script and API integration tests
- `tests/dual-mode-integration.test.js` - Dual-mode summarization flow tests
- `tests/dual-mode-ui.test.js` - Dual-mode UI component tests

Tests use Jest with jsdom environment and comprehensive Chrome API mocks.

## "Open in Claude Code" Config (`openInClaudeCode`)

The 🖥️ "Open in Claude Code" path (`handle_open_in_cc` in `local-ai-handler.py`) is configured by the `openInClaudeCode` block in `ai-config.json` — separate from the dual-mode `models[]`/`defaultPrompt` keys, because it opens an interactive Claude Code session rather than streaming a fixed summary:

```json
"openInClaudeCode": {
  "model": "claude-opus-4-8",
  "reasoning": "max",
  "systemPrompt": "You are a transcript summarizer",
  "prompt": "Read the transcript at {ref}, summarize it and extract the key insights."
}
```

- **`prompt`** — instruction sent to the session; `{ref}` is replaced with the transcript file path (substituted via `.replace`, so other braces are left untouched).
- **`systemPrompt`** — `--append-system-prompt` on the Ghostty/`claude` CLI fallback (shell-escaped with `shlex.quote`).
- **`model`** / **`reasoning`** — used by both the Superconductor terminal-tab path (`sc layout run`) and the in-app chat fallback (`sc chat new`).

The Python host reads this block **fresh from disk on every click** (`open_in_cc_config()`), so edits take effect on the next "Open in Claude Code" with no native-host restart or extension reload. Missing keys / unreadable / invalid JSON fall back to `OPEN_IN_CC_DEFAULTS` (the prior hardcoded values), logging the reason to `/tmp/local-ai-handler.log`.
