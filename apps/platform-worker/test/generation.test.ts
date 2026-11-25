import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { APICallError, generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type * as Ai from "ai";
import type * as AiPackage from "@xenoblade/ai";
import { createModel, GENERATION_LIMITS, type ModelConfig } from "@xenoblade/ai";
import type {
  GenerationRequest,
  GenerationResult,
  GuildMemoryProposal,
  HistoryMessage,
  SoulProposal,
} from "@xenoblade/contracts";
import type * as Tools from "../src/tools";

import { containsLeakedToolMarkup, generate } from "../src/generation";
import { setGuildMemory, setUserMemory } from "../src/db";
import { handleGuildMemoryApply } from "../src/memory";
import { DEFAULT_SOUL, formatSoulSegment, handleSoulApply, setBotSoul } from "../src/soul";
import { createTestD1 } from "./helpers/d1";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof Ai>();
  return { ...actual, generateText: vi.fn() };
});

// `createModel` is swapped for a scripted model where a test must run the real
// generateText loop; everything else stays real.
vi.mock("@xenoblade/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiPackage>();
  return { ...actual, createModel: vi.fn(actual.createModel) };
});

// MCP connections stay offline; the first-party tools stay real so the audit
// attributes the production tool names.
vi.mock("../src/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof Tools>();
  return {
    ...actual,
    connectMcpServers: async () => ({
      tools: {
        context7_resolve_library_id: {},
        github_search: {},
        "artificial-analysis_aa_language_models_free": {},
      },
      clients: [],
    }),
    closeMcpClients: async () => {},
  };
});

/** One call per first-party tool and per MCP server the chain exposes. */
const CALLED_TOOLS = [
  "web_search",
  "read_url",
  "vision_describe",
  "memory_list",
  "context7_resolve_library_id",
  "github_search",
  "artificial-analysis_aa_language_models_free",
];

/** Tool results of a run that called each audited tool once. */
const CALLED_TOOL_RESULTS = CALLED_TOOLS.map((toolName) => ({
  toolName,
  input: { query: "x" },
  output: { ok: true },
}));

/** Make `generateText` answer with a normal reply and `toolResults`. */
function stubModel(toolResults: readonly unknown[] = CALLED_TOOL_RESULTS): void {
  vi.mocked(generateText).mockResolvedValue({
    text: "Answer [来源](https://example.com/a).",
    usage: { inputTokens: 12, outputTokens: 34, inputTokenDetails: {} },
    toolResults,
    steps: [{}],
  } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);
}

/** The system prompt of the primary attempt. */
function systemPrompt(): string {
  return String(vi.mocked(generateText).mock.calls[0]?.[0]?.system);
}

/** Model messages the primary attempt was called with. */
function sentMessages(): Ai.ModelMessage[] {
  return vi.mocked(generateText).mock.calls[0]?.[0]?.messages ?? [];
}

function makeEnv(generation: ModelConfig[], db = createTestD1()): Env {
  return {
    DB: db,
    INTERNAL_API_TOKEN: "test-internal-token",
    OPENROUTER_API_KEY: "test-key",
    ARTIFICIAL_ANALYSIS_API_KEY: "test-key",
    MODEL_CONFIG: JSON.stringify({ generation }),
  } as Env;
}

