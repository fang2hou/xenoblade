import { describe, expect, it, vi } from "vitest";

import worker from "../src/index";
import { getRuntimeConfig } from "../src/db";
import {
  addPendingCard,
  clearPendingCards,
  getLastTurn,
  getThreadSession,
  handleThreadState,
  recordLastReply,
  recordLastTurn,
  setThreadActive,
} from "../src/thread-sessions";
import { createFailingD1, createTestD1 } from "./helpers/d1";

const TOKEN = "test-internal-token";

const THREAD = {
  threadId: "t1",
  guildId: "g1",
  parentChannelId: "c1",
  createdBy: "u1",
};

/** The same thread id, asked for by a guild that did not register it. */
const OTHER_GUILD = { threadId: THREAD.threadId, guildId: "g2" };

const TURN = {
  containerId: "discord:g1:c1",
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

interface StoredSessionRow {
  thread_id: string;
  guild_id: string;
  parent_channel_id: string;
  created_by: string;
  active: number;
  pending_card_ids_json: string;
  created_at: number;
  updated_at: number;
}

/** The session row a test leaves behind, as SQLite holds it. */
async function storedSession(
  db: D1Database,
  threadId = THREAD.threadId,
): Promise<StoredSessionRow | null> {
  return db
    .prepare(
      `SELECT thread_id, guild_id, parent_channel_id, created_by, active, pending_card_ids_json,
              created_at, updated_at
       FROM thread_sessions WHERE thread_id = ?1`,
    )
    .bind(threadId)
    .first<StoredSessionRow>();
}

function makeEnv(db = createTestD1()): Env {
  return { DB: db, INTERNAL_API_TOKEN: TOKEN } as Env;
}

async function call(
  env: Env,
  route: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<Response> {
  const request = new Request(`https://worker/internal/v1${route}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return worker.fetch(
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridging undici Request to the workers-types signature
    request as unknown as Parameters<typeof worker.fetch>[0],
    env,
    {} as ExecutionContext,
  );
}

/** A guild's switch and channel allowlist, as an operator would have set them. */
async function configureGuild(
  db: D1Database,
  config: { enabled?: boolean; allow?: string[] | null },
) {
  await db
    .prepare(
      "INSERT INTO guild_config (guild_id, enabled, allow_channels_json) VALUES ('g1', ?1, ?2)",
    )
    .bind(config.enabled === false ? 0 : 1, JSON.stringify(config.allow ?? []))
    .run();
}

describe("migration 0010", () => {
  it("creates thread_sessions with its index and container_last_turns", async () => {
    const db = createTestD1();
    const { results } = await db
      .prepare("SELECT name, type FROM sqlite_master WHERE name IN (?, ?, ?) ORDER BY name")
      .bind("thread_sessions", "idx_thread_sessions_guild_active", "container_last_turns")
      .all<{ name: string; type: string }>();

    expect(results).toEqual([
      { name: "container_last_turns", type: "table" },
      { name: "idx_thread_sessions_guild_active", type: "index" },
      { name: "thread_sessions", type: "table" },
    ]);
  });

  it("starts a session followed, with no cards waiting", async () => {
    const db = createTestD1();
    await setThreadActive(db, THREAD, true, 1000);

    expect(await storedSession(db)).toMatchObject({ active: 1, pending_card_ids_json: "[]" });
  });

  it("rejects an active flag that is neither 0 nor 1", async () => {
    const db = createTestD1();
    await expect(
      db
        .prepare(
          `INSERT INTO thread_sessions (thread_id, guild_id, parent_channel_id, created_by, active, created_at, updated_at)
           VALUES ('t1', 'g1', 'c1', 'u1', 2, 1, 1)`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it("stores when each prompt was sent, and refuses a turn without that time", async () => {
    const db = createTestD1();

    await expect(
      db
        .prepare(
          `INSERT INTO container_last_turns
             (container_id, scope_id, channel_id, user_id, user_display_name,
              trigger_message_id, trigger_content, assistant_reply, updated_at)
           VALUES ('discord:g1:c1', 'g1', 'c1', 'u1', 'User', 'm1', 'q', 'a', 1)`,
        )
        .run(),
    ).rejects.toThrow();
  });
});

describe("handleThreadState", () => {
  it("answers null for a thread that was never registered", async () => {
    expect(
      await handleThreadState(createTestD1(), { op: "get", threadId: "t1", guildId: "g1" }),
    ).toEqual({
      status: "ok",
      session: null,
    });
  });

  it("registers a followed thread on upsert", async () => {
    const db = createTestD1();

    const response = await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);

    expect(response).toEqual({
      status: "ok",
      session: {
        threadId: "t1",
        guildId: "g1",
        parentChannelId: "c1",
        active: true,
        pendingCardIds: [],
      },
    });
    expect(await storedSession(db)).toMatchObject({
      created_by: "u1",
      active: 1,
      created_at: 1000,
      updated_at: 1000,
    });
  });

  it("sets a thread followed or unfollowed, and keeps its waiting cards", async () => {
    const db = createTestD1();
    await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);
    await handleThreadState(
      db,
      { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: "card-1" },
      1100,
    );

    const paused = await handleThreadState(
      db,
      { op: "set_active", ...THREAD, active: false },
      1200,
    );
    expect(paused).toMatchObject({ status: "ok", session: { active: false } });

    const resumed = await handleThreadState(
      db,
      { op: "set_active", ...THREAD, createdBy: "u2", active: true },
      1300,
    );
    expect(resumed).toEqual({
      status: "ok",
      session: {
        threadId: "t1",
        guildId: "g1",
        parentChannelId: "c1",
        active: true,
        pendingCardIds: ["card-1"],
      },
    });
    // Resuming does not rewrite who started the thread.
    expect(await storedSession(db)).toMatchObject({ created_by: "u1", updated_at: 1300 });
  });

  it("registers a thread on set_active when it has no session yet", async () => {
    const db = createTestD1();

    const response = await handleThreadState(
      db,
      {
        op: "set_active",
        threadId: "t9",
        guildId: "g1",
        parentChannelId: "c1",
        createdBy: "u1",
        active: true,
      },
      1000,
    );

    expect(response).toMatchObject({ status: "ok", session: { threadId: "t9", active: true } });
  });

  it("re-follows a paused thread on upsert without losing its cards", async () => {
    const db = createTestD1();
    await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);
    await handleThreadState(
      db,
      { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: "card-1" },
      1100,
    );
    await handleThreadState(db, { op: "set_active", ...THREAD, active: false }, 1200);

    const response = await handleThreadState(
      db,
      { op: "upsert", ...THREAD, createdBy: "u2" },
      1300,
    );

    expect(response).toMatchObject({
      status: "ok",
      session: { active: true, pendingCardIds: ["card-1"] },
    });
    expect(await storedSession(db)).toMatchObject({ created_by: "u1" });
  });

  it("appends cards in order and ignores a card already waiting", async () => {
    const db = createTestD1();
    await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);

    expect(
      await addPendingCard(db, {
        threadId: "t1",
        guildId: "g1",
        cardMessageId: "card-1",
        now: 1100,
      }),
    ).toBe(true);
    await addPendingCard(db, { threadId: "t1", guildId: "g1", cardMessageId: "card-2", now: 1200 });
    expect(
      await addPendingCard(db, {
        threadId: "t1",
        guildId: "g1",
        cardMessageId: "card-1",
        now: 1300,
      }),
    ).toBe(false);

    expect(await storedSession(db)).toMatchObject({
      pending_card_ids_json: '["card-1","card-2"]',
    });
  });

  it("stores no card for a thread without a session", async () => {
    const db = createTestD1();

    const response = await handleThreadState(
      db,
      { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: "card-1" },
      1000,
    );

    expect(response).toEqual({ status: "ok", session: null });
    expect(await storedSession(db)).toBeNull();
    expect(
      await clearPendingCards(db, {
        threadId: "t1",
        guildId: "g1",
        clearedIds: ["card-1"],
        now: 1000,
      }),
    ).toBe(false);
  });

  it("forgets only the cards it is told are gone, leaving the rest waiting", async () => {
    const db = createTestD1();
    await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);
    for (const card of ["card-1", "card-2", "card-3"]) {
      await handleThreadState(
        db,
        { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: card },
        1100,
      );
    }

    // The Runtime deleted two of the three; the third's delete failed.
    const response = await handleThreadState(
      db,
      { op: "clear_cards", threadId: "t1", guildId: "g1", clearedIds: ["card-1", "card-3"] },
      1200,
    );

    expect(response).toMatchObject({ status: "ok", session: { pendingCardIds: ["card-2"] } });
    expect(await storedSession(db)).toMatchObject({
      pending_card_ids_json: '["card-2"]',
      active: 1,
    });
  });

  it("forgets the last waiting card to an empty list", async () => {
    const db = createTestD1();
    await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);
    await handleThreadState(
      db,
      { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: "card-1" },
      1100,
    );

    const response = await handleThreadState(
      db,
      { op: "clear_cards", threadId: "t1", guildId: "g1", clearedIds: ["card-1"] },
      1200,
    );

    expect(response).toMatchObject({ status: "ok", session: { pendingCardIds: [] } });
    expect(await storedSession(db)).toMatchObject({ pending_card_ids_json: "[]", active: 1 });
  });

  it("changes nothing for cards the thread is not waiting on", async () => {
    const db = createTestD1();
    await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);
    await handleThreadState(
      db,
      { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: "card-1" },
      1100,
    );

    const response = await handleThreadState(
      db,
      { op: "clear_cards", threadId: "t1", guildId: "g1", clearedIds: ["never-posted"] },
      1200,
    );

    expect(response).toMatchObject({ status: "ok", session: { pendingCardIds: ["card-1"] } });
  });

  it.each([
    ["a body that is not an object", "nope"],
    ["a missing op", { threadId: "t1", guildId: "g1" }],
    ["an unknown op", { op: "delete", threadId: "t1", guildId: "g1" }],
    ["an empty thread id", { op: "get", threadId: "", guildId: "g1" }],
    ["a non-string thread id", { op: "get", threadId: 42, guildId: "g1" }],
    ["a missing guild", { op: "get", threadId: "t1" }],
    ["the DM scope, which owns no threads", { op: "get", threadId: "t1", guildId: "dm" }],
    [
      "an upsert without a parent channel",
      { op: "upsert", threadId: "t1", guildId: "g1", createdBy: "u1" },
    ],
    [
      "an upsert without a creating user",
      { op: "upsert", threadId: "t1", guildId: "g1", parentChannelId: "c1" },
    ],
    ["a set_active without a boolean flag", { op: "set_active", ...THREAD, active: "yes" }],
    ["an add_card without a card", { op: "add_card", threadId: "t1", guildId: "g1" }],
    [
      "a clear_cards without a thread id",
      { op: "clear_cards", guildId: "g1", clearedIds: ["card-1"] },
    ],
    [
      "a clear_cards without the cards to forget",
      { op: "clear_cards", threadId: "t1", guildId: "g1" },
    ],
    [
      "a clear_cards of no cards",
      { op: "clear_cards", threadId: "t1", guildId: "g1", clearedIds: [] },
    ],
    [
      "a clear_cards whose cards are not a list",
      { op: "clear_cards", threadId: "t1", guildId: "g1", clearedIds: "card-1" },
    ],
    [
      "a clear_cards naming a non-string card",
      { op: "clear_cards", threadId: "t1", guildId: "g1", clearedIds: [7] },
    ],
    [
      "a clear_cards naming one card twice",
      { op: "clear_cards", threadId: "t1", guildId: "g1", clearedIds: ["card-1", "card-1"] },
    ],
    [
      "a clear_cards naming more cards than one cleanup can",
      {
        op: "clear_cards",
        threadId: "t1",
        guildId: "g1",
        clearedIds: Array.from({ length: 17 }, (_, i) => `card-${i}`),
      },
    ],
  ])("rejects %s as invalid_body and stores nothing", async (_case, body) => {
    const db = createTestD1();

    expect(await handleThreadState(db, body)).toEqual({ status: "error", code: "invalid_body" });
    expect(await storedSession(db)).toBeNull();
  });

  it("answers thread_state_failed when D1 cannot be reached", async () => {
    expect(await handleThreadState(createFailingD1(), { op: "upsert", ...THREAD })).toEqual({
      status: "error",
      code: "thread_state_failed",
    });
  });
});

describe("guild scoping of thread_sessions", () => {
  async function followedWithACard() {
    const db = createTestD1();
    await handleThreadState(db, { op: "upsert", ...THREAD }, 1000);
    await handleThreadState(
      db,
      { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: "card-1" },
      1100,
    );
    return db;
  }

  it("reads no session for a thread another guild registered", async () => {
    const db = await followedWithACard();

    expect(await handleThreadState(db, { op: "get", ...OTHER_GUILD })).toEqual({
      status: "ok",
      session: null,
    });
    expect(await getThreadSession(db, { threadId: "t1", guildId: "g1" })).toMatchObject({
      active: true,
      pendingCardIds: ["card-1"],
    });
  });

  it("adds no card to it", async () => {
    const db = await followedWithACard();

    const response = await handleThreadState(
      db,
      { op: "add_card", ...OTHER_GUILD, cardMessageId: "card-9" },
      1200,
    );

    expect(response).toEqual({ status: "ok", session: null });
    expect(await storedSession(db)).toMatchObject({ pending_card_ids_json: '["card-1"]' });
  });

  it("clears no card of it", async () => {
    const db = await followedWithACard();

    const response = await handleThreadState(
      db,
      { op: "clear_cards", ...OTHER_GUILD, clearedIds: ["card-1"] },
      1200,
    );

    expect(response).toEqual({ status: "ok", session: null });
    expect(await storedSession(db)).toMatchObject({ pending_card_ids_json: '["card-1"]' });
  });

  it("neither pauses nor resumes it", async () => {
    const db = await followedWithACard();

    const paused = await handleThreadState(
      db,
      { op: "set_active", ...THREAD, guildId: "g2", active: false },
      1200,
    );
    expect(paused).toEqual({ status: "ok", session: null });
    expect(await storedSession(db)).toMatchObject({ active: 1, updated_at: 1100 });

    const resumed = await handleThreadState(
      db,
      { op: "set_active", ...THREAD, guildId: "g2", active: true },
      1300,
    );
    expect(resumed).toEqual({ status: "ok", session: null });
    expect(await storedSession(db)).toMatchObject({ guild_id: "g1", active: 1 });
  });

  it("does not let another guild take the thread over through upsert", async () => {
    const db = await followedWithACard();

    const response = await handleThreadState(
      db,
      { op: "upsert", ...THREAD, guildId: "g2", parentChannelId: "c9", createdBy: "u9" },
      1200,
    );

    expect(response).toEqual({ status: "ok", session: null });
    expect(await storedSession(db)).toMatchObject({
      guild_id: "g1",
      parent_channel_id: "c1",
      created_by: "u1",
      pending_card_ids_json: '["card-1"]',
    });
  });

  it("still serves the thread to the guild that registered it", async () => {
    const db = await followedWithACard();

    expect(await handleThreadState(db, { op: "get", threadId: "t1", guildId: "g1" })).toMatchObject(
      {
        status: "ok",
        session: { guildId: "g1", active: true, pendingCardIds: ["card-1"] },
      },
    );
  });
});

describe("POST /internal/v1/threads/state", () => {
  const auth = { Authorization: `Bearer ${TOKEN}` };

  it("rejects requests without a bearer token", async () => {
    expect(
      (await call(makeEnv(), "/threads/state", { op: "get", threadId: "t1", guildId: "g1" }))
        .status,
    ).toBe(401);
    expect(
      (
        await call(
          makeEnv(),
          "/threads/state",
          { op: "get", threadId: "t1", guildId: "g1" },
          { Authorization: "Bearer nope" },
        )
      ).status,
    ).toBe(401);
  });

  it("answers 400 for an invalid body", async () => {
    const response = await call(
      makeEnv(),
      "/threads/state",
      { op: "upsert", threadId: "t1" },
      auth,
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ status: "error", code: "invalid_body" });
  });

  it("answers 500 when the session cannot be stored", async () => {
    const response = await call(
      makeEnv(createFailingD1()),
      "/threads/state",
      { op: "upsert", ...THREAD },
      auth,
    );

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: "error", code: "thread_state_failed" });
  });

  it("registers, reads, and pauses a thread across calls", async () => {
    const env = makeEnv();

    const registered = await call(env, "/threads/state", { op: "upsert", ...THREAD }, auth);
    expect(registered.status).toBe(200);
    expect(await registered.json()).toMatchObject({ status: "ok", session: { active: true } });

    expect(
      (await call(env, "/threads/state", { op: "get", threadId: "t1", guildId: "g1" })).status,
    ).toBe(401);

    const withCard = await call(
      env,
      "/threads/state",
      { op: "add_card", threadId: "t1", guildId: "g1", cardMessageId: "card-1" },
      auth,
    );
    expect(await withCard.json()).toMatchObject({ session: { pendingCardIds: ["card-1"] } });

    const paused = await call(
      env,
      "/threads/state",
      { op: "set_active", ...THREAD, active: false },
      auth,
    );
    expect(await paused.json()).toMatchObject({
      session: { active: false, pendingCardIds: ["card-1"] },
    });
  });
});

describe("POST /internal/v1/threads/allowed", () => {
  const auth = { Authorization: `Bearer ${TOKEN}` };
  const channel = { guildId: "g1", channelId: "c1" };

  async function allowed(
    env: Env,
    body: unknown = channel,
    headers: Record<string, string> = auth,
  ) {
    const response = await call(env, "/threads/allowed", body, headers);
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  }

  it("rejects requests without a bearer token", async () => {
    expect((await call(makeEnv(), "/threads/allowed", channel, {})).status).toBe(401);
    expect(
      (await call(makeEnv(), "/threads/allowed", channel, { Authorization: "Bearer nope" })).status,
    ).toBe(401);
  });

  it.each([
    ["a body that is not an object", "nope"],
    ["a missing guild", { channelId: "c1" }],
    ["a missing channel", { guildId: "g1" }],
    ["an empty channel id", { guildId: "g1", channelId: "" }],
    ["the DM scope, which starts no threads", { guildId: "dm", channelId: "42" }],
  ])("answers 400 for %s", async (_case, body) => {
    const response = await allowed(makeEnv(), body);

    expect(response).toEqual({ status: 400, body: { status: "error", code: "invalid_body" } });
  });

  it("allows a channel of a guild nobody configured", async () => {
    expect(await allowed(makeEnv())).toEqual({
      status: 200,
      body: { status: "ok", allowed: true },
    });
  });

  it("refuses every channel of a disabled guild", async () => {
    const env = makeEnv();
    await configureGuild(env.DB, { enabled: false });

    expect((await allowed(env, { guildId: "g1", channelId: "c1" })).body).toEqual({
      status: "ok",
      allowed: false,
    });
    expect((await allowed(env, { guildId: "g1", channelId: "c2" })).body).toEqual({
      status: "ok",
      allowed: false,
    });
  });

  it("allows a listed channel of an allowlisted guild, and refuses the others", async () => {
    const env = makeEnv();
    await configureGuild(env.DB, { allow: ["c1"] });

    expect((await allowed(env, { guildId: "g1", channelId: "c1" })).body).toEqual({
      status: "ok",
      allowed: true,
    });
    expect((await allowed(env, { guildId: "g1", channelId: "c2" })).body).toEqual({
      status: "ok",
      allowed: false,
    });
  });

  it("reads a guild whose allowlist does not parse as allowing nothing", async () => {
    const env = makeEnv();
    await env.DB.prepare(
      "INSERT INTO guild_config (guild_id, allow_channels_json) VALUES ('g1', 'not json')",
    ).run();

    expect((await allowed(env, { guildId: "g1", channelId: "c1" })).body).toEqual({
      status: "ok",
      allowed: false,
    });
  });

  it("answers exactly what the generation gate would", async () => {
    const env = makeEnv();
    await configureGuild(env.DB, { allow: ["c1"] });

    for (const channelId of ["c1", "c2"]) {
      const gate = await getRuntimeConfig(env.DB, "g1", channelId);
      expect((await allowed(env, { guildId: "g1", channelId })).body).toEqual({
        status: "ok",
        allowed: gate.enabled && gate.channelAllowed,
      });
    }
  });

  it("only reads: it stores no session and changes no configuration", async () => {
    const env = makeEnv();
    await configureGuild(env.DB, { allow: ["c1"] });

    await allowed(env, { guildId: "g1", channelId: "c1" });
    await allowed(env, { guildId: "g1", channelId: "c2" });

    const { results } = await env.DB.prepare("SELECT * FROM guild_config").all();
    expect(results).toHaveLength(1);
    expect(await storedSession(env.DB)).toBeNull();
  });
});

describe("container_last_turns", () => {
  it("stores the latest turn of a conversation with the time its prompt was sent, replacing the one before it", async () => {
    const db = createTestD1();
    await recordLastTurn(db, TURN, 1000);
    await recordLastTurn(
      db,
      {
        ...TURN,
        triggerMessageId: "m2",
        triggerCreatedAt: 2000,
        triggerContent: "And the time?",
        assistantReply: "Noon.",
      },
      3000,
    );

    expect(await getLastTurn(db, TURN.containerId)).toEqual({
      containerId: "discord:g1:c1",
      scopeId: "g1",
      channelId: "c1",
      userId: "u1",
      userDisplayName: "User",
      triggerMessageId: "m2",
      triggerCreatedAt: 2000,
      triggerContent: "And the time?",
      assistantReply: "Noon.",
      updatedAt: 3000,
    });
  });

  it("keeps conversations apart", async () => {
    const db = createTestD1();
    await recordLastTurn(db, TURN, 1000);

    expect(await getLastTurn(db, "discord:g1:c2")).toBeNull();
    expect(await getLastTurn(db, "discord:g1:c1:t1")).toBeNull();
  });

  it("replaces only the reply of a redone turn, keeping the prompt and when it was sent", async () => {
    const db = createTestD1();
    await recordLastTurn(db, TURN, 1000);

    await recordLastReply(
      db,
      { containerId: TURN.containerId, scopeId: "g1", assistantReply: "Every Friday." },
      5000,
    );

    expect(await getLastTurn(db, TURN.containerId)).toMatchObject({
      triggerMessageId: "m1",
      triggerCreatedAt: 500,
      triggerContent: "What is the release day?",
      assistantReply: "Every Friday.",
      updatedAt: 5000,
    });
  });

  it("gives a conversation with no stored turn none from a redone reply", async () => {
    const db = createTestD1();

    await recordLastReply(
      db,
      { containerId: "discord:g1:c9", scopeId: "g1", assistantReply: "x" },
      1000,
    );

    expect(await getLastTurn(db, "discord:g1:c9")).toBeNull();
  });

  it("never reaches D1 for a DM turn, so no DM prompt or reply is ever stored", async () => {
    // Every statement of this D1 throws: a write that reached it would reject.
    const db = createFailingD1();
    const dmTurn = { ...TURN, containerId: "discord:@me:42", scopeId: "dm", channelId: "42" };

    await expect(recordLastTurn(db, dmTurn, 1000)).resolves.toBeUndefined();
    await expect(
      recordLastReply(
        db,
        { containerId: dmTurn.containerId, scopeId: "dm", assistantReply: "x" },
        2000,
      ),
    ).resolves.toBeUndefined();
  });
});

describe("thread session logging", () => {
  it("logs an op's failure as an event without the request body", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await handleThreadState(createFailingD1(), {
        op: "add_card",
        threadId: "t1",
        guildId: "g1",
        cardMessageId: "card-1",
      });
      expect(log).toHaveBeenCalledTimes(1);
      const event = JSON.parse(String(log.mock.calls[0]?.[0])) as Record<string, unknown>;
      expect(event).toMatchObject({ event: "thread_state_error", op: "add_card" });
      expect(JSON.stringify(event)).not.toContain("card-1");
    } finally {
      log.mockRestore();
    }
  });
});
