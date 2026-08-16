import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UsageSubjectSummary, UsageSummary } from "@xenoblade/contracts";

import { fetchUsage } from "./ai-client";
import type { EnvConfig } from "./env";

const USAGE_FAILURE_REPLY = "Failed to load usage summary. Please try again later.";

/** /usage → fetch the Worker usage summary and reply ephemerally. */
export async function handleUsageCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const scopeId = interaction.guildId ?? "dm";
  // Acknowledge inside Discord's 3s interaction window before the Worker call:
  // the usage fetch can run up to its 15s timeout, and a first reply that
  // late renders as "The application did not respond". The deferred reply is
  // ephemeral so the final edit stays visible only to the invoking user.
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    const summary = await fetchUsage(
      { userId: interaction.user.id, scopeId },
      env.workerUrl,
      env.internalApiToken,
    );
    const content = summary.status === "ok" ? formatUsageSummary(summary) : USAGE_FAILURE_REPLY;
    await interaction.editReply({ content });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "usage_command_error",
        userId: interaction.user.id,
        scopeId,
        error: String(error),
      }),
    );
    await interaction.editReply({ content: USAGE_FAILURE_REPLY }).catch(() => undefined);
  }
}

/**
 * Render the usage summary as a compact ephemeral reply.
 *
 * Follows the bot's Discord formatting rules (SAFETY_SYSTEM): bold labels for
 * section titles, no Markdown tables or headers, `·`-separated inline stats.
 */
export function formatUsageSummary(summary: UsageSummary): string {
  const hours = Math.round(summary.windowMs / 3_600_000);
  return [
    ...formatSubject(`**You — last ${hours}h**`, summary.user),
    "",
    ...formatSubject(`**Server — last ${hours}h**`, summary.guild),
  ].join("\n");
}

function formatSubject(title: string, subject: UsageSubjectSummary): string[] {
  const lines = [
    title,
    `Generations: ${subject.generations} · Messages: ${subject.messages}`,
    `Tokens: ${subject.inputTokens.toLocaleString("en-US")} in · ${subject.outputTokens.toLocaleString("en-US")} out · ${subject.cacheReadTokens.toLocaleString("en-US")} cache read · ${subject.cacheWriteTokens.toLocaleString("en-US")} cache write`,
  ];
  if (subject.topTools.length > 0) {
    lines.push(`Top tools: ${subject.topTools.map((t) => `${t.tool} ×${t.count}`).join(" · ")}`);
  }
  return lines;
}
