import { afterEach, describe, expect, it, vi } from "vitest";

import type { MessageIngestRequest } from "@xenoblade/contracts";

import { GENERATION_TIMEOUT_MS, ingestMessages } from "../src/ai-client";
import { stagedMilestones } from "../src/i18n";

const WORKER = "https://worker.example";

describe("generation timeout", () => {
  it("outlasts the longest staged-status milestone", () => {
    const longestMilestone = Math.max(...stagedMilestones("zh").map((m) => m.afterMs));
    expect(GENERATION_TIMEOUT_MS).toBeGreaterThan(longestMilestone);
  });
});

describe("ingestMessages", () => {
  const batch: MessageIngestRequest = {
    guildId: "g1",
    upserts: [
      {
        messageId: "m1",
        channelId: "c1",
        parentChannelId: null,
        authorId: "u1",
        authorName: "Alice",
        isBot: false,
        content: "hello",
        replyToId: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    deletes: ["m2"],
  };
  const stored = {
    status: "ok",
    upserted: 1,
    deleted: 1,
    skipped: 0,
    rejected: 0,
    pruned: 0,
  } as const;

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("posts the batch to the ingest route, authenticated, under a 10s timeout", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async () =>
      Response.json(stored),
    );
    vi.stubGlobal("fetch", fetchMock);

    const response = await ingestMessages(batch, WORKER, "secret");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${WORKER}/internal/v1/messages/ingest`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer secret" },
    });
    expect(JSON.parse(String(init?.body))).toEqual(batch);
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(response).toEqual(stored);
  });

  it("rejects when the Worker refuses the batch, so the buffer keeps it", async () => {
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ status: "error", code: "invalid_body" }, { status: 400 })),
    );

    await expect(ingestMessages(batch, WORKER, "secret")).rejects.toThrow("Worker HTTP 400");
  });
});
