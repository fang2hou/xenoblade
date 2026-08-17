import type { ChatInputCommandInteraction } from "discord.js";

import { clearContext } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages } from "./i18n";
import { resolveUiLanguage } from "./language";

/** /clear-context → call the Worker context-clear endpoint. */
export async function handleClearContext(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const guildId = interaction.guildId ?? "@me";
  const scopeId = interaction.guildId ?? "dm";
  const channel = interaction.channel;

  let containerId: string;
  if (channel && channel.isThread()) {
    containerId = `discord:${guildId}:${channel.parentId ?? channel.id}:${channel.id}`;
  } else {
    containerId = `discord:${guildId}:${interaction.channelId ?? ""}`;
  }

  // Acknowledge inside Discord's 3s interaction window before the Worker call:
  // the control request can run up to its 15s timeout, and a first reply that
  // late renders as "The application did not respond". editReply then delivers
  // the final result into the deferred reply.
  await interaction.deferReply();
  try {
    // Fail-open: notices still render (in zh) when settings are unreadable.
    const language = await resolveUiLanguage(interaction.user.id, env);
    const table = messages(language).clearContext;
    const result = await clearContext(
      {
        userId: interaction.user.id,
        scopeId,
        containerId,
        scope: "user",
      },
      env.workerUrl,
      env.internalApiToken,
    );
    await interaction.editReply({
      content: result.status === "ok" ? table.success : table.failure,
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "clear_context_error",
        userId: interaction.user.id,
        containerId,
        error: String(error),
      }),
    );
    await interaction
      .editReply({ content: messages("zh").clearContext.failure })
      .catch(() => undefined);
  }
}
