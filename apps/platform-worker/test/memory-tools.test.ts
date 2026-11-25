import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExecutionOptions } from "ai";

import { setGuildMemory, setUserMemory, MAX_USER_MEMORY_ENTRIES } from "../src/db";
import {
  handleGuildMemoryApply,
  MAX_MEMORY_KEY_CHARS,
  MAX_MEMORY_VALUE_CHARS,
} from "../src/memory";
import {
  createMemoryTools,
  type MemoryDeleteOutput,
  type MemoryEntry,
  type MemoryListOutput,
  type MemorySaveOutput,
  type MemoryToolContext,
} from "../src/tools/memory-tools";
import { createFailingD1, createTestD1 } from "./helpers/d1";

/** Execution options the way the SDK passes them; the memory tools read none. */
const EXECUTION: ToolExecutionOptions<Record<string, unknown>> = {
  toolCallId: "call-1",
  messages: [],
  context: {},
};

type ToolName = "memory_list" | "memory_save" | "memory_delete";

/** Run one memory tool for a user in a scope; it answers with one plain object. */
function run<T>(name: ToolName, input: object, context: MemoryToolContext): Promise<T> {
  const memoryTool = createMemoryTools(context)[name];
  if (memoryTool?.execute === undefined) throw new Error(`${name} has no execute`);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test helper: the caller names the output type it reads
  return memoryTool.execute(input, EXECUTION) as Promise<T>;
}

/** The triggering user in a guild, each call against a fresh database. */
function guildContext(db = createTestD1()): MemoryToolContext {
  return { db, userId: "u1", scopeId: "g1" };
}

