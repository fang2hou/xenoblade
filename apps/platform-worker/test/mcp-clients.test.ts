import type { MCPClient } from "@ai-sdk/mcp";
import { afterEach, describe, expect, it, vi } from "vitest";

import { closeMcpClients, connectMcpServers } from "../src/tools/mcp-clients";

const CONTEXT7 = "https://mcp.context7.com/mcp";
const GITHUB = "https://api.githubcopilot.com/mcp/";
const CONNECT_DEADLINE_MS = 3_000;
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
      [GITHUB]: healthyServer([
        "get_me",
        "get_file_contents",
        "list_pull_requests",
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
      "github_list_pull_requests",
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
          exposedTools: 3,
          filteredTools: 3,
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

  it.each([
    { method: "initialize", sessionEstablished: false },
    { method: "tools/list", sessionEstablished: true },
  ])(
    "gives up on a server whose $method is still unanswered at the deadline",
    async ({ method, sessionEstablished }) => {
      vi.useFakeTimers();
      vi.spyOn(AbortSignal, "timeout").mockImplementation(abortOnFakeClock);
      const logs = captureLogs();
      const github = healthyServer(["get_me"]);
      const network = stubMcpNetwork({
        [CONTEXT7]: healthyServer(["resolve-library-id"]),
        [GITHUB]: (message) =>
          message.method === method ? new Promise<Response>(() => {}) : github(message),
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
      // The abandoned client is closed in the background.
      await vi.advanceTimersByTimeAsync(0);

      expect(Object.keys(result.tools)).toEqual(["context7_resolve-library-id"]);
      expect(result.clients).toHaveLength(1);
      expect(network.signalOf(GITHUB, method)?.aborted).toBe(true);
      expect(network.urlsRequested("DELETE")).toEqual(sessionEstablished ? [GITHUB] : []);
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
});

describe("closeMcpClients", () => {
  it("closes every client even when an earlier close fails", async () => {
    const network = stubMcpNetwork({
      [CONTEXT7]: healthyServer(["resolve-library-id"]),
      [GITHUB]: healthyServer(["get_me"]),
    });
    const { clients } = await connectMcpServers(ENV_WITH_GITHUB);
    const failingClose = vi.fn().mockRejectedValue(new Error("close failed"));
    const failingClient = { close: failingClose } as unknown as MCPClient;

    await expect(closeMcpClients([failingClient, ...clients])).resolves.toBeUndefined();

    expect(failingClose).toHaveBeenCalledTimes(1);
    expect(network.urlsRequested("DELETE")).toEqual([CONTEXT7, GITHUB]);
  });
});

/**
 * Stands in for the Streamable HTTP transport: each server's responder answers
 * its JSON-RPC POSTs, and every other request (SSE GET, session DELETE) gets a 405.
 */
function stubMcpNetwork(responders: Record<string, Responder>) {
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const responder = responders[String(input)];
    if (init?.method !== "POST" || !responder) return new Response(null, { status: 405 });
    return responder(JSON.parse(String(init.body)) as JsonRpcMessage);
  });
  vi.stubGlobal("fetch", fetchMock);

  function jsonRpcCalls(url: string): (RequestInit | undefined)[] {
    return fetchMock.mock.calls
      .filter(([input, init]) => String(input) === url && typeof init?.body === "string")
      .map(([, init]) => init);
  }

  return {
    urlsRequested(method: string): string[] {
      return fetchMock.mock.calls
        .filter(([, init]) => init?.method === method)
        .map(([input]) => String(input));
    },
    signalOf(url: string, method: string): AbortSignal | undefined {
      const call = jsonRpcCalls(url).find(
        (init) => (JSON.parse(String(init?.body)) as JsonRpcMessage).method === method,
      );
      return call?.signal ?? undefined;
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
            protocolVersion: "2025-06-18",
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
