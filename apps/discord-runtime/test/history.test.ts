import { describe, expect, it } from "vitest";
import type { DMChannel } from "discord.js";

import { fetchHistory } from "../src/history";

/**
 * A channel whose `messages.fetch` answers newest-first, as discord.js does:
 * `messages[0]` is the newest message in the channel.
 */
function fakeChannel(messages: Array<Record<string, unknown>>): {
  channel: DMChannel;
  fetchLimits: number[];
} {
  const fetchLimits: number[] = [];
  const stored = messages.map((partial, i) => ({
    id: `m${i}`,
    content: `text ${i}`,
    author: { id: `u${i}`, displayName: `User ${i}`, username: `user${i}`, bot: false },
    member: null,
    createdTimestamp: 10_000 - i,
    ...partial,
  }));
  const channel = {
    messages: {
      fetch: async (options: { limit: number }) => {
        fetchLimits.push(options.limit);
        return new Map(stored.slice(0, options.limit).map((message) => [message.id, message]));
      },
    },
  };
  return { channel: channel as unknown as DMChannel, fetchLimits };
}

describe("fetchHistory", () => {
  it("asks Discord for 50 messages", async () => {
    const { channel, fetchLimits } = fakeChannel([]);
    await fetchHistory(channel);
    expect(fetchLimits).toEqual([50]);
  });

  it("returns the 40 newest messages that have content, oldest first", async () => {
    // 60 messages; only the newest one and m30 are empty.
    const messages = Array.from({ length: 60 }, (_, i) => ({
      id: `m${i}`,
      content: i === 0 || i === 30 ? "   " : `text ${i}`,
    }));

    const history = await fetchHistory(fakeChannel(messages).channel);

    expect(history).toHaveLength(40);
    expect(history.map((m) => m.id)).toEqual([
      ...Array.from({ length: 11 }, (_, k) => `m${41 - k}`),
      ...Array.from({ length: 29 }, (_, k) => `m${29 - k}`),
    ]);
    expect(history.every((m) => m.text.trim() !== "")).toBe(true);
    expect(history.map((m) => m.createdAt)).toEqual(
      history.map((m) => m.createdAt).toSorted((a, b) => a - b),
    );
  });

  it("maps each message to the wire shape the Worker reads", async () => {
    const history = await fetchHistory(
      fakeChannel([
        {
          id: "m1",
          content: "hello",
          author: { id: "u1", displayName: "Display", username: "user", bot: false },
          member: { displayName: "Nickname" },
          createdTimestamp: 9,
        },
        {
          id: "m2",
          content: "beep",
          author: { id: "bot", displayName: "Xenoblade", username: "xenoblade", bot: true },
          member: null,
          createdTimestamp: 8,
        },
      ]).channel,
    );

    // Newest-first input comes back oldest first.
    expect(history).toEqual([
      {
        id: "m2",
        text: "beep",
        authorId: "bot",
        authorName: "Xenoblade",
        isBot: true,
        createdAt: 8,
      },
      {
        id: "m1",
        text: "hello",
        authorId: "u1",
        authorName: "Nickname",
        isBot: false,
        createdAt: 9,
      },
    ]);
  });

  it("asks Discord for the page before a message, so nothing posted after it is fetched", async () => {
    const asks: Array<{ limit?: number; before?: string }> = [];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js channel
    const channel = {
      messages: {
        fetch: async (options: { limit?: number; before?: string }) => (
          asks.push(options),
          new Map()
        ),
      },
    } as unknown as DMChannel;

    await fetchHistory(channel, 20, "m9");
    await fetchHistory(channel, 20);

    expect(asks).toEqual([{ limit: 20, before: "m9" }, { limit: 20 }]);
  });
});
