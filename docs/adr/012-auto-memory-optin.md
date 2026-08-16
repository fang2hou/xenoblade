# ADR-012: Opt-in Auto Memory with Confirmation

- **Status**: Accepted
- **Date**: 2026-08-16

## Context

ADR-005 restricted memory to explicit configuration: implicit learning — extracting preferences and facts from conversation history — was deferred and made conditional on explicit opt-in. The concern: silent extraction turns private conversation content into durable, injected data without consent, and wrong extractions silently steer every future generation.

Implicit learning is nonetheless what users expect from an assistant that "knows" them — persona commands cover deliberate customization poorly for things users do not think to declare. The design problem is giving consent real teeth: an opt-in that gates extraction, a confirmation step that gates persistence, and hard boundaries on where extraction may read.

## Decision

### 1. Opt-in flag, default OFF

A `learn_optin` flag in `user_settings` (default `0`), toggled by `/learn on` / `/learn off` in DMs; `learn_optin_at` records the last enable time. Extraction runs only for messages authored by opted-in users — non-opted-in users are never scanned, even in channels where other opted-in users are present.

### 2. Guild conversations only — never DMs

Extraction is architecturally restricted to guild-scope generations: the worker skips the extraction step whenever `scopeId` is the DM sentinel, regardless of flags. This holds even for users with both `chat_optin` and `learn_optin` enabled — a DM conversation may be _used_ for chat under ADR-011 but is never _mined_ for memory. DM content reaches durable storage only through explicit commands (ADR-005 posture).

### 3. Candidates are pending; the user confirms in DM

Extraction never writes `user_memory` directly:

1. After a guild generation for an opted-in user, a summarization-model pass proposes candidates `(category, key, value, confidence)`; only `fact` and `preference` are eligible (persona stays command-configured).
2. Candidates land in `memory_candidates` with `status = 'pending'` and `expires_at = now + TTL` (default 72h).
3. The user reviews in DM via the `/memory` family extended with `review` / `confirm` / `reject` subcommands. Expiry and rejection are equivalent dead ends; nothing is confirmed by default.
4. Only `confirm` promotes a candidate into `user_memory`, where it becomes indistinguishable from command-created entries — same table, same injection, same `/memory clear` coverage.

### 4. Deduplication and caps

Before inserting, the extractor checks for an exact `(user_id, category, key)` match against `user_memory` and non-rejected candidates: a confirmed match is dropped (already known); a pending match updates the value and refreshes its TTL. Caps: at most 20 pending candidates and 50 confirmed facts+preferences per user; overflow evicts the oldest pending first, and the confirmed cap surfaces to the user with a hint to clear stale entries. Values are implementation defaults, tunable without schema changes.

### 5. Schema sketch

```sql
CREATE TABLE memory_candidates (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL,
  category    TEXT NOT NULL CHECK (category IN ('fact', 'preference')),
  key         TEXT NOT NULL,
  value       TEXT NOT NULL,
  confidence  REAL NOT NULL,
  source_container_id TEXT NOT NULL,   -- guild container the fact came from
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending', 'confirmed', 'rejected')),
  expires_at  INTEGER,                   -- TTL deadline, set for pending rows; NULL once terminal
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

CREATE INDEX idx_candidates_user_status
  ON memory_candidates(user_id, status, created_at);
```

Extraction itself is **not implemented yet** — this ADR fixes the consent model and schema direction so the extraction pipeline lands against a stable contract. The shipped pieces are the `user_settings.learn_optin` flag and this decision record.

### 6. Telemetry

Candidate counts and confirm/reject outcomes are logged as metadata events (ids, counts, statuses). Candidate text appears only in the DM review message to its owner — never logged, never written to `interactions`.

## Alternatives Considered

### Silent extraction for everyone

- Pros: zero user effort; the assistant "just knows".
- Cons: no consent, no review — wrong facts steer every future generation invisibly.
- Why not chosen: exactly the failure mode ADR-005 deferred.

### Write-through without confirmation

- Pros: opt-in alone gates everything; simpler flow.
- Cons: one bad extraction persists and injects until manually found and cleared.
- Why not chosen: persistence needs its own consent gate.

### Include DM conversations in extraction scope

- Pros: richer signal from private context.
- Cons: violates the ADR-005/011 posture that DM content enters durable storage only through explicit commands.
- Why not chosen: DMs may be chat (opted in) but never mined.

## Consequences

**Positive:** layered consent — opt-in gates reading, confirmation gates writing, DMs excluded unconditionally; wrong extractions die cheaply (pending rows expire; rejection is one command); users see and control exactly what the bot learned.

**Negative:** one extra summarization pass per guild generation (opted-in users only) plus a D1 write path for candidates; three new `/memory` subcommands and TTL hygiene; opted-in users who never review leave candidates to expire (conservative, but needs a nudge).

**Neutral:** `user_memory` remains the single injection source — promotion needs no injection-path changes; TTL and cap values are defaults, not schema constraints.

## Review Triggers

- The extraction pipeline ships (amend with implementation outcomes and measured quality).
- Caps (20 pending / 50 confirmed) prove wrong-sized against real usage.
- Review-flow abandonment is high enough that good candidates routinely expire (nudge UX before weakening the default-off posture).
