import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SendableChannels } from "discord.js";

import { StagedStatus, type StatusMilestone } from "../src/staged-status";

/** Rate-limit-shaped error as discord.js would surface it. */
const RATE_LIMIT_ERROR = { name: "DiscordAPIError", status: 429, message: "rate limited" };

interface FakeMessage {
  id: string;
  edit(text: string): Promise<FakeMessage>;
  delete(): Promise<FakeMessage>;
}

interface Harness {
  channel: SendableChannels;
  sends: string[];
  /** Every message object `send` created, in send order. */
  sentMessages: FakeMessage[];
  edits: string[];
  deleted: number;
}

/**
 * Fake sendable channel: `send` records text and returns a placeholder whose
 * `edit` records text (after optionally throwing queued failures) and whose
 * `delete` counts deletions.
 */
function harness(failEdits: unknown[] = []): Harness {
  const sends: string[] = [];
  const sentMessages: FakeMessage[] = [];
  const edits: string[] = [];
  const state = { deleted: 0, nextFailure: 0, seq: 0 };
  const makeMessage = (): FakeMessage => {
    const message: FakeMessage = {
      id: `m${state.seq++}`,
      edit: async (text: string) => {
        const failure = failEdits[state.nextFailure++];
        if (failure !== undefined) throw failure;
        edits.push(text);
        return message;
      },
      delete: async () => {
        state.deleted += 1;
        return message;
      },
    };
    return message;
  };
  const channel = {
    id: "channel-test",
    send: async (text: string) => {
      sends.push(text);
      const message = makeMessage();
      sentMessages.push(message);
      return message;
    },
  };
  return {
    channel: channel as unknown as SendableChannels,
    sends,
    sentMessages,
    edits,
    get deleted() {
      return state.deleted;
    },
  };
}

/** Milestone ladder short enough to keep assertions terse. */
const LADDER: StatusMilestone[] = [
  { afterMs: 1_000, text: "s1" },
  { afterMs: 2_000, text: "s2" },
  { afterMs: 3_000, text: "s3" },
  { afterMs: 4_000, text: "s4" },
];

function staged(h: Harness, milestones: StatusMilestone[] = LADDER): StagedStatus {
  const instance = new StagedStatus(h.channel, { milestones });
  instance.start();
  return instance;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("StagedStatus milestones", () => {
  it("posts nothing before the first milestone", async () => {
    const h = harness();
    staged(h);
    await vi.advanceTimersByTimeAsync(999);
    expect(h.sends).toHaveLength(0);
    expect(h.edits).toHaveLength(0);
  });

  it("posts the default placeholder after ~8s of elapsed time", async () => {
    const h = harness();
    const instance = new StagedStatus(h.channel);
    instance.start();
    await vi.advanceTimersByTimeAsync(7_999);
    expect(h.sends).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.sends).toHaveLength(1);
    expect(h.sends[0]?.length).toBeGreaterThan(0);
  });
  it("retries placeholder creation at the next milestone after a failed send", async () => {
    const h = harness();
    let sendShouldFail = true;
    const channel = {
      id: "channel-test",
      send: async (text: string) => {
        if (sendShouldFail) {
          sendShouldFail = false;
          throw new Error("network down");
        }
        h.sends.push(text);
        return { edit: async () => {}, delete: async () => {} };
      },
    } as unknown as SendableChannels;
    const instance = new StagedStatus(channel, { milestones: LADDER });
    instance.start();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.sends).toEqual(["s2"]);
  });

  it("backs off and retries once when an edit is rate-limited (429)", async () => {
    const h = harness([RATE_LIMIT_ERROR]);
    const instance = new StagedStatus(h.channel, {
      milestones: [
        { afterMs: 1_000, text: "s1" },
        { afterMs: 2_000, text: "s2" },
        { afterMs: 10_000, text: "s3" },
      ],
    });
    instance.start();
    await vi.advanceTimersByTimeAsync(2_000);
    // First attempt rejected with 429; backoff not yet elapsed.
    expect(h.edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.edits).toEqual(["s2"]);
  });

  it("gives up on an edit that fails for a non-rate-limit reason", async () => {
    const h = harness([new Error("Unknown Message")]);
    staged(h);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(h.edits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(2_000);
    // Later milestones still run; the placeholder stays at the posted stage.
    expect(h.sends).toEqual(["s1"]);
  });
});

