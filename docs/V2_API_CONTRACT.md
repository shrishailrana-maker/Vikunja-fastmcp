# Vikunja FastMCP V2 Contract

This is the source of truth for the clean Vikunja FastMCP rebuild. The new
server is a small adapter over Vikunja's generated v2 OpenAPI contract. It does
not reuse the old v1 SDK, compatibility layers, storage, retry framework, or
duplicate tool families.

Local API references for agents:

* [`vikunja-v2-openapi.json`](vikunja-v2-openapi.json): sanitized OpenAPI 3.1
  snapshot downloaded from the configured v2 service.
* [`VIKUNJA_V2_API_REFERENCE.md`](VIKUNJA_V2_API_REFERENCE.md): generated method,
  path, operation, and schema index.
* [`vikunja-v2-docs.html`](vikunja-v2-docs.html): saved v2 interactive-doc entry
  page.

The JSON snapshot is the local HTTP authority. Re-download and review it when
the Vikunja service is upgraded; never substitute the old SDK or v1 docs.

## Design Rules

1. Support Vikunja `/api/v2` only. Reject `/api/v1` configuration clearly.
2. Keep runtime source flat and minimal: merge trivial pass-through files, but
   split a file when it contains distinct responsibilities or becomes hard to
   review and test.
3. Use Node 20 `fetch` directly. Do not add an API SDK or framework around it.
4. Register one canonical task tool: `vikunja_tasks`.
5. Require an explicit project title or ID on every project-scoped call.
6. Use server-side filtering, sorting, and pagination. Never fetch every task
   and filter it in the MCP.
7. Return a short Markdown summary followed by one normalized JSON block.
8. Preserve real HTTP status and safe server details. Never turn an identity,
   route, or permission error into an "invalid token" or JWT message.
9. Resolve task identity once before any child operation or write.
10. Never expose a token in output, logs, URLs, tests, or repository files.

## Connection

`VIKUNJA_URL` accepts the server root or its v2 API URL:

```text
https://vikunja.example.com
https://vikunja.example.com/api/v2
```

The MCP verifies `GET /api/v2/info` at startup and uses
`VIKUNJA_API_TOKEN` as a bearer token. `VIKUNJA_WEB_URL` is optional and is
used only to build browser links. A token-free `self-check` reports the MCP
version, build path, normalized API URL, authentication state, and supported
operations.

`GET /api/v2/openapi.json` is live-probed. It serves the OpenAPI document but
need not list itself inside that document's `paths` object, so absence from its
own path map is not treated as a missing capability.

## Verified V2 Route Matrix

All paths below are relative to `/api/v2`. Creates use `POST`; partial updates
prefer `PATCH`. Task updates use RFC 6902 JSON Patch and other partial resource
updates use JSON Merge Patch. Vikunja v2.3 may reject its own read-only
`subscription` object after an assignee is added; only for that exact 422
validation signature, the MCP retries with a full `PUT` containing the current
writable task fields plus the requested changes. Other validation failures are
returned unchanged. `PUT` is otherwise reserved for a documented full
replacement or bulk replacement body.

