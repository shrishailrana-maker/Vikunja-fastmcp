# Clean V2 Rebuild Plan

The GitHub repository originated as a fork used for evaluation. This rebuild
replaced that implementation completely: the current source, tests, generated
API reference, runtime package, and documentation were created for the v2-only
product and do not retain the original implementation.

## Decision

Replace the old MCP rather than simplify it in place. The new implementation
supports Vikunja v2 only, uses direct Node 24 `fetch`, and keeps all runtime
source in one small, mostly flat directory organized by real responsibilities.

The rebuild keeps a sanitized local API snapshot and generated route index at
`docs/vikunja-v2-openapi.json` and `docs/VIKUNJA_V2_API_REFERENCE.md`. Agents
use these instead of rediscovering routes from old source. The live server gate
revalidates the snapshot before implementation and after server upgrades.

The goal is not to preserve old abstractions. The goal is a fast, inspectable
tracker client that handles the tester and developer workflows in
`V2_API_CONTRACT.md` without an implementation maze.

The first release used one broad task router. Measured `tools/list` and
response cost later justified a narrower public surface: `core`, `qa`,
`developer`, and `full` profiles now register typed read/write/workflow tools.
The QA profile adds a focused task-organization tool, while the broad router
remains only in the explicit `compatibility` profile. This is one task
implementation exposed through smaller contracts, not a return to duplicate
task logic.

The public API is not maintained as separate handwritten knowledge. Runtime
Zod schemas drive MCP `tools/list` and generate one packaged `MCP_API.md` with
inputs, defaults, examples, scope rules, and response contracts. CI rejects a
stale generated document.

## Why We Are Rebuilding

The old server grew to more than one hundred TypeScript files around ordinary
HTTP calls. Real sessions exposed the cost:

- portal task numbers and database IDs were confused, creating wrong-target
  risk;
- identity and route failures were sometimes reported as invalid-token or JWT
  problems;
- unscoped and client-side queries scanned too much data;
- duplicate task tools returned different answers;
- list responses consumed thousands of tokens and hid truncation;
- writes did not consistently echo the task they changed;
- attachment readback and download were awkward;
- security behavior was removed once without regression tests;
- finding a bug in the layered implementation took longer than the underlying
  API operation justified.

MCP itself is not the problem. A persistent stdio process is appropriate for
agents. The problem was the code between MCP and Vikunja. The replacement keeps
MCP and removes the tower.

## Simplicity And Cohesion

The initial layout is intentionally small and flat:

```text
src/
  index.ts          startup, schemas, and tool registration
  config.ts         environment and URL validation
  api.ts            authenticated v2 fetch and multipart streaming
  errors.ts         status-preserving redaction and error envelopes
  format.ts         normalization, compact Markdown, and JSON envelope
  identity.ts       global ID and project-local reference resolution
  tasks.ts          task CRUD, comments, labels, assignees, and relations
  resources.ts      projects, users, teams, labels, and saved filters
  attachments.ts    upload, metadata listing, and streamed download
```

This is a starting shape, not a numeric file limit. The governing rules are:

- merge tiny pass-through modules that add navigation without ownership;
- split a large file when it contains independently testable responsibilities,
  unrelated change reasons, or cannot be reviewed comfortably in one pass;
- prefer a focused extra file over a thousand-line `tasks.ts` or `format.ts`;
- keep schemas and handlers table-driven where that remains clearer than many
  nearly identical functions;
- any new file or directory must name the responsibility it owns and the
  duplication or complexity it removes.

About 400 lines is a review trigger, not an automatic split or hard maximum.
At that point, reviewers must either identify a cohesive seam and split it or
record why the file still has one responsibility. Two unrelated
responsibilities require a split regardless of line count.

For example, Markdown conversion starts in `format.ts` but may become
`markdown.ts` when its parser, sanitizer, and round-trip tests form a real
independent seam. Labels, assignees, and relations may similarly split from
`tasks.ts` if keeping them together makes the canonical task implementation
harder to navigate.

Tests are also flat:

```text
tests/
  config.test.ts
  api.test.ts
  identity.test.ts
  format.test.ts
  tasks.test.ts
  resources.test.ts
  attachments.test.ts
  security.test.ts
```

