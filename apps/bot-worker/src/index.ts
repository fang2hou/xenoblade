import { Chat } from "chat";
import { createDiscordAdapter } from "@chat-adapter/discord";
import { createCloudflareState } from "chat-state-cloudflare-do";
import type { ChatStateDO } from "chat-state-cloudflare-do";

import { clearUserContext } from "@xenoblade/db";
import { handleGatewayRequest, notFound } from "./gateway-routes";
import {
  STOP_REPLY,
  STOP_WORDS,
  handleAiTrigger,
  tryBareMentionFallback,
  resolveReplyToBot,
} from "./pipeline";

// Re-export the Durable Object classes so Wrangler can instantiate them.
export { ChatStateDO } from "chat-state-cloudflare-do";
export { XenobladeGatewayDO } from "./gateway-do";

const CLEAR_SUCCESS_REPLY = "好的，已清除你在此频道的对话上下文。";
const CLEAR_FAILURE_REPLY = "清除上下文失败，请稍后重试。";

function createBot(env: Env): Chat {
  const bot = new Chat({
    userName: "Xenoblade",
    adapters: {
      discord: createDiscordAdapter({
        botToken: env.DISCORD_BOT_TOKEN,
        publicKey: env.DISCORD_PUBLIC_KEY,
        applicationId: env.DISCORD_APPLICATION_ID,
        createThreadsForMentions: false,
        mentionRoleIds: ["1536654090992623638"],
      }),
    },
    state: createCloudflareState({
      namespace: env.CHAT_STATE as DurableObjectNamespace<ChatStateDO>,
    }),
    concurrency: {
      strategy: "queue",
      maxQueueSize: 10,
      queueEntryTtlMs: 90_000,
      onQueueFull: "drop-oldest",
    },
  });
  registerHandlers(bot, env);
  return bot;
}

function registerHandlers(bot: Chat, env: Env): void {
  bot.onSlashCommand(["/status"], async (event) => {
    await event.channel.post("Xenoblade Gateway MVP OK");
  });

  bot.onSlashCommand(["/clear-context"], async (event) => {
    const containerId = event.channel.id;
    const userId = event.user.userId;
    const parts = containerId.split(":");
    const scopeId = parts[1] === "@me" ? "dm" : (parts[1] ?? "dm");

    const ok = await clearUserContext(env.DB, {
      scopeId,
      containerId,
      userId,
      now: Date.now(),
    });
    await event.channel.post(ok ? CLEAR_SUCCESS_REPLY : CLEAR_FAILURE_REPLY);
  });

  bot.onNewMention(async (thread, message) => {
    console.log(
      JSON.stringify({
        event: "handler",
        type: "onNewMention",
        messageId: message.id,
        isMention: message.isMention,
        textLen: message.text.length,
      }),
    );
    if (await tryBareMentionFallback(env, thread, message)) return;

    const isReply = await resolveReplyToBot(
      message,
      env.DISCORD_APPLICATION_ID,
      env.DISCORD_BOT_TOKEN,
    );
    await handleAiTrigger(env, thread, message, {
      kind: "mention",
      isReplyToBot: isReply,
      unsubscribeOnError: false,
    });
  });

  bot.onNewMessage(/[\s\S]+/, async (thread, message) => {
    console.log(
      JSON.stringify({
        event: "handler",
        type: "onNewMessage",
        messageId: message.id,
        isMention: message.isMention,
        isMe: message.author.isMe,
        textLen: message.text.length,
      }),
    );
    if (message.author.isMe) {
      return;
    }
    if (await tryBareMentionFallback(env, thread, message)) return;

    const isMention = message.isMention === true;
    const isReply = await resolveReplyToBot(
      message,
      env.DISCORD_APPLICATION_ID,
      env.DISCORD_BOT_TOKEN,
    );
    if (!isMention && !isReply) {
      return;
    }
    await handleAiTrigger(env, thread, message, {
      kind: "mention",
      isReplyToBot: isReply,
      unsubscribeOnError: false,
    });
  });

  bot.onSubscribedMessage(async (thread, message, context) => {
    console.log(
      JSON.stringify({
        event: "handler",
        type: "onSubscribedMessage",
        messageId: message.id,
        isMention: message.isMention,
        isMe: message.author.isMe,
        textLen: message.text.length,
      }),
    );
    if (message.author.isMe) {
      return;
    }

    const queued = [...(context?.skipped ?? []), message];
    const wantsStop = queued.some(
      (m) => !m.author.isMe && STOP_WORDS[m.text.trim().toLowerCase()] === true,
    );
    if (wantsStop) {
      try {
        await thread.unsubscribe();
      } catch {
        /* cleanup failure is non-fatal */
      }
      try {
        await thread.post(STOP_REPLY);
      } catch {
        /* best-effort */
      }
      return;
    }
    if (await tryBareMentionFallback(env, thread, message)) return;

    const isMention = message.isMention === true;
    const isReply = await resolveReplyToBot(
      message,
      env.DISCORD_APPLICATION_ID,
      env.DISCORD_BOT_TOKEN,
    );
    if (!isMention && !isReply) {
      return;
    }

    await handleAiTrigger(env, thread, message, {
      kind: "subscribed",
      isReplyToBot: isReply,
      unsubscribeOnError: true,
    });
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    console.log(
      JSON.stringify({
        event: "fetch",
        method: request.method,
        path: new URL(request.url).pathname,
      }),
    );
    const gatewayResponse = await handleGatewayRequest(request, env);
    if (gatewayResponse !== null) {
      return gatewayResponse;
    }

    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/webhooks/discord") {
      const bot = createBot(env);
      return bot.webhooks.discord(request, {
        waitUntil: (task: Promise<unknown>) => ctx.waitUntil(task),
      });
    }

    return notFound();
  },
};
