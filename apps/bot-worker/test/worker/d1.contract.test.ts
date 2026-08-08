/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { claimMessage, GenerationBudgetExceededError, reserveGeneration } from "@xenoblade/db";

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
