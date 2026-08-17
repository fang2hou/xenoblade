-- Migration 0004: undo-able context truncation (ADR-014)
--
-- /clear-context was a truncation in disguise: it pushed the per-user
-- `reset_at` watermark forward and offered no way back. This migration adds
-- the two pieces the redesigned /context truncate|restore needs:
--
-- 1. `hard_reset_at` — an irreversible floor. Clear operations (including
--    `/chat off`, ADR-011) stamp it so a later restore can never revive
--    history that a hard clear deliberately excluded. Existing non-zero
--    `reset_at` values all came from clear operations, so they backfill the
--    floor as-is: no retroactive undo for past clears.
-- 2. `context_truncations` — the undo stack. Every /context truncate pushes
--    one row; restore pops the newest and recomputes the effective cutoff as
--    max(hard_reset_at, max(remaining truncated_at)).

ALTER TABLE user_context_state
  ADD COLUMN hard_reset_at INTEGER NOT NULL DEFAULT 0;

UPDATE user_context_state
   SET hard_reset_at = reset_at
 WHERE reset_at > 0;

CREATE TABLE context_truncations (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  scope_id     TEXT NOT NULL,
  container_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  truncated_at INTEGER NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE INDEX idx_truncations_key
  ON context_truncations(scope_id, container_id, user_id, id);
