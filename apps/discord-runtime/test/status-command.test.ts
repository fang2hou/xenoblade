import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UiLanguage, UserSettings } from "@xenoblade/contracts";

import type { EnvConfig } from "../src/env";
import { resetLanguageCache } from "../src/language";
import { handleStatusCommand } from "../src/status";

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

function makeInteraction() {
  const replies: string[] = [];
  const interaction = {
    commandName: "status",
    guildId: "guild-1",
    user: { id: "user-1" },
    reply: async (options: string | { content?: string }) => {
      replies.push(typeof options === "string" ? options : (options.content ?? ""));
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    replies,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("handleStatusCommand", () => {
  it("replies with the localized liveness message in one direct reply", async () => {
    const { interaction, replies } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      vi.fn<(input: unknown) => Promise<Response>>(async (input: unknown) => {
        const url = String(input);
        const language: UiLanguage = url.includes("/internal/v1/settings") ? "en" : "zh";
        return new Response(JSON.stringify({ status: "ok", settings: settingsFor(language) }), {
          status: 200,
        });
      }),
    );

    await handleStatusCommand(interaction, env);

    expect(replies).toEqual(["Xenoblade Gateway OK"]);
  });

  it("replies in zh when the settings call fails (fail-open, bounded wait)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        throw new Error("down");
      }),
    );
    const { interaction, replies } = makeInteraction();

    await handleStatusCommand(interaction, env);

    expect(replies).toEqual(["Xenoblade 网关运行正常。"]);
  });
});
