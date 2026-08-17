import { createServer, type Server } from "node:http";
import process from "node:process";

import {
  Client,
  DMChannel,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  TextChannel,
  ThreadChannel,
} from "discord.js";
import type {
  ChatInputCommandInteraction,
  Message,
  MessageComponentInteraction,
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
  buildReplyControlsRow,
  ReplyRegistry,
  resolveControlAction,
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
      // Required to receive messageReactionAdd events for the memory
      // confirmations (ADR-013 ✅/❌). Reply controls are buttons and arrive
      // as interactions (ADR-015).
      GatewayIntentBits.GuildMessageReactions,
    ],
    // Partials.Channel is required to receive MESSAGE_CREATE in DM channels
    // that are not yet in the cache. Message/Reaction/User partials keep
    // messageReactionAdd flowing for memory confirmations on messages that
    // have fallen out of the cache — the handler reads only ids and fetches
    // full structures before acting, so partial payloads are safe.
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
    void handleReactionAdd(reaction, user, env, confirms);
  });

  client.on("interactionCreate", (interaction) => {
    // Receipt log: without it, an interaction that is dropped here (wrong
    // type, unrouted command or component) fails silently as "did not
    // respond" in Discord.
    const command =
      interaction.isChatInputCommand() || interaction.isContextMenuCommand()
        ? interaction.commandName
        : null;
    const customId = interaction.isMessageComponent() ? interaction.customId : null;
    console.log(
      JSON.stringify({ event: "interaction_received", type: interaction.type, command, customId }),
    );
    if (interaction.isMessageComponent()) {
      // Fire-and-forget: the handler catches and logs internally; awaiting
      // would block the gateway's event dispatch.
      void handleComponentInteraction(interaction, env, queue, client, registry, confirms);
      return;
    }
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

  await executeGeneration(channel, request, env, { regenerate: false }, registry, confirms);
}

/** How a generation run claims dedup and where its reply lands. */
interface GenerationRun {
  /** True marks a regenerate: dedup claims the Worker's regenerate lease. */
  regenerate: boolean;
  /**
   * Present when an existing reply is regenerated in place (ADR-015): the
   * run edits the tracked head message instead of posting fresh, restores it
   * on failure, and re-enables its buttons on success.
   */
  target?: RegenTarget;
}

/** The reply a regenerate edits in place, plus how to reach its clicker. */
interface RegenTarget {
  entry: ReplyEntry;
  /** Head chunk message of the reply being replaced. */
  head: Message;
  /** Ephemeral side-channel to the clicker (interaction follow-up). */
  notify: (text: string) => Promise<void>;
}

/**
 * Serialized generation execution: one typing indicator, call the Worker,
 * post the result with its button controls. Long runs get a staged status
 * placeholder (ADR-003 amendment) that the final reply replaces; a
 * regenerate reuses the existing reply's head message as that placeholder
 * (ADR-015). Runs inside the per-container queue; regenerates re-run a
 * previously built request with the same shape.
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
  // final reply or failure notice. A regenerate stages onto the existing
  // reply's head message instead (ADR-015).
  const staged = new StagedStatus(channel, {
    milestones: stagedMilestones(language),
    ...(run.target ? { placeholder: run.target.head } : {}),
  });
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
    if (run.target) {
      await restoreRegeneratedReply(run.target, staged, language, generationTexts.failure);
      return;
    }
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
    ...(run.target ? { regen: run.target } : {}),
    registry,
    confirms,
    staged,
    channel,
    language,
    redactContent: request.scopeId === "dm",
  });
}

/** Context for posting a result: what the reply controls need. */
interface PostContext {
  request: GenerationRequest;
  /** Present when this run regenerates a tracked reply in place (ADR-015). */
  regen?: RegenTarget;
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
 * staged status placeholder (if any) with the outcome text. A regenerate
 * replaces its tracked reply in place; any failed or rejected re-run
 * restores the previous reply instead of posting a notice over it.
 * DM-scope results never log content previews (ADR-011 privacy posture).
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
        if (ctx.regen) {
          await restoreRegeneratedReply(
            ctx.regen,
            ctx.staged,
            ctx.language,
            messages(ctx.language).generation.failure,
          );
        } else {
          await ctx.staged.settle(messages(ctx.language).generation.failure).catch((e) => {
            console.log(
              JSON.stringify({
                event: "post_reply_error",
                messageId,
                error: String(e),
              }),
            );
          });
        }
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
        if (ctx.regen) {
          await finishRegeneratedReply(posted, ctx);
        } else {
          await attachReplyControls(posted, ctx);
        }
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
      // A regenerate is restored either way: the previous answer must not be
      // destroyed by a failed re-run, and a silent path never posts notices.
      if (result.code === "budget_exceeded") {
        if (ctx.regen) {
          await restoreRegeneratedReply(
            ctx.regen,
            ctx.staged,
            ctx.language,
            messages(ctx.language).generation.rateLimited,
          );
        } else {
          await ctx.staged.settle(messages(ctx.language).generation.rateLimited).catch((e) => {
            console.log(
              JSON.stringify({
                event: "post_reply_error",
                messageId,
                error: String(e),
              }),
            );
          });
        }
      } else if (ctx.regen) {
        await restoreRegeneratedReply(ctx.regen, ctx.staged, ctx.language, null);
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
      if (ctx.regen) {
        await restoreRegeneratedReply(
          ctx.regen,
          ctx.staged,
          ctx.language,
          messages(ctx.language).generation.failure,
        );
      } else {
        await ctx.staged.settle(messages(ctx.language).generation.failure).catch((e) => {
          console.log(
            JSON.stringify({
              event: "post_reply_error",
              messageId,
              error: String(e),
            }),
          );
        });
      }
      return;
  }
}

/**
 * Terminate a regenerated run without new content: stop staging, put the
 * previous reply back with its buttons re-enabled, and — when `notice` is
 * set — tell the clicker why through the ephemeral side-channel.
 */
async function restoreRegeneratedReply(
  target: RegenTarget,
  staged: StagedStatus,
  language: UiLanguage,
  notice: string | null,
): Promise<void> {
  staged.abort();
  target.entry.busy = false;
  const row = buildReplyControlsRow(messages(language).replyControls, target.head.id);
  await target.head
    .edit({ content: target.entry.headContent, components: [row] })
    .catch((error) => {
      console.log(
        JSON.stringify({
          event: "regen_restore_error",
          messageId: target.head.id,
          error: String(error),
        }),
      );
    });
  if (notice !== null) await target.notify(notice);
}

/**
 * Finish a successful regenerate: drop the surplus chunks of the replaced
 * reply (continuations the new content no longer occupies) and hand the
 * edited reply back to the registry with its buttons re-enabled.
 */
async function finishRegeneratedReply(posted: readonly Message[], ctx: PostContext): Promise<void> {
  const target = ctx.regen;
  if (target === undefined) return;
  const newHead = posted[0];
  if (newHead !== undefined) {
    // The settle fallback may have already removed the old head itself; a
    // failed delete is logged and ignored either way.
    for (const id of target.entry.chunkIds) {
      if (id === newHead.id) continue;
      await ctx.channel.messages.delete(id).catch((error) => {
        console.log(
          JSON.stringify({
            event: "reply_chunk_delete_error",
            messageId: id,
            error: String(error),
          }),
        );
      });
    }
    if (newHead.id !== target.head.id) ctx.registry.remove(target.head.id);
  }
  console.log(
    JSON.stringify({
      event: "reply_regenerated",
      messageId: target.head.id,
      newHeadId: newHead?.id ?? null,
      chunks: posted.length,
    }),
  );
  await attachReplyControls(posted, ctx);
}

/**
 * Register a posted reply for the control buttons and attach the action row
 * to its head chunk. Best-effort: a failed components edit is logged, never
 * fatal — the reply itself is already delivered, and a reply without
 * registered buttons fails closed (ephemeral expiry on click).
 */
async function attachReplyControls(posted: readonly Message[], ctx: PostContext): Promise<void> {
  const head = posted[0];
  if (head === undefined) return;
  ctx.registry.register(head.id, {
    request: ctx.request,
    chunkIds: posted.map((message) => message.id),
    headContent: head.content,
    language: ctx.language,
    busy: false,
  });
  const row = buildReplyControlsRow(messages(ctx.language).replyControls, head.id);
  await head.edit({ components: [row] }).catch((error) => {
    console.log(
      JSON.stringify({
        event: "reply_control_attach_error",
        messageId: head.id,
        error: String(error),
      }),
    );
  });
}

/**
 * messageReactionAdd entry point for the memory confirmations (ADR-013).
 * The reply affordances moved to buttons and arrive as interactions
 * (ADR-015).
 */
async function handleReactionAdd(
  reaction: MessageReaction | PartialMessageReaction,
  user: User | PartialUser,
  env: EnvConfig,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  try {
    await handleMemoryConfirmReaction(reaction, user, env, confirms);
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
 * interactionCreate entry point for the reply-control buttons (ADR-015):
 * 🔁 Regenerate re-runs the frozen request and edits the reply in place,
 * 🗑 Delete removes the whole reply.
 *
 * Only the triggering user may act — regenerating spends budget and deleting
 * removes the answer they asked for, so restricting both to them stops third
 * parties from burning the shared 24h budget or destroying other members'
 * answers; anyone else gets an ephemeral refusal. Any button this process
 * cannot resolve — restart, registry eviction, unknown customId — fails
 * closed with an ephemeral expiry notice: no crash, no action.
 */
async function handleComponentInteraction(
  interaction: MessageComponentInteraction,
  env: EnvConfig,
  queue: ConversationQueue,
  client: Client,
  registry: ReplyRegistry,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  try {
    const messageId = interaction.message.id;
    const entry = registry.get(messageId);
    const decision = resolveControlAction(
      entry,
      interaction.customId,
      messageId,
      interaction.user.id,
    );
    if (decision === null || decision.action === "rejected") {
      // Unknown customId or unresolvable one — either way this process
      // cannot act on the button, so fail closed with a graceful ephemeral
      // notice: no crash, no action (ADR-015 restart safety).
      const reason = decision === null ? "expired" : decision.reason;
      const texts = messages(
        await resolveUiLanguageBounded(interaction.user.id, env, 1_000),
      ).replyControls;
      const content =
        reason === "not-owner" ? texts.notOwner : reason === "busy" ? texts.busy : texts.expired;
      await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch((error) => {
        console.log(
          JSON.stringify({
            event: "component_reject_reply_error",
            messageId,
            error: String(error),
          }),
        );
      });
      return;
    }
    if (entry === undefined) return;
    if (decision.action === "delete") {
      await deleteReply(interaction, entry, client, registry);
      return;
    }
    await startRegenerate(interaction, entry, env, queue, client, registry, confirms);
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "component_handler_error",
        messageId: interaction.message.id,
        error: String(error),
      }),
    );
  }
}

