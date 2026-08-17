import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, MessageReaction, SendableChannels, User } from "discord.js";
import type { MemoryProposal } from "@xenoblade/contracts";

import {
  handleMemoryConfirmReaction,
  MemoryConfirmRegistry,
  postMemoryConfirmation,
  renderConfirmation,
  renderConfirmOutcome,
  resolveConfirmAction,
} from "../src/memory-confirm";
import { messages } from "../src/i18n";
import type { EnvConfig } from "../src/env";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

const TEXTS = messages("zh").memoryConfirm;

function proposal(overrides: Partial<MemoryProposal> = {}): MemoryProposal {
  return {
    id: "p1",
    action: "save",
    category: "fact",
    key: "favorite language",
    value: "Rust",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveConfirmAction", () => {
  const entry = {
    userId: "user-1",
    channelId: "channel-1",
    proposals: [proposal()],
    texts: TEXTS,
    settled: false,
  };

  it("confirms on ✅ from the owning user", () => {
    expect(resolveConfirmAction(entry, "✅", "user-1", false)).toBe("confirm");
  });

  it("cancels on ❌ from the owning user", () => {
    expect(resolveConfirmAction(entry, "❌", "user-1", false)).toBe("cancel");
  });

  it("ignores other users, bots, other emoji, settled entries, and untracked ids", () => {
    expect(resolveConfirmAction(entry, "✅", "user-2", false)).toBeNull();
    expect(resolveConfirmAction(entry, "✅", "user-1", true)).toBeNull();
    expect(resolveConfirmAction(entry, "👍", "user-1", false)).toBeNull();
    expect(resolveConfirmAction({ ...entry, settled: true }, "✅", "user-1", false)).toBeNull();
    expect(resolveConfirmAction(undefined, "✅", "user-1", false)).toBeNull();
  });
});

describe("renderConfirmation", () => {
  it("lists save and forget proposals with category labels", () => {
    const text = renderConfirmation(
      [
        proposal(),
        proposal({ id: "p2", action: "forget", category: undefined, key: "pet" }),
        proposal({
          id: "p3",
          action: "save",
          category: "preference",
          key: "reply style",
          value: "简短",
        }),
      ],
      TEXTS,
    );
    expect(text).toContain("- ＋ 事实 · favorite language：Rust");
    expect(text).toContain("- － pet");
    expect(text).toContain("- ＋ 偏好 · reply style：简短");
    expect(text).toContain(TEXTS.footer);
  });
});

describe("renderConfirmOutcome", () => {
  it("reports full success, partial success, failure, and cap states", () => {
    const ok = { id: "p1", ok: true };
    expect(renderConfirmOutcome({ status: "ok", results: [ok] }, 1, TEXTS)).toBe(TEXTS.saved);
    expect(
      renderConfirmOutcome({ status: "ok", results: [ok, { id: "p2", ok: false }] }, 2, TEXTS),
    ).toBe(TEXTS.savedPartial(1, 2));
    expect(renderConfirmOutcome({ status: "error", code: "x" }, 1, TEXTS)).toBe(TEXTS.failed);
    expect(renderConfirmOutcome(null, 1, TEXTS)).toBe(TEXTS.failed);
    expect(
      renderConfirmOutcome(
        { status: "ok", results: [{ id: "p1", ok: false, code: "memory_full" }] },
        1,
        TEXTS,
      ),
    ).toBe(TEXTS.full);
  });
});

describe("postMemoryConfirmation", () => {
  it("sends the confirmation, reacts with both emojis, and registers it", async () => {
    const reacted: string[] = [];
    const sentContents: string[] = [];
    const message = fakeMessage("m1", "");
    message.react = ((emoji: string) => {
      reacted.push(emoji);
      return Promise.resolve({} as MessageReaction);
    }) as unknown as Message["react"];
    const registry = new MemoryConfirmRegistry();
    const channel = {
      send: async (content: string) => {
        sentContents.push(content);
        return message;
      },
    };

    await postMemoryConfirmation(
      channel as unknown as SendableChannels,
      "user-1",
      [proposal()],
      TEXTS,
      registry,
    );

    expect(sentContents[0]).toContain("favorite language");
    expect(reacted).toEqual(["✅", "❌"]);
    expect(registry.get("m1")?.userId).toBe("user-1");
    expect(registry.get("m1")?.proposals).toHaveLength(1);
  });
});

describe("handleMemoryConfirmReaction", () => {
  it("executes the proposals against the Worker on ✅ and edits the message", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<(_input: unknown, init?: RequestInit) => Promise<Response>>(
        async (_input: unknown, init?: RequestInit) => {
          bodies.push(JSON.parse(String(init?.body)));
          return new Response(JSON.stringify({ status: "ok", results: [{ id: "p1", ok: true }] }), {
            status: 200,
          });
        },
      ),
    );

    const edits: string[] = [];
    const message = fakeMessage("m1", "original", edits);
    const registry = new MemoryConfirmRegistry();
    registry.register("m1", {
      userId: "user-1",
      channelId: "channel-1",
      proposals: [proposal()],
      texts: TEXTS,
      settled: false,
    });

    await handleMemoryConfirmReaction(reactionOn(message, "✅"), fakeUser("user-1"), env, registry);

    expect(bodies).toEqual([{ userId: "user-1", proposals: [proposal()] }]);
    expect(edits).toEqual([TEXTS.saved]);
    expect(registry.get("m1")).toBeUndefined();
  });

  it("drops the proposals on ❌ without any Worker call", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchMock = vi.fn<() => Promise<Response>>();
    vi.stubGlobal("fetch", fetchMock);

    const edits: string[] = [];
    const message = fakeMessage("m1", "original", edits);
    const registry = new MemoryConfirmRegistry();
    registry.register("m1", {
      userId: "user-1",
      channelId: "channel-1",
      proposals: [proposal()],
      texts: TEXTS,
      settled: false,
    });

    await handleMemoryConfirmReaction(reactionOn(message, "❌"), fakeUser("user-1"), env, registry);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(edits).toEqual([TEXTS.cancelled]);
    expect(registry.get("m1")).toBeUndefined();
  });

  it("ignores reactions from other users entirely", async () => {
    const edits: string[] = [];
    const message = fakeMessage("m1", "original", edits);
    const registry = new MemoryConfirmRegistry();
    registry.register("m1", {
      userId: "user-1",
      channelId: "channel-1",
      proposals: [proposal()],
      texts: TEXTS,
      settled: false,
    });

    await handleMemoryConfirmReaction(reactionOn(message, "✅"), fakeUser("user-2"), env, registry);

    expect(edits).toEqual([]);
    expect(registry.get("m1")).toBeDefined();
  });
});

/** Minimal Message double: enough for edit/react/reactions.cache paths. */
function fakeMessage(id: string, _content: string, edits: string[] = []): Message {
  const message = {
    id,
    channelId: "channel-1",
    partial: false,
    client: { user: { id: "bot-1" } },
    edit: async (content: string) => {
      edits.push(content);
    },
    react: async () => undefined,
    reactions: {
      cache: {
        find: () => undefined,
      },
    },
  };
  return message as unknown as Message;
}

/** Minimal reaction double pointing at a message with the given emoji name. */
function reactionOn(message: Message, emojiName: string): MessageReaction {
  return {
    message,
    emoji: { name: emojiName },
  } as unknown as MessageReaction;
}

/** Minimal user double for reaction handlers (id + bot only). */
function fakeUser(id: string): User {
  return { id, bot: false } as unknown as User;
}
