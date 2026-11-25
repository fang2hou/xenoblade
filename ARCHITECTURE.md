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

- **platform-worker** — the Cloudflare Worker: `/internal/v1/*` routes with bearer auth, the generation pipeline (budget, dedup, memory injection, model chains), first-party tools (`web_search`, `web_answer`, `read_url`, `vision_describe`), the 90-day guild message history index (D1 + FTS5) with its read-only tools (`get_recent_messages`, `search_chat_history`, `get_message_context`), the interaction tools (`ask_user`, `retry_last_reply`, `thread_pause`) with thread sessions and last-turn snapshots, MCP clients, and the D1 access layer
- **discord-runtime** — the self-hosted gateway: discord.js client, trigger policy, auto-started discussion threads and their followed sessions, per-container conversation queue, staged status, `ask_user` question cards, 是 / 不是 confirmation cards (soul, guild memory), slash commands, the DM control plane, and the batched history ingest that keeps the Worker's message index in step with Discord
- **contracts** — wire types for every runtime↔worker call; shared verbatim by both apps
- **ai** — model chains per role (generation/summarization/transcription/vision) via the OpenRouter provider, system-prompt composition, generation limits
- **db** — legacy D1 helpers from the pre-split worker; unreferenced
- **deploy / scripts** — docker-compose definition for the gateway host; local deploy tooling

## Invariants

What must remain true about the architecture:

