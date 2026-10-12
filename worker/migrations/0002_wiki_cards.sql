-- Wiki step 1: per-source "cards" (claims + entity mentions + topics), extracted by an LLM.
-- Pages, canonical entities and revisions come in later migrations; this layer is the input
-- every page will cite. See docs/wiki-design.html.

-- Timestamped captions. Empty until the native host backfills them; claims carry a verbatim
-- `quote` so they can be matched to a timestamp once segments exist.
CREATE TABLE transcript_segments (
  source_id TEXT NOT NULL,     -- summaries.id
  idx       INTEGER NOT NULL,
  start_s   REAL NOT NULL,
  text      TEXT NOT NULL,
  PRIMARY KEY (source_id, idx)
);

CREATE TABLE cards (
  source_id    TEXT PRIMARY KEY,  -- summaries.id
  model        TEXT NOT NULL,
  source_hash  TEXT NOT NULL,     -- sha256 of the transcript; unchanged hash + model = skip
  gist         TEXT,
  topics       TEXT,              -- JSON array of kebab-case slugs
  json         TEXT NOT NULL,     -- full extractor output, for re-processing without a re-call
  tokens_in    INTEGER,
  tokens_out   INTEGER,
  cost_usd     REAL,
  duration_ms  INTEGER,
  created_at   INTEGER NOT NULL
);

CREATE TABLE claims (
  id         TEXT PRIMARY KEY,    -- c_<8 hex of source_id>_<idx>, stable citation id
  source_id  TEXT NOT NULL,
  idx        INTEGER NOT NULL,
  text       TEXT NOT NULL,       -- atomic, self-contained statement
  quote      TEXT,                -- verbatim span from the transcript
  quote_ok   INTEGER NOT NULL DEFAULT 0,  -- 1 if quote was found in the transcript
  kind       TEXT NOT NULL,       -- fact | opinion | advice | prediction | anecdote
  speaker    TEXT,
  start_s    REAL                 -- filled once transcript_segments exist
);
CREATE INDEX idx_claims_source ON claims (source_id, idx);

-- Raw entity mentions per source. Canonical entities (merging "Sam A." into "Sam Altman")
-- are the resolver's job in a later step.
CREATE TABLE mentions (
  source_id TEXT NOT NULL,
  name      TEXT NOT NULL,
  kind      TEXT NOT NULL,        -- person | org | product | concept | place | work
  context   TEXT,                 -- disambiguating role, e.g. "CTO of Convex"
  PRIMARY KEY (source_id, name)
);
CREATE INDEX idx_mentions_name ON mentions (name);
