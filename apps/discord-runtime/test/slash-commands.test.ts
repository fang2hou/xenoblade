import { describe, it, expect } from "vitest";
import { Routes } from "discord.js";

import { SLASH_COMMANDS, registerSlashCommands } from "../src/slash-commands";
import type { EnvConfig } from "../src/env";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

describe("SLASH_COMMANDS", () => {
  it("includes the three global commands with unique kebab-case names", () => {
    const names = SLASH_COMMANDS.map((command) => command.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toEqual(["status", "clear-context", "usage", "language"]);
    for (const command of SLASH_COMMANDS) {
      expect(command.description.length).toBeGreaterThan(0);
    }
  });
});

describe("registerSlashCommands", () => {
  it("PUTs the command definitions to the global application commands route", async () => {
    const puts: Array<{ route: string; body: unknown }> = [];
    await registerSlashCommands(env, {
      put: async (route, body) => {
        puts.push({ route, body });
        return [] as never;
      },
    });

    expect(puts).toHaveLength(1);
    expect(puts[0]?.route).toBe(Routes.applicationCommands("app-id"));
    expect(puts[0]?.body).toEqual({ body: SLASH_COMMANDS });
  });

  it("swallows registration failures (best-effort, never fatal)", async () => {
    await expect(
      registerSlashCommands(env, {
        put: async () => {
          throw new Error("rate limited");
        },
      }),
    ).resolves.toBeUndefined();
  });
});
