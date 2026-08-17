# ADR-014: Undoable Context Truncation with a Hard-Reset Floor

- **Status**: Accepted (redefines the `/clear-context` feature surface)
- **Date**: 2026-08-17

## Context

Conversation history is never persisted: the Runtime refetches it from
Discord per generation, and the Worker filters it against a per-user
`user_context_state.reset_at` watermark. `/clear-context` therefore never
cleared anything — it pushed the watermark forward (a truncation) and offered
no way back. Users asked for the honest model: truncate at a point in time,
and be able to undo it, so recent messages can re-enter reference after a
mistake or a topic switch.

One operation must stay irreversible: `/chat off` (ADR-011) hard-clears the
DM context on opt-out for privacy. An undo that could revive history past
that clear would violate the opt-out posture.

## Decision

### 1. Two commands replace `/clear-context`

`/context truncate` pushes an undoable truncation at `now`: messages older
than the cutoff are excluded from reference. `/context restore` pops the
newest truncation for this user+container; repeated restores walk the stack
back toward full history. Both are per-user, per-container — the same
granularity the watermark already had.

### 2. Watermark = max(hard floor, undoable stack)

- `context_truncations` rows are the undo stack. `truncate` inserts one and
  moves `reset_at` forward; `restore` deletes the newest and recomputes
  `reset_at = max(hard_reset_at, MAX(remaining truncated_at))`.
- `hard_reset_at` is the irreversible floor. Every clear operation
  (`/context/clear` endpoint — today `/chat off`) stamps it alongside
  `reset_at`. A restore never crosses it: if a hard clear landed after the
  truncation being popped, the effective cutoff stays at the floor and
  `restored` reports `false`.
- `reset_at` remains the hot-path read; the stack is consulted only by
  restore. Migration 0004 backfills `hard_reset_at = reset_at` (every
  pre-existing watermark came from a clear) — past clears get no retroactive
  undo.

### 3. Wire surface is additive

`ContextClearRequest`/`Result` are untouched (`/chat off` keeps calling
them); `ContextTruncate*` and `ContextRestore*` are new contract types on new
routes (`/internal/v1/context/truncate`, `/internal/v1/context/restore`).
Command registration PUTs the full final list — `context` replaces
`clear-context` in one atomic registration.

## Alternatives Considered

### Delete message rows on truncate

- Pros: "clear" becomes literal.
- Cons: history lives in Discord, not D1 — there is nothing to delete, and
  persisted copies would be a new privacy surface.
- Why not chosen: the watermark is the right primitive for live-refetched
  history.

### Single-level undo (store previous watermark only)

- Pros: one column, no new table.
- Cons: one mistake deeper than the last truncation is unrecoverable; no
  clean place to express the hard floor interplay.
- Why not chosen: an explicit stack is barely more code and composes with the
  floor naturally.

### Restore by message count / channel-wide scope

- Pros: "give me back the last N messages" is直观.
- Cons: watermarks are timestamps; counting requires persisting history or
  fuzzy time math; channel-wide truncation entangles every user's undo stack.
- Why not chosen: point-in-time + per-user stack matches the existing
  granularity exactly.

## Consequences

**Positive:** truncation becomes honest and reversible; the ADR-011 opt-out
clear remains absolute; effective cutoff stays a single indexed read on the
generation path.

**Negative:** one new table and one column; two new routes; `/context
restore` reports `false` without explaining that a hard floor held (the
common case is simply "nothing to undo").

**Neutral:** old `/clear-context` muscle memory breaks once (one-time command
rename); `clearUserContext`'s channel/all scope variants remain
worker-supported but runtime-unused, as before.

## Review Triggers

- Users want channel-wide or time-window truncation for real (extend the
  event model, not the floor).
- The undo stack grows unbounded for a user+container (it is bounded by
  truncation count; add pruning only if that ever matters).
