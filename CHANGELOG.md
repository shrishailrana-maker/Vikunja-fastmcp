# Changelog

## 2.5.1 - 2026-08-20

- Apply task-write `fields.labels` through the task-label API and return applied
  labels instead of silently discarding them.
- Accept numeric label IDs for `set_status`, expose bounded per-row bulk error
  codes/messages, deduplicate generated actor attribution, and report the
  accepted actor syntax plus duplicate workflow-label titles in diagnostics.

- Refresh the checked-in Vikunja v2 OpenAPI snapshot to the live v2.5.0
  contract and raise the minimum supported server baseline to Vikunja 2.5.0.
- Add guarded task duplication, idempotent mark-read, and bounded project-verified
  task time-entry reads using native v2 routes.
- Raise the typed-schema benchmark ceiling to 62,000 characters to account for
  those three guarded action branches without removing any scope or fields.
- Detect Vikunja Pro entitlements from `/info`, surface them through
  `self_check`, and identify the license-gated time-entry response explicitly.
- Tolerate the v2.5 OpenAPI/runtime disagreement where Pro entitlements are
  documented as integer enums but serialized as string keys.
- Raise the compatibility schema benchmark ceiling to 92,000 characters for
  the legacy broad router plus the v2.5 typed actions.
- Raise the typed schema benchmark ceiling to 63,000 characters for the
  bounded label selectors, numeric status IDs, and diagnostics fields.

## 2.4.109 - 2026-08-08

- Accept delegated actor syntax such as `Codex (as srana)` and normalize it
  before attribution and task filtering.
- Return normal MCP `structuredContent` for success, validation, diagnostics,
  configuration, and upstream error results while retaining redacted text.
- Reconcile configured status-prefix labels during `close_with_evidence` and
  report partial outcomes when label repair fails after task closure.
- Retry one transient project-catalog failure and skip malformed unrelated
  project rows without weakening title-resolution completeness.
- Resolve projects before claiming direct-create idempotency keys, so a
  proven pre-write failure does not burn a corrected retry.

## 2.4.108 - 2026-08-04

- Publish `destructiveHint: false` for every MCP tool so task updates and other
  writes do not trigger destructive-tool approval warnings. Runtime mutation
  scope, validation, dry-run, idempotency, and receipt safeguards remain active.

## 2.4.107 - 2026-08-04

- Expose the complete typed MCP tool surface through the `core`, `qa`,
  `developer`, and `full` profiles so coding agents can create tasks, manage
  labels, and use administrative, export, webhook, and migration APIs without
  switching profiles.
- Keep the redundant broad `vikunja_tasks` router exclusive to
  `compatibility`, and update profile documentation, skill guidance, tests,
  and schema benchmarks.
- Pin patched transitive versions of `fast-uri`, `hono`, and `ip-address` to
  resolve newly published production dependency advisories.

## 2.4.106 - 2026-08-03

- Add `vikunja_task_read` `my_tasks` for bounded, cursor-based lists of tasks
  assigned to the authenticated user, with open/closed/all state mapping and
  a compact current-user identity.
- Refresh the typed runtime contract, README, packaged skill, and generated
  MCP API metadata.

## 2.4.105 - 2026-08-03

- Fix task-identifier lookup so unrelated `/projects` rows without usable
  identifiers no longer break the lookup. Identified project rows still
  receive strict validation.

## 2.4.104 - 2026-08-02

- Apply optional first comments and relations during `create`,
  `create_if_absent`, `upsert`, and per-row bulk create with durable
  sub-operation receipts and explicit partial outcomes.
- Make project-export receipts observable with task count, actual Vikunja API
  request count, elapsed milliseconds, and an explicit completion flag.
- Add migration API-call estimates and a durable `cancel` action that is
  checked before the next destination write and immediately before source
  archival.
- Refresh the typed runtime schemas, generated `MCP_API.md`, README, packaged
  skill, v2 contract, and implementation plan for the completed API surface.
- Freeze the former Python fallback as the non-executable
  `fallback/vikunja-cli.py.txt` historical reference. It is no longer tested,
  supported, or included with its old test and dependency files in npm packs.
- Reject protocol-relative Markdown links and IPv4-mapped IPv6 webhook targets,
  preserve stream cancellation, and make converter placeholders collision-safe.
- Bind attachment idempotency keys to one complete batch, bound raw base64
  envelopes before normalization, and isolate malformed files during retries.
