# ADR-011: Opt-in DM Conversations

- **Status**: Accepted
- **Date**: 2026-08-16

## Context

ADR-005 made DMs a pure control plane: DM messages never trigger generation and never enter conversation context, because private messages must not leak into guild conversations. The recorded trade-off was that users who _want_ a private conversation with the bot cannot have one without "a separate explicit opt-in and a separate context scope."

That need is real: a command REPL is awkward for long-form private discussion, and users reasonably expect a chat experience once they have consciously asked for it. Non-negotiable: ADR-005's privacy posture — silence-by-default and structural isolation — must survive while flipping the default for a single, explicitly consenting user.

## Decision

### 1. Explicit opt-in, default OFF

A `chat_optin` flag in `user_settings` (default `0`), toggled via `/chat on` / `/chat off`; `chat_optin_at` records the last enable time (NULL while off — the flag is the single source of truth). Unrecognized DM text from non-opted-in users keeps returning the fixed help message. The check fails closed: a settings-read error treats the user as not opted in.

### 2. Control-plane routing priority is absolute

Command dispatch happens before any opt-in consideration. `/help`, `/persona`, `/preference`, `/memory`, `/chat`, and `/learn` always work — including `/chat off` itself — regardless of chat state. Only DM text matching no command is eligible for generation, and then only for opted-in users. A global operator kill switch (`bot_config.dm_enabled`) disables all DM generation independently of per-user flags.

### 3. DM-isolated context scope, enforced by keys

Isolation is architectural (key shapes), not prompt convention:

- **Scope and container keys.** DM generations use `scopeId = "dm"` and `containerId = discord:@me:<dmChannelId>`. `user_context_state` is keyed `(scope_id, container_id, user_id)`; guild rows carry a guild `scope_id` and a guild-id container segment — a guild request can never read or write a DM row. A DM channel is 1:1 with a user, so DM state is never shared.
- **Context fetch.** History is fetched live from the DM channel itself at request time; no cross-scope or cross-channel fetch exists in the pipeline.
- **Context building.** DM containers are three-segment (non-thread), so `buildContext` applies `channel` mode: only the requesting user's messages and bot replies survive filtering (defense in depth — they are the only participants anyway).
- **Memory injection.** Only the triggering user's own `user_memory` is injected. DM chat content is never _implicitly_ written to memory: DM-originated memory writes are only explicit `/persona` and `/preference` submissions, and ADR-012's extraction excludes DMs entirely.
- **Clearing.** `/clear-context` in a DM resolves to the same `discord:@me:<channelId>` container. `/chat off` additionally resets the user's DM context state — opting out ends the conversation's memory.

### 4. Privacy posture: metadata only, never content

- **Persisted:** `processed_messages` (ids), `user_context_state` (timestamps), `interactions` telemetry (container/scope/user ids, summon kind, model, token counts, durations). No DM text or generated replies are stored.
- **Logs:** guild-path logging includes a 100-character reply preview for debugging; DM-scope generations omit content previews entirely (lengths and statuses only).
- **Retention:** DM history lives only in Discord and is fetched per request; telemetry follows the existing `interactions` retention policy.

### 5. Budget interaction

DM generations flow through the identical `/internal/v1/generations` pipeline: same `processed_messages` dedup, same rolling 24h reservation budget. No separate DM quota; a DM-heavy user draws from the same shared window as their guild usage.

## Alternatives Considered

### DM chat enabled for everyone by default

- Pros: zero configuration; matches naive user expectations.
- Cons: silently reverses ADR-005's silence-by-default; private content generated-but-unconsented from day one.
- Why not chosen: consent must precede conversation, not follow it.

### Separate DM-only generation pipeline

- Pros: total code separation from the guild path.
- Cons: duplicate dedup/budget/telemetry surfaces, divergent behavior, new leak paths.
- Why not chosen: same pipeline + structural keys achieve isolation without forking the wire contract.

### Naming-convention isolation (prefix/suffix on container ids)

- Pros: no schema thinking; strings are cheap.
- Cons: a typo or refactor silently merges scopes; keys must be impossible to collide by construction, not by convention.
- Why not chosen: `@me` as the guild segment makes DM keys structurally disjoint from guild keys.

## Consequences

**Positive:** private conversations through explicit, revocable consent; isolation rests on key invariants that are cheap to test and cannot regress through prompt drift; control-plane reachability is unconditional; one pipeline, one quota, one dedup ledger.

**Negative:** two routing branches in the DM handler; the opt-in settings read adds one Worker round trip per non-command DM message; DM context exists only as Discord-side history plus a reset timestamp — once Discord's history expires, older DM context is gone.

**Neutral:** `bot_config.dm_enabled` semantics become "DM chat globally allowed for opted-in users" while still failing closed; the DM scope reuses the pre-existing `"dm"` sentinel.

## Review Triggers

- Discord ships per-channel or per-user bot privacy controls that change the threat model.
- DM abuse against the shared budget becomes observable (consider a DM sub-quota).
- Opt-in flow confuses users in practice (revisit command UX before weakening defaults).
