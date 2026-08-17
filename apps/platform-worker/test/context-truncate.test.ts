import { describe, it, expect } from "vitest";

import worker from "../src/index";
import { createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

function makeEnv(): Env {
  return { DB: createTestD1(), INTERNAL_API_TOKEN: TOKEN } as Env;
}

async function call(env: Env, route: string, body: unknown): Promise<Response> {
  const request = new Request(`https://worker/internal/v1${route}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  return worker.fetch(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridging undici Request to the workers-types signature
    request as unknown as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

async function truncate(env: Env): Promise<Response> {
  return call(env, "/context/truncate", {
    userId: "u1",
    scopeId: "g1",
    containerId: "discord:g1:c1",
  });
}

/** Read the materialized watermark for the default key. */
async function stateOf(env: Env): Promise<{ resetAt: number; hardResetAt: number }> {
  const row = await env.DB.prepare(
    `SELECT reset_at AS resetAt, hard_reset_at AS hardResetAt
     FROM user_context_state
     WHERE scope_id = 'g1' AND container_id = 'discord:g1:c1' AND user_id = 'u1'`,
  ).first<{ resetAt: number; hardResetAt: number }>();
  return row ?? { resetAt: -1, hardResetAt: -1 };
}

/** Seed the state row directly, as a past interaction would have. */
async function seedState(env: Env, resetAt: number, hardResetAt = 0): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO user_context_state (scope_id, container_id, user_id, reset_at, last_interaction_at, hard_reset_at)
     VALUES ('g1', 'discord:g1:c1', 'u1', ?1, NULL, ?2)`,
  )
    .bind(resetAt, hardResetAt)
    .run();
}

describe("POST /internal/v1/context/truncate + /context/restore", () => {
  it("pushes an undoable watermark and pops it back on restore", async () => {
    const env = makeEnv();

    const truncated = (await (await truncate(env)).json()) as {
      status: string;
      truncatedAt: number;
      remainingUndos: number;
    };
    expect(truncated.status).toBe("ok");
    expect(truncated.truncatedAt).toBeGreaterThan(0);
    expect(truncated.remainingUndos).toBe(1);

    let state = await stateOf(env);
    expect(state.resetAt).toBe(truncated.truncatedAt);

    const restored = (await (
      await call(env, "/context/restore", {
        userId: "u1",
        scopeId: "g1",
        containerId: "discord:g1:c1",
      })
    ).json()) as { status: string; restored: boolean; remainingUndos: number };
    expect(restored).toEqual({ status: "ok", restored: true, remainingUndos: 0 });

    state = await stateOf(env);
    expect(state.resetAt).toBe(0);
  });

  it("walks a stack of truncations back one at a time", async () => {
    const env = makeEnv();
    // Seed two truncations with distinct cutoffs (two truncations within the
    // same millisecond would legitimately report no watermark movement).
    await env.DB.prepare(
      `INSERT INTO context_truncations (scope_id, container_id, user_id, truncated_at, created_at)
       VALUES ('g1', 'discord:g1:c1', 'u1', 1000, 1000)`,
    ).run();
    await env.DB.prepare(
      `INSERT INTO context_truncations (scope_id, container_id, user_id, truncated_at, created_at)
       VALUES ('g1', 'discord:g1:c1', 'u1', 2000, 2000)`,
    ).run();
    await seedState(env, 2000);

    const first = (await (
      await call(env, "/context/restore", {
        userId: "u1",
        scopeId: "g1",
        containerId: "discord:g1:c1",
      })
    ).json()) as { restored: boolean; remainingUndos: number };
    expect(first.restored).toBe(true);
    expect(first.remainingUndos).toBe(1);
    expect((await stateOf(env)).resetAt).toBe(1000);

    const second = (await (
      await call(env, "/context/restore", {
        userId: "u1",
        scopeId: "g1",
        containerId: "discord:g1:c1",
      })
    ).json()) as { restored: boolean; remainingUndos: number };
    expect(second.restored).toBe(true);
    expect(second.remainingUndos).toBe(0);
    expect((await stateOf(env)).resetAt).toBe(0);

    const third = (await (
      await call(env, "/context/restore", {
        userId: "u1",
        scopeId: "g1",
        containerId: "discord:g1:c1",
      })
    ).json()) as { restored: boolean; remainingUndos: number };
    expect(third).toEqual({ status: "ok", restored: false, remainingUndos: 0 });
  });

  it("restore never crosses the hard floor a clear left behind", async () => {
    const env = makeEnv();
    await seedState(env, 0);

    // 1. Undoable truncation, then a hard clear (as /chat off performs).
    await truncate(env);
    await call(env, "/context/clear", {
      userId: "u1",
      scopeId: "g1",
      containerId: "discord:g1:c1",
      scope: "user",
    });

    const clearedAt = (await stateOf(env)).resetAt;
    expect((await stateOf(env)).hardResetAt).toBe(clearedAt);

    // 2. Restore pops the truncation but the floor holds the watermark.
    const restored = (await (
      await call(env, "/context/restore", {
        userId: "u1",
        scopeId: "g1",
        containerId: "discord:g1:c1",
      })
    ).json()) as { restored: boolean };
    expect(restored.restored).toBe(false);
    expect((await stateOf(env)).resetAt).toBe(clearedAt);
  });

  it("a weak beforeMs clear after a truncation still stamps the floor", async () => {
    const env = makeEnv();
    await seedState(env, 0);

    await truncate(env);
    const truncatedAt = (await stateOf(env)).resetAt;

    // A weaker clear (older threshold) is skipped by the watermark guard but
    // must still stamp hard_reset_at (ADR-014: every clear is irreversible).
    await call(env, "/context/clear", {
      userId: "u1",
      scopeId: "g1",
      containerId: "discord:g1:c1",
      scope: "user",
      beforeMs: 60 * 60 * 1000,
    });

    expect((await stateOf(env)).resetAt).toBe(truncatedAt);
    expect((await stateOf(env)).hardResetAt).toBeGreaterThan(0);

    const restored = (await (
      await call(env, "/context/restore", {
        userId: "u1",
        scopeId: "g1",
        containerId: "discord:g1:c1",
      })
    ).json()) as { restored: boolean };
    // Undoing the truncation revives history down to the weak clear's
    // threshold — the floor — and never below it (ADR-014).
    expect(restored.restored).toBe(true);
    const state = await stateOf(env);
    expect(state.resetAt).toBe(state.hardResetAt);
    expect(state.hardResetAt).toBeGreaterThan(0);
    expect(state.hardResetAt).toBeLessThan(truncatedAt);
  });

  it("rejects unauthenticated and malformed requests", async () => {
    const env = makeEnv();
    const unauth = new Request("https://worker/internal/v1/context/truncate", {
      method: "POST",
      body: "{}",
    });
    expect((await worker.fetch(unauth as never, env, {} as ExecutionContext)).status).toBe(401);

    const bad = await call(env, "/context/truncate", null);
    expect(bad.status).toBe(400);
  });
});