| Capability | Method and path | Contract |
| --- | --- | --- |
| Server gate | `GET /info`, live `GET /openapi.json` | Direct |
| Current/search users | `GET /user`, `GET /users` | Direct |
| Projects | `GET /projects`, `GET /projects/{id}` | Direct |
| Task list | `GET /projects/{project}/tasks`, `GET /tasks` | Direct |
| Task get/create | `GET /tasks/{projecttask}`, `POST /projects/{project}/tasks` | Direct |
| Task update/delete | `PATCH` or full `PUT`, `DELETE /tasks/{projecttask}` | Direct |
| Assignees | `GET`, `POST`, bulk `PUT`, and member `DELETE` below `/tasks/{projecttask}/assignees` | Direct |
| Task labels | `GET`, `POST`, bulk `PUT`, and label `DELETE` below `/tasks/{projecttask}/labels` | Direct |
| Labels | `GET`/`POST /labels`; item `GET`/`PATCH`/`PUT`/`DELETE` | Direct |
| Comments | `GET`/`POST /tasks/{task}/comments`; item `GET`/`PATCH`/`PUT`/`DELETE` | Direct |
| Attachments | `GET`/multipart `POST /tasks/{task}/attachments`; item `GET`/`DELETE` | Direct |
| Relations | `POST /tasks/{task}/relations`; relation `DELETE` | Direct writes |
| Relation listing | No collection `GET` | MCP-composed from task data |
| Teams | Team, member, and member-admin routes below `/teams` | Direct; exact nested verbs come from OpenAPI |
| Saved filters | `POST /filters`; item `GET`/`PATCH`/`PUT`/`DELETE` | Direct |
| Saved-filter listing | No `GET /filters` collection | Not exposed |
| Bulk task update | `PUT /tasks/bulk` | Direct |
| Bulk task create/delete | Existing task create/delete routes | MCP-composed, bounded, non-atomic |
| Task reminders | Embedded `reminders` task field | MCP-composed read/update |
| CSV import | `/migration/csv/detect`, `/preview`, `/migrate`, `/status` | Direct multipart/status routes |
| Project export | Paginated project task list | MCP-composed local JSON/CSV file |
| User export | `/user/export`, `/request`, `/download` | Direct; download streams to disk |
| Webhooks | Project/user webhook routes and `/webhooks/events` | Direct |
| Templates | No Vikunja v2 template route | Machine-local JSON store |

OpenAPI parameter names vary by route family. `{projecttask}` and `{task}` both
receive the resolved global numeric task ID; they are not different identity
types. Project-scoped list/create uses `{project}` and entity routes such as
projects and labels use `{id}`.

Before implementation, the capability gate records the exact request-body
schema, enum values, nested team-member verbs, multipart field names, and
expected success status class from the configured server's OpenAPI. No caller
guesses fields such as assignee ID, label ID, or relation kind. A missing or
ambiguous required schema blocks that operation and is named by `self-check`.

The exact-title server filter required by `create_if_absent` must also be
proven during this gate. If the configured v2 server cannot express it,
`create_if_absent` is reported unsupported; the MCP does not replace it with a
multi-page client-side task scan.

Agents inspect the saved OpenAPI and generated reference before adding an HTTP
call. The live capability gate still revalidates them because the installed
server may be newer than the committed snapshot.

## Minimal Tool Surface

| Tool | Operations |
| --- | --- |
| `vikunja_auth` | `status`, `self-check` |
| `vikunja_projects` | `list`, `get` |
| `vikunja_tasks` | `create`, `create_if_absent`, `get`, `list`, `update`, `delete`, `close`, `reopen`, `close_with_evidence`, `assign`, `unassign`, `list-assignees`, `apply-label`, `remove-label`, `list-labels`, `relate`, `unrelate`, `list-relations`, `attach`, `list-attachments`, `download-attachment` |
| `vikunja_task_comments` | `create`, `list`, `get`, `update`, `delete` |
| `vikunja_labels` | `list`, `get`, `create`, `update`, `delete` |
| `vikunja_users` | `current`, `search` |
| `vikunja_teams` | `list`, `get`, `create`, `update`, `delete`, `add-member`, `remove-member`, `set-member-admin` |
| `vikunja_filters` | `create`, `get`, `update`, `delete` |
| `vikunja_task_bulk` | `update`, `create`, `delete` |
| `vikunja_task_reminders` | `list`, `add`, `remove` |
| `vikunja_batch_import` | `detect`, `preview`, `import`, `status` |
| `vikunja_export_project` | one project export to JSON or CSV |
| `vikunja_request_user_export` | request native user export |
| `vikunja_download_user_export` | `status`, `download` |
| `vikunja_templates` | `create`, `list`, `get`, `delete`, `instantiate` |
| `vikunja_webhooks` | `events`, `list`, `create`, `update`, `delete` |

The surface keeps teams, saved filters, and duplicate/blocking relations
because the owner explicitly requested them. Project mutation and direct
project-member administration are omitted from the first rebuild; access can
be managed in Vikunja or through teams. There is no `vikunja_task_crud` or
other task wrapper.

### Operational Limits

The limits are part of the public MCP contract rather than hidden truncation:

* task pages default to 25 and are capped at 100 items per project page;
* bulk update/close accepts at most 100 global task IDs;
* composed bulk create accepts at most 100 tasks and is non-atomic;
* composed bulk delete accepts at most 100 global task IDs, is non-atomic, and
  requires `confirm: true`;