- Make delta cursors carry and validate their original query boundary, preserve
  semantic no-op descriptions, and keep stable sorting on cursor-only resumes.
- Resume failed CSV label application without recreating tasks, harden exported
  CSV formula cells, include updated timestamps, and correct resumed migration
  counts and legacy native-bulk selector validation.
- Add structured-only `minimal` read and `receipt` write response modes, now the
  default, while preserving explicit compact, standard, and full compatibility.
- Add task field projection, opt-in URLs, bounded title length, response-size
  budgets, and resumable cursors for task lists.
- Enforce response-character budgets in the release benchmark for self-check,
  projected task reads, large lists, writes, and errors.
- Replace the default mega task router with focused read, write, and workflow
  tools; retain the router only in the explicit compatibility profile.
- Add `core`, `qa`, `developer`, `full`, and `compatibility` tool profiles plus
  release-gated schema-size budgets for each profile.
- Add precise title/description search, changed-since reads, bounded batch get,
  task verification, programme snapshots, and durable receipt lookup.
- Require a complete mutation envelope for typed writes, add universal dry-run,
  compact receipts, content-keyed evidence append, and verified closure.
- Add durable SQLite/WAL bulk row receipts, resumable status cursors, immutable
  result hashes, retry classification, and lease-owner-checked state changes.
- Add optional local attachment SHA-256 receipts and metadata duplicate warnings
  without claiming server-enforced content deduplication.
- Add bounded comment deltas with `since`, `countOnly`, latest-comment metadata,
  truthful continuation, and scan limits.
- Add a full-profile project migration workflow with mandatory public
  sanitization, trusted GitHub host enforcement, versioned manifest hashes,
  destination issue/comment read-back, durable per-task receipts, and safe
  optional source archival.
- Report upstream-dependent uniqueness, conditional-write, atomic-transition,
  cross-host lease, attachment-hash, and collection-ETag capabilities in full
  diagnostics with explicit local fallback descriptions.
- Refresh the packaged skill and replace separate install/update instructions
  with one generic npm `@latest` prompt that installs or reuses one user-wide
  skill copy.
- Stop durable and bulk mutations immediately after local lease ownership is
  lost; stale workers cannot finalize or overwrite operation receipts.
- Apply one character budget to complete minimal task-list responses, omit
  repeated project objects from rows, and support resumable multi-project and
  stable changed-since cursors.
- Redact fine-grained and exact configured GitHub credentials from public
  migration manifests, including whitespace-normalized credentials, in
  addition to Vikunja credentials and private URLs.
- Synchronize generated API defaults with the runtime's minimal response mode.
- Treat expired or lease-lost durable writes as outcome-unknown so retries
  cannot replay a mutation whose remote result is ambiguous.
- Recheck migration source timestamps immediately before archival and pass the
  same optimistic-concurrency value into the close operation.
- Bound full task detail, rich project exports, attachment batches, aggregate
  attachment bytes, project subsets, and direct bulk updates.
- Preserve task-list page size inside continuation cursors and reject resumes
  that change it.
- Cache numeric project resolution, preserve duplicate-title ambiguity, and
  share concurrent project-catalog requests.
- Enforce local attachment/CSV source roots, reject source symlinks, create
  private temp artifacts, and expand GitHub-token redaction.
- Harden the emergency Python fallback against multipart-header injection,
  spreadsheet formulas, symlink escapes, arbitrary source reads, and permissive
  output files.
- Emit Zod string, numeric, array, and object constraints in runtime MCP JSON
  schemas instead of losing limits during conversion.
- Deduplicate repeated complex JSON schemas through local definitions, keeping
  every profile below its token budget while retaining action-specific fields.
- Bound durable bulk status cursors and reject direct bulk updates above 100
  tasks.
- Preserve project scope in verification reads, sort latest-comment queries
  explicitly, and compare delta timestamps by instant rather than by text.
- Correct CSV date layouts, headerless row numbering, and row hashes so all
  imported task fields participate in retry deduplication.
- Preserve rich stored HTML during description append and harden Markdown link,
  code, entity, and placeholder handling.
- Redact credentialed public URLs, isolate durable receipts by API credential,
  and reject unsafe cleartext, credentialed, or private webhook targets.
- Add explicit overwrite controls and truthful user-export availability; raise
  the bounded rich project-export default to 1,000 tasks.
