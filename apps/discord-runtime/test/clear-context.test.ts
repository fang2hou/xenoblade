import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";

import { handleClearContext } from "../src/clear-context";
import type { EnvConfig } from "../src/env";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

const SUCCESS_TEXT = "已清除你在此频道的对话上下文。";
const FAILURE_TEXT = "清除上下文失败，请稍后重试。";

/** Narrow an unknown JSON body to a record for field assertions. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function makeInteraction(options: { isThread?: boolean; parentId?: string | null } = {}) {
  const { isThread = false, parentId = "parent-9" } = options;
  const calls: string[] = [];
  const editContents: string[] = [];
  const bodies: unknown[] = [];
  let deferOptions: unknown;
  const interaction = {
    commandName: "clear-context",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    channel: {
      id: "channel-1",
      parentId,
      isThread: () => isThread,
    },
    deferReply: async (defer?: unknown) => {
      calls.push("defer");
      deferOptions = defer;
    },
    editReply: async (editOptions: string | { content?: string }) => {
      calls.push("edit");
      editContents.push(
        typeof editOptions === "string" ? editOptions : (editOptions.content ?? ""),
      );
    },
    reply: async () => {
      calls.push("reply");
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    calls,
    editContents,
    bodies,
    getDeferOptions: () => deferOptions,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handleClearContext", () => {
  it("defers before the Worker call, then edits in the success notice", async () => {
    const { interaction, calls, editContents, bodies, getDeferOptions } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        calls.push("fetch");
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ status: "ok", cleared: 3 }), { status: 200 });
      }),
    );

    await handleClearContext(interaction, env);

    // defer must precede the Worker fetch: a late first ack is what renders
    // as "The application did not respond" in Discord. Stays non-ephemeral.
    expect(calls).toEqual(["defer", "fetch", "edit"]);
    expect(getDeferOptions()).toBeUndefined();
    expect(editContents[0]).toBe(SUCCESS_TEXT);
    expect(asRecord(bodies[0])).toEqual({
      userId: "user-1",
      scopeId: "guild-1",
      containerId: "discord:guild-1:channel-1",
      scope: "user",
    });
  });

  it("scopes the container to the parent channel inside a thread", async () => {
    const { interaction, bodies } = makeInteraction({ isThread: true, parentId: "parent-9" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ status: "ok", cleared: 0 }), { status: 200 });
      }),
    );

    await handleClearContext(interaction, env);

    expect(asRecord(bodies[0])["containerId"]).toBe("discord:guild-1:parent-9:channel-1");
  });

  it("edits in the failure notice when the Worker call rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { interaction, calls, editContents } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch");
        throw new Error("timeout");
      }),
    );

    await handleClearContext(interaction, env);

    expect(calls).toEqual(["defer", "fetch", "edit"]);
    expect(editContents[0]).toBe(FAILURE_TEXT);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"clear_context_error"'));
  });

  it("edits in the failure notice when the Worker returns an error status", async () => {
    const { interaction, editContents } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ status: "error", code: "denied" }), { status: 200 }),
      ),
    );

    await handleClearContext(interaction, env);

    expect(editContents[0]).toBe(FAILURE_TEXT);
  });
});
