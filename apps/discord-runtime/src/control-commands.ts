import type { ChatInputCommandInteraction } from "discord.js";
import type { MemoryCategory, MemoryResponse, UserMemory } from "@xenoblade/contracts";

import { clearContext, memoryOp, settingsOp } from "./ai-client";
import type { EnvConfig } from "./env";
import { messages } from "./i18n";
import { resolveUiLanguage } from "./language";

/**
 * Native slash-command handlers for the per-user control plane (ADR-005):
 * `/persona`, `/preference`, `/memory`, `/chat`, `/learn`, `/help`. These
 * replaced the DM text-command parser — the operations and Worker calls are
 * unchanged, only the entry surface is Discord-native now.
 */
export async function handleControlCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const command = interaction.commandName;
  if (command === "persona" || command === "preference") {
    await handleCategoryCommand(interaction, env, command);
    return;
  }
  if (command === "memory") {
    await handleMemoryCommand(interaction, env);
    return;
  }
  if (command === "chat") {
    await handleChatCommand(interaction, env);
    return;
  }
  if (command === "learn") {
    await handleLearnCommand(interaction, env);
    return;
  }
  if (command === "help") {
    await handleHelpCommand(interaction, env);
  }
}

/** Acknowledge inside Discord's 3s window, then resolve the notice language. */
async function deferAndLanguage(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<ReturnType<typeof messages>["dm"]> {
  await interaction.deferReply();
  // Fail-open: notices still render (in zh) when settings are unreadable.
  const language = await resolveUiLanguage(interaction.user.id, env);
  return messages(language).dm;
}

/** `/persona` and `/preference` (both backed by the memory endpoint). */
async function handleCategoryCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
  category: MemoryCategory,
): Promise<void> {
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();
  const table = await deferAndLanguage(interaction, env);
  const label = categoryLabel(category, table);

  try {
    if (sub === "show" || sub === "list") {
      const response = await memoryOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
      const memories = filterMemories(response, category);
      await interaction.editReply({ content: formatMemories(label, memories, table) });
      return;
    }

    if (sub === "set") {
      const key = interaction.options.getString("key", true).trim();
      const value = interaction.options.getString("value", true).trim();
      if (key === "" || value === "") {
        await interaction.editReply({ content: table.memoryError });
        return;
      }
      const response = await memoryOp(
        { op: "set", userId, category, key, value },
        env.workerUrl,
        env.internalApiToken,
      );
      await interaction.editReply({
        content: response.status === "ok" ? table.memorySet(label, key) : table.memoryError,
      });
      return;
    }

    // clear
    const key = interaction.options.getString("key")?.trim();
    const request =
      key !== undefined && key !== ""
        ? { op: "clear" as const, userId, category, key }
        : { op: "clear" as const, userId, category };
    const response = await memoryOp(request, env.workerUrl, env.internalApiToken);
    await interaction.editReply({
      content: response.status === "ok" ? table.memoryCleared(label) : table.memoryError,
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "control_command_error",
        command: interaction.commandName,
        sub,
        userId,
        error: String(error),
      }),
    );
    await interaction.editReply({ content: table.genericError }).catch(() => undefined);
  }
}

/** `/memory show` and `/memory clear` (all categories). */
async function handleMemoryCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const userId = interaction.user.id;
  const sub = interaction.options.getSubcommand();
  const table = await deferAndLanguage(interaction, env);

  try {
    if (sub === "show") {
      const response = await memoryOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
      const memories = response.status === "ok" ? response.memories : [];
      await interaction.editReply({ content: formatAllMemories(memories, table) });
      return;
    }

    const response = await memoryOp({ op: "clear", userId }, env.workerUrl, env.internalApiToken);
    await interaction.editReply({
      content: response.status === "ok" ? table.allMemoriesCleared : table.memoryError,
    });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "control_command_error",
        command: "memory",
        sub,
        userId,
        error: String(error),
      }),
    );
    await interaction.editReply({ content: table.genericError }).catch(() => undefined);
  }
}

