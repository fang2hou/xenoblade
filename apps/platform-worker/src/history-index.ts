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

/** One indexed message as the read helpers return it. */
export type IndexedMessage = Omit<IndexedMessageUpsert, "updatedAt">;

/** A message of a conversation window; the requested one is the anchor. */
export interface IndexedContextMessage extends IndexedMessage {
  isAnchor: boolean;
}

export interface RecentMessagesQuery {
  guildId: string;
  channelId: string;
  allowedChannels: AllowedChannels;
  /** Only messages older than this one. */
  beforeMessageId?: string;
  limit: number;
  now: number;
}

export interface SearchMessagesQuery {
  guildId: string;
  query: string;
  channelId?: string;
  /** Part of a display name, matched without regard to case. */
  authorName?: string;
  afterMs?: number;
  beforeMs?: number;
  allowedChannels: AllowedChannels;
  limit: number;
  now: number;
}

export interface MessageContextQuery {
  guildId: string;
  messageId: string;
  /** Earlier messages of the same channel to include. */
  before: number;
  /** Later messages of the same channel to include. */
  after: number;
  allowedChannels: AllowedChannels;
  now: number;
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

const SNOWFLAKE = /^\d{1,19}$/;

/**
 * The rowid of a message's row in `guild_messages_fts`, as decimal text.
 *
 * FTS5 finds a row at once only by rowid; a DELETE on any other column scans
 * the whole index. A message's rowid is therefore derived from its id — the
 * snowflake itself, or a 63-bit hash when the id is not a number. It is
 * bound as text and cast in SQL, because a snowflake does not fit a JS number.
 */
function ftsRowId(messageId: string): string {
  if (SNOWFLAKE.test(messageId)) return messageId;
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < messageId.length; i++) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(messageId.charCodeAt(i))) * 0x100000001b3n);
  }
  return String(hash & 0x7fffffffffffffffn);
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

const UPSERT_MESSAGE = `
  INSERT INTO guild_messages
    (message_id, guild_id, channel_id, parent_channel_id, author_id, author_name,
     is_bot, content, reply_to_id, created_at, updated_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
  ON CONFLICT(message_id) DO UPDATE SET
    guild_id = excluded.guild_id,
    channel_id = excluded.channel_id,
    parent_channel_id = excluded.parent_channel_id,
    author_id = excluded.author_id,
    author_name = excluded.author_name,
    is_bot = excluded.is_bot,
    content = excluded.content,
    reply_to_id = excluded.reply_to_id,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at`;

/** Store a message and re-index its text: the previous version of the row goes first. */
function upsertStatements(
  db: D1Database,
  guildId: string,
  message: IndexedMessageUpsert,
): D1PreparedStatement[] {
  const rowId = ftsRowId(message.messageId);
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
    db.prepare("DELETE FROM guild_messages_fts WHERE rowid = CAST(?1 AS INTEGER)").bind(rowId),
    db
      .prepare(
        `INSERT INTO guild_messages_fts (rowid, message_id, guild_id, channel_id, segmented_content)
         VALUES (CAST(?1 AS INTEGER), ?2, ?3, ?4, ?5)`,
      )
      .bind(
        rowId,
        message.messageId,
        guildId,
        message.channelId,
        segmentForSearch(message.content),
      ),
  ];
}

/** Remove deleted messages of one guild — and only of that guild — from both tables. */
function deleteStatements(db: D1Database, guildId: string, messageIds: readonly string[]) {
  return [
    db
      .prepare(
        "DELETE FROM guild_messages WHERE guild_id = ?1 AND message_id IN (SELECT value FROM json_each(?2))",
      )
      .bind(guildId, JSON.stringify(messageIds)),
    db
      .prepare(
        "DELETE FROM guild_messages_fts WHERE guild_id = ?1 AND rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?2))",
      )
      .bind(guildId, JSON.stringify(messageIds.map(ftsRowId))),
  ];
}

/**
 * Statements that remove a guild's oldest expired messages from both tables.
 *
 * The guild's `(guild_id, created_at)` index finds them, and the count is
 * capped so one ingest never holds D1 for long: whatever is left waits for
 * the guild's next ingest.
 */
async function pruneStatements(
  db: D1Database,
  guildId: string,
  now: number,
): Promise<{ statements: D1PreparedStatement[]; pruned: number }> {
  const cutoff = now - HISTORY_RETENTION_MS;
  const { results } = await db
    .prepare(
      "SELECT message_id FROM guild_messages WHERE guild_id = ?1 AND created_at < ?2 ORDER BY created_at LIMIT ?3",
    )
    .bind(guildId, cutoff, PRUNE_BATCH_SIZE)
    .all<{ message_id: string }>();
  const expiredIds = (results ?? []).map((row) => row.message_id);
  if (expiredIds.length === 0) return { statements: [], pruned: 0 };
  return {
    statements: [
      db
        .prepare(
          "DELETE FROM guild_messages WHERE guild_id = ?1 AND created_at < ?2 AND message_id IN (SELECT value FROM json_each(?3))",
        )
        .bind(guildId, cutoff, JSON.stringify(expiredIds)),
      db
        .prepare(
          "DELETE FROM guild_messages_fts WHERE guild_id = ?1 AND rowid IN (SELECT CAST(value AS INTEGER) FROM json_each(?2))",
        )
        .bind(guildId, JSON.stringify(expiredIds.map(ftsRowId))),
    ],
    pruned: expiredIds.length,
  };
}