/** A test D1 that also records the SQL text of every statement it prepares. */
function recordingDb(): { db: D1Database; queries: string[] } {
  const queries: string[] = [];
  const inner = createTestD1();
  const db = {
    prepare: (query: string) => {
      queries.push(query);
      return inner.prepare(query);
    },
    batch: (statements: D1PreparedStatement[]) => inner.batch(statements),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double wrapping the SQLite facade
  return { db: db as unknown as D1Database, queries };
}

async function allowChannels(db: D1Database, channels: string[]): Promise<void> {
  await db
    .prepare("INSERT INTO guild_config (guild_id, allow_channels_json) VALUES ('g1', ?1)")
    .bind(JSON.stringify(channels))
    .run();
}

function request(overrides: Partial<GenerationRequest> = {}): GenerationRequest {
  return {
    messageId: "m1",
    containerId: "discord:g1:c1",
    scopeId: "g1",
    channelId: "c1",
    parentChannelId: null,
    userId: "u1",
    userDisplayName: "User",
    summonKind: "user-mention",
    content: "hello",
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

describe("generate model options", () => {
  it("passes the model's own temperature and output cap to generateText", async () => {
    const env = makeEnv([{ id: "test/primary", temperature: 0.4, maxOutputTokens: 2048 }]);
    stubModel();

    expect((await generate(env, request())).status).toBe("completed");
    expect(generateText).toHaveBeenCalledWith(
      expect.objectContaining({ temperature: 0.4, maxOutputTokens: 2048 }),
    );
  });

  it("uses the shared output cap and sends no temperature when the model sets none", async () => {
    const env = makeEnv([{ id: "test/reasoning" }]);
    stubModel();
    await generate(env, request());

    const options = vi.mocked(generateText).mock.calls[0]?.[0];
    expect(options?.maxOutputTokens).toBe(GENERATION_LIMITS.maxOutputTokens);
    expect(GENERATION_LIMITS.maxOutputTokens).toBeGreaterThanOrEqual(4096);
    // Absent, not undefined: reasoning models reject an explicit temperature.
    expect(options).not.toHaveProperty("temperature");
  });
});

describe("generate tool audit", () => {
  it("records first-party tools as builtin and MCP tools under their server", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel();
    await generate(env, request());

    const { results } = await env.DB.prepare(
      "SELECT tool_name, server FROM tool_invocations ORDER BY rowid",
    ).all<{ tool_name: string; server: string }>();
    expect(results).toEqual([
      { tool_name: "web_search", server: "builtin" },
      { tool_name: "read_url", server: "builtin" },
      { tool_name: "vision_describe", server: "builtin" },
      { tool_name: "memory_list", server: "builtin" },
      { tool_name: "context7_resolve_library_id", server: "context7" },
      { tool_name: "github_search", server: "github" },
      {
        tool_name: "artificial-analysis_aa_language_models_free",
        server: "artificial-analysis",
      },
    ]);
  });
});

describe("generate channel allowlist", () => {
  it("answers a thread whose parent channel is allowlisted", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await allowChannels(env.DB, ["parent"]);
    stubModel();

    const result = await generate(env, request({ channelId: "thread", parentChannelId: "parent" }));

    expect(result.status).toBe("completed");
    expect(generateText).toHaveBeenCalledTimes(1);
  });

  it("rejects a thread whose parent channel is not allowlisted", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await allowChannels(env.DB, ["other"]);
    stubModel();

    const result = await generate(env, request({ channelId: "thread", parentChannelId: "parent" }));

    expect(result).toMatchObject({ status: "rejected", code: "disabled" });
    expect(generateText).not.toHaveBeenCalled();
  });
});

/** Number of rows a run left in `bot_soul`. */
async function storedSouls(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM bot_soul").first<{ n: number }>();
  return row?.n ?? 0;
}

/** Tool results of a run that called `soul_update` once per entry. */
function soulUpdates(...contents: string[]) {
  return contents.map((content, i) => ({
    toolName: "soul_update",
    input: { content, summary: "s" },
    output: {
      status: "proposed",
      proposal: { id: `p${i + 1}`, scopeId: "g1", content, summary: "s" } satisfies SoulProposal,
    },
  }));
}

describe("generate soul", () => {
  it("injects the guild's own soul into the system prompt, before the clock", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await setBotSoul(env.DB, { scopeId: "g1", content: "Speak like a pirate.", now: 1 });
    stubModel();

    expect((await generate(env, request())).status).toBe("completed");

    const soul = formatSoulSegment("Speak like a pirate.");
    expect(systemPrompt()).toContain(soul);
    expect(systemPrompt().indexOf(soul)).toBeLessThan(systemPrompt().indexOf("Current date:"));
  });

  it("falls back to the built-in soul for a guild without one", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel();

    await generate(env, request());

    expect(systemPrompt()).toContain(formatSoulSegment(DEFAULT_SOUL));
  });

  it("never gives a DM generation a guild's soul", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await setBotSoul(env.DB, { scopeId: "g1", content: "Speak like a pirate.", now: 1 });
    stubModel();

    await generate(env, request({ scopeId: "dm", containerId: "discord:@me:42", channelId: "42" }));

    expect(systemPrompt()).toContain(formatSoulSegment(DEFAULT_SOUL));
    expect(systemPrompt()).not.toContain("Speak like a pirate.");
  });

  it("returns the latest soul proposal of the run and stores nothing", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel(soulUpdates("First version.", "Second version."));

    const result = await generate(env, request());

    expect(result).toMatchObject({
      status: "completed",
      soulProposal: { id: "p2", scopeId: "g1", content: "Second version." },
    });
    expect(await storedSouls(env.DB)).toBe(0);
  });

  it("omits soulProposal when nothing was proposed, beside whatever memory was proposed", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel([
      {
        toolName: "soul_update",
        input: { content: "x", summary: "s" },
        output: { status: "rejected", reason: "dm_not_allowed" },
      },
      ...guildMemoryCalls(GUILD_SAVE),
    ]);

    const result = await generate(env, request());

    expect(result).not.toHaveProperty("soulProposal");
    expect(result).toMatchObject({ guildMemoryProposals: [{ id: "m1" }] });
  });

  it("records the soul tools as builtin, not as an MCP server named soul", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel([
      {
        toolName: "soul_read",
        input: {},
        output: { scopeId: "g1", content: "old", isDefault: false },
      },
      ...soulUpdates("new"),
    ]);

    await generate(env, request());

    const { results } = await env.DB.prepare(
      "SELECT tool_name, server FROM tool_invocations ORDER BY rowid",
    ).all<{ tool_name: string; server: string }>();
    expect(results).toEqual([
      { tool_name: "soul_read", server: "builtin" },
      { tool_name: "soul_update", server: "builtin" },
    ]);
  });
});

