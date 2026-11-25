import { afterEach, describe, expect, it, vi } from "vitest";
import type { AttachmentBuilder, ChatInputCommandInteraction } from "discord.js";
import type { UserSettings } from "@xenoblade/contracts";

import { handleControlCommand, MEMORIES_ATTACHMENT_NAME } from "../src/control-commands";
import type { EnvConfig } from "../src/env";
import { resetLanguageCache } from "../src/language";
import { messages } from "../src/i18n";
import { MAX_MESSAGE_LENGTH } from "../src/output";

const env: EnvConfig = {
  discordBotToken: "test-token",
  discordApplicationId: "app-id",
  workerUrl: "https://worker",
  internalApiToken: "token",
  mentionRoleIds: [],
  healthPort: 8397,
};

const ZH = messages("zh").dm;

function settingsFor(): UserSettings {
  return {
    chatOptin: false,
    learnOptin: false,
    chatOptinAt: null,
    learnOptinAt: null,
    language: "zh",
  };
}

interface InteractionOptions {
  command?: string;
  subcommand?: string;
  strings?: Record<string, string | undefined>;
  inGuild?: boolean;
  channelId?: string;
}

function makeInteraction(options: InteractionOptions = {}) {
  const {
    command = "persona",
    subcommand = "show",
    strings = {},
    inGuild = false,
    channelId = "dm-1",
  } = options;
  const calls: string[] = [];
  const editContents: string[] = [];
  const editFiles: Array<AttachmentBuilder[] | undefined> = [];
  const bodies: unknown[] = [];
  const interaction = {
    commandName: command,
    guildId: inGuild ? "guild-1" : null,
    channelId,
    user: { id: "user-1" },
    inGuild: () => inGuild,
    options: {
      getSubcommand: () => subcommand,
      getString: (name: string, required = false) => {
        const value = strings[name];
        if (required && value === undefined) throw new Error(`missing option ${name}`);
        return value ?? null;
      },
    },
    deferReply: async () => {
      calls.push("defer");
    },
    editReply: async (editOptions: string | { content?: string; files?: AttachmentBuilder[] }) => {
      calls.push("edit");
      editContents.push(
        typeof editOptions === "string" ? editOptions : (editOptions.content ?? ""),
      );
      editFiles.push(typeof editOptions === "string" ? undefined : editOptions.files);
    },
  };
  return {
    interaction: interaction as unknown as ChatInputCommandInteraction,
    calls,
    editContents,
    editFiles,
    bodies,
  };
}

type RouteHandler = (body: unknown) => unknown;

