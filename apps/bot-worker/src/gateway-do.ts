import { DiscordGatewayDO } from "discord-gateway-cloudflare-do";
import type { GatewayCredentials } from "discord-gateway-cloudflare-do";

/**
 * Project subclass of {@link DiscordGatewayDO}.
 *
 * `connect()` is a reserved method name on Durable Object stubs — set aside
 * for socket-like connections — so it cannot be invoked over RPC: calling
 * `stub.connect(...)` hits the reserved socket entry point (which rejects with
 * "not an integer", expecting a port) instead of the Gateway's connect logic.
 * This subclass exposes `connectGateway()` as an RPC-callable alias that
 * delegates to the inherited `connect()` from *inside* the DO, where the
 * reserved-name shadowing does not apply.
 *
 * `disconnect()` and `status()` are not reserved names and work over RPC.
 */
export class XenobladeGatewayDO<TEnv = unknown> extends DiscordGatewayDO<TEnv> {
  async connectGateway(credentials: GatewayCredentials) {
    return this.connect(credentials);
  }
}
