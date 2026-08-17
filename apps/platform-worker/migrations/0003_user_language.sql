-- Migration 0003: per-user UI language for runtime-rendered notices
--
-- Controls the language of bot NOTICE strings only (staged status, slash
-- command replies, DM control-plane messages). Chat reply language is always
-- inferred from the conversation and never uses this column. Defaults to zh.

ALTER TABLE user_settings
  ADD COLUMN language TEXT NOT NULL DEFAULT 'zh' CHECK (language IN ('zh', 'en'));
