import { describe, it, expect, vi } from "vitest";
import type { Message } from "chat";
import {
  getScopeIdFromDiscordMessage,
  getChannelIdFromDiscordMessage,
  isReplyToBot,
  resolveReplyToBot,
  ScopeUnresolvedError,
} from "../../src/scope";

// Message is a real class with many required fields; these tests only touch
// `.raw`, so a lightweight `{ raw }` stub cast through `unknown` is the seam.
type RawMessage = { raw: unknown };
const stub = (raw: unknown): Message => ({ raw }) as RawMessage as Message;

const APP_ID = "111";

function expectScopeUnresolved(fn: () => unknown): void {
  try {
    fn();
    throw new Error("expected ScopeUnresolvedError to be thrown");
  } catch (err) {
    expect(err).toBeInstanceOf(ScopeUnresolvedError);
    expect((err as ScopeUnresolvedError).code).toBe("SCOPE_UNRESOLVED");
    expect((err as ScopeUnresolvedError).name).toBe("ScopeUnresolvedError");
  }
}

describe("getScopeIdFromDiscordMessage", () => {
  it("returns the guild id for a guild channel message", () => {
    expect(getScopeIdFromDiscordMessage(stub({ guild_id: "guild-1", channel_id: "chan-1" }))).toBe(
      "guild-1",
    );
  });

  it("returns the guild id for a Discord thread (guild thread channel type)", () => {
    expect(
      getScopeIdFromDiscordMessage(
        stub({
          guild_id: "guild-1",
          channel_id: "thread-1",
          channel_type: 11,
        }),
      ),
    ).toBe("guild-1");
  });

  it("returns 'dm' when guild_id is null", () => {
    expect(getScopeIdFromDiscordMessage(stub({ guild_id: null, channel_id: "c" }))).toBe("dm");
  });

  it("returns 'dm' when guild_id is null and channel_type is a DM (corroboration)", () => {
    expect(
      getScopeIdFromDiscordMessage(stub({ guild_id: null, channel_id: "c", channel_type: 1 })),
    ).toBe("dm");
  });

  it("returns 'dm' for a group DM (guild_id null, channel_type 3)", () => {
    expect(
      getScopeIdFromDiscordMessage(stub({ guild_id: null, channel_id: "c", channel_type: 3 })),
    ).toBe("dm");
  });

  it("throws when the guild_id key is missing", () => {
    expectScopeUnresolved(() => getScopeIdFromDiscordMessage(stub({ channel_id: "c" })));
  });

  it("throws when guild_id is an empty string", () => {
    expectScopeUnresolved(() =>
      getScopeIdFromDiscordMessage(stub({ guild_id: "", channel_id: "c" })),
    );
  });

  it("throws when guild_id is a non-string, non-null value", () => {
    expectScopeUnresolved(() =>
      getScopeIdFromDiscordMessage(stub({ guild_id: 42, channel_id: "c" })),
    );
  });

  it("throws on conflict: non-empty guild_id with channel_type 1 (DM)", () => {
    expectScopeUnresolved(() =>
      getScopeIdFromDiscordMessage(stub({ guild_id: "guild-1", channel_id: "c", channel_type: 1 })),
    );
  });

  it("throws on conflict: non-empty guild_id with channel_type 3 (group DM)", () => {
    expectScopeUnresolved(() =>
      getScopeIdFromDiscordMessage(stub({ guild_id: "guild-1", channel_id: "c", channel_type: 3 })),
    );
  });

  it("does not treat channel_type as a substitute for missing guild_id", () => {
    expectScopeUnresolved(() =>
      getScopeIdFromDiscordMessage(stub({ channel_id: "c", channel_type: 1 })),
    );
  });

  it("throws when raw is not a non-null object", () => {
    expectScopeUnresolved(() => getScopeIdFromDiscordMessage(stub(null)));
    expectScopeUnresolved(() => getScopeIdFromDiscordMessage(stub("x")));
  });
});

describe("getChannelIdFromDiscordMessage", () => {
  it("returns the channel id", () => {
    expect(getChannelIdFromDiscordMessage(stub({ guild_id: "g", channel_id: "chan-9" }))).toBe(
      "chan-9",
    );
  });

  it("throws when channel_id is missing", () => {
    expectScopeUnresolved(() => getChannelIdFromDiscordMessage(stub({ guild_id: "g" })));
  });

  it("throws when channel_id is an empty string", () => {
    expectScopeUnresolved(() =>
      getChannelIdFromDiscordMessage(stub({ guild_id: "g", channel_id: "" })),
    );
  });

  it("throws when channel_id is not a string", () => {
    expectScopeUnresolved(() =>
      getChannelIdFromDiscordMessage(stub({ guild_id: "g", channel_id: 7 })),
    );
  });
});

