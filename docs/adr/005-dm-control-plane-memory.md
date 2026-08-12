# ADR-005: DM Control Plane and Per-User Memory

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The current implementation treats DMs as a regular chat scope (`scope: dm`). Every DM message triggers AI generation, and DM content enters the conversation context alongside guild messages.

This has a privacy problem: DMs are private communications. A user might send sensitive information in a DM — personal details, configuration preferences, or role-play instructions. If this content enters the AI context and is later included in guild conversations (via context windows or tool results), the user's private data is leaked to other participants.

Additionally, users need a way to customize the bot's behavior for their own interactions — setting a persona ("be a blunt code reviewer"), preferences ("respond in Japanese"), and facts ("I'm a Rust developer"). These settings should follow the user across channels but never affect other users.

## Decision

### DM as control plane

DMs are no longer a chat scope. DM messages do **not** trigger AI generation and do **not** enter any conversation context. DMs serve exclusively as a configuration interface:

| Command                         | Effect                                       |
| ------------------------------- | -------------------------------------------- |
| `/persona set <description>`    | Set the user's persona                       |
| `/persona show`                 | Display current persona                      |
| `/persona clear`                | Remove persona                               |
| `/preference set <key> <value>` | Set a preference (language, verbosity, etc.) |
| `/preference list`              | List all preferences                         |
| `/preference clear <key>`       | Remove a preference                          |
| `/memory show`                  | Display all stored memory                    |
| `/memory clear`                 | Clear all memory                             |
| `/help`                         | List available commands                      |

DM text that is not a recognized command receives a fixed help message, not an AI response.

### Per-user memory system

A `user_memory` table stores persona, preferences, and facts keyed by `user_id`:

```sql
CREATE TABLE user_memory (
  user_id    TEXT NOT NULL,
  category   TEXT NOT NULL CHECK (category IN ('persona', 'preference', 'fact')),
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, category, key)
);
```

When a user triggers the bot in any guild channel or thread, only **that user's** memory is loaded and injected into the system prompt. User A's persona never affects User B's responses. The memory block appears as:

```
[User context for {displayName}]
Persona: {value}
Preferences: {key}={value}, ...
```

### No implicit learning

The first version supports only explicit configuration via DM commands. Implicit learning (extracting preferences from conversation history) is a future feature that requires explicit user opt-in.

## Consequences

**Positive:**

- DM content never enters AI context. Privacy is enforced at the architecture level, not by prompt convention.
- Users can customize bot behavior without affecting others.
- Memory follows the user across all guild channels and threads.
- Clean separation: DM is configuration, guild is conversation.

**Negative:**

- Users cannot have private conversations with the bot in DMs (by design). If this is needed later, it requires a separate explicit opt-in and a separate context scope.
- The memory system adds a D1 read per generation (to load the triggering user's memory).

**Neutral:**

- DM commands are processed entirely in the Discord Runtime (no Worker call needed) except for the D1 memory read/write, which goes through the Worker's `/internal/v1/memory` endpoint.
