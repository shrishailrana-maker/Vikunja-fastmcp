# Changelog

## Unreleased

- Make `self_check` compact by default and add `detail: "full"` for capability
  inventories and local diagnostic paths.
- Paginate comment listings with a 20-item default and a 100-item maximum,
  returning normalized continuation metadata.
- Update the packaged agent skill to avoid routine self-check calls and prefer
  scoped, paginated, count-only reads.
- Default task list/get responses to compact identity and state fields, with
  explicit `standard` and `full` modes plus `VIKUNJA_MCP_RESPONSE_MODE`.
- Reduce the default task page from 25 to 20, hoist project metadata out of
  compact list items, and omit submitted evidence text from close receipts.

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
