import { createServer, type Server } from "node:http";
import process from "node:process";

import {
  Client,
  DMChannel,
  GatewayIntentBits,
  Partials,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  Message,
  MessageReaction,
  PartialMessageReaction,
  PartialUser,
  SendableChannels,
  User,
} from "discord.js";

import type {
  DiscordAttachment,
  GenerationRequest,
  GenerationResult,
  HistoryMessage,
  UiLanguage,
} from "@xenoblade/contracts";

import { loadEnv, type EnvConfig } from "./env";
import { containerIdFromMessage, scopeIdFromMessage } from "./conversation-scope";
import {
  handleMemoryConfirmReaction,
  MemoryConfirmRegistry,
  postMemoryConfirmation,
} from "./memory-confirm";
import { evaluateTrigger, type TriggerDecision } from "./trigger-policy";
import { fetchHistory } from "./history";
import { sendTyping } from "./output";
import { StagedStatus } from "./staged-status";
import { generate } from "./ai-client";
import { handleDmMessage } from "./dm-commands";
import { ConversationQueue } from "./conversation-queue";
import { registerSlashCommands } from "./slash-commands";
import { handleLanguageCommand, resolveUiLanguageBounded } from "./language";
import { messages, stagedMilestones } from "./i18n";
import { handleStatusCommand } from "./status";
import { handleContextCommand } from "./context";
import { handleControlCommand } from "./control-commands";
import { handleUsageCommand } from "./usage";
import {
  DELETE_EMOJI,
  isAffordanceEmoji,
  REGENERATE_EMOJI,
  ReplyRegistry,
  resolveAffordanceAction,
  type ReplyControls,
  type ReplyEntry,
} from "./reply-controls";
import { renderReply } from "./citations";

async function main(): Promise<void> {
  const env = loadEnv();
  const queue = new ConversationQueue();
  const registry = new ReplyRegistry();
  const confirms = new MemoryConfirmRegistry();
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
      // Required to receive messageReactionAdd events for the reply
      // affordances (🔁 regenerate / 🗑 delete).
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Partials.Channel is required to receive MESSAGE_CREATE in DM channels
    // that are not yet in the cache. Message/Reaction/User partials keep
    // messageReactionAdd flowing for replies that have fallen out of the
    // cache — the handler reads only ids and fetches full structures before
    // acting, so partial payloads are safe.
    partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User],
  });

  client.once("ready", () => {
    console.log(
      JSON.stringify({
        event: "ready",
        tag: client.user?.tag ?? "unknown",
        applicationId: client.user?.id ?? env.discordApplicationId,
      }),
    );
    // Best-effort registration on ready: the helper swallows its own
    // failures so a Discord API outage never breaks startup.
    void registerSlashCommands(env);
  });

  client.on("messageCreate", (message) => {
    // Fire-and-forget: the handler catches and logs internally; awaiting
    // would block the gateway's event dispatch.
    void handleMessageCreate(message, env, queue, client, registry, confirms);
  });

  client.on("messageReactionAdd", (reaction, user) => {
    // Fire-and-forget: the handler catches and logs internally; awaiting
    // would block the gateway's event dispatch.
    void handleReactionAdd(reaction, user, env, queue, client, registry, confirms);
  });

  client.on("interactionCreate", (interaction) => {
    // Receipt log: without it, an interaction that is dropped here (wrong
    // type, unrouted command) fails silently as "did not respond" in Discord.
    const command =
      interaction.isChatInputCommand() || interaction.isContextMenuCommand()
        ? interaction.commandName
        : null;
    console.log(JSON.stringify({ event: "interaction_received", type: interaction.type, command }));
    if (!interaction.isChatInputCommand()) return;
    // Fire-and-forget: the handler catches and logs internally; awaiting
    // would block the gateway's event dispatch.
    void handleInteraction(interaction, env);
  });

  const healthServer = startHealthServer(env.healthPort);
  registerShutdown(client, healthServer);

  await client.login(env.discordBotToken);
  console.log(JSON.stringify({ event: "login" }));
}

/**
 * messageCreate entry point. Skips bots, routes DMs to the control plane
 * (which dispatches opted-in non-command text to generation), and runs the
 * summon matrix for guild messages. Triggered messages are enqueued
 * per-container so only one generation runs at a time per conversation.
 */
