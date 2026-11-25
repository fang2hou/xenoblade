import type { MCPClient } from "@ai-sdk/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeMcpClients, connectMcpServers } from "../src/tools/mcp-clients";

const CONTEXT7 = "https://mcp.context7.com/mcp";
const GITHUB = "https://api.githubcopilot.com/mcp/";
const CONNECT_DEADLINE_MS = 3_000;
const SESSION_DELETE_TIMEOUT_MS = 2_000;
const NEGOTIATED_PROTOCOL_VERSION = "2025-06-18";
const ENV_WITH_GITHUB = { GITHUB_MCP_TOKEN: "test-token" } as Env;

interface JsonRpcMessage {
  id?: number;
  method?: string;
}

type Responder = (message: JsonRpcMessage) => Response | Promise<Response>;

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("connectMcpServers", () => {
  it("exposes only allowlisted read-only tools, namespaced by server", async () => {
    const logs = captureLogs();
    stubMcpNetwork({
      [CONTEXT7]: healthyServer([
        "resolve-library-id",
        "query-docs",
        "get-library-docs",
        "submit-docs",
      ]),
      // get_issue is the deprecated name of issue_read and must not sneak back in.
      [GITHUB]: healthyServer([
        "get_me",
        "get_file_contents",
        "issue_read",
        "pull_request_read",
        "search_pull_requests",
        "get_issue",
        "create_issue",
        "push_files",
        "merge_pull_request",
      ]),
    });

    const result = await connectMcpServers(ENV_WITH_GITHUB);

    expect(Object.keys(result.tools)).toEqual([
      "context7_resolve-library-id",
      "context7_query-docs",
      "context7_get-library-docs",
      "github_get_me",
      "github_get_file_contents",
      "github_issue_read",
      "github_pull_request_read",
      "github_search_pull_requests",
    ]);
    expect(logs.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "mcp_connected",
          server: "context7",
          exposedTools: 3,
          filteredTools: 1,
        }),
        expect.objectContaining({
          event: "mcp_connected",
          server: "github",
          exposedTools: 5,
          filteredTools: 4,
        }),
      ]),
    );
  });

  it("connects every server at once instead of one after another", async () => {
    // Each server answers only once both handshakes are in flight, so a serial
    // loop would run the first server into the connect deadline.
    const bothHandshakesStarted = barrier(2);
    stubMcpNetwork({
      [CONTEXT7]: healthyServer(["resolve-library-id"], bothHandshakesStarted),
      [GITHUB]: healthyServer(["get_me"], bothHandshakesStarted),
    });

    const result = await connectMcpServers(ENV_WITH_GITHUB);

    expect(Object.keys(result.tools)).toEqual(["context7_resolve-library-id", "github_get_me"]);
  });

  it("drops a server that fails and keeps the healthy one", async () => {
    const logs = captureLogs();
    stubMcpNetwork({
      [CONTEXT7]: healthyServer(["resolve-library-id"]),
      [GITHUB]: () => new Response("unauthorized", { status: 401 }),
    });

    const result = await connectMcpServers(ENV_WITH_GITHUB);

    expect(Object.keys(result.tools)).toEqual(["context7_resolve-library-id"]);
    expect(result.clients).toHaveLength(1);
    expect(logs.events()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          event: "mcp_connected",
          server: "context7",
          exposedTools: 1,
          filteredTools: 0,
        }),
        expect.objectContaining({ event: "mcp_connect_failed", server: "github", timedOut: false }),
      ]),
    );
  });

  it.each(["initialize", "tools/list"])(
    "gives up on a server whose %s is still unanswered at the deadline",
    async (method) => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation(abortOnFakeClock);
      const logs = captureLogs();
      const network = stubMcpNetwork({
        [CONTEXT7]: healthyServer(["resolve-library-id"]),
        [GITHUB]: hangingOn(method, ["get_me"]),
      });

      let settled = false;
      const pending = connectMcpServers(ENV_WITH_GITHUB).then((result) => {
        settled = true;
        return result;
      });

      await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS - 1);
      expect(settled).toBe(false);

      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const result = await pending;

      expect(Object.keys(result.tools)).toEqual(["context7_resolve-library-id"]);
      expect(result.clients).toHaveLength(1);
      expect(network.rpcRequestsTo(GITHUB, method)[0]?.signal?.aborted).toBe(true);
      expect(logs.events()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "mcp_connected",
            server: "context7",
            exposedTools: 1,
            filteredTools: 0,
          }),
          expect.objectContaining({
            event: "mcp_connect_failed",
            server: "github",
            timedOut: true,
          }),
        ]),
      );
    },
  );

  it.each(["notifications/initialized", "tools/list"])(
    "ends the session of a server abandoned while %s was pending",
    async (method) => {
      const logs = captureLogs();
      const network = stubMcpNetwork({
        [CONTEXT7]: healthyServer(["resolve-library-id"]),
        [GITHUB]: hangingOn(method, ["get_me"]),
      });
      const deleteStatuses: number[] = [];
      // A strict server ends a session only for a client speaking the negotiated protocol version.
      network.respondTo(GITHUB, "DELETE", (init) => {
        const speaksNegotiatedVersion =
          new Headers(init?.headers).get("mcp-protocol-version") === NEGOTIATED_PROTOCOL_VERSION;
        const status = speaksNegotiatedVersion ? 200 : 400;
        deleteStatuses.push(status);
        return new Response(null, { status });
      });

      await connectPastDeadline(() => connectMcpServers(ENV_WITH_GITHUB));

      const sessionDeletes = network.requestsTo(GITHUB, "DELETE");
      expect(sessionDeletes).toHaveLength(1);
      // Its own deadline, not the already-aborted connect signal.
      expect(sessionDeletes[0]?.signal?.aborted).toBe(false);
      const deleteHeaders = Object.fromEntries(new Headers(sessionDeletes[0]?.headers));
      expect(deleteHeaders).toMatchObject({
        authorization: "Bearer test-token",
        "mcp-protocol-version": NEGOTIATED_PROTOCOL_VERSION,
        "mcp-session-id": "session",
      });
      expect(deleteStatuses).toEqual([200]);
      expect(logs.events()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            event: "mcp_connect_failed",
            server: "github",
            timedOut: true,
          }),
        ]),
      );

      await vi.advanceTimersByTimeAsync(SESSION_DELETE_TIMEOUT_MS - 1);
      expect(sessionDeletes[0]?.signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(sessionDeletes[0]?.signal?.aborted).toBe(true);
    },
  );

  it("sends a single session DELETE when the handshake fails after the server opened one", async () => {
    const github = healthyServer(["get_me"]);
    const network = stubMcpNetwork({
      [CONTEXT7]: healthyServer(["resolve-library-id"]),
      [GITHUB]: (message) =>
        message.method === "notifications/initialized"
          ? new Response("server error", { status: 500 })
          : github(message),
    });

    const result = await connectMcpServers(ENV_WITH_GITHUB);

    expect(Object.keys(result.tools)).toEqual(["context7_resolve-library-id"]);
    expect(network.requestsTo(GITHUB, "DELETE")).toHaveLength(1);
  });

  it.each(["notifications/initialized", "tools/list"])(
    "hands the cleanup of a server abandoned at %s to waitUntil",
    async (method) => {
      const waitUntil = vi.fn<(promise: Promise<unknown>) => void>();
      const network = stubMcpNetwork({
        [CONTEXT7]: healthyServer(["resolve-library-id"]),
        [GITHUB]: hangingOn(method, ["get_me"]),
      });
      const serverAnswersDelete = Promise.withResolvers<void>();
      network.respondTo(GITHUB, "DELETE", async () => {
        await serverAnswersDelete.promise;
        return new Response(null, { status: 200 });
      });

      await connectPastDeadline(() => connectMcpServers(ENV_WITH_GITHUB, { waitUntil }));

      expect(waitUntil).toHaveBeenCalledTimes(1);
      const cleanup = waitUntil.mock.calls[0]?.[0];
      let cleanedUp = false;
      void cleanup?.then(() => {
        cleanedUp = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(cleanedUp).toBe(false);

      serverAnswersDelete.resolve();
      await vi.advanceTimersByTimeAsync(0);

      expect(cleanedUp).toBe(true);
      expect(network.urlsRequested("DELETE")).toEqual([GITHUB]);
    },
  );
});

