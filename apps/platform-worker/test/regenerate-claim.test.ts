import { describe, it, expect } from "vitest";

import { REGEN_LEASE_TTL_MS, claimMessage, claimRegenerate, releaseRegenerate } from "../src/db";
import { createTestD1 } from "./helpers/d1";

describe("claimRegenerate", () => {
  it("rejects racing duplicates while the lease is held", async () => {
    const db = createTestD1();
    expect(await claimRegenerate(db, "m1", 1000)).toBe(true);
    expect(await claimRegenerate(db, "m1", 1001)).toBe(false);
    expect(await claimRegenerate(db, "m1", 1002)).toBe(false);
  });

  it("allows a new claim once the run releases the lease", async () => {
    const db = createTestD1();
    expect(await claimRegenerate(db, "m1", 1000)).toBe(true);
    await releaseRegenerate(db, "m1");
    expect(await claimRegenerate(db, "m1", 2000)).toBe(true);
  });

  it("keeps other messages' leases independent of a release", async () => {
    const db = createTestD1();
    expect(await claimRegenerate(db, "m1", 1000)).toBe(true);
    expect(await claimRegenerate(db, "m2", 1000)).toBe(true);
    await releaseRegenerate(db, "m1");
    // m1 is free again, m2 is still held.
    expect(await claimRegenerate(db, "m1", 2000)).toBe(true);
    expect(await claimRegenerate(db, "m2", 2000)).toBe(false);
  });

  it("takes over a lease only after the TTL expires (crashed-holder backstop)", async () => {
    const db = createTestD1();
    const now = 1000;
    expect(await claimRegenerate(db, "m1", now)).toBe(true);
    expect(await claimRegenerate(db, "m1", now + REGEN_LEASE_TTL_MS - 1)).toBe(false);
    expect(await claimRegenerate(db, "m1", now + REGEN_LEASE_TTL_MS)).toBe(true);
    expect(await claimRegenerate(db, "m1", now + REGEN_LEASE_TTL_MS + 1)).toBe(false);
  });

  it("does not collide with the original message's dedup claim", async () => {
    const db = createTestD1();
    // The original run claims the message id...
    expect(await claimMessage(db, "m1", 1000)).toBe(true);
    expect(await claimMessage(db, "m1", 1000)).toBe(false);
    // ...and the regenerate lease is a separate slot.
    expect(await claimRegenerate(db, "m1", 1001)).toBe(true);
    expect(await claimRegenerate(db, "m1", 1002)).toBe(false);
    // A later first-run for another message is unaffected by regen leases.
    expect(await claimMessage(db, "m2", 1003)).toBe(true);
  });
});
