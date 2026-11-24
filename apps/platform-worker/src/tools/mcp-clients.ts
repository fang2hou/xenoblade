/**
 * Remote MCP client setup (ADR-008).
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

const MCP_CONNECT_TIMEOUT_MS = 3_000;
const MCP_SESSION_DELETE_TIMEOUT_MS = 2_000;

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
  /** ADR-008 tool allowlist: tools the server offers but this list omits are never exposed. */
  allowedTools: readonly string[];
}

export function getMcpServers(env: Env): McpServerConfig[] {
  const servers: McpServerConfig[] = [];

  servers.push({
    name: "context7",
    url: "https://mcp.context7.com/mcp",
    allowedTools: ["resolve-library-id", "query-docs", "get-library-docs"],
  });

  if (env.GITHUB_MCP_TOKEN) {
    servers.push({
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: `Bearer ${env.GITHUB_MCP_TOKEN}`,
      },
      allowedTools: [
        "get_me",
        "get_file_contents",
        "search_code",
        "search_repositories",
        "search_issues",
        "list_issues",
        "issue_read",
        "search_pull_requests",
        "list_pull_requests",
        "pull_request_read",
        "list_commits",
        "get_commit",
        "list_branches",
      ],
    });
  }

  return servers;
}

export interface McpResult {
  tools: ToolSet;
  clients: MCPClient[];
}

export interface McpConnectOptions {
  /** Keeps background session cleanup alive once the response is sent (Workers `ctx.waitUntil`). */
  waitUntil?: (promise: Promise<unknown>) => void;
}

export async function connectMcpServers(
  env: Env,
  options: McpConnectOptions = {},
): Promise<McpResult> {
  const configs = getMcpServers(env);
  const clients: MCPClient[] = [];
  const allTools: ToolSet = {};

  const connections = await Promise.allSettled(
    configs.map((config) => connectServer(config, options.waitUntil)),
  );

  for (const connection of connections) {
    if (connection.status === "rejected") continue;
    clients.push(connection.value.client);
    Object.assign(allTools, connection.value.tools);
  }

  return { tools: allTools, clients };
}

export async function closeMcpClients(clients: MCPClient[]): Promise<void> {
  await Promise.allSettled(clients.map((client) => client.close()));
}

interface McpConnection {
  client: MCPClient;
  tools: ToolSet;
  exposedTools: number;
  filteredTools: number;
}

async function connectServer(
  config: McpServerConfig,
  waitUntil: McpConnectOptions["waitUntil"],
): Promise<McpConnection> {
  const started = Date.now();
  const signal = AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS);

  try {
    const connection = await openServer(config, signal, waitUntil);
    console.log(
      JSON.stringify({
        event: "mcp_connected",
        server: config.name,
        exposedTools: connection.exposedTools,
        filteredTools: connection.filteredTools,
        durationMs: Date.now() - started,
      }),
    );
    return connection;
  } catch (error) {
    console.log(
      JSON.stringify({
        event: "mcp_connect_failed",
        server: config.name,
        timedOut: signal.aborted,
        error: String(error),
        durationMs: Date.now() - started,
      }),
    );
    throw error;
  }
}

async function openServer(
  config: McpServerConfig,
  signal: AbortSignal,
  waitUntil: McpConnectOptions["waitUntil"],
): Promise<McpConnection> {
  const client = await openClient(config, signal, waitUntil);

  try {
    // client.tools() takes no signal; listing here keeps the whole setup under the deadline.
    const definitions = await client.listTools({ options: { signal } });
    return {
      client,
      ...exposeAllowedTools(config, client.toolsFromDefinitions(definitions)),
    };
  } catch (error) {
    // Closing is a session DELETE to a server that just failed: never let it hold up the result.
    cleanupInBackground(client.close(), waitUntil);
    throw error;
  }
}

async function openClient(
  config: McpServerConfig,
  signal: AbortSignal,
  waitUntil: McpConnectOptions["waitUntil"],
): Promise<MCPClient> {
  let sessionId: string | undefined;
  const fetchFn = withBoundedSessionDelete(fetch.bind(globalThis));

  try {
    return await createMCPClient({
      transport: {
        type: "http",
        url: config.url,
        headers: config.headers,
        // Workers needs both fixes:
        // 1. fetch.bind(globalThis) — avoids "Illegal invocation" when
        //    the SDK stores globalThis.fetch as a bare reference
        // 2. redirect: "follow" — Workers rejects the SDK default "error"
        redirect: "follow",
        fetch: fetchFn,
        onSessionIdChange: (id) => {
          sessionId = id;
        },
      },
      initializationOptions: { signal },
    });
  } catch (error) {
    // Once the deadline aborts the handshake, the SDK tears its transport down
    // without the session DELETE, so a session the server already opened is ended here.
    if (sessionId !== undefined && signal.aborted) {
      cleanupInBackground(deleteSession(fetchFn, config, sessionId), waitUntil);
    }
    throw error;
  }
}

/** Session cleanup must not delay the result, but it has to outlive the response in Workers. */
function cleanupInBackground(
  cleanup: Promise<unknown>,
  waitUntil: McpConnectOptions["waitUntil"],
): void {
  const settled = cleanup.catch(() => undefined);
  if (waitUntil) waitUntil(settled);
}

/**
 * The SDK deletes the server session on close() without any signal. Cap every
 * session DELETE so a server that stopped answering cannot hold up teardown.
 */
function withBoundedSessionDelete(fetchFn: typeof fetch): typeof fetch {
  return (input, init) =>
    init?.method === "DELETE"
      ? fetchFn(input, { ...init, signal: AbortSignal.timeout(MCP_SESSION_DELETE_TIMEOUT_MS) })
      : fetchFn(input, init);
}

async function deleteSession(
  fetchFn: typeof fetch,
  config: McpServerConfig,
  sessionId: string,
): Promise<void> {
  await fetchFn(config.url, {
    method: "DELETE",
    headers: { ...config.headers, "mcp-session-id": sessionId },
    redirect: "follow",
  });
}

function exposeAllowedTools(
  config: McpServerConfig,
  serverTools: Record<string, unknown>,
): Pick<McpConnection, "tools" | "exposedTools" | "filteredTools"> {
  const allowedTools = new Set(config.allowedTools);
  const tools: ToolSet = {};
  let filteredTools = 0;

  for (const [name, tool] of Object.entries(serverTools)) {
    if (!allowedTools.has(name)) {
      filteredTools += 1;
      continue;
    }
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP Tool and AI SDK ToolSet are structurally compatible
    tools[`${config.name}_${name}`] = tool as ToolSet[string];
  }

  return { tools, exposedTools: Object.keys(tools).length, filteredTools };
}
