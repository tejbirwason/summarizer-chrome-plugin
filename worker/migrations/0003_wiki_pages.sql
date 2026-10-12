-- Wiki step 2: canonical topics + entities, pages compiled from claims, revisions, review
-- proposals, and keyword search. See docs/wiki-design.html.

-- Canonical topic taxonomy, designed by the librarian agent from the raw card topics.
CREATE TABLE topics (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  grp         TEXT,               -- top-level group, e.g. "AI", "Business"
  description TEXT
);
-- Raw card topic slug -> canonical topic. A raw slug may map to nothing ('' = dropped).
CREATE TABLE topic_map (
  raw   TEXT PRIMARY KEY,
  topic TEXT NOT NULL
);

-- Canonical entities. Raw mention names resolve here through entity_alias.
CREATE TABLE entities (
  id      TEXT PRIMARY KEY,        -- slug, e.g. "sam-altman"
  name    TEXT NOT NULL,
  kind    TEXT NOT NULL,           -- person | org | product | concept | place | work
  context TEXT
);
CREATE TABLE entity_alias (
  alias     TEXT PRIMARY KEY,      -- normalized mention name (lowercase, punctuation stripped)
  entity_id TEXT NOT NULL
);
CREATE INDEX idx_alias_entity ON entity_alias (entity_id);

-- Claims also get an approximate timestamp (position of the quote in the transcript at
-- ~15 chars/s of speech) until real caption segments exist.
ALTER TABLE claims ADD COLUMN approx INTEGER NOT NULL DEFAULT 1;
-- Normalized mention name, the join key into entity_alias.
ALTER TABLE mentions ADD COLUMN norm TEXT;
CREATE INDEX idx_mentions_norm ON mentions (norm);

CREATE TABLE pages (
  slug         TEXT PRIMARY KEY,   -- "topic/agent-memory", "person/sam-altman"
  kind         TEXT NOT NULL,      -- topic | person | org | product | concept | place | work
  ref          TEXT NOT NULL,      -- topics.slug or entities.id
  title        TEXT NOT NULL,
  summary      TEXT,               -- one-liner shown in lists
  body_md      TEXT,               -- editor output with [[c:<claim>]] and [[p:<slug>]] markers
  rev          INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  claim_count  INTEGER NOT NULL DEFAULT 0,
  dirty        INTEGER NOT NULL DEFAULT 1,  -- new claims not yet written into body_md
  notes        TEXT,               -- JSON array of gardener notes the next rewrite must address
  updated_at   INTEGER NOT NULL
);
CREATE INDEX idx_pages_kind ON pages (kind, source_count DESC);
CREATE INDEX idx_pages_updated ON pages (updated_at DESC);

CREATE TABLE page_sources (
  page_slug TEXT NOT NULL,
  source_id TEXT NOT NULL,
  PRIMARY KEY (page_slug, source_id)
);
CREATE INDEX idx_page_sources_src ON page_sources (source_id);

CREATE TABLE page_revisions (
  page_slug  TEXT NOT NULL,
  rev        INTEGER NOT NULL,
  body_md    TEXT,
  summary    TEXT,
  model      TEXT,
  reason     TEXT,
  cost_usd   REAL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (page_slug, rev)
);
CREATE INDEX idx_revisions_created ON page_revisions (created_at DESC);

-- Agent-proposed structural changes awaiting your decision.
CREATE TABLE proposals (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL,        -- merge | new_page | contradiction
  title      TEXT NOT NULL,
  detail     TEXT,
  payload    TEXT NOT NULL,        -- JSON, shape depends on kind
  status     TEXT NOT NULL DEFAULT 'open',  -- open | approved | rejected
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE INDEX idx_proposals_status ON proposals (status, created_at DESC);

CREATE TABLE digests (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  body_md    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE pages_fts USING fts5(slug UNINDEXED, title, body, tokenize = 'porter unicode61');
CREATE VIRTUAL TABLE claims_fts USING fts5(id UNINDEXED, source_id UNINDEXED, text, tokenize = 'porter unicode61');
