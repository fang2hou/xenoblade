import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UiLanguage, UsageSubjectSummary, UsageSummary } from "@xenoblade/contracts";

import { fetchUsage } from "./ai-client";
import type { EnvConfig } from "./env";
import type { Messages } from "./i18n";
import { messages } from "./i18n";
import { resolveUiLanguage } from "./language";

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
    // Fail-open: the summary still renders (in zh) when settings are unreadable.
    const language = await resolveUiLanguage(interaction.user.id, env);
    const summary = await fetchUsage(
      { userId: interaction.user.id, scopeId },
      env.workerUrl,
      env.internalApiToken,
    );
    const content =
      summary.status === "ok"
        ? formatUsageSummary(summary, language)
        : messages(language).usage.failure;
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
    await interaction.editReply({ content: messages("zh").usage.failure }).catch(() => undefined);
  }
}

/**
 * Render the usage summary as a compact ephemeral reply in the user's UI
 * language.
 *
 * Follows the bot's Discord formatting rules (SAFETY_SYSTEM): bold labels for
 * section titles, no Markdown tables or headers, `·`-separated inline stats.
 */
export function formatUsageSummary(summary: UsageSummary, language: UiLanguage): string {
  const table = messages(language).usage;
  const hours = Math.round(summary.windowMs / 3_600_000);
  return [
    ...formatSubject(table.you(hours), table, summary.user),
    "",
    ...formatSubject(table.server(hours), table, summary.guild),
  ].join("\n");
}

function formatSubject(
  title: string,
  table: Messages["usage"],
  subject: UsageSubjectSummary,
): string[] {
  const lines = [
    title,
    `${table.generations}: ${subject.generations} · ${table.messages}: ${subject.messages}`,
    `${table.tokens}: ${subject.inputTokens.toLocaleString("en-US")} in · ${subject.outputTokens.toLocaleString("en-US")} out · ${subject.cacheReadTokens.toLocaleString("en-US")} ${table.cacheRead} · ${subject.cacheWriteTokens.toLocaleString("en-US")} ${table.cacheWrite}`,
  ];
  if (subject.topTools.length > 0) {
    lines.push(
      `${table.topTools}: ${subject.topTools.map((t) => `${t.tool} ×${t.count}`).join(" · ")}`,
    );
  }
  return lines;
}
