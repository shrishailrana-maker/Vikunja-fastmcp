# Changelog

## Unreleased

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
- Live developer/tester acceptance against large DFF2 and DMS task sets, including 1,772-task all-project queries.
