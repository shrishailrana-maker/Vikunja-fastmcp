# ADR 0001: Agent-Efficient MCP Contract

- Status: Accepted
- Date: 2026-08-02

## Context

Production use showed that the main cost was not Node startup or Vikunja API
latency. It was repeated schema text, duplicated Markdown/JSON responses,
unbounded task/comment reads, and multi-call agent workflows. The broad task
router also made action discovery harder and loaded every rarely used field
into every session.

Safety rules cannot be removed to save tokens. Project scope, explicit task
identity, actor attribution, idempotency, evidence-before-close, truthful
pagination, and real HTTP status remain mandatory.

## Decision

1. Default reads to structured-only `minimal` mode and writes to
   structured-only `receipt` mode.
2. Register typed task read, write, workflow, comment, and attachment tools in
   the default `core` profile. Add task organization and QA/developer/admin
   surfaces only through explicit larger profiles. Keep the broad router only
   in `compatibility`.
3. Support field projection, bounded response characters, and one truthful
   continuation cursor. Do not repeat action requirements in both tool
   descriptions and discriminated schemas.
4. Use one task engine behind every typed surface. Profiles change discovery,
   not behavior or storage.
5. Persist idempotency and bulk/migration row receipts in a local SQLite/WAL
   ledger. State may be written only by the current renewable lease owner.
   This is local-process safety, not a cross-host transaction.
6. Keep portable migration full-profile only. Require public sanitization,
   trusted destination hosts, versioned manifest hashes, complete destination
   read-back, and explicit capability reporting before source archival.
7. Gate releases on common-response and per-profile schema-character budgets.

## Consequences

- Normal sessions load fewer schemas and read much smaller responses.
- Existing clients can opt into `compatibility`, `compact`, `standard`, or
  `full` while they migrate.
- Specialized operations require choosing a larger profile and restarting the
  MCP process.
- Machine-local receipts survive restarts and same-machine concurrent agents,
  but cannot enforce uniqueness or atomicity across hosts. Full diagnostics
  name the relevant upstream server capabilities and local fallbacks.
- GitHub migration requires an environment credential and sends it only to
  `api.github.com` or an explicitly trusted GitHub Enterprise hostname.

## Rejected Alternatives

- A C# or native executable rewrite: process startup was not the measured
  bottleneck and a second implementation would not reduce model tokens.
- Removing safety fields from compact receipts: it would recreate wrong-target
  and unauditable-write failures.
- One always-loaded mega-tool: simpler internally, but materially more costly
  and less discoverable for every client session.
- Claiming distributed locks or atomic composed writes: Vikunja does not yet
  provide the required server primitives.
