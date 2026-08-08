import type { D1Database } from "@cloudflare/workers-types";

/**
 * Runtime config resolved from D1 for a given scope + channel.
 * `defaultSystemPrompt` is reserved for stage 2; always undefined in MVP.
 */
export type RuntimeConfig = {
  enabled: boolean;
  channelAllowed: boolean;
  defaultSystemPrompt: string | undefined;
};

export type InteractionKind = "mention" | "subscribed";
export type InteractionStatus = "success" | "error" | "cancelled";

export type InteractionRecord = {
  messageId: string;
  threadId: string;
  userId: string;
  scopeId: string;
  kind: InteractionKind;
  provider: string;
  model: string;
  status: InteractionStatus;
  requestedOutputTokens: number;
  completionTokens: number | null;
  costMicros: number | null;
  latencyMs: number | null;
  errorCode: string | null;
  createdAt: number;
};

/** Scope id used for direct messages (no guild). */
export const DM_SCOPE = "dm";

/** Tokens reserved per generation as a conservative budget. */
export const RESERVATION_TOKENS = 512 as const;

/** Rolling window over which generation budget is enforced. */
export const BUDGET_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Maximum reserved tokens allowed within the rolling window. */
export const BUDGET_MAX_TOKENS = 20_000;

/**
 * Thrown by {@link reserveGeneration} when the rolling-window token budget
 * would be exceeded. Carries a stable code for telemetry / tests.
 */
export class GenerationBudgetExceededError extends Error {
  readonly code = "AI_GENERATION_BUDGET_EXCEEDED";
  constructor(message = "AI_GENERATION_BUDGET_EXCEEDED") {
    super(message);
    this.name = "GenerationBudgetExceededError";
  }
}

type GuildConfigRow = {
  enabled: number;
  allow_channels_json: string | null;
};

/**
 * Resolve runtime config for a scope/channel. Fail-closed: any D1 error
 * returns `enabled: false` so generation never runs against unreadable config.
 *
 * - DM scope ({@link DM_SCOPE}) reads `bot_config.dm_enabled` (missing => enabled).
 * - Guild scope: no `guild_config` row => enabled + all channels allowed.
 *   A non-null `allow_channels_json` restricts to the listed channel ids.
 */
export async function getRuntimeConfig(
  db: D1Database,
  scopeId: string,
  channelId: string,
): Promise<RuntimeConfig> {
  const open: RuntimeConfig = {
    enabled: true,
    channelAllowed: true,
    defaultSystemPrompt: undefined,
  };

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
      channelAllowed =
        Array.isArray(parsed) &&
        parsed.every((v) => typeof v === "string") &&
        parsed.includes(channelId);
    }
    return { enabled, channelAllowed, defaultSystemPrompt: undefined };
  } catch {
    return { enabled: false, channelAllowed: false, defaultSystemPrompt: undefined };
  }
}

/**
 * De-duplicate Gateway message delivery. Returns true the first time a
 * message id is seen, false on repeats. Caller logs + skips on false.
 */
export async function claimMessage(
  db: D1Database,
  messageId: string,
  receivedAt: number,
): Promise<boolean> {
  const res = await db
    .prepare("INSERT OR IGNORE INTO processed_messages (message_id, received_at) VALUES (?1, ?2)")
    .bind(messageId, receivedAt)
    .run();
  return res.meta.changes > 0;
}

/**
 * Atomically reserve generation budget for a thread within a 24h rolling
 * window. Cleans expired reservations first (same batch), then inserts only
 * if the window total + {@link RESERVATION_TOKENS} stays within
 * {@link BUDGET_MAX_TOKENS}. Throws {@link GenerationBudgetExceededError}
 * otherwise.
 */
export async function reserveGeneration(
  db: D1Database,
  threadId: string,
  createdAt: number,
): Promise<{ reservationId: number; maxOutputTokens: typeof RESERVATION_TOKENS }> {
  const since = createdAt - BUDGET_WINDOW_MS;
  const results = await db.batch([
    db.prepare("DELETE FROM generation_reservations WHERE created_at < ?1").bind(since),
    db
      .prepare(
        `INSERT INTO generation_reservations (thread_id, reserved_tokens, created_at)
         SELECT ?1, ?2, ?3
         WHERE (
           SELECT COALESCE(SUM(reserved_tokens), 0)
           FROM generation_reservations
           WHERE created_at >= ?4
         ) + ?2 <= ?5
         RETURNING id`,
      )
      .bind(threadId, RESERVATION_TOKENS, createdAt, since, BUDGET_MAX_TOKENS),
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

/**
 * Back-fill actual provider usage onto a reservation. `consumedTokens` may be
 * null when the provider reports no usage; the reservation is kept as a
 * conservative budget in that case.
 */
export async function finishGeneration(
  db: D1Database,
  reservationId: number,
  consumedTokens: number | null,
): Promise<void> {
  await db
    .prepare("UPDATE generation_reservations SET consumed_tokens = ?1 WHERE id = ?2")
    .bind(consumedTokens, reservationId)
    .run();
}

/**
 * Persist one interaction telemetry row. Callers must pass a confirmed
 * `scope_id`; never write an interaction for an unresolved scope.
 */
export async function recordInteraction(db: D1Database, row: InteractionRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO interactions
        (message_id, thread_id, user_id, scope_id, kind, provider, model,
         status, requested_output_tokens, completion_tokens, cost_micros,
         latency_ms, error_code, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)`,
    )
    .bind(
      row.messageId,
      row.threadId,
      row.userId,
      row.scopeId,
      row.kind,
      row.provider,
      row.model,
      row.status,
      row.requestedOutputTokens,
      row.completionTokens,
      row.costMicros,
      row.latencyMs,
      row.errorCode,
      row.createdAt,
    )
    .run();
}
