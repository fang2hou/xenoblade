import { describe, expect, it, vi, type Mock } from "vitest";
import type { AdminActionPlan } from "@xenoblade/contracts";

import {
  buildAuditReason,
  executeAdminPlan,
  executeDiscordReads,
  type AdminDiscordClient,
} from "../src/admin-executor";
import type { AdminRuntimeConfig } from "../src/env";

const ADMIN: AdminRuntimeConfig = {
  guildId: "100000000000000001",
  ownerUserId: "200000000000000002",
};
const CATEGORY_ID = "100000000000000000";
const ADMIN_CHANNEL = "111111111111111111";
const ADMIN_THREAD = "111111111111111112";
const TARGET_CHANNEL = "222222222222222222";
const FOREIGN_CHANNEL = "999999999999999999";
const BOT_MANAGED_ROLE = "300000000000000003";

type RestFn = (...args: unknown[]) => Promise<unknown>;

function makeClient(): {
  client: AdminDiscordClient;
  rest: {
    get: Mock<RestFn>;
    post: Mock<RestFn>;
    patch: Mock<RestFn>;
    put: Mock<RestFn>;
    delete: Mock<RestFn>;
  };
} {
  const rest = {
    get: vi.fn<RestFn>(async (route: unknown) => {
      if (route === "/invites/own-code") return { guild: { id: ADMIN.guildId } };
      if (route === "/invites/foreign-code") return { guild: { id: "777777777777777777" } };
      return { ok: true };
    }),
    post: vi.fn<RestFn>(async () => ({ id: "created" })),
    patch: vi.fn<RestFn>(async () => ({ id: "updated" })),
    put: vi.fn<RestFn>(async () => undefined),
    delete: vi.fn<RestFn>(async () => undefined),
  };
  const channelMap = new Map<string, { guildId?: string | null; parentId?: string | null }>([
    [CATEGORY_ID, { guildId: ADMIN.guildId, parentId: null }],
    [ADMIN_CHANNEL, { guildId: ADMIN.guildId, parentId: CATEGORY_ID }],
    [ADMIN_THREAD, { guildId: ADMIN.guildId, parentId: ADMIN_CHANNEL }],
    [TARGET_CHANNEL, { guildId: ADMIN.guildId, parentId: null }],
    [FOREIGN_CHANNEL, { guildId: "777777777777777777", parentId: null }],
  ]);
  const client: AdminDiscordClient = {
    user: { id: "400000000000000004" },
    rest: rest as unknown as AdminDiscordClient["rest"],
    guilds: {
      cache: {
        get: (id) =>
          id === ADMIN.guildId
            ? { roles: { botRoleFor: () => ({ id: BOT_MANAGED_ROLE }) } }
            : undefined,
      },
    },
    channels: {
      cache: { get: (id) => channelMap.get(id) },
      fetch: async (id) => channelMap.get(id) ?? null,
    },
  };
  return { client, rest };
}