/** Fetch stub routing settings / memory / context-clear control calls. */
function stubFetch(calls: string[], bodies: unknown[], routes: Record<string, RouteHandler>) {
  return vi.fn<(_input: unknown, init?: RequestInit) => Promise<Response>>(
    async (_input: unknown, init?: RequestInit) => {
      const url = String(_input);
      const handler = Object.entries(routes).find(([route]) => url.includes(route))?.[1];
      if (handler === undefined) {
        throw new Error(`unexpected fetch: ${url}`);
      }
      calls.push(url.replace("https://worker/internal/v1", ""));
      const requestBody = init?.body;
      if (requestBody !== undefined) {
        bodies.push(JSON.parse(String(requestBody)));
      }
      return new Response(JSON.stringify(handler(JSON.parse(String(requestBody ?? "{}")))), {
        status: 200,
      });
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  resetLanguageCache();
});

describe("handleControlCommand persona", () => {
  it("defers, sets the memory over the Worker, and edits the zh notice", async () => {
    const { interaction, calls, editContents, bodies } = makeInteraction({
      command: "persona",
      subcommand: "set",
      strings: { key: "name", value: "小明" },
    });
    const routes: Record<string, RouteHandler> = {
      "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
      "/internal/v1/memory": () => ({ status: "ok", memories: [] }),
    };
    vi.stubGlobal("fetch", stubFetch(calls, bodies, routes));

    await handleControlCommand(interaction, env);

    expect(calls[0]).toBe("defer");
    expect(bodies).toContainEqual({
      op: "set",
      userId: "user-1",
      category: "persona",
      key: "name",
      value: "小明",
    });
    expect(editContents[0]).toBe(ZH.memorySet("人设", "name"));
  });

  it("lists persona memories on show", async () => {
    const { interaction, editContents } = makeInteraction({
      command: "persona",
      subcommand: "show",
    });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
        "/internal/v1/memory": () => ({
          status: "ok",
          memories: [
            { category: "persona", key: "name", value: "小明", updatedAt: 1 },
            { category: "fact", key: "lang", value: "Rust", updatedAt: 2 },
          ],
        }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(editContents[0]).toBe(`人设记忆：\n- name: 小明`);
  });
});

describe("handleControlCommand preference", () => {
  it("tells the user when their personal memory is full, instead of a generic failure", async () => {
    const { interaction, editContents, bodies } = makeInteraction({
      command: "preference",
      subcommand: "set",
      strings: { key: "reply style", value: "简短" },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
        "/internal/v1/memory": () => ({ status: "error", code: "memory_full" }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(bodies).toContainEqual({
      op: "set",
      userId: "user-1",
      category: "preference",
      key: "reply style",
      value: "简短",
    });
    expect(editContents[0]).toBe(ZH.memoryFull);
  });

  it("still shows the generic notice for any other failure", async () => {
    const { interaction, editContents } = makeInteraction({
      command: "preference",
      subcommand: "set",
      strings: { key: "reply style", value: "简短" },
    });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
        "/internal/v1/memory": () => ({ status: "error", code: "memory_op_failed" }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(editContents[0]).toBe(ZH.memoryError);
  });
});

describe("handleControlCommand memory", () => {
  it("attaches memories.txt when /memory show exceeds Discord's 2,000-character limit", async () => {
    const { interaction, editContents, editFiles } = makeInteraction({
      command: "memory",
      subcommand: "show",
    });
    const memories = Array.from({ length: 12 }, (_, i) => ({
      category: "fact" as const,
      key: `key_${i}`,
      value: "v".repeat(250),
      updatedAt: i + 1,
    }));
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
        "/internal/v1/memory": () => ({ status: "ok", memories }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(editContents[0]!.length).toBeLessThanOrEqual(MAX_MESSAGE_LENGTH);
    expect(editContents[0]).toContain(ZH.memoriesAttachmentNote);
    expect(editFiles[0]).toHaveLength(1);
    expect(editFiles[0]?.[0]?.name).toBe(MEMORIES_ATTACHMENT_NAME);
    const attached = Buffer.from(editFiles[0]?.[0]?.attachment as Buffer).toString("utf8");
    expect(attached).toContain("- [fact] key_0:");
    expect(attached).toContain("- [fact] key_11:");
  });

  it("clears all memories", async () => {
    const { interaction, editContents, bodies } = makeInteraction({
      command: "memory",
      subcommand: "clear",
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
        "/internal/v1/memory": () => ({ status: "ok", memories: [] }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(bodies).toContainEqual({ op: "clear", userId: "user-1" });
    expect(editContents[0]).toBe(ZH.allMemoriesCleared);
  });
});

describe("handleControlCommand chat", () => {
  it("enables DM chat from a DM interaction", async () => {
    const { interaction, editContents, bodies } = makeInteraction({
      command: "chat",
      strings: { value: "on" },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(bodies).toContainEqual({ op: "set", userId: "user-1", chatOptin: true });
    expect(editContents[0]).toBe(ZH.chatOn);
  });

  it("disabling also clears the DM context with the dm container key", async () => {
    const { interaction, editContents, bodies } = makeInteraction({
      command: "chat",
      strings: { value: "off" },
      channelId: "dm-42",
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
        "/internal/v1/context/clear": () => ({ status: "ok", cleared: 1 }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(bodies).toContainEqual({
      userId: "user-1",
      scopeId: "dm",
      containerId: "discord:@me:dm-42",
      scope: "user",
    });
    expect(editContents[0]).toBe(`${ZH.chatOffPrefix}${ZH.chatOffClearOk}`);
  });

  it("refuses guild invocations before any Worker call", async () => {
    const { interaction, editContents } = makeInteraction({
      command: "chat",
      strings: { value: "on" },
      inGuild: true,
    });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal("fetch", stubFetch(calls, bodies, {}));

    await handleControlCommand(interaction, env);

    expect(editContents[0]).toBe(ZH.chatDmOnly);
    expect(calls.filter((call) => call !== "defer")).toEqual([]);
  });

  it("shows the current state when no value is given", async () => {
    const { interaction, editContents } = makeInteraction({ command: "chat" });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(editContents[0]).toBe(ZH.chatState("未开启"));
  });
});

describe("handleControlCommand learn and help", () => {
  it("toggles learning off", async () => {
    const { interaction, editContents, bodies } = makeInteraction({
      command: "learn",
      strings: { value: "off" },
    });
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(bodies).toContainEqual({ op: "set", userId: "user-1", learnOptin: false });
    expect(editContents[0]).toBe(ZH.learnOff);
  });

  it("help renders the slash-command overview", async () => {
    const { interaction, editContents } = makeInteraction({ command: "help" });
    const calls: string[] = [];
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      stubFetch(calls, bodies, {
        "/internal/v1/settings": () => ({ status: "ok", settings: settingsFor() }),
      }),
    );

    await handleControlCommand(interaction, env);

    expect(editContents[0]).toContain("/persona show · set · clear");
    expect(editContents[0]).toContain("/chat on|off");
  });
});
