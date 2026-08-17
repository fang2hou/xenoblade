import { describe, it, expect } from "vitest";

import { extractMemoryProposals } from "../src/memory-proposals";
import worker from "../src/index";
import { createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

describe("extractMemoryProposals", () => {
  const save = {
    id: "p1",
    action: "save",
    category: "fact",
    key: "favorite language",
    value: "Rust",
  };

  it("collects remember/forget outputs in order and skips everything else", () => {
    const proposals = extractMemoryProposals([
      { toolName: "web_search", output: { results: [] } },
      { toolName: "remember", output: { status: "proposed", proposal: save } },
      {
        toolName: "forget",
        output: { status: "proposed", proposal: { id: "p2", action: "forget", key: "pet" } },
      },
      { toolName: "remember", output: { status: "proposed" } },
      { toolName: "read_url", output: { text: "..." } },
    ]);
    expect(proposals).toEqual([save, { id: "p2", action: "forget", key: "pet" }]);
  });

  it("tolerates missing outputs", () => {
    expect(extractMemoryProposals([{ toolName: "remember" }])).toEqual([]);
    expect(extractMemoryProposals([])).toEqual([]);
  });
});

function makeEnv(): Env {
  return { DB: createTestD1(), INTERNAL_API_TOKEN: TOKEN } as Env;
}

async function applyProposals(env: Env, proposals: unknown): Promise<Response> {
  const request = new Request("https://worker/internal/v1/memory/proposals", {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ userId: "u1", proposals }),
  });
  return worker.fetch(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridging undici Request to the workers-types signature
    request as unknown as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

async function memoriesOf(
  env: Env,
): Promise<Array<{ category: string; key: string; value: string }>> {
  const { results } = await env.DB.prepare(
    "SELECT category, key, value FROM user_memory WHERE user_id = 'u1'",
  ).all<{ category: string; key: string; value: string }>();
  return results ?? [];
}

describe("POST /internal/v1/memory/proposals", () => {
  it("saves and updates via upsert, and forgets by key", async () => {
    const env = makeEnv();

    const saved = (await (
      await applyProposals(env, [
        { id: "p1", action: "save", category: "fact", key: "lang", value: "Rust" },
      ])
    ).json()) as { status: string; results: Array<{ id: string; ok: boolean }> };
    expect(saved).toEqual({ status: "ok", results: [{ id: "p1", ok: true }] });
    expect(await memoriesOf(env)).toEqual([{ category: "fact", key: "lang", value: "Rust" }]);

    // Same key upserts instead of growing past the row.
    await applyProposals(env, [
      { id: "p2", action: "save", category: "fact", key: "lang", value: "TypeScript" },
    ]);
    expect(await memoriesOf(env)).toEqual([{ category: "fact", key: "lang", value: "TypeScript" }]);

    const forgotten = (await (
      await applyProposals(env, [{ id: "p3", action: "forget", key: "lang" }])
    ).json()) as { results: Array<{ ok: boolean; code?: string }> };
    expect(forgotten.results[0]?.ok).toBe(true);
    expect(forgotten.results[0]?.code).toBeUndefined();
    expect(await memoriesOf(env)).toEqual([]);
  });

  it("flags a forget that matched nothing and rejects invalid proposals", async () => {
    const env = makeEnv();
    const body = (await (
      await applyProposals(env, [
        { id: "p1", action: "forget", key: "ghost" },
        { id: "p2", action: "save", category: "persona", key: "identity", value: "x" },
        { id: "p3", action: "save", category: "fact", key: "", value: "x" },
        { id: "p4", action: "save", category: "fact", key: "k", value: "" },
        // An unknown action must never fall through to the delete branch.
        { id: "p5", action: "explode", category: "fact", key: "lang", value: "x" },
      ])
    ).json()) as { results: Array<{ id: string; ok: boolean; code?: string }> };

    expect(body.results).toEqual([
      { id: "p1", ok: true, code: "not_found" },
      { id: "p2", ok: false, code: "invalid_proposal" },
      { id: "p3", ok: false, code: "invalid_proposal" },
      { id: "p4", ok: false, code: "invalid_proposal" },
      { id: "p5", ok: false, code: "invalid_proposal" },
    ]);
  });

  it("refuses new rows past the confirmed cap with memory_full", async () => {
    const env = makeEnv();
    const insert = env.DB.prepare(
      `INSERT INTO user_memory (user_id, category, key, value, created_at, updated_at)
       VALUES ('u1', 'fact', ?1, 'v', 0, 0)`,
    );
    for (let i = 0; i < 50; i++) {
      await insert.bind(`k${i}`).run();
    }

    const body = (await (
      await applyProposals(env, [
        { id: "p1", action: "save", category: "fact", key: "new", value: "v" },
        { id: "p2", action: "save", category: "fact", key: "k0", value: "updated" },
      ])
    ).json()) as { results: Array<{ id: string; ok: boolean; code?: string }> };

    // A new row is refused; an update of an existing key still goes through.
    expect(body.results).toEqual([
      { id: "p1", ok: false, code: "memory_full" },
      { id: "p2", ok: true },
    ]);
    const row = await env.DB.prepare(
      "SELECT value FROM user_memory WHERE user_id = 'u1' AND key = 'k0'",
    ).first<{ value: string }>();
    expect(row?.value).toBe("updated");
  });

  it("treats a duplicate save of one new key within a batch as an update at the cap", async () => {
    const env = makeEnv();
    const insert = env.DB.prepare(
      `INSERT INTO user_memory (user_id, category, key, value, created_at, updated_at)
       VALUES ('u1', 'fact', ?1, 'v', 0, 0)`,
    );
    for (let i = 0; i < 49; i++) {
      await insert.bind(`k${i}`).run();
    }

    const body = (await (
      await applyProposals(env, [
        { id: "p1", action: "save", category: "fact", key: "new", value: "first" },
        { id: "p2", action: "save", category: "fact", key: "new", value: "second" },
      ])
    ).json()) as { results: Array<{ id: string; ok: boolean; code?: string }> };

    // The first save fills the 50th slot; the second targets the row the
    // first created, so it is an update — not a spurious memory_full.
    expect(body.results).toEqual([
      { id: "p1", ok: true },
      { id: "p2", ok: true },
    ]);
    const rows = await env.DB.prepare(
      "SELECT value FROM user_memory WHERE user_id = 'u1' AND key = 'new'",
    ).all<{ value: string }>();
    expect(rows.results).toEqual([{ value: "second" }]);
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM user_memory WHERE user_id = 'u1'",
    ).first<{ n: number }>();
    expect(count?.n).toBe(50);
  });
});