* CSV import and file upload/download use `VIKUNJA_MAX_ATTACHMENT_BYTES`, 100
  MiB by default; Vikunja controls CSV row-count limits.

Paging exists because compact data can still overwhelm an agent when hundreds
of items are serialized. A live 955-task DMS response was about 1 MB before
bounding. Compact JSON plus bounded pages keeps normal calls small while
`total`, `hasMore`, and `nextPage` preserve complete traversal. Callers use
`countOnly: true` when they need only a total.

## Published MCP API

The MCP API must be visible and versioned. It has one source of truth: the
registered tool definitions, consisting of Zod input schemas plus co-located
per-operation requirements and execution metadata. Those definitions are exposed at
runtime through the standard MCP `tools/list` operation and generate a
packaged `MCP_API.md` during the build.

`MCP_API.md` documents, for every public tool:

* tool name and purpose;
* every operation/subcommand;
* required and optional inputs, defaults, and limits;
* project-scope and task-identity rules;
* normalized success and error examples;
* attachment upload/download examples;
* whether an operation performs one HTTP call or an MCP-composed workflow.

The generated document is committed and shipped in the npm package so it is
available on GitHub and after installation. CI regenerates it and fails when
the committed copy differs, preventing tool schemas and documentation from
drifting apart.

`self-check` returns `apiContractVersion`, the package version, build path,
normalized API URL, authentication state, supported tool names, supported
subcommands, the local path to the packaged API document, the attachment
download root, and a compact list of visible projects as `{ id, title,
archived }`. It never returns a token or Authorization header. The project
list lets any new chat window orient itself with one call; it is information,
not an inferred scope for later calls.

## Project Scope

One MCP installation supports every project visible to its token and may be
used concurrently by chat windows working on different projects. Project scope
is never shared or inferred across windows. Every task list, search, create,
and portal-reference call requires an explicit project on that call:

```text
project: { "id": 101 }
project: { "title": "Alpha" }
projects: [ { "id": 101 }, { "title": "Beta" }, { "id": 104 } ]
allProjects: true
```

The numeric project ID is used directly. A title is resolved by a
case-insensitive exact match against visible projects. An unknown title returns
`PROJECT_NOT_FOUND`; more than one exact match returns
`PROJECT_TITLE_AMBIGUOUS` with safe `{ id, title }` candidates. The MCP never
guesses or falls back to a partial title match.

A project's optional short identifier may be empty, so project title and
numeric project ID are the supported project handles. A short code is not
required and is not treated as a unique project selector.

Omitting `project` is an error. It never triggers an all-project scan.
For read, list, and search only, `projects: [...]` resolves each entry with the
same exact title/ID rules and queries exactly that subset in one MCP call. This
avoids both separate agent calls and `allProjects` over-fetching projects the
caller did not request. Results are grouped by project with independent
pagination. `allProjects: true` is the other deliberate cross-project path and
is also read-only; it uses the same grouped response shape.

`projects: [...]` cannot be used for create, update, delete, or a project-local
`#index` reference. Task creation and project-local references always require
one `project`. A write using a global task ID may omit project because the
global ID is unique, but the MCP still reads and echoes the resolved project
before reporting success. When the caller supplies project, a mismatch fails
before mutation. Comments, labels, assignments, relations, and attachments
inherit scope from the resolved task. They do not invent separate identity
rules.

Agents should record the project title and numeric ID in each project's
`AGENTS.md` and pass one of them on every project-scoped tracker call. A
workspace spanning several products may record a project-name-to-ID map, but
each chat window still chooses its intended project explicitly for each call.

`vikunja_projects list` returns compact `{ id, title, archived }` items for the
same orientation workflow used by `self-check`.

Project-title and label-title resolution use a small process-lifetime cache
with a short TTL as defined in the rebuild plan. Task content, task lists,
search results, and authentication state are never cached.

Project-title resolution, grouped `projects: [...]` and `allProjects` reads,
`self-check`, `create_if_absent`, `close_with_evidence`, consolidated task get,
create-with-attachments, and `list-relations` are labeled MCP-composed
behavior. The remaining public operations map directly to generated v2 routes
verified by the startup and release capability gates. Markdown conversion is
a local representation boundary, not a Vikunja endpoint.

