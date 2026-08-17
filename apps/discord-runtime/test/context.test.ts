import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatInputCommandInteraction } from "discord.js";
import type { UserSettings } from "@xenoblade/contracts";

import { handleContextCommand } from "../src/context";
import type { EnvConfig } from "../src/env";
import { resetLanguageCache } from "../src/language";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

const TRUNCATE_SUCCESS_ZH = "已截断：此时间点之前的消息不再纳入参考。可用 /context restore 撤销。";
const TRUNCATE_FAILURE_ZH = "截断失败，请稍后重试。";
const RESTORE_SUCCESS_ZH = "已撤销最近一次截断，更早的消息重新纳入参考。";
const RESTORE_WITH_REMAINING_ZH = (n: number) =>
  `已撤销最近一次截断，更早的消息重新纳入参考。还可撤销 ${n} 次。`;
const RESTORE_NONE_ZH = "当前没有可撤销的截断。";
const RESTORE_FAILURE_ZH = "撤销截断失败，请稍后重试。";

function settingsFor(language: UserSettings["language"]): UserSettings {
  return {
    chatOptin: false,
    learnOptin: false,
    chatOptinAt: null,
    learnOptinAt: null,
    language,
  };
}

function makeInteraction(options: { subcommand?: string; isThread?: boolean } = {}) {
  const { subcommand = "truncate", isThread = false } = options;
  const calls: string[] = [];
  const editContents: string[] = [];
  const bodies: unknown[] = [];
  const interaction = {
    commandName: "context",
    guildId: "guild-1",
    channelId: "channel-1",
    user: { id: "user-1" },
    channel: {
      id: "channel-1",
      parentId: "parent-9",
      isThread: () => isThread,
    },
    options: {
      getSubcommand: () => subcommand,
    },
    deferReply: async () => {
      calls.push("defer");
    },
    editReply: async (editOptions: string | { content?: string }) => {
      calls.push("edit");
      editContents.push(
        typeof editOptions === "string" ? editOptions : (editOptions.content ?? ""),
      );
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    calls,
    editContents,
    bodies,
  };
}

/** Narrow an unknown JSON body to a record for field assertions. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

/** Fetch stub routing the settings call vs the context endpoint call. */
function stubFetch(
  calls: string[],
  bodies: unknown[],
  contextBody: unknown,
  contextRoute = "truncate",
) {
  return vi.fn<(_input: unknown, init?: RequestInit) => Promise<Response>>(
    async (_input: unknown, init?: RequestInit) => {
      const url = String(_input);
      if (url.includes("/internal/v1/settings")) {
        calls.push("settings");
        return new Response(JSON.stringify({ status: "ok", settings: settingsFor("zh") }), {
          status: 200,
        });
      }
      calls.push(contextRoute);
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(contextBody), { status: 200 });
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("handleContextCommand truncate", () => {
  it("defers before the Worker call, then edits in the success notice", async () => {
    const { interaction, calls, editContents, bodies } = makeInteraction();
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, { status: "ok", truncatedAt: 1, remainingUndos: 1 }),
    );

    await handleContextCommand(interaction, env);

    expect(calls).toEqual(["defer", "settings", "truncate", "edit"]);
    expect(editContents[0]).toBe(TRUNCATE_SUCCESS_ZH);
    expect(asRecord(bodies[0])).toEqual({
      userId: "user-1",
      scopeId: "guild-1",
      containerId: "discord:guild-1:channel-1",
    });
  });

  it("scopes the container to the parent channel inside a thread", async () => {
    const { interaction, bodies } = makeInteraction({ isThread: true });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, { status: "ok", truncatedAt: 1, remainingUndos: 1 }),
    );

    await handleContextCommand(interaction, env);

    expect(asRecord(bodies[0])["containerId"]).toBe("discord:guild-1:parent-9:channel-1");
  });

  it("edits in the failure notice on a Worker error status", async () => {
    const { interaction, editContents } = makeInteraction();
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", stubFetch(calls, bodies, { status: "error", code: "db" }));

    await handleContextCommand(interaction, env);

    expect(editContents[0]).toBe(TRUNCATE_FAILURE_ZH);
  });
});

describe("handleContextCommand restore", () => {
  it("edits in the restore notice with remaining undo count", async () => {
    const { interaction, editContents, bodies } = makeInteraction({ subcommand: "restore" });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, { status: "ok", restored: true, remainingUndos: 2 }, "restore"),
    );

    await handleContextCommand(interaction, env);

    expect(editContents[0]).toBe(RESTORE_WITH_REMAINING_ZH(2));
    expect(String(asRecord(bodies[0])["userId"])).toBe("user-1");
  });

  it("omits the remaining hint at zero undos", async () => {
    const { interaction, editContents } = makeInteraction({ subcommand: "restore" });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, { status: "ok", restored: true, remainingUndos: 0 }, "restore"),
    );

    await handleContextCommand(interaction, env);

    expect(editContents[0]).toBe(RESTORE_SUCCESS_ZH);
  });

  it("reports nothing-to-undo when the Worker restored nothing", async () => {
    const { interaction, editContents } = makeInteraction({ subcommand: "restore" });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, { status: "ok", restored: false, remainingUndos: 0 }, "restore"),
    );

    await handleContextCommand(interaction, env);

    expect(editContents[0]).toBe(RESTORE_NONE_ZH);
  });

  it("edits in the failure notice on a Worker error status", async () => {
    const { interaction, editContents } = makeInteraction({ subcommand: "restore" });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", stubFetch(calls, bodies, { status: "error", code: "db" }, "restore"));

    await handleContextCommand(interaction, env);

    expect(editContents[0]).toBe(RESTORE_FAILURE_ZH);
  });

  it("falls back to the zh failure notice when the Worker call throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { interaction, editContents } = makeInteraction({ subcommand: "restore" });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn<() => Promise<Response>>(async () => {
        calls.push("fetch");
        throw new Error("timeout");
      }),
    );

    await handleContextCommand(interaction, env);

    expect(editContents[0]).toBe(RESTORE_FAILURE_ZH);
  });
});
