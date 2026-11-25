import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  ButtonStyle,
  MessageFlags,
  type Message,
  type MessageComponentInteraction,
} from "discord.js";
import type { AdminActionPlan } from "@xenoblade/contracts";

import {
  adminButtonCustomId,
  AdminConfirmRegistry,
  buildAdminConfirmCard,
  buildAdminConfirmRow,
  handleAdminConfirmInteraction,
} from "../src/admin-confirm";
import type { AdminDiscordClient } from "../src/admin-executor";
import * as aiClient from "../src/ai-client";
import type { EnvConfig } from "../src/env";
import { messages } from "../src/i18n";
import type * as Language from "../src/language";

vi.mock("../src/ai-client", async (importOriginal) => {
  const actual = await importOriginal<typeof aiClient>();
  return {
    ...actual,
    getAdminPlan: vi.fn<typeof aiClient.getAdminPlan>(),
    claimAdminPlan: vi.fn<typeof aiClient.claimAdminPlan>(),
    completeAdminPlan: vi.fn<typeof aiClient.completeAdminPlan>(),
    cancelAdminPlan: vi.fn<typeof aiClient.cancelAdminPlan>(),
  };
});

vi.mock("../src/language", async (importOriginal) => {
  const actual = await importOriginal<typeof Language>();
  return {
    ...actual,
    resolveUiLanguageBounded: vi.fn<typeof Language.resolveUiLanguageBounded>(async () => "zh"),
  };
});

const GUILD_ID = "100000000000000001";
const OWNER_ID = "200000000000000002";
const ADMIN_CHANNEL_ID = "111111111111111111";
const TARGET_CHANNEL_ID = "222222222222222222";
const OTHER_USER_ID = "444444444444444444";

const ENV: EnvConfig = {
  discordBotToken: "token",
  discordApplicationId: "400000000000000004",
  workerUrl: "https://worker",
  internalApiToken: "secret",
  mentionRoleIds: [],
  healthPort: 8397,
  admin: { guildId: GUILD_ID, ownerUserId: OWNER_ID },
};

function makePlan(risk: "standard" | "high"): AdminActionPlan {
  return {
    id: "plan-abc-123",
    guildId: GUILD_ID,
    channelId: ADMIN_CHANNEL_ID,
    ownerUserId: OWNER_ID,
    summary: "test",
    operations: [
      {
        id: "op-1",
        actionType: risk === "high" ? "channel.delete" : "channel.update",
        description: risk === "high" ? `DELETE channel ${TARGET_CHANNEL_ID}` : "Rename channel",
        method: risk === "high" ? "DELETE" : "PATCH",
        path: `/channels/${TARGET_CHANNEL_ID}`,
        ...(risk === "high" ? {} : { body: { name: "renamed" } }),
        risk,
        ...(risk === "high" ? { riskReasons: ["destructive_delete"] } : {}),
      },
    ],
    risk,
    payloadHash: "deadbeef12345678",
    createdAt: Date.now(),
    expiresAt: Date.now() + 600_000,
  };
}

type AsyncVoid = (...args: unknown[]) => Promise<unknown>;

function makeClient(): {
  client: AdminDiscordClient;
  patch: Mock<AsyncVoid>;
  del: Mock<AsyncVoid>;
} {
  const patch = vi.fn<AsyncVoid>(async () => ({}));
  const del = vi.fn<AsyncVoid>(async () => undefined);
  const client: AdminDiscordClient = {
    user: { id: "400000000000000004" },
    rest: {
      get: vi.fn<AsyncVoid>(),
      post: vi.fn<AsyncVoid>(),
      patch,
      put: vi.fn<AsyncVoid>(),
      delete: del,
    } as unknown as AdminDiscordClient["rest"],
    guilds: { cache: { get: () => undefined } },
    channels: {
      cache: { get: () => ({ guildId: GUILD_ID, parentId: null }) },
      fetch: async () => ({ guildId: GUILD_ID, parentId: null }),
    },
  };
  return { client, patch, del };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildAdminConfirmCard & row", () => {
  it("renders deterministic operations, escapes control characters, and uses Success/Danger button styles", () => {
    const texts = messages("zh").adminConfirm;
    const highPlan = makePlan("high");
    highPlan.operations[0]!.description = "Delete\n```fake```";

    const card = buildAdminConfirmCard(texts, highPlan);
    expect(card.content).toContain("HIGH");
    expect(card.content).toContain(`DELETE /channels/${TARGET_CHANNEL_ID}`);
    expect(card.content).toContain("\\n");
    expect(card.content).toContain("````");

    const highRow = buildAdminConfirmRow(texts, highPlan).toJSON();
    expect(highRow.components[0]).toMatchObject({ style: ButtonStyle.Danger });
    expect(highRow.components[1]).toMatchObject({ style: ButtonStyle.Secondary });

    const stdRow = buildAdminConfirmRow(texts, makePlan("standard")).toJSON();
    expect(stdRow.components[0]).toMatchObject({ style: ButtonStyle.Success });
  });
});