Avoid nested directory trees, barrels, service classes, repositories,
factories, strategy objects, middleware frameworks, and duplicated schemas.
Flatness is preferred, but cohesion and reviewability take priority over an
arbitrary file count.

## Runtime Dependencies

Keep only:

```text
@modelcontextprotocol/sdk
zod
```

Node 24 supplies `fetch`, streams, `URL`, filesystem APIs,
`crypto.randomUUID`, and `node:sqlite`. Do not add `node-vikunja`, an HTTP
wrapper, database package, retry library, circuit breaker, HTML framework, or
attachment encoding library.

## Included Features

The first release includes only features tied to demonstrated workflows:

- v2 connection status and token-free self-check;
- project list/get and required project scoping;
- safe concurrent use across projects by requiring title/ID scope on every
  project-scoped call, plus explicit grouped project subsets and deliberate
  grouped `allProjects` reads;
- typed task read, write, and workflow tools, with the broad router only in an
  explicit compatibility profile;
- portal/global task identity resolution and write target echo;
- exact-title duplicate prevention and close-with-evidence;
- compact server-filtered lists with honest pagination, exact priority, and a
  count-only mode that emits no task items;
- an explicit 100-item per-project page ceiling so large trackers remain safe
  for agent context, with totals and continuation metadata preserved;
- consolidated task get with labels, assignees, attachment metadata, and a
  bounded latest-comment view;
- comments, labels, assignments, duplicate/blocking relations;
- users needed for assignment;
- teams and saved-filter direct CRUD retained by owner request;
- attachment upload during bug creation, metadata verification, and streamed
  local download for automatic agent parsing.
- compatibility tools for native bulk update, task reminders, CSV migration,
  user export, and webhooks;
- mutation-scope policy with a warn-to-require compatibility transition,
  actor-attributed writes, compact project summaries, mutually exclusive
  status-label switching, and bounded idempotent CSV import;
- bounded non-atomic bulk create/delete, composed project JSON/CSV export, and
  machine-local task templates without restoring the legacy service tower.
- structured-only minimal reads and mutation receipts, field projection,
  response/schema budgets, precise search, delta reads, batch get, task-state
  verification, and programme snapshots;
- durable SQLite/WAL bulk row receipts with lease-owner-checked resume;
- one response-wide budget and resumable cross-project cursor for minimal task
  lists, without repeated project objects in task rows;
- optional local attachment hashes, bounded comment deltas, and a full-profile
  resumable GitHub migration with public sanitization and destination read-back.

Bulk update/create/delete are capped at 100 tasks per call. Composed create and
delete are non-atomic, delete requires explicit confirmation, and CSV/file
operations use the configured byte ceiling (100 MiB by default). These limits
are generated into `MCP_API.md` and must remain synchronized with runtime
schemas.

Not included: project mutation/member administration, time entries, views,
buckets, client-side filters, a task-state database, or v1 compatibility.

Teams and saved filters remain in scope because the owner uses them, but they
are implemented after identity, scope, errors, lists, write safety,
attachments, and security are green. They cannot delay or weaken those P0
gates.

## Resolution Cache

The only in-process cache stores identity resolution:

```text
case-insensitive exact project title -> project id
case-insensitive exact label name    -> label id
```

Entries live for 45 seconds and are invalidated immediately when this MCP
creates, updates, or deletes the corresponding project or label. External
changes become visible after the short TTL. The cache belongs in `identity.ts`
and remains a small bounded map, not a service, database, or framework.

It never caches task content, task get responses, list results, search results,
pagination, attachments, comments, permissions, tokens, or authentication
state. It has no retries or stale-data fallback. Its only purpose is to avoid
re-listing projects or labels for repeated title/name resolution in a long MCP
session; it does not restore the removed caching and retry tower.

## Attachment Decision

The MCP returns both attachment metadata and a clean API download URL, but it
never embeds credentials in a URL. Because private attachment endpoints need a
bearer header, the reliable automatic workflow is:

