import type {
  ContextClearRequest,
  MemoryCategory,
  UiLanguage,
  SummonKind,
  UsageSubjectSummary,
  UsageSummary,
  UserMemory,
  UserSettings,
} from "@xenoblade/contracts";

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

/** Map an optional boolean opt-in flag to a 0/1 SQL value (NULL = unchanged). */
function toFlag(value: boolean | undefined): number | null {
  return value === undefined ? null : value ? 1 : 0;
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

// ── Regenerate leases (ADR-015) ───────────────────────────────────────────

/**
 * How long an unreleased regenerate lease keeps blocking re-claims: a
 * concurrency guard that outlives any single run (ADR-003 milestones top
 * out at 90s plus model-chain retries), short enough that a crashed or
 * evicted run's lease self-heals without operator action.
 */
export const REGEN_LEASE_TTL_MS = 15 * 60 * 1000;

/**
 * Claim the regenerate lease for an original message: a concurrency/race
 * guard, not a lifetime cap. Returns true when this caller owns the re-run —
 * either a fresh insert, or a takeover of a lease whose holder never
 * released (crash, eviction). Racing duplicate deliveries are rejected;
 * sequential re-runs are always allowed and bounded only by the rolling
 * generation budget (reserve/finalize).
 *
 * The Worker releases the lease via {@link releaseRegenerate} once the run
 * settles; the TTL is the crash backstop.
 */
export async function claimRegenerate(
  db: D1Database,
  originalMessageId: string,
  now: number,
): Promise<boolean> {
  const expiresAt = now + REGEN_LEASE_TTL_MS;
  const inserted = await db
    .prepare(
      "INSERT OR IGNORE INTO regenerate_leases (original_message_id, expires_at) VALUES (?1, ?2)",
    )
    .bind(originalMessageId, expiresAt)
    .run();
  if (inserted.meta.changes > 0) return true;
  // Row exists: claim only when its holder's lease has expired.
  const taken = await db
    .prepare(
      "UPDATE regenerate_leases SET expires_at = ?2 WHERE original_message_id = ?1 AND expires_at <= ?3",
    )
    .bind(originalMessageId, expiresAt, now)
    .run();
  return taken.meta.changes > 0;
}

/**
 * Release a regenerate lease after its run settles, so the next deliberate
 * re-run is not stuck behind the TTL. Best-effort by the caller: a failed
 * release only means the lease lingers until expiry.
 */
export async function releaseRegenerate(db: D1Database, originalMessageId: string): Promise<void> {
  await db
    .prepare("DELETE FROM regenerate_leases WHERE original_message_id = ?1")
    .bind(originalMessageId)
    .run();
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
  if (insert === undefined || insert.meta.changes === 0) {
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

// ── Usage aggregation ─────────────────────────────────────────────────────

/** Most-invoked tools returned per usage subject. */
const USAGE_TOP_TOOLS_LIMIT = 5;

type UsageAggregateRow = {
  messages: number;
  generations: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

type UsageToolRow = { tool: string; count: number };

/**
 * Aggregate rolling-window usage for the requesting user and their guild.
 *
 * The window is {@link BUDGET_WINDOW_MS} (24h), matching the generation
 * budget so the numbers users see describe the same window that limits them.
 * `messages` counts deduped interactions (one row per processed trigger
 * message); `generations` counts those that completed with a reply. Token
 * totals are summed as recorded — NULLs read as 0, never fabricated.
 */
export async function getUsageSummary(
  db: D1Database,
  key: { userId: string; scopeId: string; now: number },
): Promise<UsageSummary> {
  const since = key.now - BUDGET_WINDOW_MS;
  const [user, guild] = [
    await summarizeUsageSubject(db, since, "user_id", key.userId),
    await summarizeUsageSubject(db, since, "scope_id", key.scopeId),
  ];
  return { windowMs: BUDGET_WINDOW_MS, user, guild };
}

async function summarizeUsageSubject(
  db: D1Database,
  since: number,
  predicateColumn: "user_id" | "scope_id",
  value: string,
): Promise<UsageSubjectSummary> {
  const aggregate = await db
    .prepare(
      `SELECT
         COUNT(*) AS messages,
         COALESCE(SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END), 0) AS generations,
         COALESCE(SUM(input_tokens), 0) AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens,
         COALESCE(SUM(cache_write_tokens), 0) AS cache_write_tokens
       FROM interactions
       WHERE created_at >= ?1 AND ${predicateColumn} = ?2`,
    )
    .bind(since, value)
    .first<UsageAggregateRow>();

  const topTools = await db
    .prepare(
      `SELECT ti.tool_name AS tool, COUNT(*) AS count
       FROM tool_invocations AS ti
       JOIN interactions AS i ON i.id = ti.interaction_id
       WHERE i.created_at >= ?1 AND i.${predicateColumn} = ?2
       GROUP BY ti.tool_name
       ORDER BY count DESC, ti.tool_name ASC
       LIMIT ${USAGE_TOP_TOOLS_LIMIT}`,
    )
    .bind(since, value)
    .all<UsageToolRow>();

  return {
    messages: aggregate?.messages ?? 0,
    generations: aggregate?.generations ?? 0,
    inputTokens: aggregate?.input_tokens ?? 0,
    outputTokens: aggregate?.output_tokens ?? 0,
    cacheReadTokens: aggregate?.cache_read_tokens ?? 0,
    cacheWriteTokens: aggregate?.cache_write_tokens ?? 0,
    topTools: topTools.results.map((row) => ({ tool: row.tool, count: row.count })),
  };
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
 * Persistently clear context. Two effects per matching row:
 *
 * 1. `reset_at` moves forward (guarded: a stronger watermark is never
 *    relaxed) and `last_interaction_at` is nulled — the visibility change.
 * 2. `hard_reset_at` is stamped with the threshold unconditionally for every
 *    row in scope — the irreversibility floor. Even when the watermark guard
 *    skips a row (its `reset_at` already sits above the threshold, e.g. after
 *    a stricter truncation), the clear still asserts "history below the
 *    threshold is gone" for that row, and `/context restore` must not be able
 *    to walk the watermark back past it (ADR-014).
 *
 * - `scope: "user"` — this user in this container.
 * - `scope: "channel"` — every user in this container.
 * - `scope: "all"` — this user across every container/scope.
 *
 * `beforeMs`, when set, clears only messages older than `now - beforeMs` by
 * using that cutoff as the threshold instead of `now`. Returns the number of
 * rows whose visibility actually changed.
 */
export async function clearUserContext(db: D1Database, req: ContextClearRequest): Promise<number> {
  const now = Date.now();
  const threshold = req.beforeMs !== undefined ? now - req.beforeMs : now;

  const scopePredicate =
    req.scope === "user"
      ? {
          where: "scope_id = ?1 AND container_id = ?2 AND user_id = ?3",
          binds: [req.scopeId, req.containerId, req.userId],
        }
      : req.scope === "channel"
        ? { where: "scope_id = ?1 AND container_id = ?2", binds: [req.scopeId, req.containerId] }
        : { where: "user_id = ?1", binds: [req.userId] };
  // Threshold takes the next parameter number after the scope binds.
  const thresholdParam = `?${scopePredicate.binds.length + 1}`;

  try {
    // Floor first, unconditionally for the whole scope.
    await db
      .prepare(
        `UPDATE user_context_state
            SET hard_reset_at = MAX(hard_reset_at, ${thresholdParam})
          WHERE ${scopePredicate.where}`,
      )
      .bind(...scopePredicate.binds, threshold)
      .run();
    const res = await db
      .prepare(
        `UPDATE user_context_state
            SET reset_at = ${thresholdParam}, last_interaction_at = NULL
          WHERE ${scopePredicate.where} AND reset_at < ${thresholdParam}`,
      )
      .bind(...scopePredicate.binds, threshold)
      .run();
    return res.meta.changes;
  } catch (error) {
    console.log(JSON.stringify({ event: "context_clear_error", error: String(error) }));
    return 0;
  }
}

// ── Undoable context truncation (ADR-014) ─────────────────────────────────

/** Context key shared by truncate and restore. */
export interface ContextKey {
  scopeId: string;
  containerId: string;
  userId: string;
}

async function countTruncations(db: D1Database, key: ContextKey): Promise<number> {
  const res = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM context_truncations
       WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3`,
    )
    .bind(key.scopeId, key.containerId, key.userId)
    .first<{ n: number }>();
  return res?.n ?? 0;
}

/**
 * Push an undo-able truncation: one `context_truncations` event at `now`,
 * plus the same watermark forward-move a clear performs (floor untouched).
 * Returns the cutoff set and how many truncations now sit on the undo stack.
 */
export async function truncateUserContext(
  db: D1Database,
  key: ContextKey,
): Promise<{ truncatedAt: number; remainingUndos: number }> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO context_truncations
         (scope_id, container_id, user_id, truncated_at, created_at)
       VALUES (?1, ?2, ?3, ?4, ?4)`,
    )
    .bind(key.scopeId, key.containerId, key.userId, now)
    .run();
  await db
    .prepare(
      `INSERT INTO user_context_state
         (scope_id, container_id, user_id, reset_at, last_interaction_at)
       VALUES (?1, ?2, ?3, ?4, NULL)
       ON CONFLICT(scope_id, container_id, user_id) DO UPDATE SET
         reset_at = excluded.reset_at,
         last_interaction_at = NULL
       WHERE user_context_state.reset_at < excluded.reset_at`,
    )
    .bind(key.scopeId, key.containerId, key.userId, now)
    .run();
  return { truncatedAt: now, remainingUndos: await countTruncations(db, key) };
}

/**
 * Pop the newest truncation event and recompute the effective cutoff as
 * `max(hard_reset_at, max(remaining truncated_at))` — a restore can walk back
 * undoable truncations but never crosses the hard floor a clear left behind.
 * `restored` is true only when the effective cutoff actually moved back.
 *
 * Concurrency: the recompute is one atomic UPDATE whose subqueries read the
 * live tables, so a racing truncate can never be clobbered by a stale
 * restore value (the old read→compute→write sequence could write a cutoff
 * computed before the truncate landed). The event delete targets the id
 * selected up front; if a racing restore already removed it, this delete is
 * a no-op and the watermark stays wherever the atomic recompute put it. The
 * floor is recomputed inside the statement, so the privacy invariant holds
 * under every interleaving; the worst race outcome is transient
 * over-exclusion that the next restore or truncate corrects.
 */
export async function restoreUserContext(
  db: D1Database,
  key: ContextKey,
): Promise<{ restored: boolean; remainingUndos: number }> {
  const latest = await db
    .prepare(
      `SELECT id FROM context_truncations
       WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3
       ORDER BY id DESC LIMIT 1`,
    )
    .bind(key.scopeId, key.containerId, key.userId)
    .first<{ id: number }>();
  if (latest === null) {
    return { restored: false, remainingUndos: 0 };
  }

  const before = await readResetAt(db, key);

  // Atomic recompute excluding the event this restore is about to pop. The
  // subqueries read the tables as of this statement, so concurrent writers
  // compose: truncates only raise the watermark, and the floor is always
  // taken from the row itself, never from a stale JS-side snapshot.
  await db
    .prepare(
      `INSERT INTO user_context_state
         (scope_id, container_id, user_id, reset_at, last_interaction_at)
       VALUES (?1, ?2, ?3,
               MAX(COALESCE((SELECT hard_reset_at FROM user_context_state
                              WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3), 0),
                   COALESCE((SELECT MAX(truncated_at) FROM context_truncations
                              WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3
                                AND id <> ?4), 0)),
               NULL)
       ON CONFLICT(scope_id, container_id, user_id) DO UPDATE SET
         reset_at = MAX(COALESCE(user_context_state.hard_reset_at, 0),
                        COALESCE((SELECT MAX(truncated_at) FROM context_truncations
                                   WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3
                                     AND id <> ?4), 0))`,
    )
    .bind(key.scopeId, key.containerId, key.userId, latest.id)
    .run();

  await db.prepare(`DELETE FROM context_truncations WHERE id = ?1`).bind(latest.id).run();

  const after = await readResetAt(db, key);
  return {
    restored: after < before,
    remainingUndos: await countTruncations(db, key),
  };
}

/** Current materialized watermark for a key; 0 when no row exists. */
async function readResetAt(db: D1Database, key: ContextKey): Promise<number> {
  const state = await db
    .prepare(
      `SELECT reset_at AS resetAt FROM user_context_state
       WHERE scope_id = ?1 AND container_id = ?2 AND user_id = ?3`,
    )
    .bind(key.scopeId, key.containerId, key.userId)
    .first<{ resetAt: number }>();
  return state?.resetAt ?? 0;
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
        : entry.key !== undefined
          ? db
              .prepare("DELETE FROM user_memory WHERE user_id = ?1 AND key = ?2")
              .bind(entry.userId, entry.key)
          : db.prepare("DELETE FROM user_memory WHERE user_id = ?1").bind(entry.userId);

  const res = await stmt.run();
  return res.meta.changes;
}

// ── Interaction sources (durable citation index, ADR-007 amendment) ───────

export interface StoredSource {
  title: string;
  url: string;
}

/**
 * Persist one generation's extracted sources (best-effort: a failure is
 * logged and swallowed — the reply is already delivered and only later
 * "where is the source" follow-ups lose coverage).
 */
export async function recordInteractionSources(
  db: D1Database,
  entry: {
    interactionId: string;
    containerId: string;
    sources: readonly StoredSource[];
    now: number;
  },
): Promise<void> {
  if (entry.sources.length === 0) return;
  try {
    for (const [i, source] of entry.sources.entries()) {
      await db
        .prepare(
          `INSERT INTO interaction_sources
             (interaction_id, container_id, idx, title, url, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
        )
        .bind(entry.interactionId, entry.containerId, i + 1, source.title, source.url, entry.now)
        .run();
    }
  } catch (error) {
    console.log(JSON.stringify({ event: "sources_record_error", error: String(error) }));
  }
}

/** How far back follow-up generations can still resolve cited sources. */
const SOURCES_WINDOW_MS = 24 * 60 * 60 * 1000;
/** Cap on re-injected sources per generation (most recent first). */
const SOURCES_INJECT_LIMIT = 15;

/**
 * Recently cited sources for a container, oldest first, deduplicated by URL.
 * Injected into later generations so "where is the source" questions stay
 * answerable without any rendered footer.
 */
export async function getRecentSources(
  db: D1Database,
  key: { containerId: string; now: number },
): Promise<StoredSource[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT title, url FROM interaction_sources
          WHERE container_id = ?1 AND created_at >= ?2
          ORDER BY created_at DESC, idx ASC
          LIMIT 200`,
      )
      .bind(key.containerId, key.now - SOURCES_WINDOW_MS)
      .all<{ title: string; url: string }>();
    const seen = new Set<string>();
    const recent: StoredSource[] = [];
    for (const row of results ?? []) {
      if (seen.has(row.url)) continue;
      seen.add(row.url);
      recent.push({ title: row.title, url: row.url });
      if (recent.length >= SOURCES_INJECT_LIMIT) break;
    }
    return recent.toReversed();
  } catch (error) {
    console.log(JSON.stringify({ event: "sources_read_error", error: String(error) }));
    return [];
  }
}

// ── User settings (opt-in flags) ──────────────────────────────────────────

type SettingsRow = {
  chatOptin: number;
  learnOptin: number;
  chatOptinAt: number | null;
  learnOptinAt: number | null;
  language: string;
};

/**
 * Read a user's opt-in settings. Fail-closed: a missing row or any D1 error
 * returns all-off defaults, so DM chat (ADR-011) never enables on a read
 * failure. Language falls back to zh on any unreadable value.
 */
export async function getUserSettings(db: D1Database, userId: string): Promise<UserSettings> {
  const off: UserSettings = {
    chatOptin: false,
    learnOptin: false,
    chatOptinAt: null,
    learnOptinAt: null,
    language: "zh",
  };
  try {
    const row = await db
      .prepare(
        `SELECT chat_optin AS chatOptin, learn_optin AS learnOptin,
                chat_optin_at AS chatOptinAt, learn_optin_at AS learnOptinAt,
                language AS language
         FROM user_settings WHERE user_id = ?1`,
      )
      .bind(userId)
      .first<SettingsRow>();
    if (!row) return off;
    return {
      chatOptin: row.chatOptin === 1,
      learnOptin: row.learnOptin === 1,
      chatOptinAt: row.chatOptinAt ?? null,
      learnOptinAt: row.learnOptinAt ?? null,
      language: row.language === "en" ? "en" : "zh",
    };
  } catch (error) {
    console.log(JSON.stringify({ event: "settings_read_error", error: String(error) }));
    return off;
  }
}

/**
 * Atomically upsert the opt-in flags present in `entry` (absent flags keep
 * their current value). Enabling stamps `*_optin_at = now`; disabling clears
 * it back to NULL, keeping flag ⇔ timestamp consistent. An absent `language`
 * keeps the stored language (zh on first insert).
 */
export async function setUserSettings(
  db: D1Database,
  entry: { userId: string; chatOptin?: boolean; learnOptin?: boolean; language?: UiLanguage },
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO user_settings (user_id, chat_optin, learn_optin, chat_optin_at, learn_optin_at, language)
       VALUES (?1, ?2, ?3, ?4, ?5, COALESCE(?10, 'zh'))
       ON CONFLICT(user_id) DO UPDATE SET
         chat_optin = COALESCE(?6, chat_optin),
         chat_optin_at = CASE
           WHEN ?6 = 1 THEN ?8
           WHEN ?6 = 0 THEN NULL
           ELSE chat_optin_at
         END,
         learn_optin = COALESCE(?7, learn_optin),
         learn_optin_at = CASE
           WHEN ?7 = 1 THEN ?9
           WHEN ?7 = 0 THEN NULL
           ELSE learn_optin_at
         END,
         language = COALESCE(?10, language)`,
    )
    .bind(
      entry.userId,
      toFlag(entry.chatOptin) ?? 0,
      toFlag(entry.learnOptin) ?? 0,
      entry.chatOptin ? now : null,
      entry.learnOptin ? now : null,
      toFlag(entry.chatOptin),
      toFlag(entry.learnOptin),
      now,
      now,
      entry.language ?? null,
    )
    .run();
}
