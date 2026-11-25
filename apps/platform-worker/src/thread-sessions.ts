import type {
  ChannelAllowedResponse,
  ThreadSession,
  ThreadSessionRequest,
  ThreadSessionResponse,
} from "@xenoblade/contracts";

import { DM_SCOPE, getRuntimeConfig } from "./db";
import { isRecord } from "./guards";

// ── Thread sessions ───────────────────────────────────────────────────────

/** What names a thread to the Worker: its own id and its guild's — no session is read or changed on one without the other. */
export interface ThreadSessionRef {
  threadId: string;
  guildId: string;
}

/** What every op that can create a session row knows about a thread. */
export interface ThreadSessionKey extends ThreadSessionRef {
  parentChannelId: string;
  /** The user whose summon started or resumed the thread. */
  createdBy: string;
}

type ThreadSessionRow = {
  thread_id: string;
  guild_id: string;
  parent_channel_id: string;
  active: number;
  pending_card_ids_json: string;
};

/** Most card ids one request may clear. */
const MAX_CLEARED_CARDS = 16;

/** Type guard: a non-empty id of a plausible length. */
function isId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= 128;
}

/** The stored card list as written by this module; anything else reads as empty. */
function parseCardIds(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) return [];
    return parsed;
  } catch {
    return [];
  }
}

function toSession(row: ThreadSessionRow): ThreadSession {
  return {
    threadId: row.thread_id,
    guildId: row.guild_id,
    parentChannelId: row.parent_channel_id,
    active: row.active === 1,
    pendingCardIds: parseCardIds(row.pending_card_ids_json),
  };
}

/**
 * The session of a thread of the given guild, or null when that guild has
 * none for it. A thread id another guild owns reads as unregistered.
 */
export async function getThreadSession(
  db: D1Database,
  ref: ThreadSessionRef,
): Promise<ThreadSession | null> {
  const row = await db
    .prepare(
      `SELECT thread_id, guild_id, parent_channel_id, active, pending_card_ids_json
       FROM thread_sessions WHERE thread_id = ?1 AND guild_id = ?2`,
    )
    .bind(ref.threadId, ref.guildId)
    .first<ThreadSessionRow>();
  return row === null ? null : toSession(row);
}

/**
 * Create a thread's session, or set whether the bot follows the thread. A
 * thread that already has a row keeps everything else on it: the user who
 * first summoned in it, and the cards it is waiting on. The row belongs to
 * the guild that registered it — a summon from any other guild changes
 * nothing, and reads back as no session at all.
 */
export async function setThreadActive(
  db: D1Database,
  key: ThreadSessionKey,
  active: boolean,
  now: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO thread_sessions
         (thread_id, guild_id, parent_channel_id, created_by, active,
          pending_card_ids_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '[]', ?6, ?6)
       ON CONFLICT(thread_id) DO UPDATE SET
         active = excluded.active,
         updated_at = excluded.updated_at
       WHERE thread_sessions.guild_id = excluded.guild_id`,
    )
    .bind(key.threadId, key.guildId, key.parentChannelId, key.createdBy, active ? 1 : 0, now)
    .run();
}

/**
 * Add a question card to the thread's waiting list. The append and the
 * duplicate check are one statement, so two cards posted together cannot
 * overwrite each other's entry. Returns false when the guild has no session
 * for the thread — nothing was stored.
 */
export async function addPendingCard(
  db: D1Database,
  entry: ThreadSessionRef & { cardMessageId: string; now: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE thread_sessions
         SET pending_card_ids_json = json_insert(pending_card_ids_json, '$[#]', ?3),
             updated_at = ?4
       WHERE thread_id = ?1 AND guild_id = ?2
         AND NOT EXISTS (
           SELECT 1 FROM json_each(thread_sessions.pending_card_ids_json) WHERE value = ?3
         )`,
    )
    .bind(entry.threadId, entry.guildId, entry.cardMessageId, entry.now)
    .run();
  return result.meta.changes > 0;
}

/**
 * Forget the listed question cards of the thread — and only those: a card
 * the Runtime could not delete from Discord stays listed, so a later turn
 * cleans it up. The removal is one statement, so a card added while this
 * runs is not lost. Returns false when the guild has no session for the
 * thread.
 */
export async function clearPendingCards(
  db: D1Database,
  entry: ThreadSessionRef & { clearedIds: readonly string[]; now: number },
): Promise<boolean> {
  const placeholders = entry.clearedIds.map((_, i) => `?${i + 4}`).join(", ");
  const result = await db
    .prepare(
      `UPDATE thread_sessions
         SET pending_card_ids_json = COALESCE(
               (SELECT json_group_array(value) FROM json_each(thread_sessions.pending_card_ids_json)
                 WHERE value NOT IN (${placeholders})),
               '[]'),
             updated_at = ?3
       WHERE thread_id = ?1 AND guild_id = ?2`,
    )
    .bind(entry.threadId, entry.guildId, entry.now, ...entry.clearedIds)
    .run();
  return result.meta.changes > 0;
}

