import { REST, Routes } from "discord.js";

import type { EnvConfig } from "./env";

/** Global slash command definitions registered with Discord on startup. */
export const SLASH_COMMANDS = [
  {
    name: "status",
    description: "Check Xenoblade gateway status",
  },
  {
    name: "clear-context",
    description: "Clear your conversation context in this channel",
  },
  {
    name: "usage",
    description: "Show your 24h usage and token summary",
  },
] as const;

/**
 * Register the global slash commands (idempotent, best-effort). A registration
 * failure is logged, never fatal — the client stays up and retries on next
 * start. `rest` is injectable for tests.
 */
export async function registerSlashCommands(
  env: EnvConfig,
  rest: Pick<REST, "put"> = new REST({ version: "10" }).setToken(env.discordBotToken),
): Promise<void> {
  try {
    await rest.put(Routes.applicationCommands(env.discordApplicationId), {
      body: SLASH_COMMANDS,
    });
    console.log(JSON.stringify({ event: "slash_commands_registered" }));
  } catch (error) {
    console.log(JSON.stringify({ event: "slash_register_error", error: String(error) }));
  }
}
