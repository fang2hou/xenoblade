import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateText } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import type { ModelMessage, ToolSet } from "ai";
import type * as Ai from "ai";
import { createModel } from "@xenoblade/ai";
import type { AskUserPrompt, GenerationRequest, HistoryMessage } from "@xenoblade/contracts";
import type * as AiPackage from "@xenoblade/ai";
import type * as Tools from "../src/tools";

import { generate } from "../src/generation";
import { getLastTurn, recordLastReply, recordLastTurn } from "../src/thread-sessions";
import {
  createInteractionTools,
  extractAskPrompt,
  hasRetry,
  hasThreadPause,
} from "../src/tools/interaction-tools";
import { createTestD1 } from "./helpers/d1";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof Ai>();
  return { ...actual, generateText: vi.fn() };
});

// `createModel` is swapped for a scripted model: every test runs the real
// generateText loop, so the stop condition and the tool execution are the
// production ones.
vi.mock("@xenoblade/ai", async (importOriginal) => {
  const actual = await importOriginal<typeof AiPackage>();
  return { ...actual, createModel: vi.fn(actual.createModel) };
});

// MCP connections stay offline; the first-party tools stay real.
vi.mock("../src/tools", async (importOriginal) => {
  const actual = await importOriginal<typeof Tools>();
  return {
    ...actual,
    connectMcpServers: async () => ({ tools: {}, clients: [] }),
    closeMcpClients: async () => {},
  };
});

const ASK = {
  question: "Which approach do you want?",
  options: [
    { id: "quick", label: "Quick fix" },
    { id: "proper", label: "Proper rewrite" },
  ],
  context_note: "The proper rewrite takes about a day.",
};

const CHANNEL: GenerationRequest = {
  messageId: "m2",
  containerId: "discord:g1:c1",
  scopeId: "g1",
  channelId: "c1",
  parentChannelId: null,
  userId: "u1",
  userDisplayName: "User",
  summonKind: "user-mention",
  content: "redo that",
  history: [],
  reference: null,
  attachments: [],
};

/** The same conversation, run inside a thread of the channel. */
const THREAD: GenerationRequest = {
  ...CHANNEL,
  messageId: "m9",
  containerId: "discord:g1:c1:t1",
  channelId: "t1",
  parentChannelId: "c1",
  summonKind: "thread-chat",
};

const DM: GenerationRequest = {
  ...CHANNEL,
  containerId: "discord:@me:42",
  scopeId: "dm",
  channelId: "42",
  summonKind: "dm-chat",
};

const STORED_TURN = {
  containerId: CHANNEL.containerId,
  scopeId: "g1",
  channelId: "c1",
  userId: "u1",
  userDisplayName: "User",
  triggerMessageId: "m1",
  /** When the prompting message was sent. */
  triggerCreatedAt: 500,
  triggerContent: "What is the release day?",
  assistantReply: "Fridays.",
};

function message(
  partial: Partial<HistoryMessage> & Pick<HistoryMessage, "id" | "isBot">,
): HistoryMessage {
  return {
    text: `text of ${partial.id}`,
    authorId: "u1",
    authorName: "User",
    createdAt: 1000,
    ...partial,
  };
}

/** A conversation whose last exchange was the user's `q` and the bot's `a`. */
const EXCHANGED: HistoryMessage[] = [
  message({ id: "older", isBot: false, authorId: "u2", authorName: "Cara", text: "Anything new?" }),
  message({ id: "q", isBot: false, text: "What is the release day?" }),
  message({ id: "a", isBot: true, authorId: "bot", text: "Fridays." }),
];