## Task Identity And Write Safety

Vikunja has two useful task identities:

* `id`: globally unique database ID used by API writes and `/tasks/{id}` URLs.
* `index` / `identifier`: project-local portal reference shown in the web UI.
  A project with an empty short identifier displays only `#305`, and that same
  portal number can exist in every project.

The MCP always displays both:

```text
Investigate sync issue (#305 · id 9005)
```

It accepts a numeric global ID without project scope because that ID is unique
across the server. It accepts `#305` only with an explicit project title or ID
and resolves it to the global ID before any read-modify-write. A full
identifier, when the project has one, must agree with the resolved project.
Legacy `#NNN` text inside a title is never parsed or changed.

Before a write, the MCP resolves and reads the target once. Every write result
echoes the action and target identity:

```json
{
  "action": "closed",
  "target": {
    "id": 9005,
    "index": 305,
    "identifier": "PRJ-305",
    "project": { "id": 101, "title": "Alpha" },
    "title": "Investigate sync issue"
  }
}
```

Every write echo names the project and task and includes global ID, portal
index, and full identifier when available. Missing, ambiguous, or mismatched
targets fail before mutation. `create`,
comment creation, and attachment upload accept an optional process-local
`idempotencyKey`. `update` may accept `expectedUpdatedAt`; because v2 does not
advertise an atomic conditional PATCH, this is documented as a best-effort
pre-write conflict check, not a server-side lock.
On a detected mismatch it returns `409 CONFLICT`. Success and error wording
must never imply that Vikunja held a lock or prevented a concurrent server-side
write after the comparison.

## Agent-Ready Responses

Every response is text with exactly two parts:

1. A short Markdown summary or compact table.
2. One fenced `json` block containing the machine contract.

Success:

```json
{ "ok": true, "data": {} }
```

Failure:

```json
{
  "ok": false,
  "error": {
    "status": 403,
    "code": "PERMISSION_DENIED",
    "method": "POST",
    "path": "/tasks/9005/assignees",
    "message": "Access is forbidden",
    "fieldErrors": []
  }
}
```

Errors retain their real meaning:

* `401`: token or API URL problem.
* `403`: permission or project-access problem.
* `404`: missing task, unresolved portal reference, or missing route.
* `409`: requested write conflicts with the observed task state.

Token-like values and authorization headers are redacted before formatting or
logging.

## Normalized Tasks And Comments

Single-task responses normalize to:

```json
{
  "id": 9005,
  "index": 305,
  "identifier": "PRJ-305",
  "project": { "id": 101, "title": "Alpha" },
  "title": "Investigate sync issue",
  "description": "Evidence: verified",
  "done": false,
  "priority": 3,
  "dueDate": null,
  "labels": [{ "id": 9, "title": "bug" }],
  "assignees": [{ "id": 7, "username": "agent-user" }],
  "taskUrl": "https://vikunja.example.com/tasks/9005",
  "projectUrl": "https://vikunja.example.com/projects/101"
}
```

Every normalized task carries `project: { id, title }`, so cross-project
results and write echoes identify their project without another lookup.

Markdown is the MCP boundary for task descriptions and comments:

* On read, Vikunja's stored HTML is converted to Markdown. Headings,
  bold/italic text, links, inline code, code blocks, and ordered/unordered lists
  are preserved, and HTML entities are decoded.
* On write, agents send Markdown. The MCP converts it to the safe HTML subset
  expected by Vikunja before create, update, or comment operations. Agents do
  not send or receive HTML.
* Conversion covers `p`, `strong`, `em`, `ul`, `ol`, `li`, `a`, `code`, `pre`,
  `br`, and `h1` through `h3`. Exotic human-authored HTML is converted
  best-effort on read while the original stored HTML remains untouched.

Markdown writes use a hard allowlist. Text and attributes are escaped, unsafe
URL schemes and raw HTML are rejected, and unsupported constructs fail closed
rather than emitting HTML the converter does not understand. Read conversion
ignores tags outside the allowlist and may degrade exotic HTML to safe
approximate Markdown because the upstream HTML is never rewritten.