- Separate definite attachment failures from unknown remote outcomes, retry
  failed create attachments without recreating the task, and report missing
  local files per item.
- Serialize template writes and team-admin toggles, validate malformed project
  and user API rows, refresh stale project-identifier catalogs once, and avoid
  fabricated write receipts or dry-run task links.
- Make package metadata failures non-fatal, classify request timeouts as
  offline diagnostics, and map malformed GitHub destinations to typed errors.

## 2.4.103 - 2026-07-31

- Add the typed `vikunja_task_attachments` tool for upload, bounded listing,
  authenticated download, and ownership-safe deletion.
- Add compatible `delete-attachment`, paging, count-only, and filename-prefix
  options to the existing `vikunja_tasks` attachment actions.
- Require explicit project scope, `confirm:true`, actor attribution, and a
  durable idempotency key before deleting an attachment.
- Verify attachment ownership before deletion and return deleted metadata plus
  the remaining attachment count; identical retries perform no API requests.
- Canonicalize trailing actor text to exactly one `(by actor)` suffix and make
  structured `actor` the only attribution source in the packaged skill.
- Redact configured tokens and bearer values from API errors, self-check
  diagnostics, attachment failures, stack text, and all MCP tool envelopes.

## 2.4.102 - 2026-07-28

- Replace overloaded numeric/string task inputs with explicit `{globalId}`,
  `{identifier}`, or `{projectIndex}` selectors; bare values are rejected.
- Persist idempotency receipts in a SQLite/WAL ledger for 30 days by default,
  surviving MCP restarts and concurrent local agent processes.
- Bind caller idempotency keys to one payload and reject conflicting reuse.
- Prevent concurrent same-key writes on one machine with atomic SQLite
  execution leases and scope default ledger files to `VIKUNJA_URL`.
- Renew active execution leases so healthy long-running transfers and bulk
  operations cannot admit a duplicate retry after the initial lease window.
- Add durable per-row bulk receipts, resumable retries, and bulk operation
  status lookup; successful rows are not repeated.
- Require actor attribution for task creation, every comment mutation, closing,
  imports, and mutating bulk operations.
- Require `expectedUpdatedAt` for title or full-description replacements and
  for matched upserts that replace either field.
- Diagnose Vikunja's `subscription.entity: expected integer` response defect
  as `VIKUNJA_SUBSCRIPTION_SCHEMA_BUG` with its upstream issue, without
  misreporting authentication or silently changing subscriptions.
- Recover a task update from that upstream response defect only when a fresh
  readback proves every requested field was applied.
- Update the packaged skill and public API guidance for explicit identity,
  durable receipts, safe retries, and optimistic replacement updates.
- Preserve inline code containing underscores during Markdown-to-HTML
  conversion instead of leaking internal placeholders into comments.

## 2.4.101 - 2026-07-25

- Resolve full task identifiers such as `ALPHA-517` directly from the
  project identifier without requiring a separate `projectSelector`.
- Reject unknown, duplicate, or conflicting project identifiers instead of
  guessing from the task's local index.
- Cache project-identifier mappings for repeated task lookups while preserving
  existing cache invalidation behavior.
- Keep bare numeric selectors as global database IDs and bare `#index`
  selectors explicitly project-scoped.
- Show one project task identifier in human summaries while retaining global
  IDs in structured data and direct task-link targets.
- Update the packaged agent skill and generated MCP API reference for the new
  identity contract.

## 2.4.100 - 2026-07-23

- Add stable-key task `upsert` with `externalKey`, exact marker verification,
  ambiguity protection, optimistic concurrency, and no full-scan fallback.
- Make bulk create continue after row failures, return compact per-row outcomes,
  support stable-key upserts, and cache whole-batch idempotent retries.
- Add bounded bulk assign and unassign with one user resolution, optional dry
  runs, project verification, already-correct counts, and per-task failures.
- Accept numeric label IDs in apply/remove operations so duplicate global label
  titles do not block an explicitly identified mutation.
- Lead task write summaries with the project portal reference and always pair
  it with the global database ID.
- Return compact task write targets by default while retaining full targets in
  explicit standard and full response modes.
- Add server-side `descriptionContains` and actor-attribution task-list filters.
- Add optional comments, attachment metadata, and relation metadata with
  per-task counts to JSON and CSV project exports.
