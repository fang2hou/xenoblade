-- Xenoblade stage 2: per-user context state and cache usage telemetry.
-- 0001_mvp.sql is always applied before this migration, and each migration
-- is applied exactly once, so plain ALTER TABLE is safe here.

-- Per-user, per-container context reset / active-session state.
-- Stores only epochs (reset_at, last_interaction_at); Discord remains the
-- source of truth for message bodies. reset_at filters which historical
-- messages a user may see; clearing user A never touches user B.
CREATE TABLE IF NOT EXISTS user_context_state (
  scope_id TEXT NOT NULL,
  container_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  reset_at INTEGER NOT NULL DEFAULT 0,
  last_interaction_at INTEGER NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (scope_id, container_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_user_context_last_interaction
  ON user_context_state(container_id, last_interaction_at);

-- Cache usage telemetry for interaction rows. All nullable: providers may
-- omit cache metrics entirely.
ALTER TABLE interactions ADD COLUMN input_tokens INTEGER NULL;
ALTER TABLE interactions ADD COLUMN cache_read_tokens INTEGER NULL;
ALTER TABLE interactions ADD COLUMN cache_write_tokens INTEGER NULL;
