import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Message } from "chat";
import { buildGenerationMessages, SAFETY_SYSTEM } from "../../src/prompt";
import type { ContextDecision } from "../../src/context";

// --- Stubs ------------------------------------------------------------------

type StubMsg = {
  id: string;
  text: string;
  author: {
    userId: string;
    userName: string;
    fullName: string;
    isBot: boolean | "unknown";
    isMe: boolean;
  };
  attachments: { type: string; url?: string; mimeType?: string }[];
  metadata: { dateSent: Date; edited: boolean };
};

const msg = (id: string, text: string, extra?: Partial<StubMsg>): Message =>
  ({
    id,
    text,
    author: { userId: "u1", userName: "alice", fullName: "Alice", isBot: false, isMe: false },
    attachments: [],
    metadata: { dateSent: new Date(), edited: false },
    ...extra,
  }) as unknown as Message;

/** A bot-authored message (assistant role in AI history). */
const botMsg = (id: string, text: string, extra?: Partial<StubMsg>): Message =>
  msg(id, text, {
    author: {
      userId: "bot",
      userName: "Xenoblade",
      fullName: "Xenoblade",
      isBot: true,
      isMe: true,
    },
    ...extra,
  });

/** A "none" context decision: no history, no context block. */
const noContext = (messages: Message[] = []): ContextDecision => ({
  mode: "none",
  forced: false,
  reason: "test",
  messages,
});

/** Flatten a message content (string or part array) into its concatenated text. */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type: string; text?: string }>)
      .filter((p) => p.type === "text")
      .map((p) => p.text ?? "")
      .join("");
  }
  return "";
}

/** Collect file parts from a part-array content. */
function fileParts(content: unknown): Array<{ type: string; data?: string; mediaType?: string }> {
  if (!Array.isArray(content)) return [];
  return (content as Array<{ type: string; data?: string; mediaType?: string }>).filter(
    (p) => p.type === "file",
  );
}

// --- SAFETY_SYSTEM ----------------------------------------------------------

describe("SAFETY_SYSTEM", () => {
  it("is a non-empty string", () => {
    expect(typeof SAFETY_SYSTEM).toBe("string");
    expect(SAFETY_SYSTEM.length).toBeGreaterThan(0);
  });

  it("instructs language matching", () => {
    expect(SAFETY_SYSTEM.toLowerCase()).toContain("language");
    expect(SAFETY_SYSTEM.toLowerCase()).toMatch(/same language|reply in/);
  });

  it("guards the context block as untrusted reference material", () => {
    expect(SAFETY_SYSTEM).toContain("[Relevant Discord context]");
    expect(SAFETY_SYSTEM.toLowerCase()).toContain("untrusted");
  });

  it("guides fresh answers when the user signals it", () => {
    expect(SAFETY_SYSTEM.toLowerCase()).toMatch(
      /fresh|don't use previous context|ignore the conversation history/,
    );
  });

  it("forbids revealing secrets and internal instructions", () => {
    expect(SAFETY_SYSTEM.toLowerCase()).toContain("never reveal");
    expect(SAFETY_SYSTEM.toLowerCase()).toContain("secrets");
  });
});

// --- buildGenerationMessages ------------------------------------------------