/** First line of the shared-memory block the system prompt carries in a guild. */
const GUILD_MEMORY_HEADER = "What this server asked you to remember";
/** Start of the personal-memory block the system prompt carries for User. */
const USER_MEMORY_HEADER = "What you already know about User (";

const GUILD_SAVE: GuildMemoryProposal = {
  id: "m1",
  scope: "guild",
  guildId: "g1",
  action: "save",
  category: "fact",
  key: "release day",
  value: "Fridays",
};

const GUILD_DELETE: GuildMemoryProposal = {
  id: "m2",
  scope: "guild",
  guildId: "g1",
  action: "delete",
  key: "tone",
};

/** Tool results of a run whose memory tools proposed each of these guild changes. */
function guildMemoryCalls(...proposals: GuildMemoryProposal[]) {
  return proposals.map((proposal) => ({
    toolName: proposal.action === "save" ? "memory_save" : "memory_delete",
    input: { scope: "guild", key: proposal.key },
    output: { status: "proposed", proposal },
  }));
}

/** Number of rows a run left in `guild_memory`. */
async function storedGuildMemory(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM guild_memory").first<{ n: number }>();
  return row?.n ?? 0;
}

describe("generate guild memory", () => {
  it("injects the guild's shared memory after the soul and ahead of the user's own memory", async () => {
    const { db, queries } = recordingDb();
    const env = makeEnv([{ id: "test/primary" }], db);
    await setBotSoul(env.DB, { scopeId: "g1", content: "Speak like a pirate.", now: 1 });
    await setGuildMemory(env.DB, {
      guildId: "g1",
      category: "fact",
      key: "release day",
      value: "Fridays",
      now: 1,
    });
    await setUserMemory(env.DB, { userId: "u1", category: "fact", key: "pet", value: "cat" });
    stubModel();
    queries.length = 0;

    expect((await generate(env, request())).status).toBe("completed");

    const prompt = systemPrompt();
    expect(prompt).toContain(GUILD_MEMORY_HEADER);
    expect(prompt).toContain("- release day: Fridays");
    const soul = prompt.indexOf(formatSoulSegment("Speak like a pirate."));
    const shared = prompt.indexOf(GUILD_MEMORY_HEADER);
    const personal = prompt.indexOf(USER_MEMORY_HEADER);
    expect(soul).toBeLessThan(shared);
    expect(shared).toBeLessThan(personal);
    expect(personal).toBeLessThan(prompt.indexOf("Current date:"));
    // A guild run reads the table once; the DM case below is measured against this.
    expect(queries.filter((query) => query.includes("guild_memory"))).toHaveLength(1);
  });

  it("gives every member of the guild the same prefix through the shared memory, then their own memory", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await setGuildMemory(env.DB, {
      guildId: "g1",
      category: "fact",
      key: "release day",
      value: "Fridays",
      now: 1,
    });
    await setUserMemory(env.DB, { userId: "u1", category: "fact", key: "pet", value: "cat" });
    await setUserMemory(env.DB, { userId: "u2", category: "fact", key: "tea", value: "oolong" });
    stubModel();

    await generate(env, request({ userDisplayName: "Alice" }));
    await generate(env, request({ messageId: "m2", userId: "u2", userDisplayName: "Bob" }));

    const prompts = vi.mocked(generateText).mock.calls.map((call) => String(call[0]?.system));
    expect(prompts).toHaveLength(2);
    // Everything up to the shared entry is byte-identical for both members.
    const [alice, bob] = prompts.map((prompt) =>
      prompt.slice(0, prompt.indexOf("- release day: Fridays")),
    );
    expect(alice).toContain(GUILD_MEMORY_HEADER);
    expect(alice).toBe(bob);
    // After it, each member gets their own memory and nobody else's.
    expect(prompts[0]).toContain("What you already know about Alice (");
    expect(prompts[0]).toContain("- pet: cat");
    expect(prompts[0]).not.toContain("- tea: oolong");
    expect(prompts[1]).toContain("What you already know about Bob (");
    expect(prompts[1]).toContain("- tea: oolong");
    expect(prompts[1]).not.toContain("- pet: cat");
  });

  it("never gives a DM generation the guild's shared memory, and never queries it", async () => {
    const { db, queries } = recordingDb();
    const env = makeEnv([{ id: "test/primary" }], db);
    await setGuildMemory(env.DB, {
      guildId: "g1",
      category: "fact",
      key: "release day",
      value: "Fridays",
      now: 1,
    });
    await setUserMemory(env.DB, { userId: "u1", category: "fact", key: "pet", value: "cat" });
    stubModel();
    queries.length = 0;

    await generate(env, request({ scopeId: "dm", containerId: "discord:@me:42", channelId: "42" }));

    // The user's own memory still arrives; the guild's never does.
    expect(systemPrompt()).toContain("- pet: cat");
    expect(systemPrompt()).not.toContain(GUILD_MEMORY_HEADER);
    expect(systemPrompt()).not.toContain("Fridays");
    expect(queries.some((query) => query.includes("guild_memory"))).toBe(false);
  });

  it("carries no shared-memory block for a guild that has none", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel();

    await generate(env, request());

    expect(systemPrompt()).not.toContain(GUILD_MEMORY_HEADER);
  });

  it("completes without shared memory when the table cannot be read", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await env.DB.prepare("DROP TABLE guild_memory").run();
    stubModel();

    expect((await generate(env, request())).status).toBe("completed");
    expect(systemPrompt()).not.toContain(GUILD_MEMORY_HEADER);
  });

  it("returns the guild memory proposals of the run in order and stores nothing", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel([
      ...guildMemoryCalls(GUILD_SAVE),
      { toolName: "web_search", output: { results: [] } },
      ...guildMemoryCalls(GUILD_DELETE),
    ]);

    const result = await generate(env, request());

    expect(result).toMatchObject({
      status: "completed",
      guildMemoryProposals: [GUILD_SAVE, GUILD_DELETE],
    });
    expect(await storedGuildMemory(env.DB)).toBe(0);
  });

  it("omits guildMemoryProposals when nothing was proposed, beside whatever soul was proposed", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel([
      {
        toolName: "memory_save",
        input: { scope: "guild", key: "release day", value: "Fridays" },
        output: { status: "rejected", reason: "dm_not_allowed" },
      },
      {
        toolName: "memory_save",
        input: { scope: "user", key: "pet", value: "cat" },
        output: { status: "saved", scope: "user", category: "fact", key: "pet", value: "cat" },
      },
      ...soulUpdates("Calm down."),
    ]);

    const result = await generate(env, request());

    expect(result).not.toHaveProperty("guildMemoryProposals");
    expect(result).toMatchObject({ soulProposal: { content: "Calm down." } });
  });
});