describe("StagedStatus edit cap", () => {
  it("stops escalations at 3 edits, reserving the 4th for settle", async () => {
    const h = harness();
    const six: StatusMilestone[] = [1, 2, 3, 4, 5, 6].map((second) => ({
      afterMs: second * 1_000,
      text: `s${second}`,
    }));
    const instance = staged(h, six);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sends).toEqual(["s1"]);
    expect(h.edits).toEqual(["s2", "s3", "s4"]);
    await instance.settle("final");
    expect(h.edits).toEqual(["s2", "s3", "s4", "final"]);
  });

  it("never exceeds 4 total edits even after every milestone and settle", async () => {
    const h = harness();
    const many: StatusMilestone[] = Array.from({ length: 10 }, (_, i) => ({
      afterMs: (i + 1) * 1_000,
      text: `s${i + 1}`,
    }));
    const instance = staged(h, many);
    await vi.advanceTimersByTimeAsync(30_000);
    await instance.settle("final");
    expect(h.edits.length).toBeLessThanOrEqual(4);
    expect(h.edits[h.edits.length - 1]).toBe("final");
  });
});

describe("StagedStatus settle", () => {
  it("replaces the placeholder with the final content", async () => {
    const h = harness();
    const instance = staged(h);
    await vi.advanceTimersByTimeAsync(1_500);
    const posted = await instance.settle("the answer");
    expect(h.edits).toEqual(["the answer"]);
    expect(h.sends).toEqual(["s1"]);
    // The settled placeholder itself is the head (and only) message.
    expect(posted).toEqual([h.sentMessages[0]]);
  });

  it("posts continuation chunks as new messages beyond 2000 chars", async () => {
    const h = harness();
    const instance = staged(h);
    await vi.advanceTimersByTimeAsync(1_500);
    const content = ["a".repeat(1_500), "b".repeat(1_500), "c".repeat(1_000)].join("\n");
    const posted = await instance.settle(content);
    expect(h.sends[0]).toBe("s1");
    // Head is the settled placeholder; continuations follow in order.
    expect(posted[0]).toBe(h.sentMessages[0]);
    expect(posted.slice(1)).toEqual(h.sentMessages.slice(1));
    const continuation = h.sends.slice(1);
    expect(continuation).toHaveLength(2);
    for (const chunk of [h.edits[0], ...continuation]) {
      expect(chunk?.length).toBeLessThanOrEqual(2_000);
    }
    expect([h.edits[0], ...continuation].join("\n")).toBe(content);
  });

  it("behaves like a plain post when no placeholder exists (fast generation)", async () => {
    const h = harness();
    const instance = staged(h);
    await vi.advanceTimersByTimeAsync(500);
    const posted = await instance.settle("quick reply");
    expect(h.sends).toEqual(["quick reply"]);
    expect(h.edits).toHaveLength(0);
    // Fast path returns exactly the freshly posted messages.
    expect(posted).toEqual(h.sentMessages);
  });

  it("replaces the placeholder with the failure reply on generation failure", async () => {
    const h = harness();
    const instance = staged(h);
    await vi.advanceTimersByTimeAsync(2_500);
    await instance.settle("失败文案");
    expect(h.edits).toEqual(["s2", "失败文案"]);
    expect(h.sends).toEqual(["s1"]);
  });

  it("falls back to new messages and deletes the placeholder when the edit fails", async () => {
    const h = harness([new Error("Unknown Message")]);
    const instance = staged(h);
    await vi.advanceTimersByTimeAsync(1_500);
    const content = ["x".repeat(1_200), "y".repeat(1_200)].join("\n");
    const posted = await instance.settle(content);
    // Placeholder was posted, edit failed, full reply posted once, no duplicates.
    expect(h.edits).toHaveLength(0);
    expect(h.sends).toEqual(["s1", content.slice(0, 1_200), content.slice(-1_200)]);
    expect(h.deleted).toBe(1);
    // Fallback returns the reposted messages — not the deleted placeholder.
    expect(posted).toEqual(h.sentMessages.slice(1));
  });

  it("rejects empty content like postReply does", async () => {
    const h = harness();
    const instance = staged(h);
    await expect(instance.settle("   ")).rejects.toThrow(/empty after trim/);
  });
});

describe("StagedStatus dismiss", () => {
  it("deletes the placeholder and stops future milestones", async () => {
    const h = harness();
    const instance = staged(h);
    await vi.advanceTimersByTimeAsync(1_500);
    await instance.dismiss();
    expect(h.deleted).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.sends).toEqual(["s1"]);
    expect(h.edits).toHaveLength(0);
  });

  it("is a no-op without a placeholder", async () => {
    const h = harness();
    const instance = staged(h);
    await vi.advanceTimersByTimeAsync(500);
    await instance.dismiss();
    expect(h.deleted).toBe(0);
  });
});
