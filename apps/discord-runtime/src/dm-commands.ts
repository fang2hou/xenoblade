import type { Message, SendableChannels } from "discord.js";
import type { MemoryCategory, MemoryResponse, UserMemory } from "@xenoblade/contracts";

import type { EnvConfig } from "./env";
import { clearContext, memoryOp, settingsOp } from "./ai-client";
import { containerIdFromMessage } from "./conversation-scope";
import type { Messages } from "./i18n";
import { messages } from "./i18n";
import { resolveUiLanguage } from "./language";
import { postReply } from "./output";

/**
 * Route a DM message. Control-plane commands ALWAYS take routing priority
 * (ADR-011 §2). Non-command text reaches the AI generation pipeline — via
 * `enqueueGeneration` — only for chat-opted-in users; everyone else gets the
 * help message. Notices render in the user's UI language.
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

  // Fail-open: notices still render (in zh) when settings are unreadable.
  const language = await resolveUiLanguage(message.author.id, env);
  const table = messages(language).dm;

  const content = message.content.trim();
  const tokens = content.split(/\s+/);
  const command = (tokens[0] ?? "").toLowerCase();

  try {
    switch (command) {
      case "/help":
        await postReply(channel, table.help);
        return;
      case "/persona":
        await handleCategoryCommand(message, channel, env, "persona", tokens, table);
        return;
      case "/preference":
        await handleCategoryCommand(message, channel, env, "preference", tokens, table);
        return;
      case "/memory":
        await handleMemoryCommand(message, channel, env, tokens, table);
        return;
      case "/chat":
        await handleChatCommand(message, env, tokens, table);
        return;
      case "/learn":
        await handleLearnCommand(message, env, tokens, table);
        return;
      default:
        // Non-command DM text → generation for opted-in users, else help.
        if (await isChatOptedIn(message.author.id, env)) {
          enqueueGeneration(message);
          return;
        }
        await postReply(channel, table.help);
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "dm_command_error",
        userId: message.author.id,
        command,
        error: String(error),
      }),
    );
    await safeReply(message, table.genericError);
  }
}

/** True only when the DM chat opt-in is confirmed readable and on (fail closed). */
async function isChatOptedIn(userId: string, env: EnvConfig): Promise<boolean> {
  try {
    const response = await settingsOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
    return response.status === "ok" && response.settings.chatOptin;
  } catch (error) {
    console.log(JSON.stringify({ event: "dm_optin_check_error", userId, error: String(error) }));
    return false;
  }
}

/** Handle `/persona` and `/preference` (both backed by the memory endpoint). */
async function handleCategoryCommand(
  message: Message,
  channel: SendableChannels,
  env: EnvConfig,
  category: MemoryCategory,
  tokens: string[],
  table: Messages["dm"],
): Promise<void> {
  const userId = message.author.id;
  const sub = (tokens[1] ?? "").toLowerCase();
  const label = categoryLabel(category, table);

  if (sub === "show" || sub === "list") {
    const response = await memoryOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
    const memories = filterMemories(response, category);
    await postReply(channel, formatMemories(label, memories, table));
    return;
  }

  if (sub === "set") {
    const key = tokens[2];
    const value = tokens.slice(3).join(" ").trim();
    if (!key || value === "") {
      await safeReply(message, table.categoryUsage(category));
      return;
    }
    const response = await memoryOp(
      { op: "set", userId, category, key, value },
      env.workerUrl,
      env.internalApiToken,
    );
    await safeReply(
      message,
      response.status === "ok" ? table.memorySet(label, key) : table.memoryError,
    );
    return;
  }

  if (sub === "clear") {
    const key = tokens[2];
    const request = key
      ? { op: "clear" as const, userId, category, key }
      : { op: "clear" as const, userId, category };
    const response = await memoryOp(request, env.workerUrl, env.internalApiToken);
    await safeReply(
      message,
      response.status === "ok" ? table.memoryCleared(label) : table.memoryError,
    );
    return;
  }

  await safeReply(message, table.unknownSubCategory(category));
}

/** Handle `/memory show` and `/memory clear` (all categories). */
async function handleMemoryCommand(
  message: Message,
  channel: SendableChannels,
  env: EnvConfig,
  tokens: string[],
  table: Messages["dm"],
): Promise<void> {
  const userId = message.author.id;
  const sub = (tokens[1] ?? "").toLowerCase();

  if (sub === "show") {
    const response = await memoryOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
    const memories = response.status === "ok" ? response.memories : [];
    await postReply(channel, formatAllMemories(memories, table));
    return;
  }

  if (sub === "clear") {
    const response = await memoryOp({ op: "clear", userId }, env.workerUrl, env.internalApiToken);
    await safeReply(
      message,
      response.status === "ok" ? table.allMemoriesCleared : table.memoryError,
    );
    return;
  }

  await safeReply(message, table.unknownSubMemory);
}

