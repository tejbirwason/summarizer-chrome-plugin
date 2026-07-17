-- One row per summarized URL. Transcripts live here rather than R2: a 39-minute talk
-- measured 38 KB against D1's 2 MB row cap (~50x headroom), and D1 bills per row read,
-- not per byte. Poster bytes are the opposite case — 10-12.7 MB, 5x over the cap — so
-- those go to R2 and only their key is stored here.
CREATE TABLE summaries (
  id         TEXT PRIMARY KEY,          -- normalized URL (YouTube ?v= preserved)
  url        TEXT NOT NULL,
  title      TEXT,
  kind       TEXT NOT NULL DEFAULT 'page',  -- 'video' | 'page'
  video_id   TEXT,
  transcript TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_summaries_created ON summaries (created_at DESC);

-- One row per (summary, model). Mirrors the per-model slots in background.js's job so
-- switching models keeps each model's own content, and history can name the model that
-- actually wrote it.
CREATE TABLE generations (
  id          TEXT PRIMARY KEY,
  summary_id  TEXT NOT NULL REFERENCES summaries (id) ON DELETE CASCADE,
  model_id    TEXT NOT NULL,
  model_name  TEXT,
  model_icon  TEXT,
  prompt      TEXT,
  content     TEXT NOT NULL DEFAULT '',
  state       TEXT NOT NULL DEFAULT 'streaming',  -- streaming | complete | error
  error       TEXT,
  duration_ms INTEGER,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL,
  UNIQUE (summary_id, model_id)
);
CREATE INDEX idx_generations_summary ON generations (summary_id);
CREATE INDEX idx_generations_state ON generations (state);

CREATE TABLE posters (
  id             TEXT PRIMARY KEY,
  summary_id     TEXT NOT NULL REFERENCES summaries (id) ON DELETE CASCADE,
  r2_key         TEXT,
  thumb_r2_key   TEXT,
  state          TEXT NOT NULL DEFAULT 'queued',  -- queued | generating | complete | error
  fal_request_id TEXT,
  error          TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE INDEX idx_posters_summary ON posters (summary_id);
CREATE INDEX idx_posters_state ON posters (state);

-- Replaces chrome.storage's pref:defaultModel / pref:defaultPrompt so the extension and
-- the dashboard agree on one default.
CREATE TABLE prefs (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
