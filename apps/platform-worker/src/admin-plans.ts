import type {
  AdminActionPlan,
  AdminHttpMethod,
  AdminPlanCancelRequest,
  AdminPlanCancelResponse,
  AdminPlanClaimRequest,
  AdminPlanClaimResponse,
  AdminPlanCompleteRequest,
  AdminPlanCompleteResponse,
  AdminPlanGetRequest,
  AdminPlanGetResponse,
  AdminPlanStatus,
  AdminRestOperation,
  AdminRiskLevel,
  AdminStepResult,
  GenerationRequest,
} from "@xenoblade/contracts";

import { isRecord } from "./guards";

/** Approval window for a proposed server administration plan (10 minutes). */
export const ADMIN_PLAN_TTL_MS = 10 * 60 * 1000;

/** Maximum Discord REST write operations allowed in a single approval plan. */
export const MAX_ADMIN_OPERATIONS = 15;

/** Valid Discord Snowflake pattern (17–20 decimal digits). */
const SNOWFLAKE_RE = /^\d{17,20}$/;

/** Configured owner-approved server administration scope (both required). */
export interface AdminConfig {
  readonly guildId: string;
  readonly ownerUserId: string;
}

export function isSnowflake(value: unknown): value is string {
  return typeof value === "string" && SNOWFLAKE_RE.test(value);
}

/**
 * Resolve the Worker's admin gate from env. Fail-closed: returns `null` unless
 * both `ADMIN_GUILD_ID` and `ADMIN_OWNER_USER_ID` are valid Discord snowflakes.
 */
export function getAdminConfig(
  env: Pick<Env, "ADMIN_GUILD_ID" | "ADMIN_OWNER_USER_ID">,
): AdminConfig | null {
  const guildId = env.ADMIN_GUILD_ID?.trim();
  const ownerUserId = env.ADMIN_OWNER_USER_ID?.trim();
  if (!isSnowflake(guildId) || !isSnowflake(ownerUserId)) {
    return null;
  }
  return { guildId, ownerUserId };
}

/**
 * Four-factor fail-closed check deciding whether a generation turn is
 * authorized to inspect/plan server administration actions:
 * 1. Both `ADMIN_GUILD_ID` and `ADMIN_OWNER_USER_ID` configured;
 * 2. Request scope matches `ADMIN_GUILD_ID`;
 * 3. Triggering user matches `ADMIN_OWNER_USER_ID`;
 * 4. Runtime verified the channel/parent is private (`adminMode === true`),
 *    independently corroborated against `publicChannelIds`.
 */
export function isAdminSession(
  env: Pick<Env, "ADMIN_GUILD_ID" | "ADMIN_OWNER_USER_ID">,
  req: Pick<
    GenerationRequest,
    "scopeId" | "userId" | "channelId" | "parentChannelId" | "publicChannelIds" | "adminMode"
  >,
): boolean {
  if (req.adminMode !== true) return false;
  const cfg = getAdminConfig(env);
  if (cfg === null) return false;
  if (req.scopeId !== cfg.guildId) return false;
  if (req.userId !== cfg.ownerUserId) return false;
  if (req.publicChannelIds !== undefined) {
    if (req.publicChannelIds.includes(req.channelId)) return false;
    if (req.parentChannelId != null && req.publicChannelIds.includes(req.parentChannelId)) {
      return false;
    }
  }
  return true;
}

// ── Discord Permission Bitfields ──────────────────────────────────────────