/**
 * Handle `/chat on|off` — toggle the DM chat opt-in (ADR-011). Opting out also
 * resets the user's DM conversation context.
 */
async function handleChatCommand(
  message: Message,
  env: EnvConfig,
  tokens: string[],
  table: Messages["dm"],
): Promise<void> {
  const userId = message.author.id;
  const sub = (tokens[1] ?? "").toLowerCase();

  if (sub === "on" || sub === "off") {
    const enable = sub === "on";
    const response = await settingsOp(
      { op: "set", userId, chatOptin: enable },
      env.workerUrl,
      env.internalApiToken,
    );
    if (response.status === "error") {
      await safeReply(message, table.genericError);
      return;
    }
    if (enable) {
      await safeReply(message, table.chatOn);
      return;
    }

    // Opting out also resets the DM conversation context (ADR-011 §3),
    // best-effort: a failed clear is surfaced with a /clear-context hint.
    let clearNote = table.chatOffClearOk;
    try {
      const cleared = await clearContext(
        {
          userId,
          scopeId: "dm",
          containerId: containerIdFromMessage(message),
          scope: "user",
        },
        env.workerUrl,
        env.internalApiToken,
      );
      if (cleared.status === "error") {
        clearNote = table.chatOffClearFailed;
      }
    } catch {
      clearNote = table.chatOffClearFailed;
    }
    await safeReply(message, `${table.chatOffPrefix}${clearNote}`);
    return;
  }

  const state = await optinState(message, env, "chat", table);
  await safeReply(message, table.chatState(state));
}

/** Handle `/learn on|off` — toggle the auto-memory opt-in (ADR-012). */
async function handleLearnCommand(
  message: Message,
  env: EnvConfig,
  tokens: string[],
  table: Messages["dm"],
): Promise<void> {
  const userId = message.author.id;
  const sub = (tokens[1] ?? "").toLowerCase();

  if (sub === "on" || sub === "off") {
    const response = await settingsOp(
      { op: "set", userId, learnOptin: sub === "on" },
      env.workerUrl,
      env.internalApiToken,
    );
    if (response.status === "error") {
      await safeReply(message, table.genericError);
      return;
    }
    await safeReply(message, sub === "on" ? table.learnOn : table.learnOff);
    return;
  }

  const state = await optinState(message, env, "learn", table);
  await safeReply(message, table.learnState(state));
}

/** Resolve the current on/off label for an opt-in flag; unknown on read failure. */
async function optinState(
  message: Message,
  env: EnvConfig,
  flag: "chat" | "learn",
  table: Messages["dm"],
): Promise<string> {
  try {
    const response = await settingsOp(
      { op: "get", userId: message.author.id },
      env.workerUrl,
      env.internalApiToken,
    );
    const on =
      response.status === "ok" &&
      (flag === "chat" ? response.settings.chatOptin : response.settings.learnOptin);
    return on ? table.stateOn : table.stateOff;
  } catch {
    return table.stateUnknown;
  }
}

/** Filter a get-response to a single category; empty on error. */
function filterMemories(response: MemoryResponse, category: MemoryCategory): UserMemory[] {
  return response.status === "ok"
    ? response.memories.filter((memory) => memory.category === category)
    : [];
}

function formatMemories(label: string, memories: UserMemory[], table: Messages["dm"]): string {
  if (memories.length === 0) return table.noCategoryMemories(label);
  const lines = memories.map((memory) => `- ${memory.key}: ${memory.value}`);
  return `${table.categoryMemoriesHeader(label)}\n${lines.join("\n")}`;
}

function formatAllMemories(memories: UserMemory[], table: Messages["dm"]): string {
  if (memories.length === 0) return table.noMemories;
  const lines = memories.map((memory) => `- [${memory.category}] ${memory.key}: ${memory.value}`);
  return `${table.allMemoriesHeader}\n${lines.join("\n")}`;
}

function categoryLabel(category: MemoryCategory, table: Messages["dm"]): string {
  return category === "persona" ? table.personaLabel : table.preferenceLabel;
}

/** Reply, swallowing send failures (DM control plane must not throw). */
async function safeReply(message: Message, content: string): Promise<void> {
  try {
    await message.reply(content);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "dm_reply_error",
        userId: message.author.id,
        error: String(error),
      }),
    );
  }
}
