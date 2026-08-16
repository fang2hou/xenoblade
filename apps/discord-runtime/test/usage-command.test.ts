import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";

import { handleUsageCommand } from "../src/usage";
import type { EnvConfig } from "../src/env";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

const okSummary = {
  status: "ok",
  windowMs: 24 * 60 * 60 * 1000,
  user: {
    messages: 2,
    generations: 1,
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    topTools: [],
  },
  guild: {
    messages: 40,
    generations: 30,
    inputTokens: 1000,
    outputTokens: 2000,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    topTools: [],
  },
};

const FAILURE_TEXT = "Failed to load usage summary. Please try again later.";

function makeInteraction() {
  const calls: string[] = [];
  const editContents: string[] = [];
  let deferOptions: unknown;
  const interaction = {
    commandName: "usage",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    channel: null,
    deferReply: async (options?: unknown) => {
      calls.push("defer");
      deferOptions = options;
    },
    editReply: async (options: string | { content?: string }) => {
      calls.push("edit");
      editContents.push(typeof options === "string" ? options : (options.content ?? ""));
    },
    reply: async () => {
      calls.push("reply");
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    calls,
    editContents,
    getDeferOptions: () => deferOptions,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("handleUsageCommand", () => {
  it("defers ephemerally before the Worker call, then edits in the summary", async () => {
    const { interaction, calls, editContents, getDeferOptions } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch");
        return new Response(JSON.stringify(okSummary), { status: 200 });
      }),
    );

    await handleUsageCommand(interaction, env);

    // defer must precede the Worker fetch: a late first ack is what renders
    // as "The application did not respond" in Discord.
    expect(calls).toEqual(["defer", "fetch", "edit"]);
    expect(getDeferOptions()).toEqual({ flags: MessageFlags.Ephemeral });
    expect(editContents[0]).toContain("**You — last 24h**");
  });

  it("edits in the failure notice when the Worker returns an error status", async () => {
    const { interaction, calls, editContents } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch");
        return new Response(JSON.stringify({ status: "error", code: "boom" }), { status: 200 });
      }),
    );

    await handleUsageCommand(interaction, env);

    expect(calls).toEqual(["defer", "fetch", "edit"]);
    expect(editContents[0]).toBe(FAILURE_TEXT);
  });

  it("edits in the failure notice when the Worker call rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { interaction, calls, editContents } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls.push("fetch");
        throw new Error("network down");
      }),
    );

    await handleUsageCommand(interaction, env);

    expect(calls).toEqual(["defer", "fetch", "edit"]);
    expect(editContents[0]).toBe(FAILURE_TEXT);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"usage_command_error"'));
  });
});