The converter begins in `format.ts`; it moves to a focused `markdown.ts` when
that responsibility becomes independently substantial. This is a justified
cohesion split, not a return to nested architecture. No runtime dependency is
added. Empty dates and Vikunja's `0001-01-01T00:00:00Z` sentinel become `null`.

A single `vikunja_tasks get` returns a consolidated detail bundle:

* the normalized task, including its assignees and labels from task fields or
  supported v2 `expand` values;
* attachment metadata, using a supported task expansion when available or the
  real attachment-list route otherwise;
* the latest five normalized comments by default, fetched from the separate
  v2 comments route.

Comment and attachment folding are MCP-composed when they require separate v2
calls. `commentLimit: 0` omits comments; a higher bounded value is explicit.
The comments tool remains the path for older pages or complete comment history.
This lets an agent answer task state, ownership, labels, reviewed evidence, and
available logs with one MCP call without claiming that Vikunja provides one
combined HTTP route.

Lists omit descriptions by default and return compact identity, title, state,
priority, and label data. Pagination is normalized to `page`, `perPage`,
`total`, `totalPages`, `hasMore`, and `nextPage`. There is no hidden ten-item
truncation and no raw `$schema` or `per_page` wrapper. To prevent oversized
agent responses, each project page is explicitly capped at 100 items and the
returned pagination metadata reports that effective page size.

## List Semantics

Single-project reads map to `GET /projects/{project}/tasks`. Explicit subsets
perform one such server-filtered request per named project inside one MCP call.
Deliberate all-project reads may use `GET /tasks` where its behavior matches the
generated v2 contract. All paths pass supported `filter`, `sort_by`, `order_by`,
`q`, `page`, `per_page`, and `expand` parameters to Vikunja rather than
reimplementing them locally.

* Open tasks are the default; `done` can be supplied explicitly.
* `priority: 0` means unset priority. Other priorities are exact matches.
* Project, done, priority, labels, title search, and an explicit filter compose
  with AND semantics.
* `title` search is the default. `exactTitle`, `fullText`, and portal-reference
  modes are explicit so a word buried in a description does not become an
  accidental match.
* `page` and `perPage` are applied once by Vikunja. Default `perPage` is 25;
  requests above 100 are capped to 100 without hiding the remaining total.
* Every list states displayed count, total, and exact continuation metadata.
* Explicit `projects: [...]` and deliberate `allProjects: true` results are
  grouped by project and expose independent `pagination` blocks. Continuation
  requests name the project and next page.
* `countOnly: true` returns the v2 collection `total` and omits task items. A
  single-project response contains one total; subset and all-project responses
  contain one total per project. The MCP may request the smallest valid page
  needed to obtain `total`, but it does not infer a count by scanning tasks.

Count-only success example:

```json
{
  "ok": true,
  "data": {
    "project": { "id": 101, "title": "Alpha" },
    "count": 12
  }
}
```

## Safe Compound Operations

`create_if_absent` performs an exact-title search in one project and creates
only when no match exists.

This is best-effort duplicate prevention, not a distributed uniqueness lock.
Two concurrent MCP processes or windows can both search before either creates,
so Vikunja may still receive two tasks. A process-local `idempotencyKey`
protects retries handled by that process; it does not provide cross-process
locking.

`close_with_evidence` resolves and verifies the task, creates the audit or
verification comment, then closes it. The result reports both steps. A comment
failure prevents the close.

These are MCP workflows, not new Vikunja endpoints.

## Attachments

Testers can attach logs, screenshots, and test evidence when posting or
updating a bug:

* `create` and `create_if_absent` accept an optional `attachments` array of
  local file paths. The MCP creates the task, uploads each file, reads the
  attachment metadata back, and returns the task plus per-file results in one
  tool response. A partial upload is reported honestly and never causes a
  retry to create a second task.
* `attach` adds one or more files to an existing task from local `filePath`
  values, or from base64 plus explicit filenames, and returns attachment
  metadata.
* `list-attachments` returns attachment IDs, names, sizes, and URLs without
  file bytes.
* `download-attachment` downloads through the authenticated MCP connection to
  an explicit local `destinationPath` or, when omitted, a safe directory under
  the operating-system temporary folder. It returns the local path, filename,
  media type, size, checksum, and source metadata.

