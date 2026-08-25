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
4. After installing or updating the npm package, reuse and refresh exactly one
   user-wide copy of this packaged skill. Install it when missing; do not leave
   stale project-local or versioned duplicates that can override it.
5. Use any of the `core`, `qa`, `developer`, or `full` profiles for typed-tool
   work; they expose the same complete typed surface. Use `compatibility` only
   while migrating a client that still calls the broad `vikunja_tasks` router.
6. All tools publish `destructiveHint: false` to suppress repeated client
   approval warnings. Continue to use project scope, mutation envelopes,
   dry-run, idempotency, and receipt verification for write safety.

7. Vikunja Pro gates `admin_panel`, `time_tracking`, and `audit_logs`. Read
   `enabledProFeatures` from `self_check` before using gated features. The
   typed time-entry action reports `FEATURE_NOT_LICENSED` when
   `time_tracking` is unavailable; do not retry its intentional 404.

## Scope And Identity

- Pass `projectSelector` for every project-specific list, search, create, or
  `taskSelector: { projectIndex: 517 }` operation. A full selector such as
  `taskSelector: { identifier: "ALPHA-517" }` resolves its project on its own;
  an explicit `projectSelector` remains a wrong-project guard. Use `projects`
  or `allProjects: true` only deliberately.

### One human reference: `ALPHA-517`

- Write every task reference as the project identifier, such as `ALPHA-517`, in
  chat, headings, lists, reports, prompts, commit messages, and task comments.
  Never a bare number, and never a `PROJ #ref (id N)` pair.
- The global database ID, such as `9005`, is internal. Use it in MCP calls and
  in `/tasks/{id}` URLs only. Keep it out of Boss-facing text.
- Label links with the human reference:
  `[ALPHA-517](https://vikunja.example.com/tasks/9005)`.
- A bare portal number is ambiguous and must never be guessed because different
  projects may each contain task `#517`. When the Boss writes "bug 517",
  resolve it against the project the repository's `AGENTS.md` declares as its
  scope; if no project is declared, ask which one. Never reinterpret it as
  global ID 517.
- Always write back the complete reference, such as `ALPHA-517`, so the next
  reader has no ambiguity to resolve.

### Resolving a reference

- Fetch ALPHA-517 with `taskSelector: { identifier: "ALPHA-517" }`. The
  identifier prefix resolves the project case-insensitively. Supplying
  `projectSelector` as well is optional wrong-project protection and must agree
  with the prefix.
- Use `taskSelector: { projectIndex: 517 }` only with
  `projectSelector: { title: "Alpha" }`, because project indexes repeat.
- Use `taskSelector: { globalId: 9005 }` only for an already-verified database
  ID. Bare numbers and strings are rejected; never reinterpret a human
  reference as a global ID.
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
- Use `vikunja_task_read` with `action: "my_tasks"` for the authenticated user's
  assigned tasks. Pass exactly one of `projectSelector`, `projects`, or
  `allProjects: true`; `state` defaults to `open` and accepts `closed` or `all`.
  The response exposes only the current user's `id` and `username`.
- Prefer `countOnly: true` when only a total is needed.
- Use `vikunja_task_read` `summary` for one-project counts by done state, priority,
  labels, and configured status labels without listing task bodies.
- Reads use structured-only `minimal` responses by default. They include the
  bounded audit fields needed for reconciliation; request an explicit `fields`
  projection to reduce them further. Leave descriptions, comments, attachments,
  relations, and expanded user objects out unless the current operation needs
  them. Use `standard` or `full` only for deliberately expanded detail.
- Default task reads now include audit metadata: creator, createdAt, updatedAt,
  labels, workflow status, direct task URL, and descriptionVersion. Use the
  returned updatedAt as expectedUpdatedAt for replacement updates. The server
  does not expose a reliable last editor or complete field-change history.
