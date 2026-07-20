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
- Before update, close, reopen, unassign, unlabel, unrelate, or delete, get the
  task and verify its global ID, project, and title.
- Never parse a `#N` prefix inside task title text as task identity.

## Lists And Searches

- Lists default to open tasks. Use `allStates: true` for open and closed tasks.
- Use `assignee: "username"` for assignee lists. Vikunja list filters require
  usernames; numeric user IDs are only for operations that explicitly accept IDs.
- Prefer `countOnly: true` when only a total is needed.
- Task list/get responses are compact by default. Request `standard` or `full`
  only when the omitted fields are required for the current operation.
- Paginate large results and follow each project's independent `nextPage` value.
- Comment lists default to 20 items; request only the `page` and `perPage` needed.
- Keep searches scoped. Avoid `allProjects` when a project subset is known.

## Writes

- Prefer `create_if_absent` for duplicate-sensitive creation, while remembering
  it is best-effort rather than a distributed lock.
- Add verification evidence before closing work. Use `close_with_evidence` when appropriate.
- Make comments and important writes identify the actual agent or user acting.
- Treat composed bulk create/delete operations as bounded and non-atomic.
- Use one writer per task when several agents are active.

## Attachments And Errors

- Upload evidence through attachment operations and download through the MCP's
  sandboxed path. Do not put bearer tokens in download URLs.
- A `401` means the token or API URL is invalid or expired. A `403` means the
  authenticated identity lacks permission. Preserve the real status.
- When exact tool contracts are needed, call `self_check` with `detail: "full"`
  once and read `MCP_API.md` from its `apiDocumentPath`.
