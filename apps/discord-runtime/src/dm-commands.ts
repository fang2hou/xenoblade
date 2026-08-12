import type { Message, SendableChannels } from "discord.js";
import type { MemoryCategory, MemoryResponse, UserMemory } from "@xenoblade/contracts";

import type { EnvConfig } from "./env";
import { memoryOp } from "./ai-client";
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
  "/help — 显示此帮助",
].join("\n");

const GENERIC_ERROR_REPLY = "命令执行失败，请稍后重试。";
const MEMORY_ERROR_REPLY = "读取记忆失败，请稍后重试。";

/**
 * Route a DM message to the control-plane command handler. DMs NEVER reach the
 * AI generation pipeline. Unknown commands and plain DM text reply with help.
 */
export async function handleDmMessage(message: Message, env: EnvConfig): Promise<void> {
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
      default:
        // Non-command DM text → help, no AI call.
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
