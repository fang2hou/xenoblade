import type {
  ContextClearRequest,
  MemoryCategory,
  UserMemory,
} from "@xenoblade/contracts";
import type { SummonKind } from "@xenoblade/contracts";

// ── Budget & session constants ────────────────────────────────────────────

/** Tokens reserved per generation as a conservative budget hold. */
export const RESERVATION_TOKENS = 1024;

/** Rolling window over which generation budget is enforced (24h). */
export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Maximum reserved tokens allowed within the rolling window. */
export const BUDGET_MAX_TOKENS = 200_000;

/** Active-session window for per-user context state. */
export const SESSION_TTL_MS = 30 * 60 * 1000;

export const DM_SCOPE = "dm";

// ── Errors ────────────────────────────────────────────────────────────────

/**
 * Thrown by {@link reserveGeneration} when the rolling-window token budget
 * would be exceeded. Carries a stable code for telemetry.
 */
export class GenerationBudgetExceededError extends Error {
  readonly code = "AI_GENERATION_BUDGET_EXCEEDED";
  constructor(message = "AI_GENERATION_BUDGET_EXCEEDED") {
    super(message);
    this.name = "GenerationBudgetExceededError";
  }
}

// ── Runtime configuration ─────────────────────────────────────────────────

export interface RuntimeConfig {
  enabled: boolean;
  channelAllowed: boolean;
}

type GuildConfigRow = {
  enabled: number;
  allow_channels_json: string | null;
};

/** Type guard: true when `value` is an array of strings. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * Resolve runtime config for a scope/channel. Fail-closed: any D1 error
 * returns `enabled: false` so generation never runs against unreadable config.
 *
 * - DM scope ({@link DM_SCOPE}): reads `bot_config.dm_enabled` (missing ⇒ enabled).
 * - Guild scope: no `guild_config` row ⇒ enabled + all channels allowed.
 *   A non-null `allow_channels_json` restricts to the listed channel ids.
 */
export async function getRuntimeConfig(
  db: D1Database,
  scopeId: string,
  channelId: string,
): Promise<RuntimeConfig> {
  const open: RuntimeConfig = { enabled: true, channelAllowed: true };

  try {
    if (scopeId === DM_SCOPE) {
      const row = await db
        .prepare("SELECT value FROM bot_config WHERE key = 'dm_enabled'")
        .first<{ value?: string }>();
      const enabled = row?.value === undefined ? true : row.value === "1";
      return { ...open, enabled };
    }

    const guild = await db
      .prepare("SELECT enabled, allow_channels_json FROM guild_config WHERE guild_id = ?1")
      .bind(scopeId)
      .first<GuildConfigRow>();
    if (!guild) {
      return open;
    }

    const enabled = guild.enabled !== 0;
    let channelAllowed = true;
    if (guild.allow_channels_json !== null) {
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(guild.allow_channels_json);
      } catch {
        parsed = null;
      }
      channelAllowed = isStringArray(parsed) && parsed.includes(channelId);
    }
    return { enabled, channelAllowed };
  } catch {
    return { enabled: false, channelAllowed: false };
  }
}

// ── De-duplication ────────────────────────────────────────────────────────

/**
 * De-duplicate delivery. Returns true the first time a message id is seen,
 * false on repeats. `claim_key` mirrors `message_id` here — the Runtime always
 * sends one request per Discord message.
 */
export async function claimMessage(
  db: D1Database,
  messageId: string,
  now: number,
): Promise<boolean> {
  const res = await db
    .prepare(
      "INSERT OR IGNORE INTO processed_messages (message_id, claim_key, created_at) VALUES (?1, ?2, ?3)",
    )
    .bind(messageId, messageId, now)
    .run();
  return res.meta.changes > 0;
}

// ── Generation budget ─────────────────────────────────────────────────────

/**
 * Atomically reserve generation budget for a container within a 24h rolling
 * window. Cleans expired reservations first (same batch), then inserts only if
 * the window total + {@link RESERVATION_TOKENS} stays within
 * {@link BUDGET_MAX_TOKENS}. Throws {@link GenerationBudgetExceededError}
 * otherwise.
 */
export async function reserveGeneration(
  db: D1Database,
  containerId: string,
  createdAt: number,
): Promise<{ reservationId: number; maxOutputTokens: number }> {
  const since = createdAt - BUDGET_WINDOW_MS;
  const results = await db.batch([
    db.prepare("DELETE FROM generation_reservations WHERE created_at < ?1").bind(since),
    db
      .prepare(
        `INSERT INTO generation_reservations (container_id, reserved_tokens, created_at)
         SELECT ?1, ?2, ?3
         WHERE (
           SELECT COALESCE(SUM(reserved_tokens), 0)
           FROM generation_reservations
           WHERE created_at >= ?4
         ) + ?2 <= ?5
         RETURNING reservation_id`,
      )
      .bind(containerId, RESERVATION_TOKENS, createdAt, since, BUDGET_MAX_TOKENS),
  ]);

  const insert = results[1];
  if (insert.meta.changes === 0) {
    throw new GenerationBudgetExceededError();
  }
  const id = insert.meta.last_row_id;
  if (typeof id !== "number" || id <= 0) {
    throw new GenerationBudgetExceededError();
  }
  return { reservationId: id, maxOutputTokens: RESERVATION_TOKENS };
}