function chunks<T>(items: readonly T[], size: number): T[][] {
  const groups: T[][] = [];
  for (let i = 0; i < items.length; i += size) groups.push(items.slice(i, i + size));
  return groups;
}

/**
 * Index a batch of guild message changes (`POST /internal/v1/messages/ingest`).
 *
 * Only messages of channels the guild allows the bot in are stored, under the
 * guild's `enabled` switch; the rest are counted as skipped. Deletes are
 * always carried out, and last, so a deleted message leaves the index even
 * when the same request also upserts it. Every write is idempotent, so a
 * request that fails halfway can simply be sent again. Never throws: a bad
 * payload answers `invalid_body`, a failed write `ingest_failed`.
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

    const { statements: prune, pruned } = await pruneStatements(db, guildId, now);
    for (const batch of chunks(stored, UPSERTS_PER_BATCH)) {
      await db.batch(batch.flatMap((message) => upsertStatements(db, guildId, message)));
    }
    const removals = deletes.size > 0 ? deleteStatements(db, guildId, [...deletes]) : [];
    if (removals.length > 0 || prune.length > 0) await db.batch([...removals, ...prune]);

    console.log(
      JSON.stringify({
        event: "history_ingest",
        guildId,
        channelIds: [...channelIds],
        upserted: stored.length,
        deleted: deletes.size,
        skipped: upserts.length - stored.length,
        rejected,
        pruned,
        durationMs: Date.now() - startedAt,
      }),
    );
    return {
      status: "ok",
      upserted: stored.length,
      deleted: deletes.size,
      skipped: upserts.length - stored.length,
      rejected,
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
 * Scoped to the guild, the 90-day window, and the channel allowlist. With
 * `beforeMessageId`, only messages older than that one — the next page back.
 */
export async function getRecentIndexedMessages(
  db: D1Database,
  query: RecentMessagesQuery,
): Promise<IndexedMessage[]> {
  if (query.allowedChannels?.length === 0) return [];
  const bind = new Binds();
  const guild = bind.add(query.guildId);
  const where = [
    `gm.guild_id = ${guild}`,
    `gm.created_at >= ${bind.add(query.now - HISTORY_RETENTION_MS)}`,
    `gm.channel_id = ${bind.add(query.channelId)}`,
  ];
  if (query.beforeMessageId !== undefined) {
    const anchor = `SELECT created_at, message_id FROM guild_messages WHERE guild_id = ${guild} AND message_id = ${bind.add(query.beforeMessageId)}`;
    where.push(`(gm.created_at, gm.message_id) < (${anchor})`);
  }
  const allowlist = allowlistTerm(bind, query.allowedChannels, "gm.");
  if (allowlist !== null) where.push(allowlist);

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
 * Scoped to the guild, the 90-day window, and the channel allowlist; narrower
 * with a channel, an author name, and a time range.
 */
export async function searchIndexedMessages(
  db: D1Database,
  query: SearchMessagesQuery,
): Promise<IndexedMessage[]> {
  const match = buildFtsQuery(query.query);
  if (match === null || query.allowedChannels?.length === 0) return [];
  const since = query.now - HISTORY_RETENTION_MS;
  if (query.beforeMs !== undefined && query.beforeMs <= since) return [];

  const bind = new Binds();
  const where = [
    `guild_messages_fts MATCH ${bind.add(match)}`,
    `gm.guild_id = ${bind.add(query.guildId)}`,
    `gm.created_at >= ${bind.add(Math.max(query.afterMs ?? since, since))}`,
  ];
  if (query.beforeMs !== undefined) where.push(`gm.created_at < ${bind.add(query.beforeMs)}`);
  if (query.channelId !== undefined) where.push(`gm.channel_id = ${bind.add(query.channelId)}`);
  const allowlist = allowlistTerm(bind, query.allowedChannels, "gm.");
  if (allowlist !== null) where.push(allowlist);

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
       JOIN guild_messages AS gm ON gm.message_id = fts.message_id
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
 * allowed channel — otherwise nothing is returned, without saying which.
 */
export async function getIndexedMessageContext(
  db: D1Database,
  query: MessageContextQuery,
): Promise<IndexedContextMessage[]> {
  if (query.allowedChannels?.length === 0) return [];
  const since = query.now - HISTORY_RETENTION_MS;
  const bind = new Binds();
  const where = [
    `gm.guild_id = ${bind.add(query.guildId)}`,
    `gm.message_id = ${bind.add(query.messageId)}`,
    `gm.created_at >= ${bind.add(since)}`,
  ];
  const allowlist = allowlistTerm(bind, query.allowedChannels, "gm.");
  if (allowlist !== null) where.push(allowlist);
  const anchor = await db
    .prepare(`SELECT ${GM_COLUMNS} FROM guild_messages AS gm WHERE ${where.join(" AND ")}`)
    .bind(...bind.values)
    .first<MessageRow>();
  if (!anchor) return [];

  // The anchor's channel passed the allowlist, so its neighbours need no check of their own.
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
      .bind(query.guildId, anchor.channel_id, since, anchor.created_at, anchor.message_id, count)
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
