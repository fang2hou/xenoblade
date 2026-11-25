import type { ToolSet } from "ai";
import type { GenerationRequest } from "@xenoblade/contracts";

import { getAdminConfig, isAdminSession } from "../admin-plans";
import {
  createAdminTools,
  extractAdminOperations,
  extractDiscordReadRequests,
  stoppedOnDiscordRead,
} from "./admin-tools";
import {
  createInteractionTools,
  extractAskPrompt,
  hasRetry,
  hasThreadPause,
  pauseThread,
  stoppedOnAskUser,
} from "./interaction-tools";
import { createHistoryTools } from "./history-tools";
import { createMemoryTools } from "./memory-tools";
import { createReadUrlTool } from "./read-url";
import { createSearchTools } from "./search";
import { createVisionTool } from "./vision";
import { createSoulTools } from "./soul-tools";

export { isUrlSafe } from "./ssrf";
export { createReadUrlTool } from "./read-url";
export { createSearchTools } from "./search";
export { createVisionTool } from "./vision";
export { connectMcpServers, closeMcpClients } from "./mcp-clients";
export {
  createAdminTools,
  extractAdminOperations,
  extractAskPrompt,
  extractDiscordReadRequests,
  hasRetry,
  hasThreadPause,
  pauseThread,
  stoppedOnAskUser,
  stoppedOnDiscordRead,
};

/**
 * The Worker's own tools for one generation, acting on the generation's
 * request: the soul tools read its scope and can only ever propose a soul for
 * it, the memory tools reach only its user's personal memory and its scope's
 * shared memory, and the history tools read only the stored history of its
 * guild, its allowlisted public channels, and no further back in the current
 * channel than `resetAt` — the triggering user's context watermark (ADR-014).
 *
 * Server administration tools exist ONLY in verified owner-only private admin
 * sessions (`isAdminSession`) and are completely absent everywhere else.
 */
export function createFirstPartyTools(env: Env, req: GenerationRequest, resetAt: number): ToolSet {
  const adminConfig = isAdminSession(env, req) ? getAdminConfig(env) : null;
  const protectedChannelIds = [
    ...new Set([
      req.channelId,
      ...(req.parentChannelId ? [req.parentChannelId] : []),
      ...(req.adminProtectedChannelIds ?? []),
    ]),
  ];
  return {
    ...createSearchTools(env),
    read_url: createReadUrlTool(env),
    ...createVisionTool(env),
    ...createMemoryTools({ db: env.DB, userId: req.userId, scopeId: req.scopeId }),
    ...createSoulTools(env, req.scopeId),
    ...createHistoryTools({
      db: env.DB,
      scopeId: req.scopeId,
      channelId: req.channelId,
      parentChannelId: req.parentChannelId ?? null,
      ...(req.publicChannelIds === undefined ? {} : { publicChannelIds: req.publicChannelIds }),
      resetAt,
    }),
    ...createInteractionTools({ db: env.DB, req, resetAt }),
    ...(adminConfig === null
      ? {}
      : createAdminTools({
          config: adminConfig,
          protectedChannelIds,
          readResults: req.adminReadResults ?? [],
        })),
  };
}