describe("closeMcpClients", () => {
  it("closes every client at once, even when an earlier close fails", async () => {
    // Each session DELETE waits for the other one to be in flight, so a serial
    // loop could never finish the first.
    const bothDeletesStarted = barrier(2);
    let deletesInFlight = 0;
    let peakDeletesInFlight = 0;
    const network = stubMcpNetwork({
      [CONTEXT7]: healthyServer(["resolve-library-id"]),
      [GITHUB]: healthyServer(["get_me"]),
    });
    for (const url of [CONTEXT7, GITHUB]) {
      network.respondTo(url, "DELETE", async (init) => {
        deletesInFlight += 1;
        peakDeletesInFlight = Math.max(peakDeletesInFlight, deletesInFlight);
        try {
          await Promise.race([bothDeletesStarted(), hangUntilAborted(init?.signal)]);
          return new Response(null, { status: 200 });
        } finally {
          deletesInFlight -= 1;
        }
      });
    }
    const { clients } = await connectMcpServers(ENV_WITH_GITHUB);
    const failingClose = vi.fn().mockRejectedValue(new Error("close failed"));
    const failingClient = { close: failingClose } as unknown as MCPClient;

    await expect(closeMcpClients([failingClient, ...clients])).resolves.toBeUndefined();

    expect(failingClose).toHaveBeenCalledTimes(1);
    expect(peakDeletesInFlight).toBe(2);
    expect(network.urlsRequested("DELETE").toSorted()).toEqual([GITHUB, CONTEXT7]);
  });

  it("gives up on a session DELETE the server never answers", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementation(abortOnFakeClock);
    const network = stubMcpNetwork({ [CONTEXT7]: healthyServer(["resolve-library-id"]) });
    const { clients } = await connectMcpServers({} as Env);
    network.respondTo(CONTEXT7, "DELETE", (init) => hangUntilAborted(init?.signal));

    let closed = false;
    void closeMcpClients(clients).then(() => {
      closed = true;
    });

    await vi.advanceTimersByTimeAsync(SESSION_DELETE_TIMEOUT_MS - 1);
    expect(closed).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(closed).toBe(true);

    expect(network.requestsTo(CONTEXT7, "DELETE")[0]?.signal?.aborted).toBe(true);
  });
});

