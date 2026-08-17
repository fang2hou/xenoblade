import type { ChatInputCommandInteraction } from "discord.js";

import { restoreContext, truncateContext } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages } from "./i18n";
import { resolveUiLanguage } from "./language";

/** /context truncate|restore → Worker context endpoints (ADR-014). */
export async function handleContextCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const subcommand = interaction.options.getSubcommand();
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

  // Fail-open: notices still render (in zh) when settings are unreadable.
  const language = await resolveUiLanguage(interaction.user.id, env);
  const table = messages(language).context;
  const failureText = subcommand === "truncate" ? table.truncateFailure : table.restoreFailure;

  try {
    if (subcommand === "truncate") {
      const result = await truncateContext(
        { userId: interaction.user.id, scopeId, containerId },
        env.workerUrl,
        env.internalApiToken,
      );
      await interaction.editReply({
        content: result.status === "ok" ? table.truncateSuccess : table.truncateFailure,
      });
      return;
    }

    const result = await restoreContext(
      { userId: interaction.user.id, scopeId, containerId },
      env.workerUrl,
      env.internalApiToken,
    );
    if (result.status !== "ok") {
      await interaction.editReply({ content: table.restoreFailure });
      return;
    }
    await interaction.editReply({
      content: result.restored ? table.restoreSuccess(result.remainingUndos) : table.restoreNone,
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "context_command_error",
        subcommand,
        userId: interaction.user.id,
        containerId,
        error: String(error),
      }),
    );
    await interaction.editReply({ content: failureText }).catch(() => undefined);
  }
}
