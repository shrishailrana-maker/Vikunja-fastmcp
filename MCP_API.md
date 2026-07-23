# Vikunja FastMCP V2 Tool Reference

This reference is generated automatically from runtime schemas.

Tools with multiple actions publish action-specific JSON Schema branches, so clients can present only the fields valid for the selected action.

All responses contain a short Markdown summary followed by exactly one fenced JSON envelope: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": ... }`. HTTP error status, method, and path are preserved and secrets are redacted.

## Identity And Scope

Numeric task selectors are global database IDs. A portal reference such as `#305` or `PRJ-305` requires an explicit `projectSelector`. Task lists require exactly one explicit scope: `projectSelector`, `projects`, or `allProjects: true`. Writes echo task title, project title/id, portal index, identifier, and global ID.

Compact task lists include the creator username as `creator` when Vikunja supplies `created_by`; standard and full task records use `creator: { id, username }`. Project exports always include creator identity; comments are included only when `includeComments: true` is requested.

## Tools

### `self_check`
* **Description**: Run a compact configuration and connection self-check; use detail=full only for diagnostics.
* **Parameters**:
  * `detail`: enum ["basic", "full"] (optional)

### `vikunja_auth`
* **Description**: Check connection and get currently authenticated user details or connection status.
* **Parameters**:
  * `action`: enum ["status", "self-check"] (required)
  * `detail`: enum ["basic", "full"] (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `status` | none | none | Direct: GET /user |
| `self-check` | none | detail (basic default, full for capabilities and local paths) | MCP-composed diagnostics |

### `vikunja_projects`
* **Description**: List visible projects or retrieve a specific project details.
* **Parameters**:
  * `action`: enum ["list", "get"] (required)
  * `project`: object (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `list` | none | none | Direct paginated GET /projects |
| `get` | project.id or project.title | none | Direct GET /projects/{id} |

### `vikunja_tasks`
* **Description**: Create, update, delete, close, assign, label, relate, or attach files to tasks.
* **Parameters**:
  * `action`: enum ["create", "create_if_absent", "upsert", "get", "list", "summary", "update", "delete", "close", "reopen", "close_with_evidence", "assign", "unassign", "list-assignees", "apply-label", "remove-label", "list-labels", "set_status", "relate", "unrelate", "list-relations", "attach", "list-attachments", "download-attachment"] (required)
  * `taskSelector`: string | number (optional)
  * `projectSelector`: object (optional)
  * `projects`: array (optional)
  * `allProjects`: boolean (optional)
  * `page`: number (optional); integer, min 1
  * `perPage`: number (optional); integer, min 1, max 1000
  * `commentLimit`: number (optional); integer, min 0, max 100
  * `done`: boolean (optional)
  * `allStates`: boolean (optional)
  * `priority`: number (optional); integer, min 0, max 5
  * `label`: string | number (optional)
  * `assignee`: string (optional); min 1
  * `descriptionContains`: string (optional)
  * `q`: string (optional)
  * `search`: string (optional)
  * `countOnly`: boolean (optional)
  * `filter`: string (optional)
  * `responseMode`: enum ["compact", "standard", "full"] (optional)
  * `fields`: object (optional)
  * `expectedUpdatedAt`: string (optional)
  * `evidenceComment`: string (optional); min 1
  * `actor`: string (optional); min 1, max 80
  * `userSelector`: string | number (optional)
  * `labelTitle`: string | number (optional)
  * `statusLabel`: string (optional); min 1
  * `createIfMissing`: boolean (optional)
  * `otherTaskSelector`: string | number (optional)
  * `relationKind`: string (optional)
  * `filename`: string (optional)
  * `mimeType`: string (optional)
  * `base64Content`: string (optional)
  * `filePaths`: array (optional)
  * `attachments`: array (optional)
  * `attachmentId`: number (optional); integer, min 0
  * `destinationPath`: string (optional)
  * `overwrite`: boolean (optional)
  * `idempotencyKey`: string (optional); min 1, max 200
  * `externalKey`: string (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `create` | projectSelector, fields.title | fields, idempotencyKey, attachments, actor, responseMode | Direct POST; MCP-composed when attachments are supplied. For 3 or more tasks use vikunja_task_bulk create instead of repeated create calls. |
| `create_if_absent` | projectSelector, fields.title | fields, idempotencyKey, attachments, actor, responseMode | MCP-composed exact-title search then optional create/attach. Best-effort duplicate prevention, not a distributed lock. |
| `upsert` | projectSelector, fields.title, externalKey | fields, expectedUpdatedAt, actor, responseMode | MCP-composed description-key lookup followed by create or conditional update. Requires server-side description filtering and never falls back to a full scan. |
| `get` | taskSelector | projectSelector (required for #index or PRJ-index), commentLimit (full mode only; default 5, max 100), responseMode (compact default; standard task; full bundled detail) | Direct compact/standard GET; full mode composes comments and attachments |
| `list` | none | exactly one of projectSelector, projects, allProjects, page (default 1), perPage (default 20; requests above 100 are safely capped to 100), done, allStates, priority (0-5), label, assignee (exact username; numeric user IDs are not valid Vikunja list filters), descriptionContains (requires server-side description filtering), actor (matches stored "(by actor)" attribution; requires server-side description filtering), q, search (free-text alias for q), filter, countOnly, responseMode (compact default; standard/full explicit) | Direct per project; grouped subsets/allProjects are MCP-composed. Defaults to done=false unless done or allStates is supplied. |
| `summary` | projectSelector | none | MCP-composed paginated counts by state, priority, and label |
| `update` | taskSelector, fields | projectSelector (required for #index or PRJ-index), expectedUpdatedAt, fields.appendDescription (mutually exclusive with fields.description), responseMode | Identity/read preflight followed by RFC 6902 PATCH |
| `delete` | taskSelector | projectSelector (required for #index or PRJ-index), responseMode | Identity preflight then DELETE /tasks/{id} |
| `close` | taskSelector | projectSelector (required for #index or PRJ-index), responseMode | Identity/read preflight then task update transport |
| `reopen` | taskSelector | projectSelector (required for #index or PRJ-index), responseMode | Identity/read preflight then task update transport |
| `close_with_evidence` | taskSelector, evidenceComment | projectSelector (required for #index or PRJ-index), idempotencyKey, actor, responseMode | MCP-composed comment create followed by task close |
| `assign` | taskSelector, userSelector | projectSelector (required for #index or PRJ-index), responseMode | Identity preflight then POST assignee |
| `unassign` | taskSelector, userSelector | projectSelector (required for #index or PRJ-index), responseMode | Identity preflight then DELETE assignee |
| `list-assignees` | taskSelector | projectSelector (required for #index or PRJ-index) | Direct GET after identity resolution |
| `apply-label` | taskSelector, labelTitle | projectSelector (required for #index or PRJ-index), responseMode | Return unchanged when already attached; otherwise resolve/create then POST task label. labelTitle accepts an exact title or numeric label ID. |
| `remove-label` | taskSelector, labelTitle | projectSelector (required for #index or PRJ-index), responseMode | Resolve label then DELETE task label. labelTitle accepts an exact title or numeric label ID. |
| `list-labels` | taskSelector | projectSelector (required for #index or PRJ-index) | Direct GET after identity resolution |
| `set_status` | taskSelector, statusLabel | projectSelector (required for #index or PRJ-index), createIfMissing (default false), responseMode | Identity preflight then one bulk label-set replacement. Preserves non-status labels and repairs multiple configured-prefix labels. |
| `relate` | taskSelector, otherTaskSelector, relationKind | projectSelector (required for #index or PRJ-index), responseMode | Resolve both tasks then POST relation |
| `unrelate` | taskSelector, otherTaskSelector, relationKind | projectSelector (required for #index or PRJ-index), responseMode | Resolve both tasks then DELETE relation |
| `list-relations` | taskSelector | projectSelector (required for #index or PRJ-index), responseMode (compact default; standard/full explicit) | MCP-composed from task related_tasks data |
| `attach` | taskSelector, filePaths or base64Content+filename | projectSelector (required for #index or PRJ-index), mimeType, idempotencyKey, responseMode | Multipart POST per file after identity resolution |
| `list-attachments` | taskSelector | projectSelector (required for #index or PRJ-index) | Direct GET after identity resolution |
| `download-attachment` | taskSelector, attachmentId | projectSelector (required for #index or PRJ-index), destinationPath, overwrite | Authenticated streaming GET to sandboxed local disk |

### `vikunja_task_comments`
* **Description**: Manage task comments (create, list, get, update, delete).
* **Parameters**:
  * `action`: enum ["create", "list", "get", "update", "delete"] (required)
  * `taskSelector`: string | number (required)
  * `projectSelector`: object (optional)
  * `commentId`: number (optional); integer, min 0
  * `comment`: string (optional); min 1
  * `idempotencyKey`: string (optional); min 1, max 200
  * `actor`: string (optional); min 1, max 80
  * `page`: number (optional); integer, min 0
  * `perPage`: number (optional); integer, min 1, max 100

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `create` | taskSelector, comment | projectSelector (required for #index or PRJ-index), idempotencyKey, actor | Direct POST after identity resolution |
| `list` | taskSelector | projectSelector (required for #index or PRJ-index), page (default 1), perPage (default 20, max 100) | Direct paginated GET after identity resolution |
| `get` | taskSelector, commentId | projectSelector (required for #index or PRJ-index) | Direct GET after identity resolution |
| `update` | taskSelector, commentId, comment | projectSelector (required for #index or PRJ-index) | Direct PATCH after identity resolution |
| `delete` | taskSelector, commentId | projectSelector (required for #index or PRJ-index) | Direct DELETE after identity resolution |

### `vikunja_labels`
* **Description**: List, get, create, update, or delete global labels.
* **Parameters**:
  * `action`: enum ["list", "get", "create", "update", "delete"] (required)
  * `labelSelector`: string | number (optional)
  * `title`: string (optional); min 1
  * `description`: string (optional)
  * `hexColor`: string (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `list` | none | none | Direct paginated GET /labels |
| `get` | labelSelector | none | Direct GET /labels/{id} |
| `create` | title | description, hexColor | Direct POST /labels |
| `update` | labelSelector | title, description, hexColor | Direct PATCH /labels/{id} |
| `delete` | labelSelector | none | Direct DELETE /labels/{id} |

### `vikunja_users`
* **Description**: Get current user profile or search other users.
* **Parameters**:
  * `action`: enum ["current", "search"] (required)
  * `q`: string (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `current` | none | none | Direct GET /user |
| `search` | none | q | Direct GET /users?q= |

### `vikunja_teams`
* **Description**: Manage teams and team members.
* **Parameters**:
  * `action`: enum ["list", "get", "create", "update", "delete", "add-member", "remove-member", "set-member-admin"] (required)
  * `teamId`: number (optional); integer, min 0
  * `name`: string (optional); min 1
  * `usernameOrId`: string | number (optional)
  * `admin`: boolean (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `list` | none | none | Direct paginated GET /teams |
| `get` | teamId | none | Direct GET /teams/{id} |
| `create` | name | none | Direct POST /teams |
| `update` | teamId, name | none | Direct PATCH /teams/{id} |
| `delete` | teamId | none | Direct DELETE /teams/{id} |
| `add-member` | teamId, usernameOrId (username only for add) | none | POST then authoritative team readback |
| `remove-member` | teamId, usernameOrId | none | Optional team readback then DELETE member |
| `set-member-admin` | teamId, usernameOrId, admin | none | Team readback then conditional POST toggle |

### `vikunja_filters`
* **Description**: Create, read, update, or delete saved filters. Listing is unsupported (no collection route in the Vikunja v2 API); see self_check.unsupportedOperations.
* **Parameters**:
  * `action`: enum ["create", "get", "update", "delete"] (required)
  * `filterId`: number (optional); integer, min 0
  * `title`: string (optional); min 1
  * `filterQuery`: string (optional)
  * `description`: string (optional)
  * `isFavorite`: boolean (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `create` | title, filterQuery | description, isFavorite | Direct POST /filters |
| `get` | filterId | none | Direct GET /filters/{id} |
| `update` | filterId | title, filterQuery, description, isFavorite | Direct PATCH /filters/{id} |
| `delete` | filterId | none | Direct DELETE /filters/{id} |

### `vikunja_task_bulk`
* **Description**: Preferred way to create or upsert several tasks in one call. Also supports bounded update, delete, assign, and unassign batches.
* **Parameters**:
  * `action`: enum ["update", "create", "delete", "assign", "unassign"] (required)
  * `taskIds`: array (optional)
  * `projectSelector`: object (optional)
  * `fields`: object (optional)
  * `tasks`: array (optional)
  * `userSelector`: string | number (optional)
  * `dryRun`: boolean (optional)
  * `idempotencyKey`: string (optional); min 1, max 200
  * `confirm`: boolean (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `update` | taskIds, fields | none | Direct PUT /tasks/bulk |
| `create` | projectSelector, tasks | idempotencyKey | MCP-composed bounded task creates; non-atomic. Each row may provide externalKey for stable-key upsert; failures do not abort later rows. |
| `delete` | taskIds, confirm | none | MCP-composed verified task deletes; non-atomic |
| `assign` | taskIds, userSelector | projectSelector, dryRun | Resolve user once, verify each task scope, then compose bounded assignee writes |
| `unassign` | taskIds, userSelector | projectSelector, dryRun | Resolve user once, verify each task scope, then compose bounded assignee deletes |

### `vikunja_task_reminders`
* **Description**: List, add, or remove reminders stored on a task.
* **Parameters**:
  * `action`: enum ["list", "add", "remove"] (required)
  * `taskSelector`: string | number (required)
  * `projectSelector`: object (optional)
  * `reminder`: string (optional)
  * `relativePeriod`: number (optional); integer
  * `relativeTo`: string (optional); min 1
  * `reminderIndex`: number (optional); integer, min 0

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `list` | taskSelector | projectSelector (required for #index or PRJ-index) | Direct task read; reminders are embedded task fields |
| `add` | taskSelector | projectSelector (required for #index or PRJ-index), reminder, relativePeriod, relativeTo | Task read followed by RFC 6902 PATCH of reminders |
| `remove` | taskSelector, reminderIndex | projectSelector (required for #index or PRJ-index) | Task read followed by RFC 6902 PATCH of reminders |

### `vikunja_batch_import`
* **Description**: Detect, preview, import, or inspect CSV data through native-fast or MCP-idempotent mode.
* **Parameters**:
  * `action`: enum ["detect", "preview", "import", "status"] (required)
  * `mode`: enum ["native", "idempotent"] (optional)
  * `filePath`: string (optional); min 1
  * `config`: object (optional)
  * `projectSelector`: object (optional)
  * `idempotencyKey`: string (optional); min 1, max 200
  * `actor`: string (optional); min 1, max 80

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `detect` | filePath | none | Direct multipart CSV detect |
| `preview` | filePath, config | mode (native default or idempotent), projectSelector | Direct multipart native preview or MCP-local idempotent preview |
| `import` | filePath, config | mode (native default or idempotent), idempotencyKey (required in idempotent mode), projectSelector, actor | Direct native migration or MCP-composed row-by-row task creation. Native mode is fast and non-idempotent; idempotent mode uses a process-local ledger. |
| `status` | none | mode (native default or idempotent), idempotencyKey (required in idempotent mode) | Direct native GET or compact process-local ledger status |

### `vikunja_export_project`
* **Description**: Export one project task list to a local JSON or CSV file.
* **Parameters**:
  * `projectSelector`: object (required)
  * `format`: enum ["json", "csv"] (optional)
  * `destinationPath`: string (optional)
  * `includeComments`: boolean (optional)
  * `includeAttachments`: boolean (optional)
  * `includeRelations`: boolean (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `export` | projectSelector | format, destinationPath, includeComments, includeAttachments, includeRelations | MCP-composed paginated export to sandboxed JSON or CSV. Creator is always included; comments, attachments, and relations are fetched only when their include flags are true. |

### `vikunja_request_user_export`
* **Description**: Request a native Vikunja user-data export. Password input is never returned.
* **Parameters**:
  * `password`: string (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `request` | none | password | Direct POST /user/export/request; password is write-only. Some Vikunja servers require JWT/local-password authentication for user exports. |

### `vikunja_download_user_export`
* **Description**: Check user-export status or download the ready archive to sandboxed local disk.
* **Parameters**:
  * `action`: enum ["status", "download"] (required)
  * `password`: string (optional)
  * `destinationPath`: string (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `status` | none | none | Direct GET /user/export |
| `download` | none | password, destinationPath | Authenticated streaming POST to sandboxed local disk. Some Vikunja servers require JWT/local-password authentication for user exports. |

### `vikunja_templates`
* **Description**: Manage machine-local task templates or instantiate one in an explicit project.
* **Parameters**:
  * `action`: enum ["create", "list", "get", "delete", "instantiate"] (required)
  * `templateSelector`: string (optional); min 1
  * `name`: string (optional); min 1
  * `fields`: object (optional)
  * `projectSelector`: object (optional)
  * `variables`: object (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `list` | none | none | Machine-local template store |
| `create` | name, fields | none | Atomic write to machine-local template store |
| `get` | templateSelector | none | Machine-local lookup |
| `delete` | templateSelector | none | Machine-local delete |
| `instantiate` | templateSelector, projectSelector | variables | Local substitution followed by direct task create |

### `vikunja_webhooks`
* **Description**: List webhook events or manage project-scoped and user-scoped webhooks.
* **Parameters**:
  * `action`: enum ["events", "list", "create", "update", "delete"] (required)
  * `scope`: enum ["project", "user"] (optional)
  * `projectSelector`: object (optional)
  * `webhookId`: number (optional); integer, min 0
  * `targetUrl`: string (optional)
  * `events`: array (optional)
  * `secret`: string (optional)
  * `basicAuthUser`: string (optional)
  * `basicAuthPassword`: string (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `events` | none | scope | Direct project or user event catalog |
| `list` | none | scope, projectSelector | Direct project or user webhook list |
| `create` | targetUrl, events | scope, projectSelector, secret, basicAuthUser, basicAuthPassword | Direct project or user webhook create; credentials are write-only |
| `update` | webhookId, events | scope, projectSelector | Direct project or user webhook event update. Vikunja treats target URL and credentials as immutable after creation. |
| `delete` | webhookId | scope, projectSelector | Direct project or user webhook delete |

## Attachment Examples

Upload local logs with `vikunja_tasks` action `attach`, a global or project-scoped `taskSelector`, and `filePaths`. Inline content uses `base64Content` plus `filename`. Download with action `download-attachment` and `attachmentId`; bytes stream to the configured temporary sandbox and the response contains only local path and metadata.

## Limits And Defaults

Task lists default to open tasks, compact response mode, page 1, and 20 items. Requests above 100 items per project page are safely capped to 100 with truthful pagination metadata. The 100-item ceiling keeps typical compact responses below 100 KB while avoiding the megabyte-scale responses produced by unbounded pages. Use `countOnly` for totals and request later pages for more items. Task get is compact by default; explicit `full` mode includes the latest 5 comments unless `commentLimit` changes that bounded value. Bulk update, create, and delete accept at most 100 tasks per call; composed create/delete are non-atomic, and delete requires `confirm: true`. Ordinary requests time out after 30 seconds; streamed and multipart transfers use a 60-second default. CSV imports and file downloads use `VIKUNJA_MAX_ATTACHMENT_BYTES` (default 100 MiB); Vikunja controls CSV row limits. Idempotency keys are process-local, expire after five minutes, and do not provide distributed locking.
