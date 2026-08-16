import type { Message, SendableChannels } from "discord.js";
import type { MemoryCategory, MemoryResponse, UserMemory } from "@xenoblade/contracts";

import type { EnvConfig } from "./env";
import { clearContext, memoryOp, settingsOp } from "./ai-client";
import { containerIdFromMessage } from "./conversation-scope";
import { postReply } from "./output";

const HELP_TEXT = [
  "Xenoblade DM 控制台。可用命令：",
  "",
  "/persona show — 查看你的全部人设记忆",
  "/persona set <key> <value> — 设置一条人设记忆",
  "/persona clear [key] — 清除人设记忆（可指定 key）",
  "",
  "/preference list — 查看你的偏好",
  "/preference set <key> <value> — 设置一条偏好",
  "/preference clear [key] — 清除偏好（可指定 key）",
  "",
  "/memory show — 查看全部记忆",
  "/memory clear — 清除全部记忆",
  "",
  "/chat on|off — 开启/关闭私聊对话（默认关闭）",
  "/learn on|off — 开启/关闭自动记忆学习（默认关闭）",
  "/help — 显示此帮助",
].join("\n");

const GENERIC_ERROR_REPLY = "命令执行失败，请稍后重试。";
const MEMORY_ERROR_REPLY = "读取记忆失败，请稍后重试。";

/**
 * Route a DM message. Control-plane commands ALWAYS take routing priority
 * (ADR-011 §2). Non-command text reaches the AI generation pipeline — via
 * `enqueueGeneration` — only for chat-opted-in users; everyone else gets the
 * help message.
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

  const content = message.content.trim();
  const tokens = content.split(/\s+/);
  const command = (tokens[0] ?? "").toLowerCase();

  try {
    switch (command) {
      case "/help":
        await postReply(channel, HELP_TEXT);
        return;
      case "/persona":
        await handleCategoryCommand(message, channel, env, "persona", tokens);
        return;
      case "/preference":
        await handleCategoryCommand(message, channel, env, "preference", tokens);
        return;
      case "/memory":
        await handleMemoryCommand(message, channel, env, tokens);
        return;
      case "/chat":
        await handleChatCommand(message, env, tokens);
        return;
      case "/learn":
        await handleLearnCommand(message, env, tokens);
        return;
      default:
        // Non-command DM text → generation for opted-in users, else help.
        if (await isChatOptedIn(message.author.id, env)) {
          enqueueGeneration(message);
          return;
        }
        await postReply(channel, HELP_TEXT);
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
    await safeReply(message, GENERIC_ERROR_REPLY);
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
): Promise<void> {
  const userId = message.author.id;
  const sub = (tokens[1] ?? "").toLowerCase();
  const label = categoryLabel(category);

  if (sub === "show" || sub === "list") {
    const response = await memoryOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
    const memories = filterMemories(response, category);
    await postReply(channel, formatMemories(label, memories));
    return;
  }

  if (sub === "set") {
    const key = tokens[2];
    const value = tokens.slice(3).join(" ").trim();
    if (!key || value === "") {
      await safeReply(message, `用法：/${category} set <key> <value>`);
      return;
    }
    const response = await memoryOp(
      { op: "set", userId, category, key, value },
      env.workerUrl,
      env.internalApiToken,
    );
    await safeReply(
      message,
      response.status === "ok" ? `已设置${label}记忆：${key}` : MEMORY_ERROR_REPLY,
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
      response.status === "ok" ? `已清除${label}记忆。` : MEMORY_ERROR_REPLY,
    );
    return;
  }

  await safeReply(message, `未知子命令。用法：/${category} show|set|clear`);
}

/** Handle `/memory show` and `/memory clear` (all categories). */
async function handleMemoryCommand(
  message: Message,
  channel: SendableChannels,
  env: EnvConfig,
  tokens: string[],
): Promise<void> {
  const userId = message.author.id;
  const sub = (tokens[1] ?? "").toLowerCase();

  if (sub === "show") {
    const response = await memoryOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
    const memories = response.status === "ok" ? response.memories : [];
    await postReply(channel, formatAllMemories(memories));
    return;
  }

  if (sub === "clear") {
    const response = await memoryOp({ op: "clear", userId }, env.workerUrl, env.internalApiToken);
    await safeReply(message, response.status === "ok" ? "已清除全部记忆。" : MEMORY_ERROR_REPLY);
    return;
  }

  await safeReply(message, "未知子命令。用法：/memory show|clear");
}

/**
 * Handle `/chat on|off` — toggle the DM chat opt-in (ADR-011). Opting out also
 * resets the user's DM conversation context.
 */
async function handleChatCommand(
  message: Message,
  env: EnvConfig,
  tokens: string[],
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
      await safeReply(message, GENERIC_ERROR_REPLY);
      return;
    }
    if (enable) {
      await safeReply(
        message,
        "已开启私聊对话。现在直接发消息即可与我对话，/chat off 可随时关闭。",
      );
      return;
    }

    // Opting out also resets the DM conversation context (ADR-011 §3),
    // best-effort: a failed clear is surfaced with a /clear-context hint.
    let clearNote = "，并已清除 DM 对话上下文。";
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
        clearNote = "。清除 DM 对话上下文失败，可用 /clear-context 重试。";
      }
    } catch {
      clearNote = "。清除 DM 对话上下文失败，可用 /clear-context 重试。";
    }
    await safeReply(message, `已关闭私聊对话${clearNote}`);
    return;
  }

  const state = await optinState(message, env, "chat");
  await safeReply(message, `私聊对话当前${state}。用法：/chat on|off`);
}

/** Handle `/learn on|off` — toggle the auto-memory opt-in (ADR-012). */
async function handleLearnCommand(
  message: Message,
  env: EnvConfig,
  tokens: string[],
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
      await safeReply(message, GENERIC_ERROR_REPLY);
      return;
    }
    await safeReply(
      message,
      sub === "on"
        ? "已开启自动学习。开启后仅从你在服务器频道的对话中提取记忆候选，并经你确认后保存（功能上线后生效）。"
        : "已关闭自动学习。",
    );
    return;
  }

  const state = await optinState(message, env, "learn");
  await safeReply(message, `自动学习当前${state}。用法：/learn on|off`);
}

/** Resolve the current on/off label for an opt-in flag; "未知" on read failure. */
async function optinState(
  message: Message,
  env: EnvConfig,
  flag: "chat" | "learn",
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
    return on ? "已开启" : "未开启";
  } catch {
    return "状态未知";
  }
}

/** Filter a get-response to a single category; empty on error. */
function filterMemories(response: MemoryResponse, category: MemoryCategory): UserMemory[] {
  return response.status === "ok"
    ? response.memories.filter((memory) => memory.category === category)
    : [];
}

function formatMemories(label: string, memories: UserMemory[]): string {
  if (memories.length === 0) return `没有${label}记忆。`;
  const lines = memories.map((memory) => `- ${memory.key}: ${memory.value}`);
  return `${label}记忆：\n${lines.join("\n")}`;
}

function formatAllMemories(memories: UserMemory[]): string {
  if (memories.length === 0) return "没有任何记忆。";
  const lines = memories.map((memory) => `- [${memory.category}] ${memory.key}: ${memory.value}`);
  return `全部记忆：\n${lines.join("\n")}`;
}

function categoryLabel(category: MemoryCategory): string {
  return category === "persona" ? "人设" : "偏好";
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