/** The triggering user in a DM, each call against a fresh database. */
function dmContext(): MemoryToolContext {
  return { db: createTestD1(), userId: "u1", scopeId: "dm" };
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

async function guildMemoryCount(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT COUNT(*) AS n FROM guild_memory").first<{ n: number }>();
  return row?.n ?? 0;
}

async function userMemoryOf(db: D1Database, userId: string): Promise<MemoryEntry[]> {
  const { results } = await db
    .prepare(
      "SELECT category, key, value FROM user_memory WHERE user_id = ?1 ORDER BY category, key",
    )
    .bind(userId)
    .all<{ category: MemoryEntry["category"]; key: string; value: string }>();
  return (results ?? []).map((row) => ({ scope: "user", ...row }));
}

/** Insert one personal memory row straight into the table, with an explicit timestamp. */
async function insertUserMemory(
  db: D1Database,
  userId: string,
  category: MemoryEntry["category"],
  key: string,
  value: string,
  updatedAt: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_memory (user_id, category, key, value, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?5)`,
    )
    .bind(userId, category, key, value, updatedAt)
    .run();
}

/**
 * The personal and shared memory a guild run starts from: u1 owns a fact and
 * a persona, u2 owns a fact of their own, and g1 shares two entries. Personal
 * entries carry explicit timestamps so "newest first" is not a tie.
 */
async function seededContext(db = createTestD1()): Promise<MemoryToolContext> {
  const context = guildContext(db);
  await insertUserMemory(db, "u1", "fact", "pet", "cat", 2);
  await insertUserMemory(db, "u1", "persona", "style", "concise", 1);
  await insertUserMemory(db, "u2", "fact", "secret", "not yours", 1);
  await setGuildMemory(db, {
    guildId: "g1",
    category: "fact",
    key: "release day",
    value: "Fridays",
    now: 2,
  });
  await setGuildMemory(db, {
    guildId: "g1",
    category: "preference",
    key: "language",
    value: "Chinese",
    now: 1,
  });
  return context;
}

/** Fill a user's personal memory to the cap with seeded fact entries. */
async function fillToCap(db: D1Database, userId: string): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO user_memory (user_id, category, key, value, created_at, updated_at)
     VALUES (?1, 'fact', ?2, 'v', 0, 0)`,
  );
  for (let i = 0; i < MAX_USER_MEMORY_ENTRIES; i++) {
    await insert.bind(userId, `k${i}`).run();
  }
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("memory_list", () => {
  it("lists the triggering user's own memory and the guild's shared memory, nobody else's", async () => {
    const { db, queries } = recordingDb();

    const output = await run<MemoryListOutput>("memory_list", {}, await seededContext(db));

    expect(output).toEqual({
      status: "ok",
      memories: [
        // Personal memory, newest first, persona included.
        { scope: "user", category: "fact", key: "pet", value: "cat" },
        { scope: "user", category: "persona", key: "style", value: "concise" },
        // Shared memory, newest first.
        { scope: "guild", category: "fact", key: "release day", value: "Fridays" },
        { scope: "guild", category: "preference", key: "language", value: "Chinese" },
      ],
    });
    // A guild run does read the shared table; the DM case below is measured against this.
    expect(queries.some((query) => query.includes("guild_memory"))).toBe(true);
  });

  it("filters by scope", async () => {
    const context = await seededContext();

    const user = await run<MemoryListOutput>("memory_list", { scope: "user" }, context);
    const guild = await run<MemoryListOutput>("memory_list", { scope: "guild" }, context);

    expect(user).toEqual({
      status: "ok",
      memories: [
        { scope: "user", category: "fact", key: "pet", value: "cat" },
        { scope: "user", category: "persona", key: "style", value: "concise" },
      ],
    });
    expect(guild).toEqual({
      status: "ok",
      memories: [
        { scope: "guild", category: "fact", key: "release day", value: "Fridays" },
        { scope: "guild", category: "preference", key: "language", value: "Chinese" },
      ],
    });
  });

  it("returns an empty list when nothing is stored", async () => {
    expect(await run<MemoryListOutput>("memory_list", {}, guildContext())).toEqual({
      status: "ok",
      memories: [],
    });
  });

  it("never reads shared memory in a DM", async () => {
    const { db, queries } = recordingDb();
    const dm: MemoryToolContext = { db, userId: "u1", scopeId: "dm" };
    await setUserMemory(db, { userId: "u1", category: "fact", key: "pet", value: "cat" });
    await setGuildMemory(db, {
      guildId: "g1",
      category: "fact",
      key: "release day",
      value: "Fridays",
      now: 1,
    });
    queries.length = 0;

    const all = await run<MemoryListOutput>("memory_list", {}, dm);
    const guild = await run<MemoryListOutput>("memory_list", { scope: "guild" }, dm);

    expect(all).toEqual({
      status: "ok",
      memories: [{ scope: "user", category: "fact", key: "pet", value: "cat" }],
    });
    expect(guild).toEqual({ status: "rejected", reason: "dm_not_allowed" });
    // The user's own memory was read; the shared table was never queried.
    expect(queries.some((query) => query.includes("user_memory"))).toBe(true);
    expect(queries.some((query) => query.includes("guild_memory"))).toBe(false);
  });
});

describe("memory_save: scope user", () => {
  it("saves at once for the triggering user and reports the stored entry", async () => {
    const context = guildContext();

    const output = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "user", key: "favorite language", value: "Rust" },
      context,
    );

    expect(output).toEqual({
      status: "saved",
      scope: "user",
      category: "fact",
      key: "favorite language",
      value: "Rust",
    });
    expect(await userMemoryOf(context.db, "u1")).toEqual([
      { scope: "user", category: "fact", key: "favorite language", value: "Rust" },
    ]);
    expect(await userMemoryOf(context.db, "u2")).toEqual([]);
    expect(await guildMemoryCount(context.db)).toBe(0);
  });

  it("updates an existing entry in place, under its category", async () => {
    const context = guildContext();
    await run("memory_save", { scope: "user", key: "lang", value: "Rust" }, context);
    await run(
      "memory_save",
      { scope: "user", key: "lang", value: "TypeScript", category: "preference" },
      context,
    );

    const output = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "user", key: "lang", value: "Go", category: "preference" },
      context,
    );

    expect(output).toMatchObject({
      status: "saved",
      category: "preference",
      key: "lang",
      value: "Go",
    });
    expect(await userMemoryOf(context.db, "u1")).toEqual([
      { scope: "user", category: "fact", key: "lang", value: "Rust" },
      { scope: "user", category: "preference", key: "lang", value: "Go" },
    ]);
  });

  it("normalizes the key and the value before storing them", async () => {
    const context = guildContext();
    const storedValue = "字".repeat(MAX_MEMORY_VALUE_CHARS);

    const output = await run<MemorySaveOutput>(
      "memory_save",
      {
        scope: "user",
        key: "\n  😀 favorite language ",
        value: ` ${storedValue}字`,
        category: "preference",
      },
      context,
    );

    expect(output).toEqual({
      status: "saved",
      scope: "user",
      category: "preference",
      key: "😀 favorite language",
      value: storedValue,
    });
    expect(await userMemoryOf(context.db, "u1")).toEqual([
      { scope: "user", category: "preference", key: "😀 favorite language", value: storedValue },
    ]);
  });

  it("refuses an empty key or value and stores nothing", async () => {
    const context = guildContext();

    expect(
      await run("memory_save", { scope: "user", key: "  \n", value: "Rust" }, context),
    ).toEqual({ status: "error", code: "empty_key" });
    expect(
      await run("memory_save", { scope: "user", key: "lang", value: " \t " }, context),
    ).toEqual({ status: "error", code: "empty_value" });
    expect(await userMemoryOf(context.db, "u1")).toEqual([]);
  });

  it("refuses a new entry past the user's cap with memory_full", async () => {
    const db = createTestD1();
    await fillToCap(db, "u1");
    const context = guildContext(db);

    const refused = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "user", key: "new", value: "v" },
      context,
    );
    const updated = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "user", key: "k0", value: "updated" },
      context,
    );

    expect(refused).toEqual({ status: "error", code: "memory_full" });
    expect(updated).toMatchObject({ status: "saved", key: "k0", value: "updated" });
    expect(await userMemoryOf(db, "u1")).toHaveLength(MAX_USER_MEMORY_ENTRIES);
  });

  it("counts the cap per user", async () => {
    const db = createTestD1();
    await fillToCap(db, "u2");
    const context = guildContext(db);

    expect(
      await run<MemorySaveOutput>(
        "memory_save",
        { scope: "user", key: "new", value: "v" },
        context,
      ),
    ).toMatchObject({ status: "saved", key: "new" });
  });

  it("saves personal memory from a DM too", async () => {
    const dm = dmContext();

    const output = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "user", key: "favorite language", value: "Rust" },
      dm,
    );

    expect(output.status).toBe("saved");
    expect(await userMemoryOf(dm.db, "u1")).toHaveLength(1);
  });

  it("reports a failed write as an error", async () => {
    const failing: MemoryToolContext = { db: createFailingD1(), userId: "u1", scopeId: "g1" };

    expect(
      await run("memory_save", { scope: "user", key: "lang", value: "Rust" }, failing),
    ).toEqual({ status: "error", code: "memory_save_failed" });
  });
});

