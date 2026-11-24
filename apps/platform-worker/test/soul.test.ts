import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionOptions } from "ai";

import {
  DEFAULT_SOUL,
  DEFAULT_SOUL_SCOPE,
  extractSoulProposal,
  getBotSoul,
  handleSoulApply,
  MAX_SOUL_CHARS,
  normalizeSoul,
  setBotSoul,
} from "../src/soul";
import {
  createSoulReadTool,
  createSoulUpdateTool,
  type SoulReadOutput,
  type SoulUpdateOutput,
} from "../src/tools/soul-tools";
import worker from "../src/index";
import { createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

/** Execution options the way the SDK passes them; the soul tools read none. */
const EXECUTION: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "call-1",
  messages: [],
  context: {},
};

/** Run `soul_read`; it answers with one plain object, never a stream. */
function readSoul(env: Env, scopeId: string): Promise<SoulReadOutput> {
  return createSoulReadTool(env, scopeId).execute!({}, EXECUTION) as Promise<SoulReadOutput>;
}

/** Run `soul_update`; it answers with one plain object, never a stream. */
function updateSoul(
  scopeId: string,
  input: { content: string; summary: string },
): Promise<SoulUpdateOutput> {
  return createSoulUpdateTool(scopeId).execute!(input, EXECUTION) as Promise<SoulUpdateOutput>;
}

type SoulRow = { scope_id: string; content: string; updated_by: string | null; updated_at: number };

function soulEnv(db: D1Database): Env {
  // The soul tools and handlers read DB only; no model or tool secrets.
  return { DB: db } as Env;
}

async function soulRows(db: D1Database): Promise<SoulRow[]> {
  const { results } = await db
    .prepare("SELECT scope_id, content, updated_by, updated_at FROM bot_soul ORDER BY scope_id")
    .all<SoulRow>();
  return results ?? [];
}

/** A D1 whose every statement fails at `run`, as a real outage would. */
function failingDb(): D1Database {
  return {
    prepare: () => ({
      bind: () => ({
        first: async () => {
          throw new Error("D1 unavailable");
        },
        run: async () => {
          throw new Error("D1 unavailable");
        },
      }),
    }),
  } as unknown as D1Database;
}

const proposal = {
  id: "b7c1e2a0-5d1e-4f0a-9c3d-2e8f1a6b4c11",
  scopeId: "g1",
  content: "Be calm and precise.",
  summary: "Calm down the tone.",
};

/** POST a raw body to the apply route, as the Runtime would. */
async function applySoul(
  env: Env,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request("https://worker/internal/v1/soul/apply", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
  });
  return worker.fetch(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridging undici Request to the workers-types signature
    request as unknown as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getBotSoul", () => {
  it("uses the built-in soul wherever nothing is customized", async () => {
    expect(await getBotSoul(createTestD1(), "g1")).toEqual({
      content: DEFAULT_SOUL,
      isDefault: true,
    });
  });

  it("returns a guild's own soul, and only for that guild", async () => {
    const db = createTestD1();
    await setBotSoul(db, { scopeId: "g1", content: "Speak like a pirate.", now: 1 });

    expect(await getBotSoul(db, "g1")).toEqual({
      content: "Speak like a pirate.",
      isDefault: false,
    });
    expect(await getBotSoul(db, "g2")).toEqual({ content: DEFAULT_SOUL, isDefault: true });
  });

  it("prefers the guild's soul over the default, and the default over the built-in", async () => {
    const db = createTestD1();
    await setBotSoul(db, { scopeId: DEFAULT_SOUL_SCOPE, content: "Global soul.", now: 1 });
    await setBotSoul(db, { scopeId: "g1", content: "Guild soul.", now: 2 });

    expect((await getBotSoul(db, "g1"))?.content).toBe("Guild soul.");
    expect(await getBotSoul(db, "g2")).toEqual({ content: "Global soul.", isDefault: false });
  });

  it("never lets a guild's soul reach a DM", async () => {
    const db = createTestD1();
    await setBotSoul(db, { scopeId: "g1", content: "Guild soul.", now: 1 });
    expect(await getBotSoul(db, "dm")).toEqual({ content: DEFAULT_SOUL, isDefault: true });

    await setBotSoul(db, { scopeId: DEFAULT_SOUL_SCOPE, content: "Global soul.", now: 2 });
    expect(await getBotSoul(db, "dm")).toEqual({ content: "Global soul.", isDefault: false });
  });

  it("falls back to the built-in soul when the table cannot be read", async () => {
    expect(await getBotSoul(failingDb(), "g1")).toEqual({
      content: DEFAULT_SOUL,
      isDefault: true,
    });
  });
});

