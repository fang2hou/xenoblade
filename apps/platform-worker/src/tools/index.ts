import type { ToolSet } from "ai";

import { createReadUrlTool } from "./read-url";
import { createSearchTools } from "./search";
import { createModelInfoTools } from "./model-info";
import { createVisionTool } from "./vision";

export { isUrlSafe } from "./ssrf";
export { createReadUrlTool } from "./read-url";
export { createSearchTools } from "./search";
export { createModelInfoTools } from "./model-info";
export { createVisionTool } from "./vision";
export { connectMcpServers, closeMcpClients } from "./mcp-clients";

export function createFirstPartyTools(env: Env): ToolSet {
  return {
    ...createSearchTools(env),
    read_url: createReadUrlTool(env),
    ...createModelInfoTools(env),
    ...createVisionTool(env),
  };
}
