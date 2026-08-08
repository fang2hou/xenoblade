// Integration-test worker entry. Loaded via the `main` override in
// vitest.config.ts so the pool never bundles the discord.js CJS dependency
// chain, which workerd's ESM loader cannot resolve.
//
// This entry re-exports the Durable Object classes required by the wrangler
// bindings and delegates HTTP handling to the discord-free gateway router.
// `/webhooks/discord` is intentionally unhandled here: signature verification is
// owned by @chat-adapter/discord and validated via the deployed canary, not in
// the in-process pool.
export { ChatStateDO } from "chat-state-cloudflare-do";
export { DiscordGatewayDO } from "discord-gateway-cloudflare-do";

import { handleGatewayRequest, notFound } from "../../src/gateway-routes";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await handleGatewayRequest(request, env)) ?? notFound();
  },
};
