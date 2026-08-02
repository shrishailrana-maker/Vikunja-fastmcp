# Vikunja FastMCP Backlog And Token Plan

## Purpose

This plan covers every VMCP backlog item migrated on 2026-08-02. GitHub issues
`#1` through `#45` in `shrishailrana-maker/Vikunja-fastmcp` are now the source
of truth; the previous Vikunja tasks are a closed archive with migration links.
Migration findings and follow-up work are tracked in GitHub issues `#46`
through `#48`.
The primary product goal is to reduce agent context usage without weakening
project scope, task identity, attribution, idempotency, evidence-before-close,
or truthful error reporting.

The implementation must remain a thin Vikunja v2 adapter. Features that need a
database uniqueness constraint, transaction, cross-host lock, or server-issued
version validator are upstream dependencies, not promises FastMCP can make by
itself.

## Current Baseline

The current source is package version `2.4.103` at commit `e4eb36c`. The existing
response benchmark reports:

- basic self-check: 334 characters;
- compact task get: 207 characters;
- compact 100-task search: 12,092 characters;
- create-if-absent receipt: 183 characters;
- comment-and-close receipt: 386 characters;
- compact 401/403 errors: about 172 characters.

The 100-task search and always-loaded task schema are the first optimization
targets. All later measurements must use fixed neutral fixtures and compare
characters, estimated tokens, API-call count, and wall time.

## Migration Learnings

The tracker migration demonstrated that ease of use and raw speed are separate
properties:

- GitHub was easier because it exposed one visible issue identity, focused
  typed operations, short receipts, and one place for links and history.
- Vikunja was faster and provided stronger project scope, actor attribution,
  idempotency, and evidence-before-close behavior.
- Creating 45 GitHub issues took about 38 seconds. Closing and documenting the
  same 45 source tasks through FastMCP took about 8.1 seconds.
- The 47-task portable export took about 2.2 seconds and produced 82,375 bytes,
  but requested comments, attachments, and relations required at least 142
  task-related API calls.
- The export corrupted inline code into internal `@@INLINECODE` placeholders,
  proving that portable-format fidelity needs its own regression gate.

The product response is to simplify the TypeScript MCP rather than rewrite its
runtime:

1. show only the full human identifier in normal task output;
2. expose small typed tools instead of one broad task router;
3. default reads to structured-only minimal output and writes to compact
   receipts;
4. load only the tool profile required by the current client;
5. compose common state and workflow reads into one bounded call;
6. provide a resumable, verified migration workflow;
7. measure schema bytes, response tokens, API-call count, and latency
   independently.

A Windows or C# executable is deliberately outside this roadmap. It may be
reconsidered only after these budgets are green and a like-for-like benchmark
shows that process startup or runtime memory remains material. No executable
issue is queued in this batch.

## Non-Negotiable Rules

1. Every project-specific operation has explicit scope.
2. Human task identity is the full identifier, such as `ALPHA-517`.
3. Writes echo the resolved identifier and project.
4. Actor attribution and stable idempotency keys remain mandatory where already
   required.
5. A compact response never hides partial failure, truncation, or unresolved
   identity.
6. Server-side filtering and pagination are used before MCP-side work.
7. No raw Vikunja wrapper, HTML description, stack trace, token, or duplicate
   human-and-JSON payload is returned in minimal modes.
8. Unsupported server guarantees are reported as capabilities, not simulated
   with unsafe claims.

## Release Gates

Every phase ends with:

```text
npm run typecheck
npm run lint
npm test
npm run build
npm run docs:api
npm run docs:api:check
npm run benchmark:responses
git diff --check
```

The token benchmark becomes a release gate in Phase 1. Initial budgets:

- basic self-check: at most 400 characters;
- projected task get: at most 1,200 characters;
- default 20-task list: at most 4,000 characters;
- 100-task identifier/title projection: at most 4,000 characters, using a
  response byte budget and continuation cursor when needed;
- mutation receipt: at most 1,000 characters;
- bulk summary: at most 2,000 characters plus a failure cursor;
- compact error: at most 1,000 characters.

Safety fields are excluded from trimming: `ok`, operation, task identifier,
project identity, changed state, actor, idempotency result, partial outcome,
pagination continuation, error code, HTTP status, and remediation hint.

## Phase 0 - Audit And Close Already-Implemented Work

Before adding code, test every open item against the current source and live
v2.4 capability document. Close tasks already fully delivered and split only
when one task contains independently releasable work.

Audit first: VMCP-10, VMCP-12, VMCP-13, VMCP-14, VMCP-15, VMCP-17,
VMCP-21, VMCP-26, VMCP-29, VMCP-32, VMCP-35, VMCP-41, VMCP-44, and VMCP-45.

Deliverables:

- a checked capability matrix: implemented, partial, MCP-owned, upstream, or
  rejected with reason;
- before/after benchmark fixtures committed with no private data;
- one GitHub issue update per audited item with fresh evidence.

## Phase 1 - Remove The Largest Always-Loaded And Repeated Payloads

This phase has the highest token return and lands before new workflow features.

### 1.1 Typed, smaller tool surface

