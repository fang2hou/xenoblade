import { describe, it, expect, vi, afterEach } from "vitest";
import {
  parseDiscordMessageLinks,
  fetchLinkedMessages,
  type DiscordMessageLink,
} from "../../src/discord-links";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const link = (
  channelId: string,
  messageId: string,
  url = `https://discord.com/channels/0/${channelId}/${messageId}`,
): DiscordMessageLink => ({ channelId, messageId, url });

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// parseDiscordMessageLinks
// ---------------------------------------------------------------------------

describe("parseDiscordMessageLinks", () => {
  it("parses a standard discord.com link", () => {
    const [first] = parseDiscordMessageLinks("https://discord.com/channels/111/222/333");
    expect(first).toBeDefined();
    expect(first?.channelId).toBe("222");
    expect(first?.messageId).toBe("333");
    expect(first?.url).toBe("https://discord.com/channels/111/222/333");
  });

  it("parses a ptb.discord.com link", () => {
    const [first] = parseDiscordMessageLinks("https://ptb.discord.com/channels/111/222/333");
    expect(first?.channelId).toBe("222");
    expect(first?.messageId).toBe("333");
  });

  it("parses a canary.discord.com link", () => {
    const [first] = parseDiscordMessageLinks("https://canary.discord.com/channels/111/222/333");
    expect(first?.channelId).toBe("222");
    expect(first?.messageId).toBe("333");
  });

  it("parses an @me link", () => {
    const [first] = parseDiscordMessageLinks("https://discord.com/channels/@me/222/333");
    expect(first?.channelId).toBe("222");
    expect(first?.messageId).toBe("333");
  });

  it("parses an http (non-https) link", () => {
    const [first] = parseDiscordMessageLinks("http://discord.com/channels/111/222/333");
    expect(first?.channelId).toBe("222");
    expect(first?.messageId).toBe("333");
  });

  it("returns at most 3 links", () => {
    const links = parseDiscordMessageLinks(
      "https://discord.com/channels/1/10/100 " +
        "https://discord.com/channels/1/20/200 " +
        "https://discord.com/channels/1/30/300 " +
        "https://discord.com/channels/1/40/400",
    );
    expect(links).toHaveLength(3);
    // First three are kept in order; fourth is dropped.
    expect(links[0]?.messageId).toBe("100");
    expect(links[2]?.messageId).toBe("300");
  });

  it("returns an empty array when no links are present", () => {
    expect(parseDiscordMessageLinks("just some text")).toEqual([]);
  });

  it("returns an empty array for empty string", () => {
    expect(parseDiscordMessageLinks("")).toEqual([]);
  });

  it("extracts a link embedded in surrounding text", () => {
    const links = parseDiscordMessageLinks("看看 https://discord.com/channels/111/222/333 这个");
    expect(links).toHaveLength(1);
    expect(links[0]?.channelId).toBe("222");
    expect(links[0]?.messageId).toBe("333");
  });

  it("extracts multiple distinct links in one string", () => {
    const links = parseDiscordMessageLinks(
      "first https://discord.com/channels/1/10/100 and second https://discord.com/channels/1/20/200",
    );
    expect(links).toHaveLength(2);
    expect(links[0]?.messageId).toBe("100");
    expect(links[1]?.messageId).toBe("200");
  });

  it("does not match non-discord URLs", () => {
    expect(parseDiscordMessageLinks("https://example.com/channels/111/222/333")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchLinkedMessages
// ---------------------------------------------------------------------------

describe("fetchLinkedMessages", () => {
  it("fetches message content and image attachments as base64 data URLs", async () => {
    const imageBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]); // PNG magic header
    const expectedB64 = Buffer.from(imageBytes).toString("base64");
    const attUrl = "https://cdn.discord.com/attachments/1/image.png";

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://discord.com/api/v10")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: "look at this image",
            attachments: [
              {
                url: attUrl,
                content_type: "image/png",
                filename: "image.png",
              },
            ],
            embeds: [],
          }),
        } as unknown as Response;
      }
      // Image download
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/png" }),
        arrayBuffer: async () => imageBytes.buffer,
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock;

    const [result] = await fetchLinkedMessages([link("222", "333")], "BOT_TOKEN");

    expect(result.text).toBe("look at this image");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.dataUrl).toBe(`data:image/png;base64,${expectedB64}`);
    expect(result.images[0]?.mimeType).toBe("image/png");
  });

  it("calls the Discord REST API with the correct URL and Authorization header", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ content: "hi", attachments: [], embeds: [] }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    await fetchLinkedMessages([link("222", "333")], "MY_TOKEN");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://discord.com/api/v10/channels/222/messages/333");
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bot MY_TOKEN");
  });

  it("skips silently when the API returns 403", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () => ({ ok: false, status: 403, json: async () => ({}) }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const results = await fetchLinkedMessages([link("222", "333")], "BOT_TOKEN");
    expect(results).toEqual([]);
  });

  it("skips silently when the message fetch throws a network error", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => {
      throw new Error("network down");
    });
    globalThis.fetch = fetchMock;

    const results = await fetchLinkedMessages([link("222", "333")], "BOT_TOKEN");
    expect(results).toEqual([]);
  });

  it("returns text-only content when the message has no attachments or embeds", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ content: "plain text", attachments: [], embeds: [] }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const [result] = await fetchLinkedMessages([link("222", "333")], "BOT_TOKEN");
    expect(result.text).toBe("plain text");
    expect(result.images).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("downloads embed images", async () => {
    const imageBytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]); // JPEG magic header
    const expectedB64 = Buffer.from(imageBytes).toString("base64");
    const embedUrl = "https://cdn.discord.com/embeds/e.jpg";

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://discord.com/api/v10")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: "embedded image",
            attachments: [],
            embeds: [{ image: { url: embedUrl } }],
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        headers: new Headers({ "content-type": "image/jpeg" }),
        arrayBuffer: async () => imageBytes.buffer,
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock;

    const [result] = await fetchLinkedMessages([link("222", "333")], "BOT_TOKEN");
    expect(result.images).toHaveLength(1);
    expect(result.images[0]?.dataUrl).toBe(`data:image/jpeg;base64,${expectedB64}`);
    expect(result.images[0]?.mimeType).toBe("image/jpeg");
  });

  it("skips embed entries without an image url", async () => {
    const fetchMock = vi.fn<typeof fetch>(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            content: "no image here",
            attachments: [],
            embeds: [{ type: "rich", description: "text only" }],
          }),
        }) as unknown as Response,
    );
    globalThis.fetch = fetchMock;

    const [result] = await fetchLinkedMessages([link("222", "333")], "BOT_TOKEN");
    expect(result.images).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("processes multiple links and returns partial results", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages/ok-1")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ content: "first", attachments: [], embeds: [] }),
        } as unknown as Response;
      }
      if (url.includes("/messages/forbidden")) {
        return {
          ok: false,
          status: 403,
          json: async () => ({}),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ content: "second", attachments: [], embeds: [] }),
      } as unknown as Response;
    });
    globalThis.fetch = fetchMock;

    const results = await fetchLinkedMessages(
      [link("c1", "ok-1"), link("c2", "forbidden"), link("c3", "ok-2")],
      "BOT_TOKEN",
    );
    expect(results).toHaveLength(2);
    expect(results[0]?.text).toBe("first");
    expect(results[1]?.text).toBe("second");
  });

  it("returns an empty array when given no links", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    globalThis.fetch = fetchMock;

    const results = await fetchLinkedMessages([], "BOT_TOKEN");
    expect(results).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips image downloads that return non-ok", async () => {
    const attUrl = "https://cdn.discord.com/attachments/1/img.png";

    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://discord.com/api/v10")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            content: "broken image",
            attachments: [{ url: attUrl, content_type: "image/png" }],
            embeds: [],
          }),
        } as unknown as Response;
      }
      // Image download returns 404
      return { ok: false, status: 404 } as unknown as Response;
    });
    globalThis.fetch = fetchMock;

    const [result] = await fetchLinkedMessages([link("222", "333")], "BOT_TOKEN");
    expect(result.text).toBe("broken image");
    expect(result.images).toEqual([]);
  });
});
