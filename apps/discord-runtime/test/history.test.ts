import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelType, type DMChannel, type ThreadChannel } from "discord.js";

import { fetchHistory } from "../src/history";

afterEach(() => {
  vi.restoreAllMocks();
});

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

  it("prepends the parent starter message chronologically for a thread after a failed first turn", async () => {
    const fetchStarterMessage = vi.fn<() => Promise<unknown>>(async () => ({
      id: "thread-1",
      content: "<@bot> 将发言的权限给到用户组而不是频道上",
      author: { id: "owner-1", displayName: "Owner", username: "owner", bot: false },
      member: { displayName: "方舟" },
      createdTimestamp: 1_000,
      attachments: new Map(),
    }));
    const threadMessages = [
      {
        id: "m-retry",
        content: "再试一下",
        author: { id: "owner-1", displayName: "Owner", username: "owner", bot: false },
        member: { displayName: "方舟" },
        createdTimestamp: 3_000,
      },
      {
        id: "m-fail",
        content: "这次处理失败了，请稍后重试。",
        author: { id: "bot-1", displayName: "管理小助手", username: "bot", bot: true },
        member: null,
        createdTimestamp: 2_000,
      },
      {
        id: "m-stub",
        content: "",
        author: { id: "bot-1", displayName: "管理小助手", username: "bot", bot: true },
        member: null,
        createdTimestamp: 1_500,
      },
    ];
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js ThreadChannel
    const thread = {
      id: "thread-1",
      type: ChannelType.PublicThread,
      isThread: () => true,
      fetchStarterMessage,
      messages: {
        fetch: async () => new Map(threadMessages.map((m) => [m.id, m])),
      },
    } as unknown as ThreadChannel;

    const history = await fetchHistory(thread);

    expect(fetchStarterMessage).toHaveBeenCalledTimes(1);
    expect(history).toEqual([
      {
        id: "thread-1",
        text: "<@bot> 将发言的权限给到用户组而不是频道上",
        authorId: "owner-1",
        authorName: "方舟",
        isBot: false,
        createdAt: 1_000,
      },
      {
        id: "m-fail",
        text: "这次处理失败了，请稍后重试。",
        authorId: "bot-1",
        authorName: "管理小助手",
        isBot: true,
        createdAt: 2_000,
      },
      {
        id: "m-retry",
        text: "再试一下",
        authorId: "owner-1",
        authorName: "方舟",
        isBot: false,
        createdAt: 3_000,
      },
    ]);
  });

  it("preserves image/file attachment refs on starter messages even when text content is empty", async () => {
    const fetchStarterMessage = vi.fn<() => Promise<unknown>>(async () => ({
      id: "thread-img",
      content: "",
      author: { id: "owner-1", displayName: "Owner", username: "owner", bot: false },
      member: null,
      createdTimestamp: 1_000,
      attachments: new Map([
        [
          "a1",
          {
            url: "https://cdn.discordapp.com/attachments/1/2/spec.png",
            name: "spec.png",
            contentType: "image/png",
          },
        ],
      ]),
    }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js ThreadChannel
    const thread = {
      id: "thread-img",
      type: ChannelType.PublicThread,
      isThread: () => true,
      fetchStarterMessage,
      messages: {
        fetch: async () =>
          new Map([
            [
              "m-follow",
              {
                id: "m-follow",
                content: "帮我看看这张图",
                author: { id: "owner-1", displayName: "Owner", username: "owner", bot: false },
                member: null,
                createdTimestamp: 2_000,
              },
            ],
          ]),
      },
    } as unknown as ThreadChannel;

    const history = await fetchHistory(thread);

    expect(history.map((m) => [m.id, m.text])).toEqual([
      ["thread-img", "[Image: https://cdn.discordapp.com/attachments/1/2/spec.png]"],
      ["m-follow", "帮我看看这张图"],
    ]);
  });

  it("degrades gracefully when the starter message is deleted (404) or inaccessible", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    const fetchStarterMessage = vi.fn<() => Promise<unknown>>(async () => {
      throw new Error("Unknown Message");
    });
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js ThreadChannel
    const thread = {
      id: "thread-deleted-starter",
      type: ChannelType.PublicThread,
      isThread: () => true,
      fetchStarterMessage,
      messages: {
        fetch: async () =>
          new Map([
            [
              "m1",
              {
                id: "m1",
                content: "follow up",
                author: { id: "u1", displayName: "User", username: "u1", bot: false },
                member: null,
                createdTimestamp: 2_000,
              },
            ],
          ]),
      },
    } as unknown as ThreadChannel;

    const history = await fetchHistory(thread);

    expect(fetchStarterMessage).toHaveBeenCalledTimes(1);
    expect(history.map((m) => m.id)).toEqual(["m1"]);
  });

  it("skips fetchStarterMessage for standalone private threads and never duplicates an already-present starter", async () => {
    const privateFetchStarter = vi.fn<() => Promise<unknown>>();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a private discord.js ThreadChannel
    const privateThread = {
      id: "private-thread",
      type: ChannelType.PrivateThread,
      isThread: () => true,
      fetchStarterMessage: privateFetchStarter,
      messages: {
        fetch: async () =>
          new Map([
            [
              "m1",
              {
                id: "m1",
                content: "hello",
                author: { id: "u1", displayName: "User", username: "u1", bot: false },
                member: null,
                createdTimestamp: 1_000,
              },
            ],
          ]),
      },
    } as unknown as ThreadChannel;

    const privateHistory = await fetchHistory(privateThread);
    expect(privateFetchStarter).not.toHaveBeenCalled();
    expect(privateHistory.map((m) => m.id)).toEqual(["m1"]);

    // Forum/media post where starter message (id === thread.id) is already returned by messages.fetch.
    const forumFetchStarter = vi.fn<() => Promise<unknown>>();
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a forum post ThreadChannel
    const forumThread = {
      id: "forum-post-1",
      type: ChannelType.PublicThread,
      isThread: () => true,
      fetchStarterMessage: forumFetchStarter,
      messages: {
        fetch: async () =>
          new Map([
            [
              "m2",
              {
                id: "m2",
                content: "reply",
                author: { id: "u2", displayName: "User 2", username: "u2", bot: false },
                member: null,
                createdTimestamp: 2_000,
              },
            ],
            [
              "forum-post-1",
              {
                id: "forum-post-1",
                content: "original post",
                author: { id: "u1", displayName: "User 1", username: "u1", bot: false },
                member: null,
                createdTimestamp: 1_000,
              },
            ],
          ]),
      },
    } as unknown as ThreadChannel;

    const forumHistory = await fetchHistory(forumThread);
    expect(forumFetchStarter).not.toHaveBeenCalled();
    expect(forumHistory.map((m) => m.id)).toEqual(["forum-post-1", "m2"]);
  });

  it("skips fetchStarterMessage when the thread already fills the 40-message history window", async () => {
    const fetchStarterMessage = vi.fn<() => Promise<unknown>>();
    const fullMessages = Array.from({ length: 40 }, (_, i) => ({
      id: `m${i}`,
      content: `msg ${i}`,
      author: { id: "u1", displayName: "User", username: "u1", bot: false },
      member: null,
      createdTimestamp: 10_000 - i,
    }));
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double standing in for a discord.js ThreadChannel
    const thread = {
      id: "busy-thread",
      type: ChannelType.PublicThread,
      isThread: () => true,
      fetchStarterMessage,
      messages: {
        fetch: async () => new Map(fullMessages.map((m) => [m.id, m])),
      },
    } as unknown as ThreadChannel;

    const history = await fetchHistory(thread);

    expect(history).toHaveLength(40);
    expect(fetchStarterMessage).not.toHaveBeenCalled();
  });
});
