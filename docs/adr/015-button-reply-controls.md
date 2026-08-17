# ADR-015: Button Reply Controls and In-Place Regenerate

- **Status**: Accepted
- **Date**: 2026-08-17

## Context

Bot replies carried two emoji reactions as affordances — 🔁 regenerate and 🗑 delete — dispatched through `messageReactionAdd`. Three problems with that implementation:

1. **Broken regenerate UX.** The reaction handler posted the regenerated answer as a _new_ reply and left the old one in place, then downgraded the new reply to delete-only because the Worker allowed exactly one regenerate per original message (`claimRegenerate` wrote a permanent `regen:<id>` row into `processed_messages`). Users saw two answers, and the second could never be regenerated.
2. **Reaction mechanics.** Reactions are imprecise (no explicit affordance surface), need `MANAGE_MESSAGES` to clean up a clicker's own react, require variation-selector-tolerant emoji matching, and invite third-party clicks that had to be filtered by user id comparison.
3. **Policy mismatch.** The once-per-message lifetime cap was stricter than intended: the rolling budget (1024-token reservation per generation, 200k tokens / 24h per container) already bounds total spend. The claim's real job is rejecting _racing duplicates_, not rationing deliberate re-runs.

## Decision

1. **Native buttons replace reactions.** Every completed bot reply carries one action row: Regenerate (🔁 + localized label, `Secondary`) and Delete (🗑️, `Danger`), with customIds `xbl:regen:<headMessageId>` / `xbl:del:<headMessageId>`. Button labels follow the triggering user's UI language (zh default) — the language is already resolved in the generation path, so no extra fetch is needed at reply time; the Disable button is emoji-only by design.
2. **Interaction dispatch.** `interactionCreate` routes message-component interactions. Only the triggering user may act; anyone else gets an ephemeral refusal (`flags: MessageFlags.Ephemeral`, the current discord.js v14 idiom). Memory confirmations (ADR-013) stay on ✅/❌ reactions — they are a separate message family and unchanged.
3. **Regenerate edits in place.** The click is acknowledged by disabling both buttons (`interaction.update`). The re-run reuses the staged-status pattern (ADR-003 amendment) with the _existing head message_ as the placeholder: milestones edit it, the result replaces its content, surplus continuation chunks of the old answer are deleted, and the buttons are re-enabled on the new content. The regenerated reply keeps full controls — every completed answer is regenerable again.
4. **Failure restores.** A failed, rejected, or erroring re-run puts the previous content back with its buttons re-enabled instead of overwriting the answer with a failure notice; budget-exceeded and error outcomes additionally notify the clicker through an ephemeral follow-up on the spent interaction.
5. **Restart safety.** The reply registry stays in-memory (bounded, FIFO). Buttons on old messages after a restart — or any customId this process cannot resolve — fail closed: a graceful ephemeral "expired" notice, no action, no crash.
6. **Worker policy: lease, not cap.** `claimRegenerate` takes a short-lived lease on `regenerate_leases` (new table, migration 0006; the legacy `regen:*` rows in `processed_messages` are inert orphans). Racing duplicate deliveries are rejected as `duplicate`; the Worker releases the lease when the run settles, and an unreleased lease self-heals after a 15-minute TTL (crash backstop). The rolling budget remains the only bound on deliberate re-runs; the contracts' `regenerateOf` JSDoc records this.

### Relation to ADR-003

The staged-status bounds are unchanged: ≤ 4 placeholder edits per generation (escalations ≤ 3 plus the final replacement). Two component-level edits sit outside that placeholder budget by design: the one-per-completed-reply components-attach edit (a fresh reply cannot embed its own not-yet-assigned message id in its customIds at send time), and the one disable-buttons acknowledgment per regenerate click. Both are single bounded REST calls, not edit loops.

## Alternatives Considered

### Keep reactions, fix only the regenerate flow

- Pros: no interaction routing, smaller diff.
- Cons: keeps `MANAGE_MESSAGES` cleanup, emoji-matching fragility, and a two-message UX for in-place semantics; buttons are Discord's first-class affordance for exactly this.
- Why not chosen: the interaction surface also buys ephemeral refusals and restart-safe expiry notices, which reactions cannot express.

### Delete-and-repost on regenerate

- Pros: reuses the fresh-post path verbatim.
- Cons: the old message lingers for the full generation latency (the reported bug), and the reply's position in the channel history is lost.
- Why not chosen: editing in place is the UX users expect from a regenerate control.

### Keep the once-per-message cap, re-arm after success

- Pros: no new table.
- Cons: D1 rows keyed `regen:<id>` would need update-in-place semantics anyway, conflating permanent dedup records with transient locks in `processed_messages`.
- Why not chosen: a dedicated lease table states the actual invariant — one in-flight re-run per original message.

## Consequences

**Positive:** one message per answer at all times; every completed reply is regenerable; third-party clicks are refused with visible feedback; expired buttons degrade gracefully; the Worker's dedup now matches the real concurrency concern; no reaction-cleanup permissions needed.

**Negative:** one extra REST edit per completed reply and one per regenerate click (see ADR-003 relation); buttons on pre-migration messages from before a restart show the expiry notice until they scroll away; the regenerate lease adds a small D1 table.

**Neutral:** `GatewayMessageReactions` and the reaction partials remain required for ADR-013 confirmations; the reply registry stays in-memory and bounded — eviction and restart share the same fail-closed expiry path.

Merging to main auto-deploys both apps (CI deploy pipeline); the wire contract change (`regenerateOf` semantics) ships atomically with both sides.

## Review Triggers

- Discord changes interaction-token lifetimes such that the ephemeral follow-up window no longer covers a full generation.
- Regenerate abuse emerges that the rolling budget does not adequately price (revisit rate limiting per user, not per message).
- The components-attach edit shows up in rate-limit telemetry as a hot path (fold components into the settle edit for placeholder runs).
