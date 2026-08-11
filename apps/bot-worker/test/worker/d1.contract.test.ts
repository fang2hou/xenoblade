/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import {
  claimMessage,
  clearUserContext,
  GenerationBudgetExceededError,
  getUserContextState,
  markUserInteraction,
  reserveGeneration,
} from "@xenoblade/db";

// D1 migrations from wrangler.jsonc's migrations_dir are applied to the local
// miniflare D1 automatically by the pool (per test file).

describe("D1 data contract", () => {
  it("claims a message once and rejects the duplicate", async () => {
    const id = `msg-${crypto.randomUUID()}`;
    expect(await claimMessage(env.DB, id, Date.now())).toBe(true);
    expect(await claimMessage(env.DB, id, Date.now())).toBe(false);
  });

  it("exhausts the rolling token budget and then throws", async () => {
    const threadId = `thr-${crypto.randomUUID()}`;
    let reserved = 0;
    for (;;) {
      try {
        await reserveGeneration(env.DB, threadId, Date.now());
        reserved += 1;
      } catch (error) {
        expect(error).toBeInstanceOf(GenerationBudgetExceededError);
        break;
      }
    }
    // 20_000 budget at 512 tokens/reservation ⇒ ~39 fit before the cap trips.
    expect(reserved).toBeGreaterThanOrEqual(38);
  });
});

describe("user context state", () => {
  it("returns a default inactive state for a non-existent row", async () => {
    const state = await getUserContextState(env.DB, {
      scopeId: `scope-${crypto.randomUUID()}`,
      containerId: `container-${crypto.randomUUID()}`,
      userId: `user-${crypto.randomUUID()}`,
    });
    expect(state).toEqual({ resetAt: 0, lastInteractionAt: null, active: false });
  });

  it("clearUserContext then getUserContextState yields resetAt > 0 and inactive", async () => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const containerId = `container-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    const now = Date.now();

    expect(await clearUserContext(env.DB, { scopeId, containerId, userId, now })).toBe(true);

    const state = await getUserContextState(env.DB, { scopeId, containerId, userId });
    expect(state.resetAt).toBe(now);
    expect(state.lastInteractionAt).toBeNull();
    expect(state.active).toBe(false);
  });

  it("markUserInteraction sets lastInteractionAt and activates within TTL", async () => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const containerId = `container-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    const now = Date.now();

    await markUserInteraction(env.DB, { scopeId, containerId, userId, now });

    const state = await getUserContextState(env.DB, { scopeId, containerId, userId });
    expect(state.lastInteractionAt).toBe(now);
    expect(state.resetAt).toBe(0);
    expect(state.active).toBe(true);
  });

  it("markUserInteraction does NOT overwrite an existing resetAt", async () => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const containerId = `container-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    const resetAt = Date.now() - 1000;

    await clearUserContext(env.DB, { scopeId, containerId, userId, now: resetAt });
    await markUserInteraction(env.DB, { scopeId, containerId, userId, now: Date.now() });

    const state = await getUserContextState(env.DB, { scopeId, containerId, userId });
    expect(state.resetAt).toBe(resetAt);
    expect(state.active).toBe(true);
  });

  it("clearing user A's context does not affect user B in the same container", async () => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const containerId = `container-${crypto.randomUUID()}`;
    const userA = `user-${crypto.randomUUID()}`;
    const userB = `user-${crypto.randomUUID()}`;
    const now = Date.now();

    await clearUserContext(env.DB, { scopeId, containerId, userId: userA, now });

    const stateB = await getUserContextState(env.DB, { scopeId, containerId, userId: userB });
    expect(stateB.resetAt).toBe(0);
    expect(stateB.lastInteractionAt).toBeNull();
    expect(stateB.active).toBe(false);

    // User A is still reset; isolation holds.
    const stateA = await getUserContextState(env.DB, { scopeId, containerId, userId: userA });
    expect(stateA.resetAt).toBe(now);
  });

  it("clearing context in container X does not affect container Y", async () => {
    const scopeId = `scope-${crypto.randomUUID()}`;
    const userId = `user-${crypto.randomUUID()}`;
    const containerX = `container-${crypto.randomUUID()}`;
    const containerY = `container-${crypto.randomUUID()}`;
    const now = Date.now();

    await clearUserContext(env.DB, { scopeId, containerId: containerX, userId, now });

    const stateY = await getUserContextState(env.DB, { scopeId, containerId: containerY, userId });
    expect(stateY.resetAt).toBe(0);
    expect(stateY.lastInteractionAt).toBeNull();
    expect(stateY.active).toBe(false);
  });
});
