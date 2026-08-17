# Architecture

This document orients new contributors and guards the design against
accidental drift — especially by AI agents making broad changes. Keep it short
and stable: a map of the country, not an atlas of its states. Revisit it
occasionally; do not try to keep it synchronized with the code.

## Overview

Xenoblade is a Discord AI assistant split into two tiers: a self-hosted
discord.js runtime that owns the Discord connection, and a Cloudflare Worker
that owns AI generation, tools, and data. The runtime calls the worker over
outbound HTTPS with a bearer token; the worker never calls back. Models are
routed through OpenRouter with per-role fallback chains, and all durable state
lives in D1.

## Codebase Map

- **platform-worker** — the Cloudflare Worker: `/internal/v1/*` routes with bearer auth, the generation pipeline (budget, dedup, memory injection, model chains), first-party tools (`web_search`, `web_answer`, `read_url`, `vision_describe`, model-info), MCP clients, and the D1 access layer
- **discord-runtime** — the self-hosted gateway: discord.js client, trigger policy, per-container conversation queue, staged status, reply affordances (regenerate/delete), slash commands, and the DM control plane
- **contracts** — wire types for every runtime↔worker call; shared verbatim by both apps
- **ai** — model chains per role (generation/summarization/transcription/vision) via the OpenRouter provider, system-prompt composition, generation limits
- **db** — legacy D1 helpers from the pre-split worker; unreferenced
- **deploy / scripts** — docker-compose definition for the gateway host; local deploy tooling

## Invariants

What must remain true about the architecture:

- **Communication direction**: the Discord Runtime calls the Platform Worker over outbound HTTPS with a bearer token (`INTERNAL_API_TOKEN`) on `/internal/v1/*` — and that is the only path. The Worker **never** calls back the Runtime; the runtime host's inbound firewall is closed (its health port binds to `127.0.0.1` only). Everything on the Worker outside `/internal/v1/*` returns 404.
- **Credential isolation**: the Discord bot token exists only in the Runtime's environment; AI provider keys (`OPENROUTER_API_KEY`, Brave, MCP, Artificial Analysis) exist only in the Worker's. Neither set crosses the wire.
- **DM privacy**: DM content never enters AI context except in the explicitly opted-in DM scope (`/chat on`, ADR-011), whose context keys (`scopeId = "dm"`, `containerId = discord:@me:<channelId>`) cannot collide with any guild key. DM-scope logs carry lengths and statuses only — never content previews. DM content is never written to durable memory implicitly.
- **Single-shot generation** (ADR-003 + amendment): the Worker runs one `generateText` and returns one complete `GenerationResult` — no token deltas cross the wire. Runtime-side feedback is bounded: typing renewal plus a staged status placeholder capped at 4 edits per generation.
- **Per-user memory isolation**: only the triggering user's `user_memory` (persona/preferences/facts) is injected into a generation; one user's memory never reaches another user's prompt.
- **Intent-based memory writes** (ADR-013): the generation model proposes memory changes through the `remember`/`forget` tools on explicit user intent; proposals are stateless until the user confirms them with a ✅ reaction (❌ drops, 5-minute window). Nothing reaches `user_memory` without that confirmation. DM write consent = explicit ask + reaction (ADR-012's command-only clause is amended, not abandoned); implicit extraction keeps its own opt-in.
- **Wire contract**: `packages/contracts` is the single definition of every Runtime↔Worker message. Both apps import it verbatim; changes must stay compatible across the split or ship to both sides atomically.
- **Ownership**: the Runtime owns everything Discord (Gateway, REST, interactions, slash commands); the Worker owns everything else (models, tools, D1, MCP). Dependency direction is `apps → packages`; the two apps share no code except `packages/*`.
- **Raw fetch-handler Worker** (accepted divergence): the Worker uses no HTTP framework on purpose — it is a small, pre-existing, working service. Introducing one is a decision change, not a refactor.

## Cross-Cutting Concerns

- **Logging**: structured JSON only — `console.log(JSON.stringify({ event, ... }))`, one line per event, on both tiers. DM-scope events never include content previews (lengths and statuses only).

## Decisions

Significant decisions are recorded as ADRs in [docs/adr/](./docs/adr/), following
the shared template from the guidelines repository (Context / Decision /
Alternatives Considered / Consequences / Review Triggers).
When a request conflicts with an ADR, do not silently violate it —
follow the ADR conflict workflow in the guidelines' architecture governance.

| #                                                  | Decision                             | One-line summary                                                                                                            |
| -------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| [002](docs/adr/002-hybrid-deployment.md)           | Hybrid Deployment Topology           | Self-hosted discord.js runtime + Cloudflare Worker, outbound-only link between them.                                        |
| [003](docs/adr/003-single-shot-generation.md)      | Single-Shot Generation Protocol      | One request, one complete result; bounded staged-status feedback (≤ 4 edits).                                               |
| [004](docs/adr/004-two-tier-model.md)              | Two-Tier Model Architecture          | Separate model roles (generation / summarization / transcription / vision) per task.                                        |
| [005](docs/adr/005-dm-control-plane-memory.md)     | DM Control Plane and Per-User Memory | DMs are a configuration console by default; per-user memory, never implicit learning.                                       |
| [006](docs/adr/006-smart-url-reader.md)            | Smart URL Reader Pipeline            | `read_url` compresses long pages via the summarization model before the generation model.                                   |
| [007](docs/adr/007-brave-search-integration.md)    | Brave Search and Answer Integration  | Search as first-class model tools (`web_search` / `web_answer`), no prefetch heuristics.                                    |
| [008](docs/adr/008-mcp-integration.md)             | MCP Integration Scope                | Remote Streamable HTTP servers only; read-only tools; server + tool allowlists.                                             |
| [010](docs/adr/010-cicd-docker-ssh.md)             | CI/CD with Docker Registry and SSH   | Self-hosted registry + SSH deploys; split CI (`ci.yml` check, `deploy.yml` deploy).                                         |
| [011](docs/adr/011-dm-chat-optin.md)               | Opt-in DM Conversations              | DM chat behind a per-user opt-in with a dm-isolated context scope; fails closed.                                            |
| [012](docs/adr/012-auto-memory-optin.md)           | Opt-in Auto Memory with Confirmation | Guild-only extraction for opted-in users; pending candidates confirmed in DM, never by default.                             |
| [013](docs/adr/013-intent-memory-writes.md)        | Intent-Based Memory Writes           | Model-recognized memory intent; reaction-confirmed proposals; stateless until confirmed (amends ADR-012's DM-write clause). |
| [014](docs/adr/014-undoable-context-truncation.md) | Undoable Context Truncation          | `/context truncate`/`restore` over an undo stack with an irreversible hard-reset floor for clears.                          |

Retired records: **ADR-001** (Chat SDK → discord.js migration) and **ADR-009** (fresh D1 database) were fully executed one-off decisions and have been dropped. The Chat SDK stack was replaced by discord.js on a self-hosted host (ADR-002 records the resulting topology), and the production D1 database (`xenoblade`) was created fresh for the current schema — `apps/platform-worker/migrations/0001_initial.sql` still cites ADR-009 in its header for that history.