/** Discord permission bit positions (REST v10). */
export const DISCORD_PERMISSION_BITS: Readonly<Record<string, bigint>> = {
  CreateInstantInvite: 1n << 0n,
  KickMembers: 1n << 1n,
  BanMembers: 1n << 2n,
  Administrator: 1n << 3n,
  ManageChannels: 1n << 4n,
  ManageGuild: 1n << 5n,
  AddReactions: 1n << 6n,
  ViewAuditLog: 1n << 7n,
  PrioritySpeaker: 1n << 8n,
  Stream: 1n << 9n,
  ViewChannel: 1n << 10n,
  SendMessages: 1n << 11n,
  SendTTSMessages: 1n << 12n,
  ManageMessages: 1n << 13n,
  EmbedLinks: 1n << 14n,
  AttachFiles: 1n << 15n,
  ReadMessageHistory: 1n << 16n,
  MentionEveryone: 1n << 17n,
  UseExternalEmojis: 1n << 18n,
  ViewGuildInsights: 1n << 19n,
  Connect: 1n << 20n,
  Speak: 1n << 21n,
  MuteMembers: 1n << 22n,
  DeafenMembers: 1n << 23n,
  MoveMembers: 1n << 24n,
  UseVAD: 1n << 25n,
  ChangeNickname: 1n << 26n,
  ManageNicknames: 1n << 27n,
  ManageRoles: 1n << 28n,
  ManageWebhooks: 1n << 29n,
  ManageGuildExpressions: 1n << 30n,
  UseApplicationCommands: 1n << 31n,
  RequestToSpeak: 1n << 32n,
  ManageEvents: 1n << 33n,
  ManageThreads: 1n << 34n,
  CreatePublicThreads: 1n << 35n,
  CreatePrivateThreads: 1n << 36n,
  UseExternalStickers: 1n << 37n,
  SendMessagesInThreads: 1n << 38n,
  UseEmbeddedActivities: 1n << 39n,
  ModerateMembers: 1n << 40n,
  ViewCreatorMonetizationAnalytics: 1n << 41n,
  UseSoundboard: 1n << 42n,
  CreateGuildExpressions: 1n << 43n,
  CreateEvents: 1n << 44n,
  UseExternalSounds: 1n << 45n,
  SendVoiceMessages: 1n << 46n,
  SendPolls: 1n << 49n,
  UseExternalApps: 1n << 50n,
};

/** Permissions whose grant or modification always classifies an operation as high risk. */
export const SENSITIVE_PERMISSION_NAMES: readonly string[] = [
  "Administrator",
  "ManageGuild",
  "ManageRoles",
  "ManageChannels",
  "BanMembers",
  "KickMembers",
  "ManageWebhooks",
  "MentionEveryone",
  "ManageThreads",
  "ModerateMembers",
  "ManageMessages",
  "ManageEvents",
  "ManageGuildExpressions",
];

const PERMISSION_LOOKUP: ReadonlyMap<string, { canonical: string; bit: bigint }> = new Map(
  Object.entries(DISCORD_PERMISSION_BITS).flatMap(([name, bit]) => {
    const snake = name
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
    return [
      [name.toLowerCase(), { canonical: name, bit }],
      [snake, { canonical: name, bit }],
    ];
  }),
);

/**
 * Convert human-readable permission names (PascalCase or SNAKE_CASE) into a
 * Discord REST v10 decimal bitfield string. Returns an error naming unknown
 * entries rather than silently ignoring them.
 */
export function encodePermissionNames(
  names: readonly string[],
): { ok: true; bitfield: string; canonical: string[] } | { ok: false; unknown: string[] } {
  let mask = 0n;
  const canonical: string[] = [];
  const unknown: string[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const key = raw
      .trim()
      .toLowerCase()
      .replace(/[\s-]+/g, "_");
    const hit = PERMISSION_LOOKUP.get(key) ?? PERMISSION_LOOKUP.get(key.replaceAll("_", ""));
    if (hit === undefined) {
      unknown.push(raw);
      continue;
    }
    if (!seen.has(hit.canonical)) {
      seen.add(hit.canonical);
      canonical.push(hit.canonical);
      mask |= hit.bit;
    }
  }
  if (unknown.length > 0) return { ok: false, unknown };
  return { ok: true, bitfield: mask.toString(10), canonical };
}

/** Decode any sensitive permissions present in a decimal bitfield string or number. */
export function decodeSensitivePermissions(raw: unknown): string[] {
  let mask: bigint;
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    mask = BigInt(raw.trim());
  } else if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    mask = BigInt(raw);
  } else {
    return [];
  }
  const found: string[] = [];
  for (const name of SENSITIVE_PERMISSION_NAMES) {
    const bit = DISCORD_PERMISSION_BITS[name];
    if (bit !== undefined && (mask & bit) !== 0n) {
      found.push(name);
    }
  }
  return found;
}

// ── Path Validation & Risk Classification ─────────────────────────────────

