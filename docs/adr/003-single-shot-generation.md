# ADR-003: Single-Shot Generation Protocol

- **Status**: Accepted (amended 2026-08-16 and 2026-11-25 — see [Amendment (2026-08-16)](#amendment-2026-08-16) and [Amendment (2026-11-25)](#amendment-2026-11-25))
- **Date**: 2026-08-12

## Context

The initial design considered streaming AI output to Discord via progressive message editing — a placeholder message updated as tokens arrive. Three problems:

1. **CPU cost.** Workers bill per CPU millisecond; per-chunk parsing, edit throttling, and repeated Discord REST `PATCH` calls produce no user-visible value.
2. **Discord REST rate limits.** A generation with 50 edits is 50 REST calls; edit bursts risk `429` backoffs across concurrent channels.
3. **Typing indicator sufficiency.** Discord's typing indicator is the standard "working" UX; users do not expect character streaming in a chat client.

## Decision

Adopt a single-shot response protocol:

1. On valid trigger, the Runtime sends **one** typing indicator.
2. The Runtime calls the Worker, which runs the full generation pipeline (model + tools) and returns one complete `GenerationResult` JSON.
3. The Runtime posts the final message **once**; results over Discord's 2000-character limit are sliced into sequential messages — no editing loop.
4. No token deltas are transmitted between the Worker and Runtime.
5. No placeholder messages. _(Superseded within bounds by the 2026-08-16 amendment.)_
6. No periodic typing renewal. _(Superseded by the amendment's accepted drift.)_

## Alternatives Considered

### Token streaming with progressive edits

- Pros: perceived real-time UX.
- Cons: per-chunk CPU billing, Discord rate-limit exposure, complex edit/backoff machinery for cosmetic value.
- Why not chosen: cost and fragility with no functional gain.

### Zero-feedback wait (single typing indicator only, never renewed)

- Pros: absolute minimum REST surface.
- Cons: the indicator expires after ~10s; long generations look hung.
- Why not chosen: the amendment's bounded feedback (typing renewal + staged placeholder) covers this without streaming.

## Consequences

**Positive:** minimal Worker CPU per generation (one `generateText` call, one JSON response); minimal Discord REST per generation (one typing + one send, plus bounded placeholder edits); no rate-limit risk from edit bursts; simple request/response protocol with structured errors.

**Negative:** no streaming UX; long generations (10–30s, multi-step research) need the staged-status mechanism to communicate progress.

**Neutral:** the Worker uses `generateText` (tool loops natively supported) rather than `streamText`.

## Amendment (2026-08-16)

This amendment records accepted drift and authorizes one bounded addition. The original decision otherwise remains binding.

### Accepted drift: typing renewal

Commit `6068f97` ("feat: keep typing indicator alive during generation") made the Runtime refresh the typing indicator every 8 seconds for the duration of a generation, superseding Decision point 6. Recorded as accepted practice.

### New authorization: staged status messages

Long generations may maintain a staged status placeholder under hard constraints:

1. A single placeholder may be posted when a generation is still running after ~8 seconds.
2. The placeholder is edited **only** at coarse elapsed-time milestones (8s / 20s / 40s / 90s) to escalate the status text.
3. Hard cap: **4 edits per generation in total** (escalations plus final replacement). Escalations stop at 3 edits so the final replacement always fits; the placeholder is never edited otherwise.
4. **No token deltas**, **no per-chunk streaming**: the Worker protocol and single-request/single-response contract are unchanged — staging is Runtime-side timing only.
5. The result (or failure reply) replaces the placeholder by editing it; continuation chunks beyond 2000 characters post as new messages. Silent rejections delete the placeholder; a stale placeholder must never remain.
6. Edits respect Discord rate limits (single retry with backoff on `429`).

Decision point 5 is superseded by this amendment within the bounds above.

## Amendment (2026-11-25)

A summon in a server is answered in a thread the bot keeps following, and a reply that needs the user's decision stops on a question. Both stay inside the single-shot protocol: every generation is still one request and one complete result.

### Auto-started threads

1. A direct or watched-role mention in a regular server text channel is answered in a public thread started on the mentioning message, archived after one day of inactivity. **No thread is started unless the Worker would answer there**: the Runtime asks the generation gate first (`POST /internal/v1/threads/allowed` — the guild's switch and the channel allowlist, as `generate` reads them), so a disabled guild or a channel off the allowlist gets no empty thread; when the gate says nothing at all, the summon is answered and no thread is started. Nor is one started where the bot could not post in it, and a thread already on the message is used only if it is open and sendable for the bot. When the thread cannot be had — the bot lacks the permission, the thread on the message is locked or was started by someone else, or Discord fails — the summon is answered in the channel as before; nothing is lost but the thread.
2. The thread's **first turn carries its anchors**: the parent channel's messages **older than the summon** (at most 20, asked for by the summon's own id), read before the thread is started. Nothing posted after the summon is taken for what the thread was started from. The Worker places the anchors ahead of the thread's own history, each message once, under the same reset watermark (`resetAt`, ADR-014) and the same context budgets as any history — so a long thread history crowds out the oldest anchors first. Later turns carry none; the thread's own conversation takes over.
3. The container of a started thread is its own (`discord:<guild>:<parent>:<thread>`), with its own queue and budget. The mention stays in the channel and is indexed there like any message.

### Followed threads

4. A started thread is **followed**: un-summoned messages in it summon the bot (`summonKind: "thread-chat"`), so members continue without an `@`. Following is recorded in `thread_sessions` (migration 0010) — ids and flags only, never message text — so it survives a restart. A session belongs to the guild that registered the thread: every read and change names the guild with the thread, and the Worker acts on the row only when both match, so one guild can neither read nor change another's thread state. The Runtime keeps a short-lived cache in front of the record, since it is the only other writer.
   - **Two-layer relevance check (multi-participant threads):** To avoid interrupting human-to-human side-talk in a followed thread without dropping single-user responsiveness, un-summoned `thread-chat` messages pass through two layers before typing or card dismissal:
     1. **Layer 1 (deterministic, Runtime):** Replies to another user/bot, leading `@other` / `@non-watched-role` / `@everyone` / `@here` mentions, and non-chat Discord system messages are skipped immediately without unfollowing the thread. Explicit summons (`@bot`, watched roles, reply-to-bot) always win; self-replies, forwarded messages (`MessageReferenceType.Forward`), and mid-sentence `@user` mentions pass through.
     2. **Layer 2 (conditional lightweight semantic gate, Worker `POST /internal/v1/threads/should-reply`):** Bypassed with zero extra latency when the author has an active `ask_user` card addressed to them, or when recent thread messages involve only that single human and the bot with no recent skipped side-talk. Triggered when 2+ humans appear in recent thread history, recent side-talk was skipped, or a question card is waiting on another participant; reuses the `summarization` model chain for a short JSON verdict and fails open on transient gate errors. Skipped messages remain in Discord history for later turns and never delete pending question cards.
5. An explicit summon in a thread that is not followed resumes it; a bot's or a webhook's message never summons, not even in a followed thread.
6. The model ends the following itself through `thread_pause` when the triggering user says the discussion is over. The tool is stateless: the pause is stored only when the reply that asked for it is the one that completes, and the result's `threadDeactivated` flag tells the Runtime to drop its cache entry at once. A pause asked in the same turn as a question waits for the answer.

### Staged turns: `ask_user`

7. When the answer depends on the triggering user's decision, the model calls `ask_user` instead of guessing. The Worker's `generateText` **stops at that step** — a stop condition on the tool's result — and returns the question as `askPrompt` beside whatever text the model produced as a lead-in; an empty reply is not a failure then. A call the tool refuses (missing question, fewer than two or more than four options, a malformed id or label) does not stop the run: the model reads why and asks again, or answers in text.
8. The Runtime posts the question as **one card**: the lead-in, the question, its optional note, and one native button per option (the first primary), with embeds suppressed and mention parsing off. It replaces the staged placeholder, so the ≤ 4-edit cap is untouched.
9. **The card is intermediate.** It is forgotten the moment the user moves on: a click deletes it and starts the continuation; a typed reply deletes every waiting card before the generation runs. The thread keeps only the question's context and the final answer.
10. The user's answer returns as **a new generation**, not a resumed one. A click is acknowledged at once and **carried out inside the conversation's queue**, where nothing else touches the card: it deletes the card and runs a continuation whose message is the chosen option's label (`summonKind: "component"`, id `<messageId>:ask:<promptId>` so a double delivery runs once). A typed reply is an ordinary turn in the same queue. Whichever of the two reaches the queue first settles the card, and the other finds nothing left to do — they cannot both answer, or clear each other's record. In both, each deleted card is put back into the history the model reads as the bot's own turn — with its options spelled out, since they were buttons — so the reply still sees the question it answers.
11. Only the user who was asked may click. A click by anyone else, a second click while one is being carried out, and a card past its 15-minute window or unknown to the process (restart, eviction) are refused with an ephemeral notice and no action. At the window's end the card's buttons are dropped and it reads as a question to answer in text.
12. A thread's waiting cards are recorded in its session (`pending_card_ids_json`), so a restart loses neither the cleanup nor the answer: the buttons fail closed, and the card still goes when the user replies. **Only a card confirmed gone comes off the record** — deleted, or already absent; one whose delete failed stays listed, and a later turn tries again. A DM keeps its waiting cards in memory only.

### Asking again

13. A reply carries no controls (ADR-015, superseded). To do the last reply over, the triggering user asks in natural language and the model calls `retry_last_reply`, which hands it the conversation's latest turn. In a guild that turn comes from `container_last_turns` (migration 0010), written when a generation completes; a DM is never written there and reads its turn from the request's history alone (ADR-011). **A prompt sent before the triggering user's context watermark is not brought back** (ADR-014): the stored turn keeps when the prompt was sent (`trigger_created_at`), which no retry of the same reply moves — so a chain of retries cannot make an old prompt current again. In the history fallback, a message that only asked for a redo is walked past: the Runtime reports each redo it carries out (`retriedLastReply`) and marks that message in later history (`retryRequest`), so the prompt is still the question the user actually asked. The redone answer is a new reply; the earlier one stays.

### Consequences

**Positive:** long exchanges leave the channel; follow-up needs no repeated `@`; a staged question costs one message, and leaves nothing behind once answered; a single `generateText` still bounds CPU and REST.

**Negative:** a started thread is a new container, with its own history and budget; the Worker stores two more tables (`thread_sessions`, `container_last_turns`); a continuation is a second full generation — the model re-reads the conversation, since nothing of the first turn's tool results carries over.

**Neutral:** an `ask_user` turn records no turn for `retry_last_reply`, and a thread the Worker cannot be asked about reads as unfollowed.

## Review Triggers

- Discord ships a first-party streaming/edit affordance for bot messages.
- Generation latency routinely exceeds the 90s milestone (staging ladder insufficient).
- Model or pipeline changes make generation fast enough that staging never triggers (simplify back to typing-only).
