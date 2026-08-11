import type { XenobladeGatewayDO } from "./gateway-do";

import { timingSafeTokenMatch } from "./gateway-auth";

type GatewayControl = Pick<XenobladeGatewayDO, "connectGateway" | "disconnect" | "status">;

// `connect()` is a reserved name on DO stubs (socket-like connections), so the
// gateway exposes connectGateway() as an RPC alias (see ./gateway-do). Narrow
// the stub to the gateway method surface we actually call over RPC.
function gatewayControl(env: Env): GatewayControl {
  const id = env.DISCORD_GATEWAY.idFromName("default");
  return env.DISCORD_GATEWAY.get(id) as unknown as GatewayControl;
}

export function notFound(): Response {
  return new Response(null, { status: 404 });
}

function bearerToken(header: string | null): string | null {
  if (header === null) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match === null ? null : match[1];
}

function isControlAuthorized(request: Request, env: Env): boolean {
  return timingSafeTokenMatch(
    bearerToken(request.headers.get("Authorization")),
    env.GATEWAY_CONTROL_TOKEN,
  );
}

function isStatusAuthorized(request: Request, env: Env): boolean {
  return (
    timingSafeTokenMatch(request.headers.get("x-gateway-status-token"), env.GATEWAY_STATUS_TOKEN) ||
    isControlAuthorized(request, env)
  );
}

/**
 * Handle the gateway control-plane HTTP routes (connect / status / disconnect).
 * Returns a `Response` when the request matches a gateway route, or `null` when
 * it does not, so the caller can fall through to webhook handling or a 404.
 *
 * Intentionally kept free of the Chat SDK / discord.js dependency so it can be
 * loaded by the integration-test worker entry without pulling in node-only
 * modules that workerd cannot resolve.
 */
export async function handleGatewayRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);

  if (url.pathname === "/gateway/connect") {
    if (request.method !== "POST" || !isControlAuthorized(request, env)) {
      return notFound();
    }
    const gateway = gatewayControl(env);
    return Response.json(
      await gateway.connectGateway({
        botToken: env.DISCORD_BOT_TOKEN,
        webhookUrl: `${url.origin}/webhooks/discord`,
      }),
    );
  }

  if (url.pathname === "/gateway/status") {
    if (request.method !== "GET" || !isStatusAuthorized(request, env)) {
      return notFound();
    }
    const gateway = gatewayControl(env);
    return Response.json(await gateway.status());
  }

  if (url.pathname === "/gateway/disconnect") {
    if (request.method !== "POST" || !isControlAuthorized(request, env)) {
      return notFound();
    }
    const gateway = gatewayControl(env);
    return Response.json(await gateway.disconnect());
  }

  return null;
}
