import type { ToolSet } from "ai";

import { createReadUrlTool } from "./read-url";
import { createSearchTools } from "./search";
import { createModelInfoTools } from "./model-info";

export { isUrlSafe } from "./ssrf";
export { createReadUrlTool } from "./read-url";
export { createSearchTools } from "./search";
export { createModelInfoTools } from "./model-info";
export { connectMcpServers, closeMcpClients } from "./mcp-clients";

/**
 * Build first-party tool map (non-MCP) for the generation pipeline.
 * MCP tools are added separately in generation.ts via connectMcpServers().
 */
export function createFirstPartyTools(env: Env): ToolSet {
  return {
    ...createSearchTools(env),
    read_url: createReadUrlTool(env),
    ...createModelInfoTools(env),
  };
}
