import type {
  ThreadSession,
  ThreadSessionRequest,
  ThreadSessionResponse,
} from "@xenoblade/contracts";

import { DM_SCOPE } from "./db";
import { isRecord } from "./guards";

// ── Thread sessions ───────────────────────────────────────────────────────

/** What every op that can create a session row knows about a thread. */
export interface ThreadSessionKey {
  threadId: string;
  guildId: string;
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

/** The session of a thread, or null when it was never registered. */
export async function getThreadSession(
  db: D1Database,
  threadId: string,
): Promise<ThreadSession | null> {
  const row = await db
    .prepare(
      `SELECT thread_id, guild_id, parent_channel_id, active, pending_card_ids_json
       FROM thread_sessions WHERE thread_id = ?1`,
    )
    .bind(threadId)
    .first<ThreadSessionRow>();
  return row === null ? null : toSession(row);
}

/**
 * Create a thread's session, or set whether the bot follows the thread. A
 * thread that already has a row keeps everything else on it: the user who
 * first summoned in it, and the cards it is waiting on.
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
         updated_at = excluded.updated_at`,
    )
    .bind(key.threadId, key.guildId, key.parentChannelId, key.createdBy, active ? 1 : 0, now)
    .run();
}

/**
 * Add a question card to the thread's waiting list. The append and the
 * duplicate check are one statement, so two cards posted together cannot
 * overwrite each other's entry. Returns false when the thread has no session
 * to record the card in — nothing was stored.
 */
export async function addPendingCard(
  db: D1Database,
  entry: { threadId: string; cardMessageId: string; now: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE thread_sessions
         SET pending_card_ids_json = json_insert(pending_card_ids_json, '$[#]', ?2),
             updated_at = ?3
       WHERE thread_id = ?1
         AND NOT EXISTS (
           SELECT 1 FROM json_each(thread_sessions.pending_card_ids_json) WHERE value = ?2
         )`,
    )
    .bind(entry.threadId, entry.cardMessageId, entry.now)
    .run();
  return result.meta.changes > 0;
}

/** Forget every question card the thread was waiting on. Returns false when it has no session. */
export async function clearPendingCards(
  db: D1Database,
  entry: { threadId: string; now: number },
): Promise<boolean> {
  const result = await db
    .prepare(
      "UPDATE thread_sessions SET pending_card_ids_json = '[]', updated_at = ?2 WHERE thread_id = ?1",
    )
    .bind(entry.threadId, entry.now)
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
  if (request.op === "get") return getThreadSession(db, request.threadId);

  if (request.op === "add_card") {
    await addPendingCard(db, {
      threadId: request.threadId,
      cardMessageId: request.cardMessageId,
      now,
    });
    return getThreadSession(db, request.threadId);
  }

  if (request.op === "clear_cards") {
    await clearPendingCards(db, { threadId: request.threadId, now });
    return getThreadSession(db, request.threadId);
  }

  // upsert follows the thread; set_active takes the flag it was given.
  await setThreadActive(db, request, request.op === "upsert" ? true : request.active, now);
  return getThreadSession(db, request.threadId);
}

/** A well-formed request, or null. Every field is checked: the body is JSON from the wire. */
function parseThreadStateRequest(req: unknown): ThreadSessionRequest | null {
  if (!isRecord(req) || typeof req.op !== "string" || !isId(req.threadId)) return null;

  if (req.op === "get") return { op: "get", threadId: req.threadId };
  if (req.op === "add_card") {
    return isId(req.cardMessageId)
      ? { op: "add_card", threadId: req.threadId, cardMessageId: req.cardMessageId }
      : null;
  }
  if (req.op === "clear_cards") return { op: "clear_cards", threadId: req.threadId };

  // upsert and set_active can create the row, so both name the thread's guild and parent.
  if (req.op !== "upsert" && req.op !== "set_active") return null;
  if (!isId(req.guildId) || req.guildId === DM_SCOPE) return null;
  if (!isId(req.parentChannelId) || !isId(req.createdBy)) return null;
  const key = {
    threadId: req.threadId,
    guildId: req.guildId,
    parentChannelId: req.parentChannelId,
    createdBy: req.createdBy,
  };
  if (req.op === "upsert") return { op: "upsert", ...key };
  return typeof req.active === "boolean" ? { op: "set_active", ...key, active: req.active } : null;
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
  triggerContent: string;
  assistantReply: string;
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
          trigger_message_id, trigger_content, assistant_reply, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
       ON CONFLICT(container_id) DO UPDATE SET
         scope_id = excluded.scope_id,
         channel_id = excluded.channel_id,
         user_id = excluded.user_id,
         user_display_name = excluded.user_display_name,
         trigger_message_id = excluded.trigger_message_id,
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
      turn.triggerContent,
      turn.assistantReply,
      now,
    )
    .run();
}

/**
 * Replace only the reply of a conversation's latest turn: a retry answers the
 * same prompt again, so the prompt stays the one the user actually wrote.
 * A conversation with no stored turn gets none from this. A DM is never
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
    .bind(entry.containerId, entry.assistantReply, now)
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
              trigger_message_id, trigger_content, assistant_reply, updated_at
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
    triggerContent: row.trigger_content,
    assistantReply: row.assistant_reply,
    updatedAt: row.updated_at,
  };
}
