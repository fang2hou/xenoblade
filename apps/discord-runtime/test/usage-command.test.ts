import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UserSettings } from "@xenoblade/contracts";

import { handleUsageCommand } from "../src/usage";
import type { EnvConfig } from "../src/env";
import { resetLanguageCache } from "../src/language";

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

function settingsFor(language: UserSettings["language"]): UserSettings {
  return {
    chatOptin: false,
    learnOptin: false,
    chatOptinAt: null,
    learnOptinAt: null,
    language,
  };
}

const FAILURE_TEXT_ZH = "加载用量统计失败，请稍后重试。";

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

/** Fetch stub routing the settings control call vs the usage call. */
function stubFetch(language: UserSettings["language"], calls: string[], usageBody: unknown) {
  return vi.fn<(input: unknown) => Promise<Response>>(async (input: unknown) => {
    const url = String(input);
    if (url.includes("/internal/v1/settings")) {
      calls.push("settings");
      return new Response(JSON.stringify({ status: "ok", settings: settingsFor(language) }), {
        status: 200,
      });
    }
    calls.push("usage");
    return new Response(JSON.stringify(usageBody), { status: 200 });
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("handleUsageCommand", () => {
  it("defers ephemerally before the Worker calls, then edits in the summary", async () => {
    const { interaction, calls, editContents, getDeferOptions } = makeInteraction();
    vi.stubGlobal("fetch", stubFetch("en", calls, okSummary));

    await handleUsageCommand(interaction, env);

    // defer must precede every Worker call: a late first ack is what renders
    // as "The application did not respond" in Discord.
    expect(calls).toEqual(["defer", "settings", "usage", "edit"]);
    expect(getDeferOptions()).toEqual({ flags: MessageFlags.Ephemeral });
    expect(editContents[0]).toContain("**You — last 24h**");
  });

  it("renders the localized summary for a zh user", async () => {
    const { interaction, editContents } = makeInteraction();
    const calls: string[] = [];
    vi.stubGlobal("fetch", stubFetch("zh", calls, okSummary));

    await handleUsageCommand(interaction, env);

    expect(editContents[0]).toContain("**你 — 最近 24 小时**");
    expect(editContents[0]).toContain("**服务器 — 最近 24 小时**");
  });

  it("edits in the failure notice when the Worker returns an error status", async () => {
    const { interaction, calls, editContents } = makeInteraction();
    vi.stubGlobal("fetch", stubFetch("zh", calls, { status: "error", code: "boom" }));

    await handleUsageCommand(interaction, env);

    expect(calls).toEqual(["defer", "settings", "usage", "edit"]);
    expect(editContents[0]).toBe(FAILURE_TEXT_ZH);
  });

  it("edits in the failure notice when the Worker call rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { interaction, calls, editContents } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        calls.push("fetch");
        throw new Error("network down");
      }),
    );

    await handleUsageCommand(interaction, env);

    expect(calls).toEqual(["defer", "fetch", "fetch", "edit"]);
    expect(editContents[0]).toBe(FAILURE_TEXT_ZH);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"usage_command_error"'));
  });
});