describe("setBotSoul", () => {
  it("stores the soul with who changed it and when, and upserts the next change", async () => {
    const db = createTestD1();
    await setBotSoul(db, {
      scopeId: "g1",
      content: "First soul.",
      updatedBy: "u1",
      now: 1_000,
    });
    await setBotSoul(db, {
      scopeId: "g1",
      content: "Second soul.",
      updatedBy: "u2",
      now: 2_000,
    });

    expect(await soulRows(db)).toEqual([
      { scope_id: "g1", content: "Second soul.", updated_by: "u2", updated_at: 2_000 },
    ]);
  });

  it("rejects an empty soul and stores nothing", async () => {
    const db = createTestD1();
    await expect(setBotSoul(db, { scopeId: "g1", content: " \n\t ", now: 1 })).rejects.toThrow(
      /empty/,
    );
    expect(await soulRows(db)).toEqual([]);
  });
});

describe("normalizeSoul", () => {
  it("trims, and treats whitespace-only content as empty", () => {
    expect(normalizeSoul("  Keep me. \n")).toBe("Keep me.");
    expect(normalizeSoul("   ")).toBeNull();
  });

  it("clamps to the length cap counting code points, not UTF-16 units", () => {
    expect(normalizeSoul("字".repeat(MAX_SOUL_CHARS + 25))).toBe("字".repeat(MAX_SOUL_CHARS));
    // Astral characters such as emoji take two UTF-16 units each.
    expect(normalizeSoul("😀".repeat(MAX_SOUL_CHARS + 25))).toBe("😀".repeat(MAX_SOUL_CHARS));
  });
});

describe("soul_read", () => {
  it("reports the soul in effect for the generation's scope", async () => {
    const db = createTestD1();
    await setBotSoul(db, { scopeId: "g1", content: "Guild soul.", now: 1 });
    const env = soulEnv(db);

    expect(await readSoul(env, "g1")).toEqual({
      scopeId: "g1",
      content: "Guild soul.",
      isDefault: false,
    });
    expect(await readSoul(env, "g2")).toEqual({
      scopeId: "g2",
      content: DEFAULT_SOUL,
      isDefault: true,
    });
    expect(await readSoul(env, "dm")).toEqual({
      scopeId: "dm",
      content: DEFAULT_SOUL,
      isDefault: true,
    });
  });
});

describe("soul_update", () => {
  it("proposes the soul for the generation's scope and writes nothing", async () => {
    const db = createTestD1();

    const output = await updateSoul("g1", {
      content: "  Be calm and precise. ",
      summary: " Calm down the tone. ",
    });

    expect(output).toMatchObject({
      status: "proposed",
      proposal: { scopeId: "g1", content: "Be calm and precise.", summary: "Calm down the tone." },
    });
    expect(await soulRows(db)).toEqual([]);
  });

  it("gives every proposal its own id", async () => {
    const first = await updateSoul("g1", { content: "One.", summary: "s" });
    const second = await updateSoul("g1", { content: "Two.", summary: "s" });

    expect(first.status).toBe("proposed");
    expect(second.status).toBe("proposed");
    if (first.status !== "proposed" || second.status !== "proposed") return;
    expect(first.proposal.id).not.toBe(second.proposal.id);
  });

  it("is refused in DM scope", async () => {
    const db = createTestD1();

    const output = await updateSoul("dm", { content: "Be calm.", summary: "Calm down." });

    expect(output).toEqual({ status: "rejected", reason: "dm_not_allowed" });
    expect(await soulRows(db)).toEqual([]);
  });

  it("refuses an empty soul", async () => {
    const output = await updateSoul("g1", { content: "   ", summary: "Erase everything." });
    expect(output).toEqual({ status: "rejected", reason: "empty_content" });
  });

  it("clamps an oversized soul and summary", async () => {
    const output = await updateSoul("g1", {
      content: "字".repeat(MAX_SOUL_CHARS + 500),
      summary: "s".repeat(1_500),
    });

    expect(output.status).toBe("proposed");
    if (output.status !== "proposed") return;
    expect(Array.from(output.proposal.content)).toHaveLength(MAX_SOUL_CHARS);
    expect(output.proposal.summary).toHaveLength(300);
  });
});

