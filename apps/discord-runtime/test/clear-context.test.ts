import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UserSettings } from "@xenoblade/contracts";

import { handleClearContext } from "../src/clear-context";
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

const SUCCESS_TEXT_ZH = "已清除你在此频道的对话上下文。";
const SUCCESS_TEXT_EN = "Cleared your conversation context in this channel.";
const FAILURE_TEXT_ZH = "清除上下文失败，请稍后重试。";

function settingsFor(language: UserSettings["language"]): UserSettings {
  return {
    chatOptin: false,
    learnOptin: false,
    chatOptinAt: null,
    learnOptinAt: null,
    language,
  };
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

/** Narrow an unknown JSON body to a record for field assertions. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Fetch stub routing the settings control call vs the context-clear call. */
function stubFetch(
  language: UserSettings["language"],
  calls: string[],
  bodies: unknown[],
  clearBody: unknown,
) {
  return vi.fn<(_input: unknown, init?: RequestInit) => Promise<Response>>(
    async (_input: unknown, init?: RequestInit) => {
      const url = String(_input);
      if (url.includes("/internal/v1/settings")) {
        calls.push("settings");
        return new Response(JSON.stringify({ status: "ok", settings: settingsFor(language) }), {
          status: 200,
        });
      }
      calls.push("clear");
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(clearBody), { status: 200 });
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("handleClearContext", () => {
  it("defers before the Worker calls, then edits in the success notice", async () => {
    const { interaction, calls, editContents, bodies, getDeferOptions } = makeInteraction();
    vi.stubGlobal("fetch", stubFetch("zh", calls, bodies, { status: "ok", cleared: 3 }));

    await handleClearContext(interaction, env);

    // defer must precede every Worker call: a late first ack is what renders
    // as "The application did not respond" in Discord. Stays non-ephemeral.
    expect(calls).toEqual(["defer", "settings", "clear", "edit"]);
    expect(getDeferOptions()).toBeUndefined();
    expect(editContents[0]).toBe(SUCCESS_TEXT_ZH);
    expect(asRecord(bodies[0])).toEqual({
      userId: "user-1",
      scopeId: "guild-1",
      containerId: "discord:guild-1:channel-1",
      scope: "user",
    });
  });

  it("renders the localized notice for an en user", async () => {
    const { interaction, editContents } = makeInteraction();
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", stubFetch("en", calls, bodies, { status: "ok", cleared: 0 }));

    await handleClearContext(interaction, env);

    expect(editContents[0]).toBe(SUCCESS_TEXT_EN);
  });

  it("scopes the container to the parent channel inside a thread", async () => {
    const { interaction, bodies } = makeInteraction({ isThread: true, parentId: "parent-9" });
    const calls: string[] = [];
    vi.stubGlobal("fetch", stubFetch("zh", calls, bodies, { status: "ok", cleared: 0 }));

    await handleClearContext(interaction, env);

    expect(asRecord(bodies[0])["containerId"]).toBe("discord:guild-1:parent-9:channel-1");
  });

  it("edits in the failure notice when the Worker call rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { interaction, calls, editContents } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        calls.push("fetch");
        throw new Error("timeout");
      }),
    );

    await handleClearContext(interaction, env);

    expect(calls).toEqual(["defer", "fetch", "fetch", "edit"]);
    expect(editContents[0]).toBe(FAILURE_TEXT_ZH);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"event":"clear_context_error"'));
  });

  it("edits in the failure notice when the Worker returns an error status", async () => {
    const { interaction, editContents } = makeInteraction();
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", stubFetch("zh", calls, bodies, { status: "error", code: "denied" }));

    await handleClearContext(interaction, env);

    expect(editContents[0]).toBe(FAILURE_TEXT_ZH);
  });
});