/**
 * Regenerate a reply in place (ADR-015): acknowledge the click by disabling
 * the buttons, then enqueue a re-run of the frozen request that edits the
 * same head message with the new content. The frozen request keeps its wire
 * `regenerateOf` marker, which now claims the Worker's short-lived
 * regenerate lease. A racing second click is refused while the re-run is in
 * flight (`entry.busy`); the lease is the durable backstop.
 */
async function startRegenerate(
  interaction: MessageComponentInteraction,
  entry: ReplyEntry,
  env: EnvConfig,
  queue: ConversationQueue,
  client: Client,
  registry: ReplyRegistry,
  confirms: MemoryConfirmRegistry,
): Promise<void> {
  const messageId = interaction.message.id;
  entry.busy = true;
  // Acknowledge and disable both buttons in one call, using the language
  // the reply was posted with (no settings fetch on the ack path). A failure
  // here means the message is gone — nothing to regenerate, stand down.
  const disabledRow = buildReplyControlsRow(messages(entry.language).replyControls, messageId, {
    disabled: true,
  });
  const acknowledged = await interaction.update({ components: [disabledRow] }).then(
    () => true,
    (error) => {
      console.log(
        JSON.stringify({ event: "regen_acknowledge_error", messageId, error: String(error) }),
      );
      return false;
    },
  );
  if (!acknowledged) {
    entry.busy = false;
    return;
  }
  // Ephemeral side-channel to the clicker for the re-run's failure notices.
  const notify = (text: string): Promise<void> =>
    interaction.followUp({ content: text, flags: MessageFlags.Ephemeral }).then(
      () => undefined,
      (error) => {
        console.log(
          JSON.stringify({ event: "regen_notify_error", messageId, error: String(error) }),
        );
      },
    );

  queue.enqueue(entry.request.containerId, async () => {
    const channel = await client.channels.fetch(entry.request.channelId).catch(() => undefined);
    if (!channel?.isSendable()) {
      entry.busy = false;
      console.log(
        JSON.stringify({
          event: "regenerate_channel_unavailable",
          messageId: entry.request.messageId,
        }),
      );
      return;
    }
    const head = await channel.messages.fetch(messageId).catch(() => undefined);
    if (head === undefined) {
      entry.busy = false;
      console.log(JSON.stringify({ event: "regenerate_target_missing", messageId }));
      return;
    }
    await executeGeneration(
      channel,
      entry.request,
      env,
      { regenerate: true, target: { entry, head, notify } },
      registry,
      confirms,
    );
  });
}

/** Delete the reply a control fired on: head chunk plus every continuation. */
async function deleteReply(
  interaction: MessageComponentInteraction,
  entry: ReplyEntry,
  client: Client,
  registry: ReplyRegistry,
): Promise<void> {
  const messageId = interaction.message.id;
  registry.remove(messageId);
  // Acknowledge first (the deletion itself is the visible outcome); the
  // buttons die with the message.
  await interaction.deferUpdate().catch((error) => {
    console.log(
      JSON.stringify({ event: "component_defer_error", messageId, error: String(error) }),
    );
  });

  const channel = await client.channels.fetch(interaction.message.channelId);
  if (!channel?.isSendable()) {
    console.log(JSON.stringify({ event: "reply_delete_channel_unavailable", messageId }));
    return;
  }

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
      messageId,
      chunks: entry.chunkIds.length,
    }),
  );
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
