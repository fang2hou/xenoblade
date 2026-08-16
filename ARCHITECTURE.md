# Architecture

This document answers one question:

> **What must remain true about the current architecture?**

Keep it short and operational. It is a guardrail against accidental drift —
especially by AI agents making broad changes — not a comprehensive architecture
description.

## Invariants

- **Communication direction**: the Discord Runtime calls the Platform Worker over outbound HTTPS with a bearer token (`INTERNAL_API_TOKEN`) on `/internal/v1/*` — and that is the only path. The Worker **never** calls back the Runtime; the runtime host's inbound firewall is closed (its health port binds to `127.0.0.1` only). Everything on the Worker outside `/internal/v1/*` returns 404.
- **Credential isolation**: the Discord bot token exists only in the Runtime's environment; AI provider keys (`OPENROUTER_API_KEY`, Brave, MCP, Artificial Analysis) exist only in the Worker's. Neither set crosses the wire.
- **DM privacy**: DM content never enters AI context except in the explicitly opted-in DM scope (`/chat on`, ADR-011), whose context keys (`scopeId = "dm"`, `containerId = discord:@me:<channelId>`) cannot collide with any guild key. DM-scope logs carry lengths and statuses only — never content previews. DM content is never written to durable memory implicitly.
- **Single-shot generation** (ADR-003 + amendment): the Worker runs one `generateText` and returns one complete `GenerationResult` — no token deltas cross the wire. Runtime-side feedback is bounded: typing renewal plus a staged status placeholder capped at 4 edits per generation.
- **Per-user memory isolation**: only the triggering user's `user_memory` (persona/preferences) is injected into a generation; one user's memory never reaches another user's prompt.
- **Auto-memory consent** (ADR-012): implicit extraction may read only guild conversations of opted-in users, and may persist only after the user confirms a pending candidate. (Extraction is not yet implemented; the shipped pieces are the `learn_optin` flag and this contract.)
- **Wire contract**: `packages/contracts` is the single definition of every Runtime↔Worker message. Both apps import it verbatim; changes must stay compatible across the split or ship to both sides atomically.
- **Ownership**: the Runtime owns everything Discord (Gateway, REST, interactions, slash commands); the Worker owns everything else (models, tools, D1, MCP). Dependency direction is `apps → packages`; the two apps share no code except `packages/*`.
- **Raw fetch-handler Worker** (accepted divergence): the Worker uses no HTTP framework on purpose — it is a small, pre-existing, working service. Introducing one is a decision change, not a refactor.

## Decisions

Significant decisions are recorded as ADRs in [docs/adr/](./docs/adr/), following
the shared template from the guideline repository (Context / Decision /
Alternatives Considered / Consequences / Review Triggers).
When a request conflicts with an ADR, do not silently violate it —
follow the ADR conflict workflow in the guideline's architecture governance.

| #                                               | Decision                             | One-line summary                                                                                |
| ----------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------- |
| [002](docs/adr/002-hybrid-deployment.md)        | Hybrid Deployment Topology           | Self-hosted discord.js runtime + Cloudflare Worker, outbound-only link between them.            |
| [003](docs/adr/003-single-shot-generation.md)   | Single-Shot Generation Protocol      | One request, one complete result; bounded staged-status feedback (≤ 4 edits).                   |
| [004](docs/adr/004-two-tier-model.md)           | Two-Tier Model Architecture          | Separate model roles (generation / summarization / transcription / vision) per task.            |
| [005](docs/adr/005-dm-control-plane-memory.md)  | DM Control Plane and Per-User Memory | DMs are a configuration console by default; per-user memory, never implicit learning.           |
| [006](docs/adr/006-smart-url-reader.md)         | Smart URL Reader Pipeline            | `read_url` compresses long pages via the summarization model before the generation model.       |
| [007](docs/adr/007-brave-search-integration.md) | Brave Search and Answer Integration  | Search as first-class model tools (`web_search` / `web_answer`), no prefetch heuristics.        |
| [010](docs/adr/010-cicd-docker-ssh.md)          | CI/CD with Docker Registry and SSH   | Self-hosted registry + SSH deploys; split CI (`ci.yml` check, `deploy.yml` deploy).             |
| [011](docs/adr/011-dm-chat-optin.md)            | Opt-in DM Conversations              | DM chat behind a per-user opt-in with a dm-isolated context scope; fails closed.                |
| [012](docs/adr/012-auto-memory-optin.md)        | Opt-in Auto Memory with Confirmation | Guild-only extraction for opted-in users; pending candidates confirmed in DM, never by default. |

Retired records: **ADR-001** (Chat SDK → discord.js migration) and **ADR-009** (fresh D1 database) were fully executed one-off decisions and have been dropped. The Chat SDK stack was replaced by discord.js on a self-hosted host (ADR-002 records the resulting topology), and the production D1 database (`xenoblade`) was created fresh for the current schema — `apps/platform-worker/migrations/0001_initial.sql` still cites ADR-009 in its header for that history.