/** Runs `connect` on the fake clock until the connect deadline has passed. */
async function connectPastDeadline(connect: () => Promise<unknown>): Promise<unknown> {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation(abortOnFakeClock);
  const pending = connect();
  await vi.advanceTimersByTimeAsync(CONNECT_DEADLINE_MS);
  const result = await pending;
  await vi.advanceTimersByTimeAsync(0);
  return result;
}

/** A healthy server that never answers the JSON-RPC `method`. */
function hangingOn(method: string, toolNames: string[]): Responder {
  const healthy = healthyServer(toolNames);
  return (message) =>
    message.method === method ? new Promise<Response>(() => {}) : healthy(message);
}

/**
 * Stands in for the Streamable HTTP transport: each server's responder answers
 * its JSON-RPC POSTs, and every other request (SSE GET, session DELETE) gets a 405.
 */
function stubMcpNetwork(responders: Record<string, Responder>) {
  const overrides = new Map<string, (init?: RequestInit) => Response | Promise<Response>>();
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const override = overrides.get(`${method} ${url}`);
    if (override) return override(init);
    const responder = responders[url];
    if (init?.method === "POST" && responder) {
      return responder(JSON.parse(String(init.body)) as JsonRpcMessage);
    }
    return new Response(null, { status: 405 });
  });
  vi.stubGlobal("fetch", fetchMock);

  const requestsTo = (url: string, method: string): RequestInit[] =>
    fetchMock.mock.calls
      .filter(([input, init]) => String(input) === url && (init?.method ?? "GET") === method)
      .map(([, init]) => init ?? {});

  return {
    respondTo(
      url: string,
      method: string,
      handler: (init?: RequestInit) => Response | Promise<Response>,
    ): void {
      overrides.set(`${method} ${url}`, handler);
    },
    urlsRequested(method: string): string[] {
      return fetchMock.mock.calls
        .filter(([, init]) => (init?.method ?? "GET") === method)
        .map(([input]) => String(input));
    },
    requestsTo,
    rpcRequestsTo(url: string, method: string): RequestInit[] {
      return requestsTo(url, "POST").filter(
        (init) =>
          typeof init.body === "string" &&
          (JSON.parse(init.body) as JsonRpcMessage).method === method,
      );
    },
  };
}

function healthyServer(toolNames: string[], beforeAnswering?: () => Promise<void>): Responder {
  return async (message) => {
    await beforeAnswering?.();
    switch (message.method) {
      case "initialize":
        return jsonResponse(
          message.id,
          {
            protocolVersion: NEGOTIATED_PROTOCOL_VERSION,
            capabilities: { tools: {} },
            serverInfo: { name: "fake", version: "1.0.0" },
          },
          { "mcp-session-id": "session" },
        );
      case "tools/list":
        return jsonResponse(message.id, {
          tools: toolNames.map((name) => ({
            name,
            description: name,
            inputSchema: { type: "object", properties: {} },
          })),
        });
      default:
        return new Response(null, { status: 202 });
    }
  };
}

function jsonResponse(
  id: number | undefined,
  result: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

/** Resolves once `parties` callers are waiting. */
function barrier(parties: number): () => Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  let waiting = 0;
  return async () => {
    waiting += 1;
    if (waiting === parties) resolve();
    await promise;
  };
}

/** Behaves like a fetch to a server that never answers: settles only when the request is aborted. */
function hangUntilAborted(signal: AbortSignal | null | undefined): Promise<Response> {
  const { promise, reject } = Promise.withResolvers<Response>();
  if (signal) {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }
  return promise;
}

/** Vitest's fake clock does not drive the native AbortSignal.timeout, so the abort is scheduled on the clock. */
function abortOnFakeClock(ms: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(
    () =>
      controller.abort(
        new DOMException("The operation was aborted due to timeout", "TimeoutError"),
      ),
    ms,
  );
  return controller.signal;
}

function captureLogs() {
  const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  return {
    events: () => spy.mock.calls.map(([line]) => JSON.parse(line) as Record<string, unknown>),
  };
}