describe("generate history", () => {
  const history: HistoryMessage[] = [
    {
      id: "h1",
      text: "Anyone tried the new API?",
      authorId: "u2",
      authorName: "Bob",
      isBot: false,
      createdAt: 1_000,
    },
    {
      id: "h2",
      text: "Yes, it works.",
      authorId: "bot",
      authorName: "Xenoblade",
      isBot: true,
      createdAt: 1_100,
    },
    {
      id: "h3",
      text: "It broke for me.",
      authorId: "u3",
      authorName: "Cara",
      isBot: false,
      createdAt: 1_200,
    },
  ];

  it("sends each history message once as a speaker-labeled turn, then the labeled request", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel();

    await generate(env, request({ history, content: "  what did everyone say?  " }));

    expect(sentMessages()).toEqual([
      { role: "user", content: "[Bob]: Anyone tried the new API?" },
      { role: "assistant", content: "Yes, it works." },
      { role: "user", content: "[Cara]: It broke for me." },
      { role: "user", content: "[User (triggering user)]: what did everyone say?" },
    ]);
  });

  it("leaves the request unlabeled in a DM, its only speaker", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    stubModel();
    const earlier = { ...history[0]!, id: "h0", authorId: "u1", authorName: "Alice" };

    await generate(
      env,
      request({
        scopeId: "dm",
        containerId: "discord:@me:42",
        channelId: "42",
        history: [earlier],
      }),
    );

    expect(sentMessages()).toEqual([
      { role: "user", content: "[Alice (triggering user)]: Anyone tried the new API?" },
      { role: "user", content: "hello" },
    ]);
  });

  it("appends the cited-sources reference after the request instead of a second copy of the history", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    await env.DB.prepare(
      `INSERT INTO interaction_sources (interaction_id, container_id, idx, title, url, created_at)
       VALUES ('i0', 'discord:g1:c1', 1, 'Docs', 'https://example.com/docs', ?1)`,
    )
      .bind(Date.now())
      .run();
    stubModel();

    await generate(env, request({ history }));

    const messages = sentMessages();
    const requestMessage = messages.at(-1);
    expect(requestMessage?.role).toBe("user");
    expect(requestMessage?.content).toContain(
      "[User (triggering user)]: hello\n\n[Recently cited sources",
    );
    expect(requestMessage?.content).toContain("[1] Docs — https://example.com/docs");
    const wholePrompt = JSON.stringify(messages);
    for (const text of ["Anyone tried the new API?", "Yes, it works.", "It broke for me."]) {
      expect(wholePrompt.split(text)).toHaveLength(2);
    }
  });
});

