# ADR-013: Intent-Based Memory Writes with Reaction Confirmation

- **Status**: Accepted (amends the DM-write clause of ADR-012; amended 2026-11-25 — user-level writes now execute at once, guild-level memory is button-confirmed, and the reaction confirmation is retired, see the amendment below)
- **Date**: 2026-08-17

## Context

ADR-005 restricted durable memory to explicit DM text commands, and ADR-012
deferred implicit extraction behind an opt-in + pending/confirm pipeline that
is still unimplemented. Between those two poles sits the case users actually
hit: _"记住这个，下次我会问你"_ — an explicit, in-conversation instruction to
remember something, phrased naturally rather than through a command. Handling
it well needs intent recognition, not keyword matching: the instruction may be
indirect ("keep that in mind"), mixed with other content, or absent entirely.

Research anchors (surveyed 2026-08): mycontext keeps humans in charge of
irreversible writes; Mem0 recognizes/consolidates memories with the LLM itself
against what it already knows; TencentDB Agent Memory treats memory as
governed per-owner assets. All three decompose to the same primitives —
model-recognized intent, a confirmation gate, per-user storage, and injection
into future prompts — which this architecture already has most of.

## Decision

### 1. The generation model is the intent recognizer

Two first-party tools, `remember(key, value, category?)` and
`forget(key, category?)`, are available to every generation model in every
scope (guild and DM chat alike). A tool call **is** the recognized intent —
no separate extraction pass, no keyword list. Static system-prompt guidance
bounds their use to explicit user requests about the current user, tells the
model to consolidate related items, and forbids claiming success without the
tool. `learn_optin` is **not** required here: it gates system-initiated
extraction (ADR-012), whereas an explicit ask plus a confirmation reaction is
consent in itself.

### 2. Proposals are stateless until confirmed

The tools write nothing during generation. Their outputs are collected from
`toolResults` (the same pattern as citation sources) into
`GenerationResult.memoryProposals`, and the Runtime posts one confirmation
message listing the proposals with ✅ / ❌ reactions. Only the triggering
user's reaction acts; ✅ executes the batch against
`POST /internal/v1/memory/proposals`, ❌ drops it, and the window expires
after 5 minutes. Statelessness means a failed model-chain attempt leaves no
orphan rows, and a runtime restart simply orphans pending confirmations —
fail-closed, nothing was written.

### 3. `user_memory` stays the single source

Confirmed saves upsert into `user_memory` (fact/preference only — persona
remains command-configured), confirmed forgets delete by key, and the
confirmed cap is 50 fact+preference rows (`memory_full` surfaces the hint).
Injection is unchanged except for one fix: the system-prompt memory block now
includes `fact` entries, which were previously stored but never injected —
the model must see what it knows for updates and dedup to work.

### 4. Consent model relative to ADR-012

ADR-012's rule 2 says DM content reaches durable storage "only through
explicit commands". This ADR adds the second sanctioned path: **explicit
natural-language intent, confirmed by the user's own reaction**. Two gates
(instent + confirmation) replace the command grammar; the privacy posture is
unchanged — nothing implicit, nothing unconfirmed, nothing about other users.
ADR-012's extraction pipeline (guild mining for opted-in users, pending
candidates, TTL) remains the design for implicit learning, unchanged.

### Amendment (2026-11-25): two memory tiers, one confirmation rule

Decisions 1–3 above describe a single tier — the triggering user's own
memory — written only after a reaction. Memory now has two tiers, and only
the shared tier keeps a confirmation gate.

1. **One tool set for both tiers.** `memory_list`, `memory_save`, and
   `memory_delete` replace `remember` / `forget`. Each write tool takes a
   `scope`.
2. **`user` — the triggering user's own memory, written at once.** On their
   explicit request, `memory_save` and `memory_delete` execute inside the
   tool against `user_memory`, strictly bound to the request's `userId`, and
   report the real outcome (`saved`, `deleted`, `not_found`, or an error such
   as `memory_full`) for the model to pass on. No confirmation card follows:
   personal memory has one owner, the person who asked, and the same tools
   plus `/memory`, `/persona`, and `/preference` let them audit and undo it.
   The 50-entry cap on fact + preference still applies.
