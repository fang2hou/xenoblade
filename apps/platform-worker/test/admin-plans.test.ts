import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import type * as Ai from "ai";
import type { AdminActionPlan, GenerationRequest } from "@xenoblade/contracts";
import type * as Tools from "../src/tools";

import { ADMIN_GENERATION_LIMITS, GENERATION_LIMITS } from "@xenoblade/ai";
import {
  ADMIN_PLAN_TTL_MS,
  classifyOperationRisk,
  createAdminPlan,
  decodeSensitivePermissions,
  encodePermissionNames,
  handleAdminPlanCancel,
  handleAdminPlanClaim,
  handleAdminPlanComplete,
  handleAdminPlanGet,
  hashAdminPlanPayload,
  isAdminSession,
  MAX_ADMIN_OPERATIONS,
  validateAdminRestPath,
  type AdminConfig,
} from "../src/admin-plans";
import { setGuildMemory, setUserMemory } from "../src/db";
import { generate } from "../src/generation";
import worker from "../src/index";
import { setBotSoul } from "../src/soul";
import { createAdminTools, createFirstPartyTools, extractAdminOperations } from "../src/tools";
import { createTestD1 } from "./helpers/d1";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof Ai>();
  return { ...actual, generateText: vi.fn() };
});

vi.mock("../src/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof Tools>();
  return {
    ...actual,
    connectMcpServers: async () => ({ tools: {}, clients: [] }),
    closeMcpClients: async () => {},
  };
});

const GUILD_ID = "100000000000000001";
const OWNER_ID = "200000000000000002";
const PRIVATE_CHANNEL_ID = "111111111111111111";
const CATEGORY_ID = "100000000000000000";
const PUBLIC_CHANNEL_ID = "222222222222222222";
const THREAD_ID = "333333333333333333";
const OTHER_USER_ID = "444444444444444444";
const ROLE_ID = "555555555555555555";
const TOKEN = "test-internal-token";

const CFG: AdminConfig = {
  guildId: GUILD_ID,
  ownerUserId: OWNER_ID,
};

function makeEnv(db = createTestD1(), overrides: Partial<Env> = {}): Env {
  return {
    DB: db,
    INTERNAL_API_TOKEN: TOKEN,
    OPENROUTER_API_KEY: "test-key",
    ADMIN_GUILD_ID: GUILD_ID,
    ADMIN_OWNER_USER_ID: OWNER_ID,
    ...overrides,
  } as Env;
}

function adminRequest(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    messageId: "m-admin-1",
    containerId: `discord:${GUILD_ID}:${PRIVATE_CHANNEL_ID}:${THREAD_ID}`,
    scopeId: GUILD_ID,
    channelId: THREAD_ID,
    parentChannelId: PRIVATE_CHANNEL_ID,
    publicChannelIds: [PUBLIC_CHANNEL_ID],
    adminMode: true,
    adminProtectedChannelIds: [THREAD_ID, PRIVATE_CHANNEL_ID, CATEGORY_ID],
    userId: OWNER_ID,
    userDisplayName: "Owner",
    summonKind: "thread-chat",
    content: "rename channel",
    history: [],
    reference: null,
    attachments: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isAdminSession four-factor gate", () => {
  it("allows only when env, guild, owner, and verified private channel/thread all pass", () => {
    const env = makeEnv();
    expect(isAdminSession(env, adminRequest())).toBe(true);
    expect(
      isAdminSession(env, adminRequest({ channelId: PRIVATE_CHANNEL_ID, parentChannelId: null })),
    ).toBe(true);

    // Fails closed if any factor is missing or mismatched.
    expect(isAdminSession(env, adminRequest({ adminMode: false }))).toBe(false);
    expect(isAdminSession(env, adminRequest({ adminMode: undefined }))).toBe(false);
    expect(isAdminSession(env, adminRequest({ userId: OTHER_USER_ID }))).toBe(false);
    expect(isAdminSession(env, adminRequest({ scopeId: "999999999999999999" }))).toBe(false);
    // Rejects even if adminMode=true was sent for a public channel or thread under a public channel.
    expect(
      isAdminSession(env, adminRequest({ channelId: PUBLIC_CHANNEL_ID, parentChannelId: null })),
    ).toBe(false);
    expect(
      isAdminSession(
        env,
        adminRequest({ channelId: THREAD_ID, parentChannelId: PUBLIC_CHANNEL_ID }),
      ),
    ).toBe(false);
    // Fails closed when env vars are missing/invalid.
    expect(isAdminSession(makeEnv(undefined, { ADMIN_GUILD_ID: "" }), adminRequest())).toBe(false);
    expect(
      isAdminSession(
        makeEnv(undefined, { ADMIN_OWNER_USER_ID: "not-a-snowflake" }),
        adminRequest(),
      ),
    ).toBe(false);
  });
});

