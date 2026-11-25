import { describe, expect, it } from "vitest";

import { getRuntimeConfig } from "../src/db";
import { createTestD1 } from "./helpers/d1";

/** A guild whose allowlist is exactly `channels`. */
async function guildAllowing(channels: string[]): Promise<D1Database> {
  const db = createTestD1();
  await db
    .prepare("INSERT INTO guild_config (guild_id, allow_channels_json) VALUES ('g1', ?1)")
    .bind(JSON.stringify(channels))
    .run();
  return db;
}

describe("getRuntimeConfig channel allowlist", () => {
  it("allows every channel when the guild has no config row", async () => {
    expect(await getRuntimeConfig(createTestD1(), "g1", "c1")).toEqual({
      enabled: true,
      channelAllowed: true,
    });
  });

  it("allows no channel under an empty allowlist, thread or not", async () => {
    const db = await guildAllowing([]);
    expect(await getRuntimeConfig(db, "g1", "c1")).toMatchObject({ channelAllowed: false });
    expect(await getRuntimeConfig(db, "g1", "thread", "parent")).toMatchObject({
      channelAllowed: false,
    });
  });

  it("allows every channel under a NULL allowlist", async () => {
    // The column is NOT NULL today; a row written under the legacy schema may still hold NULL.
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => ({ enabled: 1, allow_channels_json: null }) }),
      }),
    } as unknown as D1Database;

    expect(await getRuntimeConfig(db, "g1", "c1")).toEqual({ enabled: true, channelAllowed: true });
  });

  it("allows a listed channel and rejects an unlisted one", async () => {
    const db = await guildAllowing(["c1"]);
    expect(await getRuntimeConfig(db, "g1", "c1")).toMatchObject({ channelAllowed: true });
    expect(await getRuntimeConfig(db, "g1", "c2")).toMatchObject({ channelAllowed: false });
  });

  it("admits a thread whose parent channel is listed", async () => {
    const db = await guildAllowing(["parent"]);
    expect(await getRuntimeConfig(db, "g1", "thread", "parent")).toMatchObject({
      channelAllowed: true,
    });
  });

  it("admits a thread listed in its own right", async () => {
    const db = await guildAllowing(["thread"]);
    expect(await getRuntimeConfig(db, "g1", "thread", "parent")).toMatchObject({
      channelAllowed: true,
    });
  });

  it("rejects a thread when neither it nor its parent is listed", async () => {
    const db = await guildAllowing(["other"]);
    expect(await getRuntimeConfig(db, "g1", "thread", "parent")).toMatchObject({
      channelAllowed: false,
    });
  });

  it("judges a request without a parent id by its own channel only", async () => {
    const db = await guildAllowing(["parent"]);
    expect(await getRuntimeConfig(db, "g1", "thread")).toMatchObject({ channelAllowed: false });
    expect(await getRuntimeConfig(db, "g1", "thread", null)).toMatchObject({
      channelAllowed: false,
    });
  });

  it("rejects every channel when the allowlist is unreadable", async () => {
    const db = createTestD1();
    await db
      .prepare("INSERT INTO guild_config (guild_id, allow_channels_json) VALUES ('g1', 'nope')")
      .run();
    expect(await getRuntimeConfig(db, "g1", "c1", "parent")).toMatchObject({
      channelAllowed: false,
    });
  });

  it("still honors the enabled flag for an allowed thread", async () => {
    const db = await guildAllowing(["parent"]);
    await db.prepare("UPDATE guild_config SET enabled = 0").run();
    expect(await getRuntimeConfig(db, "g1", "thread", "parent")).toEqual({
      enabled: false,
      channelAllowed: true,
    });
  });
});
