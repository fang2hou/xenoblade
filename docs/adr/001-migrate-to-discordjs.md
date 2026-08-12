# ADR-001: Migrate from Chat SDK to discord.js

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

Xenoblade currently uses Chat SDK (`chat` + `@chat-adapter/discord`) with community Durable Objects (`discord-gateway-cloudflare-do`, `chat-state-cloudflare-do`) for Discord integration.

Chat SDK's primary value is cross-platform abstraction: a single codebase targeting Slack, Microsoft Teams, Google Chat, Discord, and Telegram. Xenoblade targets Discord exclusively and has no cross-platform roadmap. The abstraction's benefit is entirely unconsumed.

Meanwhile, the abstraction imposes concrete costs:

1. **Leaky abstraction.** Business code uses Chat SDK's `Message` and `Thread` types, but internally depends on Discord-specific fields: `raw.guild_id`, message reference parsing, role mention IDs, Discord message link resolution, and attachment semantics. The "unified" types are constantly decoded back to Discord primitives.

2. **Adapter patching.** Chat SDK's Discord adapter auto-creates a thread for mentions in non-thread channels. Xenoblade needs replies in the original channel. This required a pnpm `patchedDependencies` override against `@chat-adapter/discord@4.36.0` — a clear signal that the adapter's defaults conflict with the product's interaction model.

3. **Gateway limitation.** The community Gateway DO only forwards `MESSAGE_CREATE`, `MESSAGE_REACTION_ADD`, and `MESSAGE_REACTION_REMOVE`. It does not forward `VOICE_STATE_UPDATE` or `VOICE_SERVER_UPDATE`, making Discord voice impossible without replacing the gateway layer.

4. **Community dependency risk.** Both DOs are maintained by a single external repository. They are not Cloudflare, Discord, or Chat SDK official products. The gateway DO is the sole persistent connection point — a critical path dependency with no vendor backing.

5. **Dead code accumulation.** `onSubscribedMessage`, stop words, relevance context, one-shot directives, and `tools.ts` are implemented but have zero production call paths. The subscription system (`thread.subscribe()`) is never invoked anywhere in the codebase. These dormant features add maintenance surface without delivering value.

## Decision

Replace the entire Chat SDK stack — `chat`, `@chat-adapter/discord`, `discord-gateway-cloudflare-do`, `chat-state-cloudflare-do`, and the adapter patch — with `discord.js` running on a self-hosted Node.js host.

discord.js is the canonical Discord library for Node.js. It provides direct, complete access to the Discord API: Gateway, Interactions, REST, voice, components, threads, and all event types. No adapter layer, no abstraction mismatch, no community DO dependency.

## Consequences

**Positive:**

- Full Discord API access, including voice (`@discordjs/voice`), components, threads, and all gateway events.
- No abstraction mismatch — Discord concepts are first-class, not decoded from "unified" types.
- No adapter patching needed; interaction model is controlled directly.
- No community DO dependency on the critical Gateway path.
- Ability to delete dormant subscription/stop/relevance code that never reached production.

**Negative:**

- Self-hosted process lifecycle management required (restart, healthcheck, log rotation).
- No longer serverless for the Discord layer — the process must stay running.
- Single-process model replaces Cloudflare's distributed isolation.

**Neutral:**

- Discord bot token moves from Cloudflare Worker secrets to the self-hosted host's environment.
- The Cloudflare Worker becomes a pure AI/data backend with no Discord-facing routes.