3. **`guild` — the server's shared memory, confirmed by button.** The new
   table `guild_memory` (migration 0008) holds shared knowledge per server,
   at most 100 entries, injected into guild conversations only — never into a
   DM. Every guild-level write (save, update, delete) stays stateless during
   generation: the tool returns a proposal that travels in
   `GenerationResult.guildMemoryProposals`, and nothing reaches `guild_memory`
   until the triggering user clicks 是 on the card (不是 drops it, 5-minute
   window, owner-only, fail-closed after a restart). The card lists every
   proposed key and value verbatim, and `POST /internal/v1/memory/guild/apply`
   stores exactly those bytes, refusing any that are not already normalized.
   Guild writes are refused in a DM (`dm_not_allowed`).
4. **Buttons replace reactions.** The memory card is a Discord message with
   是 / 不是 buttons (`xbl:gmem:<choice>:<cardId>`), built to the same
   discipline as the soul card. The Runtime no longer listens to
   `messageReactionAdd`, so the `GuildMessageReactions` intent and the
   reaction partial are removed, and `POST /internal/v1/memory/proposals` goes
   with the reaction flow it served.
5. **One normalization.** `normalizeMemoryKey` and `normalizeMemoryValue`
   (trim, 64 / 500 code points, empty rejected) apply to both tiers: a tool
   normalizes once when it saves or proposes, and apply refuses anything that
   is not in that form.

Why the gate moved rather than disappeared: a confirmation step protects
whoever owns the data from a change they did not ask for. For personal memory
that owner is the person who made the request, so their explicit ask is the
consent. Shared memory affects every member of the server, and only the
asker consented, so that tier keeps the gate. Decision 4 therefore changes
for DMs as well: DM content still reaches durable storage only through
explicit commands or the user's explicit natural-language ask, and for their
own memory that ask no longer needs a reaction. ADR-012's implicit
extraction keeps its own opt-in and pending/confirm pipeline, unchanged.

## Alternatives Considered

### Keyword/regex intent matching in the Runtime

- Pros: no model cost, deterministic.
- Cons: exactly the brittle non-understanding the request rejected; indirect
  phrasing ("下次我会问你") misses; false positives on quotes.
- Why not chosen: intent recognition belongs in the model.

### ADR-012-style pending candidates with 72h TTL and review commands

- Pros: user can confirm long after the fact; durable pending state.
- Cons: designed for unattended extraction; an attended explicit ask needs no
  D1-backed queue, and unreviewed candidates become silent data retention.
- Why not chosen: the in-flight confirmation window matches the attended
  flow; ADR-012's substrate stays available for extraction.

### Model writes memory directly in the tool

- Pros: one less round trip.
- Cons: persistence before consent; failed chains leave orphans; no gate.
- Why not chosen: the confirmation gate is the point.

_Reconsidered by the 2026-11-25 amendment:_ adopted for user-scope writes, where the triggering user's explicit ask is the consent. The cons still hold for guild-scope writes, which keep the gate.

## Consequences

**Positive:** natural-language memory that users can steer ("帮我记住…",
"忘掉…"); zero durable state before confirmation; a single memory store with
one injection path; the asymmetry of injected-but-uninjected `fact` rows is
gone.

**Negative:** one extra Discord message per proposing generation; proposals
from a generation whose confirm message was missed simply expire (the model
did tell the user to confirm); the 5-minute window is shorter than a review
queue would be.

**Neutral:** reaction handling grows a second registry mirroring
`ReplyRegistry`; `/memory show|clear` remain the audit and reset paths.

## Review Triggers

- Users routinely miss the 5-minute window (raise it or add a pending list).
- The model proposes unprompted often enough that confirmations feel noisy
  (tighten the guidance or require `learn_optin` in guilds).
- ADR-012's extraction ships and the two write paths need unifying.