describe("extractSoulProposal", () => {
  const first = { ...proposal, id: "p1", content: "First version." };

  it("keeps the latest valid proposal when the model called the tool several times", () => {
    const latest = extractSoulProposal([
      { toolName: "soul_read", output: { scopeId: "g1", content: "old", isDefault: false } },
      { toolName: "soul_update", output: { status: "proposed", proposal: first } },
      { toolName: "web_search", output: { results: [] } },
      { toolName: "soul_update", output: { status: "proposed", proposal } },
    ]);
    expect(latest).toEqual(proposal);
  });

  it("ignores a proposal a later malformed call does not replace", () => {
    expect(
      extractSoulProposal([
        { toolName: "soul_update", output: { status: "proposed", proposal: first } },
        { toolName: "soul_update", output: { status: "proposed", proposal: { id: "p2" } } },
      ]),
    ).toEqual(first);
  });

  it("returns undefined when nothing was proposed", () => {
    expect(
      extractSoulProposal([
        { toolName: "soul_update", output: { status: "rejected", reason: "dm_not_allowed" } },
        { toolName: "soul_update" },
        { toolName: "soul_update", output: "not an object" },
        { toolName: "remember", output: { status: "proposed", proposal: { id: "m" } } },
      ]),
    ).toBeUndefined();
    expect(extractSoulProposal([])).toBeUndefined();
  });
});

describe("handleSoulApply", () => {
  const confirmed = { proposal, updatedBy: "u9" };

  it("stores the confirmed proposal and records who confirmed it", async () => {
    const db = createTestD1();

    const response = await handleSoulApply(db, confirmed);

    expect(response).toEqual({ status: "ok", scopeId: "g1" });
    const [row] = await soulRows(db);
    expect(row).toMatchObject({
      scope_id: "g1",
      content: "Be calm and precise.",
      updated_by: "u9",
    });
    expect(row?.updated_at).toBeGreaterThan(0);
  });

  it("refuses the reserved scopes: DMs never own a soul, and chat cannot overwrite the default", async () => {
    const db = createTestD1();

    expect(
      await handleSoulApply(db, {
        proposal: { ...proposal, scopeId: "dm" },
        updatedBy: "u9",
      }),
    ).toEqual({ status: "error", code: "invalid_scope" });
    expect(
      await handleSoulApply(db, {
        proposal: { ...proposal, scopeId: DEFAULT_SOUL_SCOPE },
        updatedBy: "u9",
      }),
    ).toEqual({ status: "error", code: "invalid_scope" });
    expect(await soulRows(db)).toEqual([]);
  });

  it("rejects a malformed request without touching the table", async () => {
    const db = createTestD1();
    for (const body of [
      null,
      "apply",
      [],
      {},
      { proposal },
      { proposal, updatedBy: "" },
      { updatedBy: "u9" },
      { ...confirmed, proposal: { ...proposal, content: 7 } },
      { ...confirmed, proposal: { ...proposal, summary: undefined } },
      { ...confirmed, proposal: { ...proposal, scopeId: "" } },
    ]) {
      expect(await handleSoulApply(db, body)).toEqual({ status: "error", code: "invalid_body" });
    }
    expect(await soulRows(db)).toEqual([]);
  });

  it("rejects a proposal whose content is empty", async () => {
    const db = createTestD1();
    const response = await handleSoulApply(db, {
      ...confirmed,
      proposal: { ...proposal, content: "  " },
    });
    expect(response).toEqual({ status: "error", code: "invalid_content" });
    expect(await soulRows(db)).toEqual([]);
  });

  it("reports a failed write instead of throwing", async () => {
    expect(await handleSoulApply(failingDb(), confirmed)).toEqual({
      status: "error",
      code: "soul_apply_failed",
    });
  });
});

describe("POST /internal/v1/soul/apply", () => {
  function makeEnv(): Env {
    return { DB: createTestD1(), INTERNAL_API_TOKEN: TOKEN } as Env;
  }

  const auth = { Authorization: `Bearer ${TOKEN}` };
  const confirmed = JSON.stringify({ proposal, updatedBy: "u9" });

  it("rejects requests without a valid bearer token", async () => {
    const env = makeEnv();
    expect((await applySoul(env, confirmed)).status).toBe(401);
    expect((await applySoul(env, confirmed, { Authorization: "Bearer nope" })).status).toBe(401);
    expect(await soulRows(env.DB)).toEqual([]);
  });

  it("returns 400 for a body that is not JSON", async () => {
    const response = await applySoul(makeEnv(), "{not json", auth);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "invalid_body" });
  });

  it("writes the confirmed soul", async () => {
    const env = makeEnv();

    const response = await applySoul(env, confirmed, auth);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok", scopeId: "g1" });
    const [row] = await soulRows(env.DB);
    expect(row).toMatchObject({
      scope_id: "g1",
      content: "Be calm and precise.",
      updated_by: "u9",
    });
  });

  it("passes handler refusals through as error statuses", async () => {
    const env = makeEnv();

    const response = await applySoul(
      env,
      JSON.stringify({ proposal: { ...proposal, scopeId: "dm" }, updatedBy: "u9" }),
      auth,
    );

    expect(await response.json()).toEqual({ status: "error", code: "invalid_scope" });
    expect(await soulRows(env.DB)).toEqual([]);
  });
});