describe("Discord permissions, path validation & risk classification", () => {
  it("encodes PascalCase and SNAKE_CASE permission names and detects sensitive bits", () => {
    const encoded = encodePermissionNames(["ViewChannel", "SEND_MESSAGES", "ManageRoles"]);
    expect(encoded.ok).toBe(true);
    if (!encoded.ok) return;
    expect(encoded.canonical).toEqual(["ViewChannel", "SendMessages", "ManageRoles"]);
    expect(decodeSensitivePermissions(encoded.bitfield)).toEqual(["ManageRoles"]);

    const unknown = encodePermissionNames(["NotARealPermission"]);
    expect(unknown).toEqual({ ok: false, unknown: ["NotARealPermission"] });
  });

  it("blocks cross-guild, path traversal, owner moderation, and admin channel/category self-lockout", () => {
    const protectedChannelIds = [THREAD_ID, PRIVATE_CHANNEL_ID, CATEGORY_ID];
    expect(validateAdminRestPath(`/guilds/${GUILD_ID}/channels`, CFG, "read").ok).toBe(true);
    expect(validateAdminRestPath("/guilds/999999999999999999/channels", CFG, "read")).toEqual({
      ok: false,
      reason: "cross_guild_forbidden",
    });
    expect(validateAdminRestPath(`/guilds/${GUILD_ID}/../users/@me`, CFG, "read")).toEqual({
      ok: false,
      reason: "invalid_path_segment",
    });
    expect(validateAdminRestPath("/users/@me", CFG, "write", { method: "PATCH" })).toEqual({
      ok: false,
      reason: "route_family_not_allowed",
    });
    // Owner cannot be banned, kicked, timed out, or renamed, but may be assigned a role.
    expect(
      validateAdminRestPath(`/guilds/${GUILD_ID}/bans/${OWNER_ID}`, CFG, "write", {
        method: "PUT",
      }),
    ).toEqual({ ok: false, reason: "owner_target_forbidden" });
    expect(
      validateAdminRestPath(`/guilds/${GUILD_ID}/members/${OWNER_ID}`, CFG, "write", {
        method: "DELETE",
      }),
    ).toEqual({ ok: false, reason: "owner_target_forbidden" });
    expect(
      validateAdminRestPath(`/guilds/${GUILD_ID}/members/${OWNER_ID}`, CFG, "write", {
        method: "PATCH",
      }),
    ).toEqual({ ok: false, reason: "owner_target_forbidden" });
    expect(
      validateAdminRestPath(
        `/guilds/${GUILD_ID}/members/${OWNER_ID}/roles/${ROLE_ID}`,
        CFG,
        "write",
        {
          method: "PUT",
        },
      ).ok,
    ).toBe(true);

    // Refined anti-lockout on active admin thread, parent private channel, and parent category:
    // forbids DELETE, granting @everyone ViewChannel, and denying owner/bot access,
    // while allowing safe role overwrite adjustments (flagged high-risk).
    for (const protectedId of protectedChannelIds) {
      expect(
        validateAdminRestPath(`/channels/${protectedId}`, CFG, "write", {
          method: "DELETE",
          protectedChannelIds,
        }),
      ).toEqual({ ok: false, reason: "admin_channel_lockout_forbidden" });
      expect(
        validateAdminRestPath(`/channels/${protectedId}/permissions/${GUILD_ID}`, CFG, "write", {
          method: "PUT",
          protectedChannelIds,
          body: { type: 0, allow: String(1n << 10n), deny: "0" },
        }),
      ).toEqual({ ok: false, reason: "admin_channel_lockout_forbidden" });
      expect(
        validateAdminRestPath(`/channels/${protectedId}/permissions/${OWNER_ID}`, CFG, "write", {
          method: "PUT",
          protectedChannelIds,
          body: { type: 1, allow: "0", deny: String(1n << 11n) },
        }),
      ).toEqual({ ok: false, reason: "admin_channel_lockout_forbidden" });
      expect(
        validateAdminRestPath(`/channels/${protectedId}`, CFG, "write", {
          method: "PATCH",
          protectedChannelIds,
          body: {
            permission_overwrites: [{ id: GUILD_ID, type: 0, allow: String(1n << 10n), deny: "0" }],
          },
        }),
      ).toEqual({ ok: false, reason: "admin_channel_lockout_forbidden" });
      // Safe role overwrite edits on protected channels are allowed.
      expect(
        validateAdminRestPath(`/channels/${protectedId}/permissions/${ROLE_ID}`, CFG, "write", {
          method: "PUT",
          protectedChannelIds,
          body: { type: 0, allow: String(1n << 10n), deny: "0" },
        }).ok,
      ).toBe(true);
      expect(
        validateAdminRestPath(`/channels/${protectedId}/permissions/${ROLE_ID}`, CFG, "write", {
          method: "DELETE",
          protectedChannelIds,
        }).ok,
      ).toBe(true);
      expect(
        validateAdminRestPath(`/channels/${protectedId}`, CFG, "write", {
          method: "PATCH",
          protectedChannelIds,
          body: {
            permission_overwrites: [
              { id: GUILD_ID, type: 0, allow: "0", deny: String(1n << 10n) },
              { id: ROLE_ID, type: 0, allow: String(1n << 10n), deny: "0" },
            ],
          },
        }).ok,
      ).toBe(true);
    }
    expect(validateAdminRestPath(`/channels/${PRIVATE_CHANNEL_ID}`, CFG, "read").ok).toBe(true);
  });

  it("classifies destructive, @everyone, protected-channel, and sensitive-permission writes as high risk", () => {
    expect(
      classifyOperationRisk("PATCH", `/channels/${PUBLIC_CHANNEL_ID}`, { name: "renamed" }, CFG),
    ).toEqual({ risk: "standard", riskReasons: [] });

    const protectedEdit = classifyOperationRisk(
      "PUT",
      `/channels/${PRIVATE_CHANNEL_ID}/permissions/${ROLE_ID}`,
      { type: 0, allow: "1024", deny: "0" },
      CFG,
      [THREAD_ID, PRIVATE_CHANNEL_ID, CATEGORY_ID],
    );
    expect(protectedEdit.risk).toBe("high");
    expect(protectedEdit.riskReasons).toContain("protected_channel_change");

    const del = classifyOperationRisk("DELETE", `/channels/${PUBLIC_CHANNEL_ID}`, undefined, CFG);
    expect(del.risk).toBe("high");
    expect(del.riskReasons).toContain("destructive_delete");

    const adminGrant = classifyOperationRisk(
      "PATCH",
      `/guilds/${GUILD_ID}/roles/${ROLE_ID}`,
      { permissions: "8" },
      CFG,
    );
    expect(adminGrant.risk).toBe("high");
    expect(adminGrant.riskReasons).toContain("sensitive_permission:Administrator");

    const everyoneEdit = classifyOperationRisk(
      "PUT",
      `/channels/${PUBLIC_CHANNEL_ID}/permissions/${GUILD_ID}`,
      { type: 0, allow: "1024", deny: "0" },
      CFG,
    );
    expect(everyoneEdit.risk).toBe("high");
    expect(everyoneEdit.riskReasons).toContain("everyone_overwrite_change");
  });
});

