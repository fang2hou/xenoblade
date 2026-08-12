-- Migration 0001: Initial schema for xenoblade database (v2 architecture)
-- Replaces the old xenoblade-dev schema; see ADR-009.

-- guild/server-level configuration
CREATE TABLE guild_config (
  guild_id      TEXT PRIMARY KEY,
  enabled       INTEGER NOT NULL DEFAULT 1,
  allow_channels_json TEXT NOT NULL DEFAULT '[]'
);

-- bot global key-value config
CREATE TABLE bot_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- message-level idempotency (survives runtime restarts)
CREATE TABLE processed_messages (
  message_id TEXT PRIMARY KEY,
  claim_key  TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- generation budget reservations (rolling 24h window)
CREATE TABLE generation_reservations (
  reservation_id  INTEGER PRIMARY KEY AUTOINCREMENT,
  container_id    TEXT NOT NULL,
  reserved_tokens INTEGER NOT NULL,
  created_at      INTEGER NOT NULL,
  finalized_at    INTEGER
);

CREATE INDEX idx_reservations_window
  ON generation_reservations(container_id, created_at);

-- interaction telemetry
CREATE TABLE interactions (
  id                 TEXT PRIMARY KEY,
  container_id       TEXT NOT NULL,
  scope_id           TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  summon_kind        TEXT NOT NULL,
  model              TEXT NOT NULL,
  status             TEXT NOT NULL,  -- completed|failed|timeout|budget_exceeded
  input_tokens       INTEGER,
  output_tokens      INTEGER,
  cache_read_tokens  INTEGER,
  cache_write_tokens INTEGER,
  total_duration_ms  INTEGER,
  created_at         INTEGER NOT NULL
);

CREATE INDEX idx_interactions_container
  ON interactions(container_id, created_at);
CREATE INDEX idx_interactions_user
  ON interactions(user_id, created_at);

-- per-user per-container context reset
CREATE TABLE user_context_state (
  scope_id           TEXT NOT NULL,
  container_id       TEXT NOT NULL,
  user_id            TEXT NOT NULL,
  reset_at           INTEGER NOT NULL DEFAULT 0,
  last_interaction_at INTEGER,
  PRIMARY KEY (scope_id, container_id, user_id)
);

-- per-user memory (persona, preferences, facts)
CREATE TABLE user_memory (
  user_id    TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('persona', 'preference', 'fact')),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, category, key)
);

-- tool invocation audit
CREATE TABLE tool_invocations (
  id              TEXT PRIMARY KEY,
  interaction_id  TEXT NOT NULL,
  tool_name       TEXT NOT NULL,
  server          TEXT,  -- MCP server name or 'builtin'
  status          TEXT NOT NULL,  -- ok|error|timeout
  duration_ms     INTEGER,
  input_size      INTEGER,
  output_size     INTEGER,
  error_code      TEXT,
  created_at      INTEGER NOT NULL
);

CREATE INDEX idx_tool_invocations_interaction
  ON tool_invocations(interaction_id);