/** Run the real generateText loop against `model` for one test. */
async function useRealLoop(model: MockLanguageModelV3): Promise<void> {
  const { generateText: realGenerateText } = await vi.importActual<typeof Ai>("ai");
  vi.mocked(generateText).mockImplementation(realGenerateText);
  vi.mocked(createModel).mockReturnValue(model);
}

/**
 * A model scripted to call `toolCalls[i]` on its i-th step while tools are on
 * offer and allowed (`toolChoice !== "none"`), and to answer with text
 * otherwise or once the script runs out. `offered` and `toolChoices` record
 * what each step saw.
 */
function scriptedModel(toolCalls: ReadonlyArray<{ toolName: string; input: object }>): {
  model: MockLanguageModelV3;
  offered: number[];
  toolChoices: Array<string | undefined>;
} {
  const offered: number[] = [];
  const toolChoices: Array<string | undefined> = [];
  const model = new MockLanguageModelV3({
    doGenerate: async ({ tools, toolChoice }) => {
      offered.push(tools?.length ?? 0);
      toolChoices.push(toolChoice?.type);
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      };
      const call = toolCalls[offered.length - 1];
      if (call !== undefined && (tools?.length ?? 0) > 0 && toolChoice?.type !== "none") {
        return {
          content: [
            {
              type: "tool-call",
              toolCallId: `call-${offered.length}`,
              toolName: call.toolName,
              input: JSON.stringify(call.input),
            },
          ],
          finishReason: { unified: "tool-calls", raw: "tool-calls" },
          usage,
          warnings: [],
        };
      }
      return {
        content: [{ type: "text", text: "Final answer." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
  return { model, offered, toolChoices };
}

const MEMORY_LIST = { toolName: "memory_list", input: {} };
const SOUL_UPDATE = {
  toolName: "soul_update",
  input: { content: "Be calm and precise.", summary: "Calm down the tone." },
};
const GUILD_MEMORY_SAVE = {
  toolName: "memory_save",
  input: { scope: "guild", key: "release day", value: "Fridays" },
};
const USER_MEMORY_SAVE = {
  toolName: "memory_save",
  input: { scope: "user", key: "pet", value: "cat" },
};

const LEAKED_DSML_REPLY = [
  "<｜｜DSML｜｜ calls>",
  '<｜｜DSML｜｜ invoke name="web_search">',
  '<｜｜DSML｜｜ parameter name="query" string="true">test</｜｜DSML｜｜ parameter>',
  "</｜｜DSML｜｜ invoke>",
  "</｜｜DSML｜｜ calls>",
].join("\n");

describe("containsLeakedToolMarkup", () => {
  it("matches canonical fullwidth, doubled fullwidth, and ASCII DSML tool-call tags", () => {
    expect(containsLeakedToolMarkup(LEAKED_DSML_REPLY)).toBe(true);
    expect(containsLeakedToolMarkup('<｜DSML｜function_calls><｜DSML｜invoke name="x">')).toBe(
      true,
    );
    expect(containsLeakedToolMarkup('<||DSML||invoke name="web_search">')).toBe(true);
  });

  it("ignores normal prose and ordinary angle-bracket markup", () => {
    expect(containsLeakedToolMarkup("Here is your answer [来源](<https://example.com>).")).toBe(
      false,
    );
    expect(containsLeakedToolMarkup("DeepSeek uses DSML internally for tool calls.")).toBe(false);
  });
});

describe("generate tool loop", () => {
  it("ends a tool-only run with toolChoice none on the last step while keeping tools defined", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    // The model would keep calling tools forever, given the chance.
    const { model, offered, toolChoices } = scriptedModel(
      Array.from({ length: 16 }, () => MEMORY_LIST),
    );
    await useRealLoop(model);

    const result = await generate(env, request());

    // Eleven steps that may call tools, then a twelfth with `toolChoice: "none"`
    // and `tools` still defined (so OpenRouter serializes `tool_choice: "none"`
    // and keeps the prompt cache warm).
    expect(offered).toHaveLength(12);
    expect(offered.every((count) => count > 0)).toBe(true);
    expect(toolChoices.slice(0, 11).every((choice) => choice !== "none")).toBe(true);
    expect(toolChoices[11]).toBe("none");
    expect(result).toMatchObject({ status: "completed", reply: "Final answer." });
  });

  it("rescues a multi-step run that leaks raw DSML markup without discarding prior tool results", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    let calls = 0;
    const seenToolChoices: Array<string | undefined> = [];
    const model = new MockLanguageModelV3({
      doGenerate: async ({ toolChoice }) => {
        calls += 1;
        seenToolChoices.push(toolChoice?.type);
        const usage = {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        };
        if (calls === 1) {
          return {
            content: [
              {
                type: "tool-call",
                toolCallId: "call-1",
                toolName: "memory_list",
                input: "{}",
              },
            ],
            finishReason: { unified: "tool-calls", raw: "tool-calls" },
            usage,
            warnings: [],
          };
        }
        if (calls === 2) {
          return {
            content: [{ type: "text", text: LEAKED_DSML_REPLY }],
            finishReason: { unified: "stop", raw: "stop" },
            usage,
            warnings: [],
          };
        }
        return {
          content: [{ type: "text", text: "Rescued answer from gathered tools." }],
          finishReason: { unified: "stop", raw: "stop" },
          usage,
          warnings: [],
        };
      },
    });
    await useRealLoop(model);

    const result = await generate(env, request());

    expect(calls).toBe(3);
    expect(seenToolChoices[2]).toBe("none");
    expect(result).toMatchObject({
      status: "completed",
      reply: "Rescued answer from gathered tools.",
      usage: { inputTokens: 30, outputTokens: 15 },
    });
    const { results } = await env.DB.prepare("SELECT tool_name FROM tool_invocations").all<{
      tool_name: string;
    }>();
    expect(results).toEqual([{ tool_name: "memory_list" }]);
  });

  it("falls through to the next model when step 1 leaks raw DSML markup", async () => {
    const env = makeEnv([{ id: "test/primary" }, { id: "test/fallback" }]);
    const usage = {
      inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 5, text: 5, reasoning: 0 },
    };
    const primary = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: LEAKED_DSML_REPLY }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    });
    const fallback = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: "Clean fallback answer." }],
        finishReason: { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      }),
    });
    const { generateText: realGenerateText } = await vi.importActual<typeof Ai>("ai");
    vi.mocked(generateText).mockImplementation(realGenerateText);
    vi.mocked(createModel).mockReturnValueOnce(primary).mockReturnValueOnce(fallback);

    const result = await generate(env, request());

    expect(result).toMatchObject({
      status: "completed",
      reply: "Clean fallback answer.",
      usage: { model: "test/fallback" },
    });
  });

  it("errors instead of posting raw DSML markup when every model leaks it", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    const model = new MockLanguageModelV3({
      doGenerate: async () => ({
        content: [{ type: "text", text: LEAKED_DSML_REPLY }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
          outputTokens: { total: 5, text: 5, reasoning: 0 },
        },
        warnings: [],
      }),
    });
    await useRealLoop(model);

    const result = await generate(env, request());

    expect(result).toMatchObject({ status: "error" });
  });

  it("stops with OutputTruncatedError instead of blindly retrying fallback when output hits token length limit", async () => {
    const env = makeEnv([{ id: "test/primary" }, { id: "test/fallback" }]);
    vi.mocked(generateText).mockResolvedValueOnce({
      text: "",
      finishReason: "length",
      usage: { inputTokens: 100, outputTokens: 4096, inputTokenDetails: {} },
      toolResults: [],
      steps: [{}],
    } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);

    const result = await generate(env, request());

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "error",
      code: "OutputTruncatedError",
      retryable: false,
    });
    const events = loggedEvents();
    expect(events.filter((e) => e.event === "empty_generation")).toEqual([
      expect.objectContaining({
        model: "test/primary",
        finishReason: "length",
        outputTokens: 4096,
        steps: 1,
      }),
    ]);
    expect(events.filter((e) => e.event === "attempt_failed")).toEqual([
      expect.objectContaining({
        model: "test/primary",
        error: "OutputTruncatedError",
        finishReason: "length",
        outputTokens: 4096,
        steps: 1,
      }),
    ]);
  });

  it("carries a soul_update call back as a proposal and stores nothing", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    const { model } = scriptedModel([SOUL_UPDATE]);
    await useRealLoop(model);

    const result = await generate(env, request());

    expect(result).toMatchObject({
      status: "completed",
      reply: "Final answer.",
      soulProposal: {
        scopeId: "g1",
        content: "Be calm and precise.",
        summary: "Calm down the tone.",
      },
    });
    expect(await storedSouls(env.DB)).toBe(0);

    // What the card shows is what gets stored: the proposal, forwarded as-is.
    if (result.status !== "completed" || result.soulProposal === undefined) {
      throw new Error("expected a completed result with a soul proposal");
    }
    expect(
      await handleSoulApply(env.DB, { proposal: result.soulProposal, updatedBy: "u1" }),
    ).toEqual({ status: "ok", scopeId: "g1" });
    const row = await env.DB.prepare("SELECT content FROM bot_soul").first<{ content: string }>();
    expect(row?.content).toBe(result.soulProposal.content);
  });

  it("brings back no soul proposal from a DM, where the tool refuses", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    const { model } = scriptedModel([SOUL_UPDATE]);
    await useRealLoop(model);

    const result = await generate(
      env,
      request({ scopeId: "dm", containerId: "discord:@me:42", channelId: "42" }),
    );

    expect(result).toMatchObject({ status: "completed", reply: "Final answer." });
    expect(result).not.toHaveProperty("soulProposal");
    expect(await storedSouls(env.DB)).toBe(0);
  });

  it("carries a guild memory_save call back as a proposal for this guild, and stores nothing", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    const { model } = scriptedModel([GUILD_MEMORY_SAVE]);
    await useRealLoop(model);

    const result = await generate(env, request());

    expect(result).toMatchObject({
      status: "completed",
      reply: "Final answer.",
      guildMemoryProposals: [
        {
          scope: "guild",
          guildId: "g1",
          action: "save",
          category: "fact",
          key: "release day",
          value: "Fridays",
        },
      ],
    });
    expect(await storedGuildMemory(env.DB)).toBe(0);

    // What the card shows is what gets stored: the proposal, forwarded as-is.
    if (result.status !== "completed" || result.guildMemoryProposals === undefined) {
      throw new Error("expected a completed result with guild memory proposals");
    }
    const [proposal] = result.guildMemoryProposals;
    if (proposal?.action !== "save") throw new Error("expected one guild memory save proposal");
    expect(
      await handleGuildMemoryApply(env.DB, { proposals: [proposal], updatedBy: "u1" }),
    ).toEqual({ status: "ok", results: [{ id: proposal.id, ok: true }] });
    const row = await env.DB.prepare(
      "SELECT guild_id, key, value, updated_by FROM guild_memory",
    ).first();
    expect(row).toEqual({
      guild_id: "g1",
      key: proposal.key,
      value: proposal.value,
      updated_by: "u1",
    });
  });

  it("brings back no guild memory proposal from a DM, where the tool refuses", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    const { model } = scriptedModel([GUILD_MEMORY_SAVE]);
    await useRealLoop(model);

    const result = await generate(
      env,
      request({ scopeId: "dm", containerId: "discord:@me:42", channelId: "42" }),
    );

    expect(result).toMatchObject({ status: "completed", reply: "Final answer." });
    expect(result).not.toHaveProperty("guildMemoryProposals");
    expect(await storedGuildMemory(env.DB)).toBe(0);
  });

  it("saves the triggering user's own memory at once, with no proposal", async () => {
    const env = makeEnv([{ id: "test/primary" }]);
    const { model } = scriptedModel([USER_MEMORY_SAVE]);
    await useRealLoop(model);

    const result = await generate(env, request());

    expect(result).toMatchObject({ status: "completed", reply: "Final answer." });
    expect(result).not.toHaveProperty("guildMemoryProposals");
    const row = await env.DB.prepare("SELECT user_id, key, value FROM user_memory").first();
    expect(row).toEqual({ user_id: "u1", key: "pet", value: "cat" });
  });
});

