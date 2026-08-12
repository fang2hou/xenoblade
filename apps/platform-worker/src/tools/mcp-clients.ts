/**
 * Remote MCP client setup (ADR-008).
 *
 * Creates per-request MCP clients for allowlisted Remote Streamable HTTP
 * servers, merges their tools into a single tool map, and provides a reliable
 * close() for cleanup.
 *
 * Only Remote Streamable HTTP transport is supported (Cloudflare Worker
 * cannot run stdio MCP). All servers are explicitly allowlisted.
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

/**
 * Allowlisted MCP servers. Only these servers are connected.
 * Credentials come from Worker secrets (env).
 */
export function getMcpServers(env: Env): McpServerConfig[] {
  const servers: McpServerConfig[] = [];

  // Context7 — library documentation lookup (no auth required, lower rate limits without key)
  servers.push({
    name: "context7",
    url: "https://mcp.context7.com/mcp",
  });

  // GitHub — repository access, issues, PRs, Actions
  if (env.GITHUB_MCP_TOKEN) {
    servers.push({
      name: "github",
      url: "https://api.githubcopilot.com/mcp/",
      headers: {
        Authorization: `Bearer ${env.GITHUB_MCP_TOKEN}`,
      },
    });
  }

  return servers;
}

export interface McpResult {
  tools: ToolSet;
  clients: MCPClient[];
}

/**
 * Connect to all allowlisted MCP servers and merge their tools.
 * Returns a combined ToolSet and the clients for later cleanup.
 *
 * Connection failures are non-fatal — a failed server contributes no tools
export function getMcpServers(env: Env): McpServerConfig[] {
  // MCP disabled in Workers pending transport compatibility fix.
  // The @modelcontextprotocol/sdk uses redirect:"error" which Workers
  // rejects. Re-enable when the SDK supports Workers-compatible fetch.
  return [];

  // eslint-disable-next-line no-unreachable

  for (const config of configs) {
    const started = Date.now();
    try {
      const client = await createMCPClient({
        transport: {
          type: "http",
          url: config.url,
          headers: config.headers,
          // Workers-compatible fetch: force redirect:"follow" (Workers
          // rejects redirect:"error" which the MCP SDK uses by default)
          fetch: ((input: RequestInfo | URL, init?: RequestInit) =>
            fetch(input, { ...init, redirect: "follow" })) as typeof fetch,
        },
      });

      const serverTools = await client.tools();
      for (const [name, tool] of Object.entries(serverTools)) {
        // Namespace tools by server name to avoid collisions
        allTools[`${config.name}_${name}`] = tool as typeof allTools[string];
      }
      clients.push(client);

      console.log(
        JSON.stringify({
          event: "mcp_connected",
          server: config.name,
          tools: Object.keys(serverTools).length,
          durationMs: Date.now() - started,
        }),
      );
    } catch (error) {
      console.log(
        JSON.stringify({
          event: "mcp_connect_failed",
          server: config.name,
          error: String(error),
          durationMs: Date.now() - started,
        }),
      );
    }
  }

  return { tools: allTools, clients };
}

/**
 * Reliably close all MCP clients. Must be called in finally blocks.
 */
export async function closeMcpClients(clients: MCPClient[]): Promise<void> {
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      // non-fatal
    }
  }
}