function makePlan(operations: AdminActionPlan["operations"]): AdminActionPlan {
  return {
    id: "12345678-aaaa-bbbb-cccc-1234567890ab",
    guildId: ADMIN.guildId,
    channelId: ADMIN_THREAD,
    ownerUserId: ADMIN.ownerUserId,
    summary: "test plan",
    operations,
    risk: operations.some((op) => op.risk === "high") ? "high" : "standard",
    payloadHash: "abc123",
    createdAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

describe("executeDiscordReads", () => {
  it("runs guild-scoped GETs, blocks cross-guild resources, and trims oversized arrays", async () => {
    const { client, rest } = makeClient();
    rest.get.mockResolvedValueOnce(
      Array.from({ length: 400 }, (_, i) => ({ id: String(i), padding: "x".repeat(80) })),
    );

    const results = await executeDiscordReads(client, ADMIN, [
      { id: "r1", path: `/guilds/${ADMIN.guildId}/channels` },
      { id: "r2", path: `/channels/${FOREIGN_CHANNEL}` },
      { id: "r3", path: "/guilds/777777777777777777/roles" },
      { id: "r4", path: `/channels/${TARGET_CHANNEL}/pins` },
      { id: "r5", path: "/invites/foreign-code" },
    ]);

    expect(results[0]?.ok).toBe(true);
    expect(results[0]?.data).toMatchObject({ truncated: true, totalCount: 400 });
    expect(results[1]).toMatchObject({ ok: false, error: "channel_not_in_target_guild" });
    expect(results[2]).toMatchObject({ ok: false, error: "cross_guild_forbidden" });
    expect(results[3]?.ok).toBe(true);
    expect(results[4]).toMatchObject({ ok: false, error: "invite_not_in_target_guild" });
  });
});

describe("executeAdminPlan", () => {
  it("executes operations verbatim with audit log reason and stops on first error", async () => {
    const { client, rest } = makeClient();
    rest.patch.mockRejectedValueOnce(new Error("Missing Permissions"));

    const plan = makePlan([
      {
        id: "op-1",
        actionType: "channel.create",
        description: "Create channel",
        method: "POST",
        path: `/guilds/${ADMIN.guildId}/channels`,
        body: { name: "ops", type: 0 },
        auditReason: "new ops channel",
        risk: "standard",
      },
      {
        id: "op-2",
        actionType: "channel.update",
        description: "Rename channel",
        method: "PATCH",
        path: `/channels/${TARGET_CHANNEL}`,
        body: { name: "renamed" },
        risk: "standard",
      },
      {
        id: "op-3",
        actionType: "role.assign",
        description: "Assign role",
        method: "PUT",
        path: `/guilds/${ADMIN.guildId}/members/444444444444444444/roles/555555555555555555`,
        risk: "standard",
      },
    ]);

    const res = await executeAdminPlan(client, ADMIN, plan);
    expect(res.outcome).toBe("failed");
    expect(res.results[0]).toMatchObject({ id: "op-1", status: "succeeded" });
    expect(res.results[1]).toMatchObject({ id: "op-2", status: "failed" });
    expect(res.results[2]).toEqual({ id: "op-3", status: "skipped" });

    expect(rest.post).toHaveBeenCalledWith(
      `/guilds/${ADMIN.guildId}/channels`,
      expect.objectContaining({
        body: { name: "ops", type: 0 },
        reason: buildAuditReason(plan, plan.operations[0]!),
      }),
    );
    expect(rest.put).not.toHaveBeenCalled();
  });

  it("enforces anti-lockout on bot managed role, active thread, parent channel, parent category, and foreign invites", async () => {
    const { client, rest } = makeClient();

    const managedRolePlan = makePlan([
      {
        id: "op-bot-role",
        actionType: "role.position",
        description: "Move bot role",
        method: "PATCH",
        path: `/guilds/${ADMIN.guildId}/roles`,
        body: [{ id: BOT_MANAGED_ROLE, position: 1 }],
        risk: "standard",
      },
    ]);
    expect((await executeAdminPlan(client, ADMIN, managedRolePlan)).results[0]).toMatchObject({
      error: "bot_managed_role_forbidden",
    });

    // Parent category of the admin channel is protected too.
    const categoryLockoutPlan = makePlan([
      {
        id: "op-cat",
        actionType: "channel.delete",
        description: "Delete parent category",
        method: "DELETE",
        path: `/channels/${CATEGORY_ID}`,
        risk: "high",
      },
    ]);
    expect((await executeAdminPlan(client, ADMIN, categoryLockoutPlan)).results[0]).toMatchObject({
      error: "admin_channel_lockout_forbidden",
    });

    // Foreign invite cannot be deleted.
    const foreignInvitePlan = makePlan([
      {
        id: "op-inv",
        actionType: "invite.delete",
        description: "Delete foreign invite",
        method: "DELETE",
        path: "/invites/foreign-code",
        risk: "high",
      },
    ]);
    expect((await executeAdminPlan(client, ADMIN, foreignInvitePlan)).results[0]).toMatchObject({
      error: "invite_not_in_target_guild",
    });
    expect(rest.delete).not.toHaveBeenCalled();
  });
});