/**
 * `POST /internal/v1/threads/state`: read or change one thread's session and
 * answer with the session as it stands afterwards. A body that is not a
 * well-formed request — or that names the DM scope, which owns no threads —
 * is `invalid_body`. Never throws — a failure returns `thread_state_failed`.
 */
export async function handleThreadState(
  db: D1Database,
  req: unknown,
  now = Date.now(),
): Promise<ThreadSessionResponse> {
  const request = parseThreadStateRequest(req);
  if (request === null) return { status: "error", code: "invalid_body" };

  try {
    return { status: "ok", session: await applyThreadState(db, request, now) };
  } catch (error) {
    console.log(
      JSON.stringify({ event: "thread_state_error", op: request.op, error: String(error) }),
    );
    return { status: "error", code: "thread_state_failed" };
  }
}

/** Carry out one well-formed request and answer with the session as it stands afterwards. */
async function applyThreadState(
  db: D1Database,
  request: ThreadSessionRequest,
  now: number,
): Promise<ThreadSession | null> {
  const ref: ThreadSessionRef = { threadId: request.threadId, guildId: request.guildId };

  if (request.op === "get") return getThreadSession(db, ref);

  if (request.op === "add_card") {
    await addPendingCard(db, { ...ref, cardMessageId: request.cardMessageId, now });
    return getThreadSession(db, ref);
  }

  if (request.op === "clear_cards") {
    await clearPendingCards(db, { ...ref, clearedIds: request.clearedIds, now });
    return getThreadSession(db, ref);
  }

  // upsert follows the thread; set_active takes the flag it was given.
  await setThreadActive(db, request, request.op === "upsert" ? true : request.active, now);
  return getThreadSession(db, ref);
}

/**
 * `POST /internal/v1/threads/allowed`: whether the generation gate would
 * answer in a channel at all. The Runtime asks before it starts a thread
 * there. Reads the same configuration the gate does, so the two can never
 * disagree about a channel; a body that is not a well-formed request, or
 * that names the DM scope, is `invalid_body`.
 */
export async function handleChannelAllowed(
  db: D1Database,
  req: unknown,
): Promise<ChannelAllowedResponse> {
  if (!isRecord(req) || !isId(req.guildId) || req.guildId === DM_SCOPE || !isId(req.channelId)) {
    return { status: "error", code: "invalid_body" };
  }
  const config = await getRuntimeConfig(db, req.guildId, req.channelId);
  return { status: "ok", allowed: config.enabled && config.channelAllowed };
}

/** A well-formed request, or null. Every field is checked: the body is JSON from the wire. */
function parseThreadStateRequest(req: unknown): ThreadSessionRequest | null {
  if (!isRecord(req) || typeof req.op !== "string" || !isId(req.threadId)) return null;
  // The DM scope owns no threads, so no op may name it.
  if (!isId(req.guildId) || req.guildId === DM_SCOPE) return null;
  const ref: ThreadSessionRef = { threadId: req.threadId, guildId: req.guildId };

  if (req.op === "get") return { op: "get", ...ref };
  if (req.op === "add_card") {
    return isId(req.cardMessageId)
      ? { op: "add_card", ...ref, cardMessageId: req.cardMessageId }
      : null;
  }
  if (req.op === "clear_cards") {
    const clearedIds = parseClearedIds(req.clearedIds);
    return clearedIds === null ? null : { op: "clear_cards", ...ref, clearedIds };
  }

  // upsert and set_active can create the row, so both name the thread's parent.
  if (req.op !== "upsert" && req.op !== "set_active") return null;
  if (!isId(req.parentChannelId) || !isId(req.createdBy)) return null;
  const key = { ...ref, parentChannelId: req.parentChannelId, createdBy: req.createdBy };
  if (req.op === "upsert") return { op: "upsert", ...key };
  return typeof req.active === "boolean" ? { op: "set_active", ...key, active: req.active } : null;
}

/** The card ids a clear may forget — a short list of ids with no repeats — or null. */
function parseClearedIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_CLEARED_CARDS) return null;
  if (!value.every(isId)) return null;
  const ids = new Set(value);
  return ids.size === value.length ? [...ids] : null;
}

// ── Last turn of a conversation ───────────────────────────────────────────

