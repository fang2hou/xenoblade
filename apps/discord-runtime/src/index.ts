import { createServer, type Server } from "node:http";
import process from "node:process";

import { Client, GatewayIntentBits, Partials, TextChannel, ThreadChannel } from "discord.js";
import type { ChatInputCommandInteraction, Message, SendableChannels } from "discord.js";
import type {
  DiscordAttachment,
  GenerationRequest,
  GenerationResult,
  HistoryMessage,
} from "@xenoblade/contracts";

import { loadEnv, type EnvConfig } from "./env";
import { containerIdFromMessage, scopeIdFromMessage } from "./conversation-scope";
import { evaluateTrigger, type TriggerDecision } from "./trigger-policy";
import { fetchHistory } from "./history";
import { postReply, sendTyping } from "./output";
import { clearContext, generate } from "./ai-client";
import { handleDmMessage } from "./dm-commands";
import { ConversationQueue } from "./conversation-queue";
import { registerSlashCommands } from "./slash-commands";
import { handleUsageCommand } from "./usage";

const FAILURE_REPLY = "这次处理失败了，请稍后重试。";
const RATE_LIMIT_REPLY = "请求过于频繁，请稍后再试。";
const CLEAR_SUCCESS_REPLY = "已清除你在此频道的对话上下文。";
const CLEAR_FAILURE_REPLY = "清除上下文失败，请稍后重试。";

async function main(): Promise<void> {
  const env = loadEnv();
  const queue = new ConversationQueue();

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
    // Partials.Channel is required to receive MESSAGE_CREATE in DM channels
    // that are not yet in the cache.
    partials: [Partials.Channel],
  });

  client.once("ready", () => {
    console.log(
      JSON.stringify({
        event: "ready",
        tag: client.user?.tag ?? "unknown",
        applicationId: client.user?.id ?? env.discordApplicationId,
      }),
    );
    void registerSlashCommands(env);
  });

  client.on("messageCreate", (message) => {
    void handleMessageCreate(message, env, queue, client);
  });

  client.on("interactionCreate", (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    void handleInteraction(interaction, env);
  });

  const healthServer = startHealthServer(env.healthPort);
  registerShutdown(client, healthServer);

  await client.login(env.discordBotToken);
  console.log(JSON.stringify({ event: "login" }));
}

/**
 * messageCreate entry point. Skips bots, routes DMs to the control plane, and
 * runs the summon matrix for guild messages. Triggered messages are enqueued
 * per-container so only one generation runs at a time per conversation.
 */
async function handleMessageCreate(
  message: Message,
  env: EnvConfig,
  queue: ConversationQueue,
  client: Client,
): Promise<void> {
  try {
    if (message.author.bot) return;

    // DMs route to the control plane, never the AI pipeline.
    if (message.channel?.isDMBased()) {
      await handleDmMessage(message, env);
      return;
    }

    const botId = client.user?.id ?? env.discordApplicationId;
    const decision = await evaluateTrigger(message, botId, env.mentionRoleIds);
    if (!decision) return;

    const containerId = containerIdFromMessage(message);
    console.log(
      JSON.stringify({
        event: "trigger",
        messageId: message.id,
        containerId,
        kind: decision.kind,
        hasFallback: Boolean(decision.fallbackMessage),
      }),
    );
    queue.enqueue(containerId, () => runGeneration(message, decision, env));
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "message_handler_error",
        messageId: message.id,
        error: String(error),
      }),
    );
  }
}

/**
 * Serialized generation for one triggered message: one typing indicator, fetch
 * history, build the request, call the Worker, post the result. Runs inside the
 * per-container queue.
 */
async function runGeneration(
  message: Message,
  decision: TriggerDecision,
  env: EnvConfig,
): Promise<void> {
  const channel = message.channel;
  if (!channel?.isSendable()) return;

  const scopeId = scopeIdFromMessage(message);
  const containerId = containerIdFromMessage(message);
  const effective = decision.fallbackMessage ?? message;

  // Keep typing indicator alive during generation. Discord's typing
  // indicator expires after ~10s; refresh every 8s until done.
  await sendTyping(channel);
  const typingInterval = setInterval(() => void sendTyping(channel), 8000);

  let history: HistoryMessage[] = [];
  try {
    if (channel instanceof TextChannel || channel instanceof ThreadChannel) {
      history = await fetchHistory(channel);
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "history_fetch_error",
        messageId: message.id,
        error: String(error),
      }),
    );
  }

  const request: GenerationRequest = {
    // messageId is the dedup key on the Worker — use the trigger event (the
    // mention), not the fallback content source, so a bare mention that
    // re-uses a prior message still triggers (see spec: fallback is "trigger
    // content", not identity).
    messageId: message.id,
    containerId,
    scopeId,
    channelId: message.channelId,
    userId: message.author.id,
    userDisplayName:
      message.member?.displayName || message.author.displayName || message.author.username,
    summonKind: decision.kind,
    content: effective.content,
    history,
    reference: buildReference(message),
    attachments: mapAttachments(effective.attachments),
  };

  console.log(
    JSON.stringify({
      event: "generation_request",
      messageId: request.messageId,
      containerId,
      scopeId,
      summonKind: request.summonKind,
      historyLen: history.length,
      hasFallback: decision.fallbackMessage !== undefined,
    }),
  );

  let result: GenerationResult;
  try {
    result = await generate(request, env.workerUrl, env.internalApiToken);
  } catch (error) {
    clearInterval(typingInterval);
    console.log(
      JSON.stringify({
        event: "generation_call_failed",
        messageId: message.id,
        error: String(error),
      }),
    );
    await postReply(channel, FAILURE_REPLY).catch((e) => {
      console.log(
        JSON.stringify({ event: "post_reply_error", messageId: message.id, error: String(e) }),
      );
    });
    return;
  }

  clearInterval(typingInterval);
  await applyGenerationResult(channel, result, message.id);
}