- Add `appendDescription` for safe partial description updates with optimistic
  concurrency and stable-key-marker preservation.
- Include a compact task-to-attachment mapping in attach responses.
- Make attachment retries idempotent through the existing process-local cache.
- Make every bulk mutation retry-safe with payload-fingerprinted process-local
  idempotency keys while leaving dry runs uncached.
- Use `vikunja-fastmcp@latest` as the only public installation source and add
  readable cross-platform verification and MCP configuration guidance.
- Make actor task filters compatible with Vikunja 2.4 by matching the stored
  attribution text without tokenizer-rejected parentheses.

## 2.4.0 - 2026-07-22

### Vikunja 2.4.0

- Refresh the checked-in API contract from Vikunja 2.4.0 and require that
  latest v2 surface instead of retaining older API compatibility behavior.
- Remove the Vikunja 2.3 task-update PATCH-to-PUT workaround; task and reminder
  updates now use the documented RFC 6902 PATCH route directly.
- Remove the same obsolete PATCH-to-PUT workaround from the emergency Python
  fallback and require Vikunja 2.4.0 there as well.
- Require the current `requests` 2.34.2 release for new fallback CLI setups.
- Reject bare-array or malformed collection responses instead of silently
  treating API drift as an empty result.
- Verify user-export downloads against `Content-Length` and remove partial ZIP
  files when a transfer is truncated.

### Development Toolchain

- Compile and type-check with TypeScript 7.0 while retaining the TypeScript 6
  API package required by ESLint and Jest tooling.
- Refresh compatible development-tool patch releases without taking the
  unrelated ESLint 10 or Zod 4 major-version changes.

### Workflow Safety And Efficiency

- Add configurable mutation project enforcement. Global-ID writes without
  `projectSelector` are rejected under the default
  `VIKUNJA_MUTATION_SCOPE_MODE=require`; `warn` and `off` remain available as
  temporary migration aids.
- Bound streamed attachment and user-export downloads by inactivity instead of
  total duration, so a healthy large transfer is no longer cut off at the
  transfer timeout while a stalled stream still fails with `REQUEST_TIMEOUT`.
- Report `unchanged` instead of issuing a no-op PATCH when clearing the due
  date of a task that has none.
- Return compact related-task summaries from `list-relations` by default;
  `responseMode: "standard"` or `"full"` restores the larger task bodies.
- Add optional actor attribution to task creation, comment creation,
  evidence-close, and idempotent CSV import workflows.
- Add compact project summaries grouped by done state, priority, labels, and
  the configured status-label prefix without returning task bodies.
- Add `set_status`, which replaces all labels in the configured status group
  in one request, repairs multiple-status tasks, and does not create a missing
  label unless explicitly requested.
- Add a bounded process-local idempotent CSV mode with preview, deterministic
  row hashes, same-key rerun skipping, and honest created/skipped/failed counts.
  Native CSV migration remains the fast non-idempotent path.

## 2.3.997 - 2026-07-22

### Agent Search And Guidance

- Accept `search` as a backward-compatible task-list alias for Vikunja's native
  `q` free-text parameter; reject conflicting `q` and `search` values.
- Preserve Zod field descriptions in the operation-specific MCP JSON Schema so
  clients can explain aliases and constrained fields without a diagnostic call.
- Clarify in the packaged skill that bare numeric task selectors are global
  database IDs, while portal references such as `#360` require explicit project
  scope.
- Document direct free-text search, the 100-item page ceiling, and Markdown-safe
  formatting for file paths and code identifiers.
- Make the copy-paste update prompt follow npm's `latest` dist-tag instead of a
  hardcoded release number.

### Test Reliability

- Isolate the streamed-download test with its own temporary directory instead
  of mocking directory creation and depending on leftover filesystem state.

### Security

- Pin patched transitive `fast-uri` and `@hono/node-server` releases so fresh
  installations do not retain the published host-confusion and Windows
  static-path traversal advisories. The MCP remains a stdio-only server and
  does not expose Hono's static-file transport.

## 2.3.996 - 2026-07-20

### Performance And Token Usage

- Make compact task list and get responses the default, with explicit
  `standard` and `full` modes plus the `VIKUNJA_MCP_RESPONSE_MODE` server
  default.
- Reduce the default task page from 25 to 20, cap each project page at 100,
  hoist project metadata out of compact list items, and retain truthful
  continuation metadata.