describe("memory_save: scope guild", () => {
  it("proposes an entry for the guild and writes nothing", async () => {
    const context = guildContext();

    const output = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "guild", key: "release day", value: "Fridays", category: "preference" },
      context,
    );

    expect(output).toMatchObject({
      status: "proposed",
      proposal: {
        scope: "guild",
        guildId: "g1",
        action: "save",
        category: "preference",
        key: "release day",
        value: "Fridays",
      },
    });
    expect(await guildMemoryCount(context.db)).toBe(0);
  });

  it("gives every proposal its own id and defaults the category to fact", async () => {
    const first = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "guild", key: "a", value: "1" },
      guildContext(),
    );
    const second = await run<MemorySaveOutput>(
      "memory_save",
      { scope: "guild", key: "b", value: "2" },
      guildContext(),
    );

    expect(first.status).toBe("proposed");
    expect(second.status).toBe("proposed");
    if (first.status !== "proposed" || second.status !== "proposed") return;
    expect(first.proposal.category).toBe("fact");
    expect(first.proposal.id).not.toBe(second.proposal.id);
  });

  it("normalizes the proposal", async () => {
    const output = await run<MemorySaveOutput>(
      "memory_save",
      {
        scope: "guild",
        key: ` 字${"字".repeat(MAX_MEMORY_KEY_CHARS)}`,
        value: "\n  Ship on Fridays.\n\nKeep it.  ",
      },
      guildContext(),
    );

    expect(output.status).toBe("proposed");
    if (output.status !== "proposed") return;
    expect(Array.from(output.proposal.key)).toHaveLength(MAX_MEMORY_KEY_CHARS);
    expect(output.proposal.key.startsWith("字")).toBe(true);
    expect(output.proposal.value).toBe("Ship on Fridays.\n\nKeep it.");
  });

  it("is refused in a DM", async () => {
    const dm = dmContext();

    expect(
      await run("memory_save", { scope: "guild", key: "release day", value: "Fridays" }, dm),
    ).toEqual({ status: "rejected", reason: "dm_not_allowed" });
    expect(await guildMemoryCount(dm.db)).toBe(0);
  });

  it("refuses an empty key or value", async () => {
    expect(
      await run("memory_save", { scope: "guild", key: " ", value: "Fridays" }, guildContext()),
    ).toEqual({ status: "rejected", reason: "empty_key" });
    expect(
      await run("memory_save", { scope: "guild", key: "release day", value: " " }, guildContext()),
    ).toEqual({ status: "rejected", reason: "empty_value" });
  });

  it("proposes the exact bytes the confirmed apply stores", async () => {
    const context = await seededContext();
    const output = await run<MemorySaveOutput>(
      "memory_save",
      {
        scope: "guild",
        key: "  😀 release day ",
        value: " Ship on <@&123> @everyone.\n\n结论先行.  ",
      },
      context,
    );
    if (output.status !== "proposed") throw new Error("expected the save to be proposed");

    // The card lists the proposal as it comes back here; apply stores the same.
    expect(
      await handleGuildMemoryApply(context.db, { proposals: [output.proposal], updatedBy: "u1" }),
    ).toEqual({ status: "ok", results: [{ id: output.proposal.id, ok: true }] });
    const row = await context.db
      .prepare("SELECT key, value, updated_by FROM guild_memory WHERE guild_id = 'g1' AND key = ?1")
      .bind(output.proposal.key)
      .first<{ key: string; value: string; updated_by: string | null }>();
    expect(row).toEqual({
      key: "😀 release day",
      value: "Ship on <@&123> @everyone.\n\n结论先行.",
      updated_by: "u1",
    });
  });
});

