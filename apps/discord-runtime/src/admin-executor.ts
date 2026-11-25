import { DiscordAPIError, type Client, type RouteLike } from "discord.js";
import type {
  AdminActionPlan,
  AdminRestOperation,
  AdminStepResult,
  DiscordReadRequest,
  DiscordReadResult,
} from "@xenoblade/contracts";

import type { AdminRuntimeConfig } from "./env";

const SNOWFLAKE_RE = /^\d{17,20}$/;
const UNSAFE_PATH_CHARS = /[\s?#\\]|%2e|%2f|%5c/i;
const VALID_SEGMENT = /^[A-Za-z0-9@._~-]+$/;
const VALID_INVITE_CODE = /^[A-Za-z0-9-]{2,32}$/;

const VIEW_CHANNEL_BIT = 1n << 10n;
const LOCKOUT_DENY_MASK = (1n << 10n) | (1n << 11n) | (1n << 38n);

function parsePermissionBitfield(raw: unknown): bigint {
  if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    return BigInt(raw.trim());
  }
  if (typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 0) {
    return BigInt(raw);
  }
  return 0n;
}

function hasAnyPermissionBit(raw: unknown, mask: bigint): boolean {
  return (parsePermissionBitfield(raw) & mask) !== 0n;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Maximum serialized size of one read-proxy response kept on the wire. */
const MAX_READ_PAYLOAD_CHARS = 16_000;

/** Minimal slice of discord.js `Client` required by the admin REST proxy & executor. */
export interface AdminDiscordClient {
  readonly user: { readonly id: string } | null;
  readonly rest: Pick<Client["rest"], "get" | "post" | "patch" | "put" | "delete">;
  readonly guilds: {
    readonly cache: {
      get(
        id: string,
      ): { readonly roles?: { botRoleFor?(botId: string): { id: string } | null } } | undefined;
    };
  };
  readonly channels: {
    readonly cache: { get(id: string): unknown };
    fetch(id: string): Promise<unknown>;
  };
}

function readChannelMeta(channel: unknown): { guildId: string | null; parentId: string | null } {
  if (typeof channel !== "object" || channel === null) {
    return { guildId: null, parentId: null };
  }
  const rawGuildId = "guildId" in channel ? channel.guildId : undefined;
  const rawParentId = "parentId" in channel ? channel.parentId : undefined;
  return {
    guildId: typeof rawGuildId === "string" ? rawGuildId : null,
    parentId: typeof rawParentId === "string" ? rawParentId : null,
  };
}

interface ValidatedRoute {
  normalizedPath: RouteLike;
  root: "guilds" | "channels" | "webhooks" | "invites";
  targetId: string;
  segments: string[];
}

function validateRoute(
  rawPath: string,
  admin: AdminRuntimeConfig,
  mode: "read" | "write",
  options: {
    method?: AdminRestOperation["method"];
    protectedChannelIds?: readonly string[];
    body?: AdminRestOperation["body"];
    protectedActorIds?: readonly string[];
  } = {},
): { ok: true; route: ValidatedRoute } | { ok: false; reason: string } {
  const { method, protectedChannelIds = [], body, protectedActorIds = [] } = options;
  const trimmed = rawPath.trim();
  if (!trimmed.startsWith("/") || trimmed.length > 256 || UNSAFE_PATH_CHARS.test(trimmed)) {
    return { ok: false, reason: "invalid_path" };
  }
  const withoutApi = trimmed.replace(/^\/api\/v\d+(?=\/)/i, "");
  const segments = withoutApi.split("/").filter((s) => s.length > 0);
  if (segments.length < 2 || segments.length > 8) {
    return { ok: false, reason: "invalid_path_depth" };
  }
  for (const seg of segments) {
    if (seg === "." || seg === ".." || !VALID_SEGMENT.test(seg)) {
      return { ok: false, reason: "invalid_path_segment" };
    }
  }
  const normalizedPath: RouteLike = `/${segments.join("/")}`;
  const [root, targetId, sub1, sub2] = segments;

  if (root === "guilds") {
    if (targetId !== admin.guildId) return { ok: false, reason: "cross_guild_forbidden" };
    if (mode === "write") {
      if (segments.length === 2 && method === "DELETE") {
        return { ok: false, reason: "guild_delete_forbidden" };
      }
      if (sub1 === "bans" && sub2 === admin.ownerUserId) {
        return { ok: false, reason: "owner_target_forbidden" };
      }
      if (sub1 === "members" && sub2 === admin.ownerUserId && segments.length === 4) {
        return { ok: false, reason: "owner_target_forbidden" };
      }
    }
    return { ok: true, route: { normalizedPath, root, targetId, segments } };
  }

  if (root === "channels") {
    if (targetId === undefined || !SNOWFLAKE_RE.test(targetId)) {
      return { ok: false, reason: "invalid_channel_id" };
    }
    if (mode === "write" && protectedChannelIds.includes(targetId)) {
      const lockoutTargets = new Set<string>([admin.ownerUserId, ...protectedActorIds]);
      const objBody = isPlainRecord(body) ? body : undefined;
      if (segments.length === 2) {
        if (method === "DELETE") {
          return { ok: false, reason: "admin_channel_lockout_forbidden" };
        }
        if (
          method === "PATCH" &&
          objBody !== undefined &&
          Array.isArray(objBody.permission_overwrites)
        ) {
          for (const item of objBody.permission_overwrites) {
            if (!isPlainRecord(item) || typeof item.id !== "string") continue;
            if (item.id === admin.guildId && hasAnyPermissionBit(item.allow, VIEW_CHANNEL_BIT)) {
              return { ok: false, reason: "admin_channel_lockout_forbidden" };
            }
            if (lockoutTargets.has(item.id) && hasAnyPermissionBit(item.deny, LOCKOUT_DENY_MASK)) {
              return { ok: false, reason: "admin_channel_lockout_forbidden" };
            }
          }
        }
      } else if (sub1 === "permissions" && method === "PUT" && sub2 !== undefined) {
        if (sub2 === admin.guildId && hasAnyPermissionBit(objBody?.allow, VIEW_CHANNEL_BIT)) {
          return { ok: false, reason: "admin_channel_lockout_forbidden" };
        }
        if (lockoutTargets.has(sub2) && hasAnyPermissionBit(objBody?.deny, LOCKOUT_DENY_MASK)) {
          return { ok: false, reason: "admin_channel_lockout_forbidden" };
        }
      }
    }
    return { ok: true, route: { normalizedPath, root, targetId, segments } };
  }

  if (root === "webhooks") {
    if (targetId === undefined || !SNOWFLAKE_RE.test(targetId)) {
      return { ok: false, reason: "invalid_webhook_id" };
    }
    if (segments.length > 2) {
      return { ok: false, reason: "webhook_token_route_forbidden" };
    }
    return { ok: true, route: { normalizedPath, root, targetId, segments } };
  }

  if (root === "invites") {
    if (segments.length !== 2 || targetId === undefined || !VALID_INVITE_CODE.test(targetId)) {
      return { ok: false, reason: "invalid_invite_code" };
    }
    if (mode === "write" && method !== "DELETE") {
      return { ok: false, reason: "invite_method_not_allowed" };
    }
    return { ok: true, route: { normalizedPath, root, targetId, segments } };
  }

  return { ok: false, reason: "route_family_not_allowed" };
}

/** Verify that a channel belongs to the configured admin guild before touching it. */
async function verifyChannelInGuild(
  client: AdminDiscordClient,
  channelId: string,
  guildId: string,
): Promise<boolean> {
  const cached = client.channels.cache.get(channelId);
  if (cached !== undefined) return readChannelMeta(cached).guildId === guildId;
  try {
    const fetched = await client.channels.fetch(channelId);
    return readChannelMeta(fetched).guildId === guildId;
  } catch {
    return false;
  }
}

/** Collect protected channel/parent/category IDs for anti-lockout enforcement. */
export async function resolveProtectedChannelIds(
  client: AdminDiscordClient,
  channelId: string,
): Promise<string[]> {
  const ids = new Set<string>([channelId]);
  let currentId: string | null = channelId;
  for (let depth = 0; depth < 3 && currentId !== null; depth += 1) {
    let ch = client.channels.cache.get(currentId);
    if (ch === undefined) {
      ch = await client.channels.fetch(currentId).catch(() => undefined);
    }
    const { parentId } = readChannelMeta(ch);
    if (parentId === null || ids.has(parentId)) break;
    ids.add(parentId);
    currentId = parentId;
  }
  return [...ids];
}

/** Verify that a webhook belongs to the configured admin guild before modifying it. */
async function verifyWebhookInGuild(
  client: AdminDiscordClient,
  webhookId: string,
  guildId: string,
): Promise<boolean> {
  try {
    const raw = await client.rest.get(`/webhooks/${webhookId}`);
    return (
      typeof raw === "object" &&
      raw !== null &&
      "guild_id" in raw &&
      (raw as { guild_id?: unknown }).guild_id === guildId
    );
  } catch {
    return false;
  }
}

/** Verify that an invite belongs to the configured admin guild before deleting it. */
async function verifyInviteInGuild(
  client: AdminDiscordClient,
  inviteCode: string,
  guildId: string,
): Promise<boolean> {
  try {
    const raw = await client.rest.get(`/invites/${inviteCode}`);
    if (typeof raw !== "object" || raw === null || !("guild" in raw)) return false;
    const guild = (raw as { guild?: unknown }).guild;
    return (
      typeof guild === "object" &&
      guild !== null &&
      "id" in guild &&
      (guild as { id?: unknown }).id === guildId
    );
  } catch {
    return false;
  }
}

function trimReadPayload(data: unknown): unknown {
  const raw = JSON.stringify(data);
  if (raw === undefined || raw.length <= MAX_READ_PAYLOAD_CHARS) return data;
  if (Array.isArray(data)) {
    const kept: unknown[] = [];
    let size = 2;
    for (const item of data) {
      const itemStr = JSON.stringify(item);
      if (itemStr === undefined) continue;
      if (size + itemStr.length + 1 > MAX_READ_PAYLOAD_CHARS - 128) break;
      kept.push(item);
      size += itemStr.length + 1;
    }
    return {
      items: kept,
      truncated: true,
      returnedCount: kept.length,
      totalCount: data.length,
    };
  }
  return { truncatedPreview: `${raw.slice(0, MAX_READ_PAYLOAD_CHARS - 64)}…[truncated]` };
}

function errorDetail(error: unknown): { httpStatus?: number; message: string } {
  if (error instanceof DiscordAPIError) {
    return {
      httpStatus: error.status,
      message: `DiscordAPIError(${String(error.code)}): ${error.message}`.slice(0, 240),
    };
  }
  if (error instanceof Error) {
    return { message: `${error.name}: ${error.message}`.slice(0, 240) };
  }
  return { message: String(error).slice(0, 240) };
}

/**
 * Execute Runtime-proxied read-only Discord REST GET queries for an authorized
 * admin session. Independently enforces target-guild resource ownership and
 * trims oversized payloads before returning data to the Worker.
 */
export async function executeDiscordReads(
  client: AdminDiscordClient,
  admin: AdminRuntimeConfig,
  requests: readonly DiscordReadRequest[],
): Promise<DiscordReadResult[]> {
  const results: DiscordReadResult[] = [];
  for (const req of requests) {
    const validated = validateRoute(req.path, admin, "read");
    if (!validated.ok) {
      results.push({
        id: req.id,
        path: req.path,
        ...(req.query === undefined ? {} : { query: req.query }),
        ok: false,
        error: validated.reason,
      });
      continue;
    }

    const { route } = validated;
    if (route.root === "channels") {
      const owned = await verifyChannelInGuild(client, route.targetId, admin.guildId);
      if (!owned) {
        results.push({
          id: req.id,
          path: route.normalizedPath,
          ...(req.query === undefined ? {} : { query: req.query }),
          ok: false,
          error: "channel_not_in_target_guild",
        });
        continue;
      }
    }

    try {
      const query =
        req.query && Object.keys(req.query).length > 0 ? new URLSearchParams(req.query) : undefined;
      const data = await client.rest.get(
        route.normalizedPath,
        query === undefined ? undefined : { query },
      );
      if (route.root === "webhooks") {
        const guildId =
          typeof data === "object" && data !== null && "guild_id" in data
            ? (data as { guild_id?: unknown }).guild_id
            : undefined;
        if (guildId !== admin.guildId) {
          results.push({
            id: req.id,
            path: route.normalizedPath,
            ...(req.query === undefined ? {} : { query: req.query }),
            ok: false,
            error: "webhook_not_in_target_guild",
          });
          continue;
        }
      }
      if (route.root === "invites") {
        const guild =
          typeof data === "object" && data !== null && "guild" in data
            ? (data as { guild?: unknown }).guild
            : undefined;
        const guildId =
          typeof guild === "object" && guild !== null && "id" in guild
            ? (guild as { id?: unknown }).id
            : undefined;
        if (guildId !== admin.guildId) {
          results.push({
            id: req.id,
            path: route.normalizedPath,
            ...(req.query === undefined ? {} : { query: req.query }),
            ok: false,
            error: "invite_not_in_target_guild",
          });
          continue;
        }
      }
      results.push({
        id: req.id,
        path: route.normalizedPath,
        ...(req.query === undefined ? {} : { query: req.query }),
        ok: true,
        status: 200,
        data: trimReadPayload(data),
      });
    } catch (error) {
      const info = errorDetail(error);
      results.push({
        id: req.id,
        path: route.normalizedPath,
        ...(req.query === undefined ? {} : { query: req.query }),
        ok: false,
        ...(info.httpStatus === undefined ? {} : { status: info.httpStatus }),
        error: info.message,
      });
    }
  }
  return results;
}

/** Build a Discord-compliant audit log reason header (≤ 512 chars). */
export function buildAuditReason(plan: AdminActionPlan, op: AdminRestOperation): string {
  const shortPlanId = plan.id.slice(0, 8);
  const base = `Xenoblade plan:${shortPlanId} approved by ${plan.ownerUserId}`;
  const detail = op.auditReason?.trim();
  const full = detail ? `${base} | ${detail}` : base;
  return Array.from(full).slice(0, 512).join("");
}

/**
 * Execute a claimed, frozen {@link AdminActionPlan} verbatim via `client.rest`.
 * Stops on the first failed step and marks remaining steps as `skipped` so
 * dependent operations never cascade blindly.
 */
export async function executeAdminPlan(
  client: AdminDiscordClient,
  admin: AdminRuntimeConfig,
  plan: AdminActionPlan,
): Promise<{ outcome: "completed" | "failed"; results: AdminStepResult[] }> {
  if (plan.guildId !== admin.guildId || plan.ownerUserId !== admin.ownerUserId) {
    return {
      outcome: "failed",
      results: plan.operations.map((op) => ({
        id: op.id,
        status: "failed",
        error: "plan_scope_mismatch",
      })),
    };
  }

  const protectedChannelIds = await resolveProtectedChannelIds(client, plan.channelId);
  const botId = client.user?.id;
  const botManagedRoleId =
    botId !== undefined
      ? (client.guilds.cache.get(admin.guildId)?.roles?.botRoleFor?.(botId)?.id ?? null)
      : null;

  const protectedActorIds = [
    ...(botId === undefined ? [] : [botId]),
    ...(botManagedRoleId === null ? [] : [botManagedRoleId]),
  ];

  const results: AdminStepResult[] = [];
  let aborted = false;

  for (const op of plan.operations) {
    if (aborted) {
      results.push({ id: op.id, status: "skipped" });
      continue;
    }

    const validated = validateRoute(op.path, admin, "write", {
      method: op.method,
      protectedChannelIds,
      body: op.body,
      protectedActorIds,
    });
    if (!validated.ok) {
      results.push({ id: op.id, status: "failed", error: validated.reason });
      aborted = true;
      continue;
    }
    const { route } = validated;

    // Anti-lockout: never edit/delete/reposition the bot's own managed role.
    if (botManagedRoleId !== null && route.root === "guilds" && route.segments[2] === "roles") {
      const targetsBotRole =
        route.segments[3] === botManagedRoleId ||
        (Array.isArray(op.body) && op.body.some((item) => item.id === botManagedRoleId));
      if (targetsBotRole) {
        results.push({ id: op.id, status: "failed", error: "bot_managed_role_forbidden" });
        aborted = true;
        continue;
      }
    }

    if (route.root === "channels") {
      const owned = await verifyChannelInGuild(client, route.targetId, admin.guildId);
      if (!owned) {
        results.push({ id: op.id, status: "failed", error: "channel_not_in_target_guild" });
        aborted = true;
        continue;
      }
    }

    if (route.root === "webhooks") {
      const owned = await verifyWebhookInGuild(client, route.targetId, admin.guildId);
      if (!owned) {
        results.push({ id: op.id, status: "failed", error: "webhook_not_in_target_guild" });
        aborted = true;
        continue;
      }
    }

    if (route.root === "invites") {
      const owned = await verifyInviteInGuild(client, route.targetId, admin.guildId);
      if (!owned) {
        results.push({ id: op.id, status: "failed", error: "invite_not_in_target_guild" });
        aborted = true;
        continue;
      }
    }

    const reason = buildAuditReason(plan, op);
    const requestOptions = {
      ...(op.body === undefined ? {} : { body: op.body }),
      reason,
    };

    try {
      if (op.method === "POST") {
        await client.rest.post(route.normalizedPath, requestOptions);
      } else if (op.method === "PATCH") {
        await client.rest.patch(route.normalizedPath, requestOptions);
      } else if (op.method === "PUT") {
        await client.rest.put(route.normalizedPath, requestOptions);
      } else {
        await client.rest.delete(route.normalizedPath, requestOptions);
      }
      results.push({ id: op.id, status: "succeeded", httpStatus: 200 });
    } catch (error) {
      const info = errorDetail(error);
      results.push({
        id: op.id,
        status: "failed",
        ...(info.httpStatus === undefined ? {} : { httpStatus: info.httpStatus }),
        error: info.message,
      });
      aborted = true;
    }
  }

  return { outcome: aborted ? "failed" : "completed", results };
}
