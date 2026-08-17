import { describe, it, expect } from "vitest";

import { getRecentSources, recordInteractionSources } from "../src/db";
import { createTestD1 } from "./helpers/d1";

const CONTAINER = "discord:g1:c1";

describe("interaction source index (ADR-007 amendment)", () => {
  it("persists sources and reads them back oldest-first, deduplicated", async () => {
    const db = createTestD1();
    const now = Date.now();

    await recordInteractionSources(db, {
      interactionId: "i1",
      containerId: CONTAINER,
      sources: [
        { title: "A", url: "https://a" },
        { title: "B", url: "https://b" },
      ],
      now: now - 5000,
    });
    // Same URL again from a later interaction — deduplicated on read.
    await recordInteractionSources(db, {
      interactionId: "i2",
      containerId: CONTAINER,
      sources: [
        { title: "A2", url: "https://a" },
        { title: "C", url: "https://c" },
      ],
      now,
    });

    const recent = await getRecentSources(db, { containerId: CONTAINER, now });
    // Oldest-first, matching the order the conversation cited them in.
    expect(recent).toEqual([
      { title: "B", url: "https://b" },
      { title: "C", url: "https://c" },
      { title: "A2", url: "https://a" },
    ]);
  });

  it("ignores sources outside the 24h window and other containers", async () => {
    const db = createTestD1();
    const now = Date.now();

    await recordInteractionSources(db, {
      interactionId: "old",
      containerId: CONTAINER,
      sources: [{ title: "old", url: "https://old" }],
      now: now - 25 * 60 * 60 * 1000,
    });
    await recordInteractionSources(db, {
      interactionId: "other",
      containerId: "discord:g1:c2",
      sources: [{ title: "other", url: "https://other" }],
      now,
    });

    expect(await getRecentSources(db, { containerId: CONTAINER, now })).toEqual([]);
  });

  it("caps the injected list at the most recent 15 distinct URLs", async () => {
    const db = createTestD1();
    const now = Date.now();
    for (let i = 0; i < 20; i++) {
      await recordInteractionSources(db, {
        interactionId: `i${i}`,
        containerId: CONTAINER,
        sources: [{ title: `t${i}`, url: `https://x/${i}` }],
        now: now - (20 - i) * 1000,
      });
    }

    const recent = await getRecentSources(db, { containerId: CONTAINER, now });
    expect(recent).toHaveLength(15);
    // Most recent first would be x/19..x/5; oldest-first rendering flips it.
    expect(recent[0]).toEqual({ title: "t5", url: "https://x/5" });
    expect(recent[14]).toEqual({ title: "t19", url: "https://x/19" });
  });

  it("records nothing for an empty source list", async () => {
    const db = createTestD1();
    await recordInteractionSources(db, {
      interactionId: "i",
      containerId: CONTAINER,
      sources: [],
      now: Date.now(),
    });
    const { results } = await db
      .prepare("SELECT COUNT(*) AS n FROM interaction_sources")
      .all<{ n: number }>();
    expect(results[0]?.n).toBe(0);
  });
});
