# Summarizer Chrome Extension + Cloud Wiki

Chrome extension that summarizes any webpage selection or YouTube video, backed by a **Cloudflare Worker** (`worker/`) that streams OpenRouter models, renders editorial infographic posters via fal into R2, hosts a reading dashboard + chat drawer, and maintains a personal knowledge wiki (`/wiki`).

## Components

- **Cloudflare Worker (`worker/`)**:
  - `SummaryJob` Durable Object: streams completions from OpenRouter (`OPENROUTER_API_KEY`), persists summaries to D1, renders posters via fal (`FAL_KEY`) into R2, and enqueues each source into `WIKI_INGEST`.
  - **Dashboard (`/`)**: poster gallery, reading view, and per-summary `SummaryChat` drawer.
  - **Wiki (`/wiki`)**: agent-maintained knowledge wiki — Haiku 5.5 card extraction, Opus 5.5 taxonomy librarian, `bge-m3` embeddings + Vectorize + FTS5 hybrid search, debounced `WikiPage` editors (Haiku 5.5 / Sonnet 5.5), weekly `WikiGarden` proposals/digest, and `WikiChat`.
- **Chrome Extension (root)**:
  - `background.js` — service worker talking to the Worker via `APP_TOKEN` and caching active jobs.
  - `content-dual.js` — universal reading panel, model picker, prompt editor, history, and follow-up composer.
  - `youtube-content.js` + `yt-transcript.js` — YouTube player & feed-tile buttons + in-page transcript scraper fallback.
  - `ai-config.json` — model picker metadata (kept in sync with `worker/src/config.ts`).
- **Optional YouTube transcript native host (`yt-summary.py` + `com.ytsummary.json`)**:
  - Primary YouTube transcript fetcher (`youtube-transcript-api` → optional Webshare proxy → `yt-dlp`) because YouTube blocks datacenter IPs. Optional: without it, the extension falls back to `yt-transcript.js`.

## Setup

1. **Load the extension** unpacked from this directory in `chrome://extensions/` (Developer mode).
2. **Configure Worker credentials** in the extension options page:
   - Worker base URL (default `https://summarizer.goldenoreo.workers.dev`)
   - `APP_TOKEN`
3. *(Optional)* Install the YouTube transcript native host:
   ```bash
   scripts/install.sh <EXTENSION_ID>
   ```
   Optionally copy `.env.example` → `.env` for Webshare proxy credentials, then fully quit and relaunch Chrome.

## Worker Development & Deploy

Worker runtime secrets (`OPENROUTER_API_KEY`, `FAL_KEY`, `APP_TOKEN`) are stored in Cloudflare (`wrangler secret put`) and locally in `worker/.dev.vars`. Deploy credentials (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`) live in `worker/.env`.

```bash
cd worker && npx tsc --noEmit
cd worker && set -a && . ./.env && set +a && npx wrangler deploy
```

See `CLAUDE.md` for full architecture and debugging details.
