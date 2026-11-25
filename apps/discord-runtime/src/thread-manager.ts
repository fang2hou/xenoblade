import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  ThreadAutoArchiveDuration,
  type Client,
  type Message,
  type TextChannel,
} from "discord.js";
import type {
  ChannelAllowedRequest,
  ChannelAllowedResponse,
  GenerationRequest,
  HistoryMessage,
  SummonKind,
  ThreadSession,
  ThreadSessionRequest,
  ThreadSessionResponse,
} from "@xenoblade/contracts";

import { checkChannelAllowed, threadSessionOp } from "./ai-client";
import { fetchHistory } from "./history";

// ── Threads started on a summon ───────────────────────────────────────────

/**
 * Whether a summon is answered in a thread started on its message: a direct
 * or role mention in a regular server text channel. A reply to the bot stays
 * in the channel, and so does any summon sent where Discord starts no thread
 * from a message — an announcement channel, a voice channel's text chat, a DM.
 */
export function startsThread(kind: SummonKind, channel: { type: ChannelType }): boolean {
  return (
    (kind === "user-mention" || kind === "role-mention") && channel.type === ChannelType.GuildText
  );
}

/** Longest name Discord accepts for a thread, in UTF-16 code units. */
const MAX_THREAD_TITLE_UNITS = 100;

/** A mention as Discord writes it into message content: a user, a role, a channel. */
const MENTION_TOKEN = /<@!?\d+>|<@&\d+>|<#\d+>/g;

/**
 * Name a thread by the summon's own words: its mention tokens dropped, its
 * whitespace collapsed, and what remains cut to Discord's limit without
 * splitting a surrogate pair. `fallback` names a summon that said nothing
 * but the mention.
 */
export function buildThreadTitle(content: string, fallback: string): string {
  const words = content.replace(MENTION_TOKEN, " ").replace(/\s+/g, " ").trim();
  let title = "";
  for (const char of words) {
    if (title.length + char.length > MAX_THREAD_TITLE_UNITS) break;
    title += char;
  }
  const trimmed = title.trim();
  return trimmed === "" ? fallback : trimmed;
}

/** How many of the parent channel's messages precede the summon into the thread's context. */
const ANCHOR_MESSAGE_COUNT = 20;

/** A thread a summon runs in, and the discussion it was started from. */
export interface StartedThread {
  thread: NonNullable<Message["thread"]>;
  /**
   * What the parent channel said before the summon, oldest first. The summon
   * itself is not part of it, and neither is anything posted after it.
   */
  anchorHistory: HistoryMessage[];
}

export interface StartThreadOptions {
  /** Name of the thread — see {@link buildThreadTitle}. */
  name: string;
  /** Reads a channel's latest messages: Discord, unless a test stubs it. */
  fetchHistory?: typeof fetchHistory;
}

/**
 * Whether the bot may post in a thread it would start from the channel: the
 * channel's permissions for the bot allow sending in threads. Asked before
 * the thread exists, so none is left standing that the bot cannot answer in.
 */
function mayPostInThreads(channel: TextChannel, client: Pick<Client, "user">): boolean {
  const bot = client.user;
  if (bot === null) return false;
  const permissions = channel.permissionsFor(bot);
  return permissions?.has(PermissionFlagsBits.SendMessagesInThreads, false) === true;
}

/**
 * Whether the bot can post in the thread as it stands. `sendable` is
 * discord.js' own reading of the bot's permissions there and of the thread's
 * state; a locked thread is closed to the bot even where that reading passes.
 */
function isWritable(thread: StartedThread["thread"]): boolean {
  return !thread.locked && thread.sendable;
}

/** `thread_not_writable`: ids only, as every event here. */
function notWritable(message: Message, thread: StartedThread["thread"]): string {
  return JSON.stringify({
    event: "thread_not_writable",
    messageId: message.id,
    threadId: thread.id,
  });
}