/** One completed turn: the message that prompted a reply, and that reply. */
export interface ContainerLastTurn {
  containerId: string;
  scopeId: string;
  channelId: string;
  userId: string;
  userDisplayName: string;
  triggerMessageId: string;
  /**
   * When the prompting message was sent. It stays the same for as long as the
   * conversation's stored turn is this one — a later retry moves neither the
   * prompt nor its time — so it is what the triggering user's context
   * watermark (ADR-014) is compared with.
   */
  triggerCreatedAt: number;
  triggerContent: string;
  assistantReply: string;
}

/** Longest prompt or reply text stored in `container_last_turns` (guards D1 row size & retry context). */
export const MAX_LAST_TURN_CONTENT_CHARS = 16_000;

const LAST_TURN_TRUNCATED_MARK = "…[truncated]";

function clampLastTurnText(text: string): string {
  const chars = Array.from(text);
  if (chars.length <= MAX_LAST_TURN_CONTENT_CHARS) return text;
  const keep = MAX_LAST_TURN_CONTENT_CHARS - Array.from(LAST_TURN_TRUNCATED_MARK).length;
  return `${chars.slice(0, keep).join("")}${LAST_TURN_TRUNCATED_MARK}`;
}

/**
 * Store a guild conversation's latest turn, replacing the one before it.
 *
 * A DM is never written (ADR-011): the function returns before it reaches D1,
 * whatever container it is handed, so `container_last_turns` holds guild
 * conversations only.
 */
export async function recordLastTurn(
  db: D1Database,
  turn: ContainerLastTurn,
  now: number,
): Promise<void> {
  if (turn.scopeId === DM_SCOPE) return;
  await db
    .prepare(
      `INSERT INTO container_last_turns
         (container_id, scope_id, channel_id, user_id, user_display_name,
          trigger_message_id, trigger_created_at, trigger_content, assistant_reply, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
       ON CONFLICT(container_id) DO UPDATE SET
         scope_id = excluded.scope_id,
         channel_id = excluded.channel_id,
         user_id = excluded.user_id,
         user_display_name = excluded.user_display_name,
         trigger_message_id = excluded.trigger_message_id,
         trigger_created_at = excluded.trigger_created_at,
         trigger_content = excluded.trigger_content,
         assistant_reply = excluded.assistant_reply,
         updated_at = excluded.updated_at`,
    )
    .bind(
      turn.containerId,
      turn.scopeId,
      turn.channelId,
      turn.userId,
      turn.userDisplayName,
      turn.triggerMessageId,
      turn.triggerCreatedAt,
      clampLastTurnText(turn.triggerContent),
      clampLastTurnText(turn.assistantReply),
      now,
    )
    .run();
}

/**
 * Replace only the reply of a conversation's latest turn: a retry answers the
 * same prompt again, so the prompt — and when it was sent — stay the user's
 * own. A conversation with no stored turn gets none from this. A DM is never
 * written, as in {@link recordLastTurn}.
 */
export async function recordLastReply(
  db: D1Database,
  entry: { containerId: string; scopeId: string; assistantReply: string },
  now: number,
): Promise<void> {
  if (entry.scopeId === DM_SCOPE) return;
  await db
    .prepare(
      "UPDATE container_last_turns SET assistant_reply = ?2, updated_at = ?3 WHERE container_id = ?1",
    )
    .bind(entry.containerId, clampLastTurnText(entry.assistantReply), now)
    .run();
}

/** The latest turn stored for a conversation, with the time its reply was stored. */
export type StoredLastTurn = ContainerLastTurn & { updatedAt: number };

/** The latest turn stored for a conversation, or null when there is none. */
export async function getLastTurn(
  db: D1Database,
  containerId: string,
): Promise<StoredLastTurn | null> {
  const row = await db
    .prepare(
      `SELECT container_id, scope_id, channel_id, user_id, user_display_name,
              trigger_message_id, trigger_created_at, trigger_content, assistant_reply, updated_at
       FROM container_last_turns WHERE container_id = ?1`,
    )
    .bind(containerId)
    .first<{
      container_id: string;
      scope_id: string;
      channel_id: string;
      user_id: string;
      user_display_name: string;
      trigger_message_id: string;
      trigger_created_at: number;
      trigger_content: string;
      assistant_reply: string;
      updated_at: number;
    }>();
  if (row === null) return null;
  return {
    containerId: row.container_id,
    scopeId: row.scope_id,
    channelId: row.channel_id,
    userId: row.user_id,
    userDisplayName: row.user_display_name,
    triggerMessageId: row.trigger_message_id,
    triggerCreatedAt: row.trigger_created_at,
    triggerContent: row.trigger_content,
    assistantReply: row.assistant_reply,
    updatedAt: row.updated_at,
  };
}