Replace the broad `vikunja_tasks` schema in the default tool profile with typed
task tools grouped by purpose:

- task read/list/search/count;
- task create/update/delete;
- task workflow/labels/assignees/relations;
- task comments;
- task attachments;
- task bulk.

Keep the old router only in an explicit compatibility profile. Add process-level
profiles so a client can register `core`, `qa`, `developer`, or `full` tools.
Measure the exact `tools/list` bytes for every profile.

Tasks: VMCP-35, VMCP-52, VMCP-54.

### 1.2 Structured-only response modes

Add these effective modes:

- `minimal` for reads: one JSON envelope, projected fields, no duplicate prose;
- `receipt` for writes: one compact JSON receipt;
- `standard`: short Markdown plus JSON for compatibility;
- `full`: explicit expanded data only.

Default reads to `minimal` and writes to `receipt` after a documented migration
release. URLs become opt-in. Pagination appears once. Bulk responses return
changed/failure detail and summarize unchanged rows by count.

Tasks: VMCP-29, VMCP-30, VMCP-31, VMCP-34, VMCP-45.

### 1.3 Universal projection and output budgets

Implement `fields`, `includeUrl`, `titleMaxChars`, and a bounded response budget
for every list-style operation. Projection happens before formatting. A budget
limit never lies: it sets `incomplete: true` and returns a continuation cursor.

Tasks: VMCP-32, VMCP-33, VMCP-41, VMCP-51.

Acceptance:

- at least 60 percent reduction from the current 100-task response;
- no duplicated project object in a single-project compact result;
- no duplicated prose/JSON pagination;
- benchmark tests fail the build when budgets regress.

## Phase 2 - Make Common Reads One Call

### 2.1 Precise search and delta reads

Add title-only and description-only search, `changedSince`, stable sorting, and
a cursor based on `(updated, id)`. Use Vikunja filters directly and reject query
shapes the server cannot evaluate safely.

Tasks: VMCP-24, VMCP-38.

### 2.2 Batch get and task snapshot

Add bounded `batch_get` for full identifiers. Add `verify_task_state` returning
project, state, labels, assignees, attachment names/count, relations, comment
count, latest comment timestamp, and latest verification receipt in one bounded
response. Comments and attachments remain opt-in when their bodies are large.

Tasks: VMCP-15, VMCP-26, VMCP-37.

### 2.3 Counts, snapshots, and reconciliation

Add `programme_snapshot` with totals by done state, status label, assignee,
blocked/stale state, and changed-since cursor. Add the narrower MPF
reconciliation view as a preset over the same aggregation engine, not a second
implementation.

Tasks: VMCP-40, VMCP-48.

### 2.4 Deduplication and receipt lookup

Add title-scoped `task_dedupe`, exact external-key lookup, and durable receipt
lookup without listing a project. Clearly label duplicate detection as advisory
until the server provides uniqueness.

Tasks: VMCP-27, VMCP-46.

Acceptance:

- common QA state checks take one MCP call;
- no task/comment descriptions are returned unless requested;
- every list exposes `returnedCount`, `totalCount`, `nextCursor`, and
  `incomplete` once, in the machine envelope.

## Phase 3 - Truthful, Safe, Compact Writes

### 3.1 Mandatory write envelope

Use one shared write schema requiring project scope, actor, idempotency key, and
the appropriate optimistic precondition. Require `expectedUpdatedAt` for
replacement updates until server-side `If-Match` exists. Append-only operations
may use a content/evidence key instead.

Tasks: VMCP-19, VMCP-22, VMCP-44.

### 3.2 Dry-run and receipts

Add dry-run to status, label, assignment, relation, close, create, update, and
delete paths. A mutation receipt contains only identifier, operation, before and
after state, actor, idempotency state, updated timestamp, and verification
verdict unless item detail is requested.

Tasks: VMCP-20, VMCP-42.

### 3.3 Evidence workflows

Make `close_with_evidence` accept structured evidence: command, result, actor,
timestamp, revision or task state, and an evidence key. Return a partial-outcome
receipt that separately states whether the comment was created and whether the
task state changed. Add `close_if_verified`, `transition_with_evidence`, and
`append_evidence_if_changed` on the same engine.

Tasks: VMCP-11, VMCP-16, VMCP-23, VMCP-39, VMCP-47.

### 3.4 Relation and create receipts

Relation receipts echo both task identifiers and titles. Task creation may
inline bounded relation creation and the first comment, with explicit composed
call results rather than pretending the calls are atomic.

Tasks: VMCP-25, VMCP-53.

### 3.5 Errors and diagnostics

Standardize errors with `retryable`, operation id, HTTP status, resolved safe
identity, capability/version context, and one remediation hint. Keep concise
diagnostics separate from full self-check.

Tasks: VMCP-13, VMCP-17.

## Phase 4 - Durable Bulk Operations

Extend the existing SQLite/WAL operation ledger rather than adding another
store. Every row records selected, changed, unchanged, skipped, failed, retry
count, final identity, and immutable result hash. A resumed operation processes
only unfinished or explicitly retryable rows.

