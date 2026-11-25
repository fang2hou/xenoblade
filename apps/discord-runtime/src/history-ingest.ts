import type {
  IndexedMessageUpsert,
  MessageIngestRequest,
  MessageIngestResponse,
} from "@xenoblade/contracts";

import { ingestMessages } from "./ai-client";
import { authorDisplayName } from "./history";

/** How often pending changes are sent, whatever their number. */
export const FLUSH_INTERVAL_MS = 5_000;

/** Pending changes of one guild that are sent at once, ahead of the timer. */
export const FLUSH_BATCH_SIZE = 20;

/** Most pending changes kept per guild; beyond it the oldest are dropped, so a Worker outage never grows memory. */
export const MAX_QUEUE_SIZE = 200;

/** Most changes in one request: the Worker accepts 50 upserts and 100 deletes. */
const MAX_REQUEST_SIZE = 50;

/**
 * The fields of a discord.js `Message` the buffer reads. A full message and a
 * partial one both fit: a partial carries `null` for `content` and `author`.
 */
export interface IngestMessage {
  id: string;
  channelId: string;
  guildId: string | null;
  content: string | null;
  webhookId: string | null;
  system: boolean | null;
  createdTimestamp: number;
  editedTimestamp: number | null;
  channel?: { isThread(): boolean; isDMBased(): boolean; parentId?: string | null } | null;
  author?: { id: string; bot: boolean; displayName: string | null; username: string } | null;
  member?: { displayName: string } | null;
  reference?: { messageId?: string | null } | null;
}

/** One buffered change; for a message id only the latest state is kept. */
type Pending =
  | { kind: "upsert"; messageId: string; message: IndexedMessageUpsert }
  | { kind: "delete"; messageId: string };

/** A change and the guild whose buffer takes it. */
interface GuildChange {
  guildId: string;
  entry: Pending;
}

export interface HistoryIngestOptions {
  workerUrl: string;
  token: string;
  /** Id of Xenoblade's own account: its replies are indexed like anyone's messages. */
  botId: () => string;
  /** Sends one request — the Worker client, unless a test stubs it. */
  send?: (req: MessageIngestRequest) => Promise<MessageIngestResponse>;
}

type GuildChatMessage = IngestMessage & {
  guildId: string;
  author: { id: string; bot: boolean; displayName: string | null; username: string };
};

function hasText(message: IngestMessage): message is IngestMessage & { content: string } {
  return typeof message.content === "string" && message.content.trim() !== "";
}

/**
 * Is this a message of a guild channel that is chat — no DM, webhook, another
 * bot, or Discord system notice? Xenoblade's own messages pass, so a question
 * and its answer stay together in the index.
 */
function isGuildChat(message: IngestMessage, botId: string): message is GuildChatMessage {
  if (message.guildId === null || message.channel?.isDMBased() === true) return false;
  if (message.webhookId !== null || message.system === true) return false;
  const author = message.author;
  return author != null && (!author.bot || author.id === botId);
}

function isIndexable(
  message: IngestMessage,
  botId: string,
): message is GuildChatMessage & { content: string } {
  return isGuildChat(message, botId) && hasText(message);
}

/** The index entry of a guild chat message that carries text. */
function toUpsert(message: GuildChatMessage & { content: string }): GuildChange {
  const channel = message.channel;
  return {
    guildId: message.guildId,
    entry: {
      kind: "upsert",
      messageId: message.id,
      message: {
        messageId: message.id,
        channelId: message.channelId,
        parentChannelId: channel?.isThread() === true ? (channel.parentId ?? null) : null,
        authorId: message.author.id,
        authorName: authorDisplayName(message),
        isBot: message.author.bot,
        content: message.content,
        replyToId: message.reference?.messageId ?? null,
        createdAt: message.createdTimestamp,
        updatedAt: message.editedTimestamp ?? message.createdTimestamp,
      },
    },
  };
}