const UNSAFE_PATH_CHARS = /[\s?#\\]|%2e|%2f|%5c/i;
const VALID_PATH_SEGMENT = /^[A-Za-z0-9@._~-]+$/;
const VALID_INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/;

export type PathValidationResult =
  | { ok: true; normalizedPath: string }
  | { ok: false; reason: string };

export interface PathValidationOptions {
  method?: AdminHttpMethod;
  /** Active admin channel/thread, its parent channel, and parent category IDs. */
  protectedChannelIds?: readonly string[];
}

/**
 * Validate and normalize a Discord REST v10 path against strict guild-scoped
 * allowlist rules and anti-lockout guards.
 */
export function validateAdminRestPath(
  rawPath: string,
  cfg: AdminConfig,
  mode: "read" | "write",
  options: PathValidationOptions = {},
): PathValidationResult {
  const { method, protectedChannelIds = [] } = options;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/") || trimmed.length > 256) {
    return { ok: false, reason: "invalid_path" };
  }
  if (UNSAFE_PATH_CHARS.test(trimmed)) {
    return { ok: false, reason: "unsafe_path_chars" };
  }

  const withoutApi = trimmed.replace(/^\/api\/v\d+(?=\/)/i, "");
  const segments = withoutApi.split("/").filter((s) => s.length > 0);
  if (segments.length < 2 || segments.length > 8) {
    return { ok: false, reason: "invalid_path_depth" };
  }
  for (const seg of segments) {
    if (seg === "." || seg === ".." || !VALID_PATH_SEGMENT.test(seg)) {
      return { ok: false, reason: "invalid_path_segment" };
    }
  }
  const normalizedPath = `/${segments.join("/")}`;
  const [root, targetId, sub1, sub2] = segments;

  if (root === "guilds") {
    if (targetId !== cfg.guildId) {
      return { ok: false, reason: "cross_guild_forbidden" };
    }
    if (mode === "write") {
      if (segments.length === 2 && method === "DELETE") {
        return { ok: false, reason: "guild_delete_forbidden" };
      }
      // Block kick/timeout/nickname (`DELETE`/`PATCH /guilds/:id/members/:ownerId`)
      // and ban (`PUT /guilds/:id/bans/:ownerId`) targeting the server owner.
      if (sub1 === "bans" && sub2 === cfg.ownerUserId) {
        return { ok: false, reason: "owner_target_forbidden" };
      }
      if (sub1 === "members" && sub2 === cfg.ownerUserId && segments.length === 4) {
        return { ok: false, reason: "owner_target_forbidden" };
      }
    }
    return { ok: true, normalizedPath };
  }

  if (root === "channels") {
    if (!isSnowflake(targetId)) {
      return { ok: false, reason: "invalid_channel_id" };
    }
    if (mode === "write" && protectedChannelIds.includes(targetId)) {
      // Anti-lockout: never delete, edit, or modify permission overwrites on
      // the active admin channel/thread, its parent channel, or its category.
      if (segments.length === 2 || sub1 === "permissions") {
        return { ok: false, reason: "admin_channel_lockout_forbidden" };
      }
    }
    return { ok: true, normalizedPath };
  }

  if (root === "webhooks") {
    if (!isSnowflake(targetId)) {
      return { ok: false, reason: "invalid_webhook_id" };
    }
    if (segments.length > 2) {
      return { ok: false, reason: "webhook_token_route_forbidden" };
    }
    return { ok: true, normalizedPath };
  }

  if (root === "invites") {
    if (segments.length !== 2 || targetId === undefined || !VALID_INVITE_CODE.test(targetId)) {
      return { ok: false, reason: "invalid_invite_code" };
    }
    if (mode === "write" && method !== "DELETE") {
      return { ok: false, reason: "invite_method_not_allowed" };
    }
    return { ok: true, normalizedPath };
  }

  return { ok: false, reason: "route_family_not_allowed" };
}

/**
 * Deterministically classify an operation's risk level from its exact REST
 * method, normalized path, and body. The model can never downgrade this.
 */
