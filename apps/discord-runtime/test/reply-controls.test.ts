import { describe, it, expect } from "vitest";
import { ButtonStyle } from "discord.js";
import type { GenerationRequest } from "@xenoblade/contracts";

import {
  buildReplyControlsRow,
  DELETE_EMOJI,
  parseControlCustomId,
  REGENERATE_EMOJI,
  ReplyRegistry,
  controlCustomId,
  resolveControlAction,
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
  return {
    request: request(),
    chunkIds: ["r1", "r2"],
    headContent: "answer head",
    language: "zh",
    busy: false,
    ...overrides,
  };
}

describe("controlCustomId", () => {
  it("encodes the scheme xbl:<action>:<messageId>", () => {
    expect(controlCustomId("regenerate", "123")).toBe("xbl:regen:123");
    expect(controlCustomId("delete", "123")).toBe("xbl:del:123");
  });

  it("round-trips through parseControlCustomId", () => {
    expect(parseControlCustomId(controlCustomId("regenerate", "123"))).toBe("regenerate");
    expect(parseControlCustomId(controlCustomId("delete", "123"))).toBe("delete");
  });

  it("rejects foreign prefixes, verbs, shapes, and empty ids", () => {
    expect(parseControlCustomId("other:regen:123")).toBeNull();
    expect(parseControlCustomId("xbl:edit:123")).toBeNull();
    expect(parseControlCustomId("xbl:regen")).toBeNull();
    expect(parseControlCustomId("xbl:regen:")).toBeNull();
    expect(parseControlCustomId("xbl:regen:123:extra")).toBeNull();
    expect(parseControlCustomId("")).toBeNull();
  });
});
describe("buildReplyControlsRow", () => {
  type ButtonData = {
    custom_id: string;
    label?: string;
    emoji?: { name?: string };
    style: number;
    disabled?: boolean;
  };

  function rowButtons(texts: { regenerate: string }, disabled = false): ButtonData[] {
    const row = buildReplyControlsRow(texts, "r1", { disabled });
    // Test-side view of the serialized buttons; SKU-link variants don't occur here.
    return row.toJSON().components.map((button) => button as unknown as ButtonData);
  }

  it("renders Regenerate (label + emoji, Secondary) and Delete (emoji, Danger)", () => {
    const [regen, del] = rowButtons({ regenerate: "重新生成" });
    expect(regen?.custom_id).toBe("xbl:regen:r1");
    expect(regen?.label).toBe("重新生成");
    expect(regen?.emoji?.name).toBe(REGENERATE_EMOJI);
    expect(regen?.style).toBe(ButtonStyle.Secondary);
    expect(del?.custom_id).toBe("xbl:del:r1");
    expect(del?.label).toBeUndefined();
    expect(del?.emoji?.name).toBe(DELETE_EMOJI);
    expect(del?.style).toBe(ButtonStyle.Danger);
  });

  it("can render both buttons disabled", () => {
    for (const button of rowButtons({ regenerate: "Regenerate" }, true)) {
      expect(button.disabled).toBe(true);
    }
  });
});

describe("resolveControlAction", () => {
  it("maps the trigger author's button clicks to actions", () => {
    expect(resolveControlAction(entry(), "xbl:regen:r1", "r1", "u1")).toEqual({
      action: "regenerate",
    });
    expect(resolveControlAction(entry(), "xbl:del:r1", "r1", "u1")).toEqual({ action: "delete" });
  });

  it("rejects buttons whose customId does not match the message they fired on", () => {
    expect(resolveControlAction(entry(), "xbl:regen:r1", "other-message", "u1")).toBeNull();
  });

  it("rejects foreign customIds with null (caller shows the expired notice)", () => {
    expect(resolveControlAction(entry(), "other:regen:r1", "r1", "u1")).toBeNull();
    expect(resolveControlAction(undefined, "xbl:del:r1", "r1", "u2")).toEqual({
      action: "rejected",
      reason: "expired",
    });
  });

  it("expires buttons the process cannot resolve (restart, eviction)", () => {
    expect(resolveControlAction(undefined, "xbl:regen:r1", "r1", "u1")).toEqual({
      action: "rejected",
      reason: "expired",
    });
  });

  it("refuses users other than the trigger author", () => {
    expect(resolveControlAction(entry(), "xbl:regen:r1", "r1", "u2")).toEqual({
      action: "rejected",
      reason: "not-owner",
    });
  });

  it("refuses clicks while a regenerate is in flight", () => {
    const busy = entry({ busy: true });
    expect(resolveControlAction(busy, "xbl:regen:r1", "r1", "u1")).toEqual({
      action: "rejected",
      reason: "busy",
    });
    expect(resolveControlAction(busy, "xbl:del:r1", "r1", "u1")).toEqual({
      action: "rejected",
      reason: "busy",
    });
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