/**
 * Start a thread on a summoning message — or find the one already started on
 * it — and read what the parent channel said before the summon. Only the
 * messages older than the summon are read, so a message posted after it —
 * while the thread was being started — is never taken for what the thread
 * was started from.
 *
 * Returns null when the thread cannot be had, and in every such case the
 * channel is left without a thread of this bot's making: the message is not
 * in a regular text channel, the bot could not post in a thread there, or
 * the thread that exists is closed to the bot. A thread Discord refuses to
 * start is one more such case. The caller then answers in the channel.
 */
export async function startDiscussionThread(
  message: Message,
  options: StartThreadOptions,
): Promise<StartedThread | null> {
  // Only a regular text channel starts a thread from a message; anywhere else
  // the caller's own check said so too (see startsThread).
  const channel = message.channel;
  if (channel.type !== ChannelType.GuildText) return null;
  if (!mayPostInThreads(channel, message.client)) {
    console.log(JSON.stringify({ event: "thread_start_refused", messageId: message.id }));
    return null;
  }

  try {
    // A thread that is there already must be one the bot can post in; when it
    // is not, nothing else is asked of Discord.
    const existing = await existingThread(message);
    if (existing !== null && !isWritable(existing)) {
      console.log(notWritable(message, existing));
      return null;
    }

    // Read while the summon is still what the thread is started from, and before the thread exists.
    const anchorHistory = await readAnchors(message, options);
    const thread = existing ?? (await startOrRecoverThread(message, options.name));
    if (!isWritable(thread)) {
      console.log(notWritable(message, thread));
      return null;
    }
    console.log(
      JSON.stringify({
        event: "thread_started",
        messageId: message.id,
        threadId: thread.id,
        anchors: anchorHistory.length,
      }),
    );
    return { thread, anchorHistory };
  } catch (error) {
    // An error code is all the log needs: a failed call names no user content.
    console.log(
      JSON.stringify({
        event: "thread_start_error",
        messageId: message.id,
        code: error instanceof DiscordAPIError ? error.code : errorName(error),
      }),
    );
    return null;
  }
}

/** The parent channel's messages older than the summon; none when they cannot be read. */
async function readAnchors(
  message: Message,
  options: StartThreadOptions,
): Promise<HistoryMessage[]> {
  const readHistory = options.fetchHistory ?? fetchHistory;
  // The channel type was checked by the caller; the cast is for the reader's signature.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a regular text channel, as startDiscussionThread checked
  const channel = message.channel as TextChannel;
  return readHistory(channel, ANCHOR_MESSAGE_COUNT, message.id).then(
    (history) => history.filter((anchor) => anchor.id !== message.id),
    (error: unknown) => {
      console.log(
        JSON.stringify({
          event: "anchor_fetch_error",
          messageId: message.id,
          errorName: errorName(error),
        }),
      );
      return [];
    },
  );
}

/**
 * Start a thread on the message. When Discord answers that the message has a
 * thread already — one started between the look-up and this call — that
 * thread is fetched instead: a thread started on a message has the message's
 * id. A thread that cannot be fetched rethrows, and the summon is answered in
 * the channel.
 */
async function startOrRecoverThread(
  message: Message,
  name: string,
): Promise<StartedThread["thread"]> {
  try {
    return await message.startThread({
      name,
      autoArchiveDuration: ThreadAutoArchiveDuration.OneDay,
    });
  } catch (error) {
    if (
      !(error instanceof DiscordAPIError) ||
      error.code !== RESTJSONErrorCodes.ThreadAlreadyCreatedForMessage
    ) {
      throw error;
    }
    const existing = await message.client.channels.fetch(message.id);
    if (existing === null || !existing.isThread()) throw error;
    console.log(
      JSON.stringify({ event: "thread_start_raced", messageId: message.id, threadId: existing.id }),
    );
    return existing;
  }
}

/**
 * The thread already started on the message, when Discord says it has one.
 * A thread started on a message has the message's id, so an uncached one is
 * fetched by it; a message that merely carries the flag is left alone.
 */
