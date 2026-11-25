-- Migration 0009: 90-day guild message history index (FTS5)
--
-- A reconstructible index of what was said in the public channels a guild
-- allows the bot in (allow_channels_json) — never in DMs. The Runtime streams
-- message creates, edits, and deletes to POST /internal/v1/messages/ingest,
-- which keeps both tables in step: guild_messages holds the message, and
-- guild_messages_fts holds its word-segmented text for full-text search.
-- Rows older than 90 days are pruned during ingest (src/history-index.ts).
--
-- A message's row in guild_messages_fts has the rowid of its row in
-- guild_messages: the SQLite-owned `id`, never the Discord message id. FTS5
-- deletes by rowid, and deriving one from a message id would let ids outside
-- the signed 64-bit range alias each other.

CREATE TABLE guild_messages (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id        TEXT NOT NULL UNIQUE,
  guild_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  parent_channel_id TEXT,
  author_id         TEXT NOT NULL,
  author_name       TEXT NOT NULL,
  is_bot            INTEGER NOT NULL DEFAULT 0 CHECK (is_bot IN (0, 1)),
  content           TEXT NOT NULL,
  reply_to_id       TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE INDEX idx_guild_messages_channel_time
  ON guild_messages(guild_id, channel_id, created_at DESC);

CREATE INDEX idx_guild_messages_guild_time
  ON guild_messages(guild_id, created_at DESC);

CREATE INDEX idx_guild_messages_author_time
  ON guild_messages(guild_id, author_id, created_at DESC);

CREATE VIRTUAL TABLE guild_messages_fts USING fts5(
  message_id UNINDEXED,
  guild_id UNINDEXED,
  channel_id UNINDEXED,
  segmented_content,
  tokenize = 'unicode61'
);