The default local path is deterministic:

```text
Windows: %TEMP%\vikunja-fastmcp\attachments\<task-id>\<attachment-id>\<filename>
Other:   <os.tmpdir>/vikunja-fastmcp/attachments/<task-id>/<attachment-id>/<filename>
```

This is local to the user account running the MCP process. Temporary downloads
are not repository files and are never committed. They remain available for
the agent session but may be removed later by the operating system. An operator
that needs durable storage sets `VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT`; every
explicit `destinationPath` remains sandboxed inside that configured root.

The MCP may print a clean `attachmentUrl`, but it never puts a token in that
URL. A private Vikunja API URL normally requires an Authorization header, so a
plain link is not guaranteed to download in every browser or agent. Automatic
agent download therefore uses `download-attachment`; the calling agent then
opens and parses the returned local file with its normal text, image, archive,
or document tools. Agents that can attach a bearer header may use
`attachmentUrl` directly. A browser-friendly task link is also returned so a
signed-in human can open the attachment in Vikunja.

Binary data and base64 are never placed in the MCP response. Downloads are
streamed to disk, bounded by a configured size limit, use a safe basename, and
refuse to overwrite an existing file unless explicitly allowed. Upload is
followed by metadata readback so the tester and developer can verify the file
belongs to the intended task.

### Tester-To-Developer Log Workflow

```text
tester calls create/create_if_absent with title, evidence, and attachments[]
MCP creates or finds the scoped task
MCP uploads logs/screenshots and verifies attachment metadata
developer agent lists or gets the task and sees attachment metadata
developer agent calls download-attachment
MCP authenticates, streams the file to a safe local temporary path, and
returns localPath plus metadata
developer agent reads and parses localPath using its normal file tools
```

No human has to copy a token, manually download the log, or paste its contents
into chat. The MCP transports the file; the agent's established file tooling
parses it. This keeps attachment code small and avoids building log, image,
archive, PDF, or document parsers into the tracker MCP.

MCP operational logs are separate from task attachments. By default they are
concise structured messages on `stderr` for the parent MCP client to capture;
the server does not create an unexplained local log file. If file logging is
added later, it must require an explicit configured path documented by
`self-check`.

## Required Workflows

The first rebuild must support these incidents end to end:

1. Post a bug without creating a duplicate.
2. Upload logs or screenshots in the same bug-creation call and verify each
   attachment's metadata.
3. Download attached logs automatically without sending binary through the
   model context.
4. List open or highest-priority bugs in one explicit project, or deliberately
   across all projects with grouped results.
5. Find a forgotten task by exact title, portal ID, or deliberate full text.
6. Read task state and recent comments to see whether logs were reviewed.
7. Add verification evidence and close the verified task safely.
8. Assign or unassign a user without replacing unrelated assignees.
9. Mark duplicate or blocking relationships between tasks.
10. Maintain the retained team and saved-filter workflows.

## Security And Release Invariants

Mandatory tests cover credential redaction, structural validation, identity
resolution, write target echo, project scope, real HTTP error preservation,
compact output, pagination, zero dates, HTML/entity conversion, attachment
path safety, upload limits, and download limits.

The rebuild does not include time entries, project views, buckets, a local
task database, generic retries, circuit breakers, client-side filtering, or a
v1 compatibility layer. Compatibility tools for reminders, webhooks, exports,
CSV import, templates, and bulk task work stay thin: direct v2 routes where
available and explicitly documented MCP composition otherwise.

Machine-local templates live at `~/.vikunja-fastmcp/templates.json` by default
or at `VIKUNJA_TEMPLATE_FILE`. Atomic file replacement prevents partial writes,
but the store is not a distributed lock across processes. Project and user
exports download under the same sandbox used by attachments. Passwords,
webhook secrets, and basic-auth credentials are write-only inputs and never
appear in responses.

User-data export authentication is server-specific. A configured Vikunja
server may accept API tokens as advertised by OpenAPI or may require a JWT and
local-password confirmation. The MCP does not rewrite that response: a server
`401` remains a structured `401`. Label application similarly follows the
caller's project and label permissions independently of ordinary task-update
permission.