```text
tester calls create/create_if_absent with attachments[]
MCP creates or finds the task, uploads each file, and verifies metadata
developer agent calls download-attachment
MCP streams the authenticated response to an explicit path or a safe temp path
MCP returns localPath, filename, media type, size, checksum, and source URL
agent opens and parses localPath with its normal file tools
```

This lets developers retrieve large logs without loading binary or base64 into
the model context. It also lets testers post logs and screenshots as part of
the original bug operation instead of making a separate manual upload. A
partial file failure is returned per attachment without duplicating the task
on retry. A signed-in human can use the returned task web link.

When no destination is supplied, the MCP stores the download under the current
user's operating-system temporary directory:

```text
%TEMP%\vikunja-fastmcp\attachments\<task-id>\<attachment-id>\<filename>
```

`self-check` reports the resolved download root. Temporary downloads are never
placed in a project repository. Agents use an explicit destination when a file
must survive operating-system temporary-file cleanup.

## Safety Requirements

- Never infer project scope from process configuration. Require an exact
  project title or numeric ID on task creation, search, listing, and portal
  references.
- Allow cross-project reads only through explicit read-only `projects: [...]`
  or deliberate read-only `allProjects`; keep pagination grouped per project.
- Accept only explicit `{globalId}`, `{identifier}`, or `{projectIndex}` task
  selectors, then resolve once and use the global ID for child operations.
- Read and echo project, title, portal reference, and global ID on every write.
- Warn or reject global-ID mutations without explicit project scope according
  to `VIKUNJA_MUTATION_SCOPE_MODE`; always reject a supplied project mismatch.
- Keep actor attribution additive and idempotent, and never echo submitted
  evidence in compact write receipts.
- Replace configured status labels in one bulk request while preserving every
  unrelated label; never create the target label unless explicitly requested.
- Persist idempotency and import receipts in a bounded-lifetime SQLite/WAL
  ledger scoped to the configured server URL; ledger loss degrades only to
  duplicate risk, never deletion.
- Preserve 401, 403, 404, 405, and 409 meanings and safe server details.
- Redact credentials before logs or responses are constructed.
- Require payload-bound durable idempotency for create, comment, attachment,
  evidence-close, import, and mutating bulk retries.
- Use an isolated operating-system temporary directory when no download
  destination is supplied, and never overwrite an existing file without
  explicit permission.
- Keep attachment bytes out of MCP responses and enforce upload/download size
  limits before consuming the full body.

## Removal Plan

The old implementation, tests, mocks, generated output, stale CI, obsolete
architecture docs, and retired dependencies were removed before coding began.
They remain recoverable from the parent Git commit and public repository
history. The replacement is implemented directly in empty `src/` and `tests/`
directories and must not inspect, import, copy, or wrap legacy runtime code.

The clean baseline removed these legacy groups rather than preserving
individual folders:

```text
src/                replaced completely by the cohesive v2 implementation
tests/              replaced completely by focused v2 tests
__mocks__/
scripts/test-mcp.ts
```

Remove old architecture documents after their useful decisions are represented
in this contract and plan. Rewrite `README.md`, `TECHNICAL.md`, and
`.env.example` for the new v2 server. Add generated `MCP_API.md` as the one
complete public tool reference and include it in the npm package. Generated
`dist`, `coverage`, and `node_modules` remain untracked.

The executor plan, progress journal, and audit packet are local audit artifacts.
They remain available until the owner explicitly approves deletion. They are
excluded from public package output unless the owner requests otherwise.

## Implementation Sequence

1. Keep these two documents as the design boundary.
2. Live-probe `/api/v2/info` and `/api/v2/openapi.json`, then generate a
   capability checklist from the configured server's OpenAPI. Verify every
   dependency against the live server and record method, path, request-body
   schema, enum values, expected success status class, and the composed MCP
   operations that depend on it. Resolve all ambiguous body fields and nested
   verbs before their feature is coded. A missing required dependency makes
   `self-check` name the missing method/path and every affected operation; it
   never triggers a v1 fallback.
3. Create the small cohesive source and test layout from empty `src/` and
   `tests/` directories. The legacy implementation has already been removed
   and must not be consulted or restored. Generate `MCP_API.md` from the
   registered schemas rather than maintaining a second handwritten contract.
