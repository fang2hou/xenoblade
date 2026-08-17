import type { ChatInputCommandInteraction } from "discord.js";

import type { EnvConfig } from "./env";
import { messages } from "./i18n";
import { resolveUiLanguageBounded } from "./language";

/** /status → local liveness reply in the user's UI language. */
export async function handleStatusCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  // Bounded: a cold or slow settings fetch must never push the reply past
  // Discord's 3s interaction window; zh covers the degraded case.
  const language = await resolveUiLanguageBounded(interaction.user.id, env, 500);
  await interaction.reply(messages(language).status.ok);
}
