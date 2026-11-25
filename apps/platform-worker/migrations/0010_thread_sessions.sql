-- Migration 0010: thread sessions and last-turn snapshots (ADR-003 amendment)
--
-- thread_sessions: one row per thread the bot was summoned in. `active`
-- decides whether un-summoned messages there summon the bot, and
-- pending_card_ids_json lists the question cards still waiting for an answer
-- so they are cleaned up across Runtime restarts. It holds ids and flags
-- only — never message text.
--
-- container_last_turns: the latest prompt and reply of a guild conversation,
-- for the retry_last_reply tool. It stores guild conversations only: a DM
-- (scope_id 'dm') is never written here, enforced in src/thread-sessions.ts.
CREATE TABLE thread_sessions (
    thread_id              TEXT PRIMARY KEY,
    guild_id               TEXT NOT NULL,
    parent_channel_id      TEXT NOT NULL,
    created_by             TEXT NOT NULL,
    active                 INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
    pending_card_ids_json  TEXT NOT NULL DEFAULT '[]',
    created_at             INTEGER NOT NULL,
    updated_at             INTEGER NOT NULL
);

CREATE INDEX idx_thread_sessions_guild_active
    ON thread_sessions(guild_id, active, updated_at DESC);

CREATE TABLE container_last_turns (
    container_id        TEXT PRIMARY KEY,
    scope_id            TEXT NOT NULL,
    channel_id          TEXT NOT NULL,
    user_id             TEXT NOT NULL,
    user_display_name   TEXT NOT NULL,
    trigger_message_id  TEXT NOT NULL,
    trigger_content     TEXT NOT NULL,
    assistant_reply     TEXT NOT NULL,
    updated_at          INTEGER NOT NULL
);
