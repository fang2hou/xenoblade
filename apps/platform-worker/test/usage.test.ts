import { describe, it, expect } from "vitest";

import { getUsageSummary } from "../src/db";
import { createTestD1 } from "./helpers/d1";

const HOUR_MS = 3_600_000;
const NOW = 1_800_000_000_000;

interface InteractionSeed {
  id: string;
  userId?: string;
  scopeId?: string;
  status?: string;
  inputTokens?: number | null;
  outputTokens?: number | null;
  createdAt?: number;
}

function seedInteractions(db: D1Database, rows: InteractionSeed[]): void {
  for (const row of rows) {
    db.prepare(
      `INSERT INTO interactions
         (id, container_id, scope_id, user_id, summon_kind, model, status,
          input_tokens, output_tokens, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
      .bind(
        row.id,
        "discord:g1:c1",
        row.scopeId ?? "g1",
        row.userId ?? "u1",
        "user-mention",
        "test/model",
        row.status ?? "completed",
        row.inputTokens ?? null,
        row.outputTokens ?? null,
        row.createdAt ?? NOW,
      )
      .run();
  }
}

function seedToolInvocation(
  db: D1Database,
  row: { id: string; interactionId: string; tool: string },
): void {
  db.prepare(
    `INSERT INTO tool_invocations (id, interaction_id, tool_name, server, status, created_at)
     VALUES (?1, ?2, ?3, 'builtin', 'ok', ?4)`,
  )
    .bind(row.id, row.interactionId, row.tool, NOW)
    .run();
}

describe("getUsageSummary", () => {
  it("returns zeroed summaries for an empty database", async () => {
    const summary = await getUsageSummary(createTestD1(), {
      userId: "u1",
      scopeId: "g1",
      now: NOW,
    });

    expect(summary).toEqual({
      windowMs: 24 * HOUR_MS,
      user: {
        messages: 0,
        generations: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topTools: [],
      },
      guild: {
        messages: 0,
        generations: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        topTools: [],
      },
    });
  });

  it("counts messages vs completed generations and sums tokens as recorded", async () => {
    const db = createTestD1();
    seedInteractions(db, [
      { id: "a", status: "completed", inputTokens: 100, outputTokens: 50 },
      { id: "b", status: "completed", inputTokens: 10, outputTokens: 5 },
      { id: "c", status: "failed", inputTokens: 7, outputTokens: null },
      { id: "d", status: "budget_exceeded", inputTokens: null, outputTokens: null },
    ]);

    const { user } = await getUsageSummary(db, { userId: "u1", scopeId: "g1", now: NOW });

    expect(user.messages).toBe(4);
    expect(user.generations).toBe(2);
    expect(user.inputTokens).toBe(117);
    expect(user.outputTokens).toBe(55);
  });

  it("only aggregates rows inside the 24h window", async () => {
    const db = createTestD1();
    seedInteractions(db, [
      { id: "fresh", createdAt: NOW - 23 * HOUR_MS, inputTokens: 10 },
      { id: "stale", createdAt: NOW - 25 * HOUR_MS, inputTokens: 10_000 },
    ]);

    const { user } = await getUsageSummary(db, { userId: "u1", scopeId: "g1", now: NOW });

    expect(user.messages).toBe(1);
    expect(user.inputTokens).toBe(10);
  });

  it("scopes the user subject to the user and the guild subject to the scope", async () => {
    const db = createTestD1();
    seedInteractions(db, [
      { id: "mine", userId: "u1", scopeId: "g1", inputTokens: 10 },
      { id: "theirs", userId: "u2", scopeId: "g1", inputTokens: 20 },
      { id: "other-guild", userId: "u1", scopeId: "g2", inputTokens: 40 },
    ]);

    const summary = await getUsageSummary(db, { userId: "u1", scopeId: "g1", now: NOW });

    expect(summary.user.messages).toBe(2);
    expect(summary.user.inputTokens).toBe(50);
    expect(summary.guild.messages).toBe(2);
    expect(summary.guild.inputTokens).toBe(30);
  });

  it("ranks top tools by invocation count, name-ascending on ties, capped at 5", async () => {
    const db = createTestD1();
    seedInteractions(db, [
      { id: "i1" },
      { id: "i2" },
      { id: "old", createdAt: NOW - 25 * HOUR_MS },
    ]);
    const calls: Array<[string, string]> = [
      ["i1", "web_search"],
      ["i1", "web_search"],
      ["i1", "web_search"],
      ["i1", "web_answer"],
      ["i2", "web_answer"],
      ["i2", "alpha_tool"],
      ["i2", "beta_tool"],
      ["old", "stale_tool"],
    ];
    calls.forEach(([interactionId, tool], i) => {
      seedToolInvocation(db, { id: `t${i}`, interactionId, tool });
    });

    const { guild } = await getUsageSummary(db, { userId: "u1", scopeId: "g1", now: NOW });

    expect(guild.topTools).toEqual([
      { tool: "web_search", count: 3 },
      { tool: "web_answer", count: 2 },
      { tool: "alpha_tool", count: 1 },
      { tool: "beta_tool", count: 1 },
    ]);
  });

  it("excludes tool invocations joined to other users' interactions from the user subject", async () => {
    const db = createTestD1();
    seedInteractions(db, [
      { id: "mine", userId: "u1" },
      { id: "theirs", userId: "u2" },
    ]);
    seedToolInvocation(db, { id: "t1", interactionId: "mine", tool: "web_search" });
    seedToolInvocation(db, { id: "t2", interactionId: "theirs", tool: "read_url" });

    const { user, guild } = await getUsageSummary(db, { userId: "u1", scopeId: "g1", now: NOW });

    expect(user.topTools).toEqual([{ tool: "web_search", count: 1 }]);
    expect(guild.topTools).toEqual([
      { tool: "read_url", count: 1 },
      { tool: "web_search", count: 1 },
    ]);
  });
});
