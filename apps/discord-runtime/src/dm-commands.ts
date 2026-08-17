import type { Message } from "discord.js";

import { settingsOp } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages } from "./i18n";
import { resolveUiLanguage } from "./language";
import { postReply } from "./output";

/**
 * Route a DM message. The control plane is native slash commands now
 * (`/persona`, `/preference`, `/memory`, `/chat`, `/learn`, `/help`);
 * non-command DM text continues to generation only for chat-opted-in
 * users (ADR-011) and otherwise gets the help overview.
 */
export async function handleDmMessage(
  message: Message,
  env: EnvConfig,
  enqueueGeneration: (message: Message) => void,
): Promise<void> {
  if (message.author.bot) return;

  // Only sendable channels can receive replies; bail silently otherwise.
  const channel = message.channel;
  if (!channel?.isSendable()) return;

  try {
    if (await isChatOptedIn(message.author.id, env)) {
      enqueueGeneration(message);
      return;
    }
    // Fail-open: notices still render (in zh) when settings are unreadable.
    const language = await resolveUiLanguage(message.author.id, env);
    await postReply(channel, messages(language).dm.help);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "dm_message_error",
        userId: message.author.id,
        error: String(error),
      }),
    );
  }
}

/** True only when the DM chat opt-in is confirmed readable and on (fail closed). */
async function isChatOptedIn(userId: string, env: EnvConfig): Promise<boolean> {
  try {
    const response = await settingsOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
    return response.status === "ok" && response.settings.chatOptin;
  } catch (error) {
    console.log(JSON.stringify({ event: "settings_read_error", error: String(error) }));
    return false;
  }
}