/**
 * `/chat on|off` — toggle the DM chat opt-in (ADR-011). DM-only: the opt-out
 * clears the user's DM conversation context, which is only computable from a
 * DM channel. Omitting the value shows the current state.
 */
async function handleChatCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const table = await deferAndLanguage(interaction, env);
  if (interaction.inGuild()) {
    await interaction.editReply({ content: table.chatDmOnly });
    return;
  }
  const userId = interaction.user.id;
  const value = interaction.options.getString("value");

  try {
    if (value === "on" || value === "off") {
      const enable = value === "on";
      const response = await settingsOp(
        { op: "set", userId, chatOptin: enable },
        env.workerUrl,
        env.internalApiToken,
      );
      if (response.status === "error") {
        await interaction.editReply({ content: table.genericError });
        return;
      }
      if (enable) {
        await interaction.editReply({ content: table.chatOn });
        return;
      }

      // Opting out also resets the DM conversation context (ADR-011 §3),
      // best-effort: a failed clear is surfaced with a /context truncate hint.
      let clearNote = table.chatOffClearOk;
      try {
        const cleared = await clearContext(
          {
            userId,
            scopeId: "dm",
            containerId: `discord:@me:${interaction.channelId ?? ""}`,
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
      await interaction.editReply({ content: `${table.chatOffPrefix}${clearNote}` });
      return;
    }

    const state = await optinState(env, userId, "chat", table);
    await interaction.editReply({ content: table.chatState(state) });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "control_command_error",
        command: "chat",
        userId,
        error: String(error),
      }),
    );
    await interaction.editReply({ content: table.genericError }).catch(() => undefined);
  }
}

/** `/learn on|off` — toggle the auto-memory opt-in (ADR-012). */
async function handleLearnCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const userId = interaction.user.id;
  const table = await deferAndLanguage(interaction, env);
  const value = interaction.options.getString("value");

  try {
    if (value === "on" || value === "off") {
      const response = await settingsOp(
        { op: "set", userId, learnOptin: value === "on" },
        env.workerUrl,
        env.internalApiToken,
      );
      if (response.status === "error") {
        await interaction.editReply({ content: table.genericError });
        return;
      }
      await interaction.editReply({ content: value === "on" ? table.learnOn : table.learnOff });
      return;
    }

    const state = await optinState(env, userId, "learn", table);
    await interaction.editReply({ content: table.learnState(state) });
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "control_command_error",
        command: "learn",
        userId,
        error: String(error),
      }),
    );
    await interaction.editReply({ content: table.genericError }).catch(() => undefined);
  }
}

/** `/help` — the control-plane overview. */
async function handleHelpCommand(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const table = await deferAndLanguage(interaction, env);
  await interaction.editReply({ content: table.help });
}

/** Resolve the current on/off label for an opt-in flag; unknown on failure. */
async function optinState(
  env: EnvConfig,
  userId: string,
  flag: "chat" | "learn",
  table: ReturnType<typeof messages>["dm"],
): Promise<string> {
  try {
    const response = await settingsOp({ op: "get", userId }, env.workerUrl, env.internalApiToken);
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

function formatMemories(
  label: string,
  memories: UserMemory[],
  table: ReturnType<typeof messages>["dm"],
): string {
  if (memories.length === 0) return table.noCategoryMemories(label);
  const lines = memories.map((memory) => `- ${memory.key}: ${memory.value}`);
  return `${table.categoryMemoriesHeader(label)}\n${lines.join("\n")}`;
}

function formatAllMemories(
  memories: UserMemory[],
  table: ReturnType<typeof messages>["dm"],
): string {
  if (memories.length === 0) return table.noMemories;
  const lines = memories.map((memory) => `- [${memory.category}] ${memory.key}: ${memory.value}`);
  return `${table.allMemoriesHeader}\n${lines.join("\n")}`;
}

function categoryLabel(category: MemoryCategory, table: ReturnType<typeof messages>["dm"]): string {
  return category === "persona" ? table.personaLabel : table.preferenceLabel;
}
