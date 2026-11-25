import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_USER_MEMORY_ENTRIES } from "../src/db";
import { handleMemory } from "../src/memory";
import worker from "../src/index";
import { createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

type MemoryRow = { category: string; key: string; value: string };

async function memoriesOf(db: D1Database, userId: string): Promise<MemoryRow[]> {
  const { results } = await db
    .prepare(
      "SELECT category, key, value FROM user_memory WHERE user_id = ?1 ORDER BY category, key",
    )
    .bind(userId)
    .all<MemoryRow>();
  return results ?? [];
}

/** Fill a user's fact and preference entries up to `count` rows in total. */
async function seedEntries(db: D1Database, userId: string, count: number): Promise<void> {
  const insert = db.prepare(
    `INSERT INTO user_memory (user_id, category, key, value, created_at, updated_at)
     VALUES (?1, ?2, ?3, 'v', 0, 0)`,
  );
  for (let i = 0; i < count; i++) {
    const category = i % 2 === 0 ? "fact" : "preference";
    await insert.bind(userId, category, `k${i}`).run();
  }
}

/** POST a memory command to the route the slash commands use. */
async function postMemory(
  env: Env,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request("https://worker/internal/v1/memory", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
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

describe("handleMemory set", () => {
  const setPreference = {
    op: "set",
    userId: "u1",
    category: "preference",
    key: "reply style",
    value: "简短",
  } as const;

  it("sets a preference and returns the user's memory afterwards", async () => {
    const db = createTestD1();

    const response = await handleMemory(db, setPreference);

    expect(response).toEqual({
      status: "ok",
      memories: [
        {
          category: "preference",
          key: "reply style",
          value: "简短",
          updatedAt: expect.any(Number),
        },
      ],
    });
    expect(await memoriesOf(db, "u1")).toEqual([
      { category: "preference", key: "reply style", value: "简短" },
    ]);
  });

  it("answers memory_full for a new preference past the cap, and still updates an existing one", async () => {
    const db = createTestD1();
    await seedEntries(db, "u1", MAX_USER_MEMORY_ENTRIES);

    const refused = await handleMemory(db, { ...setPreference, key: "new" });
    const updated = await handleMemory(db, { ...setPreference, key: "k1", value: "updated" });

    expect(refused).toEqual({ status: "error", code: "memory_full" });
    expect(updated.status).toBe("ok");
    expect(await memoriesOf(db, "u1")).toHaveLength(MAX_USER_MEMORY_ENTRIES);
    expect(await memoriesOf(db, "u1")).toContainEqual({
      category: "preference",
      key: "k1",
      value: "updated",
    });
  });

  it("keeps /persona set outside the cap, since persona entries do not count toward it", async () => {
    const db = createTestD1();
    await seedEntries(db, "u1", MAX_USER_MEMORY_ENTRIES);

    const response = await handleMemory(db, {
      ...setPreference,
      category: "persona",
      key: "style",
      value: "concise",
    });

    expect(response.status).toBe("ok");
    expect(await memoriesOf(db, "u1")).toHaveLength(MAX_USER_MEMORY_ENTRIES + 1);
    // The slot the persona row took is not a capped one.
    expect(await handleMemory(db, { ...setPreference, key: "new" })).toEqual({
      status: "error",
      code: "memory_full",
    });
  });
});

describe("POST /internal/v1/memory", () => {
  function makeEnv(): Env {
    return { DB: createTestD1(), INTERNAL_API_TOKEN: TOKEN } as Env;
  }

  const auth = { Authorization: `Bearer ${TOKEN}` };
  const setPreference = { op: "set", userId: "u1", category: "preference", key: "new", value: "v" };

  it("rejects requests without a valid bearer token", async () => {
    const env = makeEnv();

    expect((await postMemory(env, setPreference)).status).toBe(401);
    expect((await postMemory(env, setPreference, { Authorization: "Bearer nope" })).status).toBe(
      401,
    );
    expect(await memoriesOf(env.DB, "u1")).toEqual([]);
  });

  it("answers memory_full from the route when /preference set hits the cap", async () => {
    const env = makeEnv();
    await seedEntries(env.DB, "u1", MAX_USER_MEMORY_ENTRIES);

    const response = await postMemory(env, setPreference, auth);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "error", code: "memory_full" });
    expect(await memoriesOf(env.DB, "u1")).toHaveLength(MAX_USER_MEMORY_ENTRIES);
  });

  it("stores a preference below the cap", async () => {
    const env = makeEnv();

    const response = await postMemory(env, setPreference, auth);

    expect(response.status).toBe(200);
    expect(await memoriesOf(env.DB, "u1")).toEqual([
      { category: "preference", key: "new", value: "v" },
    ]);
  });
});
