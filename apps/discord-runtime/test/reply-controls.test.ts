import { describe, it, expect } from "vitest";
import type { GenerationRequest } from "@xenoblade/contracts";

import {
  DELETE_EMOJI,
  isAffordanceEmoji,
  REGENERATE_EMOJI,
  ReplyRegistry,
  resolveAffordanceAction,
  type ReplyEntry,
} from "../src/reply-controls";

function request(userId = "u1"): GenerationRequest {
  return {
    messageId: "m1",
    containerId: "discord:g1:c1",
    scopeId: "g1",
    channelId: "c1",
    userId,
    userDisplayName: "User",
    summonKind: "user-mention",
    content: "hello",
    history: [],
    reference: null,
    attachments: [],
  };
}

function entry(overrides: Partial<ReplyEntry> = {}): ReplyEntry {
  return { request: request(), chunkIds: ["r1", "r2"], regenerable: true, ...overrides };
}

describe("isAffordanceEmoji", () => {
  it("matches affordance emoji with or without the variation selector", () => {
    expect(isAffordanceEmoji(REGENERATE_EMOJI, REGENERATE_EMOJI)).toBe(true);
    expect(isAffordanceEmoji(DELETE_EMOJI, DELETE_EMOJI)).toBe(true);
    expect(isAffordanceEmoji("🗑", DELETE_EMOJI)).toBe(true);
    expect(isAffordanceEmoji("🗑️", DELETE_EMOJI)).toBe(true);
  });

  it("rejects missing names and other emoji", () => {
    expect(isAffordanceEmoji(null, DELETE_EMOJI)).toBe(false);
    expect(isAffordanceEmoji(undefined, DELETE_EMOJI)).toBe(false);
    expect(isAffordanceEmoji("👍", DELETE_EMOJI)).toBe(false);
  });
});

describe("resolveAffordanceAction", () => {
  it("maps the trigger author's affordance clicks to actions", () => {
    expect(resolveAffordanceAction(entry(), REGENERATE_EMOJI, "u1", false)).toBe("regenerate");
    expect(resolveAffordanceAction(entry(), DELETE_EMOJI, "u1", false)).toBe("delete");
  });

  it("ignores bot reactions — including the bot's own affordance adds", () => {
    expect(resolveAffordanceAction(entry(), REGENERATE_EMOJI, "u1", true)).toBeNull();
    expect(resolveAffordanceAction(entry(), DELETE_EMOJI, "bot", true)).toBeNull();
  });

  it("ignores untracked messages and non-affordance emoji", () => {
    expect(resolveAffordanceAction(undefined, REGENERATE_EMOJI, "u1", false)).toBeNull();
    expect(resolveAffordanceAction(entry(), "👍", "u1", false)).toBeNull();
    expect(resolveAffordanceAction(entry(), null, "u1", false)).toBeNull();
  });

  it("ignores users other than the trigger author", () => {
    expect(resolveAffordanceAction(entry(), REGENERATE_EMOJI, "u2", false)).toBeNull();
    expect(resolveAffordanceAction(entry(), DELETE_EMOJI, "u2", false)).toBeNull();
  });

  it("downgrades delete-only replies: 🔁 ignored, 🗑 still deletable", () => {
    const spent = entry({ regenerable: false });
    expect(resolveAffordanceAction(spent, REGENERATE_EMOJI, "u1", false)).toBeNull();
    expect(resolveAffordanceAction(spent, DELETE_EMOJI, "u1", false)).toBe("delete");
  });
});

describe("ReplyRegistry", () => {
  it("registers, looks up, and removes entries by head message id", () => {
    const registry = new ReplyRegistry();
    registry.register("r1", entry());
    expect(registry.get("r1")?.chunkIds).toEqual(["r1", "r2"]);
    registry.remove("r1");
    expect(registry.get("r1")).toBeUndefined();
  });

  it("evicts the oldest entry beyond the cap", () => {
    const registry = new ReplyRegistry();
    for (let i = 0; i < 129; i++) {
      registry.register(`head-${i}`, entry({ chunkIds: [`head-${i}`] }));
    }
    expect(registry.get("head-0")).toBeUndefined();
    expect(registry.get("head-1")?.chunkIds).toEqual(["head-1"]);
    expect(registry.get("head-128")?.chunkIds).toEqual(["head-128"]);
  });
});
