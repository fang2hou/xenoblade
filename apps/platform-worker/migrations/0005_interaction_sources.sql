-- Migration 0005: durable per-interaction source index (ADR-007 amendment)
--
-- The rendered Sources footer is gone from replies (Discord preview cards
-- destroyed readability); citations are inline masked links now. To still
-- answer "where is the source / 原文在哪" later, every generation's extracted
-- sources are persisted per interaction and re-injected into subsequent
-- generations of the same container as a reference block.

CREATE TABLE interaction_sources (
  interaction_id TEXT NOT NULL,
  container_id   TEXT NOT NULL,
  idx            INTEGER NOT NULL,
  title          TEXT NOT NULL,
  url            TEXT NOT NULL,
  created_at     INTEGER NOT NULL,
  PRIMARY KEY (interaction_id, idx)
);

CREATE INDEX idx_sources_container_time
  ON interaction_sources(container_id, created_at);
