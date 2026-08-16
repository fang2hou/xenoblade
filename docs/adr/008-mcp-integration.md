# ADR-008: MCP Integration Scope

- **Status**: Accepted
- **Date**: 2026-08-12

## Context

Model Context Protocol (MCP) connects AI applications to external tools and data. Two constraints shape the integration:

1. **Cloudflare Worker compatibility.** The Worker is a V8 isolate — it cannot spawn child processes, so stdio transports are impossible; only HTTP-based transports (Streamable HTTP, SSE) are viable.
2. **Security.** MCP tools can have real-world side effects (send, write, purchase). An ungoverned tool surface risks executing unintended actions on behalf of users.

## Decision

### Transport: remote Streamable HTTP only

Only MCP servers reachable via Streamable HTTP. stdio-only servers would require a bridge container on the self-hosted host (see [ADR-002](002-hybrid-deployment.md)) converting allowlisted stdio tools to authenticated Streamable HTTP — deferred until needed; AI orchestration does not move off the Worker.

### Scope: read-only tools only

Only read-only tools (search, fetch, query, list) are exposed. Side-effect tools are filtered out until a Discord component confirmation flow (tool, target, parameters, approve/reject) exists.

### Governance

- **Server allowlist:** only explicitly configured servers connect (today: context7 always; GitHub MCP when `GITHUB_MCP_TOKEN` is set). No auto-discovery.
- **Tool allowlist:** within each server, only explicitly allowlisted tools are exposed; server-level allowlisting alone is insufficient.
- **Namespace:** tools are namespaced by server (`server.tool`) to prevent collisions.
- **Credentials:** MCP auth lives in Worker secrets only — never in D1, never transmitted to the Runtime, never in logs or model messages.
- **Lifecycle:** clients are created per request and reliably closed; connection/schema/tool failures degrade gracefully without breaking conversation.
- **Quotas:** per-user, per-container, and per-tool call limits bound runaway costs.

## Alternatives Considered

### stdio bridge container from day one

- Pros: immediate access to the large stdio-server ecosystem.
- Cons: new always-on infrastructure on the host before a single required server exists.
- Why not chosen: no current stdio-only requirement justifies the bridge.

### Expose all tools from allowlisted servers

- Pros: simpler governance, fewer configuration knobs.
- Cons: one tool-listing change on the server side silently widens the model's power.
- Why not chosen: the dual allowlist is defense in depth against exactly that.

### Run MCP clients in the Discord Runtime

- Pros: full Node.js process, stdio possible.
- Cons: breaks credential isolation (MCP secrets on the Discord tier) and drags tool logic across the wire contract.
- Why not chosen: violates the ADR-002 ownership boundary.

## Consequences

**Positive:** external data sources reach the model via a standard interface; read-only scope eliminates side-effect risk in this version; MCP unavailability degrades gracefully.

**Negative:** stdio-only servers inaccessible without bridge infrastructure; a conservative tool allowlist may miss useful read-only tools; per-request client creation adds connection overhead.

**Neutral:** `@ai-sdk/mcp` integrates MCP tools into the `generateText` tool loop natively; adding side-effect tools later requires only the confirmation flow and policy updates.

## Review Triggers

- A stdio-only MCP server becomes genuinely required (build the bridge container).
- A side-effect tool is requested (implement the Discord confirmation flow first).
- The MCP standard shifts beyond Streamable HTTP (transport revisit).
