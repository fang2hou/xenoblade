# ADR-005: DM Control Plane and Per-User Memory

- **Status**: Accepted (scope of DM chat later extended by ADR-011; implicit learning later consent-gated by ADR-012 — both preserve this ADR's privacy posture)
- **Date**: 2026-08-12

## Context

The original implementation treated DMs as a regular chat scope: every DM message triggered AI generation, and DM content entered conversation context alongside guild messages. That is a privacy problem — private messages could surface in guild conversations via context windows or tool results.

Separately, users need per-user customization (persona, preferences, facts) that follows them across channels without ever affecting another user's responses.

## Decision

### DM as control plane

DMs do **not** trigger AI generation and do **not** enter any conversation context. DMs are a configuration interface:

| Command                      | Effect                    |
| ---------------------------- | ------------------------- |
| `/persona set/show/clear`    | Manage the user's persona |
| `/preference set/list/clear` | Manage preferences        |
| `/memory show/clear`         | View or clear all memory  |
| `/help`                      | List commands             |

Unrecognized DM text gets a fixed help message, not an AI response. _(Extended by ADR-011: non-command DM text from explicitly opted-in users may generate, in a dm-isolated scope.)_

### Per-user memory

A `user_memory` table stores persona, preferences, and facts keyed by `user_id`. When a user triggers the bot in any guild channel or thread, only **that user's** memory is injected into the system prompt.

### No implicit learning

Only explicit DM-command configuration; implicit extraction from conversations requires explicit opt-in. _(Specified by ADR-012: guild-only extraction, opt-in plus pending/confirm.)_

## Alternatives Considered

### DM as normal chat scope (status quo)

- Pros: chat-like DM UX with zero gating.
- Cons: private content can leak into guild prompts — privacy by hope.
- Why not chosen: the leak is architectural, not fixable by prompting.

### Privacy by prompt convention

- Pros: no routing changes.
- Cons: an instruction, not a boundary — one prompt regression away from disclosure.
- Why not chosen: isolation must be structural (routing and key shapes), not conventional.

### Global bot persona / shared memory

- Pros: one configuration, simpler schema.
- Cons: every user's prompt inherits every other user's settings.
- Why not chosen: cross-user leakage of personalization data.

## Consequences

**Positive:** DM content never enters AI context by default — enforced at the architecture level; customization never crosses users; memory follows users across guild channels.

**Negative:** no private AI conversations in DMs by design (later addressed for consenting users by ADR-011); one extra D1 read per generation to load the triggering user's memory.

**Neutral:** DM commands are processed in the Discord Runtime; memory reads/writes go through the Worker's `/internal/v1/memory` endpoint.

## Review Triggers

- Users systematically need private DM conversations → ADR-011 already covers this; revisit if its consent model proves too restrictive.
- Memory volume strains the system-prompt budget (cap or compress per-user memory).
- A request for group-shared memory arrives (needs a new consent and isolation model, not an edit here).