/**
 * Buffers guild message changes and delivers them to the Worker's history
 * index in batches.
 *
 * Created, edited, and deleted messages of guild channels are buffered per
 * guild — one entry per message id, its latest state — and sent every
 * {@link FLUSH_INTERVAL_MS}, or as soon as a guild holds
 * {@link FLUSH_BATCH_SIZE} changes. DMs, webhooks, other bots, and messages
 * without text never enter; Xenoblade's own replies do.
 *
 * Delivery is best-effort. A batch the Worker could not take goes back to the
 * front of its buffer and is retried, and no buffer keeps more than
 * {@link MAX_QUEUE_SIZE} changes: the oldest are dropped, so a Worker outage
 * costs index gaps, never memory. The timer never keeps the process alive;
 * `stop` delivers what is pending before the runtime exits.
 */
export class HistoryIngestBuffer {
  private readonly options: HistoryIngestOptions;
  private readonly send: (req: MessageIngestRequest) => Promise<MessageIngestResponse>;
  private readonly guilds = new Map<string, Map<string, Pending>>();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly timer: NodeJS.Timeout;
  private stopped = false;

  constructor(options: HistoryIngestOptions) {
    this.options = options;
    this.send = options.send ?? ((req) => ingestMessages(req, options.workerUrl, options.token));
    this.timer = setInterval(() => this.flushAll(), FLUSH_INTERVAL_MS);
    this.timer.unref();
  }

  /** Queue a created message for the index. */
  add(message: IngestMessage): void {
    this.safely(() => {
      if (isIndexable(message, this.options.botId())) {
        const upsert = toUpsert(message);
        this.put(upsert.guildId, upsert.entry);
      }
    });
  }

  /**
   * Queue an edited message. Its new text is re-indexed; a message edited to
   * no text at all leaves the index instead. An update that left the text
   * unchanged — an embed, attachment, or component changed — sends nothing.
   */
  edit(oldMessage: IngestMessage | null, newMessage: IngestMessage): void {
    this.safely(() => {
      const botId = this.options.botId();
      // A partial update carries no content at all: it says nothing about the text.
      if (newMessage.content == null || !isGuildChat(newMessage, botId)) return;
      if (hasText(newMessage)) {
        if (oldMessage?.content !== newMessage.content) {
          const upsert = toUpsert(newMessage);
          this.put(upsert.guildId, upsert.entry);
        }
        return;
      }
      // The text is gone: a message that carried text — or whose earlier text is unknown — leaves the index.
      if (oldMessage === null || hasText(oldMessage)) this.remove(newMessage);
    });
  }

  /** Queue a deleted message for removal. A partial message is enough: it still has its ids. */
  remove(message: IngestMessage): void {
    this.safely(() => {
      if (message.guildId !== null) {
        this.put(message.guildId, { kind: "delete", messageId: message.id });
      }
    });
  }

  /** Send everything pending now: waits for flushes already running, then drains every guild. */
  async flush(): Promise<void> {
    await Promise.all(this.inFlight.values());
    await Promise.all([...this.guilds.keys()].map((guildId) => this.flushGuild(guildId)));
  }

