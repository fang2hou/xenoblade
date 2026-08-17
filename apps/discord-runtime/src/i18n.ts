import type { UiLanguage } from "@xenoblade/contracts";

import type { StatusMilestone } from "./staged-status";

/**
 * UI string tables for runtime-rendered notices. Chat (generation) replies are
 * NOT localized here — they always follow the conversation language.
 *
 * `zh` is the source of truth for the table shape; `en` must match it
 * (asserted by `satisfies` and a parity test).
 */
const zh = {
  status: {
    ok: "Xenoblade 网关运行正常。",
  },
  generation: {
    failure: "这次处理失败了，请稍后重试。",
    rateLimited: "请求过于频繁，请稍后再试。",
  },
  stagedMilestones: [
    "还在处理中…",
    "仍在生成中，请稍候…",
    "这次生成比较复杂，仍在处理…",
    "仍在处理中，感谢耐心等待…",
  ],
  clearContext: {
    success: "已清除你在此频道的对话上下文。",
    failure: "清除上下文失败，请稍后重试。",
  },
  usage: {
    failure: "加载用量统计失败，请稍后重试。",
    you: (hours: number) => `**你 — 最近 ${hours} 小时**`,
    server: (hours: number) => `**服务器 — 最近 ${hours} 小时**`,
    generations: "生成次数",
    messages: "消息数",
    tokens: "Token",
    cacheRead: "缓存读",
    cacheWrite: "缓存写",
    topTools: "常用工具",
  },
  language: {
    set: "提示语言已切换为中文。（聊天回复语言始终自动跟随对话）",
    failure: "切换语言失败，请稍后重试。",
    invalid: "无效的语言选项。",
  },
  dm: {
    help: [
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
    ].join("\n"),
    genericError: "命令执行失败，请稍后重试。",
    memoryError: "读取记忆失败，请稍后重试。",
    categoryUsage: (category: string) => `用法：/${category} set <key> <value>`,
    memorySet: (label: string, key: string) => `已设置${label}记忆：${key}`,
    memoryCleared: (label: string) => `已清除${label}记忆。`,
    unknownSubCategory: (category: string) => `未知子命令。用法：/${category} show|set|clear`,
    unknownSubMemory: "未知子命令。用法：/memory show|clear",
    allMemoriesCleared: "已清除全部记忆。",
    chatOn: "已开启私聊对话。现在直接发消息即可与我对话，/chat off 可随时关闭。",
    chatOffClearOk: "，并已清除 DM 对话上下文。",
    chatOffClearFailed: "。清除 DM 对话上下文失败，可用 /clear-context 重试。",
    chatOffPrefix: "已关闭私聊对话",
    chatState: (state: string) => `私聊对话当前${state}。用法：/chat on|off`,
    learnOn:
      "已开启自动学习。开启后仅从你在服务器频道的对话中提取记忆候选，并经你确认后保存（功能上线后生效）。",
    learnOff: "已关闭自动学习。",
    learnState: (state: string) => `自动学习当前${state}。用法：/learn on|off`,
    stateOn: "已开启",
    stateOff: "未开启",
    stateUnknown: "状态未知",
    noCategoryMemories: (label: string) => `没有${label}记忆。`,
    categoryMemoriesHeader: (label: string) => `${label}记忆：`,
    noMemories: "没有任何记忆。",
    allMemoriesHeader: "全部记忆：",
    personaLabel: "人设",
    preferenceLabel: "偏好",
  },
} as const;

export type Messages = {
  status: { ok: string };
  generation: { failure: string; rateLimited: string };
  stagedMilestones: readonly string[];
  clearContext: { success: string; failure: string };
  usage: {
    failure: string;
    you: (hours: number) => string;
    server: (hours: number) => string;
    generations: string;
    messages: string;
    tokens: string;
    cacheRead: string;
    cacheWrite: string;
    topTools: string;
  };
  language: { set: string; failure: string; invalid: string };
  dm: {
    help: string;
    genericError: string;
    memoryError: string;
    categoryUsage: (category: string) => string;
    memorySet: (label: string, key: string) => string;
    memoryCleared: (label: string) => string;
    unknownSubCategory: (category: string) => string;
    unknownSubMemory: string;
    allMemoriesCleared: string;
    chatOn: string;
    chatOffClearOk: string;
    chatOffClearFailed: string;
    chatOffPrefix: string;
    chatState: (state: string) => string;
    learnOn: string;
    learnOff: string;
    learnState: (state: string) => string;
    stateOn: string;
    stateOff: string;
    stateUnknown: string;
    noCategoryMemories: (label: string) => string;
    categoryMemoriesHeader: (label: string) => string;
    noMemories: string;
    allMemoriesHeader: string;
    personaLabel: string;
    preferenceLabel: string;
  };
};

