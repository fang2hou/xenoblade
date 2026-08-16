import { describe, expect, it } from "vitest";
import type { GenerationRequest, HistoryMessage } from "@xenoblade/contracts";

import { buildContext, isThreadContainer } from "../src/context";

/**
 * ADR-011 isolation invariants. DM context lives under
 * `scopeId = "dm"`, `containerId = discord:@me:<dmChannelId>`; guild requests
 * use a guild scope and container. History reaches `buildContext` only from
 * the triggering channel itself, so these tests pin the remaining invariants:
 * DM containers are non-thread containers (channel mode, user+bot filtering)
 * and honor the reset cutoff.
 */

function message(partial: Partial<HistoryMessage> & Pick<HistoryMessage, "id">): HistoryMessage {
  return {
    text: `text of ${partial.id}`,
    authorId: "author",
    authorName: "Author",
    isBot: false,
    createdAt: 1000,
    ...partial,
  };
}

function request(containerId: string, history: HistoryMessage[]): GenerationRequest {
  return {
    messageId: "current",
    containerId,
    scopeId: containerId.startsWith("discord:@me:") ? "dm" : "123",
    channelId: containerId.split(":").at(-1) ?? "",
    userId: "user-a",
    userDisplayName: "User A",
    summonKind: "dm-chat",
    content: "hello",
    history,
    reference: null,
    attachments: [],
  };
}

describe("DM container keying (ADR-011 §3)", () => {
  it("a DM container is never treated as a thread", () => {
    expect(isThreadContainer("discord:@me:999888")).toBe(false);
    expect(isThreadContainer("discord:111:222:333")).toBe(true);
  });

  it("DM context keeps only the requesting user's and bot messages", () => {
    const history = [
      message({ id: "m1", authorId: "user-a", createdAt: 1000 }),
      message({ id: "m2", authorId: "intruder", createdAt: 1100 }),
      message({ id: "m3", authorId: "bot", isBot: true, createdAt: 1200 }),
    ];
    const decision = buildContext(request("discord:@me:999888", history), 0);
    expect(decision.mode).toBe("channel");
    expect(decision.messages.map((m) => m.id)).toEqual(["m1", "m3"]);
  });

  it("DM context honors the reset cutoff", () => {
    const history = [
      message({ id: "old", authorId: "user-a", createdAt: 1000 }),
      message({ id: "new", authorId: "user-a", createdAt: 2000 }),
    ];
    const decision = buildContext(request("discord:@me:999888", history), 1500);
    expect(decision.messages.map((m) => m.id)).toEqual(["new"]);
  });

  it("the current message is never part of its own context", () => {
    const history = [message({ id: "current", authorId: "user-a", createdAt: 1000 })];
    const decision = buildContext(request("discord:@me:999888", history), 0);
    expect(decision.mode).toBe("none");
    expect(decision.messages).toEqual([]);
  });
});