4. Write fail-first tests for identity, truthful errors, explicit project title
   and ID scope, exact project subsets, ambiguous titles, concurrent-window
   isolation, grouped pagination, count-only totals with no items, consolidated
   get, resolution-cache TTL/invalidation, compact lists, priority, write echo,
   idempotency, relations, teams, filters, upload, metadata readback, and
   streamed download. Mandatory grouped-pagination cases prove that Alpha page
   2 does not advance Beta and an Alpha/Beta subset never requests or returns
   Gamma. Grouping may coordinate independent server pages but must not fetch
   broad results and merge or filter task contents client-side.
5. Add mandatory security tests for token redaction, safe paths, size limits,
   entity decoding, unsafe URL schemes, and hostile HTML/error content.
6. Implement in risk order: identity/scope/truthful errors; list and grouped
   pagination; write echo and safe compounds; attachments; security hardening;
   then teams and saved filters. Identity, scope, list, attachment, and security
   acceptance tests must pass before teams or saved-filter work begins. Make
   each stage pass without importing any old source file.
7. Run read-only smoke tests: self-check including compact visible projects,
   projects, users, scoped list/search, get with comments, labels, assignees,
   relations, teams, filters, and attachment metadata.
8. With owner approval, use two neutral scratch projects, "Alpha" and "Beta".
   Create, list, and search in each concurrently; query the explicit
   Alpha/Beta subset without including a neutral third project, confirm no
   cross-project bleed, reject a bare `#index` without project scope, and
   resolve the same portal index independently in each project.
9. Write a task description and comment containing a Markdown heading, bold
   text, a link, and a bulleted list. Read both back and verify the
   Markdown-to-HTML-to-Markdown round trip preserves that structure.
10. Verify create-if-absent, update, assignment, label, comment, relation,
    create-with-attachments, automatic download-to-local-path, evidence close,
    and delete.
11. Record the parent Git commit and public release containing the last legacy
    implementation as rollback history. Do not restore or inspect old source,
    and do not create a new tag or switch `current`.
12. Verify the clean baseline and final implementation contain no old source,
    tests, mocks, generated output, obsolete docs, retired dependencies,
    legacy imports, or legacy task-tool registrations.
13. Run typecheck, lint, the new full suite, atomic build, pack dry-run,
    generated-API drift check, whitespace check, and a clean-install smoke
    test.
14. Measure API call count and response bytes for each required workflow.
15. Ask the owner before any commit intended for publication, GitHub push,
    tag, release, or shared-runtime switch.

## Acceptance Gate

The rebuild is ready for owner review only when:

- runtime source remains small and mostly flat, with no trivial pass-through
  maze and no oversized multi-responsibility files;
- there is exactly one task implementation;
- no old source is present, imported, copied, wrapped, or runnable;
- all required workflows pass against mocked v2 responses;
- approved live smoke tests pass against the native Vikunja service;
- the checked capability matrix records every required method, path,
  request-body schema, enum, expected status class, and composed-operation
  dependency; no required row remains guessed or open, and `self-check` names
  any missing route plus each affected operation;
- security, identity, attachment, and error regression tests pass;
- list output is compact and mechanically parseable;
- count-only output contains totals and no task items;
- consolidated get returns bounded comments and attachment metadata without
  hiding that extra HTTP calls are MCP-composed;
- the resolution cache contains identity mappings only and passes TTL and
  invalidation tests;
- Markdown writes allow only the documented safe subset and fail closed on
  unsafe HTML, attributes, or URL schemes;
- compound-operation responses do not claim distributed uniqueness or
  server-side optimistic locking;
- attachment download writes to disk without exposing credentials or binary;
- `tools/list`, `MCP_API.md`, and `self-check` report the same API contract;
- `self-check` reports the resolved temporary download directory;
- install/build is atomic and cannot destroy the active runtime on failure;
- the parent commit and existing public release provide rollback history while
  old source remains absent from the current tree;
- no private URL, token, local path, or customer/project identity enters the
  public repository.

No commit, push, tag, release, or runtime junction update is part of this
documentation change.
