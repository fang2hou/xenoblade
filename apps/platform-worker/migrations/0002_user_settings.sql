-- Migration 0002: per-user opt-in settings (ADR-011 DM chat, ADR-012 auto memory)
--
-- Both flags default to 0 (OFF). The *_at columns record when the opt-in was
-- last enabled and are cleared back to NULL on opt-out, so the boolean flag is
-- the single source of truth for current state.

CREATE TABLE user_settings (
  user_id        TEXT PRIMARY KEY,
  chat_optin     INTEGER NOT NULL DEFAULT 0 CHECK (chat_optin IN (0, 1)),
  learn_optin    INTEGER NOT NULL DEFAULT 0 CHECK (learn_optin IN (0, 1)),
  chat_optin_at  INTEGER,
  learn_optin_at INTEGER
);