export function classifyOperationRisk(
  method: AdminHttpMethod,
  normalizedPath: string,
  body: Record<string, unknown> | Array<Record<string, unknown>> | undefined,
  cfg: AdminConfig,
): { risk: AdminRiskLevel; riskReasons: string[] } {
  const reasons: string[] = [];
  const segments = normalizedPath.split("/").filter((s) => s.length > 0);
  const [root, targetId, sub1, sub2] = segments;
  const objBody = body !== undefined && !Array.isArray(body) ? body : undefined;

  if (method === "DELETE") {
    reasons.push("destructive_delete");
  }
  if (root === "guilds" && targetId === cfg.guildId) {
    if (segments.length === 2 && method === "PATCH") {
      reasons.push("guild_settings_change");
    }
    if (sub1 === "bans" || sub1 === "prune") {
      reasons.push("moderation_ban_or_prune");
    }
    if (sub1 === "roles" && sub2 === cfg.guildId) {
      reasons.push("everyone_role_change");
    }
    if (
      sub1 === "members" &&
      objBody !== undefined &&
      objBody.communication_disabled_until != null
    ) {
      reasons.push("member_timeout");
    }
  }
  if (root === "channels") {
    if (sub1 === "messages" && sub2 === "bulk-delete") {
      reasons.push("bulk_delete_messages");
    }
    if (sub1 === "permissions" && sub2 === cfg.guildId) {
      reasons.push("everyone_overwrite_change");
    }
  }

  if (objBody !== undefined) {
    for (const field of ["permissions", "allow", "deny"] as const) {
      const sensitive = decodeSensitivePermissions(objBody[field]);
      for (const perm of sensitive) {
        reasons.push(`sensitive_permission:${perm}`);
      }
    }
    if (Array.isArray(objBody.permission_overwrites)) {
      for (const item of objBody.permission_overwrites) {
        if (!isRecord(item)) continue;
        if (item.id === cfg.guildId) {
          reasons.push("everyone_overwrite_change");
        }
        for (const field of ["allow", "deny"] as const) {
          for (const perm of decodeSensitivePermissions(item[field])) {
            reasons.push(`sensitive_permission:${perm}`);
          }
        }
      }
    }
  }

  const deduped = [...new Set(reasons)];
  return {
    risk: deduped.length > 0 ? "high" : "standard",
    riskReasons: deduped,
  };
}

