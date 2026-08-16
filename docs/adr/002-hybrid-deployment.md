# ADR-002: Hybrid Deployment Topology

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

Deep Discord integration — voice channels, a persistent Gateway connection, real-time interactions — has runtime requirements Cloudflare Workers cannot satisfy:

1. **Persistent WebSocket.** Discord Gateway needs a long-lived socket with heartbeat, session resume, and reconnection; Workers are request-scoped.
2. **Bidirectional UDP.** Discord voice needs a Voice WebSocket plus UDP media transport; Workers offer outbound TCP only.
3. **DAVE E2EE.** Discord's mandatory end-to-end encryption for voice involves MLS key exchange and ratcheted media keys — computationally unsuitable for per-request serverless.

Meanwhile the AI/data layer fits Cloudflare well: stateless edge compute, D1 managed SQLite, Browser Rendering, edge caching, and built-in observability.

## Decision

Split the system into two tiers connected by a single outbound HTTPS path.

**Discord Runtime (self-hosted host):** runs `discord.js` in Docker; owns the bot token, Gateway WebSocket, interactions, REST, and future voice. All traffic is outbound; no inbound ports (the health port binds to localhost only).

**Platform Worker (Cloudflare):** pure AI/data backend — no Discord routes, no bot token. Owns AI credentials, D1, tools, and MCP clients; exposes authenticated `/internal/v1/*` endpoints only.

The Runtime calls the Worker with a shared bearer token. The Worker never calls back; the Runtime's inbound firewall stays closed.

## Alternatives Considered

### All-in on Cloudflare Workers (community Gateway DO)

- Pros: one platform, no self-hosted operations.
- Cons: no UDP (no voice), DAVE E2EE unsuitable, fragile community dependency on the critical Gateway path.
- Why not chosen: hard platform limits plus a critical-path dependency with no vendor backing.

### Fully self-hosted

- Pros: one tier, one deploy target, full control.
- Cons: lose D1, Browser Rendering, edge caching, observability; must self-host and operate every equivalent.
- Why not chosen: the AI/data layer gains nothing from self-hosting and costs real operational effort.

## Consequences

**Positive:** Discord voice becomes feasible; no community Gateway DO dependency; clean credential isolation (Discord token never leaves the Runtime, AI keys never leave the Worker); Worker stays stateless and edge-distributed; outbound-only topology minimizes attack surface.

**Negative:** two deployment targets; the self-hosted host is a single point of failure; every AI request traverses the public internet; container lifecycle, health monitoring, and disk management are on the team.

**Neutral:** CPU billing differs per tier (per-CPU-ms vs fixed host cost); `packages/contracts` becomes a hard wire dependency — version mismatches fail silently and must be CI-gated.

## Review Triggers

- Cloudflare Workers ships native persistent WebSocket and/or UDP support.
- Voice support is deprioritized or dropped from the roadmap (the strongest reason for self-hosting weakens).
- Cloudflare pricing or platform changes erase the Worker tier's cost/ops advantage.
- The contracts compatibility gate proves insufficient in practice (silent version-skew incidents).
