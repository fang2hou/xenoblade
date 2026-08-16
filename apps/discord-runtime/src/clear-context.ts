import type { ChatInputCommandInteraction } from "discord.js";

import { clearContext } from "./ai-client";
import type { EnvConfig } from "./env";

const CLEAR_SUCCESS_REPLY = "已清除你在此频道的对话上下文。";
const CLEAR_FAILURE_REPLY = "清除上下文失败，请稍后重试。";

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
      content: result.status === "ok" ? CLEAR_SUCCESS_REPLY : CLEAR_FAILURE_REPLY,
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
    await interaction.editReply({ content: CLEAR_FAILURE_REPLY }).catch(() => undefined);
  }
}
