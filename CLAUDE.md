# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Chrome extension that summarizes any page selection or YouTube video. Summaries run on a **Cloudflare Worker** (`worker/`) that calls OpenRouter, stores results in D1, renders explain-viz posters via fal into R2, and serves a dashboard. The extension is a client of that Worker.

- **Worker owns durable state.** One Durable Object (`SummaryJob`) per normalized URL runs the OpenRouter stream, so a summary finishes and saves even if the tab or service worker dies.
- **background.js keeps a render cache** of each job (`chrome.storage.local['summary:<url>']`) and relays Worker SSE deltas to the tab.
- **Reading panel** (content-dual.js): dark neutral palette (teal/amber, no blue), model picker with a remembered default (`pref:defaultModel`), in-panel prompt editor (`pref:defaultPrompt`), history view, "Summary ready" reopen pill, inline poster.
- **Two FABs on a selection:** ✨ summary + infographic, ⚡ quick summary (no infographic).
- **Dashboard** (`worker/public/index.html`): poster gallery, summary detail, per-summary chat drawer (Cloudflare Agents SDK, `SummaryChat` DO).
- Only `yt-summary.py` (`com.ytsummary.json`) remains as an optional native host (YouTube transcripts). The old local AI native host and "Open in Claude Code" flow have been removed.

## Key Commands

```bash
# Worker
cd worker && npx tsc --noEmit        # typecheck
set -a && . worker/.env && set +a && (cd worker && npx wrangler deploy)   # deploy — API token, never OAuth
set -a && . worker/.env && set +a && (cd worker && npx wrangler tail)     # live logs

# Extension: no build step. Reload it after editing (see "Live-testing").
node --check content-dual.js         # quick syntax check
```

## Architecture

### Worker (`worker/`)

