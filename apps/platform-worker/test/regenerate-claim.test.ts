import { describe, it, expect } from "vitest";

import { claimMessage, claimRegenerate } from "../src/db";
import { createTestD1 } from "./helpers/d1";

describe("claimRegenerate", () => {
  it("allows exactly one regenerate per original message", async () => {
    const db = createTestD1();
    expect(await claimRegenerate(db, "m1", 1000)).toBe(true);
    expect(await claimRegenerate(db, "m1", 1001)).toBe(false);
    expect(await claimRegenerate(db, "m1", 1002)).toBe(false);
  });

  it("claims independently per original message", async () => {
    const db = createTestD1();
    expect(await claimRegenerate(db, "m1", 1000)).toBe(true);
    expect(await claimRegenerate(db, "m2", 1000)).toBe(true);
    expect(await claimRegenerate(db, "m1", 1000)).toBe(false);
  });

  it("does not collide with the original message's claim slot", async () => {
    const db = createTestD1();
    // The original run claims the message id...
    expect(await claimMessage(db, "m1", 1000)).toBe(true);
    expect(await claimMessage(db, "m1", 1000)).toBe(false);
    // ...and the regenerate slot is still free for exactly one re-run.
    expect(await claimRegenerate(db, "m1", 1001)).toBe(true);
    expect(await claimRegenerate(db, "m1", 1002)).toBe(false);
    // A later first-run for another message is unaffected by regen claims.
    expect(await claimMessage(db, "m2", 1003)).toBe(true);
  });
});
