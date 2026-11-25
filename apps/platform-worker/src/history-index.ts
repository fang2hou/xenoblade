import type { IndexedMessageUpsert, MessageIngestResponse } from "@xenoblade/contracts";

import { DM_SCOPE, getRuntimeConfig } from "./db";
import { isRecord } from "./guards";

// ── Limits ────────────────────────────────────────────────────────────────

/** How long a guild message stays in the index. */
export const HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

/** Longest stored message text, in Unicode characters. */
export const MAX_CONTENT_CHARS = 4_000;

/** Most messages one ingest request may add or re-index. */
export const MAX_UPSERTS_PER_REQUEST = 50;

/** Most message ids one ingest request may delete. */
export const MAX_DELETES_PER_REQUEST = 100;

/** Expired messages one ingest removes; the rest wait for its next ingest. */
export const PRUNE_BATCH_SIZE = 200;

/** Upserts per write transaction, so one D1 batch stays short in statements and bytes. */
const UPSERTS_PER_BATCH = 10;

/** Statements that store one message: the row, then its search text out with the old and in with the new. */
const STATEMENTS_PER_UPSERT = 3;

/** A message dated further ahead than this is not stored: no row may outlive the window. */
const MAX_CLOCK_SKEW_MS = 24 * 60 * 60 * 1000;

/** Most distinct words one search requires. */
const MAX_QUERY_TOKENS = 12;

/** Longest id, message or channel, that an ingest request may carry. */
const MAX_ID_CHARS = 64;

/** Candidates read when a name filter is applied in JavaScript rather than SQL. */
const AUTHOR_FILTER_CANDIDATES = 200;

// ── Types ─────────────────────────────────────────────────────────────────

/** Channel ids whose stored history may be read; null when the guild allows every channel. */
type AllowedChannels = readonly string[] | null;

/** The scope every read is bound to. */
interface ReadScope {
  guildId: string;
  /** The guild's channel allowlist; null when every channel is allowed. */
  allowedChannels: AllowedChannels;
  /**
   * The channels that are public right now, as the Runtime sees them. When
   * set, only messages of these channels are read, however they got into the
   * index: a channel made private after its messages were stored is no
   * longer readable. Unset when the Runtime did not say.
   */
  publicChannelIds?: readonly string[];
  /**
   * The triggering user's context watermark for the container the generation
   * runs in (ADR-014): messages of `containerChannelId` older than it were
   * truncated away from that user, so no read may bring them back.
   */
  resetAt?: number;
  containerChannelId?: string;
  now: number;
}

/** One indexed message as the read helpers return it. */
export type IndexedMessage = Omit<IndexedMessageUpsert, "updatedAt">;

/** A message of a conversation window; the requested one is the anchor. */
export interface IndexedContextMessage extends IndexedMessage {
  isAnchor: boolean;
}

export interface RecentMessagesQuery extends ReadScope {
  channelId: string;
  /** Only messages older than this one. */
  beforeMessageId?: string;
  limit: number;
}

export interface SearchMessagesQuery extends ReadScope {
  query: string;
  channelId?: string;
  /** Part of a display name, matched without regard to case. */
  authorName?: string;
  afterMs?: number;
  beforeMs?: number;
  limit: number;
}

export interface MessageContextQuery extends ReadScope {
  messageId: string;
  /** Earlier messages of the same channel to include. */
  before: number;
  /** Later messages of the same channel to include. */
  after: number;
}

// ── Segmentation and query building ───────────────────────────────────────

const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });

/**
 * Split text into the words FTS5 indexes, lowercased and space-separated.
 *
 * `unicode61` takes an unbroken run of Chinese as a single token, so 发售日
 * would never match 的发售日是. Word segmentation makes each word its own
 * token; queries go through the same function, so both sides split alike.
 */
export function segmentForSearch(text: string): string {
  const words: string[] = [];
  for (const { isWordLike, segment } of segmenter.segment(text)) {
    if (isWordLike) words.push(segment.toLowerCase());
  }
  return words.join(" ");
}