/** Mark a reservation finalized by stamping `finalized_at`. */
export async function finishGeneration(
  db: D1Database,
  reservationId: number,
  now: number,
): Promise<void> {
  await db
    .prepare("UPDATE generation_reservations SET finalized_at = ?1 WHERE reservation_id = ?2")
    .bind(now, reservationId)
    .run();
}

// ── Interaction telemetry ─────────────────────────────────────────────────

export interface InteractionRecord {
  id: string;
  containerId: string;
  scopeId: string;
  userId: string;
  summonKind: SummonKind;
  model: string;
  status: "completed" | "failed" | "timeout" | "budget_exceeded";
  inputTokens?: number | null;
  outputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  totalDurationMs?: number | null;
  createdAt: number;
}

/** Persist one interaction telemetry row against the new `interactions` schema. */
export async function recordInteraction(db: D1Database, row: InteractionRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO interactions
        (id, container_id, scope_id, user_id, summon_kind, model, status,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         total_duration_ms, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)`,
    )
    .bind(
      row.id,
      row.containerId,
      row.scopeId,
      row.userId,
      row.summonKind,
      row.model,
      row.status,
      row.inputTokens ?? null,
      row.outputTokens ?? null,
      row.cacheReadTokens ?? null,
      row.cacheWriteTokens ?? null,
      row.totalDurationMs ?? null,
      row.createdAt,
    )
    .run();
}

// ── Tool invocation telemetry ─────────────────────────────────────────────

export interface ToolInvocationRecord {
  id: string;
  interactionId: string;
  toolName: string;
  /** MCP server name or "builtin" for first-party tools. */
  server: string;
  status: "ok" | "error" | "timeout";
  durationMs?: number | null;
  inputSize?: number | null;
  outputSize?: number | null;
  errorCode?: string | null;
  createdAt: number;
}

/** Persist one tool invocation audit row. */
export async function recordToolInvocation(
  db: D1Database,
  row: ToolInvocationRecord,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO tool_invocations
        (id, interaction_id, tool_name, server, status,
         duration_ms, input_size, output_size, error_code, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      row.id,
      row.interactionId,
      row.toolName,
      row.server,
      row.status,
      row.durationMs ?? null,
      row.inputSize ?? null,
      row.outputSize ?? null,
      row.errorCode ?? null,
      row.createdAt,
    )
    .run();
}

// ── Per-user context state ────────────────────────────────────────────────

export interface UserContextState {
  resetAt: number;
  lastInteractionAt: number | null;
  /** Whether the user has an active session (interaction within TTL). */
  active: boolean;
}

/**
 * Read per-user, per-container context state. Returns a default
 * `{ resetAt: 0, lastInteractionAt: null, active: false }` when no row exists.
 * Fail-closed: on any D1 error returns a freshly-reset state (`resetAt = now`,
 * inactive) so generation degrades to current-message-only instead of leaking
 * history.
 */
export async function getUserContextState(
  db: D1Database,
  key: { scopeId: string; containerId: string; userId: string },
): Promise<UserContextState> {
  const now = Date.now();
  try {
    const res = await db
      .prepare(
        `SELECT reset_at AS resetAt, last_interaction_at AS lastInteractionAt
         FROM user_context_state
         WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3`,
      )
      .bind(key.scopeId, key.containerId, key.userId)
      .first<{ resetAt: number; lastInteractionAt: number | null }>();
    if (!res) {
      return { resetAt: 0, lastInteractionAt: null, active: false };
    }
    const lastInteractionAt = res.lastInteractionAt ?? null;
    const active = lastInteractionAt !== null && now - lastInteractionAt < SESSION_TTL_MS;
    return { resetAt: res.resetAt, lastInteractionAt, active };
  } catch (error) {
    console.log(JSON.stringify({ event: "context_state_read_error", error: String(error) }));
    return { resetAt: now, lastInteractionAt: null, active: false };
  }
}

/**
 * Persistently clear context, setting `reset_at` forward and nulling
 * `last_interaction_at` for every matching row. Only rows whose current
 * `reset_at` is older than the threshold are affected (a harder reset is never
 * relaxed). Returns the number of rows cleared.
 *
 * - `scope: "user"` — this user in this container.
 * - `scope: "channel"` — every user in this container.
 * - `scope: "all"` — this user across every container/scope.
 *
 * `beforeMs`, when set, clears only messages older than `now - beforeMs` by
 * using that cutoff as the threshold instead of `now`.
 */
export async function clearUserContext(
  db: D1Database,
  req: ContextClearRequest,
): Promise<number> {
  const now = Date.now();
  const threshold = req.beforeMs !== undefined ? now - req.beforeMs : now;

  const stmt =
    req.scope === "user"
      ? db
          .prepare(
            `UPDATE user_context_state
               SET reset_at = ?4, last_interaction_at = NULL
             WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3
               AND reset_at < ?4`,
          )
          .bind(req.scopeId, req.containerId, req.userId, threshold)
      : req.scope === "channel"
        ? db
            .prepare(
              `UPDATE user_context_state
                 SET reset_at = ?3, last_interaction_at = NULL
               WHERE scope_id = ?1 AND container_id = ?2 AND reset_at < ?3`,
            )
            .bind(req.scopeId, req.containerId, threshold)
        : db
            .prepare(
              `UPDATE user_context_state
                 SET reset_at = ?2, last_interaction_at = NULL
               WHERE user_id = ?1 AND reset_at < ?2`,
            )
            .bind(req.userId, threshold);

  try {
    const res = await stmt.run();
    return res.meta.changes;
  } catch (error) {
    console.log(JSON.stringify({ event: "context_clear_error", error: String(error) }));
    return 0;
  }
}

/**
 * Record that a user interacted in a container, updating
 * `last_interaction_at`. Never overwrites an existing `reset_at`. On error,
 * logs and swallows: a telemetry failure must not revoke an already-built reply.
 */
export async function markUserInteraction(
  db: D1Database,
  key: { scopeId: string; containerId: string; userId: string; now: number },
): Promise<void> {
  try {
    await db
      .prepare(
        `INSERT INTO user_context_state
           (scope_id, container_id, user_id, reset_at, last_interaction_at)
         VALUES (?1, ?2, ?3, 0, ?4)
         ON CONFLICT(scope_id, container_id, user_id) DO UPDATE SET
           last_interaction_at = excluded.last_interaction_at`,
      )
      .bind(key.scopeId, key.containerId, key.userId, key.now)
      .run();
  } catch (error) {
    console.log(JSON.stringify({ event: "context_state_mark_error", error: String(error) }));
  }
}

// ── User memory ───────────────────────────────────────────────────────────

type MemoryRow = {
  category: MemoryCategory;
  key: string;
  value: string;
  updated_at: number;
};

function toUserMemory(row: MemoryRow): UserMemory {
  return {
    category: row.category,
    key: row.key,
    value: row.value,
    updatedAt: row.updated_at,
  };
}

/** Read every stored memory for a user, newest first. */
export async function getUserMemory(db: D1Database, userId: string): Promise<UserMemory[]> {
  try {
    const { results } = await db
      .prepare(
        "SELECT category, key, value, updated_at FROM user_memory WHERE user_id = ?1 ORDER BY updated_at DESC",
      )
      .bind(userId)
      .all<MemoryRow>();
    return (results ?? []).map(toUserMemory);
  } catch (error) {
    console.log(JSON.stringify({ event: "memory_read_error", error: String(error) }));
    return [];
  }
}

/** Upsert a single memory entry (created_at set on insert, updated_at always). */
export async function setUserMemory(
  db: D1Database,
  entry: { userId: string; category: MemoryCategory; key: string; value: string },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO user_memory (user_id, category, key, value, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)
       ON CONFLICT(user_id, category, key) DO UPDATE SET
         value = excluded.value, updated_at = excluded.updated_at`,
    )
    .bind(entry.userId, entry.category, entry.key, entry.value, now)
    .run();
}

/**
 * Clear memories for a user. When `category` and/or `key` are given, only the
 * matching subset is deleted; otherwise everything for the user. Returns the
 * number of rows deleted.
 */
export async function clearUserMemory(
  db: D1Database,
  entry: { userId: string; category?: MemoryCategory; key?: string },
): Promise<number> {
  const stmt =
    entry.category !== undefined && entry.key !== undefined
      ? db
          .prepare("DELETE FROM user_memory WHERE user_id = ?1 AND category = ?2 AND key = ?3")
          .bind(entry.userId, entry.category, entry.key)
      : entry.category !== undefined
        ? db
            .prepare("DELETE FROM user_memory WHERE user_id = ?1 AND category = ?2")
            .bind(entry.userId, entry.category)
        : db.prepare("DELETE FROM user_memory WHERE user_id = ?1").bind(entry.userId);

  const res = await stmt.run();
  return res.meta.changes;
}