- `src/index.ts` — routes. `/api/*` needs `Authorization: Bearer <APP_TOKEN>`; everything else is static assets (the dashboard). Key routes: `GET /api/models`, `GET|POST /api/prefs`, `POST /api/summarize`, `GET /api/job/<id>/stream` (SSE), `GET /api/summary/<id>`, `GET /api/summaries`, `DELETE /api/summaries/<id>`, `POST /api/import`, `/poster/<key>` (R2), `/agents/summary-chat/*` (chat agent).
- `src/job.ts` — `SummaryJob` DO: streams the generation, writes `generations` rows to D1, kicks off the poster.
- `src/openrouter.ts` — direct `fetch` to OpenRouter (no LiteLLM). Passes the model's `reasoning` object through as-is.
- `src/fal.ts` — explain-viz poster render (port of the explain-viz skill's `render.sh`) → R2 bucket `summarizer-posters`.
- `src/chat.ts` — `SummaryChat` agent (`@cloudflare/ai-chat`) for the dashboard chat drawer.
- `src/config.ts` — **the model list and prompts that actually run** (see Model config).
- Bindings: D1 `DB`, R2 `POSTERS`, Images `IMAGES`, DOs `JOB` + `SummaryChat`. Secrets: `OPENROUTER_API_KEY`, `FAL_KEY`, `APP_TOKEN` (local: `worker/.dev.vars`).

### Extension

1. **background.js** — service worker.
   - `api()` / `workerCreds()` call the Worker. Base URL + token come from the options page (`worker:base`, `worker:token`); base defaults to `https://summarizer.goldenoreo.workers.dev`.
   - Keeps one cached job per normalized URL (`normUrl` keeps YouTube's `?v=`). `streamModel()` reads the Worker's SSE stream, accumulates, and relays `updateSummary` / `summaryComplete` / `summaryError` to the tab.
   - Message API: `summarizeDual`/`summarize`/`summarizeVideo` (start), `regenerate`, `followup`, `getPageState` (rehydrate), `listSummaries`, `getSource`, `deleteSummary`, `getPoster` (R2 URL), `getConfig`, `getDashboardLink`. Toolbar icon sends `togglePanel`.
   - `resolvePreferredModel`/`resolvePreferredPrompt` apply `pref:defaultModel`/`pref:defaultPrompt` when a request omits them.
   - Transcripts (`fetchTranscript`), in order: (1) `com.ytsummary` native host (`yt-summary.py`), (2) a transcript the content script already scraped, (3) DOM scrape of the transcript panel (`yt-transcript.js`). YouTube blocks transcript fetches by ASN, so this can't move into the Worker.

2. **content-dual.js** — the universal renderer (all pages, incl. YouTube). Thin view of the background's job for the current URL; rehydrates via `getPageState`, appends deltas with a `streamingLength` gap-check, never persists. Palette in the `T` token object; styles in one injected `#cs-styles` sheet (`cs-` prefix). Enter = send, Shift+Enter = newline.
   - Model icons: a config `icon` of `"claude"` or `"openai"` renders the brand SVG (simple-icons, CC0) via `iconHTML()`; any other value (emoji, old stored icons) renders as escaped text. The dashboard has the same helper.

3. **youtube-content.js** — YouTube buttons; routes everything through the background, so content-dual.js renders the panel.
   - Watch-page buttons are appended **inside `#movie_player`** (top-right) so they follow theater/fullscreen/miniplayer; the container swallows `click`/`dblclick`/`mousedown` so pressing a button doesn't toggle playback.
   - **Feed-tile buttons** on every regular-video thumbnail (feed, search, sidebar):
     - Two layouts ship at once: old Polymer (`a#thumbnail` in `ytd-thumbnail`) and new view-model (`a.ytLockupViewModelContentImage` in `div.ytLockupViewModelHost`). Match both. Ads/Shorts/playlists are skipped (no `watch?v=`). Read `videoId` from the href **at click time** — tiles are recycled.
     - Buttons sit bottom-right of the thumbnail box at `z-index: 2019` (below the sticky masthead's 2020). They cover the duration badge while shown; top-right holds the preview's mute/CC controls.
     - **Reveal is JS pointer-tracking, not CSS `:hover`.** YouTube's inline preview (`#video-preview`, parented at `ytd-app`) floats over the tile and steals `:hover`. A throttled `mousemove` uses `document.elementsFromPoint()` to find the card underneath. A loading button stays visible when un-hovered.
     - A throttled (~250ms) `MutationObserver` re-injects on infinite scroll; idempotency is by button-presence check, so recycled tiles get a fresh button.

4. **yt-summary.py** — native host `com.ytsummary`: `youtube_transcript_api` → Webshare proxy → yt-dlp. Stdio protocol, 4-byte little-endian length + JSON. Log: `/tmp/native-host-test.txt`. Manifest `com.ytsummary.json` goes in Chrome's `NativeMessagingHosts/` (`~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` on macOS; Arc uses it too). Optional: without it, transcripts fall back to the page.

### Message flow

1. User selects text → ✨ or ⚡ → content-dual.js sends `summarizeDual {text, url, title, noPoster?}`.
2. background.js resolves model + prompt, `POST /api/summarize`, opens `/api/job/<id>/stream`.
3. The `SummaryJob` DO streams from OpenRouter, saves to D1, and (unless `noPoster`) renders the poster.
4. background.js relays deltas; content-dual.js renders. On complete, the poster loads from `/poster/<key>`.

YouTube: youtube-content.js sends `summarizeVideo {videoId}` → background.js gets the transcript (see order above) → same flow as text.

Follow-up / regenerate: `followup {question}` or `regenerate {modelId, prompt}` continue or replace the job's conversation on the Worker.

### Wiki (`/wiki`)

An agent-maintained wiki compiled from every summarized source. Design + mockups: `docs/wiki-design.html`. UI: `worker/public/wiki.html` (same `APP_TOKEN` as the dashboard).

- **Cards** (`src/wiki.ts`): queue `wiki-ingest` → Haiku 5.5 extracts claims (with a verbatim quote), entity mentions, topics → D1 `cards`/`claims`/`mentions`. Skips unchanged transcripts, stubs under 300 chars, and duplicate transcripts (only one copy of a shared transcript feeds the wiki). Claim timestamps are **approximate** (quote position at ~15 chars/s).
- **Graph** (`src/wiki-graph.ts`): canonical `topics` (librarian-designed), `entities` + `entity_alias`, `page_sources`. Topic page at 2+ sources, entity page at 3+.
- **Pages** (`src/wiki-page.ts`): one `WikiPage` DO per page. `schedule()` debounces (10 min on live ingest); the alarm runs the editor (Sonnet 5.5 above 12 sources, else Haiku). Code validates citations `[[c:ID]]` and links `[[p:slug]]`.
- **Live ingest**: `SummaryJob.start()` and `/api/import` enqueue → card → `attachSource()` → affected pages rewrite. Deleting a summary (`dropCard`) removes its claims/vectors and rewrites the pages it fed.
- **Build** (`src/wiki-build.ts`, Workflow `wiki-build`): full recompile — taxonomy, topic map, entity merge, pages, FTS + Vectorize, schedule all editors. `POST /api/wiki/build`. Re-running re-designs the taxonomy; pass `{"skipTaxonomy":true,"skipEntities":true}` to only re-index and rewrite.
- **Gardeners** (`src/wiki-garden.ts`, Workflow `wiki-garden`, cron Sunday 17:00 UTC): merge / contradiction / new-topic proposals + weekly digest. Proposals wait in `/wiki/review`; approving applies them (`applyProposal`).
- **Chat** (`src/wiki-chat.ts`): `WikiChat` agent at `/agents/wiki-chat/<thread>`, tools `search_wiki` (FTS5 + Vectorize `summarizer-wiki`, RRF), `read_page`, `read_source`.
- Debug: `POST /api/wiki/ingest-now {"id"}` runs one card synchronously and returns the real error; `POST /api/wiki/rewrite {"slug"}` rewrites one page now; `GET /api/wiki/stats`.

## Model config

**Two files, keep them in sync:**

- `worker/src/config.ts` — **what runs.** `MODELS[0]` is the default. The Worker falls back to `MODELS[0]` for an unknown model id, so a model added only to the extension silently runs the old default. **Changes need a Worker deploy.**
- `ai-config.json` — what the extension's picker shows (`id`, `name`, `icon`, `prompt`, `defaultPrompt`). Changes need an extension reload.

Both have `models[]` (primary; `[0]` is the default) and `alternateModels[]`. Ids must be unique across both. Alternates define no `prompt`, so they use the current prompt.

Prompt resolution (`resolvePrompt` in config.ts): explicit prompt → the model's own `prompt` (primaries only) → remembered `pref:defaultPrompt` → `DEFAULT_PROMPT`. So the default model's own prompt beats anything saved in the ✎ editor.

One active model at a time. Choosing a model saves `pref:defaultModel` and, if the page has a summary, sends `regenerate`. Each generation records `usedModel` ({id, name, icon}) so captions and history name the model that wrote it. **Changing the default model means resetting two saved prefs**, or the old one keeps winning:
- extension: `chrome.storage.local['pref:defaultModel']`
- Worker: D1 `prefs.defaultModel` (used when a request has no `modelId`, e.g. feed tiles) — `POST /api/prefs {"defaultModel":"<id>"}`.

### Reasoning

OpenRouter takes one unified `reasoning` field and maps it per provider; `openrouter.ts` passes it through:

```ts
reasoning: { effort: 'high' }        // current Claude (adaptive thinking) and GPT models
reasoning: { max_tokens: 10000 }     // manual thinking budget — older Claude models only
```

Current Claude models (Opus 4.8+, Fable 5.1, Sonnet 5) use adaptive thinking steered by `effort`; Opus 5.5 and Fable 5.1 can't turn thinking off. Check model IDs with `curl -s https://openrouter.ai/api/v1/models` — they change often.

## Deploying the Worker

**Always deploy with the Cloudflare API token. Never `wrangler login`.**

- The Worker lives in the **personal Cloudflare account** (tejbirwason@gmail.com, account `70f16665…`, pinned in `worker/wrangler.jsonc`). The OAuth login on this machine is the **work** account (tj@relevanceai.com, "Arg AI") and must not be used or replaced.
- `worker/.env` (gitignored, `chmod 600`) holds `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` — same token as `~/influencer-ugc/.env`. If it's missing, recreate it: `rg "^CLOUDFLARE_(API_TOKEN|ACCOUNT_ID)=" ~/influencer-ugc/.env > worker/.env`.
- Load it with `set -a` (the file has no `export` lines, so a bare `source` leaves wrangler on OAuth and the wrong account):
  ```bash
  cd worker && set -a && . ./.env && set +a && npx wrangler whoami   # must say tejbirwason@gmail.com
  cd worker && set -a && . ./.env && set +a && npx wrangler deploy
  ```
- Same for every wrangler command against this Worker (`tail`, `secret put`, `d1 migrations apply summarizer --remote`).

## Security Notes

- Secrets live in the Worker (`wrangler secret put`), not the extension. The extension holds only the `APP_TOKEN` (options page).
- Rendered markdown is sanitized with DOMPurify; untrusted data goes in via `textContent` or `escapeHtml()`.

## Debugging

- **Button spins forever.** Usually an orphaned content script: reloading the extension leaves old content scripts running but disconnected (`chrome.runtime.id` is `undefined`, `sendMessage` throws "Extension context invalidated"). **Fix: reload the page.** `sendToBackground()` / `ytSend()` detect this and show a "refresh this page" banner.
- **Stuck on "Generating with <model>…".** Check `wrangler tail` (API-token env, see Deploying). A model id the deployed Worker doesn't know falls back to `MODELS[0]`, so after a config change, deploy.
- If reloading the page doesn't help, check the service worker console (`chrome://extensions` → the extension → "service worker"). If `loadAIConfig()` throws, `configLoaded` stays `false` and every message queues in `pendingRequests` forever.
- "Worker endpoint/token not configured" → set them in the extension's options page.
- Transcript problems: `tail -f /tmp/native-host-test.txt` (yt-summary.py).

## Testing

Verify live via curl smoke tests (below) or in the browser via CDP.

### Smoke-testing the Worker (preferred for backend/model changes)
No browser needed. `APP_TOKEN` is in `worker/.dev.vars`:
```bash
T=...; B=https://summarizer.goldenoreo.workers.dev; U=https://example.com/smoke-test
curl -s -X POST -H "Authorization: Bearer $T" -H 'Content-Type: application/json' $B/api/summarize \
  -d "{\"url\":\"$U\",\"text\":\"...\",\"modelId\":\"<id>\",\"noPoster\":true}"
curl -sN --max-time 120 -H "Authorization: Bearer $T" "$B/api/job/$(python3 -c "import urllib.parse;print(urllib.parse.quote('$U',safe=''))")/stream"
```
The SSE stream stays open after completion; look for `usedModel` + `durationMs`. Delete the test entry afterwards: `DELETE /api/summaries/<encoded url>`.

### Live-testing this extension over CDP
- ⚠️ This is Tj's **real** Arc browser, in use while you test, so the active tab changes under you and `eval`/`screenshot` can hit the wrong tab. Pin a tab with `tab <id>` right before each check, never `open` in a tab Tj is using, and prefer the curl smoke test for anything that doesn't need the UI.
- Loaded **unpacked in Arc** — ID `fbmgekimgmgiiffchlkfknehmgmiphaf` (path-derived from `/Users/tj/summarizer-chrome-plugin`; no `key` in manifest, which is why the native-host `allowed_origins` match).
- Arc exposes CDP on port 9222 (`~/bin/arc-cdp`). Drive with `agent-browser --cdp 9222 ...`. Arc has many tabs open; `agent-browser tab list` / `tab <id>` before screenshots, or you'll capture the wrong one.
- **Reload after editing `background.js`, `content-dual.js`, `ai-config.json` or `manifest.json`:** open `chrome-extension://<id>/options.html`, then `eval "chrome.runtime.reload()"`, then reload the test page.
- Trigger a summary: select text, then `.click()` `#fab-container button[title^="Quick"]` (⚡, no poster) or `[title^="Summarize"]` (✨). Inspect state via `chrome.storage.local.get(null)` from the options page.

## Chat with transcript (💬 player button)

Opens the panel with the video's transcript as context and **generates nothing** until you ask. `chatVideo` → same transcript fetch as `summarizeVideo` → `startChat()` POSTs `/api/summarize` with `chat: true`; the Worker's `SummaryJob.start` seeds the conversation (`CHAT_PROMPT` + transcript as one system turn) and skips `run()`. The first question goes through the normal `followup` route. Jobs carry `mode: 'summary' | 'chat'`; "Summarize instead" calls `regenerate`, which flips the job back to `summary`. In chat mode the picker never regenerates — `followup {modelId}` moves the thread to the new model (Worker copies the messages).

SSE `snapshot`/`complete` carry only the **current turn** (`gen.turnStart`); `gen.content` in D1 still accumulates every turn for the dashboard.

## Icons

Buttons use Lucide line icons from `icons.js` (`self.CS_ICONS`, loaded in both content-script entries, so it's guarded against running twice). Player/tile buttons are "glass mono" (translucent dark circle, white icon, teal on hover). Model icons in the picker/history go through `iconHTML()` (brand logos); chat jobs show 💬 in history.

