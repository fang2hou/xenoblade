-- Migration 0011: owner-approved Discord server administration plans & audit log
--
-- Stores frozen administration plans proposed during owner-only private admin
-- sessions. A plan transitions atomically from `pending` -> `executing` via a
-- single CAS UPDATE (`handleAdminPlanClaim`) before the Discord Runtime
-- executes the frozen REST operations, preventing double-clicks, replays, and
-- drift between what the approval card showed and what runs.
CREATE TABLE admin_action_plans (
  id                TEXT PRIMARY KEY,
  guild_id          TEXT NOT NULL,
  channel_id        TEXT NOT NULL,
  requester_user_id TEXT NOT NULL,
  summary           TEXT NOT NULL,
  actions_json      TEXT NOT NULL,
  payload_sha256    TEXT NOT NULL,
  risk_level        TEXT NOT NULL CHECK (risk_level IN ('standard', 'high')),
  status            TEXT NOT NULL CHECK (
    status IN ('pending', 'executing', 'completed', 'failed', 'cancelled', 'expired')
  ),
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,
  decided_at        INTEGER,
  decided_by        TEXT,
  result_json       TEXT
);

CREATE INDEX idx_admin_action_plans_guild_status
  ON admin_action_plans(guild_id, status, created_at DESC);
