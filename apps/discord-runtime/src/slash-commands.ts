import type { EnvConfig } from "./env";

/**
 * Global slash command definitions registered with Discord on startup.
 *
 * Command NAMES are always English (deliberate; they are also the canonical
 * identifiers the code matches on). DESCRIPTIONS carry zh-CN localizations and
 * render per each user's Discord client locale.
 */
export const SLASH_COMMANDS = [
  {
    name: "status",
    description: "Check Xenoblade gateway status",
    description_localizations: { "zh-CN": "检查 Xenoblade 网关状态" },
  },
  {
    name: "context",
    description: "Manage which past messages the bot references in this channel",
    description_localizations: { "zh-CN": "管理机器人参考的历史消息范围" },
    options: [
      {
        type: 1,
        name: "truncate",
        description: "Stop referencing messages before now (undoable)",
        description_localizations: { "zh-CN": "从现在起不再参考之前的消息（可撤销）" },
      },
      {
        type: 1,
        name: "restore",
        description: "Undo the latest truncation in this channel",
        description_localizations: { "zh-CN": "撤销此频道最近一次截断" },
      },
    ],
  },
  {
    name: "usage",
    description: "Show your 24h usage and token summary",
    description_localizations: { "zh-CN": "查看你最近 24 小时的用量与 Token 统计" },
  },
  {
    name: "language",
    description: "Switch the language of bot notices (chat replies stay automatic)",
    description_localizations: { "zh-CN": "切换提示语言（聊天回复语言始终自动跟随对话）" },
    options: [
      {
        type: 3,
        name: "value",
        description: "Notice language",
        required: true,
        description_localizations: { "zh-CN": "提示语言" },
        choices: [
          { name: "中文", value: "zh" },
          { name: "English", value: "en" },
        ],
      },
    ],
  },
  {
    name: "persona",
    description: "Manage your persona memories (how you describe yourself to the bot)",
    description_localizations: { "zh-CN": "管理你的人设记忆（你希望机器人如何了解你）" },
    options: [
      {
        type: 1,
        name: "show",
        description: "List all your persona memories",
        description_localizations: { "zh-CN": "查看你的全部人设记忆" },
      },
      {
        type: 1,
        name: "set",
        description: "Set one persona memory",
        description_localizations: { "zh-CN": "设置一条人设记忆" },
        options: [
          {
            type: 3,
            name: "key",
            description: "Memory key",
            required: true,
            description_localizations: { "zh-CN": "记忆键名" },
          },
          {
            type: 3,
            name: "value",
            description: "Memory content",
            required: true,
            description_localizations: { "zh-CN": "记忆内容" },
          },
        ],
      },
      {
        type: 1,
        name: "clear",
        description: "Clear persona memories (optionally one key)",
        description_localizations: { "zh-CN": "清除人设记忆（可指定键名）" },
        options: [
          {
            type: 3,
            name: "key",
            description: "Only clear this key",
            required: false,
            description_localizations: { "zh-CN": "仅清除该键名" },
          },
        ],
      },
    ],
  },
  {
    name: "preference",
    description: "Manage your preference memories (how the bot should behave)",
    description_localizations: { "zh-CN": "管理你的偏好记忆（希望机器人的行为方式）" },
    options: [
      {
        type: 1,
        name: "list",
        description: "List your preferences",
        description_localizations: { "zh-CN": "查看你的偏好" },
      },
      {
        type: 1,
        name: "set",
        description: "Set one preference",
        description_localizations: { "zh-CN": "设置一条偏好" },
        options: [
          {
            type: 3,
            name: "key",
            description: "Preference key",
            required: true,
            description_localizations: { "zh-CN": "偏好键名" },
          },
          {
            type: 3,
            name: "value",
            description: "Preference content",
            required: true,
            description_localizations: { "zh-CN": "偏好内容" },
          },
        ],
      },
      {
        type: 1,
        name: "clear",
        description: "Clear preferences (optionally one key)",
        description_localizations: { "zh-CN": "清除偏好（可指定键名）" },
        options: [
          {
            type: 3,
            name: "key",
            description: "Only clear this key",
            required: false,
            description_localizations: { "zh-CN": "仅清除该键名" },
          },
        ],
      },
    ],
  },
  {
    name: "memory",
    description: "View or clear everything the bot remembers about you",
    description_localizations: { "zh-CN": "查看或清除机器人对你的全部记忆" },
    options: [
      {
        type: 1,
        name: "show",
        description: "Show all memories",
        description_localizations: { "zh-CN": "查看全部记忆" },
      },
      {
        type: 1,
        name: "clear",
        description: "Clear all memories",
        description_localizations: { "zh-CN": "清除全部记忆" },
      },
    ],
  },
  {
    name: "chat",
    description: "Toggle DM chat with the bot (DMs only)",
    description_localizations: { "zh-CN": "开关与机器人的私聊对话（仅限私聊）" },
    options: [
      {
        type: 3,
        name: "value",
        description: "Enable or disable DM chat; omit to show the current state",
        required: false,
        description_localizations: { "zh-CN": "开启或关闭私聊；不填则查看当前状态" },
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
        ],
      },
    ],
  },
  {
    name: "learn",
    description: "Toggle auto memory learning (DM console)",
    description_localizations: { "zh-CN": "开关自动记忆学习（私聊控制台）" },
    options: [
      {
        type: 3,
        name: "value",
        description: "Enable or disable learning; omit to show the current state",
        required: false,
        description_localizations: { "zh-CN": "开启或关闭；不填则查看当前状态" },
        choices: [
          { name: "on", value: "on" },
          { name: "off", value: "off" },
        ],
      },
    ],
  },
  {
    name: "help",
    description: "Show what Xenoblade can do",
    description_localizations: { "zh-CN": "查看 Xenoblade 的功能说明" },
  },
] as const;

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Shape of the injectable registrar (tests substitute a fake). */
export interface CommandRegistrar {
  put(route: string, options: { body: unknown }): Promise<unknown>;
}

/**
 * Register the global slash commands (idempotent, best-effort). A registration
 * failure is logged, never fatal — the client stays up and retries on next
 * start. The default registrar PUTs via plain fetch so the body is sent
 * verbatim with no library transformation.
 *
 * Verification note: Discord's GET /applications/{id}/commands OMITS
 * `description_localizations` unless called with `?with_localizations=true`.
 * A bare GET showing no localizations is NOT evidence of a stripped or failed
 * registration — do not re-diagnose from it.
 */
export async function registerSlashCommands(
  env: EnvConfig,
  put: CommandRegistrar["put"] = async (route, options) => {
    const response = await fetch(`${DISCORD_API_BASE}${route}`, {
      method: "PUT",
      headers: {
        Authorization: `Bot ${env.discordBotToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(options.body),
    });
    if (!response.ok) {
      throw new Error(`Discord API ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
    return response.json();
  },
): Promise<void> {
  try {
    await put(`/applications/${env.discordApplicationId}/commands`, {
      body: SLASH_COMMANDS,
    });
    console.log(JSON.stringify({ event: "slash_commands_registered" }));
  } catch (error) {
    console.log(JSON.stringify({ event: "slash_register_error", error: String(error) }));
  }
}
