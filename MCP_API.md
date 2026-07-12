# Vikunja FastMCP V2 Tool Reference

This reference is generated automatically from runtime schemas.

Tools with multiple actions publish action-specific JSON Schema branches, so clients can present only the fields valid for the selected action.

All responses contain a short Markdown summary followed by exactly one fenced JSON envelope: `{ "ok": true, "data": ... }` or `{ "ok": false, "error": ... }`. HTTP error status, method, and path are preserved and secrets are redacted.

## Identity And Scope

Numeric task selectors are global database IDs. A portal reference such as `#305` or `PRJ-305` requires an explicit `projectSelector`. Task lists require exactly one explicit scope: `projectSelector`, `projects`, or `allProjects: true`. Writes echo task title, project title/id, portal index, identifier, and global ID.

Normalized task records include `creator: { id, username }` when Vikunja supplies `created_by`. Project exports always include creator identity; comments are included only when `includeComments: true` is requested.

## Tools

### `self_check`
* **Description**: Run diagnostic self-checks verifying configuration and connection status.
* **Parameters**:
  * None

### `vikunja_auth`
* **Description**: Check connection and get currently authenticated user details or connection status.
* **Parameters**:
  * `action`: enum ["status", "self-check"] (required)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `status` | none | none | Direct: GET /user |
| `self-check` | none | none | MCP-composed diagnostics |

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
  * `action`: enum ["create", "create_if_absent", "get", "list", "update", "delete", "close", "reopen", "close_with_evidence", "assign", "unassign", "list-assignees", "apply-label", "remove-label", "list-labels", "relate", "unrelate", "list-relations", "attach", "list-attachments", "download-attachment"] (required)
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
  * `q`: string (optional)
  * `countOnly`: boolean (optional)
  * `filter`: string (optional)
  * `fields`: object (optional)
  * `expectedUpdatedAt`: string (optional)
  * `evidenceComment`: string (optional); min 1
  * `userSelector`: string | number (optional)
  * `labelTitle`: string (optional); min 1
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

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `create` | projectSelector, fields.title | fields, idempotencyKey, attachments | Direct POST; MCP-composed when attachments are supplied |
| `create_if_absent` | projectSelector, fields.title | fields, idempotencyKey, attachments | MCP-composed exact-title search then optional create/attach. Best-effort duplicate prevention, not a distributed lock. |
| `get` | taskSelector | projectSelector (required for #index or PRJ-index), commentLimit (default 5, max 100) | MCP-composed task, recent comments, and attachment metadata |
| `list` | none | exactly one of projectSelector, projects, allProjects, page (default 1), perPage (default 25; requests above 100 are safely capped to 100), done, allStates, priority (0-5), label, q, filter, countOnly | Direct per project; grouped subsets/allProjects are MCP-composed. Defaults to done=false unless done or allStates is supplied. |
| `update` | taskSelector, fields | projectSelector (required for #index or PRJ-index), expectedUpdatedAt | Identity/read preflight, RFC 6902 PATCH, guarded writable-field PUT fallback |
| `delete` | taskSelector | projectSelector (required for #index or PRJ-index) | Identity preflight then DELETE /tasks/{id} |
| `close` | taskSelector | projectSelector (required for #index or PRJ-index) | Identity/read preflight then task update transport |
| `reopen` | taskSelector | projectSelector (required for #index or PRJ-index) | Identity/read preflight then task update transport |
| `close_with_evidence` | taskSelector, evidenceComment | projectSelector (required for #index or PRJ-index) | MCP-composed comment create followed by task close |
| `assign` | taskSelector, userSelector | projectSelector (required for #index or PRJ-index) | Identity preflight then POST assignee |
| `unassign` | taskSelector, userSelector | projectSelector (required for #index or PRJ-index) | Identity preflight then DELETE assignee |
| `list-assignees` | taskSelector | projectSelector (required for #index or PRJ-index) | Direct GET after identity resolution |
| `apply-label` | taskSelector, labelTitle | projectSelector (required for #index or PRJ-index) | Return unchanged when already attached; otherwise resolve/create then POST task label |
| `remove-label` | taskSelector, labelTitle | projectSelector (required for #index or PRJ-index) | Resolve label then DELETE task label |
| `list-labels` | taskSelector | projectSelector (required for #index or PRJ-index) | Direct GET after identity resolution |
| `relate` | taskSelector, otherTaskSelector, relationKind | projectSelector (required for #index or PRJ-index) | Resolve both tasks then POST relation |
| `unrelate` | taskSelector, otherTaskSelector, relationKind | projectSelector (required for #index or PRJ-index) | Resolve both tasks then DELETE relation |
| `list-relations` | taskSelector | projectSelector (required for #index or PRJ-index) | MCP-composed from task related_tasks data |
| `attach` | taskSelector, filePaths or base64Content+filename | projectSelector (required for #index or PRJ-index), mimeType | Multipart POST per file after identity resolution |
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

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `create` | taskSelector, comment | projectSelector (required for #index or PRJ-index), idempotencyKey | Direct POST after identity resolution |
| `list` | taskSelector | projectSelector (required for #index or PRJ-index) | Direct GET after identity resolution |
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
* **Description**: Update many tasks through the native v2 bulk route, or compose bounded create/delete batches.
* **Parameters**:
  * `action`: enum ["update", "create", "delete"] (required)
  * `taskIds`: array (optional)
  * `projectSelector`: object (optional)
  * `fields`: object (optional)
  * `tasks`: array (optional)
  * `confirm`: boolean (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `update` | taskIds, fields | none | Direct PUT /tasks/bulk |
| `create` | projectSelector, tasks | none | MCP-composed bounded task creates; non-atomic |
| `delete` | taskIds, confirm | none | MCP-composed verified task deletes; non-atomic |

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
* **Description**: Detect, preview, start, or inspect a native Vikunja v2 CSV import.
* **Parameters**:
  * `action`: enum ["detect", "preview", "import", "status"] (required)
  * `filePath`: string (optional); min 1
  * `config`: object (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `detect` | filePath | none | Direct multipart CSV detect |
| `preview` | filePath, config | none | Direct multipart CSV preview |
| `import` | filePath, config | none | Direct multipart CSV migration |
| `status` | none | none | Direct GET /migration/csv/status |

### `vikunja_export_project`
* **Description**: Export one project task list to a local JSON or CSV file.
* **Parameters**:
  * `projectSelector`: object (required)
  * `format`: enum ["json", "csv"] (optional)
  * `destinationPath`: string (optional)
  * `includeComments`: boolean (optional)

#### Operations

| Action | Required | Optional | Execution |
| --- | --- | --- | --- |
| `export` | projectSelector | format, destinationPath, includeComments | MCP-composed paginated export to sandboxed JSON or CSV. Creator is always included; comments are fetched only when includeComments is true. |

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

Task lists default to open tasks, page 1, and 25 items. Requests above 100 items per project page are safely capped to 100 with truthful pagination metadata. The 100-item ceiling keeps typical compact responses below 100 KB while avoiding the megabyte-scale responses produced by unbounded pages. Use `countOnly` for totals and request later pages for more items. Bulk update, create, and delete accept at most 100 tasks per call; composed create/delete are non-atomic, and delete requires `confirm: true`. CSV imports and file downloads use `VIKUNJA_MAX_ATTACHMENT_BYTES` (default 100 MiB); Vikunja controls CSV row limits. Consolidated get defaults to the latest 5 comments; `commentLimit` is limited to 100. Idempotency keys are process-local, expire after five minutes, and do not provide distributed locking.