- Include the creator username in compact task responses without expanding a
  full user object or requiring a second standard-mode request.
- Reuse the identity-resolution payload for compact and standard task reads,
  removing a duplicate task GET from the common read path.
- Make `self_check` compact by default; `detail: "full"` remains available for
  capability inventories and local diagnostic paths.
- Paginate comment listings with a 20-item default and a 100-item ceiling
  instead of returning unbounded comment history.
- Omit submitted evidence text from compact close receipts and update the
  packaged agent skill to prefer scoped, paginated, and count-only reads.

### Correctness And Reliability

- Reject unknown tool arguments and empty update payloads instead of silently
  discarding fields or issuing meaningless writes.
- Return honest `unchanged` receipts for no-op task updates, assignments, and
  label mutations.
- Make `close_with_evidence` retries process-locally idempotent so evidence
  comments are not duplicated after a lost response.
- Add a 30-second timeout for ordinary API requests and a separate 60-second
  timeout for streamed or multipart transfers. Both are operator-configurable.
- Recover a valid `dist-old` after interrupted atomic builds.
- Expand the OpenAPI capability gate to every route used by the public source.

### Security

- Require HTTP(S) API and browser URLs.
- Prevent download and export sandbox escapes through symlinked or junctioned
  parent paths.
- Neutralize spreadsheet formula-leading cells in generated CSV exports.

## 2.3.995 - 2026-07-12

- Add first-class task listing by exact assignee username, avoiding Vikunja's
  silent zero-result behavior when numeric user IDs are used in assignee filters.
- Ship a neutral `vikunja-fastmcp` agent skill covering project scope, task
  identity, pagination, write safety, attachments, and truthful errors.
- Expose the packaged skill path through `self_check` and document installation
  for Codex, Claude, and clients that use persistent agent rules.

## 2.3.994 - 2026-07-12

- Include task creator identity in task responses and project exports.
- Make repeated label application a successful `unchanged` operation.
- Add opt-in project comment export with `includeComments: true`.
- Publish action-specific tool schema branches and explicit list continuation hints.
- Add a documented emergency Python fallback as `fallback/vikunja-cli.py`.

## 2.3.993 - 2026-07-12

### Added

- Restored the eight compatibility tool names used by existing agent prompts.
- Native v2 bulk task update, CSV migration, user export, and project/user webhooks.
- Task reminder list/add/remove with the assigned-task update workaround preserved.
- Bounded composed task create/delete, local project JSON/CSV export, and machine-local templates.

### Safety

- Bulk delete requires explicit confirmation and composed batches are capped at 100 tasks.
- Downloads and exports remain inside the configured attachment sandbox.
- Passwords and webhook credentials are write-only and never returned.
- Large list requests are capped at 100 items per project page with truthful continuation metadata, and JSON envelopes are compact to reduce agent token cost.

## 2.3.992 - 2026-07-12

### Fixed

- Start correctly when `dist/index.js` is launched through the shared `current` junction or another filesystem symlink.

## 2.3.991 - 2026-07-12

First public release of the clean-room Vikunja v2 MCP server.

### Added

- Explicit single-project, multi-project subset, and deliberate all-project task queries.
- Stable global task IDs plus project-scoped portal references such as `#305`.
- Compact agent-ready Markdown with one normalized JSON envelope per response.
- Open-task defaults, exact priority and label filtering, truthful pagination, and count-only queries.
- Task CRUD, comments, labels, assignees, relations, teams, saved filters, and attachments.
- Streamed attachment download to a sandboxed local directory with size and path protections.
- Safe composed operations including `create_if_absent` and `close_with_evidence`.
- Self-check output covering version, build, API, authentication, projects, and supported operations.
- Generated `MCP_API.md` reference synchronized with the registered tool schemas.

### Compatibility And Safety

- Supports Vikunja `/api/v2` only and rejects v1 URLs.
- Preserves real HTTP status and field errors without misleading JWT advice.
- Handles the Vikunja v2.3 assigned-task subscription validation defect with a narrowly guarded update fallback.
- Redacts credentials and prevents tokens from entering URLs, responses, logs, or generated documentation.

### Verification

- 180 automated tests covering formatting, identity, errors, scoping, security, tasks, attachments, teams, and filters.
- Live developer/tester acceptance against large neutral project fixtures, including
  1,772-task all-project queries.
