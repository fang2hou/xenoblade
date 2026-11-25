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
  askConfirm: {
    contextNote: (note: string) => `补充：${note}`,
    options: (labels: readonly string[]) => `[可选项] ${labels.join(" / ")}`,
    footer: "点击选项继续，也可以直接回复。",
    chosen: (label: string) => `[确认选择]: ${label}`,
    notOwner: "只有被提问的用户可以选择。",
    expiredNotice: "该提问已失效（机器人可能已重启或已超时），请直接回复。",
    busy: "正在处理你的选择，请稍候。",
  },
  thread: {
    defaultTitle: "与 Xenoblade 的讨论",
  },
  interaction: {
    unknownControl: "该按钮已失效。",
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
    header: (count: number) => `确实要更新本服务器的全局记忆吗？共 ${count} 项：`,
    headerDelete: (count: number) => `确实要删除本服务器的全局记忆吗？共 ${count} 项：`,
    entry: (index: number, action: string, category: string) =>
      `[${index}] ${action} · 类别：${category}`,
    key: (index: number, key: string) => `[${index}] 键：${key}`,
    value: (index: number, value: string) => `[${index}] 值：${value}`,
    actionSave: "保存",
    actionDelete: "删除",
    footer: "点击后才会生效（5 分钟内有效）。",
    escapeNote: "字段里的 \\n 表示换行，\\t 表示制表符，\\u{…} 表示其他不可见字符。",
    attachmentNote:
      "列表放不进一条消息，完整内容见附件 guild-memory-proposal.txt（确认后按附件里的内容原样执行）。",
    yes: "是",
    no: "不是",
    saved: "✅ 已更新本服务器的全局记忆。",
    savedPartial: (ok: number, total: number) => `部分更新成功（${ok}/${total}），其余请稍后重试。`,
    full: "本服务器的全局记忆条数已达上限（100 条），请先删除一些再试。",
    nothingToDelete: "没有找到要删除的记忆，本服务器的全局记忆未修改。",
    cancelled: "已取消，本服务器的全局记忆未修改。",
    expired: "⏱️ 未及时确认，本服务器的全局记忆未修改。",
    failed: "更新本服务器的全局记忆失败，请稍后重试。",
    notOwner: "只有发起这次全局记忆修改的用户可以确认。",
    busy: "正在更新全局记忆，请稍候。",
    expiredNotice: "该确认已失效（机器人可能已重启或已超时）。",
    labelFact: "事实",
    labelPreference: "偏好",
    labelBothCategories: "事实和偏好",
  },
  soulConfirm: {
    header: "确实要更新本服务器的助手人设（soul）吗？",
    summary: (summary: string) => `变更摘要：${summary}`,
    fullContent: "新的人设全文（确认后原样保存）：",
    attachmentNote:
      "全文放不进一条消息，完整内容见附件 soul-proposal.txt（确认后原样保存附件里的内容）。",
    footer: "点击后才会生效（5 分钟内有效）。",
    yes: "是",
    no: "不是",
    applied: "✅ 已更新本服务器的助手人设（soul）。",
    cancelled: "已取消，人设未修改。",
    expired: "⏱️ 未及时确认，人设未修改。",
    failed: "更新人设失败，请稍后重试。",
    notOwner: "只有发起这次人设修改的用户可以确认。",
    busy: "正在更新人设，请稍候。",
    expiredNotice: "该确认已失效（机器人可能已重启或已超时）。",
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
      '也可以在对话中直接说"帮我记住…"/"忘掉…"，个人记忆会立即写入。',
      "",
      "/chat on|off — 开启/关闭私聊对话（默认关闭，仅限私聊使用）",
      "/learn on|off — 开启/关闭自动记忆学习（默认关闭）",
      "/context truncate|restore — 管理机器人参考的历史消息范围",
      "/language — 切换提示语言",
      "/help — 显示此帮助",
    ].join("\n"),
    genericError: "命令执行失败，请稍后重试。",
    memoryError: "读取记忆失败，请稍后重试。",
    memoryFull:
      "个人记忆条数已达上限（50 条），请先用 /preference clear 或 /memory clear 清理后再试。",
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
  askConfirm: {
    contextNote: (note: string) => string;
    options: (labels: readonly string[]) => string;
    footer: string;
    chosen: (label: string) => string;
    notOwner: string;
    expiredNotice: string;
    busy: string;
  };
  thread: { defaultTitle: string };
  interaction: { unknownControl: string };
  stagedMilestones: readonly string[];
  context: {
    truncateSuccess: string;
    truncateFailure: string;
    restoreSuccess: (remaining: number) => string;
    restoreNone: string;
    restoreFailure: string;
  };
  memoryConfirm: {
    header: (count: number) => string;
    headerDelete: (count: number) => string;
    entry: (index: number, action: string, category: string) => string;
    key: (index: number, key: string) => string;
    value: (index: number, value: string) => string;
    actionSave: string;
    actionDelete: string;
    footer: string;
    escapeNote: string;
    attachmentNote: string;
    yes: string;
    no: string;
    saved: string;
    savedPartial: (ok: number, total: number) => string;
    full: string;
    nothingToDelete: string;
    cancelled: string;
    expired: string;
    failed: string;
    notOwner: string;
    busy: string;
    expiredNotice: string;
    labelFact: string;
    labelPreference: string;
    labelBothCategories: string;
  };
  soulConfirm: {
    header: string;
    summary: (summary: string) => string;
    fullContent: string;
    attachmentNote: string;
    footer: string;
    yes: string;
    no: string;
    applied: string;
    cancelled: string;
    expired: string;
    failed: string;
    notOwner: string;
    busy: string;
    expiredNotice: string;
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
    memoryFull: string;
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
  askConfirm: {
    contextNote: (note: string) => `Note: ${note}`,
    options: (labels: readonly string[]) => `[Options] ${labels.join(" / ")}`,
    footer: "Click an option to continue, or just reply.",
    chosen: (label: string) => `[Choice]: ${label}`,
    notOwner: "Only the user who was asked can choose.",
    expiredNotice:
      "This question has expired (the bot may have restarted or timed out) — please just reply.",
    busy: "Your choice is already being processed — please wait.",
  },
  thread: {
    defaultTitle: "Discussion with Xenoblade",
  },
  interaction: {
    unknownControl: "This button no longer works.",
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
    header: (count: number) =>
      count === 1
        ? "Update this server's shared memory? 1 change:"
        : `Update this server's shared memory? ${count} changes:`,
    headerDelete: (count: number) =>
      count === 1
        ? "Delete from this server's shared memory? 1 change:"
        : `Delete from this server's shared memory? ${count} changes:`,
    entry: (index: number, action: string, category: string) =>
      `[${index}] ${action} · category: ${category}`,
    key: (index: number, key: string) => `[${index}] key: ${key}`,
    value: (index: number, value: string) => `[${index}] value: ${value}`,
    actionSave: "Save",
    actionDelete: "Delete",
    footer: "Nothing changes until you choose (valid for 5 minutes).",
    escapeNote: "\\n marks a line break, \\t a tab, and \\u{…} another invisible character.",
    attachmentNote:
      "The full list is too long to show here. It is attached as guild-memory-proposal.txt and will be applied exactly as shown in that file.",
    yes: "Yes",
    no: "No",
    saved: "✅ This server's shared memory was updated.",
    savedPartial: (ok: number, total: number) =>
      `Partially updated (${ok}/${total}); please retry the rest later.`,
    full: "This server's shared memory is full (100 entries); remove some entries first.",
    nothingToDelete: "Nothing was found to delete — the server's shared memory was not changed.",
    cancelled: "Cancelled — the server's shared memory was not changed.",
    expired: "⏱️ Not confirmed in time — the server's shared memory was not changed.",
    failed: "Failed to update the server's shared memory. Please try again later.",
    notOwner: "Only the user who requested this change can confirm it.",
    busy: "The memory update is already in progress — please wait.",
    expiredNotice: "This confirmation has expired (the bot may have restarted or timed out).",
    labelFact: "fact",
    labelPreference: "preference",
    labelBothCategories: "fact and preference",
  },
  soulConfirm: {
    header: "Update this server's assistant persona (soul)?",
    summary: (summary: string) => `Change: ${summary}`,
    fullContent: "Full new soul (saved exactly as shown):",
    attachmentNote:
      "The full text is too long to show here. It is attached as soul-proposal.txt and will be saved exactly as shown in that file.",
    footer: "Nothing changes until you choose (valid for 5 minutes).",
    yes: "Yes",
    no: "No",
    applied: "✅ Persona (soul) updated for this server.",
    cancelled: "Cancelled — the persona was not changed.",
    expired: "⏱️ Not confirmed in time — the persona was not changed.",
    failed: "Failed to update the persona. Please try again later.",
    notOwner: "Only the user who requested this change can confirm it.",
    busy: "The persona update is already in progress — please wait.",
    expiredNotice: "This confirmation has expired (the bot may have restarted or timed out).",
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
      'You can also just say "remember…" / "forget…" in chat; personal memories are saved right away.',
      "",
      "/chat on|off — enable/disable DM chat (off by default, DMs only)",
      "/learn on|off — enable/disable auto memory learning (off by default)",
      "/context truncate|restore — manage which past messages the bot references",
      "/language — switch notice language",
      "/help — show this help",
    ].join("\n"),
    genericError: "Command failed. Please try again later.",
    memoryError: "Failed to read memories. Please try again later.",
    memoryFull:
      "Your personal memory is full (50 entries); clear some with /preference clear or /memory clear first.",
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