// ── Canonical Payload Hashing ─────────────────────────────────────────────

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isRecord(value)) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).toSorted()) {
      const entry = value[key];
      if (entry !== undefined) sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/** Deterministic SHA-256 hex digest over the immutable execution payload. */
export async function hashAdminPlanPayload(
  guildId: string,
  ownerUserId: string,
  operations: readonly AdminRestOperation[],
): Promise<string> {
  const canonical = JSON.stringify(
    canonicalize({
      guildId,
      ownerUserId,
      operations: operations.map((op) => ({
        id: op.id,
        method: op.method,
        path: op.path,
        body: op.body,
        auditReason: op.auditReason,
      })),
    }),
  );
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ── D1 Persistence & Atomic CAS Handlers ──────────────────────────────────

type PlanRow = {
  id: string;
  guild_id: string;
  channel_id: string;
  requester_user_id: string;
  summary: string;
  actions_json: string;
  payload_sha256: string;
  risk_level: AdminRiskLevel;
  status: AdminPlanStatus;
  created_at: number;
  expires_at: number;
};

function rowToPlan(row: PlanRow): AdminActionPlan | null {
  try {
    const parsed: unknown = JSON.parse(row.actions_json);
    if (!Array.isArray(parsed)) return null;
    return {
      id: row.id,
      guildId: row.guild_id,
      channelId: row.channel_id,
      ownerUserId: row.requester_user_id,
      summary: row.summary,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- validated on insert by Worker
      operations: parsed as AdminRestOperation[],
      risk: row.risk_level,
      payloadHash: row.payload_sha256,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

/** Persist a freshly proposed frozen plan in `pending` state. */
export async function createAdminPlan(db: D1Database, plan: AdminActionPlan): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_action_plans
         (id, guild_id, channel_id, requester_user_id, summary, actions_json,
          payload_sha256, risk_level, status, created_at, expires_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9, ?10)`,
    )
    .bind(
      plan.id,
      plan.guildId,
      plan.channelId,
      plan.ownerUserId,
      plan.summary,
      JSON.stringify(plan.operations),
      plan.payloadHash,
      plan.risk,
      plan.createdAt,
      plan.expiresAt,
    )
    .run();
}

function isNonEmptyId(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= 128;
}

function parsePlanRef(value: unknown): AdminPlanGetRequest | null {
  if (!isRecord(value)) return null;
  if (
    !isNonEmptyId(value.planId) ||
    !isSnowflake(value.guildId) ||
    !isSnowflake(value.ownerUserId)
  ) {
    return null;
  }
  return { planId: value.planId, guildId: value.guildId, ownerUserId: value.ownerUserId };
}

function matchesConfiguredOwner(
  env: Pick<Env, "ADMIN_GUILD_ID" | "ADMIN_OWNER_USER_ID">,
  guildId: string,
  ownerUserId: string,
): boolean {
  const cfg = getAdminConfig(env);
  return cfg !== null && cfg.guildId === guildId && cfg.ownerUserId === ownerUserId;
}

/** `POST /internal/v1/admin/plans/get`: read a persisted plan (supports post-restart approvals). */
export async function handleAdminPlanGet(
  db: D1Database,
  env: Pick<Env, "ADMIN_GUILD_ID" | "ADMIN_OWNER_USER_ID">,
  req: unknown,
): Promise<AdminPlanGetResponse> {
  const parsed = parsePlanRef(req);
  if (parsed === null) return { status: "error", code: "invalid_body" };
  if (!matchesConfiguredOwner(env, parsed.guildId, parsed.ownerUserId)) {
    return { status: "error", code: "not_owner" };
  }
  try {
    const row = await db
      .prepare(
        `SELECT id, guild_id, channel_id, requester_user_id, summary, actions_json,
                payload_sha256, risk_level, status, created_at, expires_at
           FROM admin_action_plans
          WHERE id = ?1 AND guild_id = ?2`,
      )
      .bind(parsed.planId, parsed.guildId)
      .first<PlanRow>();
    if (row === null) return { status: "error", code: "not_found" };
    if (row.requester_user_id !== parsed.ownerUserId) return { status: "error", code: "not_owner" };
    const plan = rowToPlan(row);
    if (plan === null) return { status: "error", code: "plan_failed" };
    return { status: "ok", plan, planStatus: row.status };
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "admin_plan_get_error",
        planId: parsed.planId,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { status: "error", code: "plan_failed" };
  }
}

function parseClaimRequest(value: unknown): AdminPlanClaimRequest | null {
  const ref = parsePlanRef(value);
  if (ref === null || !isRecord(value)) return null;
  if (value.payloadHash !== undefined && !isNonEmptyId(value.payloadHash)) return null;
  return {
    ...ref,
    ...(value.payloadHash === undefined ? {} : { payloadHash: value.payloadHash }),
  };
}

/**
 * `POST /internal/v1/admin/plans/claim`: atomically transition a pending,
 * unexpired plan to `executing` via single-statement CAS so double-clicks and
 * replays can never run twice.
 */
export async function handleAdminPlanClaim(
  db: D1Database,
  env: Pick<Env, "ADMIN_GUILD_ID" | "ADMIN_OWNER_USER_ID">,
  req: unknown,
  now = Date.now(),
): Promise<AdminPlanClaimResponse> {
  const parsed = parseClaimRequest(req);
  if (parsed === null) return { status: "error", code: "invalid_body" };
  if (!matchesConfiguredOwner(env, parsed.guildId, parsed.ownerUserId)) {
    return { status: "error", code: "not_owner" };
  }

  try {
    const row = await db
      .prepare(
        `SELECT id, guild_id, channel_id, requester_user_id, summary, actions_json,
                payload_sha256, risk_level, status, created_at, expires_at
           FROM admin_action_plans
          WHERE id = ?1 AND guild_id = ?2`,
      )
      .bind(parsed.planId, parsed.guildId)
      .first<PlanRow>();
    if (row === null) return { status: "error", code: "not_found" };
    if (row.requester_user_id !== parsed.ownerUserId) return { status: "error", code: "not_owner" };
    if (parsed.payloadHash !== undefined && row.payload_sha256 !== parsed.payloadHash) {
      return { status: "error", code: "hash_mismatch" };
    }
    if (row.status !== "pending") {
      return { status: "error", code: "already_settled" };
    }
    if (now >= row.expires_at) {
      await db
        .prepare(
          `UPDATE admin_action_plans SET status = 'expired', decided_at = ?2
            WHERE id = ?1 AND status = 'pending'`,
        )
        .bind(parsed.planId, now)
        .run();
      return { status: "error", code: "expired" };
    }

    const plan = rowToPlan(row);
    if (plan === null) return { status: "error", code: "plan_failed" };
    const recomputedHash = await hashAdminPlanPayload(
      plan.guildId,
      plan.ownerUserId,
      plan.operations,
    );
    if (recomputedHash !== row.payload_sha256) {
      return { status: "error", code: "hash_mismatch" };
    }

    const claimed = await db
      .prepare(
        `UPDATE admin_action_plans
            SET status = 'executing', decided_by = ?2, decided_at = ?3
          WHERE id = ?1 AND guild_id = ?4 AND requester_user_id = ?2
            AND payload_sha256 = ?5 AND status = 'pending' AND expires_at > ?3`,
      )
      .bind(parsed.planId, parsed.ownerUserId, now, parsed.guildId, row.payload_sha256)
      .run();
    if (claimed.meta.changes !== 1) {
      return { status: "error", code: "already_settled" };
    }

    console.log(
      JSON.stringify({
        event: "admin_plan_claimed",
        planId: plan.id,
        guildId: plan.guildId,
        ownerUserId: plan.ownerUserId,
        operations: plan.operations.length,
        risk: plan.risk,
      }),
    );
    return { status: "ok", plan };
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "admin_plan_claim_error",
        planId: parsed.planId,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { status: "error", code: "plan_failed" };
  }
}

function isStepResult(value: unknown): value is AdminStepResult {
  if (!isRecord(value) || !isNonEmptyId(value.id)) return false;
  if (value.status !== "succeeded" && value.status !== "failed" && value.status !== "skipped") {
    return false;
  }
  if (value.httpStatus !== undefined && typeof value.httpStatus !== "number") return false;
  if (value.error !== undefined && typeof value.error !== "string") return false;
  return true;
}

function parseCompleteRequest(value: unknown): AdminPlanCompleteRequest | null {
  const ref = parsePlanRef(value);
  if (ref === null || !isRecord(value)) return null;
  if (value.outcome !== "completed" && value.outcome !== "failed") return null;
  if (!Array.isArray(value.results) || !value.results.every(isStepResult)) return null;
  return { ...ref, outcome: value.outcome, results: value.results };
}

/** `POST /internal/v1/admin/plans/complete`: finalize audit outcome after Runtime execution. */
export async function handleAdminPlanComplete(
  db: D1Database,
  env: Pick<Env, "ADMIN_GUILD_ID" | "ADMIN_OWNER_USER_ID">,
  req: unknown,
  now = Date.now(),
): Promise<AdminPlanCompleteResponse> {
  const parsed = parseCompleteRequest(req);
  if (parsed === null) return { status: "error", code: "invalid_body" };
  if (!matchesConfiguredOwner(env, parsed.guildId, parsed.ownerUserId)) {
    return { status: "error", code: "not_found" };
  }
  try {
    const res = await db
      .prepare(
        `UPDATE admin_action_plans
            SET status = ?2, result_json = ?3, decided_at = ?4
          WHERE id = ?1 AND guild_id = ?5 AND requester_user_id = ?6 AND status = 'executing'`,
      )
      .bind(
        parsed.planId,
        parsed.outcome,
        JSON.stringify(parsed.results),
        now,
        parsed.guildId,
        parsed.ownerUserId,
      )
      .run();
    if (res.meta.changes === 0) return { status: "error", code: "not_found" };
    console.log(
      JSON.stringify({
        event: "admin_plan_completed",
        planId: parsed.planId,
        outcome: parsed.outcome,
        steps: parsed.results.length,
        succeeded: parsed.results.filter((r) => r.status === "succeeded").length,
      }),
    );
    return { status: "ok" };
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "admin_plan_complete_error",
        planId: parsed.planId,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { status: "error", code: "plan_failed" };
  }
}

/** `POST /internal/v1/admin/plans/cancel`: mark a pending plan cancelled by the owner. */
export async function handleAdminPlanCancel(
  db: D1Database,
  env: Pick<Env, "ADMIN_GUILD_ID" | "ADMIN_OWNER_USER_ID">,
  req: unknown,
  now = Date.now(),
): Promise<AdminPlanCancelResponse> {
  const parsed: AdminPlanCancelRequest | null = parsePlanRef(req);
  if (parsed === null) return { status: "error", code: "invalid_body" };
  if (!matchesConfiguredOwner(env, parsed.guildId, parsed.ownerUserId)) {
    return { status: "error", code: "not_owner" };
  }
  try {
    const res = await db
      .prepare(
        `UPDATE admin_action_plans
            SET status = 'cancelled', decided_by = ?4, decided_at = ?2
          WHERE id = ?1 AND guild_id = ?3 AND requester_user_id = ?4 AND status = 'pending'`,
      )
      .bind(parsed.planId, now, parsed.guildId, parsed.ownerUserId)
      .run();
    return { status: "ok", cancelled: res.meta.changes > 0 };
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "admin_plan_cancel_error",
        planId: parsed.planId,
        error: error instanceof Error ? error.name : typeof error,
      }),
    );
    return { status: "error", code: "plan_failed" };
  }
}