describe("admin_action_plans D1 persistence & atomic CAS", () => {
  async function seedPlan(db: D1Database, now = 1_700_000_000_000): Promise<AdminActionPlan> {
    const operations = [
      {
        id: "op-1",
        actionType: "channel.update",
        description: `Update channel ${PUBLIC_CHANNEL_ID}`,
        method: "PATCH" as const,
        path: `/channels/${PUBLIC_CHANNEL_ID}`,
        body: { name: "announcements" },
        risk: "standard" as const,
      },
    ];
    const payloadHash = await hashAdminPlanPayload(GUILD_ID, OWNER_ID, operations);
    const plan: AdminActionPlan = {
      id: "plan-1",
      guildId: GUILD_ID,
      channelId: THREAD_ID,
      ownerUserId: OWNER_ID,
      summary: "Update channel",
      operations,
      risk: "standard",
      payloadHash,
      createdAt: now,
      expiresAt: now + ADMIN_PLAN_TTL_MS,
    };
    await createAdminPlan(db, plan);
    return plan;
  }

  it("claims a pending plan exactly once, prevents replay, and records completion", async () => {
    const db = createTestD1();
    const env = makeEnv(db);
    const now = 1_700_000_000_000;
    const plan = await seedPlan(db, now);

    const fetched = await handleAdminPlanGet(db, env, {
      planId: plan.id,
      guildId: GUILD_ID,
      ownerUserId: OWNER_ID,
    });
    expect(fetched.status).toBe("ok");

    const wrongOwner = await handleAdminPlanClaim(
      db,
      env,
      { planId: plan.id, guildId: GUILD_ID, ownerUserId: OTHER_USER_ID },
      now + 1000,
    );
    expect(wrongOwner).toEqual({ status: "error", code: "not_owner" });

    const badHash = await handleAdminPlanClaim(
      db,
      env,
      { planId: plan.id, guildId: GUILD_ID, ownerUserId: OWNER_ID, payloadHash: "deadbeef" },
      now + 1000,
    );
    expect(badHash).toEqual({ status: "error", code: "hash_mismatch" });

    const first = await handleAdminPlanClaim(
      db,
      env,
      { planId: plan.id, guildId: GUILD_ID, ownerUserId: OWNER_ID, payloadHash: plan.payloadHash },
      now + 1000,
    );
    expect(first.status).toBe("ok");

    const replay = await handleAdminPlanClaim(
      db,
      env,
      { planId: plan.id, guildId: GUILD_ID, ownerUserId: OWNER_ID, payloadHash: plan.payloadHash },
      now + 2000,
    );
    expect(replay).toEqual({ status: "error", code: "already_settled" });

    const completed = await handleAdminPlanComplete(
      db,
      env,
      {
        planId: plan.id,
        guildId: GUILD_ID,
        ownerUserId: OWNER_ID,
        outcome: "completed",
        results: [{ id: "op-1", status: "succeeded", httpStatus: 200 }],
      },
      now + 3000,
    );
    expect(completed).toEqual({ status: "ok" });
  });

  it("rejects expired plans and allows owner cancel", async () => {
    const db = createTestD1();
    const env = makeEnv(db);
    const now = 1_700_000_000_000;
    const plan = await seedPlan(db, now);

    const expired = await handleAdminPlanClaim(
      db,
      env,
      { planId: plan.id, guildId: GUILD_ID, ownerUserId: OWNER_ID },
      now + ADMIN_PLAN_TTL_MS + 1,
    );
    expect(expired).toEqual({ status: "error", code: "expired" });

    const plan2 = { ...plan, id: "plan-2" };
    await createAdminPlan(db, plan2);
    const cancelled = await handleAdminPlanCancel(
      db,
      env,
      { planId: "plan-2", guildId: GUILD_ID, ownerUserId: OWNER_ID },
      now + 500,
    );
    expect(cancelled).toEqual({ status: "ok", cancelled: true });
  });

  it("exposes /internal/v1/admin/plans/get behind Bearer auth", async () => {
    const env = makeEnv();
    const res = await worker.fetch(
      new Request("https://worker/internal/v1/admin/plans/get", {
        method: "POST",
        headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
        body: JSON.stringify({ planId: "missing", guildId: GUILD_ID, ownerUserId: OWNER_ID }),
      }) as unknown as Parameters<typeof worker.fetch>[0],
      env,
      {} as ExecutionContext,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "error", code: "not_found" });
  });
});