- **Communication direction**: the Discord Runtime calls the Platform Worker over outbound HTTPS with a bearer token (`INTERNAL_API_TOKEN`) on `/internal/v1/*` — and that is the only path. The Worker **never** calls back the Runtime; the runtime host's inbound firewall is closed (its health port binds to `127.0.0.1` only). Everything on the Worker outside `/internal/v1/*` returns 404.
- **Credential isolation**: the Discord bot token exists only in the Runtime's environment; AI provider keys (`OPENROUTER_API_KEY`, Brave, MCP, Artificial Analysis) exist only in the Worker's. Neither set crosses the wire.
- **DM privacy**: DM content never enters AI context except in the explicitly opted-in DM scope (`/chat on`, ADR-011), whose context keys (`scopeId = "dm"`, `containerId = discord:@me:<channelId>`) cannot collide with any guild key. DM-scope logs carry lengths and statuses only — never content previews. DM content is never written to durable memory implicitly, and never to a turn snapshot either: `container_last_turns` and `thread_sessions` hold guild conversations only.
- **Single-shot generation** (ADR-003 + amendments): the Worker runs one `generateText` and returns one complete `GenerationResult` — no token deltas cross the wire. Runtime-side feedback is bounded: typing renewal plus a staged status placeholder capped at 4 edits per generation. A turn that stops on `ask_user` is still one complete result: its content is the question, and the answer is a later, separate generation.
- **Followed threads** (ADR-003 amendment): a thread is started only where the Worker answers — the Runtime asks the generation gate before `startThread`, so a disabled guild or a channel off the allowlist gets no empty thread — and used only if the bot can post in it. A thread is followed only from a summon in it — one the Runtime started on a mention, or a later explicit one — and `thread_sessions` (`active`, pending card ids; never message text) is the record: a row belongs to the guild that registered it, and no read or change reaches it without that guild. Un-summoned messages summon the bot in a followed thread alone, gated by a two-layer relevance check (deterministic Runtime filter for replies to others, leading `@other` mentions, and system messages, plus a conditional Worker semantic gate via `POST /internal/v1/threads/should-reply` in multi-participant or side-talk threads before typing or dismissing question cards); a bot's or a webhook's message never summons. The model can stop the following (`thread_pause`), and only a completed reply makes that stick.
- **Question cards** (ADR-003 amendment): `ask_user` is stateless on the Worker — a question lives in the result and, as one card, on Discord, until answered. Only the user who was asked can click. A click and a typed reply are both carried out inside the conversation's queue, so they never both answer or clear each other's record; each deletes every waiting card before its generation runs, and only a card confirmed gone comes off the record. The choice comes back as that generation's own message.
- **Asking again** (ADR-015, superseded): a reply carries no controls. `retry_last_reply` hands the model the conversation's latest turn — `container_last_turns` in a guild, the request's history in a DM — and a prompt sent before the triggering user's context watermark (ADR-014) is never brought back, however often its reply is redone since. A message that only asked for a redo is not a prompt: the walk back goes past it to the question actually asked. The redone answer is a new reply; nothing is edited in place.
- **Per-user memory isolation**: only the triggering user's `user_memory` (persona/preferences/facts) is injected into a generation; one user's memory never reaches another user's prompt.
- **Guild history index** (`allowed-channels-90d`): `guild_messages` + `guild_messages_fts` hold a reconstructible index of the last 90 days of a guild's **allowed public channels** — never a DM. The Runtime indexes only channels `@everyone` can read (a private thread never) and streams message creates, edits, and deletes to `POST /internal/v1/messages/ingest`; the Worker stores a message only when the guild is enabled and its channel passes `allow_channels_json` (a thread through a listed parent), refuses the `dm` scope, and prunes expired rows as part of ingest. Every write is keyed by the guild, so a request can only touch its own guild's rows. The three history tools exist in guild generations only, and every read is scoped to the generation's guild, the 90-day window, the allowlist, the channels that are public at read time (a channel made private afterwards is no longer readable), and — in the channel the generation runs in — the triggering user's context truncation (ADR-014).
- **User memory writes** (ADR-013, amended 2026-11-25): on the triggering user's explicit request, `memory_save` / `memory_delete` write the triggering user's own `user_memory` at once — bound to the request's `userId`, so no generation can reach another user's memory — and report the real outcome to the model. DM write consent = explicit ask (ADR-012's command-only clause is amended, not abandoned); implicit extraction keeps its own opt-in.
- **Guild memory** (ADR-013 amendment): `guild_memory` holds a server's shared knowledge (at most 100 entries), injected into guild conversations only — never into a DM. The generation model can only propose changes to it (`scope: "guild"`); the proposal is stateless until the triggering user clicks 是 on its card (不是 drops it, 5-minute window), and only that click makes the Runtime call `POST /internal/v1/memory/guild/apply`, which stores exactly the key and value the card showed. Nothing reaches `guild_memory` without the confirmation, and no guild write is possible from a DM.
- **Button-confirmed soul writes**: the generation model proposes a persona change for a guild through `soul_update`, never writes it. The proposal is stateless until the triggering user clicks 是 on its confirmation card (不是 drops it, 5-minute window); only that click makes the Runtime call `POST /internal/v1/soul/apply`, which stores the exact text the card showed. Nothing reaches `bot_soul` without the confirmation, a DM cannot change a soul, and a guild's soul never reaches a DM.
- **Wire contract**: `packages/contracts` is the single definition of every Runtime↔Worker message. Both apps import it verbatim; changes must stay compatible across the split or ship to both sides atomically.
- **Ownership**: the Runtime owns everything Discord (Gateway, REST, interactions, slash commands); the Worker owns everything else (models, tools, D1, MCP). Dependency direction is `apps → packages`; the two apps share no code except `packages/*`.
- **Raw fetch-handler Worker** (accepted divergence): the Worker uses no HTTP framework on purpose — it is a small, pre-existing, working service. Introducing one is a decision change, not a refactor.

## Cross-Cutting Concerns

- **Logging**: structured JSON only — `console.log(JSON.stringify({ event, ... }))`, one line per event, on both tiers. No event carries a reply preview or a provider error message: replies can echo personal or shared memory and provider text can quote a request, so generation logs hold lengths, counts, statuses, and error names. DM-scope events never include content previews. History ingest and search events carry ids, counts, timings, and error names only — never message text or a search query.

## Decisions

Significant decisions are recorded as ADRs in [docs/adr/](./docs/adr/), following
the shared template from the guidelines repository (Context / Decision /
Alternatives Considered / Consequences / Review Triggers).
When a request conflicts with an ADR, do not silently violate it —
follow the ADR conflict workflow in the guidelines' architecture governance.

| #                                                  | Decision                             | One-line summary                                                                                                                                                  |
| -------------------------------------------------- | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [002](docs/adr/002-hybrid-deployment.md)           | Hybrid Deployment Topology           | Self-hosted discord.js runtime + Cloudflare Worker, outbound-only link between them.                                                                              |
| [003](docs/adr/003-single-shot-generation.md)      | Single-Shot Generation Protocol      | One request, one complete result; bounded staged-status feedback (≤ 4 edits); auto-started followed threads and `ask_user` question cards (2026-11-25 amendment). |
| [004](docs/adr/004-two-tier-model.md)              | Two-Tier Model Architecture          | Separate model roles (generation / summarization / transcription / vision) per task.                                                                              |
| [005](docs/adr/005-dm-control-plane-memory.md)     | DM Control Plane and Per-User Memory | DMs are a configuration console by default; per-user memory, never implicit learning.                                                                             |
| [006](docs/adr/006-smart-url-reader.md)            | Smart URL Reader Pipeline            | `read_url` compresses long pages via the summarization model before the generation model.                                                                         |
| [007](docs/adr/007-brave-search-integration.md)    | Brave Search and Answer Integration  | Search as first-class model tools (`web_search` / `web_answer`), no prefetch heuristics.                                                                          |
| [008](docs/adr/008-mcp-integration.md)             | MCP Integration Scope                | Remote Streamable HTTP servers only; read-only tools; server + tool allowlists.                                                                                   |
| [010](docs/adr/010-cicd-docker-ssh.md)             | CI/CD with Docker Registry and SSH   | Self-hosted registry + SSH deploys; split CI (`ci.yml` check, `deploy.yml` deploy).                                                                               |
| [011](docs/adr/011-dm-chat-optin.md)               | Opt-in DM Conversations              | DM chat behind a per-user opt-in with a dm-isolated context scope; fails closed.                                                                                  |
| [012](docs/adr/012-auto-memory-optin.md)           | Opt-in Auto Memory with Confirmation | Guild-only extraction for opted-in users; pending candidates confirmed in DM, never by default.                                                                   |
| [013](docs/adr/013-intent-memory-writes.md)        | Intent-Based Memory Writes           | Model-recognized memory intent; user writes land at once, guild writes need a yes click (amends ADR-012's DM-write clause).                                       |
| [014](docs/adr/014-undoable-context-truncation.md) | Undoable Context Truncation          | `/context truncate`/`restore` over an undo stack with an irreversible hard-reset floor for clears.                                                                |
| [015](docs/adr/015-button-reply-controls.md)       | Button Reply Controls (superseded)   | Reply-control buttons and in-place regenerate; superseded 2026-11-25 by the natural-language `retry_last_reply` tool.                                             |

Retired records: **ADR-001** (Chat SDK → discord.js migration) and **ADR-009** (fresh D1 database) were fully executed one-off decisions and have been dropped. The Chat SDK stack was replaced by discord.js on a self-hosted host (ADR-002 records the resulting topology), and the production D1 database (`xenoblade`) was created fresh for the current schema — `apps/platform-worker/migrations/0001_initial.sql` still cites ADR-009 in its header for that history.
