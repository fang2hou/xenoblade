-- Migration 0006: regenerate leases (ADR-015)
--
-- Short-lived locks that serialize regenerate attempts per original message.
-- Replaces the once-per-message claim row `regen:<id>` previously written
-- into processed_messages; those legacy rows are inert orphans and are left
-- in place. Sequential re-runs are allowed — the rolling generation budget
-- (generation_reservations) remains the real bound on totals.
CREATE TABLE regenerate_leases (
  original_message_id TEXT PRIMARY KEY,
  expires_at          INTEGER NOT NULL
);
