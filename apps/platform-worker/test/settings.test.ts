import { describe, expect, it } from "vitest";

import { getUserSettings, setUserSettings } from "../src/db";
import { handleSettings } from "../src/settings";
import { createTestD1 } from "./helpers/d1";

describe("user settings language", () => {
  it("defaults to zh for a user without a row", async () => {
    const settings = await getUserSettings(createTestD1(), "u1");
    expect(settings.language).toBe("zh");
  });

  it("persists an explicit en choice and survives unrelated flag updates", async () => {
    const db = createTestD1();
    await setUserSettings(db, { userId: "u1", language: "en" });
    await setUserSettings(db, { userId: "u1", chatOptin: true });

    const settings = await getUserSettings(db, "u1");
    expect(settings.language).toBe("en");
    expect(settings.chatOptin).toBe(true);
  });

  it("keeps the stored language when a set omits it", async () => {
    const db = createTestD1();
    await setUserSettings(db, { userId: "u1", language: "en" });
    await setUserSettings(db, { userId: "u1", learnOptin: true });

    expect((await getUserSettings(db, "u1")).language).toBe("en");
  });

  it("routes through handleSettings get and set", async () => {
    const db = createTestD1();
    const set = await handleSettings(db, { op: "set", userId: "u1", language: "en" });
    expect(set).toMatchObject({ status: "ok", settings: { language: "en" } });

    const get = await handleSettings(db, { op: "get", userId: "u1" });
    expect(get).toMatchObject({ status: "ok", settings: { language: "en" } });
  });
});