async function existingThread(message: Message): Promise<StartedThread["thread"] | null> {
  if (message.thread !== null) return message.thread;
  if (!message.hasThread) return null;
  const fetched = await message.client.channels.fetch(message.id);
  return fetched?.isThread() ? fetched : null;
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

// ── Thread sessions ───────────────────────────────────────────────────────

/** What names a thread to the Runtime and to the Worker: its guild, its own id, and its parent channel's. */
export interface ThreadRef {
  /** The thread's guild. The Worker acts on a session only for the guild that registered the thread. */
  guildId: string;
  id: string;
  /** Null when Discord did not say: such a thread has no session to keep. */
  parentId: string | null;
}

/**
 * The thread a request was addressed to, by the Runtime's own convention: a
 * request says which channel it runs in, and names a parent only inside a thread.
 */
export function threadOf(request: GenerationRequest): ThreadRef | null {
  if (request.parentChannelId == null) return null;
  return { guildId: request.scopeId, id: request.channelId, parentId: request.parentChannelId };
}

/** Most threads whose session is remembered; the oldest is read again when it is next needed. */
const MAX_REMEMBERED_THREADS = 2048;

/**
 * How long a remembered session stands before the Worker is asked again. The
 * Worker is the only other writer, so memory and store drift only when an
 * answer is lost on the way back; this bounds how long that can matter.
 */
const SESSION_TTL_MS = 10 * 60_000;

interface Remembered {
  session: ThreadSession;
  expiresAt: number;
}

export interface ThreadSessionsOptions {
  workerUrl: string;
  token: string;
  /** Sends one session request — the Worker client, unless a test stubs it. */
  send?: (req: ThreadSessionRequest) => Promise<ThreadSessionResponse>;
  /** Asks whether the Worker answers in a channel — the Worker client, unless a test stubs it. */
  ask?: (req: ChannelAllowedRequest) => Promise<ChannelAllowedResponse>;
}

/**
 * What the Runtime knows of the threads it was summoned in: whether the bot
 * follows a thread's un-summoned messages, and which question cards in it are
 * still waiting for an answer. The Worker holds the record, so a session
 * survives a restart; this remembers each one for a while so ordinary chat
 * costs no request. Every request names the thread's guild with it.
 *
 * Failures never throw. A thread the Worker cannot be asked about is treated
 * as unfollowed — nothing summons the bot on a guess — and a change that
 * cannot be stored leaves the remembered session as it was.
 */
export class ThreadSessions {
  private readonly send: (req: ThreadSessionRequest) => Promise<ThreadSessionResponse>;
  private readonly ask: (req: ChannelAllowedRequest) => Promise<ChannelAllowedResponse>;
  private readonly remembered = new Map<string, Remembered>();

  constructor(options: ThreadSessionsOptions) {
    this.send = options.send ?? ((req) => threadSessionOp(req, options.workerUrl, options.token));
    this.ask = options.ask ?? ((req) => checkChannelAllowed(req, options.workerUrl, options.token));
  }

  /**
   * Whether the Worker answers in a channel at all — its guild switch and
   * channel allowlist, as the generation gate reads them. Null when the
   * Worker cannot be asked: a caller that acts on "no" (it starts no thread)
   * then keeps to what it may do without the answer.
   */
  async isChannelAllowed(channel: ChannelAllowedRequest): Promise<boolean | null> {
    try {
      const response = await this.ask(channel);
      return response.status === "ok" ? response.allowed : null;
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "thread_session_error",
          op: "check_allowed",
          detail: errorName(error),
        }),
      );
      return null;
    }
  }

  /** Whether un-summoned messages in the thread summon the bot. */
  async isFollowed(thread: ThreadRef): Promise<boolean> {
    return (await this.read(thread))?.active ?? false;
  }

  /** Make the bot follow the thread, registering it first when it never was. */
  async follow(thread: ThreadRef, userId: string): Promise<void> {
    if (thread.parentId === null) {
      console.log(JSON.stringify({ event: "thread_unregistered", threadId: thread.id }));
      return;
    }
    await this.write(
      {
        op: "upsert",
        threadId: thread.id,
        guildId: thread.guildId,
        parentChannelId: thread.parentId,
        createdBy: userId,
      },
      thread,
    );
  }

  /** Note that the bot stopped following the thread — the Worker already stored as much. */
  unfollow(threadId: string): void {
    const remembered = this.remembered.get(threadId);
    if (remembered !== undefined) {
      remembered.session = { ...remembered.session, active: false };
    }
  }

  /** Message ids of the question cards the thread is still waiting on. */
  async pendingCardIds(thread: ThreadRef): Promise<string[]> {
    return (await this.read(thread))?.pendingCardIds ?? [];
  }

  /** Record a question card posted in the thread, so it is cleaned up even after a restart. */
  async recordCard(thread: ThreadRef, cardMessageId: string): Promise<void> {
    const remembered = this.remembered.get(thread.id);
    if (remembered !== undefined && !remembered.session.pendingCardIds.includes(cardMessageId)) {
      remembered.session = {
        ...remembered.session,
        pendingCardIds: [...remembered.session.pendingCardIds, cardMessageId],
      };
    }
    await this.write(
      { op: "add_card", threadId: thread.id, guildId: thread.guildId, cardMessageId },
      thread,
    );
  }

  /**
   * Forget the question cards the Runtime deleted from Discord, and only
   * those: a card it could not delete stays listed, so a later turn cleans it
   * up. Nothing is sent for an empty list.
   */
  async forgetCards(thread: ThreadRef, cardMessageIds: readonly string[]): Promise<void> {
    if (cardMessageIds.length === 0) return;
    await this.write(
      {
        op: "clear_cards",
        threadId: thread.id,
        guildId: thread.guildId,
        clearedIds: [...cardMessageIds],
      },
      thread,
    );
  }

  /**
   * The thread's session as the Worker holds it, remembered for a while.
   * Null when the Worker cannot say — the caller then acts on an unfollowed
   * thread with no cards.
   */
  private async read(thread: ThreadRef): Promise<ThreadSession | null> {
    const remembered = this.remembered.get(thread.id);
    if (remembered !== undefined && remembered.expiresAt > Date.now()) return remembered.session;

    try {
      const response = await this.send({ op: "get", threadId: thread.id, guildId: thread.guildId });
      if (response.status === "error") {
        this.logFailure("get", thread.id, response.code);
        return null;
      }
      const session = response.session ?? {
        threadId: thread.id,
        guildId: thread.guildId,
        parentChannelId: thread.parentId ?? "",
        active: false,
        pendingCardIds: [],
      };
      this.remember(session);
      return session;
    } catch (error) {
      this.logFailure("get", thread.id, errorName(error));
      return null;
    }
  }

  /**
   * Send a change and adopt the session the Worker answers with — its card
   * list included, so a card the Worker still lists is still cleaned up. The
   * Worker refused the change or kept no session for the thread: nothing is
   * remembered about it, so the next lookup asks again.
   */
  private async write(request: ThreadSessionRequest, thread: ThreadRef): Promise<void> {
    try {
      const response = await this.send(request);
      if (response.status === "error") {
        this.logFailure(request.op, thread.id, response.code);
        return;
      }
      if (response.session === null) {
        this.remembered.delete(thread.id);
        return;
      }
      this.remember(response.session);
    } catch (error) {
      this.logFailure(request.op, thread.id, errorName(error));
    }
  }

  private remember(session: ThreadSession): void {
    this.remembered.delete(session.threadId);
    this.remembered.set(session.threadId, { session, expiresAt: Date.now() + SESSION_TTL_MS });
    if (this.remembered.size > MAX_REMEMBERED_THREADS) {
      const oldest = this.remembered.keys().next().value;
      if (oldest !== undefined) this.remembered.delete(oldest);
    }
  }

  private logFailure(op: ThreadSessionRequest["op"], threadId: string, detail: string): void {
    console.log(JSON.stringify({ event: "thread_session_error", op, threadId, detail }));
  }
}
