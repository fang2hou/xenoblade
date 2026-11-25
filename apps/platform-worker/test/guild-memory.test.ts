import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { GuildMemoryCategory, GuildMemoryProposal } from "@xenoblade/contracts";

import {
  clearGuildMemory,
  clearUserMemory,
  getGuildMemory,
  MAX_GUILD_MEMORY_ENTRIES,
  MAX_USER_MEMORY_ENTRIES,
  setGuildMemory,
  setUserMemoryWithinCap,
} from "../src/db";
import {
  extractGuildMemoryProposals,
  handleGuildMemoryApply,
  MAX_MEMORY_KEY_CHARS,
  MAX_MEMORY_VALUE_CHARS,
  normalizeMemoryKey,
  normalizeMemoryValue,
} from "../src/memory";
import worker from "../src/index";
import { createFailingD1, createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

const SAVE: GuildMemoryProposal = {
  id: "p1",
  scope: "guild",
  guildId: "g1",
  action: "save",
  category: "fact",
  key: "release day",
  value: "Fridays",
};

const DELETE: GuildMemoryProposal = {
  id: "p2",
  scope: "guild",
  guildId: "g1",
  action: "delete",
  category: "preference",
  key: "tone",
};

const CONFIRMED = { proposals: [SAVE, DELETE], updatedBy: "u9" };

type GuildRow = {
  guild_id: string;
  category: string;
  key: string;
  value: string;
  updated_by: string | null;
  created_at: number;
  updated_at: number;
};

async function rows(db: D1Database): Promise<GuildRow[]> {
  const { results } = await db
    .prepare(
      `SELECT guild_id, category, key, value, updated_by, created_at, updated_at
       FROM guild_memory ORDER BY guild_id, category, key`,
    )
    .all<GuildRow>();
  return results ?? [];
}

/** Insert `count` fact entries for a guild straight into the table. */
async function seedGuild(db: D1Database, guildId: string, count: number): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO guild_memory (guild_id, category, key, value, updated_by, created_at, updated_at)
     VALUES (?1, 'fact', ?2, 'v', NULL, 0, 0)`,
  );
  for (let i = 0; i < count; i++) {
    await insert.bind(guildId, `k${i}`).run();
  }
}

/** Insert `count` entries for a user straight into the table. */
async function seedUser(
  db: D1Database,
  userId: string,
  count: number,
  category: GuildMemoryCategory | "persona" = "fact",
): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO user_memory (user_id, category, key, value, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'v', 0, 0)`,
  );
  for (let i = 0; i < count; i++) {
    await insert.bind(userId, category, `k${i}`).run();
  }
}