/** Drive the pipeline through every hang and pause it waits on (fake timers), then read its answer. */
async function settleRun(run: Promise<GenerationResult>): Promise<GenerationResult> {
  await vi.advanceTimersByTimeAsync(200_000);
  return run;
}

/** Wait `ms` of faked time, as an attempt stuck until its timeout does. */
function hang(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/** The interaction row a single-run test leaves behind. */
async function recordedRun(db: D1Database): Promise<{ status: string; total_duration_ms: number }> {
  const { results } = await db
    .prepare("SELECT status, total_duration_ms FROM interactions")
    .all<{ status: string; total_duration_ms: number }>();
  return results[0] ?? { status: "missing", total_duration_ms: -1 };
}

/** Every structured event a run logged since the console spy was armed. */
function loggedEvents(): Array<Record<string, unknown>> {
  return vi
    .mocked(console.log)
    .mock.calls.map((line) => JSON.parse(String(line[0])) as Record<string, unknown>);
}

describe("generate log hygiene", () => {
  /** Something only the request, the reply, or the provider's error text could put into a log line. */
  const PRIVATE = "pet-name-Mr-Whiskers-7f3a";

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    ["a guild", {}],
    ["a DM", { scopeId: "dm", containerId: "discord:@me:42", channelId: "42" }],
  ])(
    "logs no reply text, memory content, or provider error text from %s generation",
    async (_case, scope) => {
      const env = makeEnv([{ id: "test/failing" }, { id: "test/primary" }]);
      await setUserMemory(env.DB, { userId: "u1", category: "fact", key: "pet", value: PRIVATE });
      const failure = new APICallError({
        message: `provider rejected the prompt about ${PRIVATE}`,
        url: "https://provider.invalid/v1/chat",
        requestBodyValues: {},
        statusCode: 502,
      });
      vi.mocked(generateText)
        .mockRejectedValueOnce(failure)
        .mockResolvedValueOnce({
          text: `Your pet is ${PRIVATE}.`,
          usage: { inputTokens: 12, outputTokens: 34, inputTokenDetails: {} },
          toolResults: [],
          steps: [{}],
        } as unknown as Ai.GenerateTextResult<Ai.ToolSet, never, never>);

      const result = await settleRun(generate(env, request(scope)));

      expect(result.status).toBe("completed");
      const events = loggedEvents();
      // The failed attempt stays identifiable by name and status, not by its message.
      expect(events.filter((event) => event.event === "attempt_failed")).toEqual([
        {
          event: "attempt_failed",
          messageId: "m1",
          model: "test/failing",
          retryable: false,
          error: failure.name,
          statusCode: 502,
        },
      ]);
      // The completion is a length and counts, never a preview.
      expect(events.filter((event) => event.event === "generation_completed")).toEqual([
        expect.objectContaining({ replyLength: `Your pet is ${PRIVATE}.`.length }),
      ]);
      expect(JSON.stringify(events)).not.toContain(PRIVATE);
    },
  );

  it("names the error of a run that failed on every model, and logs nothing else about it", async () => {
    const env = makeEnv([{ id: "test/only" }]);
    vi.mocked(generateText).mockRejectedValueOnce(new Error(`tool read the page about ${PRIVATE}`));

    const result = await settleRun(generate(env, request()));

    expect(result).toMatchObject({ status: "error", code: "Error" });
    const failures = loggedEvents().filter((event) => event.event === "attempt_failed");
    expect(failures).toEqual([
      {
        event: "attempt_failed",
        messageId: "m1",
        model: "test/only",
        retryable: false,
        error: "Error",
      },
    ]);
    expect(JSON.stringify(loggedEvents())).not.toContain(PRIVATE);
  });
});

