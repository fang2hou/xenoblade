import { jsonSchema, tool } from "ai";
import type { StopCondition, ToolSet } from "ai";
import type {
  AdminHttpMethod,
  AdminRestOperation,
  DiscordReadRequest,
  DiscordReadResult,
} from "@xenoblade/contracts";

import {
  classifyOperationRisk,
  encodePermissionNames,
  isSnowflake,
  MAX_ADMIN_OPERATIONS,
  validateAdminRestPath,
  type AdminConfig,
} from "../admin-plans";
import { isRecord } from "../guards";

/** Maximum Runtime-proxied Discord GET requests queued in a single generation hop. */
export const MAX_DISCORD_READS_PER_HOP = 5;

const MAX_DESCRIPTION_CHARS = 300;
const MAX_REASON_CHARS = 200;

function clampText(text: string, max: number): string {
  return Array.from(text.trim()).slice(0, max).join("");
}

function readLookupKey(path: string, query?: Record<string, string>): string {
  if (query === undefined) return path;
  const keys = Object.keys(query).toSorted();
  if (keys.length === 0) return path;
  const qs = keys.map((k) => `${k}=${query[k] ?? ""}`).join("&");
  return `${path}?${qs}`;
}

function parseQueryParams(raw: unknown): Record<string, string> | undefined | null {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) return null;
  const query: Record<string, string> = {};
  const entries = Object.entries(raw);
  if (entries.length > 16) return null;
  for (const [k, v] of entries) {
    if (!/^[A-Za-z0-9_.-]{1,48}$/.test(k)) return null;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
      query[k] = String(v).slice(0, 128);
    } else {
      return null;
    }
  }
  return Object.keys(query).length > 0 ? query : undefined;
}