Return counts by default. Item receipts are paginated behind `operationId` and
cursor. Dry-run creates no mutation receipt and performs no write.

Tasks: VMCP-21, VMCP-30, VMCP-42.

Acceptance:

- lost responses and process restarts do not replay successful local rows;
- cross-host non-atomic limitations remain visible;
- a 100-row bulk summary stays inside the response budget.

## Phase 5 - Attachments And Comment Efficiency

Make task-get attachment behavior explicit and consistent. Add filename/count
projection, task-to-attachment mapping, optional local SHA-256 calculation,
duplicate warnings, and content-hash receipts. Add bounded comment `since`,
`countOnly`, and latest-comment metadata.

Tasks: VMCP-12, VMCP-28, VMCP-50.

Server-provided hashes remain preferred because local hashing cannot detect a
concurrent upload or avoid downloading old remote content.

### 5.1 Portable project migration

Add a resumable migration workflow with a versioned manifest and a GitHub
destination adapter. It must support preview, public-content sanitization,
deterministic migration keys, durable source-to-destination receipts, read-back
verification, progress/resume, and per-row failures. Source tasks are archived
only after destination verification, with an explicit `migrated, not
implemented` comment.

The adapter must preserve descriptions, comments, priorities, relation
references, and attachment metadata where supported. Binary attachment transfer
is capability-gated. Credentials and private paths never enter task content,
logs, command arguments, or receipts.

GitHub issues: `#46` export-fidelity bug, `#47` bounded/observable export
fallback, and `#48` resumable migration workflow. Upstream native project
export is tracked in `go-vikunja/vikunja#3397`.

## Phase 6 - Server-Dependent Guarantees

FastMCP implements capability detection and safe degraded behavior, but does not
claim these guarantees until Vikunja provides them:

- server-enforced external-key uniqueness and durable create idempotency:
  https://github.com/go-vikunja/vikunja/issues/3391
- race-free task write preconditions with `If-Match`:
  https://github.com/go-vikunja/vikunja/issues/3392
- atomic evidence comment plus task transition:
  https://github.com/go-vikunja/vikunja/issues/3393
- cross-host expiring task leases:
  https://github.com/go-vikunja/vikunja/issues/3394
- server attachment hashes and idempotent upload:
  https://github.com/go-vikunja/vikunja/issues/3395
- collection ETags for safe identity-resolution caching:
  https://github.com/go-vikunja/vikunja/issues/3396

Tasks: VMCP-18, VMCP-19, VMCP-23, VMCP-43, VMCP-44, VMCP-46, VMCP-47,
VMCP-49, VMCP-50.

The known `subscription.entity` server defect remains tracked separately in
VMCP-9 and upstream issue 3316. FastMCP preserves the real error and read-back
verification; it does not mutate subscription data as a workaround.

## Phase 7 - Documentation, Skill, And Release

After each public contract change:

1. Update the typed tool contract and regenerate `MCP_API.md`.
2. Update README examples using npm `@latest` and neutral projects.
3. Update the packaged skill with minimal-mode defaults, projections, scope,
   identity, and continuation behavior.
4. Maintain one generic, copy-ready agent prompt in the README for both new and
   existing users. It installs or updates `vikunja-fastmcp@latest`, keeps the
   MCP command as `vikunja-mcp`, preserves configured secrets without printing
   them, locates the skill in the installed npm package, installs it when
   missing, refreshes and reuses it when present, avoids duplicate skill copies,
   restarts the MCP client, and reports the resolved package, command, and skill
   paths. The wording must not name a specific agent, OS, user profile, project,
   host, credential, or fixed package version.
5. Add capability tests that fail when the README prompt, packaged skill, and
   runtime tool contract disagree.
6. Add migration notes for removed default tools or response modes.
7. Copy the packaged skill to local clients only after package installation.
8. Run a clean npm pack inspection and secret/private-data scan.
9. Live-test admin, developer, and read-only roles using neutral scratch tasks.
10. Publish only after explicit approval.

Tasks: VMCP-14, VMCP-35, VMCP-51, VMCP-52, VMCP-54.

## Recommended Delivery Slices

To keep review risk manageable, deliver in this order:

1. benchmark gate plus structured-only modes and projection;
2. typed tool profiles and schema-size reduction;
3. precise search, delta reads, and batch get;
4. task snapshot and programme snapshot;
5. shared write envelope, dry-run, and compact receipts;
6. evidence workflows and truthful partial results;
7. durable bulk receipts;
8. attachments, comment deltas, and dedupe helpers;
9. resumable project migration and destination verification;
10. upstream capability adapters when the server features land;
11. final docs, skill, live role matrix, and release.

Each slice must be independently releasable. Do not combine the tool-surface
split, durable-store migration, and evidence workflow rewrite in one release.

## Completion Definition

The backlog is complete when every open VMCP item is either:

- closed with fresh automated and live evidence;
- explicitly waiting on a linked upstream issue with a safe MCP fallback; or
- rejected with a documented product reason.

Completion also requires the response and schema benchmarks to pass, the
packaged skill and generated API document to match runtime schemas, and no
private host, project, task, username, or credential in repository fixtures.
