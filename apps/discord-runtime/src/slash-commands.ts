import { REST, Routes } from "discord.js";

import type { EnvConfig } from "./env";

/** Global slash command definitions registered with Discord on startup. */
export const SLASH_COMMANDS = [
  {
    name: "status",
    description: "Check Xenoblade gateway status",
    name_localizations: { "zh-CN": "状态" },
    description_localizations: { "zh-CN": "检查 Xenoblade 网关状态" },
  },
  {
    name: "clear-context",
    description: "Clear your conversation context in this channel",
    name_localizations: { "zh-CN": "清除上下文" },
    description_localizations: { "zh-CN": "清除你在此频道的对话上下文" },
  },
  {
    name: "usage",
    description: "Show your 24h usage and token summary",
    name_localizations: { "zh-CN": "用量" },
    description_localizations: { "zh-CN": "查看你最近 24 小时的用量与 Token 统计" },
  },
  {
    name: "language",
    description: "Switch the language of bot notices (chat replies stay automatic)",
    name_localizations: { "zh-CN": "语言" },
    description_localizations: { "zh-CN": "切换提示语言（聊天回复语言始终自动跟随对话）" },
    options: [
      {
        name: "value",
        description: "Notice language",
        required: true,
        name_localizations: { "zh-CN": "选项" },
        description_localizations: { "zh-CN": "提示语言" },
        choices: [
          { name: "中文", value: "zh" },
          { name: "English", value: "en" },
        ],
      },
    ],
  },
] as const;

/**
 * Register the global slash commands (idempotent, best-effort). A registration
 * failure is logged, never fatal — the client stays up and retries on next
 * start. `rest` is injectable for tests.
 */
export async function registerSlashCommands(
  env: EnvConfig,
  rest: Pick<REST, "put"> = new REST({ version: "10" }).setToken(env.discordBotToken),
): Promise<void> {
  try {
    await rest.put(Routes.applicationCommands(env.discordApplicationId), {
      body: SLASH_COMMANDS,
    });
    console.log(JSON.stringify({ event: "slash_commands_registered" }));
  } catch (error) {
    console.log(JSON.stringify({ event: "slash_register_error", error: String(error) }));
  }
}
