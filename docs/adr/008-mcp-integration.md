# ADR-008: MCP Integration Scope

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

Model Context Protocol (MCP) is an emerging standard for connecting AI applications to external tools and data sources. The ecosystem includes both read-only tools (search, fetch, query) and side-effect tools (create, update, delete, send, publish).

Xenoblade needs to integrate external MCP servers for extended research and data retrieval. However, two constraints shape the integration scope:

1. **Cloudflare Worker compatibility.** The Worker runs in a V8 isolate, not a full Node.js process. It cannot spawn child processes, which means stdio-based MCP transports are impossible. Only HTTP-based transports (Streamable HTTP, SSE) are viable.

2. **Security.** MCP tools can have real-world side effects: sending messages, modifying databases, making purchases. A Discord bot that exposes arbitrary MCP tools to the model without guardrails risks executing unintended actions on behalf of users.

## Decision

### Transport: Remote Streamable HTTP only

The first version supports only MCP servers accessible via Streamable HTTP transport. This is compatible with the Cloudflare Worker runtime.

stdio-based MCP servers require a Node.js process. If needed in the future, a separate MCP bridge container will be deployed on the self-hosted host (see [ADR-002](002-hybrid-deployment.md)), converting allowlisted stdio tools to authenticated Streamable HTTP. AI orchestration does not move to the self-hosted host.

### Scope: read-only tools only

Only tools classified as read-only (search, fetch, query, list) are exposed to the model. Tools with side effects (create, update, delete, send, publish, purchase, authorize) are filtered out by default.

When side-effect tools are added in the future, they require a Discord Component confirmation flow: the bot displays the tool name, target, and parameters in a Discord message with approve/reject buttons. The tool executes only after explicit user approval.

### Governance

- **Server allowlist:** Only explicitly configured MCP servers are connected. Unknown servers are never auto-discovered.
- **Tool allowlist:** Within each server, only explicitly allowlisted tools are exposed. Server-level allowlisting alone is insufficient.
- **Namespace:** Tools are namespaced by server name (`server.tool`) to prevent collisions across servers.
- **Credentials:** MCP server authentication lives in Worker secrets only — never in D1, never transmitted to the Runtime, never included in logs or model messages.
- **Lifecycle:** MCP clients are created per request and reliably `close()`d. Connection failures, schema fetch errors, or individual tool timeouts do not break the core conversation.
- **Quotas:** Per-user, per-container, and per-tool call limits prevent runaway costs.

## Consequences

**Positive:**
- External data sources become accessible to the model via standardized MCP tools.
- Read-only scope eliminates the risk of unintended side effects in the first version.
- Server + tool dual allowlist provides defense in depth.
- MCP unavailability degrades gracefully — core conversation works without MCP.

**Negative:**
- stdio-only MCP servers are inaccessible without additional bridge infrastructure.
- Some useful read-only tools may be missed if the allowlist is too conservative.
- Per-request client creation adds connection overhead (mitigated by keep-alive where supported).

**Neutral:**
- The AI SDK's `@ai-sdk/mcp` package provides `createMCPClient`, which integrates MCP tools into `generateText`'s tool loop natively.
- The architecture supports adding side-effect tools later without structural changes — only the confirmation flow and allowlist policy need updating.
