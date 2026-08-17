import { afterEach, describe, expect, it, vi } from "vitest";
import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UserSettings } from "@xenoblade/contracts";

import type { EnvConfig } from "../src/env";
import {
  handleLanguageCommand,
  rememberUiLanguage,
  resetLanguageCache,
  resolveUiLanguage,
} from "../src/language";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
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
/** Fetch stub routing /settings vs everything else. */
function stubFetch(settings: UserSettings, calls: string[]): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.includes("/internal/v1/settings")) {
        calls.push("settings");
        return new Response(JSON.stringify({ status: "ok", settings }), { status: 200 });
      }
      calls.push("other");
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("resolveUiLanguage", () => {
  it("returns the stored language", async () => {
    const calls: string[] = [];
    stubFetch(settingsFor("en"), calls);

    expect(await resolveUiLanguage("u1", env)).toBe("en");
  });

  it("caches per user for the TTL window (one settings call for two resolves)", async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn<() => Promise<Response>>(async () => {
      calls.push("settings");
      return new Response(JSON.stringify({ status: "ok", settings: settingsFor("en") }), {
        status: 200,
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await resolveUiLanguage("u1", env)).toBe("en");
    expect(await resolveUiLanguage("u1", env)).toBe("en");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("fails open to zh when the Worker call rejects", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        throw new Error("down");
      }),
    );

    expect(await resolveUiLanguage("u1", env)).toBe("zh");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"language_resolve_error"'),
    );
  });

  it("rememberUiLanguage short-circuits the next resolve", async () => {
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    rememberUiLanguage("u1", "en");
    expect(await resolveUiLanguage("u1", env)).toBe("en");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function makeInteraction(value: string | null) {
  const calls: string[] = [];
  const editContents: string[] = [];
  let deferOptions: unknown;
  const bodies: unknown[] = [];
  const interaction = {
    commandName: "language",
    guildId: "guild-1",
    user: { id: "user-1" },
    options: { getString: (name: string) => (name === "value" ? value : null) },
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
    bodies,
    getDeferOptions: () => deferOptions,
  };
}
describe("handleLanguageCommand", () => {
  it("defers ephemerally, persists en, and confirms in English", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { interaction, calls, editContents, getDeferOptions } = makeInteraction("en");
    const posts: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        calls.push("settings");
        if (init?.body !== undefined) posts.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify({ status: "ok", settings: settingsFor("en") }), {
          status: 200,
        });
      }),
    );

    await handleLanguageCommand(interaction, env);

    expect(calls).toEqual(["defer", "settings", "edit"]);
    expect(getDeferOptions()).toEqual({ flags: MessageFlags.Ephemeral });
    expect(posts[0]).toEqual({ op: "set", userId: "user-1", language: "en" });
    expect(editContents[0]).toContain("English");

    // The cache was refreshed: a later resolve makes no Worker call.
    const fetchMock = vi.fn<() => Promise<Response>>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await resolveUiLanguage("user-1", env)).toBe("en");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining("language_command_error"));
  });

  it("rejects an invalid option with the invalid notice", async () => {
    const { interaction, calls, editContents } = makeInteraction("fr");

    await handleLanguageCommand(interaction, env);

    expect(calls).toEqual(["defer", "edit"]);
    expect(editContents[0]).toBe("无效的语言选项。");
  });

  it("edits in the failure notice when the Worker rejects the set", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { interaction, editContents } = makeInteraction("en");
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        throw new Error("down");
      }),
    );

    await handleLanguageCommand(interaction, env);

    expect(editContents[0]).toBe("切换语言失败，请稍后重试。");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"event":"language_command_error"'),
    );
  });
});