/** Number of memory rows a user holds. */
async function userEntryCount(db: D1Database, userId: string): Promise<number> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM user_memory WHERE user_id = ?1")
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** POST a raw body to the apply route, as the Runtime would. */
async function postApply(
  env: Env,
  body: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request("https://worker/internal/v1/memory/guild/apply", {
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

describe("getGuildMemory", () => {
  it("returns nothing for a guild without shared memory", async () => {
    expect(await getGuildMemory(createTestD1(), "g1")).toEqual([]);
  });

  it("returns a guild's entries newest first, and only that guild's", async () => {
    const db = createTestD1();
    await setGuildMemory(db, { guildId: "g1", category: "fact", key: "a", value: "1", now: 1 });
    await setGuildMemory(db, { guildId: "g1", category: "fact", key: "b", value: "2", now: 3 });
    await setGuildMemory(db, { guildId: "g2", category: "fact", key: "c", value: "3", now: 2 });

    expect(await getGuildMemory(db, "g1")).toEqual([
      { category: "fact", key: "b", value: "2", updatedAt: 3 },
      { category: "fact", key: "a", value: "1", updatedAt: 1 },
    ]);
    expect(await getGuildMemory(db, "g2")).toEqual([
      { category: "fact", key: "c", value: "3", updatedAt: 2 },
    ]);
  });

  it("reads the DM scope as empty without touching the table", async () => {
    expect(await getGuildMemory(createFailingD1(), "dm")).toEqual([]);
    expect(console.log).not.toHaveBeenCalled();
  });

  it("falls back to no shared memory when the table cannot be read", async () => {
    expect(await getGuildMemory(createFailingD1(), "g1")).toEqual([]);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("guild_memory_read_error"));
  });
});

describe("setGuildMemory", () => {
  it("stores who changed what and when, and upserts the next change", async () => {
    const db = createTestD1();
    await setGuildMemory(db, {
      guildId: "g1",
      category: "fact",
      key: "release day",
      value: "Tuesdays",
      updatedBy: "u1",
      now: 1_000,
    });
    const outcome = await setGuildMemory(db, {
      guildId: "g1",
      category: "fact",
      key: "release day",
      value: "Fridays",
      updatedBy: "u2",
      now: 2_000,
    });

    expect(outcome).toBe("saved");
    expect(await rows(db)).toEqual([
      {
        guild_id: "g1",
        category: "fact",
        key: "release day",
        value: "Fridays",
        updated_by: "u2",
        created_at: 1_000,
        updated_at: 2_000,
      },
    ]);
  });

  it("keeps one guild's entries apart from another's", async () => {
    const db = createTestD1();
    await setGuildMemory(db, { guildId: "g1", category: "fact", key: "a", value: "1", now: 1 });
    await setGuildMemory(db, { guildId: "g2", category: "fact", key: "a", value: "2", now: 1 });

    expect(await rows(db)).toEqual([
      expect.objectContaining({ guild_id: "g1", value: "1" }),
      expect.objectContaining({ guild_id: "g2", value: "2" }),
    ]);
  });

  it("refuses a new entry at the cap, while an existing entry still updates", async () => {
    const db = createTestD1();
    await seedGuild(db, "g1", MAX_GUILD_MEMORY_ENTRIES);

    const refused = await setGuildMemory(db, {
      guildId: "g1",
      category: "preference",
      key: "new",
      value: "v",
      now: 1,
    });
    const updated = await setGuildMemory(db, {
      guildId: "g1",
      category: "fact",
      key: "k0",
      value: "updated",
      now: 2,
    });

    expect(refused).toBe("memory_full");
    expect(updated).toBe("saved");
    expect(await rows(db)).toHaveLength(MAX_GUILD_MEMORY_ENTRIES);
    expect(await rows(db)).toContainEqual(
      expect.objectContaining({ key: "k0", value: "updated", updated_at: 2 }),
    );
  });

  it("counts the cap per guild", async () => {
    const db = createTestD1();
    await seedGuild(db, "g1", MAX_GUILD_MEMORY_ENTRIES);

    expect(
      await setGuildMemory(db, { guildId: "g2", category: "fact", key: "new", value: "v", now: 1 }),
    ).toBe("saved");
  });
});

describe("clearGuildMemory", () => {
  it("deletes the key from both categories, and only for that guild", async () => {
    const db = createTestD1();
    for (const guildId of ["g1", "g2"]) {
      for (const category of ["fact", "preference"] as const) {
        await setGuildMemory(db, { guildId, category, key: "tone", value: "v", now: 1 });
      }
    }

    expect(await clearGuildMemory(db, { guildId: "g1", key: "tone" })).toBe(2);
    expect(await rows(db)).toEqual([
      expect.objectContaining({ guild_id: "g2", category: "fact" }),
      expect.objectContaining({ guild_id: "g2", category: "preference" }),
    ]);
  });

  it("restricts the deletion to one category", async () => {
    const db = createTestD1();
    for (const category of ["fact", "preference"] as const) {
      await setGuildMemory(db, { guildId: "g1", category, key: "tone", value: "v", now: 1 });
    }

    expect(await clearGuildMemory(db, { guildId: "g1", category: "fact", key: "tone" })).toBe(1);
    expect(await rows(db)).toEqual([expect.objectContaining({ category: "preference" })]);
  });

  it("reports zero when nothing matched", async () => {
    expect(await clearGuildMemory(createTestD1(), { guildId: "g1", key: "ghost" })).toBe(0);
  });
});

describe("setUserMemoryWithinCap", () => {
  it("saves a new entry and updates it in place", async () => {
    const db = createTestD1();
    const entry = { userId: "u1", category: "fact" as const, key: "pet" };

    expect(await setUserMemoryWithinCap(db, { ...entry, value: "cat" })).toBe("saved");
    expect(await setUserMemoryWithinCap(db, { ...entry, value: "dog" })).toBe("saved");

    const { results } = await db
      .prepare("SELECT key, value FROM user_memory WHERE user_id = 'u1'")
      .all<{ key: string; value: string }>();
    expect(results).toEqual([{ key: "pet", value: "dog" }]);
  });

  it("refuses a new entry at the cap, while an existing entry still updates", async () => {
    const db = createTestD1();
    await seedUser(db, "u1", MAX_USER_MEMORY_ENTRIES - 10);
    await seedUser(db, "u1", 10, "preference");

    expect(
      await setUserMemoryWithinCap(db, { userId: "u1", category: "fact", key: "new", value: "v" }),
    ).toBe("memory_full");
    expect(
      await setUserMemoryWithinCap(db, {
        userId: "u1",
        category: "preference",
        key: "k0",
        value: "updated",
      }),
    ).toBe("saved");

    expect(await userEntryCount(db, "u1")).toBe(MAX_USER_MEMORY_ENTRIES);
  });

  it("does not count persona entries toward the cap", async () => {
    const db = createTestD1();
    await seedUser(db, "u1", MAX_USER_MEMORY_ENTRIES);
    await seedUser(db, "u1", 1, "persona");
    // One slot is free for a fact or preference, even though the user holds
    // MAX_USER_MEMORY_ENTRIES rows besides it.
    await clearUserMemory(db, { userId: "u1", category: "fact", key: "k0" });

    expect(
      await setUserMemoryWithinCap(db, { userId: "u1", category: "fact", key: "new", value: "v" }),
    ).toBe("saved");
    expect(await userEntryCount(db, "u1")).toBe(MAX_USER_MEMORY_ENTRIES + 1);
  });

  it("counts the cap per user", async () => {
    const db = createTestD1();
    await seedUser(db, "u1", MAX_USER_MEMORY_ENTRIES);

    expect(
      await setUserMemoryWithinCap(db, { userId: "u2", category: "fact", key: "new", value: "v" }),
    ).toBe("saved");
  });
});

describe("memory normalization", () => {
  it("trims, and treats whitespace-only input as empty", () => {
    expect(normalizeMemoryKey("  pet \n")).toBe("pet");
    expect(normalizeMemoryKey(" \n\t ")).toBeNull();
    expect(normalizeMemoryValue("  Likes tea. ")).toBe("Likes tea.");
    expect(normalizeMemoryValue("\n")).toBeNull();
  });

  it("clamps to the caps counting code points, not UTF-16 units", () => {
    expect(normalizeMemoryKey("字".repeat(MAX_MEMORY_KEY_CHARS + 5))).toBe(
      "字".repeat(MAX_MEMORY_KEY_CHARS),
    );
    // Astral characters such as emoji take two UTF-16 units each.
    expect(
      Array.from(normalizeMemoryKey("😀".repeat(MAX_MEMORY_KEY_CHARS + 5)) ?? ""),
    ).toHaveLength(MAX_MEMORY_KEY_CHARS);
    expect(Array.from(normalizeMemoryValue("字😀".repeat(400)) ?? "")).toHaveLength(
      MAX_MEMORY_VALUE_CHARS,
    );
  });

  it("leaves already-normalized text unchanged, interior whitespace included", () => {
    const key = "release day";
    const value = "Ship on Fridays,\nnot Tuesdays.";
    expect(normalizeMemoryKey(key)).toBe(key);
    expect(normalizeMemoryValue(value)).toBe(value);
  });

  it("stays idempotent when the cut lands right after inner whitespace", () => {
    // The 64th / 500th code point is whitespace: the cut must not leave it trailing.
    const key = `${"k".repeat(MAX_MEMORY_KEY_CHARS - 1)} \t tail`;
    const value = `${"v".repeat(MAX_MEMORY_VALUE_CHARS - 1)} \n tail`;
    const normalizedKey = normalizeMemoryKey(key);
    const normalizedValue = normalizeMemoryValue(value);

    expect(normalizedKey).toBe("k".repeat(MAX_MEMORY_KEY_CHARS - 1));
    expect(normalizedValue).toBe("v".repeat(MAX_MEMORY_VALUE_CHARS - 1));
    expect(normalizeMemoryKey(normalizedKey ?? "")).toBe(normalizedKey);
    expect(normalizeMemoryValue(normalizedValue ?? "")).toBe(normalizedValue);
  });

  it("reaches its fixed point in one pass, whatever it is given", () => {
    const inputs = [
      "  padded  ",
      "a\n\nb  ",
      "\t\n",
      "字 ".repeat(300),
      `${"x".repeat(600)} `,
      `${"😀".repeat(520)} end `,
      " \u00a0 ",
    ];
    for (const normalize of [normalizeMemoryKey, normalizeMemoryValue]) {
      for (const input of inputs) {
        const once = normalize(input);
        if (once === null) continue;
        expect(normalize(once)).toBe(once);
      }
    }
  });
});

describe("extractGuildMemoryProposals", () => {
  it("collects proposed guild saves and deletes in order and skips everything else", () => {
    const proposals = extractGuildMemoryProposals([
      { toolName: "web_search", output: { results: [] } },
      { toolName: "memory_save", output: { status: "proposed", proposal: SAVE } },
      {
        toolName: "memory_save",
        output: { status: "saved", scope: "user", category: "fact", key: "pet", value: "cat" },
      },
      { toolName: "memory_delete", output: { status: "proposed", proposal: DELETE } },
      { toolName: "memory_delete", output: { status: "not_found", scope: "user", key: "x" } },
      { toolName: "memory_save", output: { status: "rejected", reason: "dm_not_allowed" } },
      { toolName: "memory_save", output: { status: "proposed", proposal: { id: "p9" } } },
      {
        toolName: "memory_save",
        output: { status: "proposed", proposal: { ...SAVE, scope: "user" } },
      },
      { toolName: "memory_save", output: { status: "proposed", proposal: { ...SAVE, key: "" } } },
      { toolName: "memory_save", output: { status: "proposed", proposal: { ...SAVE, value: 7 } } },
      {
        toolName: "memory_delete",
        output: { status: "proposed", proposal: { ...DELETE, category: "persona" } },
      },
    ]);
    expect(proposals).toEqual([SAVE, DELETE]);
  });

  it("tolerates missing outputs", () => {
    expect(extractGuildMemoryProposals([{ toolName: "memory_save" }])).toEqual([]);
    expect(extractGuildMemoryProposals([])).toEqual([]);
  });
});

describe("handleGuildMemoryApply", () => {
  it("executes confirmed saves and deletes, records who confirmed, and answers per proposal", async () => {
    const db = createTestD1();
    await setGuildMemory(db, {
      guildId: "g1",
      category: "preference",
      key: "tone",
      value: "old",
      now: 1,
    });

    const response = await handleGuildMemoryApply(db, CONFIRMED);

    expect(response).toEqual({
      status: "ok",
      results: [
        { id: "p1", ok: true },
        { id: "p2", ok: true },
      ],
    });
    const [row] = await rows(db);
    expect(row).toMatchObject({
      guild_id: "g1",
      category: "fact",
      key: "release day",
      value: "Fridays",
      updated_by: "u9",
    });
    expect(row?.updated_at).toBeGreaterThan(0);
  });

  it("refuses the DM scope", async () => {
    const db = createTestD1();

    expect(
      await handleGuildMemoryApply(db, {
        updatedBy: "u9",
        proposals: [
          { ...SAVE, guildId: "dm" },
          { ...DELETE, guildId: "dm" },
        ],
      }),
    ).toEqual({
      status: "ok",
      results: [
        { id: "p1", ok: false, code: "dm_not_allowed" },
        { id: "p2", ok: false, code: "dm_not_allowed" },
      ],
    });
    expect(await rows(db)).toEqual([]);
  });

  it("refuses a key or value that is not in the normalized form the card showed", async () => {
    const db = createTestD1();
    const fullKey = "k".repeat(MAX_MEMORY_KEY_CHARS);
    const fullValue = "v".repeat(MAX_MEMORY_VALUE_CHARS);
    const refused: Array<[GuildMemoryProposal, string]> = [
      [{ ...SAVE, key: " padded " }, "invalid_key"],
      [{ ...SAVE, key: `${fullKey}k` }, "invalid_key"],
      [{ ...SAVE, key: "line\n" }, "invalid_key"],
      [{ ...DELETE, key: " padded " }, "invalid_key"],
      [{ ...SAVE, value: " padded " }, "invalid_value"],
      [{ ...SAVE, value: `${fullValue}v` }, "invalid_value"],
      [{ ...SAVE, value: "Fridays\n\n" }, "invalid_value"],
    ];

    for (const [proposal, code] of refused) {
      expect(await handleGuildMemoryApply(db, { updatedBy: "u9", proposals: [proposal] })).toEqual({
        status: "ok",
        results: [{ id: proposal.id, ok: false, code }],
      });
    }
    expect(await rows(db)).toEqual([]);
  });

  it("accepts a key and a value that are exactly at the caps", async () => {
    const db = createTestD1();
    const key = "😀".repeat(MAX_MEMORY_KEY_CHARS);
    const value = "字".repeat(MAX_MEMORY_VALUE_CHARS);

    expect(
      await handleGuildMemoryApply(db, {
        updatedBy: "u9",
        proposals: [{ ...SAVE, key, value }],
      }),
    ).toEqual({ status: "ok", results: [{ id: "p1", ok: true }] });
    expect(await rows(db)).toContainEqual(expect.objectContaining({ key, value }));
  });

  it("rejects a malformed request without touching the table", async () => {
    const db = createTestD1();
    for (const body of [
      null,
      "apply",
      [],
      {},
      { proposals: [SAVE] },
      { proposals: [SAVE], updatedBy: "" },
      { updatedBy: "u9" },
      { updatedBy: "u9", proposals: {} },
      { updatedBy: "u9", proposals: [SAVE, { id: "p2", action: "save", key: "k" }] },
      { updatedBy: "u9", proposals: [{ ...SAVE, category: "persona" }] },
      { updatedBy: "u9", proposals: [{ ...SAVE, action: "forget" }] },
      { updatedBy: "u9", proposals: [{ ...SAVE, value: undefined }] },
      { updatedBy: "u9", proposals: [{ ...SAVE, guildId: "" }] },
      { updatedBy: "u9", proposals: [{ ...DELETE, category: "persona" }] },
    ]) {
      expect(await handleGuildMemoryApply(db, body)).toEqual({
        status: "error",
        code: "invalid_body",
      });
    }
    expect(await rows(db)).toEqual([]);
  });

  it("flags a delete that matched nothing", async () => {
    const response = await handleGuildMemoryApply(createTestD1(), {
      ...CONFIRMED,
      proposals: [DELETE],
    });
    expect(response).toEqual({
      status: "ok",
      results: [{ id: "p2", ok: true, code: "not_found" }],
    });
  });

  it("refuses a new entry at the cap with memory_full, and still runs the rest of the batch", async () => {
    const db = createTestD1();
    await seedGuild(db, "g1", MAX_GUILD_MEMORY_ENTRIES);

    const response = await handleGuildMemoryApply(db, {
      updatedBy: "u9",
      proposals: [SAVE, { ...DELETE, category: undefined }, { ...SAVE, id: "p3", key: "k0" }],
    });

    expect(response).toEqual({
      status: "ok",
      results: [
        { id: "p1", ok: false, code: "memory_full" },
        { id: "p2", ok: true, code: "not_found" },
        { id: "p3", ok: true },
      ],
    });
    expect(await rows(db)).toHaveLength(MAX_GUILD_MEMORY_ENTRIES);
  });

  it("treats two saves of one new key at the last slot as one insert", async () => {
    const db = createTestD1();
    await seedGuild(db, "g1", MAX_GUILD_MEMORY_ENTRIES - 1);

    const response = await handleGuildMemoryApply(db, {
      updatedBy: "u9",
      proposals: [SAVE, { ...SAVE, value: "Saturdays" }],
    });

    expect(response).toEqual({
      status: "ok",
      results: [
        { id: "p1", ok: true },
        { id: "p1", ok: true },
      ],
    });
    expect(await rows(db)).toHaveLength(MAX_GUILD_MEMORY_ENTRIES);
    expect(await rows(db)).toContainEqual(expect.objectContaining({ value: "Saturdays" }));
  });

  it("reports failed writes instead of throwing", async () => {
    expect(await handleGuildMemoryApply(createFailingD1(), CONFIRMED)).toEqual({
      status: "ok",
      results: [
        { id: "p1", ok: false, code: "memory_op_failed" },
        { id: "p2", ok: false, code: "memory_op_failed" },
      ],
    });
  });
});

describe("POST /internal/v1/memory/guild/apply", () => {
  function makeEnv(): Env {
    return { DB: createTestD1(), INTERNAL_API_TOKEN: TOKEN } as Env;
  }

  const auth = { Authorization: `Bearer ${TOKEN}` };

  it("rejects requests without a valid bearer token", async () => {
    const env = makeEnv();
    expect((await postApply(env, JSON.stringify(CONFIRMED))).status).toBe(401);
    expect(
      (await postApply(env, JSON.stringify(CONFIRMED), { Authorization: "Bearer nope" })).status,
    ).toBe(401);
    expect(await rows(env.DB)).toEqual([]);
  });

  it("returns 400 for a body that is not JSON", async () => {
    const response = await postApply(makeEnv(), "{not json", auth);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "invalid_body" });
  });

  it("writes the confirmed proposals", async () => {
    const env = makeEnv();

    const response = await postApply(env, JSON.stringify(CONFIRMED), auth);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "ok",
      results: [
        { id: "p1", ok: true },
        { id: "p2", ok: true, code: "not_found" },
      ],
    });
    expect(await rows(env.DB)).toEqual([
      expect.objectContaining({
        guild_id: "g1",
        key: "release day",
        value: "Fridays",
        updated_by: "u9",
      }),
    ]);
  });

  it("passes refusals through as per-proposal results", async () => {
    const env = makeEnv();
    const body = JSON.stringify({ ...CONFIRMED, proposals: [{ ...SAVE, guildId: "dm" }] });

    const response = await postApply(env, body, auth);

    expect(await response.json()).toEqual({
      status: "ok",
      results: [{ id: "p1", ok: false, code: "dm_not_allowed" }],
    });
    expect(await rows(env.DB)).toEqual([]);
  });
});
