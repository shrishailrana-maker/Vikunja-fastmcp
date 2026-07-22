---
name: vikunja-fastmcp
description: Use for every task, bug, project, comment, label, assignee, relation, attachment, bulk, import, export, template, team, filter, reminder, or webhook action performed through the Vikunja FastMCP server.
---

# Vikunja FastMCP

Use the configured `vikunja` MCP server. Do not call Vikunja with ad hoc HTTP
requests or legacy tracker scripts while the MCP is available.

## Start

1. Do not run `self_check` as a routine session warm-up. Use the compact default
   only when connectivity is uncertain; use `detail: "full"` only when reporting
   an exact version, diagnosing configuration, or locating packaged files.
2. For normal work, choose the intended project explicitly on the requested
   operation instead of loading diagnostic inventories first.
3. Never print or store API tokens in chat, commands, logs, task content, or repositories.

## Scope And Identity

- Pass `projectSelector` for every project-specific list, search, create, or
  portal-index operation. Use `projects` or `allProjects: true` only deliberately.
- A portal reference such as `#25` repeats across projects and requires a project.
- A numeric task ID is globally unique and is used in task URLs.
- A bare numeric selector always means the global database ID. For example,
  `taskSelector: 360` targets global task 360, not portal task `#360`. Resolve
  the portal task with `taskSelector: "#360"` plus an explicit
  `projectSelector`, such as `{ title: "Example Project" }`.
- Before update, close, reopen, unassign, unlabel, unrelate, or delete, get the
  task and verify its global ID, project, and title.
- Pass `projectSelector` on mutations even when using a global task ID. The
  server rejects unscoped global-ID mutations by default
  (`PROJECT_SCOPE_REQUIRED`); only deployments configured with `warn` or `off`
  allow them.
- Never parse a `#N` prefix inside task title text as task identity.

## Lists And Searches

- Lists default to open tasks. Use `allStates: true` for open and closed tasks.
- Use `q` for ordinary free-text task search; `search` is an equivalent alias.
  Use `filter` only for an explicitly requested Vikunja filter expression. Do
  not run `self_check` or probe filter syntax before a routine scoped search.
- Use `assignee: "username"` for assignee lists. Vikunja list filters require
  usernames; numeric user IDs are only for operations that explicitly accept IDs.
- Prefer `countOnly: true` when only a total is needed.
- Use `vikunja_tasks` `summary` for one-project counts by done state, priority,
  labels, and configured status labels without listing task bodies.
- Task list, get, and list-relations responses are compact by default. Request
  `standard` or `full` only when the omitted fields are required for the
  current operation.
- Task-list `perPage` must not exceed 100. Paginate larger results and follow
  each project's independent `nextPage` value.
- Comment lists default to 20 items; request only the `page` and `perPage` needed.
- Keep searches scoped. Avoid `allProjects` when a project subset is known.

## Writes

- Prefer `create_if_absent` for duplicate-sensitive creation, while remembering
  it is best-effort rather than a distributed lock.
- Add verification evidence before closing work. Use `close_with_evidence` when appropriate.
- Pass `actor` on create, comment, evidence-close, and idempotent import so the
  MCP appends durable attribution once.
- Use `set_status` to replace all labels in the configured status-prefix group
  in one request. Keep `createIfMissing: false` unless label creation is
  explicitly intended.
- Use CSV `mode: "idempotent"` plus a stable `idempotencyKey` for retry-safe
  row-by-row imports; use `mode: "native"` only when speed matters more than
  retry deduplication. Preview either mode before importing.
- Wrap file paths, commands, and code identifiers in inline backticks in task
  descriptions and comments so Markdown does not reinterpret underscores.
- Treat composed bulk create/delete operations as bounded and non-atomic.
- Use one writer per task when several agents are active.

## Attachments And Errors

- Upload evidence through attachment operations and download through the MCP's
  sandboxed path. Do not put bearer tokens in download URLs.
- A `401` means the token or API URL is invalid or expired. A `403` means the
  authenticated identity lacks permission. Preserve the real status.
- When exact tool contracts are needed, call `self_check` with `detail: "full"`
  once and read `MCP_API.md` from its `apiDocumentPath`.
