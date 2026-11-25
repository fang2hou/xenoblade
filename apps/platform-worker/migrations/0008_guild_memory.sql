-- Migration 0008: per-guild shared memory (ADR-013 amendment)
--
-- Knowledge a guild asked the bot to remember for everyone in that server.
-- It is injected into guild conversations only — never into a DM — and every
-- write to it is confirmed with a button click first. The cap of 100 entries
-- per guild is enforced in src/db.ts, not by the schema.
CREATE TABLE guild_memory (
  guild_id   TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('fact', 'preference')),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  updated_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (guild_id, category, key)
);
