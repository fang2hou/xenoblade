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
  replyControls: {
    regenerate: "重新生成",
    notOwner: "只有发起这条消息的用户可以操作。",
    expired: "该操作已失效（机器人可能已重启）。",
    busy: "正在重新生成，请稍候。",
  },
  stagedMilestones: [
    "还在处理中…",
    "仍在生成中，请稍候…",
    "这次生成比较复杂，仍在处理…",
    "仍在处理中，感谢耐心等待…",
  ],
  context: {
    truncateSuccess: "已截断：此时间点之前的消息不再纳入参考。可用 /context restore 撤销。",
    truncateFailure: "截断失败，请稍后重试。",
    restoreSuccess: (remaining: number) =>
      remaining > 0
        ? `已撤销最近一次截断，更早的消息重新纳入参考。还可撤销 ${remaining} 次。`
        : "已撤销最近一次截断，更早的消息重新纳入参考。",
    restoreNone: "当前没有可撤销的截断。",
    restoreFailure: "撤销截断失败，请稍后重试。",
  },
  memoryConfirm: {
    header: "我准备更新对你的记忆：",
    saveLine: (label: string, key: string, value: string) => `＋ ${label} · ${key}：${value}`,
    forgetLine: (label: string | null, key: string) =>
      label === null ? `－ ${key}` : `－ ${label} · ${key}`,
    footer: "回复 ✅ 保存，❌ 取消（5 分钟内有效）。",
    saved: "✅ 已保存到记忆。",
    savedPartial: (ok: number, total: number) => `部分保存成功（${ok}/${total}），其余请稍后重试。`,
    full: "记忆条数已达上限（50 条），请先用 /memory clear 清理后再试。",
    cancelled: "已取消，未修改记忆。",
    expired: "⏱️ 未及时确认，本次未修改记忆。",
    failed: "保存失败，请稍后重试。",
    labelFact: "事实",
    labelPreference: "偏好",
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
      "Xenoblade 控制台。可用命令（均为 Discord 原生斜杠命令）：",
      "",
      "/persona show · set · clear — 管理你的人设记忆",
      "/preference list · set · clear — 管理你的偏好",
      "/memory show · clear — 查看或清除全部记忆",
      "",
      '也可以在对话中直接说"帮我记住…"/"忘掉…"，确认后即写入记忆。',
      "",
      "/chat on|off — 开启/关闭私聊对话（默认关闭，仅限私聊使用）",
      "/learn on|off — 开启/关闭自动记忆学习（默认关闭）",
      "/context truncate|restore — 管理机器人参考的历史消息范围",
      "/language — 切换提示语言",
      "/help — 显示此帮助",
    ].join("\n"),
    genericError: "命令执行失败，请稍后重试。",
    memoryError: "读取记忆失败，请稍后重试。",
    memorySet: (label: string, key: string) => `已设置${label}记忆：${key}`,
    memoryCleared: (label: string) => `已清除${label}记忆。`,
    allMemoriesCleared: "已清除全部记忆。",
    chatDmOnly: "此命令仅在私聊中可用。",
    chatOn: "已开启私聊对话。现在直接发消息即可与我对话，/chat off 可随时关闭。",
    chatOffClearOk: "，并已清除 DM 对话上下文。",
    chatOffClearFailed: "。清除 DM 对话上下文失败，可用 /context truncate 重试。",
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
  replyControls: {
    regenerate: string;
    notOwner: string;
    expired: string;
    busy: string;
  };
  stagedMilestones: readonly string[];
  context: {
    truncateSuccess: string;
    truncateFailure: string;
    restoreSuccess: (remaining: number) => string;
    restoreNone: string;
    restoreFailure: string;
  };
  memoryConfirm: {
    header: string;
    saveLine: (label: string, key: string, value: string) => string;
    forgetLine: (label: string | null, key: string) => string;
    footer: string;
    saved: string;
    savedPartial: (ok: number, total: number) => string;
    full: string;
    cancelled: string;
    expired: string;
    failed: string;
    labelFact: string;
    labelPreference: string;
  };
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
    memorySet: (label: string, key: string) => string;
    memoryCleared: (label: string) => string;
    allMemoriesCleared: string;
    chatDmOnly: string;
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
  replyControls: {
    regenerate: "Regenerate",
    notOwner: "Only the user who triggered this reply can control it.",
    expired: "This control has expired (the bot may have restarted).",
    busy: "A regeneration is already running — please wait.",
  },
  stagedMilestones: [
    "Still working…",
    "Still generating, please hold on…",
    "This one is taking longer than usual…",
    "Still working — thanks for your patience…",
  ],
  context: {
    truncateSuccess:
      "Truncated: messages before this point are no longer referenced. Undo anytime with /context restore.",
    truncateFailure: "Failed to truncate. Please try again later.",
    restoreSuccess: (remaining: number) =>
      remaining > 0
        ? `Undid the latest truncation; earlier messages are referenced again. ${remaining} more undo(s) available.`
        : "Undid the latest truncation; earlier messages are referenced again.",
    restoreNone: "There is no truncation to undo right now.",
    restoreFailure: "Failed to undo the truncation. Please try again later.",
  },
  memoryConfirm: {
    header: "I'd like to update what I remember about you:",
    saveLine: (label: string, key: string, value: string) => `+ ${label} · ${key}: ${value}`,
    forgetLine: (label: string | null, key: string) =>
      label === null ? `- ${key}` : `- ${label} · ${key}`,
    footer: "React ✅ to save or ❌ to cancel (valid for 5 minutes).",
    saved: "✅ Saved to memory.",
    savedPartial: (ok: number, total: number) =>
      `Partially saved (${ok}/${total}); please retry the rest later.`,
    full: "Your memory is full (50 entries); clear some with /memory clear first.",
    cancelled: "Cancelled — nothing was changed.",
    expired: "⏱️ Not confirmed in time — nothing was changed.",
    failed: "Failed to save. Please try again later.",
    labelFact: "fact",
    labelPreference: "preference",
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
      "Xenoblade console. Available commands (native Discord slash commands):",
      "",
      "/persona show · set · clear — manage your persona memories",
      "/preference list · set · clear — manage your preferences",
      "/memory show · clear — show or clear all memories",
      "",
      'You can also just say "remember…" / "forget…" in chat; it\'s saved after you confirm.',
      "",
      "/chat on|off — enable/disable DM chat (off by default, DMs only)",
      "/learn on|off — enable/disable auto memory learning (off by default)",
      "/context truncate|restore — manage which past messages the bot references",
      "/language — switch notice language",
      "/help — show this help",
    ].join("\n"),
    genericError: "Command failed. Please try again later.",
    memoryError: "Failed to read memories. Please try again later.",
    memorySet: (label: string, key: string) => `Set ${label} memory: ${key}`,
    memoryCleared: (label: string) => `Cleared ${label} memories.`,
    allMemoriesCleared: "Cleared all memories.",
    chatDmOnly: "This command is only available in DMs.",
    chatOn: "DM chat enabled. Just send a message to talk to me; /chat off disables it anytime.",
    chatOffClearOk: " and cleared the DM conversation context.",
    chatOffClearFailed: ". Failed to clear the DM context; retry with /context truncate.",
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