function parseHexColor(color: unknown): number | null | undefined {
  if (color === undefined) return undefined;
  if (typeof color === "number" && Number.isInteger(color) && color >= 0 && color <= 0xffffff) {
    return color;
  }
  if (typeof color === "string") {
    const cleaned = color.trim().replace(/^#/, "");
    if (/^[0-9a-fA-F]{6}$/.test(cleaned)) {
      return Number.parseInt(cleaned, 16);
    }
  }
  return null;
}

function parseOptionalStringArray(value: unknown): string[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return null;
  return value;
}

function buildOperation(
  cfg: AdminConfig,
  protectedChannelIds: readonly string[],
  input: {
    actionType: string;
    description: string;
    method: AdminHttpMethod;
    path: string;
    body?: Record<string, unknown> | Array<Record<string, unknown>>;
    auditReason?: string;
  },
): { ok: true; operation: AdminRestOperation } | { ok: false; reason: string } {
  const pathCheck = validateAdminRestPath(input.path, cfg, "write", {
    method: input.method,
    protectedChannelIds,
  });
  if (!pathCheck.ok) return { ok: false, reason: pathCheck.reason };

  const { risk, riskReasons } = classifyOperationRisk(
    input.method,
    pathCheck.normalizedPath,
    input.body,
    cfg,
  );
  const reason = input.auditReason ? clampText(input.auditReason, MAX_REASON_CHARS) : undefined;
  return {
    ok: true,
    operation: {
      id: crypto.randomUUID(),
      actionType: input.actionType,
      description: clampText(input.description, MAX_DESCRIPTION_CHARS),
      method: input.method,
      path: pathCheck.normalizedPath,
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(reason ? { auditReason: reason } : {}),
      risk,
      ...(riskReasons.length > 0 ? { riskReasons } : {}),
    },
  };
}

// ── Stop condition & extractors ───────────────────────────────────────────

function isWaitingForRead(output: unknown): output is { request: DiscordReadRequest } {
  return (
    isRecord(output) &&
    output.status === "waiting_for_runtime_read" &&
    isRecord(output.request) &&
    typeof output.request.id === "string" &&
    typeof output.request.path === "string"
  );
}

/**
 * End the current Worker generation hop once `discord_api_read` queues live
 * Discord GET request(s) for the Runtime to execute locally (ADR-002).
 */
export const stoppedOnDiscordRead: StopCondition<ToolSet> = ({ steps }) => {
  const last = steps.at(-1);
  return (
    last?.toolResults.some(
      (result) => result.toolName === "discord_api_read" && isWaitingForRead(result.output),
    ) ?? false
  );
};

/** Extract unique pending Discord read requests queued during this hop. */
export function extractDiscordReadRequests(
  toolResults: readonly { toolName: string; output?: unknown }[],
): DiscordReadRequest[] {
  const seen = new Set<string>();
  const requests: DiscordReadRequest[] = [];
  for (const tr of toolResults) {
    if (tr.toolName !== "discord_api_read" || !isWaitingForRead(tr.output)) continue;
    const req = tr.output.request;
    const key = readLookupKey(req.path, req.query);
    if (seen.has(key)) continue;
    seen.add(key);
    requests.push(req);
    if (requests.length >= MAX_DISCORD_READS_PER_HOP) break;
  }
  return requests;
}

const ADMIN_PLAN_TOOL_NAMES = new Set([
  "admin_plan_channel",
  "admin_plan_role",
  "admin_plan_member",
  "admin_plan_message_thread",
  "admin_plan_guild",
  "admin_plan_rest",
]);

function isProposedAdminOp(output: unknown): output is { operation: AdminRestOperation } {
  return (
    isRecord(output) &&
    output.status === "proposed" &&
    isRecord(output.operation) &&
    typeof output.operation.id === "string" &&
    typeof output.operation.method === "string" &&
    typeof output.operation.path === "string"
  );
}

/** Extract all proposed server administration operations from tool results (capped). */
export function extractAdminOperations(
  toolResults: readonly { toolName: string; output?: unknown }[],
): AdminRestOperation[] {
  const operations: AdminRestOperation[] = [];
  for (const tr of toolResults) {
    if (!ADMIN_PLAN_TOOL_NAMES.has(tr.toolName) || !isProposedAdminOp(tr.output)) continue;
    operations.push(tr.output.operation);
    if (operations.length >= MAX_ADMIN_OPERATIONS) break;
  }
  return operations;
}

// ── Tool Factory ──────────────────────────────────────────────────────────

export interface AdminToolContext {
  config: AdminConfig;
  protectedChannelIds: readonly string[];
  readResults: readonly DiscordReadResult[];
}

/**
 * Create the owner-only Discord server administration toolset:
 * - `discord_api_read`: live read-only Discord REST v10 query via Runtime proxy
 * - `admin_plan_channel`, `admin_plan_role`, `admin_plan_member`,
 *   `admin_plan_message_thread`, `admin_plan_guild`: structured planners with
 *   human-readable permission names and built-in anti-lockout guards
 * - `admin_plan_rest`: universal escape hatch for any Discord REST v10 write
 *
 * Write tools NEVER execute during generation — they only produce normalized,
 * risk-classified operations that require owner button approval before the
 * Runtime executes them verbatim.
 */
export function createAdminTools(ctx: AdminToolContext): ToolSet {
  const { config, protectedChannelIds, readResults } = ctx;
  const cachedReads = new Map<string, DiscordReadResult>();
  for (const result of readResults) {
    cachedReads.set(readLookupKey(result.path, result.query), result);
  }

  return {
    discord_api_read: tool({
      description:
        `Read live Discord server state via Discord REST v10 GET for guild ${config.guildId}. ` +
        `Common paths: /guilds/${config.guildId} (overview), /guilds/${config.guildId}/channels (channel/category tree & overwrites), ` +
        `/guilds/${config.guildId}/threads/active (active threads), /guilds/${config.guildId}/roles (roles & permissions), ` +
        `/guilds/${config.guildId}/members (query limit=100), /guilds/${config.guildId}/members/search (query query=...), ` +
        `/guilds/${config.guildId}/members/{userId}, /guilds/${config.guildId}/audit-logs (query limit=25), ` +
        `/guilds/${config.guildId}/bans, /guilds/${config.guildId}/invites, /guilds/${config.guildId}/webhooks, ` +
        `/channels/{channelId}, /channels/{channelId}/pins, /channels/{channelId}/webhooks. ` +
        "You may issue up to 5 read calls in one step to gather server state before planning changes.",
      inputSchema: jsonSchema<{ path: string; query?: Record<string, string> }>({
        type: "object",
        properties: {
          path: {
            type: "string",
            description: `Discord REST v10 path starting with '/', e.g. '/guilds/${config.guildId}/channels'. Do not include query parameters in path.`,
          },
          query: {
            type: "object",
            description:
              "Optional query parameters as string key/value pairs (e.g. { limit: '25' }).",
            additionalProperties: { type: "string" },
          },
        },
        required: ["path"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        if (!isRecord(args) || typeof args.path !== "string") {
          return { status: "error", code: "invalid_input" };
        }
        const query = parseQueryParams(args.query);
        if (query === null) {
          return { status: "error", code: "invalid_query" };
        }
        const check = validateAdminRestPath(args.path, config, "read");
        if (!check.ok) {
          return { status: "rejected", reason: check.reason };
        }
        const key = readLookupKey(check.normalizedPath, query);
        const existing = cachedReads.get(key);
        if (existing !== undefined) {
          return {
            status: existing.ok ? "ok" : "error",
            cached: true,
            httpStatus: existing.status,
            ...(existing.ok ? { data: existing.data } : { error: existing.error ?? "read_failed" }),
          };
        }
        const request: DiscordReadRequest = {
          id: crypto.randomUUID(),
          path: check.normalizedPath,
          ...(query === undefined ? {} : { query }),
        };
        return { status: "waiting_for_runtime_read", request };
      },
    }),

    admin_plan_channel: tool({
      description:
        "Propose a Discord channel or category administration change (create, update, delete, set_permission_overwrite, delete_permission_overwrite). " +
        "Uses human-readable Discord permission names (e.g. 'ViewChannel', 'SendMessages', 'ManageMessages'). " +
        "Nothing executes until the owner clicks Approve.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: [
              "create",
              "update",
              "delete",
              "set_permission_overwrite",
              "delete_permission_overwrite",
            ],
          },
          channel_id: {
            type: "string",
            description: "Target channel ID (required for all ops except create).",
          },
          name: {
            type: "string",
            description: "Channel name (required for create; optional for update).",
          },
          channel_type: {
            type: "number",
            description:
              "Discord channel type for create: 0=GuildText, 2=GuildVoice, 4=GuildCategory, 5=GuildAnnouncement, 13=GuildStageVoice, 15=GuildForum.",
          },
          parent_id: {
            type: ["string", "null"],
            description: "Category ID to place the channel under, or null to uncategorize.",
          },
          topic: { type: ["string", "null"], description: "Channel topic." },
          position: { type: "number", description: "Sorting position." },
          nsfw: { type: "boolean" },
          rate_limit_per_user: {
            type: "number",
            description: "Slowmode delay in seconds (0–21600).",
          },
          bitrate: { type: "number", description: "Voice channel bitrate in bits (8000–384000)." },
          user_limit: { type: "number", description: "Voice channel user limit (0–99)." },
          rtc_region: {
            type: ["string", "null"],
            description: "Voice RTC region override or null for auto.",
          },
          target_id: {
            type: "string",
            description:
              "Role or member ID for set_permission_overwrite / delete_permission_overwrite.",
          },
          target_type: {
            type: "string",
            enum: ["role", "member"],
            description:
              "Whether target_id is a 'role' (0) or 'member' (1) for set_permission_overwrite.",
          },
          allow_permissions: {
            type: "array",
            items: { type: "string" },
            description: "Permission names to ALLOW in the overwrite.",
          },
          deny_permissions: {
            type: "array",
            items: { type: "string" },
            description: "Permission names to DENY in the overwrite.",
          },
          audit_reason: { type: "string", description: "Short audit log reason." },
        },
        required: ["op"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        if (!isRecord(args) || typeof args.op !== "string") {
          return { status: "error", code: "invalid_input" };
        }
        const auditReason = typeof args.audit_reason === "string" ? args.audit_reason : undefined;

        if (args.op === "create") {
          if (typeof args.name !== "string" || args.name.trim() === "") {
            return { status: "error", code: "missing_name" };
          }
          const body: Record<string, unknown> = {
            name: args.name.trim().slice(0, 100),
            type: typeof args.channel_type === "number" ? args.channel_type : 0,
          };
          if (args.parent_id === null || isSnowflake(args.parent_id))
            body.parent_id = args.parent_id;
          if (typeof args.topic === "string") body.topic = args.topic.slice(0, 1024);
          if (typeof args.position === "number") body.position = args.position;
          if (typeof args.nsfw === "boolean") body.nsfw = args.nsfw;
          if (typeof args.rate_limit_per_user === "number") {
            body.rate_limit_per_user = Math.max(
              0,
              Math.min(21600, Math.floor(args.rate_limit_per_user)),
            );
          }
          if (typeof args.bitrate === "number")
            body.bitrate = Math.max(8000, Math.min(384000, Math.floor(args.bitrate)));
          if (typeof args.user_limit === "number")
            body.user_limit = Math.max(0, Math.min(99, Math.floor(args.user_limit)));
          if (args.rtc_region === null || typeof args.rtc_region === "string")
            body.rtc_region = args.rtc_region;
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "channel.create",
            description: `Create channel #${String(body.name)} (type=${String(body.type)})`,
            method: "POST",
            path: `/guilds/${config.guildId}/channels`,
            body,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (!isSnowflake(args.channel_id)) {
          return { status: "error", code: "invalid_channel_id" };
        }
        const channelId = args.channel_id;

        if (args.op === "update") {
          const body: Record<string, unknown> = {};
          const changes: string[] = [];
          if (typeof args.name === "string" && args.name.trim() !== "") {
            body.name = args.name.trim().slice(0, 100);
            changes.push(`name=${String(body.name)}`);
          }
          if (args.topic === null || typeof args.topic === "string") {
            body.topic = args.topic === null ? null : args.topic.slice(0, 1024);
            changes.push("topic");
          }
          if (args.parent_id === null || isSnowflake(args.parent_id)) {
            body.parent_id = args.parent_id;
            changes.push(`parent=${String(args.parent_id)}`);
          }
          if (typeof args.position === "number") {
            body.position = args.position;
            changes.push(`position=${args.position}`);
          }
          if (typeof args.nsfw === "boolean") {
            body.nsfw = args.nsfw;
            changes.push(`nsfw=${String(args.nsfw)}`);
          }
          if (typeof args.rate_limit_per_user === "number") {
            body.rate_limit_per_user = Math.max(
              0,
              Math.min(21600, Math.floor(args.rate_limit_per_user)),
            );
            changes.push(`slowmode=${String(body.rate_limit_per_user)}s`);
          }
          if (typeof args.bitrate === "number") {
            body.bitrate = Math.max(8000, Math.min(384000, Math.floor(args.bitrate)));
            changes.push(`bitrate=${String(body.bitrate)}`);
          }
          if (typeof args.user_limit === "number") {
            body.user_limit = Math.max(0, Math.min(99, Math.floor(args.user_limit)));
            changes.push(`user_limit=${String(body.user_limit)}`);
          }
          if (args.rtc_region === null || typeof args.rtc_region === "string") {
            body.rtc_region = args.rtc_region;
            changes.push(`rtc_region=${String(args.rtc_region)}`);
          }
          if (Object.keys(body).length === 0) {
            return { status: "error", code: "empty_update" };
          }
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "channel.update",
            description: `Update channel ${channelId} (${changes.join(", ")})`,
            method: "PATCH",
            path: `/channels/${channelId}`,
            body,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "delete") {
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "channel.delete",
            description: `DELETE channel ${channelId}`,
            method: "DELETE",
            path: `/channels/${channelId}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (!isSnowflake(args.target_id)) {
          return { status: "error", code: "invalid_target_id" };
        }
        const targetId = args.target_id;

        if (args.op === "delete_permission_overwrite") {
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "channel.overwrite.delete",
            description: `Delete permission overwrite for ${targetId} on channel ${channelId}`,
            method: "DELETE",
            path: `/channels/${channelId}/permissions/${targetId}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "set_permission_overwrite") {
          if (args.target_type !== "role" && args.target_type !== "member") {
            return { status: "error", code: "invalid_target_type" };
          }
          const allowList = parseOptionalStringArray(args.allow_permissions) ?? [];
          const denyList = parseOptionalStringArray(args.deny_permissions) ?? [];
          const allowEncoded = encodePermissionNames(allowList);
          if (!allowEncoded.ok) {
            return { status: "error", code: "unknown_permissions", unknown: allowEncoded.unknown };
          }
          const denyEncoded = encodePermissionNames(denyList);
          if (!denyEncoded.ok) {
            return { status: "error", code: "unknown_permissions", unknown: denyEncoded.unknown };
          }
          const body: Record<string, unknown> = {
            type: args.target_type === "role" ? 0 : 1,
            allow: allowEncoded.bitfield,
            deny: denyEncoded.bitfield,
          };
          const desc =
            `Set ${args.target_type} ${targetId} overwrite on channel ${channelId}: ` +
            `allow=[${allowEncoded.canonical.join(",") || "none"}] deny=[${denyEncoded.canonical.join(",") || "none"}]`;
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "channel.overwrite.set",
            description: desc,
            method: "PUT",
            path: `/channels/${channelId}/permissions/${targetId}`,
            body,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        return { status: "error", code: "unsupported_op" };
      },
    }),

    admin_plan_role: tool({
      description:
        "Propose a Discord role management action (create, update, reorder_position, delete, assign_member, remove_member). " +
        "Uses human-readable permission names and hex colors. Nothing executes until the owner approves.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: [
              "create",
              "update",
              "reorder_position",
              "delete",
              "assign_member",
              "remove_member",
            ],
          },
          role_id: {
            type: "string",
            description: "Target role ID (required for all ops except create).",
          },
          user_id: {
            type: "string",
            description: "Target member user ID (for assign_member / remove_member).",
          },
          name: { type: "string" },
          color: {
            type: ["string", "number"],
            description: "Hex color like '#3498db' or 24-bit integer.",
          },
          hoist: { type: "boolean", description: "Display role separately in member list." },
          mentionable: { type: "boolean" },
          position: { type: "number", description: "New role position (for reorder_position)." },
          permissions: {
            type: "array",
            items: { type: "string" },
            description:
              "Full permission name list for this role (replaces the role's permission bitfield).",
          },
          audit_reason: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        if (!isRecord(args) || typeof args.op !== "string") {
          return { status: "error", code: "invalid_input" };
        }
        const auditReason = typeof args.audit_reason === "string" ? args.audit_reason : undefined;

        if (args.op === "create" || args.op === "update") {
          if (args.op === "update" && !isSnowflake(args.role_id)) {
            return { status: "error", code: "invalid_role_id" };
          }
          const body: Record<string, unknown> = {};
          const summaryParts: string[] = [];
          if (typeof args.name === "string" && args.name.trim() !== "") {
            body.name = args.name.trim().slice(0, 100);
            summaryParts.push(`name=${String(body.name)}`);
          }
          const color = parseHexColor(args.color);
          if (color === null) return { status: "error", code: "invalid_color" };
          if (color !== undefined) {
            body.color = color;
            summaryParts.push(`color=#${color.toString(16).padStart(6, "0")}`);
          }
          if (typeof args.hoist === "boolean") {
            body.hoist = args.hoist;
            summaryParts.push(`hoist=${String(args.hoist)}`);
          }
          if (typeof args.mentionable === "boolean") {
            body.mentionable = args.mentionable;
            summaryParts.push(`mentionable=${String(args.mentionable)}`);
          }
          const perms = parseOptionalStringArray(args.permissions);
          if (perms === null) return { status: "error", code: "invalid_permissions" };
          if (perms !== undefined) {
            const encoded = encodePermissionNames(perms);
            if (!encoded.ok) {
              return { status: "error", code: "unknown_permissions", unknown: encoded.unknown };
            }
            body.permissions = encoded.bitfield;
            summaryParts.push(`perms=[${encoded.canonical.join(",") || "none"}]`);
          }
          if (args.op === "create" && typeof body.name !== "string") {
            return { status: "error", code: "missing_name" };
          }
          if (args.op === "update" && Object.keys(body).length === 0) {
            return { status: "error", code: "empty_update" };
          }
          const built = buildOperation(config, protectedChannelIds, {
            actionType: args.op === "create" ? "role.create" : "role.update",
            description:
              args.op === "create"
                ? `Create role (${summaryParts.join(", ")})`
                : `Update role ${String(args.role_id)} (${summaryParts.join(", ")})`,
            method: args.op === "create" ? "POST" : "PATCH",
            path:
              args.op === "create"
                ? `/guilds/${config.guildId}/roles`
                : `/guilds/${config.guildId}/roles/${String(args.role_id)}`,
            body,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (!isSnowflake(args.role_id)) return { status: "error", code: "invalid_role_id" };
        const roleId = args.role_id;

        if (args.op === "reorder_position") {
          if (
            typeof args.position !== "number" ||
            !Number.isInteger(args.position) ||
            args.position < 1
          ) {
            return { status: "error", code: "invalid_position" };
          }
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "role.position",
            description: `Move role ${roleId} to position ${args.position}`,
            method: "PATCH",
            path: `/guilds/${config.guildId}/roles`,
            body: [{ id: roleId, position: args.position }],
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "delete") {
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "role.delete",
            description: `DELETE role ${roleId}`,
            method: "DELETE",
            path: `/guilds/${config.guildId}/roles/${roleId}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (!isSnowflake(args.user_id)) return { status: "error", code: "invalid_user_id" };
        const userId = args.user_id;

        if (args.op === "assign_member" || args.op === "remove_member") {
          const isAssign = args.op === "assign_member";
          const built = buildOperation(config, protectedChannelIds, {
            actionType: isAssign ? "role.assign" : "role.remove",
            description: isAssign
              ? `Add role ${roleId} to member ${userId}`
              : `Remove role ${roleId} from member ${userId}`,
            method: isAssign ? "PUT" : "DELETE",
            path: `/guilds/${config.guildId}/members/${userId}/roles/${roleId}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        return { status: "error", code: "unsupported_op" };
      },
    }),

    admin_plan_member: tool({
      description:
        "Propose a Discord member moderation/profile action (update_nickname, timeout, clear_timeout, kick, ban, unban). " +
        "Nothing executes until the owner approves.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: ["update_nickname", "timeout", "clear_timeout", "kick", "ban", "unban"],
          },
          user_id: { type: "string", description: "Target user ID." },
          nick: { type: ["string", "null"], description: "New nickname, or null to reset." },
          timeout_minutes: {
            type: "number",
            description: "Timeout duration in minutes (1–40320, up to 28 days).",
          },
          delete_message_seconds: {
            type: "number",
            description: "Optional seconds of recent messages to delete on ban (0–604800).",
          },
          audit_reason: { type: "string" },
        },
        required: ["op", "user_id"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        if (!isRecord(args) || typeof args.op !== "string" || !isSnowflake(args.user_id)) {
          return { status: "error", code: "invalid_input" };
        }
        const userId = args.user_id;
        const auditReason = typeof args.audit_reason === "string" ? args.audit_reason : undefined;

        if (args.op === "update_nickname") {
          if (args.nick !== null && typeof args.nick !== "string") {
            return { status: "error", code: "invalid_nick" };
          }
          const nick = args.nick === null ? null : args.nick.trim().slice(0, 32);
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "member.nickname",
            description:
              nick === null
                ? `Reset nickname of member ${userId}`
                : `Set nickname of member ${userId} to "${nick}"`,
            method: "PATCH",
            path: `/guilds/${config.guildId}/members/${userId}`,
            body: { nick },
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "timeout") {
          const minutes =
            typeof args.timeout_minutes === "number" && Number.isFinite(args.timeout_minutes)
              ? Math.max(1, Math.min(40320, Math.floor(args.timeout_minutes)))
              : null;
          if (minutes === null) return { status: "error", code: "invalid_timeout_minutes" };
          const until = new Date(Date.now() + minutes * 60_000).toISOString();
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "member.timeout",
            description: `Timeout member ${userId} for ${minutes}m (until ${until})`,
            method: "PATCH",
            path: `/guilds/${config.guildId}/members/${userId}`,
            body: { communication_disabled_until: until },
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "clear_timeout") {
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "member.clear_timeout",
            description: `Clear timeout for member ${userId}`,
            method: "PATCH",
            path: `/guilds/${config.guildId}/members/${userId}`,
            body: { communication_disabled_until: null },
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "kick") {
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "member.kick",
            description: `KICK member ${userId}`,
            method: "DELETE",
            path: `/guilds/${config.guildId}/members/${userId}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "ban") {
          const deleteSeconds =
            typeof args.delete_message_seconds === "number" &&
            Number.isFinite(args.delete_message_seconds)
              ? Math.max(0, Math.min(604800, Math.floor(args.delete_message_seconds)))
              : 0;
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "member.ban",
            description: `BAN member ${userId} (delete_message_seconds=${deleteSeconds})`,
            method: "PUT",
            path: `/guilds/${config.guildId}/bans/${userId}`,
            body: { delete_message_seconds: deleteSeconds },
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "unban") {
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "member.unban",
            description: `Unban user ${userId}`,
            method: "DELETE",
            path: `/guilds/${config.guildId}/bans/${userId}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        return { status: "error", code: "unsupported_op" };
      },
    }),

    admin_plan_message_thread: tool({
      description:
        "Propose a message or thread management action (pin_message, unpin_message, delete_message, bulk_delete_messages, update_thread, delete_thread). " +
        "Nothing executes until the owner approves.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: [
              "pin_message",
              "unpin_message",
              "delete_message",
              "bulk_delete_messages",
              "update_thread",
              "delete_thread",
            ],
          },
          channel_id: { type: "string", description: "Target channel or thread ID." },
          message_id: {
            type: "string",
            description: "Target message ID (for pin/unpin/delete_message).",
          },
          message_ids: {
            type: "array",
            items: { type: "string" },
            description: "2–100 message IDs (<14 days old) for bulk_delete_messages.",
          },
          name: { type: "string", description: "Thread name for update_thread." },
          archived: { type: "boolean", description: "Archive/unarchive thread." },
          locked: { type: "boolean", description: "Lock/unlock thread." },
          auto_archive_duration: {
            type: "number",
            enum: [60, 1440, 4320, 10080],
            description: "Auto-archive duration in minutes.",
          },
          rate_limit_per_user: {
            type: "number",
            description: "Slowmode delay in seconds (0–21600).",
          },
          audit_reason: { type: "string" },
        },
        required: ["op", "channel_id"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        if (!isRecord(args) || typeof args.op !== "string" || !isSnowflake(args.channel_id)) {
          return { status: "error", code: "invalid_input" };
        }
        const channelId = args.channel_id;
        const auditReason = typeof args.audit_reason === "string" ? args.audit_reason : undefined;

        if (args.op === "pin_message" || args.op === "unpin_message") {
          if (!isSnowflake(args.message_id)) return { status: "error", code: "invalid_message_id" };
          const isPin = args.op === "pin_message";
          const built = buildOperation(config, protectedChannelIds, {
            actionType: isPin ? "message.pin" : "message.unpin",
            description: `${isPin ? "Pin" : "Unpin"} message ${args.message_id} in channel ${channelId}`,
            method: isPin ? "PUT" : "DELETE",
            path: `/channels/${channelId}/pins/${args.message_id}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "delete_message") {
          if (!isSnowflake(args.message_id)) return { status: "error", code: "invalid_message_id" };
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "message.delete",
            description: `DELETE message ${args.message_id} in channel ${channelId}`,
            method: "DELETE",
            path: `/channels/${channelId}/messages/${args.message_id}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "bulk_delete_messages") {
          const ids = parseOptionalStringArray(args.message_ids);
          if (!ids || ids.length < 2 || ids.length > 100 || !ids.every(isSnowflake)) {
            return { status: "error", code: "invalid_message_ids" };
          }
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "message.bulk_delete",
            description: `BULK DELETE ${ids.length} messages in channel ${channelId}`,
            method: "POST",
            path: `/channels/${channelId}/messages/bulk-delete`,
            body: { messages: ids },
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "update_thread") {
          const body: Record<string, unknown> = {};
          const parts: string[] = [];
          if (typeof args.name === "string" && args.name.trim() !== "") {
            body.name = args.name.trim().slice(0, 100);
            parts.push(`name=${String(body.name)}`);
          }
          if (typeof args.archived === "boolean") {
            body.archived = args.archived;
            parts.push(`archived=${String(args.archived)}`);
          }
          if (typeof args.locked === "boolean") {
            body.locked = args.locked;
            parts.push(`locked=${String(args.locked)}`);
          }
          if (typeof args.auto_archive_duration === "number") {
            body.auto_archive_duration = args.auto_archive_duration;
            parts.push(`autoArchive=${args.auto_archive_duration}m`);
          }
          if (typeof args.rate_limit_per_user === "number") {
            body.rate_limit_per_user = Math.max(
              0,
              Math.min(21600, Math.floor(args.rate_limit_per_user)),
            );
            parts.push(`slowmode=${String(body.rate_limit_per_user)}s`);
          }
          if (Object.keys(body).length === 0) return { status: "error", code: "empty_update" };
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "thread.update",
            description: `Update thread ${channelId} (${parts.join(", ")})`,
            method: "PATCH",
            path: `/channels/${channelId}`,
            body,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "delete_thread") {
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "thread.delete",
            description: `DELETE thread ${channelId}`,
            method: "DELETE",
            path: `/channels/${channelId}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        return { status: "error", code: "unsupported_op" };
      },
    }),

    admin_plan_guild: tool({
      description:
        "Propose server-level settings, invite, or webhook changes (update_guild, create_invite, delete_invite, create_webhook, delete_webhook). " +
        "Nothing executes until the owner approves.",
      inputSchema: jsonSchema<Record<string, unknown>>({
        type: "object",
        properties: {
          op: {
            type: "string",
            enum: [
              "update_guild",
              "create_invite",
              "delete_invite",
              "create_webhook",
              "delete_webhook",
            ],
          },
          name: {
            type: "string",
            description: "Guild name (update_guild) or webhook name (create_webhook).",
          },
          description: { type: ["string", "null"], description: "Guild description." },
          verification_level: { type: "number", description: "0–4." },
          default_message_notifications: { type: "number", description: "0=all, 1=mentions only." },
          explicit_content_filter: { type: "number", description: "0–2." },
          afk_channel_id: { type: ["string", "null"] },
          afk_timeout: { type: "number" },
          system_channel_id: { type: ["string", "null"] },
          channel_id: {
            type: "string",
            description: "Target channel ID for create_invite / create_webhook.",
          },
          max_age: { type: "number", description: "Invite duration in seconds (0–604800)." },
          max_uses: { type: "number", description: "Max invite uses (0–100)." },
          temporary: { type: "boolean", description: "Temporary membership invite." },
          invite_code: { type: "string", description: "Invite code to delete." },
          webhook_id: { type: "string", description: "Webhook ID to delete." },
          audit_reason: { type: "string" },
        },
        required: ["op"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        if (!isRecord(args) || typeof args.op !== "string") {
          return { status: "error", code: "invalid_input" };
        }
        const auditReason = typeof args.audit_reason === "string" ? args.audit_reason : undefined;

        if (args.op === "update_guild") {
          const body: Record<string, unknown> = {};
          const parts: string[] = [];
          if (typeof args.name === "string" && args.name.trim() !== "") {
            body.name = args.name.trim().slice(0, 100);
            parts.push(`name=${String(body.name)}`);
          }
          if (args.description === null || typeof args.description === "string") {
            body.description = args.description === null ? null : args.description.slice(0, 120);
            parts.push("description");
          }
          if (typeof args.verification_level === "number") {
            body.verification_level = args.verification_level;
            parts.push(`verification=${args.verification_level}`);
          }
          if (typeof args.default_message_notifications === "number") {
            body.default_message_notifications = args.default_message_notifications;
            parts.push(`notifications=${args.default_message_notifications}`);
          }
          if (typeof args.explicit_content_filter === "number") {
            body.explicit_content_filter = args.explicit_content_filter;
            parts.push(`contentFilter=${args.explicit_content_filter}`);
          }
          if (args.afk_channel_id === null || isSnowflake(args.afk_channel_id)) {
            body.afk_channel_id = args.afk_channel_id;
            parts.push(`afkChannel=${String(args.afk_channel_id)}`);
          }
          if (typeof args.afk_timeout === "number") {
            body.afk_timeout = args.afk_timeout;
            parts.push(`afkTimeout=${args.afk_timeout}`);
          }
          if (args.system_channel_id === null || isSnowflake(args.system_channel_id)) {
            body.system_channel_id = args.system_channel_id;
            parts.push(`systemChannel=${String(args.system_channel_id)}`);
          }
          if (Object.keys(body).length === 0) return { status: "error", code: "empty_update" };
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "guild.update",
            description: `Update server settings (${parts.join(", ")})`,
            method: "PATCH",
            path: `/guilds/${config.guildId}`,
            body,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "create_invite") {
          if (!isSnowflake(args.channel_id)) return { status: "error", code: "invalid_channel_id" };
          const body: Record<string, unknown> = {};
          if (typeof args.max_age === "number")
            body.max_age = Math.max(0, Math.min(604800, Math.floor(args.max_age)));
          if (typeof args.max_uses === "number")
            body.max_uses = Math.max(0, Math.min(100, Math.floor(args.max_uses)));
          if (typeof args.temporary === "boolean") body.temporary = args.temporary;
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "invite.create",
            description: `Create invite for channel ${args.channel_id}`,
            method: "POST",
            path: `/channels/${args.channel_id}/invites`,
            body,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "delete_invite") {
          if (typeof args.invite_code !== "string" || args.invite_code.trim() === "") {
            return { status: "error", code: "invalid_invite_code" };
          }
          const code = args.invite_code.trim();
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "invite.delete",
            description: `DELETE invite ${code}`,
            method: "DELETE",
            path: `/invites/${code}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "create_webhook") {
          if (!isSnowflake(args.channel_id)) return { status: "error", code: "invalid_channel_id" };
          if (typeof args.name !== "string" || args.name.trim() === "") {
            return { status: "error", code: "missing_name" };
          }
          const name = args.name.trim().slice(0, 80);
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "webhook.create",
            description: `Create webhook "${name}" in channel ${args.channel_id}`,
            method: "POST",
            path: `/channels/${args.channel_id}/webhooks`,
            body: { name },
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        if (args.op === "delete_webhook") {
          if (!isSnowflake(args.webhook_id)) return { status: "error", code: "invalid_webhook_id" };
          const built = buildOperation(config, protectedChannelIds, {
            actionType: "webhook.delete",
            description: `DELETE webhook ${args.webhook_id}`,
            method: "DELETE",
            path: `/webhooks/${args.webhook_id}`,
            auditReason,
          });
          return built.ok
            ? { status: "proposed", operation: built.operation }
            : { status: "rejected", reason: built.reason };
        }

        return { status: "error", code: "unsupported_op" };
      },
    }),

    admin_plan_rest: tool({
      description:
        `Universal fallback planner for ANY Discord REST v10 write operation on guild ${config.guildId} not covered by the structured tools ` +
        "(e.g. AutoMod rules, scheduled events, emojis, onboarding, soundboard). Nothing executes until the owner approves.",
      inputSchema: jsonSchema<{
        method: AdminHttpMethod;
        path: string;
        body?: Record<string, unknown> | Array<Record<string, unknown>>;
        description: string;
        audit_reason?: string;
      }>({
        type: "object",
        properties: {
          method: { type: "string", enum: ["POST", "PATCH", "PUT", "DELETE"] },
          path: {
            type: "string",
            description: `Discord REST v10 path starting with '/', scoped to guild ${config.guildId}, a guild channel, a guild webhook, or an invite.`,
          },
          body: {
            type: "object",
            description: "Optional JSON payload sent verbatim to Discord REST v10.",
          },
          description: {
            type: "string",
            description: "Concise, accurate description of what this REST call changes.",
          },
          audit_reason: { type: "string", description: "Short audit log reason." },
        },
        required: ["method", "path", "description"],
        additionalProperties: false,
      }),
      execute: async (args: unknown) => {
        if (!isRecord(args)) return { status: "error", code: "invalid_input" };
        if (
          args.method !== "POST" &&
          args.method !== "PATCH" &&
          args.method !== "PUT" &&
          args.method !== "DELETE"
        ) {
          return { status: "error", code: "invalid_method" };
        }
        if (
          typeof args.path !== "string" ||
          typeof args.description !== "string" ||
          args.description.trim() === ""
        ) {
          return { status: "error", code: "invalid_input" };
        }
        if (args.body !== undefined && !isRecord(args.body)) {
          return { status: "error", code: "invalid_body" };
        }
        const built = buildOperation(config, protectedChannelIds, {
          actionType: "rest.custom",
          description: args.description,
          method: args.method,
          path: args.path,
          ...(args.body === undefined ? {} : { body: args.body }),
          ...(typeof args.audit_reason === "string" ? { auditReason: args.audit_reason } : {}),
        });
        return built.ok
          ? { status: "proposed", operation: built.operation }
          : { status: "rejected", reason: built.reason };
      },
    }),
  };
}
