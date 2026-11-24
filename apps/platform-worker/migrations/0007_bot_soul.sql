-- Migration 0007: per-scope bot soul (persona and voice)
--
-- One row per scope: a guild id holds that server's own soul, and the
-- reserved key 'default' holds the global fallback. A scope without a row
-- falls back to 'default', then to the built-in DEFAULT_SOUL in
-- src/soul.ts. The 'dm' scope never owns a row: it reads only 'default',
-- and the soul cannot be edited from DMs.
CREATE TABLE bot_soul (
  scope_id   TEXT PRIMARY KEY,
  content    TEXT NOT NULL,
  updated_by TEXT,
  updated_at INTEGER NOT NULL
);
