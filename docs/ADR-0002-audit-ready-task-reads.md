# ADR-0002: Make default task reads audit-ready without fabricating history

## Status

Accepted

## Context

Campaign reconciliation and concurrent task updates need stable task identity,
creator, timestamps, labels, workflow status, and a direct task link in the
default response. The Vikunja v2 API provides current task metadata and task
comments, but does not provide a general field-level task-history route or a
reliable last-editor field.

## Decision

Default compact task reads return a bounded audit projection: human reference,
global ID, direct link, creator, creation/update timestamps, current labels,
derived workflow status, and a description version equal to `updatedAt`.

`activity` composes current task metadata with a bounded recent-comment
timeline. It explicitly reports field-level title, description, label, and
workflow-transition history as unavailable unless Vikunja later offers an
authoritative server route. `evidence_search` is bounded and returns
`incomplete: true` whenever it cannot prove absence across the project.

## Consequences

- Callers receive `updatedAt` directly for `expectedUpdatedAt` writes.
- Batch identifier reads become useful for reconciliation without repetitive
  client calls.
- The MCP does not claim unavailable server audit guarantees or invent a last
  editor from unrelated evidence.
- Default read receipts are larger, but remain bounded and retain field
  projection for callers that need a smaller response.