describe("admin generation isolation, read-proxy continuation & budget accounting", () => {
  it("omits guild-writable bot_soul & guild_memory while preserving owner user_memory", async () => {
    const db = createTestD1();
    await setBotSoul(db, {
      scopeId: GUILD_ID,
      content: "POISONED_SOUL_INSTRUCTION",
      updatedBy: OTHER_USER_ID,
      now: Date.now(),
    });
    await setGuildMemory(db, {
      guildId: GUILD_ID,
      category: "fact",
      key: "poison",
      value: "POISONED_GUILD_MEMORY",
      updatedBy: OTHER_USER_ID,
      now: Date.now(),
    });
    await setUserMemory(db, {
      userId: OWNER_ID,
      category: "preference",
      key: "style",
      value: "OWNER_PERSONAL_PREF",
    });
    const env = makeEnv(db);

    vi.mocked(generateText).mockResolvedValue({
      text: "Planned changes.",
      usage: { inputTokens: 10, outputTokens: 10, inputTokenDetails: {} },
      toolResults: [],
      steps: [{}],
    } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);

    const result = await generate(env, adminRequest());
    expect(result.status).toBe("completed");
    const system = String(vi.mocked(generateText).mock.calls[0]?.[0]?.system);
    expect(system).toContain("Server administration mode");
    expect(system).toContain("OWNER_PERSONAL_PREF");
    expect(system).not.toContain("POISONED_SOUL_INSTRUCTION");
    expect(system).not.toContain("POISONED_GUILD_MEMORY");

    const tools = createFirstPartyTools(env, adminRequest(), 0);
    expect(Object.keys(tools)).toEqual(
      expect.arrayContaining([
        "discord_api_read",
        "admin_plan_batch",
        "admin_plan_channel",
        "admin_plan_role",
        "admin_plan_member",
        "admin_plan_message_thread",
        "admin_plan_guild",
        "admin_plan_rest",
        "search_chat_history",
      ]),
    );
    expect(system).toContain("admin_plan_batch");
    expect(system).toContain("permission_overwrites");

    const nonAdminTools = createFirstPartyTools(
      env,
      adminRequest({ userId: OTHER_USER_ID, adminMode: false }),
      0,
    );
    expect(Object.keys(nonAdminTools)).not.toContain("discord_api_read");
    expect(Object.keys(nonAdminTools)).not.toContain("admin_plan_batch");
    expect(Object.keys(nonAdminTools)).not.toContain("admin_plan_rest");
  });

  it("passes elevated maxOutputTokens and 120s total timeout (no short per-step cap) for admin sessions only", async () => {
    const db = createTestD1();
    const env = makeEnv(db);
    vi.mocked(generateText).mockResolvedValue({
      text: "Done.",
      usage: { inputTokens: 10, outputTokens: 10, inputTokenDetails: {} },
      toolResults: [],
      steps: [{}],
    } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);

    await generate(env, adminRequest({ messageId: "m-admin-limits" }));
    const adminCall = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(adminCall?.maxOutputTokens).toBe(ADMIN_GENERATION_LIMITS.maxOutputTokens);
    expect(ADMIN_GENERATION_LIMITS.maxOutputTokens).toBe(32_768);
    expect(typeof adminCall?.timeout).toBe("number");
    const adminTimeout = adminCall?.timeout as number;
    expect(adminTimeout).toBeLessThanOrEqual(ADMIN_GENERATION_LIMITS.timeout.totalMs);
    expect(adminTimeout).toBeGreaterThan(GENERATION_LIMITS.timeout.totalMs);
    expect(adminTimeout).toBeGreaterThanOrEqual(115_000);

    await generate(
      env,
      adminRequest({
        messageId: "m-normal-limits",
        userId: OTHER_USER_ID,
        adminMode: false,
      }),
    );
    const normalCall = vi.mocked(generateText).mock.calls[1]?.[0];
    expect(normalCall?.maxOutputTokens).toBe(GENERATION_LIMITS.maxOutputTokens);
    expect(typeof normalCall?.timeout).toBe("number");
    expect(normalCall?.timeout as number).toBeLessThanOrEqual(GENERATION_LIMITS.timeout.totalMs);
  });

  it("allows a slow 65s single-step admin_plan_batch generation to succeed on primary without tripping a 45s step timeout", async () => {
    vi.useFakeTimers();
    try {
      const db = createTestD1();
      const env = makeEnv(db);
      const adminTools = createAdminTools({
        config: CFG,
        protectedChannelIds: [THREAD_ID, PRIVATE_CHANNEL_ID, CATEGORY_ID],
        readResults: [],
      });
      const batchTool = adminTools.admin_plan_batch as unknown as {
        execute: (args: unknown) => Promise<Record<string, unknown>>;
      };
      const batchOut = await batchTool.execute({
        operations: [
          {
            tool: "role",
            params: {
              op: "update",
              role_id: ROLE_ID,
              permissions: ["SendMessages", "AttachFiles"],
            },
          },
          {
            tool: "channel",
            params: {
              op: "update",
              channel_id: PUBLIC_CHANNEL_ID,
              permission_overwrites: [
                { target_id: GUILD_ID, target_type: "role", deny_permissions: ["ViewChannel"] },
                { target_id: ROLE_ID, target_type: "role", allow_permissions: ["ViewChannel"] },
              ],
            },
          },
        ],
      });

      vi.mocked(generateText).mockImplementationOnce(async ({ timeout }) => {
        expect(typeof timeout).toBe("number");
        expect(timeout as number).toBeGreaterThanOrEqual(115_000);
        await new Promise((resolve) => setTimeout(resolve, 65_000));
        return {
          text: "Phase 1 & 2 planned — please review and approve.",
          usage: { inputTokens: 19_000, outputTokens: 6_500, inputTokenDetails: {} },
          toolResults: [{ toolName: "admin_plan_batch", input: {}, output: batchOut }],
          steps: [{}, {}],
        } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>;
      });

      const pending = generate(
        env,
        adminRequest({ messageId: "m-slow-batch:ar:1", adminContinuation: true }),
      );
      await vi.advanceTimersByTimeAsync(70_000);
      const res = await pending;
      expect(res.status).toBe("completed");
      if (res.status !== "completed") return;
      expect(res.adminActionPlan?.operations).toHaveLength(2);
      expect(generateText).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("supports whole-channel permission_overwrites on admin_plan_channel(update) and admin_plan_batch with explicit operation limit", async () => {
    const tools = createAdminTools({
      config: CFG,
      protectedChannelIds: [THREAD_ID, PRIVATE_CHANNEL_ID, CATEGORY_ID],
      readResults: [],
    });
    const channelTool = tools.admin_plan_channel as unknown as {
      execute: (args: unknown) => Promise<Record<string, unknown>>;
    };
    const batchTool = tools.admin_plan_batch as unknown as {
      execute: (args: unknown) => Promise<Record<string, unknown>>;
    };

    // Whole-channel permission_overwrites update encodes human-readable permissions & flags high risk.
    const wholeChannelRes = await channelTool.execute({
      op: "update",
      channel_id: PUBLIC_CHANNEL_ID,
      permission_overwrites: [
        { target_id: GUILD_ID, target_type: "role", deny_permissions: ["ViewChannel"] },
        {
          target_id: ROLE_ID,
          target_type: "role",
          allow_permissions: ["ViewChannel", "ManageMessages"],
        },
      ],
    });
    expect(wholeChannelRes.status).toBe("proposed");
    const wholeOp = wholeChannelRes.operation as {
      method: string;
      path: string;
      risk: string;
      riskReasons: string[];
      body: {
        permission_overwrites: Array<{ id: string; type: number; allow: string; deny: string }>;
      };
    };
    expect(wholeOp.method).toBe("PATCH");
    expect(wholeOp.path).toBe(`/channels/${PUBLIC_CHANNEL_ID}`);
    expect(wholeOp.risk).toBe("high");
    expect(wholeOp.riskReasons).toEqual(
      expect.arrayContaining(["everyone_overwrite_change", "sensitive_permission:ManageMessages"]),
    );
    expect(wholeOp.body.permission_overwrites).toEqual([
      { id: GUILD_ID, type: 0, allow: "0", deny: "1024" },
      { id: ROLE_ID, type: 0, allow: "9216", deny: "0" },
    ]);

    // Safe overwrite on protected channel is allowed and marked high-risk; exposing @everyone ViewChannel is rejected.
    const protectedAllowed = await channelTool.execute({
      op: "update",
      channel_id: PRIVATE_CHANNEL_ID,
      permission_overwrites: [
        { target_id: GUILD_ID, target_type: "role", deny_permissions: ["ViewChannel"] },
        { target_id: ROLE_ID, target_type: "role", allow_permissions: ["ViewChannel"] },
      ],
    });
    expect(protectedAllowed.status).toBe("proposed");
    expect((protectedAllowed.operation as { risk: string; riskReasons: string[] }).risk).toBe(
      "high",
    );
    expect((protectedAllowed.operation as { riskReasons: string[] }).riskReasons).toContain(
      "protected_channel_change",
    );

    const protectedExpose = await channelTool.execute({
      op: "update",
      channel_id: PRIVATE_CHANNEL_ID,
      permission_overwrites: [
        { target_id: GUILD_ID, target_type: "role", allow_permissions: ["ViewChannel"] },
      ],
    });
    expect(protectedExpose).toEqual({
      status: "rejected",
      reason: "admin_channel_lockout_forbidden",
    });

    // Batch planning bundles multiple role + channel ops in one call and explicitly rejects overflow at MAX_ADMIN_OPERATIONS (30).
    expect(MAX_ADMIN_OPERATIONS).toBe(30);
    const batchEntries = Array.from({ length: MAX_ADMIN_OPERATIONS }, (_, idx) => ({
      tool: idx % 2 === 0 ? "role" : "channel",
      params:
        idx % 2 === 0
          ? { op: "update", role_id: ROLE_ID, permissions: ["SendMessages", "AttachFiles"] }
          : { op: "update", channel_id: PUBLIC_CHANNEL_ID, name: `ch-${idx}` },
    }));
    // 2 slots were already consumed above, so 28 should succeed and 2 should be explicitly rejected.
    const batchRes = await batchTool.execute({ operations: batchEntries });
    expect(batchRes.status).toBe("proposed_batch");
    expect(batchRes.proposedCount).toBe(MAX_ADMIN_OPERATIONS - 2);
    expect(batchRes.rejectedCount).toBe(2);
    expect(batchRes.remainingSlots).toBe(0);
    const batchResults = batchRes.results as Array<Record<string, unknown>>;
    expect(batchResults.at(-1)).toMatchObject({
      status: "rejected",
      reason: "plan_operation_limit_reached",
      limit: MAX_ADMIN_OPERATIONS,
    });

    // Any further single-op or batch call explicitly rejects with plan_operation_limit_reached.
    const extraSingle = await channelTool.execute({
      op: "update",
      channel_id: PUBLIC_CHANNEL_ID,
      name: "overflow",
    });
    expect(extraSingle).toEqual({
      status: "rejected",
      reason: "plan_operation_limit_reached",
      limit: MAX_ADMIN_OPERATIONS,
    });

    const extracted = extractAdminOperations([
      { toolName: "admin_plan_channel", output: wholeChannelRes },
      { toolName: "admin_plan_channel", output: protectedAllowed },
      { toolName: "admin_plan_batch", output: batchRes },
    ]);
    expect(extracted).toHaveLength(MAX_ADMIN_OPERATIONS);
  });

  it("suspends on discord_api_read, skips duplicate budget reservation on continuation, and persists adminActionPlan", async () => {
    const db = createTestD1();
    const env = makeEnv(db);

    const adminTools = createAdminTools({
      config: CFG,
      protectedChannelIds: [THREAD_ID, PRIVATE_CHANNEL_ID, CATEGORY_ID],
      readResults: [],
    });
    const readTool = adminTools.discord_api_read as unknown as {
      execute: (args: unknown) => Promise<unknown>;
    };
    const readOutput = await readTool.execute({ path: `/guilds/${GUILD_ID}/channels` });

    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      usage: { inputTokens: 10, outputTokens: 5, inputTokenDetails: {} },
      toolResults: [{ toolName: "discord_api_read", input: {}, output: readOutput }],
      steps: [{}],
    } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);

    const hop0 = await generate(env, adminRequest({ messageId: "m-hop-0" }));
    expect(hop0.status).toBe("completed");
    if (hop0.status !== "completed") return;
    expect(hop0.discordReadRequests).toHaveLength(1);

    const reservationsAfterHop0 = await db
      .prepare("SELECT COUNT(*) AS n FROM generation_reservations")
      .first<{ n: number }>();
    expect(reservationsAfterHop0?.n).toBe(1);

    const channelTool = adminTools.admin_plan_channel as unknown as {
      execute: (args: unknown) => Promise<unknown>;
    };
    const guildTool = adminTools.admin_plan_guild as unknown as {
      execute: (args: unknown) => Promise<unknown>;
    };
    const planOp1 = await channelTool.execute({
      op: "update",
      channel_id: PUBLIC_CHANNEL_ID,
      name: "new-name",
    });
    const planOp2 = await guildTool.execute({
      op: "create_invite",
      channel_id: PUBLIC_CHANNEL_ID,
      max_uses: 5,
    });

    vi.mocked(generateText).mockResolvedValueOnce({
      text: "Ready — please approve below.",
      usage: { inputTokens: 20, outputTokens: 15, inputTokenDetails: {} },
      toolResults: [
        { toolName: "admin_plan_channel", input: {}, output: planOp1 },
        { toolName: "admin_plan_guild", input: {}, output: planOp2 },
      ],
      steps: [{}],
    } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);

    const hop1 = await generate(
      env,
      adminRequest({
        messageId: "m-hop-0:ar:1",
        adminContinuation: true,
        adminReadResults: [
          {
            id: "r1",
            path: `/guilds/${GUILD_ID}/channels`,
            ok: true,
            status: 200,
            data: [{ id: PUBLIC_CHANNEL_ID, name: "old-name" }],
          },
        ],
      }),
    );
    expect(hop1.status).toBe("completed");
    if (hop1.status !== "completed") return;
    expect(hop1.adminActionPlan?.operations).toHaveLength(2);
    expect(hop1.adminActionPlan?.risk).toBe("standard");

    // Continuation hop must NOT charge a second 24h budget reservation.
    const reservationsAfterHop1 = await db
      .prepare("SELECT COUNT(*) AS n FROM generation_reservations")
      .first<{ n: number }>();
    expect(reservationsAfterHop1?.n).toBe(1);

    const stored = await handleAdminPlanGet(db, env, {
      planId: hop1.adminActionPlan!.id,
      guildId: GUILD_ID,
      ownerUserId: OWNER_ID,
    });
    expect(stored.status).toBe("ok");
  });
});