describe("memory_delete: scope user", () => {
  /** u1 and u2 each hold the key under both categories; u1 holds one more entry. */
  async function sharedKey(): Promise<MemoryToolContext> {
    const context = guildContext();
    for (const userId of ["u1", "u2"]) {
      await setUserMemory(context.db, { userId, category: "fact", key: "lang", value: "Rust" });
      await setUserMemory(context.db, { userId, category: "preference", key: "lang", value: "Go" });
    }
    await setUserMemory(context.db, { userId: "u1", category: "fact", key: "pet", value: "cat" });
    return context;
  }

  it("deletes at once and reports how many entries went", async () => {
    const context = await sharedKey();

    const output = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "user", key: " lang " },
      context,
    );

    expect(output).toEqual({ status: "deleted", scope: "user", key: "lang", deletedCount: 2 });
    expect(await userMemoryOf(context.db, "u1")).toEqual([
      { scope: "user", category: "fact", key: "pet", value: "cat" },
    ]);
  });

  it("restricts the deletion to one category", async () => {
    const context = await sharedKey();

    const output = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "user", key: "lang", category: "fact" },
      context,
    );

    expect(output).toEqual({ status: "deleted", scope: "user", key: "lang", deletedCount: 1 });
    expect(await userMemoryOf(context.db, "u1")).toEqual([
      { scope: "user", category: "fact", key: "pet", value: "cat" },
      { scope: "user", category: "preference", key: "lang", value: "Go" },
    ]);
  });

  it("reaches only the triggering user's memory", async () => {
    const context = await sharedKey();

    await run("memory_delete", { scope: "user", key: "lang" }, context);

    expect(await userMemoryOf(context.db, "u2")).toEqual([
      { scope: "user", category: "fact", key: "lang", value: "Rust" },
      { scope: "user", category: "preference", key: "lang", value: "Go" },
    ]);
  });

  it("reports not_found when no entry had the key, changing nothing", async () => {
    const context = await sharedKey();
    const before = await userMemoryOf(context.db, "u1");

    const output = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "user", key: "ghost" },
      context,
    );

    expect(output).toEqual({ status: "not_found", scope: "user", key: "ghost", deletedCount: 0 });
    expect(await userMemoryOf(context.db, "u1")).toEqual(before);
  });

  it("refuses an empty key instead of clearing the user's memory", async () => {
    const context = await sharedKey();
    const before = await userMemoryOf(context.db, "u1");

    const output = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "user", key: " \n " },
      context,
    );

    expect(output).toEqual({ status: "error", code: "empty_key" });
    expect(await userMemoryOf(context.db, "u1")).toEqual(before);
  });

  it("deletes personal memory from a DM too", async () => {
    const dm = dmContext();
    await setUserMemory(dm.db, { userId: "u1", category: "fact", key: "pet", value: "cat" });

    const output = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "user", key: "pet" },
      dm,
    );

    expect(output).toEqual({ status: "deleted", scope: "user", key: "pet", deletedCount: 1 });
    expect(await userMemoryOf(dm.db, "u1")).toEqual([]);
  });

  it("reports a failed delete as an error", async () => {
    const failing: MemoryToolContext = { db: createFailingD1(), userId: "u1", scopeId: "g1" };

    expect(await run("memory_delete", { scope: "user", key: "lang" }, failing)).toEqual({
      status: "error",
      code: "memory_delete_failed",
    });
  });
});