- Use `activity` for current task audit metadata plus bounded recent comments.
  It reports unavailable server history explicitly. Use `evidence_search` with
  project scope for bounded exact evidence-key duplicate checks; never treat an
  incomplete result as proof of absence.
- Use `batch_get` for several known human identifiers, `verify_task_state` for
  one bounded status/evidence check, and `programme_snapshot` for project
  aggregates. Use `changedSince` for delta reads instead of re-listing an
  unchanged project.
- Task-list `perPage` must not exceed 100. Paginate larger results and follow
  `nextCursor` whenever `incomplete` is true. Resume a multi-project cursor
  with the same ordered project scope.
- Comment lists default to 20 items. Use `since`, `countOnly`, and
  `includeLatest` to avoid loading old comment bodies.
- On Vikunja v2.5, use `vikunja_task_read` with `action: "list_time_entries"`
  for one project-verified, bounded task time-entry page. Set `countOnly: true`
  when only the total is needed; the route returns server-provided numeric
  user IDs and does not infer user profiles.
- Keep searches scoped. Avoid `allProjects` when a project subset is known.

## Writes

- Prefer `vikunja_task_bulk` `create` (or `upsert` with `externalKey`) when
  filing 3 or more tasks.
- Add `firstComment` and `relations` directly to create, create-if-absent,
  upsert, or a bulk-create row instead of making separate follow-up calls.
  Inspect the durable row receipt when a composed sub-operation is partial.
- Use `upsert` with a stable `externalKey`, such as file plus line plus
  detector, so reruns update the existing finding instead of duplicating it.
- `fields.labels` on create/upsert accepts label titles or numeric IDs, applies
  them through the task-label route, and appears in the receipt; unsupported
  task-write fields must fail validation rather than being silently ignored.
- Prefer `create_if_absent` for duplicate-sensitive creation, while remembering
  it is best-effort rather than a distributed lock.
- To copy a task on Vikunja v2.5, use `vikunja_task_write` with
  `action: "duplicate"`, explicit task/project selectors, `confirm: true`, an
  actor, and a stable idempotency key. The native duplicate route does not
  promise attachment or relation copying in its contract; inspect the returned
  target and add any required child data explicitly.
- Use `vikunja_task_workflow` with `action: "mark_read"` to clear the current
  user's unread state. It is an idempotent server no-op when already read, but
  still requires explicit selectors, actor attribution, and a stable receipt
  key in this MCP.
- Add verification evidence before closing work. Use `close_with_evidence` when appropriate.
- Use `append_evidence_if_changed` with a stable evidence key when repeated
  builds may produce the same proof. Use `close_if_verified` when closure must
  depend on a structured verification receipt.
- Pass `actor` on create, every comment mutation, close, import, and every
  mutating bulk call. These operations reject missing attribution.
- Delegated actors such as `Codex (as srana)` are accepted and normalized to
  `Codex as srana` for stored attribution and parser-safe task filters.
- Treat structured `actor` as the only attribution source. Do not also write
  `by <agent>` or `Actor: <agent>` in the description or comment text; the MCP
  appends one canonical suffix.
- Pass a stable `idempotencyKey` on task creation, comment creation, attachment
  upload, evidence-close, and every mutating bulk call. Reuse the same key only
  for the identical payload.
- If `IDEMPOTENCY_OPERATION_IN_PROGRESS` is returned, wait briefly and retry
  the identical payload with the same key. Never invent a second key for the
  same intended write.
- If an attachment receipt reports `unknown`, do not treat it as failed or
  upload with a new key. List the task attachments, then retry only the
  identical payload and idempotency key when needed.
- Use bulk `status` with the returned `operationId`, or rerun the same bulk
  payload and key, to resume failed rows without repeating recorded successes.
- Before replacing a task title or full description, run `get` and pass its
  `updated` timestamp as `expectedUpdatedAt`. Prefer `appendDescription` when
  only adding evidence.
