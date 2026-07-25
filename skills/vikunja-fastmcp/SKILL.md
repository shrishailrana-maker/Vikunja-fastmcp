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
  bare `#index` operation. A full identifier such as `ALPHA-517` resolves its
  project on its own; an explicit `projectSelector` remains a wrong-project guard.
  Use `projects` or `allProjects: true` only deliberately.
### One human reference: `ALPHA-517`

- Write every task reference as the project identifier, such as `ALPHA-517`, in
  chat, headings, lists, reports, prompts, commit messages, and task comments.
  Never a bare number, and never a `PROJ #ref (id N)` pair.
- The global database ID, such as `9005`, is internal. Use it in MCP calls and
  in `/tasks/{id}` URLs only. Keep it out of owner-facing text.
- Label links with the human reference:
  `[ALPHA-517](https://vikunja.example.com/tasks/9005)`.
- A bare portal number is ambiguous and must never be guessed because different
  projects may each contain task `#517`. When the owner writes "bug 517",
  resolve it against the project the repository's `AGENTS.md` declares as its
  scope; if no project is declared, ask which one. Never reinterpret it as
  global ID 517.
- Always write back the complete reference, such as `ALPHA-517`, so the next
  reader has no ambiguity to resolve.

### Resolving a reference

- Fetch ALPHA-517 directly with `taskSelector: "ALPHA-517"`. The identifier prefix
  resolves the project case-insensitively. Supplying `projectSelector` as well
  is optional wrong-project protection and must agree with the prefix.
- A bare portal reference such as `taskSelector: "#517"` still requires
  `projectSelector: { title: "Alpha" }` because the number repeats across projects.
- A bare numeric selector means the global database ID and can silently return
  a different task from the human reference. Never look up an owner reference
  this way.
- Responses carry `identifier` (`ALPHA-517`), `index` (the portal number), and
  `id` (global). Read `identifier` to confirm the right task.
- Before update, close, reopen, unassign, unlabel, unrelate, or delete, get the
  task and verify its `identifier`, project, and title against what was asked.
  Stop and report any mismatch.
- A project with no identifier falls back to a bare `#n`, which is ambiguous
  across projects. Set an identifier on every project that holds real work.
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

- Prefer `vikunja_task_bulk` `create` (or `upsert` with `externalKey`) when
  filing 3 or more tasks.
- Use `upsert` with a stable `externalKey`, such as file plus line plus
  detector, so reruns update the existing finding instead of duplicating it.
- Prefer `create_if_absent` for duplicate-sensitive creation, while remembering
  it is best-effort rather than a distributed lock.
- Add verification evidence before closing work. Use `close_with_evidence` when appropriate.
- Pass `actor` on create, comment, evidence-close, and idempotent import so the
  MCP appends durable attribution once.
- Use `set_status` to replace all labels in the configured status-prefix group
  in one request. Keep `createIfMissing: false` unless label creation is
  explicitly intended.
- When a label title is ambiguous, pass the numeric label ID.
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
