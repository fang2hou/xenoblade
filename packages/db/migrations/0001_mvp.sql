-- Xenoblade MVP schema (stage 0/1).
-- All statements are idempotent so re-applying is safe.

-- Per-guild runtime config. No row => guild enabled, all channels allowed.
CREATE TABLE IF NOT EXISTS guild_config (
  guild_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  allow_channels_json TEXT NULL,
  updated_at INTEGER NOT NULL
);

-- Bot-wide config (key/value). Holds dm_enabled (missing => enabled).
CREATE TABLE IF NOT EXISTS bot_config (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL
);

-- Gateway delivery de-duplication. Only the Discord message id is stored,
-- never the message body.
CREATE TABLE IF NOT EXISTS processed_messages (
  message_id TEXT PRIMARY KEY NOT NULL,
  received_at INTEGER NOT NULL
);

-- Generation budget reservations. reserved_tokens is a conservative budget
-- claimed before a model call; consumed_tokens is back-filled with actual
-- provider usage when available (else stays NULL).
CREATE TABLE IF NOT EXISTS generation_reservations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  consumed_tokens INTEGER NULL,
  created_at INTEGER NOT NULL
);

-- Interaction telemetry. One row per generation attempt.
CREATE TABLE IF NOT EXISTS interactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('mention','subscribed')),
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('success','error','cancelled')),
  requested_output_tokens INTEGER NOT NULL,
  completion_tokens INTEGER NULL,
  cost_micros INTEGER NULL,
  latency_ms INTEGER NULL,
  error_code TEXT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_interactions_created_at
  ON interactions(created_at);

CREATE INDEX IF NOT EXISTS idx_interactions_thread_created_at
  ON interactions(thread_id, created_at);

CREATE INDEX IF NOT EXISTS idx_generation_reservations_created_at
  ON generation_reservations(created_at);
