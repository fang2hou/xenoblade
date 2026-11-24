/**
 * Remote MCP client setup (ADR-008).
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

const MCP_CONNECT_TIMEOUT_MS = 3_000;

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
        "get_issue",
        "list_pull_requests",
        "get_pull_request",
        "get_pull_request_files",
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

export async function connectMcpServers(env: Env): Promise<McpResult> {
  const configs = getMcpServers(env);
  const clients: MCPClient[] = [];
  const allTools: ToolSet = {};

  const connections = await Promise.allSettled(configs.map(connectServer));

  for (const connection of connections) {
    if (connection.status === "rejected") continue;
    clients.push(connection.value.client);
    Object.assign(allTools, connection.value.tools);
  }

  return { tools: allTools, clients };
}

export async function closeMcpClients(clients: MCPClient[]): Promise<void> {
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      // non-fatal
    }
  }
}

interface McpConnection {
  client: MCPClient;
  tools: ToolSet;
  exposedTools: number;
  filteredTools: number;
}

async function connectServer(config: McpServerConfig): Promise<McpConnection> {
  const started = Date.now();
  const signal = AbortSignal.timeout(MCP_CONNECT_TIMEOUT_MS);

  try {
    const connection = await openServer(config, signal);
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

async function openServer(config: McpServerConfig, signal: AbortSignal): Promise<McpConnection> {
  const client = await createMCPClient({
    transport: {
      type: "http",
      url: config.url,
      headers: config.headers,
      // Workers needs both fixes:
      // 1. fetch.bind(globalThis) — avoids "Illegal invocation" when
      //    the SDK stores globalThis.fetch as a bare reference
      // 2. redirect: "follow" — Workers rejects the SDK default "error"
      redirect: "follow",
      fetch: fetch.bind(globalThis),
    },
    initializationOptions: { signal },
  });

  try {
    // client.tools() takes no signal; listing here keeps the whole setup under the deadline.
    const definitions = await client.listTools({ options: { signal } });
    return {
      client,
      ...exposeAllowedTools(config, client.toolsFromDefinitions(definitions)),
    };
  } catch (error) {
    // Closing is a session DELETE to a server that just failed: never let it hold up the result.
    void client.close().catch(() => undefined);
    throw error;
  }
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