/**
 * Turn free text into an FTS5 query: up to {@link MAX_QUERY_TOKENS} distinct
 * words, each a quoted phrase, all of them required (FTS5's implicit AND).
 *
 * Quoting is what keeps a query safe. `OR`, `NOT`, `-`, `*`, `:` and `"` are
 * punctuation or ordinary words to the segmenter and end up inside quotes, so
 * they can never be read as FTS5 syntax. Null when nothing searchable remains.
 */
export function buildFtsQuery(rawQuery: string): string | null {
  const tokens = new Set(segmentForSearch(rawQuery).split(" "));
  tokens.delete("");
  if (tokens.size === 0) return null;
  return [...tokens]
    .slice(0, MAX_QUERY_TOKENS)
    .map((token) => `"${token.replaceAll('"', '""')}"`)
    .join(" ");
}

// ── Ingest ────────────────────────────────────────────────────────────────

interface IngestRequest {
  guildId: string;
  /** Valid upserts, one per message id — the latest of a repeated id. */
  upserts: IndexedMessageUpsert[];
  deletes: Set<string>;
  /** Entries left out: malformed, without text, or already expired. */
  rejected: number;
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_ID_CHARS;
}

function isOptionalId(value: unknown): value is string | null | undefined {
  return value == null || isId(value);
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * Validate and normalize one upsert.
 *
 * Null when it is malformed, carries no text, or already lies outside the
 * retention window. An expired message must never enter the index: rows then
 * only expire by aging, which is what keeps pruning exact.
 */
function parseUpsert(value: unknown, now: number): IndexedMessageUpsert | null {
  if (!isRecord(value)) return null;
  const { messageId, channelId, parentChannelId, authorId, authorName, isBot, content, replyToId } =
    value;
  const { createdAt, updatedAt } = value;
  if (!isId(messageId) || !isId(channelId) || !isId(authorId)) return null;
  if (!isOptionalId(parentChannelId) || !isOptionalId(replyToId)) return null;
  if (typeof authorName !== "string" || typeof isBot !== "boolean") return null;
  if (typeof content !== "string") return null;
  const text = Array.from(content.trim()).slice(0, MAX_CONTENT_CHARS).join("");
  if (text === "") return null;
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null;
  if (createdAt < now - HISTORY_RETENTION_MS || createdAt > now + MAX_CLOCK_SKEW_MS) return null;
  return {
    messageId,
    channelId,
    parentChannelId: parentChannelId ?? null,
    authorId,
    authorName,
    isBot,
    content: text,
    replyToId: replyToId ?? null,
    createdAt,
    updatedAt,
  };
}

/** The request's guild, upserts, and deletes, or null when the payload is invalid. */
function parseIngestRequest(req: unknown, now: number): IngestRequest | null {
  if (!isRecord(req) || !isId(req.guildId) || req.guildId === DM_SCOPE) return null;
  const rawUpserts = req.upserts ?? [];
  const rawDeletes = req.deletes ?? [];
  if (!Array.isArray(rawUpserts) || !Array.isArray(rawDeletes)) return null;
  if (rawUpserts.length > MAX_UPSERTS_PER_REQUEST || rawDeletes.length > MAX_DELETES_PER_REQUEST) {
    return null;
  }

  const latest = new Map<string, IndexedMessageUpsert>();
  let rejected = 0;
  for (const value of rawUpserts) {
    const upsert = parseUpsert(value, now);
    if (upsert === null) rejected += 1;
    else latest.set(upsert.messageId, upsert);
  }
  const deletes = new Set<string>();
  for (const value of rawDeletes) {
    if (isId(value)) deletes.add(value);
    else rejected += 1;
  }
  return { guildId: req.guildId, upserts: [...latest.values()], deletes, rejected };
}

/**
 * The stored row of one message of a guild. Keyed by the message id and the
 * guild together, it is what keeps a guild's writes on its own rows: the id
 * of a message another guild already owns resolves to nothing here.
 */
const OWNED_ROW = "(SELECT id FROM guild_messages WHERE guild_id = ?1 AND message_id = ?2)";

const UPSERT_MESSAGE = `
  INSERT INTO guild_messages
    (message_id, guild_id, channel_id, parent_channel_id, author_id, author_name,
     is_bot, content, reply_to_id, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  ON CONFLICT(message_id) DO UPDATE SET
    channel_id = excluded.channel_id,
    parent_channel_id = excluded.parent_channel_id,
    author_id = excluded.author_id,
    author_name = excluded.author_name,
    is_bot = excluded.is_bot,
    content = excluded.content,
    reply_to_id = excluded.reply_to_id,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at
  WHERE guild_messages.guild_id = excluded.guild_id`;

/**
 * Store a message and re-index its text: the previous version of its search
 * row goes first. All three statements run in one batch, and the search row
 * takes its rowid from the stored row itself, so the two tables cannot drift.
 */
function upsertStatements(
  db: D1Database,
  guildId: string,
  message: IndexedMessageUpsert,
): D1PreparedStatement[] {
  return [
    db
      .prepare(UPSERT_MESSAGE)
      .bind(
        message.messageId,
        guildId,
        message.channelId,
        message.parentChannelId,
        message.authorId,
        message.authorName,
        message.isBot ? 1 : 0,
        message.content,
        message.replyToId,
        message.createdAt,
        message.updatedAt,
      ),
    db
      .prepare(`DELETE FROM guild_messages_fts WHERE rowid = ${OWNED_ROW}`)
      .bind(guildId, message.messageId),
    db
      .prepare(
        `INSERT INTO guild_messages_fts (rowid, message_id, guild_id, channel_id, segmented_content)
         SELECT id, message_id, guild_id, channel_id, ?3 FROM guild_messages
         WHERE guild_id = ?1 AND message_id = ?2`,
      )
      .bind(guildId, message.messageId, segmentForSearch(message.content)),
  ];
}

/** The stored rows of a guild's messages, by their message ids. */
const OWNED_ROWS =
  "(SELECT id FROM guild_messages WHERE guild_id = ?1 AND message_id IN (SELECT value FROM json_each(?2)))";

/**
 * Remove deleted messages of one guild — and only of that guild — from both
 * tables. The search rows go first: they are found through the stored rows,
 * which the second statement then removes.
 */
function deleteStatements(db: D1Database, guildId: string, messageIds: readonly string[]) {
  return [
    db
      .prepare(`DELETE FROM guild_messages_fts WHERE guild_id = ?1 AND rowid IN ${OWNED_ROWS}`)
      .bind(guildId, JSON.stringify(messageIds)),
    db
      .prepare(`DELETE FROM guild_messages WHERE id IN ${OWNED_ROWS}`)
      .bind(guildId, JSON.stringify(messageIds)),
  ];
}

/** A guild's oldest expired messages, at most {@link PRUNE_BATCH_SIZE} of them. */
const OLDEST_EXPIRED =
  "(SELECT id FROM guild_messages WHERE guild_id = ?1 AND created_at < ?2 ORDER BY created_at, id LIMIT ?3)";

/**
 * Statements that remove a guild's oldest expired messages from both tables.
 *
 * Both select the same rows with the same predicate, and run in one batch:
 * the first statement removes only search rows, so the second still finds the
 * very same stored rows to remove. The guild's `(guild_id, created_at)` index
 * finds them, and the count is capped so one ingest never holds D1 for long —
 * whatever is left waits for the guild's next ingest.
 */
function pruneStatements(db: D1Database, guildId: string, now: number): D1PreparedStatement[] {
  const params = [guildId, now - HISTORY_RETENTION_MS, PRUNE_BATCH_SIZE];
  return [
    db
      .prepare(`DELETE FROM guild_messages_fts WHERE guild_id = ?1 AND rowid IN ${OLDEST_EXPIRED}`)
      .bind(...params),
    db.prepare(`DELETE FROM guild_messages WHERE id IN ${OLDEST_EXPIRED}`).bind(...params),
  ];
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/** Rows a statement changed, as D1 reports it. */
function changes(result: D1Result | undefined): number {
  return result?.meta.changes ?? 0;
}

/**
 * Index a batch of guild message changes (`POST /internal/v1/messages/ingest`).
 *
 * Only messages of channels the guild allows the bot in are stored, under the
 * guild's `enabled` switch; the rest are counted as skipped. Every write is
 * keyed by the guild, so a request can only ever touch that guild's rows.
 * Deletes are always carried out, and last, so a deleted message leaves the
 * index even when the same request also upserts it. Each batch is atomic and
 * every write is idempotent, so a request that fails halfway can simply be
 * sent again. Never throws: a bad payload answers `invalid_body`, a failed
 * write `ingest_failed`.
 */
export async function handleMessageIngest(
  db: D1Database,
  req: unknown,
  now = Date.now(),
): Promise<MessageIngestResponse> {
  const startedAt = Date.now();
  const request = parseIngestRequest(req, now);
  if (request === null) return { status: "error", code: "invalid_body" };
  const { guildId, upserts, deletes, rejected } = request;

  try {
    // One config read per distinct channel decides whether its messages are
    // stored. The parent is part of the key: it is what admits a thread.
    const accepted = new Map<string, boolean>();
    const channelIds = new Set<string>();
    const stored: IndexedMessageUpsert[] = [];
    for (const upsert of upserts) {
      channelIds.add(upsert.channelId);
      const key = `${upsert.channelId}\u0000${upsert.parentChannelId ?? ""}`;
      let allowed = accepted.get(key);
      if (allowed === undefined) {
        const config = await getRuntimeConfig(
          db,
          guildId,
          upsert.channelId,
          upsert.parentChannelId,
        );
        allowed = config.enabled && config.channelAllowed;
        accepted.set(key, allowed);
      }
      if (allowed) stored.push(upsert);
    }

    let upserted = 0;
    for (const batch of chunks(stored, UPSERTS_PER_BATCH)) {
      const results = await db.batch(
        batch.flatMap((message) => upsertStatements(db, guildId, message)),
      );
      // A stored row counts; a message id another guild already owns changed nothing.
      for (let i = 0; i < batch.length; i++) {
        upserted += changes(results[i * STATEMENTS_PER_UPSERT]);
      }
    }

    const removals = deletes.size > 0 ? deleteStatements(db, guildId, [...deletes]) : [];
    const outcomes = await db.batch([...removals, ...pruneStatements(db, guildId, now)]);
    const pruned = changes(outcomes[removals.length + 1]);

    console.log(
      JSON.stringify({
        event: "history_ingest",
        guildId,
        channelIds: [...channelIds],
        upserted,
        deleted: deletes.size,
        skipped: upserts.length - stored.length,
        rejected: rejected + stored.length - upserted,
        pruned,
        durationMs: Date.now() - startedAt,
      }),
    );
    return {
      status: "ok",
      upserted,
      deleted: deletes.size,
      skipped: upserts.length - stored.length,
      rejected: rejected + stored.length - upserted,
      pruned,
    };
  } catch (error) {
    // The error's name only: a database error can quote the statement or its values.
    console.log(
      JSON.stringify({
        event: "history_ingest_failed",
        guildId,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { status: "error", code: "ingest_failed" };
  }
}

// ── Reads ─────────────────────────────────────────────────────────────────

type MessageRow = {
  message_id: string;
  channel_id: string;
  parent_channel_id: string | null;
  author_id: string;
  author_name: string;
  is_bot: number;
  content: string;
  reply_to_id: string | null;
  created_at: number;
};

const GM_COLUMNS =
  "gm.message_id, gm.channel_id, gm.parent_channel_id, gm.author_id, gm.author_name, gm.is_bot, gm.content, gm.reply_to_id, gm.created_at";

function toMessage(row: MessageRow): IndexedMessage {
  return {
    messageId: row.message_id,
    channelId: row.channel_id,
    parentChannelId: row.parent_channel_id,
    authorId: row.author_id,
    authorName: row.author_name,
    isBot: row.is_bot === 1,
    content: row.content,
    replyToId: row.reply_to_id,
    createdAt: row.created_at,
  };
}

/** Numbered binds of one statement: a value is bound once and referenced as `?n` wherever needed. */
class Binds {
  readonly values: unknown[] = [];

  add(value: unknown): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

/** True when the scope itself admits no channel at all. */
function readsNothing(scope: ReadScope): boolean {
  return scope.allowedChannels?.length === 0 || scope.publicChannelIds?.length === 0;
}

/**
 * The `WHERE` terms every read shares, beyond the message's own: its guild,
 * the 90-day window, the channel allowlist, the channels that are public
 * now, and the triggering user's truncation of the current container.
 */
function scopeTerms(bind: Binds, scope: ReadScope): string[] {
  const terms = [
    `gm.guild_id = ${bind.add(scope.guildId)}`,
    `gm.created_at >= ${bind.add(scope.now - HISTORY_RETENTION_MS)}`,
  ];
  const allowlist = allowlistTerm(bind, scope.allowedChannels, "gm.");
  if (allowlist !== null) terms.push(allowlist);
  if (scope.publicChannelIds !== undefined) {
    terms.push(
      `gm.channel_id IN (SELECT value FROM json_each(${bind.add(JSON.stringify(scope.publicChannelIds))}))`,
    );
  }
  const resetAt = scope.resetAt ?? 0;
  if (resetAt > 0 && scope.containerChannelId !== undefined) {
    terms.push(
      `(gm.channel_id <> ${bind.add(scope.containerChannelId)} OR gm.created_at >= ${bind.add(resetAt)})`,
    );
  }
  return terms;
}

/**
 * `WHERE` term admitting only allowlisted channels — a thread through its
 * listed parent. Null without an allowlist, when every channel is allowed.
 */
function allowlistTerm(bind: Binds, allowedChannels: AllowedChannels, prefix = ""): string | null {
  if (allowedChannels === null) return null;
  const json = bind.add(JSON.stringify(allowedChannels));
  return `(${prefix}channel_id IN (SELECT value FROM json_each(${json})) OR ${prefix}parent_channel_id IN (SELECT value FROM json_each(${json})))`;
}

/**
 * Can SQLite's LIKE match this name filter exactly? LIKE folds case for ASCII
 * only; a filter holding a cased character beyond ASCII (Cyrillic, Greek,
 * accented Latin) would miss Дима when written дима.
 */
function isLikeExact(filter: string): boolean {
  for (const char of filter) {
    if (char.charCodeAt(0) > 0x7f && char.toLowerCase() !== char.toUpperCase()) return false;
  }
  return true;
}

/**
 * The newest messages of one channel, oldest first.
 *
 * Scoped to the guild, the 90-day window, the channel allowlist, the channels
 * that are public now, and the triggering user's truncation of this channel,
 * if it is the one the generation runs in. With `beforeMessageId`, only
 * messages older than that one — the next page back.
 */
export async function getRecentIndexedMessages(
  db: D1Database,
  query: RecentMessagesQuery,
): Promise<IndexedMessage[]> {
  if (readsNothing(query)) return [];
  const bind = new Binds();
  const guild = bind.add(query.guildId);
  const where = scopeTerms(bind, query);
  where.push(`gm.channel_id = ${bind.add(query.channelId)}`);
  if (query.beforeMessageId !== undefined) {
    const anchor = `SELECT created_at, message_id FROM guild_messages WHERE guild_id = ${guild} AND message_id = ${bind.add(query.beforeMessageId)}`;
    where.push(`(gm.created_at, gm.message_id) < (${anchor})`);
  }

  const { results } = await db
    .prepare(
      `SELECT ${GM_COLUMNS} FROM guild_messages AS gm
       WHERE ${where.join(" AND ")}
       ORDER BY gm.created_at DESC, gm.message_id DESC
       LIMIT ${bind.add(query.limit)}`,
    )
    .bind(...bind.values)
    .all<MessageRow>();
  return (results ?? []).map(toMessage).toReversed();
}

/**
 * Search a guild's history: messages matching every word of `query`, best
 * match first and, among equals, newest first.
 *
 * Scoped like every read — guild, 90-day window, allowlist, the channels
 * that are public now, the triggering user's truncation of the current
 * container — and narrower with a channel, an author name, and a time range.
 */
export async function searchIndexedMessages(
  db: D1Database,
  query: SearchMessagesQuery,
): Promise<IndexedMessage[]> {
  const match = buildFtsQuery(query.query);
  if (match === null || readsNothing(query)) return [];
  const since = query.now - HISTORY_RETENTION_MS;
  if (query.beforeMs !== undefined && query.beforeMs <= since) return [];

  const bind = new Binds();
  const where = scopeTerms(bind, query);
  where.push(`guild_messages_fts MATCH ${bind.add(match)}`);
  where.push(`gm.created_at >= ${bind.add(Math.max(query.afterMs ?? since, since))}`);
  if (query.beforeMs !== undefined) where.push(`gm.created_at < ${bind.add(query.beforeMs)}`);
  if (query.channelId !== undefined) where.push(`gm.channel_id = ${bind.add(query.channelId)}`);

  const name = query.authorName === "" ? undefined : query.authorName;
  let readLimit = query.limit;
  if (name !== undefined) {
    if (isLikeExact(name)) {
      // The wildcard escape pairs with LIKE's ESCAPE clause.
      where.push(
        `gm.author_name LIKE ${bind.add(`%${name.replace(/[\\%_]/g, "\\$&")}%`)} ESCAPE '\\'`,
      );
    } else {
      // LIKE would miss this filter's case: read a bounded window of candidates instead.
      readLimit = AUTHOR_FILTER_CANDIDATES;
    }
  }

  const { results } = await db
    .prepare(
      `SELECT ${GM_COLUMNS} FROM guild_messages_fts AS fts
       JOIN guild_messages AS gm ON gm.id = fts.rowid
       WHERE ${where.join(" AND ")}
       ORDER BY fts.rank, gm.created_at DESC, gm.message_id DESC
       LIMIT ${bind.add(readLimit)}`,
    )
    .bind(...bind.values)
    .all<MessageRow>();
  let messages = (results ?? []).map(toMessage);
  if (name !== undefined && !isLikeExact(name)) {
    const needle = name.toLowerCase();
    messages = messages.filter((message) => message.authorName.toLowerCase().includes(needle));
  }
  return messages.slice(0, query.limit);
}

/**
 * The conversation around one message: up to `before` earlier and `after`
 * later messages of its channel, oldest first, the requested message marked
 * as the anchor.
 *
 * The anchor must belong to the guild, be recent enough, and sit in an
 * allowed, public channel — and, in the channel the generation runs in, be
 * newer than the triggering user's truncation — otherwise nothing is
 * returned, without saying which.
 */
export async function getIndexedMessageContext(
  db: D1Database,
  query: MessageContextQuery,
): Promise<IndexedContextMessage[]> {
  if (readsNothing(query)) return [];
  const since = query.now - HISTORY_RETENTION_MS;
  const bind = new Binds();
  const where = scopeTerms(bind, query);
  where.push(`gm.message_id = ${bind.add(query.messageId)}`);
  const anchor = await db
    .prepare(`SELECT ${GM_COLUMNS} FROM guild_messages AS gm WHERE ${where.join(" AND ")}`)
    .bind(...bind.values)
    .first<MessageRow>();
  if (!anchor) return [];

  // The anchor passed every scope check, and its neighbours share its channel,
  // so they pass the same ones — all but the truncation, which is a matter of
  // time: in the container's own channel nothing older than it comes back.
  const inContainer = anchor.channel_id === query.containerChannelId;
  const floor = Math.max(since, inContainer ? (query.resetAt ?? 0) : 0);
  const neighbors = async (earlier: boolean, count: number): Promise<MessageRow[]> => {
    if (count === 0) return [];
    const { results } = await db
      .prepare(
        `SELECT ${GM_COLUMNS} FROM guild_messages AS gm
         WHERE gm.guild_id = ?1 AND gm.channel_id = ?2 AND gm.created_at >= ?3
           AND (gm.created_at, gm.message_id) ${earlier ? "<" : ">"} (?4, ?5)
         ORDER BY gm.created_at ${earlier ? "DESC" : "ASC"}, gm.message_id ${earlier ? "DESC" : "ASC"}
         LIMIT ?6`,
      )
      .bind(query.guildId, anchor.channel_id, floor, anchor.created_at, anchor.message_id, count)
      .all<MessageRow>();
    return results ?? [];
  };
  const [earlier, later] = await Promise.all([
    neighbors(true, query.before),
    neighbors(false, query.after),
  ]);
  return [...earlier.toReversed(), anchor, ...later].map((row) => ({
    ...toMessage(row),
    isAnchor: row === anchor,
  }));
}