describe("memory_delete: scope guild", () => {
  it("proposes the deletion and deletes nothing", async () => {
    const context = await seededContext();
    const before = await guildMemoryCount(context.db);

    const output = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "guild", key: " release day ", category: "fact" },
      context,
    );

    expect(output).toMatchObject({
      status: "proposed",
      proposal: {
        scope: "guild",
        guildId: "g1",
        action: "delete",
        category: "fact",
        key: "release day",
      },
    });
    expect(await guildMemoryCount(context.db)).toBe(before);
  });

  it("proposes a delete across both categories when no category is given", async () => {
    const output = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "guild", key: "tone" },
      guildContext(),
    );

    expect(output.status).toBe("proposed");
    if (output.status !== "proposed") return;
    expect(output.proposal).not.toHaveProperty("category");
    expect(Object.keys(output.proposal)).toEqual(["id", "scope", "guildId", "action", "key"]);
  });

  it("gives every proposal its own id", async () => {
    const first = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "guild", key: "a" },
      guildContext(),
    );
    const second = await run<MemoryDeleteOutput>(
      "memory_delete",
      { scope: "guild", key: "b" },
      guildContext(),
    );

    expect(first.status).toBe("proposed");
    expect(second.status).toBe("proposed");
    if (first.status !== "proposed" || second.status !== "proposed") return;
    expect(first.proposal.id).not.toBe(second.proposal.id);
  });

  it("is refused in a DM", async () => {
    expect(await run("memory_delete", { scope: "guild", key: "release day" }, dmContext())).toEqual(
      {
        status: "rejected",
        reason: "dm_not_allowed",
      },
    );
  });

  it("refuses an empty key", async () => {
    expect(await run("memory_delete", { scope: "guild", key: " " }, guildContext())).toEqual({
      status: "rejected",
      reason: "empty_key",
    });
  });
});