const en: Messages = {
  status: {
    ok: "Xenoblade Gateway OK",
  },
  generation: {
    failure: "That request failed. Please try again later.",
    rateLimited: "You're sending requests too fast — please wait a moment.",
  },
  stagedMilestones: [
    "Still working…",
    "Still generating, please hold on…",
    "This one is taking longer than usual…",
    "Still working — thanks for your patience…",
  ],
  clearContext: {
    success: "Cleared your conversation context in this channel.",
    failure: "Failed to clear the context. Please try again later.",
  },
  usage: {
    failure: "Failed to load the usage summary. Please try again later.",
    you: (hours: number) => `**You — last ${hours}h**`,
    server: (hours: number) => `**Server — last ${hours}h**`,
    generations: "Generations",
    messages: "Messages",
    tokens: "Tokens",
    cacheRead: "cache read",
    cacheWrite: "cache write",
    topTools: "Top tools",
  },
  language: {
    set: "Notice language switched to English. (Chat replies always follow the conversation.)",
    failure: "Failed to switch the language. Please try again later.",
    invalid: "Invalid language option.",
  },
  dm: {
    help: [
      "Xenoblade DM console. Available commands:",
      "",
      "/persona show — list all your persona memories",
      "/persona set <key> <value> — set one persona memory",
      "/persona clear [key] — clear persona memories (optionally one key)",
      "",
      "/preference list — list your preferences",
      "/preference set <key> <value> — set one preference",
      "/preference clear [key] — clear preferences (optionally one key)",
      "",
      "/memory show — show all memories",
      "/memory clear — clear all memories",
      "",
      "/chat on|off — enable/disable DM chat (off by default)",
      "/learn on|off — enable/disable auto memory learning (off by default)",
      "/help — show this help",
    ].join("\n"),
    genericError: "Command failed. Please try again later.",
    memoryError: "Failed to read memories. Please try again later.",
    categoryUsage: (category: string) => `Usage: /${category} set <key> <value>`,
    memorySet: (label: string, key: string) => `Set ${label} memory: ${key}`,
    memoryCleared: (label: string) => `Cleared ${label} memories.`,
    unknownSubCategory: (category: string) =>
      `Unknown subcommand. Usage: /${category} show|set|clear`,
    unknownSubMemory: "Unknown subcommand. Usage: /memory show|clear",
    allMemoriesCleared: "Cleared all memories.",
    chatOn: "DM chat enabled. Just send a message to talk to me; /chat off disables it anytime.",
    chatOffClearOk: " and cleared the DM conversation context.",
    chatOffClearFailed: ". Failed to clear the DM context; retry with /clear-context.",
    chatOffPrefix: "DM chat disabled",
    chatState: (state: string) => `DM chat is currently ${state}. Usage: /chat on|off`,
    learnOn:
      "Auto learning enabled. Memory candidates are extracted only from your server-channel conversations and saved after your confirmation (effective once the feature ships).",
    learnOff: "Auto learning disabled.",
    learnState: (state: string) => `Auto learning is currently ${state}. Usage: /learn on|off`,
    stateOn: "enabled",
    stateOff: "disabled",
    stateUnknown: "in an unknown state",
    noCategoryMemories: (label: string) => `No ${label} memories yet.`,
    categoryMemoriesHeader: (label: string) => `${label} memories:`,
    noMemories: "No memories at all.",
    allMemoriesHeader: "All memories:",
    personaLabel: "persona",
    preferenceLabel: "preference",
  },
};

/** The string table for each supported UI language. */
export const MESSAGES: Record<UiLanguage, Messages> = { zh, en };

/** Default UI language when a user has never chosen one. */
export const DEFAULT_UI_LANGUAGE: UiLanguage = "zh";

/** Resolve the string table for a language (unknown values fall back to zh). */
export function messages(language: UiLanguage): Messages {
  return MESSAGES[language] ?? MESSAGES[DEFAULT_UI_LANGUAGE];
}

/** Staged-status milestone ladder (ADR-003 amendment timings) for a language. */
export function stagedMilestones(language: UiLanguage): StatusMilestone[] {
  const texts = messages(language).stagedMilestones;
  const timings = [8_000, 20_000, 40_000, 90_000];
  return texts.map((text, index) => ({ afterMs: timings[index] ?? 90_000, text }));
}