function makeEnv(db = createTestD1()): Env {
  return {
    DB: db,
    INTERNAL_API_TOKEN: "test-internal-token",
    OPENROUTER_API_KEY: "test-key",
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

/** Call a tool's `execute` as the SDK does; the interaction tools read nothing else from a call. */
async function runTool(
  req: GenerationRequest,
  name: string,
  input?: unknown,
  options: { db?: D1Database; resetAt?: number } = {},
): Promise<unknown> {
  const tools: ToolSet = createInteractionTools({
    db: options.db ?? createTestD1(),
    req,
    resetAt: options.resetAt ?? 0,
  });
  const definition = tools[name] as unknown as {
    execute: (input: unknown, context: unknown) => Promise<unknown>;
  };
  return definition.execute(input, { toolCallId: "call-1", messages: [], abortSignal: undefined });
}

/** The question of an `ask_user` output that produced one; throws on any other output. */
function promptOf(output: unknown): AskUserPrompt {
  if (typeof output === "object" && output !== null && "prompt" in output) {
    const prompt = output.prompt;
    if (typeof prompt === "object" && prompt !== null && "question" in prompt) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the tool's own output type, checked above
      return prompt as AskUserPrompt;
    }
  }
  throw new Error(`expected a waiting_for_user output, got ${JSON.stringify(output)}`);
}

// ── Through the real tool loop ────────────────────────────────────────────

/** One scripted step: a tool call, a text answer, or a tool call with a text lead-in. */
type Step = { text: string } | { call: { toolName: string; input: object }; text?: string };

/**
 * A model scripted to play `steps` in order: a step calls its tool while
 * tools are on offer and otherwise answers with its text. Records every prompt
 * it was given and the tools each step was offered.
 */
function scriptedModel(steps: readonly Step[]) {
  const prompts: ModelMessage[][] = [];
  const offered: string[][] = [];
  const model = new MockLanguageModelV3({
    doGenerate: async ({ tools, prompt }) => {
      prompts.push(prompt);
      offered.push((tools ?? []).map((tool) => tool.name));
      const usage = {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 5, text: 5, reasoning: 0 },
      };
      const step = steps[offered.length - 1];
      const calling = step !== undefined && "call" in step && (tools?.length ?? 0) > 0;
      const text = step?.text;
      return {
        content: [
          ...(calling
            ? [
                {
                  type: "tool-call" as const,
                  toolCallId: `call-${offered.length}`,
                  toolName: step.call.toolName,
                  input: JSON.stringify(step.call.input),
                },
              ]
            : []),
          ...(text === undefined ? [] : [{ type: "text" as const, text }]),
        ],
        finishReason: calling
          ? { unified: "tool-calls", raw: "tool-calls" }
          : { unified: "stop", raw: "stop" },
        usage,
        warnings: [],
      };
    },
  });
  return { model, prompts, offered };
}

/** Run the real generateText loop against `model` for one test. */
async function useRealLoop(model: MockLanguageModelV3): Promise<void> {
  const { generateText: realGenerateText } = await vi.importActual<typeof Ai>("ai");
  vi.mocked(generateText).mockImplementation(realGenerateText);
  vi.mocked(createModel).mockReturnValue(model);
}

/** The tool results a prompt carries, in the order the model receives them. */
function toolOutputs(prompt: ModelMessage[]): Array<{ toolName: string; output: unknown }> {
  const outputs: Array<{ toolName: string; output: unknown }> = [];
  for (const modelMessage of prompt) {
    if (modelMessage.role !== "tool") continue;
    for (const part of modelMessage.content) {
      if (part.type !== "tool-result") continue;
      const output = part.output;
      outputs.push({
        toolName: part.toolName,
        output:
          typeof output === "object" &&
          output !== null &&
          "type" in output &&
          output.type === "json" &&
          "value" in output
            ? output.value
            : output,
      });
    }
  }
  return outputs;
}

/** Names of the interaction tools a generation is offered. */
function offeredTools(req: GenerationRequest): string[] {
  return Object.keys(createInteractionTools({ db: createTestD1(), req, resetAt: 0 }));
}

/** One tool result of a run, as the pipeline reads them back. */
function resultOf(toolName: string, output: unknown): { toolName: string; output: unknown } {
  return { toolName, output };
}

/** A `retry_last_reply` result carried by a run. */
function retryResult(output: unknown): Array<{ toolName: string; output: unknown }> {
  return [resultOf("retry_last_reply", output)];
}

/** A successful `ask_user` result carrying the question `<id>?`. */
function askResult(id: string): { toolName: string; output: unknown } {
  return resultOf("ask_user", {
    status: "waiting_for_user",
    prompt: { id, question: `${id}?`, options: [] },
  });
}

type StoredTurnRow = {
  trigger_message_id: string;
  trigger_created_at: number;
  trigger_content: string;
  assistant_reply: string;
  updated_at: number;
};

