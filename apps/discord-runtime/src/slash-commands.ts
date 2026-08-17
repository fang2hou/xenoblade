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
    name: "clear-context",
    description: "Clear your conversation context in this channel",
    description_localizations: { "zh-CN": "清除你在此频道的对话上下文" },
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
] as const;

const DISCORD_API_BASE = "https://discord.com/api/v10";

/** Shape of the injectable registrar (tests substitute a fake). */
export interface CommandRegistrar {
  put(route: string, options: { body: unknown }): Promise<unknown>;
}

/**
 * Register the global slash commands (idempotent, best-effort). A registration
 * failure is logged, never fatal — the client stays up and retries on next
 * start. The default registrar PUTs via plain fetch: it must send the body
 * verbatim, and the discord.js REST layer was observed dropping
 * `description_localizations` from raw command payloads.
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