describe("isReplyToBot", () => {
  const replyTo = (authorId: string) =>
    stub({
      guild_id: "g",
      channel_id: "c",
      message_reference: { message_id: "m-1" },
      referenced_message: { author: { id: authorId } },
    });

  it("returns true when the referenced message author is this bot", () => {
    expect(isReplyToBot(replyTo(APP_ID), APP_ID)).toBe(true);
  });

  it("returns false when the referenced message author is a different bot", () => {
    expect(isReplyToBot(replyTo("other-bot"), APP_ID)).toBe(false);
  });

  it("returns false when there is no referenced_message", () => {
    expect(
      isReplyToBot(
        stub({
          guild_id: "g",
          channel_id: "c",
          message_reference: { message_id: "m-1" },
        }),
        APP_ID,
      ),
    ).toBe(false);
  });

  it("returns false when there is no message_reference at all", () => {
    expect(isReplyToBot(stub({ guild_id: "g", channel_id: "c" }), APP_ID)).toBe(false);
  });

  it("returns false when message_reference.message_id is missing", () => {
    expect(
      isReplyToBot(
        stub({
          guild_id: "g",
          channel_id: "c",
          message_reference: {},
          referenced_message: { author: { id: APP_ID } },
        }),
        APP_ID,
      ),
    ).toBe(false);
  });

  it("returns false when referenced_message.author.id is missing", () => {
    expect(
      isReplyToBot(
        stub({
          guild_id: "g",
          channel_id: "c",
          message_reference: { message_id: "m-1" },
          referenced_message: { author: {} },
        }),
        APP_ID,
      ),
    ).toBe(false);
  });

  it("returns false (never throws) when raw is not an object", () => {
    expect(isReplyToBot(stub(null), APP_ID)).toBe(false);
    expect(isReplyToBot(stub(undefined), APP_ID)).toBe(false);
  });
});

describe("resolveReplyToBot", () => {
  const okResponse = (json: unknown) =>
    ({
      ok: true,
      status: 200,
      json: async () => json,
    }) as unknown as Response;

  const notFoundResponse = () =>
    ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }) as unknown as Response;

  it("returns true without fetching when referenced_message already matches", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const message = stub({
      guild_id: "g",
      channel_id: "c",
      message_reference: { message_id: "m-1" },
      referenced_message: { author: { id: APP_ID } },
    });
    const result = await resolveReplyToBot(message, APP_ID, "tok", fetchMock);
    expect(result).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns true via REST fallback when only message_reference is present", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => okResponse({ author: { id: APP_ID } }));
    const message = stub({
      guild_id: "g",
      channel_id: "c",
      message_reference: { message_id: "m-1" },
    });
    const result = await resolveReplyToBot(message, APP_ID, "tok", fetchMock);
    expect(result).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      "https://discord.com/api/v10/channels/c/messages/m-1",
    );
  });

  it("returns false when the REST fallback returns a mismatching author", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () =>
      okResponse({ author: { id: "someone-else" } }),
    );
    const message = stub({
      guild_id: "g",
      channel_id: "c",
      message_reference: { message_id: "m-1" },
    });
    const result = await resolveReplyToBot(message, APP_ID, "tok", fetchMock);
    expect(result).toBe(false);
  });

  it("returns false when the REST fallback returns 404", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => notFoundResponse());
    const message = stub({
      guild_id: "g",
      channel_id: "c",
      message_reference: { message_id: "m-1" },
    });
    const result = await resolveReplyToBot(message, APP_ID, "tok", fetchMock);
    expect(result).toBe(false);
  });

  it("returns false when the REST fallback throws", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    const message = stub({
      guild_id: "g",
      channel_id: "c",
      message_reference: { message_id: "m-1" },
    });
    const result = await resolveReplyToBot(message, APP_ID, "tok", fetchMock);
    expect(result).toBe(false);
  });

  it("returns false without fetching when there is no message_reference at all", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const message = stub({ guild_id: "g", channel_id: "c" });
    const result = await resolveReplyToBot(message, APP_ID, "tok", fetchMock);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns false when channel_id cannot be resolved", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const message = stub({
      guild_id: "g",
      message_reference: { message_id: "m-1" },
    });
    const result = await resolveReplyToBot(message, APP_ID, "tok", fetchMock);
    expect(result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
