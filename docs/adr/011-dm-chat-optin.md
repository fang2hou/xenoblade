# ADR-011: Opt-in DM Conversations

- **Status**: Accepted
- **Date**: 2026-08-16

## Context

ADR-005 made DMs a pure control plane: DM messages never trigger AI generation and never enter conversation context, because private messages must not leak into guild conversations. The recorded trade-off (ADR-005:73) was that users who _want_ a private conversation with the bot cannot have one without "a separate explicit opt-in and a separate context scope."

That need is real: treating the DM channel as a command REPL is awkward for long-form private discussion, and users reasonably expect a chat experience once they have consciously asked for it. The constraint that remains non-negotiable is ADR-005's privacy posture — silence-by-default and structural isolation. Any DM chat feature must preserve both while flipping the default for a single, explicitly consenting user.

## Decision

### 1. Explicit opt-in, default OFF

DM chat is gated per user by a `chat_optin` flag in the new `user_settings` table (Deliverable 3 of this change set), defaulting to `0`. The flag toggles via the DM control-plane commands `/chat on` and `/chat off`; `chat_optin_at` records when the opt-in was last enabled (NULL while off, so the flag remains the single source of truth). Unrecognized DM text from non-opted-in users keeps returning the fixed help message — the ADR-005 default is unchanged.

The opt-in check fails closed: if the settings read errors, the user is treated as not opted in.

### 2. Control-plane routing priority is absolute

Command dispatch happens before any opt-in consideration. `/help`, `/persona`, `/preference`, `/memory`, `/chat`, and `/learn` are always interpreted as commands — even when chat is enabled — so a user can always reach configuration (including `/chat off` itself) regardless of chat state. Only DM text that matches _no_ command is eligible for generation, and then only for opted-in users. A global operator kill switch is retained: the existing `bot_config.dm_enabled` runtime gate disables all DM generation independently of per-user flags.

### 3. DM-isolated context scope, enforced by keys

Isolation is architectural (key shapes and fetch paths), not a prompt convention:

- **Scope and container keys.** DM generations use `scopeId = "dm"` and `containerId = discord:@me:<dmChannelId>`. `user_context_state` is keyed `(scope_id, container_id, user_id)`; guild rows carry a guild `scope_id` and a container whose second segment is the guild id. A guild request can therefore never read or write a DM row — the keys cannot collide. A DM channel is 1:1 with a user, so one user's DM state is never shared with another.
- **Context fetch.** History is fetched live from the DM channel itself at request time (same `fetchHistory` path as guild channels). No cross-scope or cross-channel history fetch exists anywhere in the pipeline, so DM text cannot surface in a guild prompt.
- **Context building.** DM containers are three-segment (non-thread) containers, so `buildContext` applies `channel` mode: only the requesting user's messages and bot replies survive filtering. In a DM those are the only participants anyway; the filter is defense in depth.
- **Memory injection.** Only the triggering user's own `user_memory` is injected into their DM reply — the same user-scoped injection as guild generations, never another user's data. DM chat and history content is never _implicitly_ written to `user_memory`: the only DM-originated writes are values a user explicitly submits via the `/persona` and `/preference` control-plane commands (the ADR-005 path), and ADR-012's future extraction excludes DMs entirely.
- **Clearing.** `/clear-context` invoked in a DM resolves to the same `discord:@me:<channelId>` container, so the existing command covers the DM scope with no special casing. Additionally, `/chat off` resets the user's DM context state, so opting out also ends the conversation's memory.

### 4. Privacy posture

What the system retains about a DM conversation is metadata, never content:

- **Persisted server-side:** `processed_messages` stores the message id (dedup); `user_context_state` stores reset/interaction timestamps; `interactions` telemetry stores container/scope/user ids, summon kind, model, token counts, and durations. None of these tables stores DM text or generated replies.
- **Logs:** the guild path logs a 100-character reply preview for debugging; DM-scope generations omit content previews entirely (lengths and statuses only). No DM text is logged at any stage.
- **Retention:** there is no DM content to retain — history lives only in Discord and is fetched per request. Telemetry rows follow the existing `interactions` retention policy.
- **Clear path:** `/clear-context` in the DM (per-container) and `/chat off` (automatic on opt-out), as above. `/memory clear` covers user memory as before.

### 5. Budget interaction

DM generations flow through the identical `/internal/v1/generations` pipeline, so they are subject to the same `processed_messages` dedup and count against the same rolling 24h reservation budget (`BUDGET_MAX_TOKENS`) as guild generations. There is no separate DM quota, and opting in does not increase a user's budget; a DM-heavy user consumes the same shared window their guild usage draws from.

## Consequences

**Positive:**

- Users get private bot conversations through an explicit, revocable consent action; the privacy default for everyone else is exactly ADR-005's.
- Isolation rests on key invariants (scope/container shapes), which are cheap to test and cannot regress through prompt drift.
- Control-plane reachability is unconditional — an opted-in user can always turn chat off or manage memory.
- No new budget surface: one pipeline, one quota, one dedup ledger.

**Negative:**

- Two routing branches in the DM handler (commands vs. opted-in chat) — the opt-in settings read adds one Worker round trip per non-command DM message.
- DM context lives only as Discord-side history plus a reset timestamp; after Discord's own history expires, older DM context is simply gone (no server-side reconstruction).

**Neutral:**

- `bot_config.dm_enabled` semantics change from "DMs are never chat" to "DM chat is globally allowed for opted-in users" while still failing closed (missing key ⇒ enabled, explicit `0` ⇒ disabled).
- The DM scope reuses the `"dm"` sentinel already present in the worker's schema and runtime-config gate.
