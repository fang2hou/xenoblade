# ADR-012: Opt-in Auto Memory with Confirmation

- **Status**: Accepted
- **Date**: 2026-08-16

## Context

ADR-005 restricted the memory system to explicit configuration: implicit learning — extracting preferences and facts from conversation history — was deferred and "requires explicit user opt-in" (ADR-005:58-60). The concern was that silent extraction turns private conversation content into durable, injected data without consent, and that wrong extractions would silently steer every future generation.

Implicit learning is nonetheless the feature users expect from an assistant that "knows" them: persona and preference commands cover deliberate customization poorly for things users do not think to declare. The design problem is giving consent real teeth — an opt-in that gates extraction, a confirmation step that gates persistence, and hard boundaries on where extraction may read at all.

## Decision

### 1. Opt-in flag, default OFF

A `learn_optin` flag in `user_settings` (Deliverable 3 of this change set), defaulting to `0`, toggled by `/learn on` / `/learn off` in DMs. `learn_optin_at` records when the opt-in was last enabled (NULL while off). Extraction runs only for messages authored by opted-in users; a non-opted-in user's messages are never scanned, even in channels where other opted-in users are present.

### 2. Guild conversations only — never DMs

Extraction is architecturally restricted to guild-scope generations: the worker skips the extraction step whenever `scopeId` is the DM sentinel, regardless of the user's flags. This holds even for users with both `chat_optin` and `learn_optin` enabled — a DM conversation may be _used_ for chat under ADR-011 but is never _mined_ for memory. This mirrors ADR-005's posture: DM content enters durable storage only through explicit commands.

### 3. Candidates are pending, confirmed by the user in DM

Extraction never writes to `user_memory` directly. The pipeline is:

1. After a guild generation completes for an opted-in user, a summarization-model pass proposes candidates `(category, key, value, confidence)`; only `fact` and `preference` categories are eligible (persona stays command-configured).
2. Candidates are inserted into a `memory_candidates` table with `status = 'pending'` and `expires_at = now + TTL`. The TTL defaults to 72 hours — long enough to review across a weekend, short enough that stale proposals do not linger.
3. The user reviews candidates in DM through the existing `/memory` command family, extended with `review` / `confirm` / `reject` subcommands (e.g. `/memory review` lists pending candidates by index, `/memory confirm 2`, `/memory reject 1-3`). No candidate is ever confirmed by default; expiry and rejection are equivalent dead ends.
4. Only `confirm` promotes a candidate: the row is copied into `user_memory` (making it eligible for prompt injection under the existing per-user block) and marked `confirmed`. Promoted entries are indistinguishable from command-created ones thereafter — same table, same injection, same `/memory clear` coverage.

### 4. Deduplication and caps

- **Dedup:** before inserting a candidate, the extractor checks for an exact `(user_id, category, key)` match against both `user_memory` and existing non-rejected candidates. A match against confirmed memory is dropped (already known); a match against a pending candidate updates its value and refreshes its TTL instead of stacking a duplicate.
- **Per-user caps:** at most 20 pending candidates and at most 50 confirmed facts+preferences per user. When a cap is hit, the oldest pending candidates (by `created_at`) are evicted first; the confirmed cap surfaces to the user in `/memory review` with a hint to clear stale entries rather than silently discarding confirmed data. Values are implementation defaults, tunable without a schema change.

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

Extraction itself is **not implemented on this branch** — this ADR fixes the consent model and schema direction so the extraction pipeline lands against a stable contract. The only shipped pieces are the `user_settings.learn_optin` flag and this decision record.

### 6. Telemetry

Candidate counts and confirm/reject outcomes are recorded as metadata events (ids, counts, statuses) in the existing structured logs. Candidate text appears only in the DM review message to its owner; it is never logged, and never written to `interactions`.

## Consequences

**Positive:**

- Consent is real and layered: opt-in gates reading, confirmation gates writing, and DMs are excluded unconditionally — the ADR-005 invariant survives implicit learning.
- Wrong extractions die cheaply: pending rows expire, rejection is one command, and nothing unconfirmed ever reaches a prompt.
- Users see and control exactly what the bot "learned", in the same command family as explicit memory.

**Negative:**

- Extraction adds a summarization-model pass per guild generation (for opted-in users only) and a D1 write path for candidates.
- The review flow adds three subcommands to `/memory` and a periodic expiry sweep (TTL enforcement on read is sufficient; a sweep is optional hygiene).
- Some users will opt in and never review candidates; their pending rows expire unconfirmed — the conservative outcome, but a flow that needs a nudge.

**Neutral:**

- `user_memory` remains the single injection source; promotion makes candidates ordinary rows, so no injection-path changes are needed.
- The 72h TTL, 20-pending, and 50-confirmed values are defaults, not schema constraints.
