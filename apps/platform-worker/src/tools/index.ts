import type { ToolSet } from "ai";

import { createMemoryTools } from "./memory-tools";
import { createReadUrlTool } from "./read-url";
import { createSearchTools } from "./search";
import { createModelInfoTools } from "./model-info";
import { createVisionTool } from "./vision";
import { createSoulTools } from "./soul-tools";

export { isUrlSafe } from "./ssrf";
export { createReadUrlTool } from "./read-url";
export { createSearchTools } from "./search";
export { createModelInfoTools } from "./model-info";
export { createVisionTool } from "./vision";
export { connectMcpServers, closeMcpClients } from "./mcp-clients";

/**
 * The Worker's own tools for one generation. `scopeId` is the generation's
 * scope: the soul tools act on it — `soul_read` reports its soul and
 * `soul_update` can only ever propose a soul for it.
 */
export function createFirstPartyTools(env: Env, scopeId: string): ToolSet {
  return {
    ...createSearchTools(env),
    read_url: createReadUrlTool(env),
    ...createModelInfoTools(env),
    ...createVisionTool(env),
    ...createMemoryTools(),
    ...createSoulTools(env, scopeId),
  };
}
