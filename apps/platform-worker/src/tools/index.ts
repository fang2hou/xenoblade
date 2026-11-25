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
 * The Worker's own tools for one generation, acting on the generation's
 * scope: the soul tools read it and can only ever propose a soul for it, and
 * the memory tools reach only this user's personal memory and this scope's
 * shared memory.
 */
export function createFirstPartyTools(env: Env, scopeId: string, userId: string): ToolSet {
  return {
    ...createSearchTools(env),
    read_url: createReadUrlTool(env),
    ...createModelInfoTools(env),
    ...createVisionTool(env),
    ...createMemoryTools({ db: env.DB, userId, scopeId }),
    ...createSoulTools(env, scopeId),
  };
}
