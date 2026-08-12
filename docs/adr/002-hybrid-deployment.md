# ADR-002: Hybrid Deployment Topology

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

Discord bots that aim for deep platform integration — voice channels, persistent Gateway connections, real-time interactions — have runtime requirements that Cloudflare Workers cannot satisfy:

1. **Persistent WebSocket.** Discord Gateway requires a long-lived WebSocket with heartbeat, session resume, and automatic reconnection. Workers are request-scoped; they cannot maintain persistent connections natively (the current workaround uses a community Durable Object, which is fragile and feature-limited).

2. **Bidirectional UDP.** Discord voice requires a Voice WebSocket plus a bidirectional UDP socket for media transport. Workers only provide outbound TCP via `connect()` — no UDP support at all.

3. **DAVE E2EE.** As of March 2026, Discord requires DAVE end-to-end encryption for all voice/video. This protocol involves MLS key exchange and per-sender ratcheted media keys — computationally unsuitable for per-request serverless.

At the same time, the AI and data layer benefits strongly from Cloudflare's platform:

1. **Edge compute.** AI orchestration (prompt building, tool calling, model routing) is stateless and CPU-light — ideal for Workers.

2. **D1.** Managed SQLite with global read replicas provides configuration, budgeting, idempotency, and audit storage without database operations.

3. **Browser Rendering.** Cloudflare's managed headless Chrome (`@cloudflare/puppeteer` binding) provides dynamic web page rendering without self-hosting Chromium.

4. **Cache API.** Edge caching of search results and URL content reduces external API calls and latency.

5. **Observability.** Built-in structured logging and metrics for Workers and D1.

## Decision

Split the system into two runtime tiers connected by a single outbound HTTPS path:

**Discord Runtime (self-hosted host):**
- Runs `discord.js` in a Docker container on a dedicated long-running host.
- Owns the Discord bot token, Gateway WebSocket, all Interactions, REST calls, and future voice.
- All network traffic is **outbound**: Gateway WebSocket to Discord, HTTPS to the Cloudflare Worker. No inbound ports required.

**Platform Worker (Cloudflare):**
- Pure AI/data backend. No Discord routes, no bot token.
- Owns AI model credentials, D1, Browser Rendering, R2, Cache, and MCP clients.
- Exposes authenticated internal endpoints (`/internal/v1/*`) called only by the Discord Runtime.

**Communication:** The Discord Runtime calls the Worker via outbound HTTPS with a shared bearer token. The Worker never calls back to the Runtime. This makes the Runtime's firewall fully closed inbound (SSH excluded), which is a significant security property.

## Consequences

**Positive:**
- Discord voice becomes feasible (native UDP on a standard Linux host).
- No community Gateway DO dependency.
- Clean credential isolation: Discord token never leaves the Runtime; AI keys never leave the Worker.
- Worker remains stateless and edge-distributed.
- Browser Rendering and D1 stay on Cloudflare without self-hosting equivalents.
- Outbound-only network topology simplifies firewall rules and reduces attack surface.

**Negative:**
- Two deployment targets increase operational complexity.
- The self-hosted host is a single point of failure (no global redundancy like Workers).
- Every AI request traverses the public internet between the two tiers.
- Docker process lifecycle, health monitoring, and disk management become the team's responsibility.

**Neutral:**
- CPU billing differs between tiers: Workers bill per CPU millisecond; the host bills at fixed monthly cost regardless of utilization.
- The internal API contract (`packages/contracts`) becomes a hard dependency — version mismatches cause silent failures and must be CI-gated.