describe("handleAdminConfirmInteraction", () => {
  it("refuses clicks from non-owner users without calling Worker or Discord REST", async () => {
    const registry = new AdminConfirmRegistry();
    const plan = makePlan("standard");
    const edit = vi.fn<AsyncVoid>(async () => undefined);
    registry.register(plan.id, {
      plan,
      message: { id: "msg-1", edit } as unknown as Message,
      texts: messages("zh").adminConfirm,
      busy: false,
      timer: undefined,
    });
    const reply = vi.fn<AsyncVoid>(async () => undefined);
    const { client, patch } = makeClient();

    await handleAdminConfirmInteraction(
      {
        customId: adminButtonCustomId("approve", plan.id),
        guildId: GUILD_ID,
        user: { id: OTHER_USER_ID },
        message: { id: "msg-1", edit },
        reply,
      } as unknown as MessageComponentInteraction,
      client,
      ENV,
      registry,
    );

    expect(reply).toHaveBeenCalledWith(expect.objectContaining({ flags: MessageFlags.Ephemeral }));
    expect(aiClient.claimAdminPlan).not.toHaveBeenCalled();
    expect(patch).not.toHaveBeenCalled();
  });

  it("executes standard and high-risk plans directly on owner approve click after D1 CAS claim", async () => {
    const registry = new AdminConfirmRegistry();
    const plan = makePlan("high");
    const edit = vi.fn<AsyncVoid>(async () => undefined);
    registry.register(plan.id, {
      plan,
      message: { id: "msg-2", edit } as unknown as Message,
      texts: messages("zh").adminConfirm,
      busy: false,
      timer: undefined,
    });
    vi.mocked(aiClient.claimAdminPlan).mockResolvedValue({ status: "ok", plan });
    vi.mocked(aiClient.completeAdminPlan).mockResolvedValue({ status: "ok" });

    const { client, del } = makeClient();
    const deferUpdate = vi.fn<AsyncVoid>(async () => undefined);

    await handleAdminConfirmInteraction(
      {
        customId: adminButtonCustomId("approve", plan.id),
        guildId: GUILD_ID,
        user: { id: OWNER_ID },
        message: { id: "msg-2", edit },
        deferUpdate,
      } as unknown as MessageComponentInteraction,
      client,
      ENV,
      registry,
    );

    expect(deferUpdate).toHaveBeenCalledTimes(1);
    expect(aiClient.claimAdminPlan).toHaveBeenCalledTimes(1);
    expect(del).toHaveBeenCalledTimes(1);
    expect(aiClient.completeAdminPlan).toHaveBeenCalledWith(
      expect.objectContaining({ planId: plan.id, outcome: "completed" }),
      ENV.workerUrl,
      ENV.internalApiToken,
    );
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });

  it("supports post-restart approvals by loading pending plans from D1 and owner cancel", async () => {
    const emptyRegistry = new AdminConfirmRegistry();
    const plan = makePlan("standard");
    vi.mocked(aiClient.getAdminPlan).mockResolvedValue({
      status: "ok",
      plan,
      planStatus: "pending",
    });
    vi.mocked(aiClient.cancelAdminPlan).mockResolvedValue({ status: "ok", cancelled: true });

    const { client, patch } = makeClient();
    const edit = vi.fn<AsyncVoid>(async () => undefined);
    const deferUpdate = vi.fn<AsyncVoid>(async () => undefined);

    await handleAdminConfirmInteraction(
      {
        customId: adminButtonCustomId("cancel", plan.id),
        guildId: GUILD_ID,
        user: { id: OWNER_ID },
        message: { id: "msg-restarted", edit },
        deferUpdate,
      } as unknown as MessageComponentInteraction,
      client,
      ENV,
      emptyRegistry,
    );

    expect(aiClient.getAdminPlan).toHaveBeenCalledTimes(1);
    expect(aiClient.cancelAdminPlan).toHaveBeenCalledTimes(1);
    expect(patch).not.toHaveBeenCalled();
    expect(edit).toHaveBeenCalledWith(expect.objectContaining({ components: [] }));
  });
});
