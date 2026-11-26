# ADR-016: Owner-Approved Discord Server Administration

- **Status**: Accepted
- **Date**: 2026-11-26 (records PR #30, #31, #32, and #34)

## Context

Operating a Discord community often requires repetitive server administration tasks: creating or reorganizing channels, updating role permissions, bulk-applying permission overwrites, and adjusting guild settings. Doing this conversationally with an LLM assistant is valuable, but granting an LLM direct Discord write access introduces severe risks:

1. **Credential isolation (ADR-002)**: `DISCORD_BOT_TOKEN` must never enter the Platform Worker; the Worker cannot call Discord REST APIs directly.
2. **Prompt injection**: ordinary guild members can post in public channels or propose guild-level `bot_soul` / `guild_memory` changes that could manipulate an admin session.
3. **Unreviewed destructive mutations**: an LLM must never execute server mutations unilaterally or lock the owner or bot out of the administration channel.
4. **Replay and drift**: double-clicking an approval button or mutating parameters between preview and execution could apply unintended changes.

## Decision

Introduce an owner-only, approval-gated server administration mode that stays strictly inside the two-tier credential boundary (ADR-002):

1. **Four-factor fail-closed gate**: admin tools (`discord_api_read` and `admin_plan_*`) are mounted only when `ADMIN_GUILD_ID` and `ADMIN_OWNER_USER_ID` are valid snowflakes configured on both tiers, the request matches both IDs, and the Runtime verifies the channel (and its parent, for threads) is private, independently corroborated against `publicChannelIds`.
2. **Prompt-injection isolation**: admin sessions omit guild-writable `bot_soul` and `guild_memory` from the system prompt and substitute fixed `ADMIN_GUIDANCE`.
3. **Runtime-proxied read-only hops**: when the model calls `discord_api_read`, the Worker stops the turn and returns bounded read requests (up to 5 reads per hop, up to 6 continuation hops) to the Runtime. The Runtime executes read-only Discord REST GETs using its local bot token and sends the sanitized results back without double-charging the 24h generation budget.
4. **Frozen SHA-256 plans with CAS claiming**: write-planning tools never mutate Discord. They persist a frozen `AdminActionPlan` (at most 30 REST operations, 10-minute TTL, SHA-256 payload digest, risk classification, and anti-lockout validation on the active admin channel/parent) in D1 (`admin_action_plans`).
5. **Owner approval and verbatim execution**: the Runtime renders a deterministic approval card (with Approve / Cancel buttons and optional `admin-action-plan.txt` attachment when > 2000 chars). Only the configured owner may approve; clicking Approve atomically claims the plan (`pending -> executing`) via single-statement CAS on `/internal/v1/admin/plans/claim`, updates the card in place while executing the exact frozen REST calls with Audit Log reasons, and records the outcome via `/internal/v1/admin/plans/complete`.

## Alternatives Considered

### Give the Worker direct access to `DISCORD_BOT_TOKEN`

- Pros: simpler single-hop tool execution without read continuation hops.
- Cons: breaks ADR-002 credential isolation and exposes the Discord bot token to the AI/tool execution tier.
- Why not chosen: credential isolation is a foundational invariant of Xenoblade.

### Execute low-risk server writes immediately without confirmation

- Pros: fewer clicks for routine edits.
- Cons: a single misunderstood request or prompt injection from channel names/topics could alter live server structure before the owner sees it.
- Why not chosen: deterministic preview + explicit owner click keeps blast radius zero before approval.

### Keep approval state only in Runtime memory

- Pros: avoids D1 migration and internal plan endpoints.
- Cons: restarts break live cards and leave no durable audit trail or atomic cross-process CAS claim.
- Why not chosen: D1 persistence (`0011_admin_action_plans.sql`) guarantees replay safety, digest verification, and auditability across restarts.

## Consequences

- **Positive**: preserves ADR-002 credential isolation; blocks public-channel prompt injection via `bot_soul`/`guild_memory` omission; prevents double execution and preview/execution drift; enforces anti-lockout guards and Audit Log attribution.
- **Negative**: requires `GuildMembers` privileged intent on the Runtime, extra `/internal/v1/admin/plans/*` routes, elevated generation timeouts (`120s` per attempt / `180s` chain deadline / `195s` Runtime timeout) for bulk reasoning, and syncing `ADMIN_GUILD_ID` + `ADMIN_OWNER_USER_ID` to both tiers.
- **Neutral**: disabled by default (fail-closed) when either `ADMIN_*` variable is unset.

## Review Triggers

- Multi-admin or role-based approval is needed beyond a single configured owner.
- Discord API rate limits or plan sizes exceed the 30-operation / 6-read-hop bounds in practice.
- Admin tooling grows enough to warrant splitting `apps/platform-worker/src/tools/admin-tools.ts` into per-resource planning modules.
