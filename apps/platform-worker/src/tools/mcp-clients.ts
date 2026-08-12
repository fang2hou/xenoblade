/**
 * Remote MCP client setup (ADR-008).
 */
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp";
import type { ToolSet } from "ai";

export interface McpServerConfig {
  name: string;
  url: string;
  headers?: Record<string, string>;
}

export function getMcpServers(env: Env): McpServerConfig[] {
  const servers: McpServerConfig[] = [];

  servers.push({
    name: "context7",
    url: "https://mcp.context7.com/mcp",
  });

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

export async function connectMcpServers(env: Env): Promise<McpResult> {
  const configs = getMcpServers(env);
  const clients: MCPClient[] = [];
  const allTools: ToolSet = {};

  for (const config of configs) {
    const started = Date.now();
    try {
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
      });

      const serverTools = await client.tools();
      for (const [name, tool] of Object.entries(serverTools)) {
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

export async function closeMcpClients(clients: MCPClient[]): Promise<void> {
  for (const client of clients) {
    try {
      await client.close();
    } catch {
      // non-fatal
    }
  }
}