  /** Stop the timer and deliver what is still pending. Later events are ignored. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.timer);
    await this.flush();
  }

  /** Run one gateway event; indexing is best-effort, so nothing here may break the caller. */
  private safely(step: () => void): void {
    try {
      step();
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "history_ingest_event_error",
          error: error instanceof Error ? error.name : typeof error,
        }),
      );
    }
  }

  /** Buffer the latest state of a message. The latest state also counts as the newest change. */
  private put(guildId: string, entry: Pending): void {
    if (this.stopped) return;
    let buffer = this.guilds.get(guildId);
    if (buffer === undefined) {
      buffer = new Map();
      this.guilds.set(guildId, buffer);
    }
    buffer.delete(entry.messageId);
    buffer.set(entry.messageId, entry);
    this.trim(guildId, buffer);
    if (buffer.size >= FLUSH_BATCH_SIZE) void this.flushGuild(guildId);
  }

  /** Keep a guild's buffer within {@link MAX_QUEUE_SIZE} by dropping its oldest changes. */
  private trim(guildId: string, buffer: Map<string, Pending>): void {
    let dropped = 0;
    for (const oldest of buffer.keys()) {
      if (buffer.size <= MAX_QUEUE_SIZE) break;
      buffer.delete(oldest);
      dropped += 1;
    }
    if (dropped > 0) {
      console.log(
        JSON.stringify({ event: "history_ingest_overflow", guildId, dropped, queued: buffer.size }),
      );
    }
  }

  private flushAll(): void {
    for (const guildId of this.guilds.keys()) void this.flushGuild(guildId);
  }

  /** Send everything a guild has pending; a guild whose flush is still running waits for a later pass. */
  private flushGuild(guildId: string): Promise<void> {
    const buffer = this.guilds.get(guildId);
    if (this.inFlight.has(guildId) || buffer === undefined || buffer.size === 0) {
      return Promise.resolve();
    }
    const pending = [...buffer.values()];
    buffer.clear();
    const flush = this.deliver(guildId, pending).finally(() => {
      this.inFlight.delete(guildId);
      // Forget the guild only when nothing is buffered for it now. That is
      // not the map captured above: a failed flush puts its batch back into
      // a fresh one, and that backlog must survive for the next pass.
      if (this.guilds.get(guildId)?.size === 0) this.guilds.delete(guildId);
    });
    this.inFlight.set(guildId, flush);
    return flush;
  }

  /** Send pending changes in order, request by request; what cannot be delivered goes back to the buffer. */
  private async deliver(guildId: string, pending: Pending[]): Promise<void> {
    // Consecutive changes, at most 50 per request: never more than 50 upserts and 50 deletes.
    const requests: Array<{ entries: Pending[]; body: MessageIngestRequest }> = [];
    for (let i = 0; i < pending.length; i += MAX_REQUEST_SIZE) {
      const entries = pending.slice(i, i + MAX_REQUEST_SIZE);
      requests.push({
        entries,
        body: {
          guildId,
          upserts: entries.flatMap((entry) => (entry.kind === "upsert" ? [entry.message] : [])),
          deletes: entries.flatMap((entry) => (entry.kind === "delete" ? [entry.messageId] : [])),
        },
      });
    }

    for (const [i, request] of requests.entries()) {
      const startedAt = Date.now();
      try {
        const response = await this.send(request.body);
        if (response.status !== "ok") throw new Error("ingest_rejected");
        console.log(
          JSON.stringify({
            event: "history_ingest_flushed",
            guildId,
            messages: request.entries.length,
            upserted: response.upserted,
            skipped: response.skipped,
            rejected: response.rejected,
            durationMs: Date.now() - startedAt,
          }),
        );
      } catch (error) {
        const undelivered = requests.slice(i).flatMap((rest) => rest.entries);
        console.log(
          JSON.stringify({
            event: "history_ingest_failed",
            guildId,
            messages: undelivered.length,
            // The error's name only: an HTTP error page can echo a request body.
            error: error instanceof Error ? error.name : typeof error,
            durationMs: Date.now() - startedAt,
          }),
        );
        this.restore(guildId, undelivered);
        return;
      }
    }
  }

  /** Put undelivered changes back, oldest first, never over the newer state of the same message. */
  private restore(guildId: string, undelivered: Pending[]): void {
    if (this.stopped) return;
    const current = this.guilds.get(guildId);
    const merged = new Map<string, Pending>();
    for (const entry of undelivered) {
      if (current?.has(entry.messageId) !== true) merged.set(entry.messageId, entry);
    }
    if (current !== undefined) {
      for (const [messageId, entry] of current) merged.set(messageId, entry);
    }
    this.guilds.set(guildId, merged);
    this.trim(guildId, merged);
  }
}