async function handleMessageCreate(
  message: Message,
  env: EnvConfig,
  queue: ConversationQueue,
  client: Client,
  registry: ReplyRegistry,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  try {
    if (message.author.bot) return;

    // DMs route to the control plane first (commands always win); non-command
    // text continues to generation only for chat-opted-in users (ADR-011).
    if (message.channel?.isDMBased()) {
      await handleDmMessage(message, env, (dmMessage) => {
        queue.enqueue(containerIdFromMessage(dmMessage), () =>
          runGeneration(dmMessage, { kind: "dm-chat" }, env, registry, confirms),
        );
      });
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
    queue.enqueue(containerId, () => runGeneration(message, decision, env, registry, confirms));
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
 * Serialized generation for one triggered message: fetch history, build the
 * request, hand off to {@link executeGeneration}. Runs inside the
 * per-container queue.
 */
async function runGeneration(
  message: Message,
  decision: TriggerDecision,
  env: EnvConfig,
  registry: ReplyRegistry,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  const channel = message.channel;
  if (!channel?.isSendable()) return;

  const scopeId = scopeIdFromMessage(message);
  const containerId = containerIdFromMessage(message);
  const effective = decision.fallbackMessage ?? message;

  let history: HistoryMessage[] = [];
  try {
    if (
      channel instanceof TextChannel ||
      channel instanceof ThreadChannel ||
      channel instanceof DMChannel
    ) {
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

  await executeGeneration(
    channel,
    request,
    env,
    { regenerate: false, controls: "full" },
    registry,
    confirms,
  );
}

/** How a generation run claims dedup and which affordances its reply gets. */
interface GenerationRun {
  /** True marks a regenerate: dedup claims the once-per-trigger slot. */
  regenerate: boolean;
  controls: ReplyControls;
}

/**
 * Serialized generation execution: one typing indicator, call the Worker,
 * post the result with its reaction affordances. Long runs get a staged
 * status placeholder (ADR-003 amendment) that the final reply replaces.
 * Runs inside the per-container queue; regenerates re-run a previously
 * built request with the same shape.
 */
async function executeGeneration(
  channel: SendableChannels,
  request: GenerationRequest,
  env: EnvConfig,
  run: GenerationRun,
  registry: ReplyRegistry,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  // Keep typing indicator alive during generation. Discord's typing
  // indicator expires after ~10s; refresh every 8s until done.
  await sendTyping(channel);
  const typingInterval = setInterval(() => void sendTyping(channel), 8000);

  // UI language for this user's notices (staged status, failure texts);
  // chat reply language stays conversation-driven and never comes from here.
  // Bounded wait: a cold/slow settings fetch must never delay the placeholder
  // or the generation call — zh covers the degraded case, and the underlying
  // resolve keeps populating the cache for the next run.
  const language = await resolveUiLanguageBounded(request.userId, env, 1_000);
  const generationTexts = messages(language).generation;

  // Staged status placeholder for long generations (ADR-003 amendment):
  // posts after ~8s, escalates at coarse milestones, and is replaced by the
  // final reply or failure notice.
  const staged = new StagedStatus(channel, { milestones: stagedMilestones(language) });
  staged.start();

  const wireRequest: GenerationRequest = run.regenerate
    ? { ...request, regenerateOf: request.messageId }
    : request;
  if (run.regenerate) {
    console.log(JSON.stringify({ event: "regenerate_request", messageId: request.messageId }));
  }

  let result: GenerationResult;
  try {
    result = await generate(wireRequest, env.workerUrl, env.internalApiToken);
  } catch (error) {
    clearInterval(typingInterval);
    console.log(
      JSON.stringify({
        event: "generation_call_failed",
        messageId: request.messageId,
        error: String(error),
      }),
    );
    await staged.settle(generationTexts.failure).catch((e) => {
      console.log(
        JSON.stringify({
          event: "post_reply_error",
          messageId: request.messageId,
          error: String(e),
        }),
      );
    });
    return;
  }

  clearInterval(typingInterval);
  await applyGenerationResult(result, {
    request,
    controls: run.controls,
    registry,
    confirms,
    staged,
    channel,
    language,
    redactContent: request.scopeId === "dm",
  });
}

/** Context for posting a result: what the reaction controls need. */
interface PostContext {
  request: GenerationRequest;
  controls: ReplyControls;
  registry: ReplyRegistry;
  /** Pending memory confirmations for this runtime (ADR-013). */
  confirms: MemoryConfirmRegistry;
  /** Staged placeholder this run owns; settle/dismiss post or remove it. */
  staged: StagedStatus;
  /** Channel the reply was posted to; confirmations follow the reply. */
  channel: SendableChannels;
  /** UI language for this user's failure/rate-limit notices. */
  language: UiLanguage;
  redactContent: boolean;
}

/**
 * Post the Worker result (or a fallback message) to the channel, settling the
 * staged status placeholder (if any) with the outcome text. DM-scope results
 * never log content previews (ADR-011 privacy posture).
 */
async function applyGenerationResult(result: GenerationResult, ctx: PostContext): Promise<void> {
  const messageId = ctx.request.messageId;
  console.log(
    JSON.stringify({
      event: "generation_result",
      messageId,
      status: result.status,
    }),
  );

  switch (result.status) {
    case "completed": {
      const content = renderReply(result.reply);
      const replyLength = result.reply.length;
      const replyPreview = ctx.redactContent ? "" : result.reply.slice(0, 100);
      console.log(
        JSON.stringify({
          event: "reply_posting",
          messageId,
          replyLength,
          ...(replyPreview === "" ? {} : { replyPreview }),
          sources: result.sources.length,
        }),
      );
      if (replyLength === 0 || content === "") {
        console.log(JSON.stringify({ event: "empty_reply", messageId }));
        await ctx.staged.settle(messages(ctx.language).generation.failure).catch((e) => {
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
      const posted = await ctx.staged
        .settle(content)
        .then((sent) => {
          console.log(
            JSON.stringify({
              event: "reply_sent",
              messageId,
              length: replyLength,
            }),
          );
          return sent;
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
          return undefined;
        });
      if (posted !== undefined) {
        await addReplyControls(posted, ctx);
      }
      // Memory proposals from this generation (ADR-013): post the
      // ✅/❌ confirmation message right after the reply. Count-only logs —
      // proposal text never reaches the logs (DM posture applies everywhere).
      if (result.memoryProposals !== undefined && result.memoryProposals.length > 0) {
        console.log(
          JSON.stringify({
            event: "memory_proposals_posted",
            messageId,
            proposals: result.memoryProposals.length,
          }),
        );
        await postMemoryConfirmation(
          ctx.channel,
          ctx.request.userId,
          result.memoryProposals,
          messages(ctx.language).memoryConfirm,
          ctx.confirms,
        );
      }
      return;
    }
    case "rejected":
      // duplicate / disabled → silent; budget_exceeded → courteous notice.
      if (result.code === "budget_exceeded") {
        await ctx.staged.settle(messages(ctx.language).generation.rateLimited).catch((e) => {
          console.log(
            JSON.stringify({
              event: "post_reply_error",
              messageId,
              error: String(e),
            }),
          );
        });
      } else {
        // Silent rejection still must not leave a stale placeholder.
        await ctx.staged.dismiss();
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
      await ctx.staged.settle(messages(ctx.language).generation.failure).catch((e) => {
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

/**
 * React to the head chunk of a freshly posted reply with its affordances and
 * register it for the reaction handler. Best-effort: a failed react is
 * logged, never fatal — the reply itself is already delivered.
 */
async function addReplyControls(posted: readonly Message[], ctx: PostContext): Promise<void> {
  const head = posted[0];
  if (head === undefined) return;
  ctx.registry.register(head.id, {
    request: ctx.request,
    chunkIds: posted.map((message) => message.id),
    regenerable: ctx.controls === "full",
  });
  const emojis = ctx.controls === "full" ? [REGENERATE_EMOJI, DELETE_EMOJI] : [DELETE_EMOJI];
  for (const emoji of emojis) {
    await head.react(emoji).catch((error) => {
      console.log(
        JSON.stringify({
          event: "reply_control_react_error",
          messageId: head.id,
          emoji,
          error: String(error),
        }),
      );
    });
  }
}

/**
 * messageReactionAdd entry point for the reply affordances: 🔁 regenerates
 * the answer for the original trigger, 🗑 deletes the reply.
 *
 * The bot's own reactions are ignored — that includes the affordances it
 * adds itself. Only the triggering user may act: 🔁 spends generation budget
 * and 🗑 removes the answer they asked for, so restricting both to them stops
 * third parties from burning the shared 24h budget or deleting other members'
 * answers; moderators keep Discord's native message-deletion path.
 */
async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  env: EnvConfig,
  queue: ConversationQueue,
  client: Client,
  registry: ReplyRegistry,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  try {
    // Memory confirmations are a separate message family from reply
    // affordances; ids never overlap, so order is irrelevant.
    await handleMemoryConfirmReaction(reaction, user, env, confirms);
    const entry = registry.get(reaction.message.id);
    const action = resolveAffordanceAction(entry, reaction.emoji?.name, user.id, user.bot);
    if (action === "regenerate" && entry) {
      await startRegenerate(reaction, entry, env, queue, client, registry, confirms);
      return;
    }
    if (action === "delete" && entry) {
      await deleteReply(reaction, entry, client, registry);
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "reaction_handler_error",
        messageId: reaction.message.id,
        error: String(error),
      }),
    );
  }
}

/**
 * Consume the reply's regenerate affordance and enqueue a re-run of the
 * frozen original request (same shape, plus the wire `regenerateOf` marker
 * the Worker dedups on). The regenerated reply gets delete-only controls:
 * the once-per-trigger regenerate claim is spent.
 */
async function startRegenerate(
  reaction: MessageReaction | PartialMessageReaction,
  entry: ReplyEntry,
  env: EnvConfig,
  queue: ConversationQueue,
  client: Client,
  registry: ReplyRegistry,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  // Consume before enqueuing: one attempt per reply, even if the re-run
  // fails. The Worker's claimRegenerate is the durable cross-restart bound.
  registry.remove(reaction.message.id);
  await clearAffordances(reaction, entry.request.userId);

  queue.enqueue(entry.request.containerId, async () => {
    const channel = await client.channels.fetch(entry.request.channelId);
    if (!channel?.isSendable()) {
      console.log(
        JSON.stringify({
          event: "regenerate_channel_unavailable",
          messageId: entry.request.messageId,
        }),
      );
      return;
    }
    await executeGeneration(
      channel,
      entry.request,
      env,
      { regenerate: true, controls: "delete-only" },
      registry,
      confirms,
    );
  });
}

/** Delete the reply: head chunk plus every chunk continuation message. */
async function deleteReply(
  reaction: MessageReaction | PartialMessageReaction,
  entry: ReplyEntry,
  client: Client,
  registry: ReplyRegistry,
): Promise<void> {
  registry.remove(reaction.message.id);

  const channel = await client.channels.fetch(reaction.message.channelId);
  if (!channel?.isSendable()) {
    console.log(
      JSON.stringify({
        event: "reply_delete_channel_unavailable",
        messageId: reaction.message.id,
      }),
    );
    return;
  }

  // Head first so the affordances disappear immediately; the reactions die
  // with the message, so no explicit clear is needed here.
  for (const id of entry.chunkIds) {
    await channel.messages.delete(id).catch((error) => {
      console.log(
        JSON.stringify({ event: "reply_chunk_delete_error", messageId: id, error: String(error) }),
      );
    });
  }
  console.log(
    JSON.stringify({
      event: "reply_deleted",
      messageId: reaction.message.id,
      chunks: entry.chunkIds.length,
    }),
  );
}

/**
 * Remove the affordance reactions from a reply once it has been acted on, so
 * stale buttons don't accumulate. Removes the bot's own instances and the
 * actor's click (the latter needs MANAGE_MESSAGES; both are best-effort).
 */
async function clearAffordances(
  reaction: MessageReaction | PartialMessageReaction,
  actorId: string,
): Promise<void> {
  try {
    const fetched = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
    if (!fetched) return;
    for (const emoji of [REGENERATE_EMOJI, DELETE_EMOJI]) {
      const affordance = fetched.reactions.cache.find((r) =>
        isAffordanceEmoji(r.emoji?.name, emoji),
      );
      if (!affordance) continue;
      await affordance.remove().catch(() => undefined);
      await affordance.users.remove(actorId).catch(() => undefined);
    }
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "clear_affordances_error",
        messageId: reaction.message.id,
        error: String(error),
      }),
    );
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
      await handleStatusCommand(interaction, env);
      return;
    }
    if (interaction.commandName === "context") {
      await handleContextCommand(interaction, env);
      return;
    }
    if (interaction.commandName === "usage") {
      await handleUsageCommand(interaction, env);
      return;
    }
    if (interaction.commandName === "language") {
      await handleLanguageCommand(interaction, env);
      return;
    }
    if (
      interaction.commandName === "persona" ||
      interaction.commandName === "preference" ||
      interaction.commandName === "memory" ||
      interaction.commandName === "chat" ||
      interaction.commandName === "learn" ||
      interaction.commandName === "help"
    ) {
      await handleControlCommand(interaction, env);
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
    // Fire-and-forget: process exit below is driven by server.close (with a
    // 5s failsafe), not by awaiting the gateway teardown.
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
