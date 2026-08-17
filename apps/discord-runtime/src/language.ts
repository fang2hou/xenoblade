import { MessageFlags } from "discord.js";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UiLanguage } from "@xenoblade/contracts";

import { settingsOp } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages } from "./i18n";

/** How long a resolved language stays cached before re-fetching settings. */
const CACHE_TTL_MS = 5 * 60_000;
/** Safety valve: reset the cache rather than grow it unboundedly. */
const CACHE_MAX_ENTRIES = 4_096;

const cache = new Map<string, { language: UiLanguage; expiresAt: number }>();

/**
 * Resolve the UI language for a user: TTL cache, then the Worker settings
 * endpoint, then zh on any failure (fail-open; notices must still render).
 */
export async function resolveUiLanguage(userId: string, env: EnvConfig): Promise<UiLanguage> {
  const hit = cache.get(userId);
  if (hit && hit.expiresAt > Date.now()) return hit.language;

  let language: UiLanguage = "zh";
  try {
    const response = await settingsOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
    if (response.status === "ok") language = response.settings.language;
  } catch (error) {
    console.log(JSON.stringify({ event: "language_resolve_error", userId, error: String(error) }));
  }

  if (cache.size >= CACHE_MAX_ENTRIES) cache.clear();
  cache.set(userId, { language, expiresAt: Date.now() + CACHE_TTL_MS });
  return language;
}

/** Update the cache after a successful set (used by the /language command). */
export function rememberUiLanguage(userId: string, language: UiLanguage): void {
  cache.set(userId, { language, expiresAt: Date.now() + CACHE_TTL_MS });
}

/** Reset the cached languages (test seam). */
export function resetLanguageCache(): void {
  cache.clear();
}

/**
 * Resolve the UI language with a hard delay cap: a slow or cold settings
 * call must never hold back the staged-status placeholder or the generation
 * call. Falls back to zh when the cap hits; the underlying resolve keeps
 * running and populates the cache for the next run.
 */
export function resolveUiLanguageBounded(
  userId: string,
  env: EnvConfig,
  maxDelayMs: number,
): Promise<UiLanguage> {
  return Promise.race([
    resolveUiLanguage(userId, env),
    new Promise<UiLanguage>((resolve) => {
      setTimeout(() => resolve("zh"), maxDelayMs).unref();
    }),
  ]);
}

/** /language → persist the user's UI language and confirm ephemerally. */
export async function handleLanguageCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const requested = interaction.options.getString("value");
  // Acknowledge inside Discord's 3s window before the Worker call; see
  // handleUsageCommand. The confirmation renders in the NEW language.
  const language: UiLanguage | null = requested === "zh" || requested === "en" ? requested : null;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  try {
    if (!language) {
      await interaction.editReply({ content: messages("zh").language.invalid });
      return;
    }
    const response = await settingsOp(
      { op: "set", userId: interaction.user.id, language },
      env.workerUrl,
      env.internalApiToken,
    );
    if (response.status === "ok") {
      rememberUiLanguage(interaction.user.id, language);
      await interaction.editReply({ content: messages(language).language.set });
      return;
    }
    console.log(
      JSON.stringify({
        event: "language_command_error",
        userId: interaction.user.id,
        code: response.code,
      }),
    );
    await interaction
      .editReply({ content: messages(language).language.failure })
      .catch(() => undefined);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "language_command_error",
        userId: interaction.user.id,
        error: String(error),
      }),
    );
    await interaction
      .editReply({ content: messages("zh").language.failure })
      .catch(() => undefined);
  }
}
