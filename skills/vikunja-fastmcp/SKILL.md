---
name: vikunja-fastmcp
description: Use for every task, bug, project, comment, label, assignee, relation, attachment, bulk, import, export, template, team, filter, reminder, or webhook action performed through the Vikunja FastMCP server.
---

# Vikunja FastMCP

Use the configured `vikunja` MCP server. Do not call Vikunja with ad hoc HTTP
requests or legacy tracker scripts while the MCP is available.

## Start

1. Run `self_check` before the first tracker operation in a session.
2. Confirm the API is v2, authentication is valid, and the intended project is visible.
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
- Paginate large results and follow each project's independent `nextPage` value.
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
- Read `MCP_API.md` from `self_check.apiDocumentPath` for exact tool contracts.

