import type { ToolSet } from "ai";

import { createReadUrlTool } from "./read-url";
import { createSearchTools } from "./search";

export { isUrlSafe } from "./ssrf";
export { createReadUrlTool } from "./read-url";
export { createSearchTools } from "./search";

/**
 * Build the full tool map for the generation pipeline.
 *
 * Returns `{ web_search, web_answer, read_url }` as an AI SDK `ToolSet`
 * suitable for `generateText`. All tools degrade gracefully — they return
 * structured errors rather than throwing.
 */
export function createAllTools(env: Env): ToolSet {
  return {
    ...createSearchTools(env),
    read_url: createReadUrlTool(env),
  };
}
