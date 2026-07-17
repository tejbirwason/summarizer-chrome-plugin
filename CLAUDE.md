# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension providing AI-powered summarization of any page selection or YouTube video, via a local Python native-messaging host that routes to OpenRouter models. Key traits:

- **Background-owned job store** — the service worker owns all summary state + persistence, so a summary keeps generating and gets saved even after you navigate away from the tab that started it. Content scripts are thin renderers that rehydrate from the background (`getPageState`).
- **Redesigned reading panel** — dark neutral palette (teal/amber accents, no blue), document-style summary + right-aligned chat turns, sticky follow-up composer.
- **First-class model picker** with a remembered default (`pref:defaultModel`), an in-panel **editable prompt** (`pref:defaultPrompt`), a **history** view of past summaries, a "Summary ready" reopen pill on already-summarized pages, and **inline poster** display (downscaled preview of an explain-viz graphic).
- The old ✒️ **draft** flow was removed. Only ✨ Summarize and 🖥️ Open in Claude Code remain.

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

1. **background.js** - Service worker that **owns the job store** (the heart of the design):
   - One **job per normalized URL** (`normUrl` keeps YouTube's `?v=` in the key). A job holds the source text, prompt, `activeModelId`, and a per-model `{ messages, streaming, inProgress, complete, usedModel, duration }`. Deltas accumulate here and are throttle-persisted to `chrome.storage.local['summary:<url>']` + flushed on complete — so generation survives the content script dying.
   - `streamModel()` connects the native port, accumulates, relays best-effort to the tab, and runs an **idle watchdog** (150s, reset per delta) that errors out a hung LiteLLM call instead of spinning forever. `loadJob()` clears stale `inProgress` flags on rehydration (a job reaching that path has no live port).
   - Message API: `summarizeDual`/`summarizeVideo` (start), `regenerate` (model/prompt swap), `followup`, `getPageState` (rehydrate), `listSummaries` (history), `deleteSummary`, `getPoster` (inline graphic), `openInCC`/`openVideoInCC`, `getSummaryStatus`/`openGraphic`, `getConfig`. The toolbar icon (`chrome.action.onClicked`) sends `togglePanel`.
   - `resolvePreferredModel`/`resolvePreferredPrompt` apply the remembered `pref:defaultModel`/`pref:defaultPrompt` when a request omits them, so the picker's choice applies to every entry point (incl. YouTube's button, which can't know the pref).

2. **content-dual.js** - The **universal renderer** (injected on all pages, incl. YouTube — youtube-content.js only draws buttons and routes through the background, so this file renders every panel):
   - Thin, reactive VIEW of the background's job for the current URL. On load it queries `getPageState` and rehydrates; while streaming it appends deltas (with a `streamingLength` gap-check that triggers a resync on reconnect); it never persists.
   - Creates the selection FABs (✨ Summarize, 🖥️ Open in Claude Code), the panel (masthead: title, 🕘 history, 📄 copy, ✕ close; toolbar: model picker, ✎ prompt editor, ↻ regenerate; scroll region; sticky composer), the history view, the model dropdown, and the "Summary ready" reopen pill.
   - Palette lives in the `T` token object; all styles in one injected `#cs-styles` sheet (classes prefixed `cs-`). Enter=send / Shift+Enter=newline in the composer.

3. **youtube-content.js** - YouTube-specific content script:
   - Adds "✨ Summarize" + "🖥️ Open in Claude Code" buttons to YouTube video pages (`/watch`), appended **inside `#movie_player`** at its top-right corner. Anchoring to the player (rather than `position: fixed` on `document.body`) keeps them on the video across theater/fullscreen/miniplayer instead of floating over page content; the container swallows `click`/`dblclick`/`mousedown` so pressing a button doesn't toggle playback.
   - Initiates dual-mode video summarization
   - **Feed-tile buttons**: also injects a hover-revealed 🖥️ "Open in Claude Code" button onto every regular-video thumbnail across the feed / search results / watch-page sidebar, so a transcript can be opened in Claude Code without navigating into the video. Reuses the existing `openVideoInCC` message flow — no `background.js` or native-host changes. Implementation notes:
     - **Two layouts must both be handled** — YouTube ships them simultaneously: the old Polymer markup (search results, watch sidebar) uses `a#thumbnail` inside `ytd-thumbnail`; the new view-model markup (home + channel grids) uses `a.ytLockupViewModelContentImage` (no `id`) inside `div.ytLockupViewModelHost`. The selector matches both; missing the new one is why buttons never showed on the home feed. Ads/Shorts/playlists are skipped (hrefs lack `watch?v=`); `videoId` is read from the anchor href **at click time** (tiles are virtualized/recycled, so caching the ID would summarize the wrong video).
     - The button is appended to the **thumbnail box** — `ytd-thumbnail` (old) or `.ytLockupViewModelHost` (new) — both `position: relative` and coincident with the thumbnail in every renderer. Positioned **bottom-right** (`✨` at `right: 46px`, `🖥️` at `right: 8px`) at `z-index: 2019` — above the content-level preview but below the sticky masthead (`z-index: 2020`) so buttons never bleed over the search bar when a tile scrolls up. Note this corner also holds YouTube's duration badge, which the buttons cover while shown; top-right was avoided because the inline-preview mute/CC controls live there.
     - **Reveal is JS pointer-tracking, NOT CSS `:hover`.** When the inline hover-preview plays, YouTube floats a shared `#video-preview` element (parented at `ytd-app`) over the thumbnail, so the cursor's hit-test target becomes the preview, not the tile — the tile loses `:hover` and a CSS-revealed button vanishes exactly when you're looking at it. A throttled `mousemove` handler uses `document.elementsFromPoint(x, y)` (which sees *through* the overlay to the card beneath) to resolve the card under the cursor and toggle that card's button visible. An in-flight (loading) button stays visible even when un-hovered.
     - A `MutationObserver` (throttled ~250ms) re-injects as infinite scroll adds tiles; idempotency is by button-presence check (not a flag) so recycled tiles that get their children wiped get a fresh button.
     - On success a green toast ("✅ Opened in Claude Code") slides up and the clicked button briefly shows ✅; the completion listener is guarded by `activeCCTileBtn` so the watch-page fixed button's flow is untouched. Only one open is tracked at a time.

4. **local-ai-handler.py** - Native messaging host for summarization:
   - `models[]` are the picker's primary models (default = `models[0]`, the "best" pick); `alternateModels[]` are additional picker/regenerate targets. Both are selectable from the single in-panel model picker (the old per-model tab UI is gone — one active model at a time, switching regenerates).
   - Summary state keys by URL in the background now (not per-model-id in the content script), so model-id renames no longer strand saved summaries.
   - All models route through OpenRouter via LiteLLM (`openrouter/` prefix), authenticated by `OPENROUTER_API_KEY`. Supports streaming; handles text + transcript summarization.
   - **`getGraphic`** returns a generated explain-viz poster as an inline JPEG **preview** — the originals are 4K (11–14 MB), far over Chrome's ~1 MB native-message cap, so it downscales with the built-in `sips` (no extra Python deps) and returns the ORIGINAL path so a click still opens full-res in Preview.

5. **yt-summary.py** - Native messaging host for YouTube:
   - Fetches YouTube transcripts using youtube_transcript_api
   - Communicates via stdio protocol
   - Returns full transcript to background script

### Message Flow

**Text Summarization:**
1. User selects text → FAB appears → clicks ✨
2. content-dual.js sends `summarizeDual` (with `url`, `title`, optional `prompt`) to background.js
3. background.js creates a job keyed by the URL, resolves the preferred model, connects the native port
4. local-ai-handler.py streams the summary; background.js accumulates into the job, persists, and relays deltas to the tab
5. content-dual.js renders the streaming summary; on complete it's saved (survives navigation) and a follow-up composer/history/model-picker are available

**Follow-up / Regenerate:** content-dual.js sends `followup {question}` or `regenerate {modelId, prompt}`; the background continues/replaces the job's conversation and streams back. The model picker persists `pref:defaultModel`; the prompt editor persists `pref:defaultPrompt`.

**YouTube Summarization:** youtube-content.js sends `summarizeVideo {videoId}` → background.js fetches the transcript via yt-summary.py → starts a job exactly like text summarization → **content-dual.js** renders the panel (youtube-content.js only draws buttons + clears their spinners on summary events).

### YouTube Transcript Summarization Flow

1. **Button Creation**: youtube-content.js detects YouTube page, adds "✨ Summarize" button
2. **User Clicks**: Extracts video ID, sends `summarizeVideo` to background.js
3. **Transcript Fetching**: background.js → yt-summary.py (native messaging) → youtube_transcript_api
4. **Transcript Return**: yt-summary.py returns full transcript via stdio protocol (4-byte length + JSON)
5. **Summarization**: background.js creates a URL-keyed job → local-ai-handler.py streams the summary with the preferred model
6. **Streaming Display**: deltas stream to **content-dual.js** (the renderer), which shows the panel; if the video has a generated explain-viz poster it loads inline via `getPoster`

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

3. **Environment Setup**: Create `.env` with `OPENROUTER_API_KEY` (see `.env.example`)

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
  - `OPENROUTER_API_KEY` in `.env` (gitignored) — used by local-ai-handler.py for all summarization
  - (The old Claude-API draft flow and its `config.js` key are gone; `background.js` still `importScripts('config.js')` defensively so an existing file doesn't break, but it's no longer required.)
- Rendered markdown is sanitized with DOMPurify; data injected as `textContent` (no `innerHTML` for untrusted data)
- Native messaging requires explicit manifest setup

## Debugging

**Log files:**
- `tail -f /tmp/local-ai-handler.log` - AI summarization (models, errors, API calls)
- `tail -f /tmp/native-host-test.txt` - YouTube transcript fetching

**Common issues:**
- **Button spins forever, nothing in either log.** Almost always an orphaned content script, not broken code. Reloading the extension leaves the content scripts already injected into open tabs running but disconnected — `chrome.runtime.id` becomes `undefined` and `sendMessage` throws "Extension context invalidated". The message never reaches background.js, so *no log line is written anywhere*. **Fix: reload the page.** Diagnose it by checking whether `/tmp/local-ai-handler.log` shows the `status` polls (every ~15s from youtube-content.js) suddenly stopping — that timestamp is when the extension was reloaded. `sendToBackground()` / `ytSend()` now detect this, clear the spinners, and show a "refresh this page" banner instead of hanging.
- If reloading the page doesn't help, check the service worker console (`chrome://extensions` → the extension → "service worker"). If `loadAIConfig()` throws, `configLoaded` stays `false` and **every** message queues in `pendingRequests` forever — identical silent-hang symptom, different cause.
- `litellm.UnsupportedParamsError: openrouter does not support parameters: ['reasoning_effort']` (or `['thinking']`) → something is setting LiteLLM's *native* reasoning params on an `openrouter/` model. Don't. Use the unified `reasoning` object (see below); `build_params()` routes it to `extra_body`. LiteLLM accepts `reasoning_effort` for `gpt-5.6-sol` but rejects it for `gpt-5.6-sol-pro`, so this failure is per-model and easy to miss.
- Occasionally LiteLLM yields the whole completion as a single stream chunk (~60s of blank overlay, then the full summary at once). Raw OpenRouter SSE streams normally, so this is a LiteLLM-side hiccup, not a config error. `summaryComplete` carries the full text, so output is never lost.
- Verify the model list with `curl -s https://openrouter.ai/api/v1/models` — model IDs change often.

## Reasoning config (`build_params` in local-ai-handler.py)

OpenRouter exposes **one** unified `reasoning` field and maps it onto whatever the upstream provider expects. So a model entry writes reasoning once, provider-agnostically:

```json
"reasoning": "high"                  // shorthand → {"effort": "high"}
"reasoning": {"effort": "high"}      // OpenAI-style effort
"reasoning": {"max_tokens": 10000}   // Anthropic-style thinking budget
```

`build_params()` passes this through as `extra_body={"reasoning": ...}` for any `openrouter/`-prefixed model. The legacy `reasoning_effort` / `thinking` provider-sniffing path is retained **only** for direct `openai/...` / `anthropic/...` entries, should one ever be added back. There is no longer a `thinking` key in ai-config.json.

## Model picker (`models[]` + `alternateModels[]`)

`ai-config.json` has two model arrays, both selectable from the single in-panel picker:

- **`models[]`** — primary picks; `models[0]` is the default ("best") pick used when nothing is remembered.
- **`alternateModels[]`** — additional picker options (no separate UI of their own).

Ids must be unique across both arrays (`loadAIConfig` enforces this). Alternates define **no `prompt`**, so they inherit the current prompt — switching model is a pure model swap, same instructions.

There is **one active model at a time**. Choosing a different model in the picker (a) persists `pref:defaultModel` (the remembered default for future summaries), and (b) if the page already has a summary, sends `regenerate {modelId, prompt}` — the background rebuilds the job's conversation on the new model and streams it back into the same panel. Each job's per-model slot carries `usedModel` ({id, name, icon}) so the caption, "Generating with …" placeholder, and history entry name the model that actually wrote the content. Follow-ups continue with the active model.

## Testing

⚠️ The Jest suite (`tests/*.test.js`) is **stale** — it targets the pre-rewrite architecture (Hetzner `/summarize` + `/draft` HTTP API, fixed fast/deep tabs, hex-vs-`rgb()` assertions) and largely fails against the current native-messaging + job-store code. It needs a from-scratch rewrite. **Verification is done live in the browser via CDP** (agent-browser driving Arc — see below), not this suite.

### Live-testing this extension over CDP
- The extension is loaded **unpacked in Arc** (Chromium) — ID `fbmgekimgmgiiffchlkfknehmgmiphaf` is path-derived from `/Users/tj/summarizer-chrome-plugin` (no `key` in manifest), which is why the native-host `allowed_origins` match. Native-host manifests live in Google **Chrome**'s `NativeMessagingHosts/` dir but Arc uses them.
- Arc exposes CDP on port 9222 (`~/bin/arc-cdp`). Drive with `agent-browser --cdp 9222 ...`.
- **Reload the extension after editing `background.js`/`manifest.json`**: open `chrome-extension://<id>/options.html`, then `eval "chrome.runtime.reload()"`. (Python native-host edits need no reload — the host is spawned fresh per message.)
- Trigger a summary from page context by selecting text and `.click()`-ing `#fab-container button[title="Summarize selection"]`; inspect state via `chrome.storage.local.get(null)` from the options page.

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