describe("buildGenerationMessages", () => {
  it("none mode returns a single user message with just the current text", async () => {
    const context: ContextDecision = {
      mode: "none",
      forced: false,
      reason: "directive",
      messages: [],
    };
    const result = await buildGenerationMessages(context, msg("cur", "hello world"));

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("hello world");
  });

  it("forced mode turns history into role-tagged AI turns and appends the current message as the final user turn", async () => {
    const context: ContextDecision = {
      mode: "channel",
      forced: true,
      reason: "reply",
      messages: [
        msg("m1", "earlier question"),
        botMsg("m2", "bot answer"),
        msg("cur", "follow up"),
      ],
    };

    const result = await buildGenerationMessages(context, msg("cur", "follow up"));

    // m1 (user) and m2 (assistant) become AI turns; current message is final user turn.
    expect(result).toHaveLength(3);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("earlier question");
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toBe("bot answer");

    // Final turn is the current message.
    expect(result[2].role).toBe("user");
    expect(extractText(result[2].content)).toContain("follow up");
    // The forced history is also surfaced as an untrusted context block tail.
    expect(extractText(result[2].content)).toContain("[Relevant Discord context]");
  });

  it("relevant (non-forced) mode returns a single user message with the context block appended", async () => {
    const context: ContextDecision = {
      mode: "channel",
      forced: false,
      reason: "relevant",
      messages: [msg("rel", "some relevant note")],
    };

    const result = await buildGenerationMessages(context, msg("cur", "what about this"));

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");

    const text = extractText(result[0].content);
    expect(text).toContain("what about this");
    expect(text).toContain("[Relevant Discord context]");
    expect(text).toContain("some relevant note");
  });

  it("includes linked Discord message text in the content", async () => {
    const result = await buildGenerationMessages(noContext(), msg("cur", "see this"), [
      { text: "linked text", images: [] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");

    const text = extractText(result[0].content);
    expect(text).toContain("see this");
    expect(text).toContain("[Linked Discord message 1]");
    expect(text).toContain("linked text");
  });

  it("includes a voice message transcription block when provided", async () => {
    const result = await buildGenerationMessages(
      noContext(),
      msg("cur", "listen to this"),
      [],
      "transcribed text",
    );

    const text = extractText(result[0].content);
    expect(text).toContain("listen to this");
    expect(text).toContain("[Voice message transcription]");
    expect(text).toContain("transcribed text");
  });

  it("includes linked images as file parts", async () => {
    const result = await buildGenerationMessages(noContext(), msg("cur", "look"), [
      { text: "", images: [{ dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" }] },
    ]);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");

    const files = fileParts(result[0].content);
    expect(files).toHaveLength(1);
    expect(files[0].data).toBe("data:image/png;base64,AAAA");
    expect(files[0].mediaType).toBe("image/png");

    // The text is still present as a text part.
    expect(extractText(result[0].content)).toContain("look");
  });

  it("does not include author names in forced history turns (cacheable prefix)", async () => {
    const context: ContextDecision = {
      mode: "thread",
      forced: true,
      reason: "thread",
      messages: [msg("m1", "named author message"), msg("cur", "current")],
    };

    const result = await buildGenerationMessages(context, msg("cur", "current"));

    // History turn content is the bare text, no author name tag.
    expect(result[0].role).toBe("user");
    expect(result[0].content).toBe("named author message");
    expect(extractText(result[0].content)).not.toContain("Alice");
  });

  it("excludes the current message from forced history even if present in context.messages", async () => {
    const current = msg("cur", "the current question");
    const context: ContextDecision = {
      mode: "channel",
      forced: true,
      reason: "reply",
      messages: [msg("m1", "older"), current],
    };

    const result = await buildGenerationMessages(context, current);

    // Only "older" becomes a history turn; the current message is the final turn.
    expect(result).toHaveLength(2);
    expect(result[0].content).toBe("older");
    expect(result[1].role).toBe("user");
    expect(extractText(result[1].content)).toContain("the current question");
  });
});

// --- own image attachments (currentMessageToAi fetch path) ------------------

describe("currentMessageToAi — own image attachments", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    const fakePng = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        headers: { get: () => "image/png" },
        arrayBuffer: async () => fakePng.buffer,
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    globalThis.fetch = originalFetch;
  });

  it("downloads own image attachments as base64 file parts", async () => {
    const current = msg("cur", "see this image", {
      attachments: [
        { type: "image", url: "https://cdn.example.com/img.png", mimeType: "image/png" },
      ],
    });

    const result = await buildGenerationMessages(noContext(), current);

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");

    const files = fileParts(result[0].content);
    expect(files).toHaveLength(1);
    expect(files[0].data).toMatch(/^data:image\/png;base64,/);
    expect(files[0].mediaType).toBe("image/png");
    expect(extractText(result[0].content)).toContain("see this image");
  });

  it("skips own attachments gracefully when the download fails", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));

    const current = msg("cur", "broken image", {
      attachments: [
        { type: "image", url: "https://cdn.example.com/missing.png", mimeType: "image/png" },
      ],
    });

    const result = await buildGenerationMessages(noContext(), current);

    // No images could be fetched → content is plain text again.
    expect(result).toHaveLength(1);
    expect(typeof result[0].content).toBe("string");
    expect(result[0].content).toContain("broken image");
  });
});