/** Post the Worker result (or a fallback message) to the channel. */
async function applyGenerationResult(
  channel: SendableChannels,
  result: GenerationResult,
  messageId: string,
): Promise<void> {
  console.log(
    JSON.stringify({
      event: "generation_result",
      messageId,
      status: result.status,
    }),
  );

  switch (result.status) {
    case "completed": {
      const replyLength = result.reply.length;
      const replyPreview = result.reply.slice(0, 100);
      console.log(
        JSON.stringify({
          event: "reply_posting",
          messageId,
          replyLength,
          replyPreview,
        }),
      );
      if (replyLength === 0 || result.reply.trim() === "") {
        console.log(JSON.stringify({ event: "empty_reply", messageId }));
        await postReply(channel, FAILURE_REPLY).catch((e) => {
          console.log(
            JSON.stringify({
              event: "post_reply_error",
              messageId,
              error: String(e),
            }),
          );
        });
        return;
      }
      await postReply(channel, result.reply)
        .then(() => {
          console.log(
            JSON.stringify({
              event: "reply_sent",
              messageId,
              length: replyLength,
            }),
          );
        })
        .catch((e) => {
          console.log(
            JSON.stringify({
              event: "post_reply_error",
              messageId,
              error: String(e),
              replyLength,
            }),
          );
        });
      return;
    }
    case "rejected":
      // duplicate / disabled → silent; budget_exceeded → courteous notice.
      if (result.code === "budget_exceeded") {
        await postReply(channel, RATE_LIMIT_REPLY).catch((e) => {
          console.log(
            JSON.stringify({
              event: "post_reply_error",
              messageId,
              error: String(e),
            }),
          );
        });
      }
      console.log(
        JSON.stringify({
          event: "generation_rejected",
          messageId,
          code: result.code,
        }),
      );
      return;
    case "error":
      console.log(
        JSON.stringify({
          event: "generation_error",
          messageId,
          code: result.code,
          message: result.message,
          retryable: result.retryable,
        }),
      );
      await postReply(channel, FAILURE_REPLY).catch((e) => {
        console.log(
          JSON.stringify({
            event: "post_reply_error",
            messageId,
            error: String(e),
          }),
        );
      });
      return;
  }
}

/** Build the wire `reference` from a reply, if any. */
function buildReference(message: Message): GenerationRequest["reference"] {
  const reference = message.reference;
  if (!reference?.messageId) return null;
  return {
    messageId: reference.messageId,
    channelId: reference.channelId,
    authorId: message.mentions.repliedUser?.id ?? null,
  };
}

/** Map discord.js attachments to the wire `DiscordAttachment` shape. */
function mapAttachments(attachments: Message["attachments"]): DiscordAttachment[] {
  return [...attachments.values()].map((attachment) => ({
    id: attachment.id,
    url: attachment.url,
    contentType: attachment.contentType,
    size: attachment.size,
  }));
}

/** interactionCreate entry point for slash commands. */
async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  try {
    if (interaction.commandName === "status") {
      await interaction.reply("Xenoblade Gateway OK");
      return;
    }
    if (interaction.commandName === "clear-context") {
      await handleClearContext(interaction, env);
      return;
    }
    if (interaction.commandName === "usage") {
      await handleUsageCommand(interaction, env);
      return;
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "interaction_error",
        command: interaction.commandName,
        error: String(error),
      }),
    );
  }
}

/** /clear-context → call the Worker context-clear endpoint. */
async function handleClearContext(
  interaction: ChatInputCommandInteraction,
  env: EnvConfig,
): Promise<void> {
  const guildId = interaction.guildId ?? "@me";
  const scopeId = interaction.guildId ?? "dm";
  const channel = interaction.channel;

  let containerId: string;
  if (channel && channel.isThread()) {
    containerId = `discord:${guildId}:${channel.parentId ?? channel.id}:${channel.id}`;
  } else {
    containerId = `discord:${guildId}:${interaction.channelId ?? ""}`;
  }

  try {
    const result = await clearContext(
      {
        userId: interaction.user.id,
        scopeId,
        containerId,
        scope: "user",
      },
      env.workerUrl,
      env.internalApiToken,
    );
    await interaction.reply(result.status === "ok" ? CLEAR_SUCCESS_REPLY : CLEAR_FAILURE_REPLY);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "clear_context_error",
        userId: interaction.user.id,
        containerId,
        error: String(error),
      }),
    );
    await interaction.reply(CLEAR_FAILURE_REPLY).catch(() => undefined);
  }
}

/** Start the health HTTP server: GET /health → { status, timestamp }. */
function startHealthServer(port: number): Server {
  const server = createServer((req, res) => {
    const path = (req.url ?? "/").split("?")[0];
    if (req.method === "GET" && path === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", timestamp: Date.now() }));
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "not_found" }));
  });
  server.listen(port, () => {
    console.log(JSON.stringify({ event: "health_listening", port }));
  });
  return server;
}

/** Tear down the client and health server on SIGTERM / SIGINT. */
function registerShutdown(client: Client, server: Server): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(JSON.stringify({ event: "shutdown", signal }));
    void client.destroy();
    server.close(() => {
      console.log(JSON.stringify({ event: "health_closed" }));
      process.exit(0);
    });
    // Don't hang forever if the server won't close promptly.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

main().catch((error) => {
  console.log(JSON.stringify({ event: "fatal", error: String(error) }));
  process.exit(1);
});