describe("generate chain deadline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives every attempt only the time the chain has left, and still answers in time", async () => {
    const env = makeEnv([{ id: "test/a" }, { id: "test/b" }, { id: "test/c" }]);
    const timeouts: number[] = [];
    // Each attempt hangs for its whole timeout and then times out, as the SDK does.
    vi.mocked(generateText).mockImplementation(async ({ timeout }) => {
      const ms = typeof timeout === "number" ? timeout : 0;
      timeouts.push(ms);
      await hang(ms);
      throw new DOMException(`timeout of ${ms}ms exceeded`, "TimeoutError");
    });

    const result = await settleRun(generate(env, request()));

    // 135s budget: 60s + 3s pause + 60s + 3s pause leaves 9s for the last model.
    expect(timeouts).toEqual([60_000, 60_000, 9_000]);
    expect(result).toMatchObject({ status: "error", code: "TimeoutError", retryable: true });
    // The Worker answers at its deadline, 15s before the Runtime would give up.
    expect(await recordedRun(env.DB)).toEqual({ status: "timeout", total_duration_ms: 135_000 });
    // Model attribution must reflect the fallback model that actually timed out, not the primary.
    const row = await env.DB.prepare("SELECT model FROM interactions").first<{ model: string }>();
    expect(row?.model).toBe("test/c");
  });

  it("cuts off an attempt that outlives the chain's deadline", async () => {
    const env = makeEnv([{ id: "test/a" }, { id: "test/b" }]);
    // A tool that ignores its abort signal keeps the first attempt hanging
    // far beyond both its own timeout and the chain's deadline.
    vi.mocked(generateText).mockImplementationOnce(async () => {
      await hang(300_000);
      throw new Error("never reached");
    });

    const result = await settleRun(generate(env, request()));

    // Cut at the deadline with no pause or second attempt, and still a structured answer.
    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "error",
      code: "GenerationDeadlineError",
      retryable: true,
    });
    expect(await recordedRun(env.DB)).toEqual({ status: "timeout", total_duration_ms: 135_000 });
  });

  it("gives up instead of starting an attempt the chain has no time for", async () => {
    const env = makeEnv([{ id: "test/a" }, { id: "test/b" }]);
    // The first attempt outlives its own timeout.
    vi.mocked(generateText).mockImplementationOnce(async () => {
      await hang(131_000);
      throw new Error("hung");
    });

    const result = await settleRun(generate(env, request()));

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      status: "error",
      code: "GenerationDeadlineError",
      retryable: true,
    });
    expect(await recordedRun(env.DB)).toEqual({ status: "timeout", total_duration_ms: 134_000 });
  });

  it("classifies SDK step vs total TimeoutErrors distinctly and logs attemptDurationMs", async () => {
    const env = makeEnv([{ id: "test/a" }]);
    vi.mocked(generateText).mockImplementationOnce(async () => {
      await hang(12_000);
      throw new DOMException("Step timeout of 45000ms exceeded", "TimeoutError");
    });

    const result = await settleRun(generate(env, request()));

    expect(result).toMatchObject({
      status: "error",
      code: "StepTimeoutError",
      retryable: true,
    });
    expect(loggedEvents().filter((e) => e.event === "attempt_failed")).toEqual([
      expect.objectContaining({
        model: "test/a",
        error: "StepTimeoutError",
        attemptDurationMs: 12_000,
      }),
    ]);
  });
});