type StoredThreadRow = {
  guild_id: string;
  parent_channel_id: string;
  created_by: string;
  active: number;
  pending_card_ids_json: string;
};

async function storedTurn(db: D1Database, containerId: string): Promise<StoredTurnRow | null> {
  return db
    .prepare(
      "SELECT trigger_message_id, trigger_created_at, trigger_content, assistant_reply, updated_at FROM container_last_turns WHERE container_id = ?1",
    )
    .bind(containerId)
    .first<StoredTurnRow>();
}

async function storedThreads(db: D1Database): Promise<StoredThreadRow[]> {
  const { results } = await db
    .prepare(
      "SELECT guild_id, parent_channel_id, created_by, active, pending_card_ids_json FROM thread_sessions",
    )
    .all<StoredThreadRow>();
  return results;
}

beforeEach(() => {
  vi.mocked(generateText).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ask_user", () => {
  it("returns the question as a prompt the Runtime can show at once", async () => {
    const output = await runTool(CHANNEL, "ask_user", ASK);

    expect(output).toMatchObject({
      status: "waiting_for_user",
      prompt: { question: ASK.question, options: ASK.options, contextNote: ASK.context_note },
    });
    expect(promptOf(output).id).not.toBe("");
  });

  it("accepts two to four options and leaves out an absent context note", async () => {
    const yesNo = [
      { id: "yes", label: "Yes" },
      { id: "no", label: "No" },
    ];
    const four = [...yesNo, { id: "maybe", label: "Maybe" }, { id: "later", label: "Later" }];

    expect(
      promptOf(await runTool(CHANNEL, "ask_user", { question: "Go on?", options: yesNo })),
    ).toMatchObject({ options: yesNo });
    expect(
      promptOf(
        await runTool(CHANNEL, "ask_user", { question: "Which?", options: four }),
      ).options.map((o) => o.id),
    ).toEqual(["yes", "no", "maybe", "later"]);
    for (const input of [
      { question: "Go on?", options: yesNo },
      { ...ASK, context_note: "   " },
    ]) {
      const prompt = promptOf(await runTool(CHANNEL, "ask_user", input));
      expect(prompt).not.toHaveProperty("contextNote");
    }
  });

  it("cuts a long question, note, and labels to size instead of refusing them", async () => {
    const prompt = promptOf(
      await runTool(CHANNEL, "ask_user", {
        question: "q".repeat(900),
        options: [
          { id: "a", label: "x".repeat(120) },
          { id: "b", label: "y".repeat(120) },
        ],
        context_note: "n".repeat(900),
      }),
    );

    expect(prompt.question).toHaveLength(500);
    expect(prompt.contextNote).toHaveLength(500);
    expect(prompt.options.map((option) => option.label)).toEqual(["x".repeat(80), "y".repeat(80)]);
  });

  it("never cuts a label inside a surrogate pair", async () => {
    // 79 ASCII units, an emoji (two units), and one more: the emoji does not fit the 80th unit.
    const prompt = promptOf(
      await runTool(CHANNEL, "ask_user", {
        question: "Which?",
        options: [
          { id: "a", label: `${"a".repeat(79)}😀b` },
          { id: "b", label: "No" },
        ],
      }),
    );

    expect(prompt.options[0]?.label).toBe("a".repeat(79));
  });

  it.each([
    ["a missing question", { options: ASK.options }],
    ["a blank question", { ...ASK, question: "   " }],
    ["a non-string question", { ...ASK, question: 7 }],
    ["one option", { ...ASK, options: ASK.options.slice(0, 1) }],
    [
      "five options",
      {
        ...ASK,
        options: [
          ...ASK.options,
          { id: "c", label: "C" },
          { id: "d", label: "D" },
          { id: "e", label: "E" },
        ],
      },
    ],
    ["an option without an id", { ...ASK, options: [{ label: "A" }, ASK.options[1]] }],
    [
      "an id with characters outside letters, digits, and hyphens",
      { ...ASK, options: [{ id: "opt_1", label: "A" }, ASK.options[1]] },
    ],
    [
      "an id longer than 24 characters",
      { ...ASK, options: [{ id: "a".repeat(25), label: "A" }, ASK.options[1]] },
    ],
    ["two options with the same id", { ...ASK, options: [ASK.options[0], ASK.options[0]] }],
    ["an option without a label", { ...ASK, options: [{ id: "a" }, ASK.options[1]] }],
    ["a blank label", { ...ASK, options: [{ id: "a", label: " " }, ASK.options[1]] }],
    ["a non-string context note", { ...ASK, context_note: 3 }],
    ["a body that is not an object", "just ask"],
  ])("refuses %s and asks for nothing", async (_case, input) => {
    const output = await runTool(CHANNEL, "ask_user", input);

    expect(output).toMatchObject({ status: "error", code: "invalid_input" });
    expect(output).not.toHaveProperty("prompt");
  });

  it("names the field to fix, so the model can ask again", async () => {
    expect(
      await runTool(CHANNEL, "ask_user", { ...ASK, options: ASK.options.slice(0, 1) }),
    ).toEqual({
      status: "error",
      code: "invalid_input",
      reason: "options_count",
    });
    expect(
      await runTool(CHANNEL, "ask_user", { ...ASK, options: [ASK.options[0], ASK.options[0]] }),
    ).toEqual({
      status: "error",
      code: "invalid_input",
      reason: "option_id",
    });
    expect(
      await runTool(CHANNEL, "ask_user", {
        ...ASK,
        options: [{ id: "a", label: " " }, ASK.options[1]],
      }),
    ).toEqual({
      status: "error",
      code: "invalid_input",
      reason: "option_label",
    });
  });

  it("ends the run at once on a question, with no answer text", async () => {
    const env = makeEnv();
    const { model, offered } = scriptedModel([
      { call: { toolName: "ask_user", input: ASK } },
      { text: "This step must never run." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, { ...CHANNEL, content: "fix the bug" });

    expect(offered).toHaveLength(1);
    expect(result).toMatchObject({
      status: "completed",
      requestId: expect.any(String),
      reply: "",
      usage: expect.objectContaining({ inputTokens: 10 }),
      askPrompt: { question: ASK.question, options: ASK.options, contextNote: ASK.context_note },
    });
  });

  it("keeps what the model said before asking as the reply", async () => {
    const env = makeEnv();
    const { model, offered } = scriptedModel([
      { call: { toolName: "ask_user", input: ASK }, text: "I found two ways." },
      { text: "This step must never run." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, CHANNEL);

    expect(offered).toHaveLength(1);
    expect(result).toMatchObject({ status: "completed", reply: "I found two ways." });
  });

  it("does not end the run on a refused call: the model reads why and asks again", async () => {
    const env = makeEnv();
    const { model, prompts, offered } = scriptedModel([
      { call: { toolName: "ask_user", input: { ...ASK, options: ASK.options.slice(0, 1) } } },
      { call: { toolName: "ask_user", input: ASK } },
      { text: "This step must never run." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, CHANNEL);

    expect(offered).toHaveLength(2);
    expect(toolOutputs(prompts[1] ?? [])).toEqual([
      {
        toolName: "ask_user",
        output: { status: "error", code: "invalid_input", reason: "options_count" },
      },
    ]);
    expect(result).toMatchObject({ status: "completed", askPrompt: { question: ASK.question } });
  });

  it("returns the latest valid question of a run", () => {
    const refused = { toolName: "ask_user", output: { status: "error", code: "invalid_input" } };

    expect(extractAskPrompt([askResult("first"), askResult("second")])).toMatchObject({
      id: "second",
    });
    expect(extractAskPrompt([askResult("first"), refused])).toMatchObject({ id: "first" });
    expect(extractAskPrompt([refused])).toBeUndefined();
    expect(extractAskPrompt([resultOf("web_search", askResult("x").output)])).toBeUndefined();
  });

  it("stores no turn for a run that ended on a question", async () => {
    const env = makeEnv();
    const { model } = scriptedModel([{ call: { toolName: "ask_user", input: ASK } }]);
    await useRealLoop(model);

    const result = await generate(env, THREAD);

    expect(result).toMatchObject({ status: "completed", askPrompt: { question: ASK.question } });
    expect(await storedTurn(env.DB, THREAD.containerId)).toBeNull();
  });
});

describe("retry_last_reply", () => {
  it("hands the model the stored turn of a guild conversation", async () => {
    const db = createTestD1();
    await recordLastTurn(db, STORED_TURN, 1000);

    const output = await runTool(
      { ...CHANNEL, history: EXCHANGED },
      "retry_last_reply",
      { instruction: " shorter " },
      { db },
    );

    expect(output).toEqual({
      status: "ok",
      previousUserPrompt: "What is the release day?",
      previousAssistantReply: "Fridays.",
      instruction: "shorter",
    });
  });

  it("prefers the stored turn over what the history shows", async () => {
    const db = createTestD1();
    await recordLastTurn(
      db,
      { ...STORED_TURN, triggerContent: "STORED PROMPT", assistantReply: "STORED REPLY" },
      1000,
    );

    const output = await runTool(
      { ...CHANNEL, history: EXCHANGED },
      "retry_last_reply",
      {},
      { db },
    );

    expect(output).toMatchObject({
      previousUserPrompt: "STORED PROMPT",
      previousAssistantReply: "STORED REPLY",
    });
  });

  it("falls back to the conversation's history when nothing is stored", async () => {
    expect(await runTool({ ...CHANNEL, history: EXCHANGED }, "retry_last_reply", {})).toEqual({
      status: "ok",
      previousUserPrompt: "What is the release day?",
      previousAssistantReply: "Fridays.",
      instruction: "",
    });
  });

  it("falls back to the history when the stored turns cannot be read", async () => {
    const db = createTestD1();
    await db.prepare("DROP TABLE container_last_turns").run();

    const output = await runTool(
      { ...CHANNEL, history: EXCHANGED },
      "retry_last_reply",
      {},
      { db },
    );

    expect(output).toMatchObject({ status: "ok", previousUserPrompt: "What is the release day?" });
  });

  it("finds nothing to redo without a bot reply to redo", async () => {
    expect(await runTool({ ...CHANNEL, history: [] }, "retry_last_reply")).toEqual({
      status: "no_previous_turn",
    });
    expect(
      await runTool(
        { ...CHANNEL, history: [message({ id: "q", isBot: false })] },
        "retry_last_reply",
      ),
    ).toEqual({
      status: "no_previous_turn",
    });
  });

  it("finds nothing to redo in a stored turn whose prompt is empty", async () => {
    const db = createTestD1();
    await recordLastTurn(
      db,
      { ...STORED_TURN, triggerContent: "", assistantReply: "Here is what the image shows." },
      1000,
    );

    const output = await runTool({ ...CHANNEL, history: [] }, "retry_last_reply", {}, { db });

    expect(output).toEqual({ status: "no_previous_turn" });
  });

  it("reads the exchange just before the current message, not an older one", async () => {
    const history = [
      ...EXCHANGED,
      message({ id: "q2", isBot: false, text: "And the build time?" }),
      message({ id: "a2", isBot: true, text: "About an hour." }),
      message({ id: "m2", isBot: false, text: "redo that", createdAt: 5000 }),
    ];

    const output = await runTool({ ...CHANNEL, history }, "retry_last_reply", {
      instruction: "brief",
    });

    expect(output).toMatchObject({
      previousUserPrompt: "And the build time?",
      previousAssistantReply: "About an hour.",
      instruction: "brief",
    });
  });

  /** A conversation whose visible history holds one later exchange. */
  const LATER = [
    ...EXCHANGED,
    message({ id: "q3", isBot: false, text: "Later question", createdAt: 3000 }),
    message({ id: "a3", isBot: true, text: "Later answer", createdAt: 3100 }),
  ];

  it("brings back no exchange the user truncated away", async () => {
    const db = createTestD1();
    await recordLastTurn(db, STORED_TURN, 1000);

    const output = await runTool(
      { ...CHANNEL, history: LATER },
      "retry_last_reply",
      {},
      { db, resetAt: 3000 },
    );

    expect(output).toMatchObject({
      previousUserPrompt: "Later question",
      previousAssistantReply: "Later answer",
    });
    expect(
      await runTool(
        { ...CHANNEL, history: EXCHANGED },
        "retry_last_reply",
        {},
        { db, resetAt: 3000 },
      ),
    ).toEqual({
      status: "no_previous_turn",
    });
  });

  it("goes by when the prompt was sent, not by when its reply was stored", async () => {
    const db = createTestD1();
    // The user asked at t = 500 and truncated at t = 3000 while the reply was
    // still being written; the reply landed at t = 3500.
    await recordLastTurn(db, STORED_TURN, 3500);

    const output = await runTool(
      { ...CHANNEL, history: EXCHANGED },
      "retry_last_reply",
      {},
      { db, resetAt: 3000 },
    );

    // The prompt predates the truncation, so the stored turn is not used — however recent its reply.
    expect(output).toEqual({ status: "no_previous_turn" });
  });

  it("does not let retries stored after the truncation revive the prompt", async () => {
    const db = createTestD1();
    await recordLastTurn(db, STORED_TURN, 1000);
    // Two retries, both stored after the user truncated everything before t = 3000.
    await recordLastReply(
      db,
      { containerId: STORED_TURN.containerId, scopeId: "g1", assistantReply: "Friday." },
      4000,
    );
    await recordLastReply(
      db,
      { containerId: STORED_TURN.containerId, scopeId: "g1", assistantReply: "Fri." },
      5000,
    );

    expect(await getLastTurn(db, STORED_TURN.containerId)).toMatchObject({
      triggerCreatedAt: 500,
      assistantReply: "Fri.",
      updatedAt: 5000,
    });
    expect(
      await runTool(
        { ...CHANNEL, history: EXCHANGED },
        "retry_last_reply",
        {},
        { db, resetAt: 3000 },
      ),
    ).toEqual({ status: "no_previous_turn" });
  });

  it("reads a stored prompt that was sent after the watermark", async () => {
    const db = createTestD1();
    await recordLastTurn(db, { ...STORED_TURN, triggerCreatedAt: 3000 }, 4000);

    const output = await runTool(
      { ...CHANNEL, history: [] },
      "retry_last_reply",
      {},
      { db, resetAt: 3000 },
    );

    expect(output).toMatchObject({
      previousUserPrompt: "What is the release day?",
      previousAssistantReply: "Fridays.",
    });
  });

  /** A conversation where the user asked, then asked twice in a row for the reply to be redone. */
  const CHAINED = [
    ...EXCHANGED,
    message({ id: "redo-1", isBot: false, text: "重试", createdAt: 2000, retryRequest: true }),
    message({
      id: "a-redone",
      isBot: true,
      authorId: "bot",
      text: "It deploys on Fridays.",
      createdAt: 2100,
    }),
  ];

  it("walks back past an earlier redo request to the question actually asked", async () => {
    const output = await runTool({ ...DM, history: CHAINED }, "retry_last_reply", {
      instruction: "shorter",
    });

    // The question is the one the redone reply answers; the reply to improve is the latest one to it.
    expect(output).toEqual({
      status: "ok",
      previousUserPrompt: "What is the release day?",
      previousAssistantReply: "It deploys on Fridays.",
      instruction: "shorter",
    });
  });

  it("walks back any number of redo requests in a row", async () => {
    const history = [
      ...CHAINED,
      message({ id: "redo-2", isBot: false, text: "again", createdAt: 2200, retryRequest: true }),
      message({
        id: "a-redone-2",
        isBot: true,
        authorId: "bot",
        text: "Fridays.",
        createdAt: 2300,
      }),
    ];

    const output = await runTool({ ...DM, history }, "retry_last_reply");

    expect(output).toMatchObject({
      previousUserPrompt: "What is the release day?",
      previousAssistantReply: "Fridays.",
    });
  });

  it("finds nothing to redo when every prompt left is a redo request", async () => {
    const history = [
      message({ id: "redo-1", isBot: false, text: "重试", createdAt: 2000, retryRequest: true }),
      message({
        id: "a-redone",
        isBot: true,
        authorId: "bot",
        text: "It deploys on Fridays.",
        createdAt: 2100,
      }),
    ];

    expect(await runTool({ ...DM, history }, "retry_last_reply")).toEqual({
      status: "no_previous_turn",
    });
  });

  it("does not walk back past the user's truncation to reach a question", async () => {
    // The question was asked before the truncation; only the redo requests and their replies are still in view.
    expect(
      await runTool({ ...CHANNEL, history: CHAINED }, "retry_last_reply", {}, { resetAt: 1999 }),
    ).toEqual({
      status: "no_previous_turn",
    });
  });

  it("refuses an instruction that is not text", async () => {
    expect(await runTool(CHANNEL, "retry_last_reply", { instruction: 4 })).toEqual({
      status: "error",
      code: "invalid_input",
    });
  });

  it("reads a DM turn from the DM's history only, and never queries the stored turns", async () => {
    const { db, queries } = recordingDb();
    await db.prepare("DROP TABLE container_last_turns").run();
    queries.length = 0;

    const output = await runTool({ ...DM, history: EXCHANGED }, "retry_last_reply", {}, { db });

    expect(output).toMatchObject({
      status: "ok",
      previousUserPrompt: "What is the release day?",
      previousAssistantReply: "Fridays.",
    });
    expect(queries.filter((query) => query.includes("container_last_turns"))).toEqual([]);
  });

  it("reads a DM's own messages only, in a DM", async () => {
    const history = [
      message({ id: "other", isBot: false, authorId: "intruder", text: "INTRUDER TEXT" }),
      message({ id: "q", isBot: false, text: "What is the release day?" }),
      message({ id: "a", isBot: true, text: "Fridays." }),
    ];

    const output = await runTool({ ...DM, history }, "retry_last_reply");

    expect(JSON.stringify(output)).not.toContain("INTRUDER TEXT");
    expect(output).toMatchObject({ previousUserPrompt: "What is the release day?" });
  });
});

describe("generation turn record", () => {
  it("stores a completed guild turn for the next retry, with the time its message was sent", async () => {
    const env = makeEnv();
    const { model } = scriptedModel([{ text: "Fridays." }]);
    await useRealLoop(model);

    const result = await generate(env, {
      ...CHANNEL,
      content: "What is the release day?",
      messageCreatedAt: 4242,
    });

    expect(await storedTurn(env.DB, CHANNEL.containerId)).toMatchObject({
      trigger_message_id: "m2",
      trigger_created_at: 4242,
      trigger_content: "What is the release day?",
      assistant_reply: "Fridays.",
    });
    expect(result).not.toHaveProperty("retriedLastReply");
  });

  it("stamps a Runtime that does not say when the message was sent with the reply's own time", async () => {
    const env = makeEnv();
    const { model } = scriptedModel([{ text: "Fridays." }]);
    await useRealLoop(model);

    await generate(env, CHANNEL);

    // Late rather than early: a prompt the Runtime did not time reads as newer than it is.
    expect(await storedTurn(env.DB, CHANNEL.containerId)).toMatchObject({
      trigger_message_id: "m2",
      trigger_created_at: expect.any(Number),
    });
    const row = await storedTurn(env.DB, CHANNEL.containerId);
    expect(row?.trigger_created_at).toBe(row?.updated_at);
  });

  it("replaces only the reply when the turn redid the last one, and says so", async () => {
    const env = makeEnv();
    await recordLastTurn(env.DB, STORED_TURN, 1000);
    const { model, prompts } = scriptedModel([
      { call: { toolName: "retry_last_reply", input: { instruction: "shorter" } } },
      { text: "Friday." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, { ...CHANNEL, messageCreatedAt: 9000 });

    expect(toolOutputs(prompts[1] ?? [])).toEqual([
      {
        toolName: "retry_last_reply",
        output: {
          status: "ok",
          previousUserPrompt: "What is the release day?",
          previousAssistantReply: "Fridays.",
          instruction: "shorter",
        },
      },
    ]);
    expect(result).toMatchObject({ status: "completed", retriedLastReply: true });
    // The prompt stays the one the user actually wrote, with its own time — not the redo request's.
    expect(await storedTurn(env.DB, CHANNEL.containerId)).toMatchObject({
      trigger_message_id: "m1",
      trigger_created_at: 500,
      trigger_content: "What is the release day?",
      assistant_reply: "Friday.",
    });
  });

  it("stores a normal turn when there was nothing to redo", async () => {
    const env = makeEnv();
    const { model } = scriptedModel([
      { call: { toolName: "retry_last_reply", input: {} } },
      { text: "There is no earlier reply to redo." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, { ...CHANNEL, messageCreatedAt: 7000 });

    expect(result).not.toHaveProperty("retriedLastReply");
    expect(await storedTurn(env.DB, CHANNEL.containerId)).toMatchObject({
      trigger_message_id: "m2",
      trigger_created_at: 7000,
      trigger_content: "redo that",
      assistant_reply: "There is no earlier reply to redo.",
    });
  });

  it("never stores a DM turn: no statement names the table", async () => {
    const { db, queries } = recordingDb();
    const env = makeEnv(db);
    const { model } = scriptedModel([
      { call: { toolName: "retry_last_reply", input: {} } },
      { text: "Friday." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, { ...DM, history: EXCHANGED, content: "again, shorter" });
    const touched = queries.filter((query) => query.includes("container_last_turns"));

    expect(result).toMatchObject({ status: "completed", reply: "Friday." });
    expect(touched).toEqual([]);
  });

  it("still answers when the turn cannot be recorded", async () => {
    const env = makeEnv();
    await env.DB.prepare("DROP TABLE container_last_turns").run();
    const { model } = scriptedModel([{ text: "Fridays." }]);
    await useRealLoop(model);

    expect(await generate(env, CHANNEL)).toMatchObject({ status: "completed", reply: "Fridays." });
  });
});

describe("thread_pause", () => {
  it("is offered in a server thread, and nowhere else", () => {
    expect(offeredTools(THREAD)).toEqual(["ask_user", "retry_last_reply", "thread_pause"]);
    expect(offeredTools(CHANNEL)).toEqual(["ask_user", "retry_last_reply"]);
    expect(offeredTools({ ...DM, parentChannelId: "42" })).toEqual([
      "ask_user",
      "retry_last_reply",
    ]);
  });

  it("unfollows the thread once the reply that asked for it is complete", async () => {
    const env = makeEnv();
    const { model, prompts } = scriptedModel([
      { call: { toolName: "thread_pause", input: {} } },
      { text: "Sure, stopping here." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, THREAD);

    expect(toolOutputs(prompts[1] ?? [])).toEqual([
      { toolName: "thread_pause", output: { status: "paused" } },
    ]);
    expect(result).toMatchObject({
      status: "completed",
      reply: "Sure, stopping here.",
      threadDeactivated: true,
    });
    expect(await storedThreads(env.DB)).toEqual([
      {
        guild_id: "g1",
        parent_channel_id: "c1",
        created_by: "u1",
        active: 0,
        pending_card_ids_json: "[]",
      },
    ]);
  });

  it("leaves the thread followed and the result silent when the pause cannot be stored", async () => {
    const env = makeEnv();
    await env.DB.prepare("DROP TABLE thread_sessions").run();
    const { model } = scriptedModel([
      { call: { toolName: "thread_pause", input: {} } },
      { text: "Stopping here." },
    ]);
    await useRealLoop(model);

    const result = await generate(env, THREAD);

    expect(result).toMatchObject({ status: "completed", reply: "Stopping here." });
    expect(result).not.toHaveProperty("threadDeactivated");
  });

  it("waits with the pause while the same turn still asks the user something", async () => {
    const env = makeEnv();
    const { model, offered } = scriptedModel([
      { call: { toolName: "thread_pause", input: {} } },
      { call: { toolName: "ask_user", input: ASK } },
    ]);
    await useRealLoop(model);

    const result = await generate(env, THREAD);

    expect(offered).toHaveLength(2);
    expect(result).toMatchObject({ askPrompt: { question: ASK.question } });
    expect(result).not.toHaveProperty("threadDeactivated");
    expect(await storedThreads(env.DB)).toEqual([]);
  });

  it("tells a call that took effect apart from one with nothing to act on", () => {
    expect(hasRetry(retryResult({ status: "ok" }))).toBe(true);
    expect(hasRetry(retryResult({ status: "no_previous_turn" }))).toBe(false);
    expect(hasRetry(retryResult({ status: "error", code: "invalid_input" }))).toBe(false);
    expect(hasThreadPause([{ toolName: "thread_pause", output: { status: "paused" } }])).toBe(true);
    expect(hasThreadPause([{ toolName: "thread_pause", output: { status: "error" } }])).toBe(false);
  });
});