- Use `set_status` to replace all labels in the configured status-prefix group
  in one request. Keep `createIfMissing: false` unless label creation is
  explicitly intended. `statusLabel` accepts a title or numeric label ID; use
  the numeric ID when duplicate global titles exist. `self_check` detail=full
  reports duplicate workflow-label titles and candidate IDs.
- When a label title is ambiguous, pass the numeric label ID.
- Use CSV `mode: "idempotent"` plus a stable `idempotencyKey` for retry-safe
  row-by-row imports; use `mode: "native"` only when speed matters more than
  retry deduplication. Preview either mode before importing.
- Wrap file paths, commands, and code identifiers in inline backticks in task
  descriptions and comments so Markdown does not reinterpret underscores.
- Treat composed bulk operations as bounded and non-atomic. Their durable
  SQLite receipts survive local MCP restarts and prevent concurrent same-key
  writes on one machine, but they are not a distributed lock between machines.
- Bulk mutations return counts plus bounded per-row error codes/messages by
  default. Read item receipts through the operation `status` cursor when a
  failed or skipped row needs the full receipt.
- Mutation responses use structured-only `receipt` mode by default. Do not ask
  for `standard` or `full` merely to restate submitted text.
- Read `structuredContent` first. It carries the same redacted `{ok,data}` or
  `{ok:false,error}` envelope as the text fallback.
- A close-with-evidence receipt reports and removes configured status-prefix
  labels. Project-title lookup retries one transient catalog failure and fails
  closed if malformed data could match the requested title.
- Use one writer per task when several agents are active.

## Attachments And Errors

- Upload evidence through attachment operations and download through the MCP's
  sandboxed path. Do not put bearer tokens in download URLs.
- Keep upload and CSV-import files under a configured
  `VIKUNJA_ATTACHMENT_SOURCE_ROOTS` directory. Source symlinks and arbitrary
  paths outside those roots are rejected.
- Upload no more than 20 attachments per call. For full task detail, comments
  default to five and attachments to 20; request larger bounded limits only
  when the current task needs them.
- Prefer the typed `vikunja_task_attachments` tool. Bound large lists with
  `page` and `perPage`, or use `countOnly`/`filenamePrefix`.
- Request local `computeSha256` only when a content receipt is needed. Treat
  `warnOnDuplicate` as a warning based on available metadata/local hashes, not
  as server-enforced deduplication.
- Delete an attachment only with its task, explicit project scope,
  `confirm:true`, `actor`, and a stable `idempotencyKey`. The MCP verifies the
  attachment belongs to that task before deleting it.
- Use `overwrite: true` only when deliberately replacing a sandboxed download
  or export. Webhook targets must be credential-free public HTTPS URLs.
- A `401` means the token or API URL is invalid or expired. A `403` means the
  authenticated identity lacks permission. Preserve the real status.
- `VIKUNJA_SUBSCRIPTION_SCHEMA_BUG` means Vikunja returned the known invalid
  `subscription.entity` response while processing a task write. Task updates
  automatically read back the requested fields and succeed only when the write
  is proven. If the error remains, keep the task open, preserve the evidence,
  and reference
  `https://github.com/go-vikunja/vikunja/issues/3316`; do not reconnect auth or
  silently unsubscribe the user.
- When exact tool contracts are needed, call `self_check` with `detail: "full"`
  once and read `MCP_API.md` from its `apiDocumentPath`.

## Portable Migration

- Preview project migration first and review its API-call estimate, then run
  with one stable idempotency key and inspect paginated status receipts before
  archiving source tasks. Use `cancel` with the operation ID and actor to stop
  before the next destination write or source archival.
- Public sanitization is mandatory. The GitHub token comes only from the MCP
  process environment and must never be placed in tool arguments or task text.
- A source task closes only after the destination issue and every migrated
  comment read back exactly. A migration comment means migrated, not
  implemented.
- Binary attachments remain source metadata unless the reported destination
  capability says otherwise. Download important files separately before
  retiring the source tracker.
