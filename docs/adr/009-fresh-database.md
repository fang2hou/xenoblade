# ADR-009: Fresh D1 Database

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

The existing D1 database (`xenoblade-dev`) carries schema constraints from the Chat SDK era:

1. `interactions.kind` has a `CHECK (kind IN ('mention', 'subscribed'))` constraint. The new architecture removes the subscription system entirely and introduces a richer `summon_kind` enum (`user-mention`, `role-mention`, `reply-to-bot`, `slash-command`, `component`).

2. `user_context_state` columns (`last_interaction_at`, `active`) were designed for implicit session tracking that was never wired in production. They carry semantics that no longer apply.

3. The schema lacks tables needed by new features: `user_memory` (per-user persona/preferences), `tool_invocations` (tool call audit trail).

4. SQLite's `CHECK` constraints cannot be modified in place. Changing the `interactions.kind` constraint requires a table-copy migration, which is error-prone on a live database.

The current bot is operational on the existing database. Any schema disruption risks downtime.

## Decision

Create a **new D1 database** with a clean schema designed for the target architecture. The old database continues serving the old bot without modification.

**Key differences from the old schema:**

| Area                | Old                                                     | New                                                                    |
| ------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------- |
| `interactions.kind` | `CHECK (kind IN ('mention', 'subscribed'))`             | `summon_kind TEXT NOT NULL` (no CHECK; validated in application layer) |
| Session tracking    | `last_interaction_at`, `active` (implicit subscription) | Removed; `reset_at` retained for context clearing                      |
| User customization  | Not supported                                           | `user_memory` table (`persona`, `preference`, `fact`)                  |
| Tool audit          | Not supported                                           | `tool_invocations` table                                               |
| Context clearing    | Single mode (user × container)                          | Multiple modes (user, channel-wide, user-wide, time-filtered)          |

**Migration strategy:** No data migration. The new database starts empty. The old database is preserved as a rollback data source. Cutover occurs at production deployment (Phase D) when the old bot stops and the new system becomes the sole data source.

## Consequences

**Positive:**

- Clean schema with no legacy constraints or dormant columns.
- Old bot is completely unaffected during development — both systems can run in parallel on different databases.
- No risky in-place migrations on a live database.
- Table design is driven by current requirements, not historical accidents.

**Negative:**

- No data continuity. Historical interactions, context reset points, and processed message IDs from the old database are lost. The new bot starts with no memory of past conversations.
- Two databases to manage during the transition period.

**Neutral:**

- The old database can be queried for historical analysis if needed, but it is not wired to the new system.
- Wrangler configuration references the new database ID; the old database ID is removed at cutover.
