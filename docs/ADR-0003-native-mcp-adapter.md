# ADR-0003: Use native Vikunja MCP behind the local campaign adapter

## Status

Accepted, 2026-10-05

## Decision

Clients continue to launch the npm executable `vikunja-mcp` through stdio.
The default `native` profile exposes `find_action`/`do_action` alongside our
campaign tools. Discovery includes both the server's permission-filtered direct
tools and its additional catalog actions, so native schemas load on demand. One shared
Streamable HTTP client connects to `/api/v2/mcp` with the configured API token.
The token needs `mcp:access` and the permissions for the operations used.

Our existing task readers, guarded writes, evidence closure, batch receipts,
and migration composition remain compatible. Their supported API operations
are translated using the live OpenAPI route/parameter descriptions and sent
through native MCP. Top-level JSON Patch becomes a native partial-update
argument object. Native no-op patches are read back to return current state.

Binary uploads/downloads, exports, webhooks, current-user diagnostics, and other
routes excluded by the server's MCP catalog still use authenticated REST.
An exposed action missing from token discovery is denied, never sent through
REST. Native errors/timeouts never trigger REST replay of a write.

Raw native tools carry the native server's guarantees. They do not acquire our
local receipts or add actor suffixes. Use our guarded tools for writes that
need stable idempotency keys, evidence closure, or resumable row receipts.

## Compatibility

`VIKUNJA_MCP_BACKEND=rest` explicitly selects the earlier REST adapter for older
servers. The core/qa/developer/full/compatibility profiles retain their existing
tool contracts. With the native backend these wrappers also use native MCP.
There is no automatic fallback after failed initialization or failed actions.

## Limits

The upstream MCP must be available and authorized. Local stdio does not add
OAuth to native HTTP. Arbitrary conditional HTTP headers and nested JSON Patch
cannot be represented by native MCP and return typed errors. Durable receipts
remain machine-local; field history and distributed locks are unchanged.
