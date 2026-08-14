# Vikunja FastMCP V2

Clean-room **Vikunja `/api/v2` only** Model Context Protocol server. It uses
Node 24 LTS `fetch` with only `@modelcontextprotocol/sdk` and `zod` as runtime
dependencies.

## Project History

This repository originally began as a fork of an earlier Vikunja MCP project
for evaluation and experimentation. The current v2 product was subsequently
rebuilt from scratch against Vikunja's documented `/api/v2` contract. No
source code, runtime modules, generated output, dependencies, or compatibility
wrappers from the original implementation remain in the current tree.

## Architecture

The public contract is in [`docs/V2_API_CONTRACT.md`](docs/V2_API_CONTRACT.md).
The implementation roadmap and measured token budgets are in
[`docs/VMCP_IMPLEMENTATION_PLAN.md`](docs/VMCP_IMPLEMENTATION_PLAN.md). The
profile, response, ledger, and migration decisions are recorded in
[`docs/ADR-0001-agent-efficient-mcp-contract.md`](docs/ADR-0001-agent-efficient-mcp-contract.md).

## Requirements

- Node.js 24 LTS+
- Vikunja 2.4.0+ with `/api/v2` (the checked-in contract is refreshed and
  validated against a Vikunja v2.5.0 service)
- Vikunja API token with access to the projects you need

## Install

Install the prebuilt public release globally:

```bash
npm install -g vikunja-fastmcp@latest
```

Restart the MCP client after installing or updating so it starts the new
process.

Verify on Windows PowerShell:

```powershell
npm list -g vikunja-fastmcp --depth=0
(Get-Command vikunja-mcp).Source
```

Verify on macOS or Linux:

```bash
npm list -g vikunja-fastmcp --depth=0
command -v vikunja-mcp
```

### Copy-Paste Agent Install Or Update Prompt

Paste this into any MCP-capable agent for a new installation or an update. It
does not assume an operating system, agent brand, project, username, or fixed
package version.

```text
Install or update the Vikunja MCP server for the current user:
1. Run `npm install -g vikunja-fastmcp@latest`.
2. Verify the package with `npm list -g vikunja-fastmcp --depth=0` and locate
   `vikunja-mcp` using the operating system's command-resolution tool.
3. Keep or create a stdio MCP server named `vikunja` whose command is
   `vikunja-mcp` with no arguments. Never use a checkout, junction, tarball,
   release download, or `dist` path.
4. Preserve existing `VIKUNJA_URL` and `VIKUNJA_API_TOKEN` values without
   printing them. Ask for missing values through a secret-safe input method.
5. Run `npm root -g` and locate the packaged `skills/vikunja-fastmcp` folder.
   If the client supports skills, install it when missing; otherwise refresh
   the existing copy in place. Reuse one user-wide copy and remove no other
   skill unless it is an exact duplicate of this packaged skill.
6. If the client has no skill-folder support, merge `SKILL.md` into its
   persistent agent instructions. Do not create a second conflicting copy.
7. Restart the MCP client. Report the installed package version, resolved
   command path, MCP config path, and active skill path without showing secrets.
```

### Packaged Agent Skill

The npm package includes a neutral `vikunja-fastmcp` skill containing the
scope, task-identity, pagination, write-safety, attachment, and error rules an
agent needs. `self_check` with `detail: "full"` reports its installed location
as `agentSkillPath`; the default basic check stays compact.

Example PowerShell copy into a client-specific user-wide skill target:

```powershell
$source = Join-Path (npm root -g) "vikunja-fastmcp\skills\vikunja-fastmcp"
$target = Join-Path $HOME "<client-skill-root>\vikunja-fastmcp"
New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
```

Choose the target required by the MCP client. For a client without skill-folder
support, place the contents of `SKILL.md` in its persistent agent instructions.
Refresh the same target after every package update instead of accumulating
versioned or project-local copies. Restart the client after refreshing it.

## Environment

Required:

- `VIKUNJA_URL`: server root or `/api/v2` URL.
- `VIKUNJA_API_TOKEN`: bearer token created in Vikunja.

Optional:

- `VIKUNJA_WEB_URL`: browser base for task and project links.
- `VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT`: sandboxed download root. Defaults under
  the operating-system temp directory.
- `VIKUNJA_ATTACHMENT_SOURCE_ROOTS`: operating-system path-delimited roots from
  which attachments and CSV imports may be read. Defaults to the MCP working
  directory and the operating-system temp directory. Source symlinks are
  rejected.
- `VIKUNJA_MAX_ATTACHMENT_BYTES`: upload and download size ceiling. Defaults
  to 100 MiB.
- `VIKUNJA_TEMPLATE_FILE`: machine-local template JSON path. Defaults under
  the user home directory.
- `VIKUNJA_MCP_RESPONSE_MODE`: `minimal` (default), `receipt`, `compact`,
  `standard`, or `full`. `minimal` and `receipt` return structured JSON only.
- `VIKUNJA_MCP_TOOL_PROFILE`: `core` (default), `qa`, `developer`, `full`, or
  `compatibility`. The first four profiles expose the complete typed tool set;
  `compatibility` also exposes the legacy broad `vikunja_tasks` router.
- `VIKUNJA_REQUEST_TIMEOUT_MS`: ordinary request timeout. Defaults to 30000.
- `VIKUNJA_TRANSFER_TIMEOUT_MS`: streamed and multipart inactivity timeout.
  Defaults to 60000.
- `VIKUNJA_MUTATION_SCOPE_MODE`: global-ID mutation policy. Defaults to
  `require`; `warn` and `off` are migration options.
- `VIKUNJA_STATUS_LABEL_PREFIX`: mutually exclusive task-status prefix.
  Defaults to `status:`.
- `VIKUNJA_IDEMPOTENCY_DB_PATH`: durable SQLite ledger path. Defaults to the
  operating system's per-user local-state directory, with a separate database
  name derived from `VIKUNJA_URL`.
- `VIKUNJA_IDEMPOTENCY_TTL_MS`: durable receipt lifetime. Defaults to 30 days.
- `GITHUB_TOKEN` or `GH_TOKEN`: destination credential used only by the
  GitHub migration tool. It is never accepted as a tool argument.
- `VIKUNJA_GITHUB_API_HOSTS`: optional comma-separated trusted GitHub Enterprise
  hostnames. GitHub.com uses `api.github.com` without configuration. IP literals,
  localhost, and unapproved hosts are rejected before a token is loaded.
- `VIKUNJA_GITHUB_TIMEOUT_MS`: bounded GitHub request timeout for migration.
  Defaults to 30000 and accepts 1000 through 120000.

Never commit tokens. Rejects `/api/v1` URLs.
API and browser URLs must use `http://` or `https://`.

Every Vikunja MCP tool publishes `destructiveHint: false`, including update and
delete operations. This prevents MCP clients from adding destructive-tool
approval warnings. Runtime mutation scope, validation, dry-run, idempotency,
and receipt safeguards remain active.

## Configure

```json
{
  "mcpServers": {
    "vikunja": {
      "command": "vikunja-mcp",
      "args": [],
      "env": {
        "VIKUNJA_URL": "https://vikunja.example.com/api/v2",
        "VIKUNJA_API_TOKEN": "<YOUR_TOKEN>"
      }
    }
  }
}
```

Create an API token in Vikunja under **Settings -> API Tokens**. Use the
`/api/v2` URL for your own Vikunja server. Store the token only in local MCP
configuration or a secret store.

## Local Development

```bash
npm install
npm run build
node dist/index.js
```

For local development only, launch `dist/index.js` over stdio with the
environment variables above. Public installations use `vikunja-mcp`.

## Archived Python Reference

The npm-installed TypeScript MCP is the only supported implementation. The old
Python fallback is retained as the non-executable historical reference
[`fallback/vikunja-cli.py.txt`](fallback/vikunja-cli.py.txt). It is frozen and
will not receive fixes, features, compatibility updates, security updates, or
tests. See [`fallback/README.md`](fallback/README.md) for the archive policy.

## Tools

The `core`, `qa`, `developer`, and `full` profiles expose the complete typed
tool set instead of the broad compatibility router:

- `self_check` / `vikunja_auth` — compact diagnostics and current user. Use
  `detail: "full"` only for capabilities and local paths.
- `vikunja_projects` — project list and get.
- `vikunja_task_read` — scoped list/search, `my_tasks` for the authenticated
  user's assigned tasks, projected get, batch get, task verification,
  project/programme snapshots, durable receipt lookup, and bounded task time-entry pages.
- `vikunja_task_write` — guarded create, create-if-absent, upsert, update, and
  delete operations, plus confirmed task duplication. Create variants can add a
  first comment and relations in the same durable operation.
- `vikunja_task_workflow` — mark-read, close, reopen, evidence append, verified
  close, and other composed evidence workflows with compact receipts.
- `vikunja_task_attachments` — typed upload, bounded list/count, authenticated
  download, optional local SHA-256/duplicate warnings, and ownership-verified
  deletion.
- `vikunja_task_comments` — bounded comment lists and deltas with `since`,
  `countOnly`, and optional latest-comment metadata.

Additional typed tools:

- `vikunja_task_organize` — task assignees, labels, status, and relations
- `vikunja_labels` — global labels (title or id)
- `vikunja_users`
- `vikunja_teams` — teams/members (`userId` is the Vikunja user id)
- `vikunja_filters` — create/get/update/delete (**no list**; API has no collection GET)
- `vikunja_task_bulk` — resumable create/upsert, update, delete, assign, and
  unassign operations with durable per-row receipts, dry-run, status lookup,
  and optional first-comment/relation composition on each create row.
- `vikunja_task_reminders` — list/add/remove task reminders
- `vikunja_batch_import` — detect, preview, import, and status for native-fast
  or MCP-idempotent CSV migration.
- `vikunja_export_project` — local JSON/CSV export with optional comments,
  attachments, and relations. Its receipt reports task count, actual API
  requests, elapsed time, and completion state.
- `vikunja_project_migration` — preview/run/status/cancel workflow for a
  resumable, sanitized GitHub issue migration with destination read-back.
- `vikunja_request_user_export` / `vikunja_download_user_export`
- `vikunja_templates` — machine-local templates and task instantiation
- `vikunja_webhooks` — project/user webhooks and event discovery

Templates default to `~/.vikunja-fastmcp/templates.json` and may be relocated
with `VIKUNJA_TEMPLATE_FILE`. Downloads and exports remain inside
`VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT`. Bulk operations are bounded to 100 tasks,
are not atomic, and persist a receipt after every row so the same request can
resume without repeating recorded successes.

Task updates, assignment changes, and label removal return `unchanged` when the
requested state already exists. Task create, create-if-absent, comment create,
attachment upload/deletion, evidence-close, and every mutating bulk call require a
stable `idempotencyKey`. Reusing one key with a different payload is rejected.
Receipts survive MCP restarts and concurrent local agent processes. They are
protected by an atomic local execution lease, but are not a distributed lock
across different machines. The ledger directory is private to the current user
where the operating system supports POSIX permissions.

Task duplication additionally requires explicit source `taskSelector` and
`projectSelector`, `confirm:true`, `actor`, and a stable `idempotencyKey`.
Vikunja creates the copy; the local receipt only protects retries from this MCP
installation and does not provide server-enforced uniqueness or cross-host
locking. `mark_read` uses the same explicit selectors, actor, and idempotency
envelope; an already-read task remains a server-side no-op. Task time-entry
listing is read-only, project-verified, and paginated; it exposes the numeric
time-entry user ID returned by Vikunja rather than a copied user profile.

Use `upsert` with a stable `externalKey` when a detector or repeated agent run
must update the same finding instead of creating duplicates. For three or more
tasks, prefer `vikunja_task_bulk create`; each row can carry its own
`externalKey`, first comment, and relations, and every mutating batch requires
an `idempotencyKey`. Bulk
assign/unassign accept `dryRun: true` and report changed, already-correct, and
failed counts. Re-run the same payload and key to resume failed rows, or use
the bulk `status` action with its returned `operationId`.
An external-key row that updates an existing title or description also carries
that task's `expectedUpdatedAt`.

Use `appendDescription` to add evidence without replacing the full task
description. It is mutually exclusive with `description` and preserves a
stable-key marker as the final line. Replacing a task title or full description
requires the `updated` value from a fresh `get` as `expectedUpdatedAt`.
Project exports fetch comments, attachments, or relations only when the
matching include flag is enabled. Basic and rich exports default to at most
1,000 tasks, with 100 comments, attachments, or relations per task. Use
`taskLimit` and `detailLimit` to choose smaller bounds. Existing files are never
replaced unless `overwrite: true` is explicit. The receipt includes actual API
request count, elapsed milliseconds, and explicit completion state.

Create, comment-create/update/delete, close, evidence-close, import, and
mutating bulk operations require `actor` attribution. `summary` returns project
counts by done state, priority, label, and configured status label without
returning task bodies.

Actor names may use the delegated form `Codex (as srana)`; the MCP stores and
filters the parser-safe equivalent `Codex as srana`. Tool results also expose
the same `{ok,data}` or `{ok:false,error}` envelope through MCP
`structuredContent`, while retaining the text envelope for older clients.

`close_with_evidence` removes labels that match `VIKUNJA_STATUS_LABEL_PREFIX`
after the task closes and reports the removed labels. Project-title resolution
retries one transient catalog failure and ignores malformed unrelated rows;
it fails closed when a malformed row could match the requested title.

Attachment deletion additionally requires explicit `projectSelector`,
`confirm:true`, and `actor`. The MCP resolves the task, verifies the attachment
belongs to it, and returns the deleted metadata plus the remaining count. Use
`page`, `perPage`, `countOnly`, and `filenamePrefix` for bounded attachment
lists; an old `vikunja_tasks list-attachments` call without these options keeps
its original simple array response.

Attachment receipts distinguish `failed` from `unknown`. An unknown outcome
means the upload may have reached Vikunja; inspect attachments or retry the
identical idempotency key instead of uploading under a new key.

Webhook creation accepts only credential-free HTTPS destinations on public
hosts. Cleartext, loopback, link-local, private-network, and URL-credential
targets are rejected before the Vikunja request.

`set_status` replaces every task label matching `VIKUNJA_STATUS_LABEL_PREFIX`
with the requested existing visible label in one bulk-label request. It repairs
tasks that already have multiple matching labels and reports that repair.
`createIfMissing` is opt-in; labels are global/visible Vikunja entities rather
than project-owned records, while the task itself remains project-verified.

Global-ID mutations without `projectSelector` are rejected under the default
`VIKUNJA_MUTATION_SCOPE_MODE=require`. Set `warn` (log only) or `off` only as a
temporary migration aid. A supplied project is always checked against the
resolved task before mutation.

Vikunja permissions still apply per operation. Applying a label may be denied
even when ordinary task updates are allowed. Some Vikunja builds also require
JWT/local-password authentication for user-data export routes; the MCP
preserves the real `401` instead of presenting false JWT advice.

Vikunja Pro currently gates three server capabilities: `admin_panel`,
`time_tracking`, and `audit_logs`. `self_check` reports the instance's
`enabledProFeatures` and, in full detail, the entitlement map. The typed
time-entry read checks `time_tracking` first and returns `FEATURE_NOT_LICENSED`
with the license remediation instead of exposing Vikunja's intentional opaque
404. It accepts both the string and integer enum encodings seen in v2.5
`/info` responses. The MCP does not claim admin-panel or audit-log operations
that it has not implemented.
If Vikunja 2.4 returns `subscription.entity: expected integer` while reading a
write response, the MCP reports `VIKUNJA_SUBSCRIPTION_SCHEMA_BUG` with the
[upstream issue](https://github.com/go-vikunja/vikunja/issues/3316). It does
not silently unsubscribe the user or claim that the token is invalid. For task
updates, it first reads the task back and reports success only when every
requested field is visibly applied.

See generated `MCP_API.md` for inputs. Responses contain a Markdown summary
plus one JSON envelope in `compact`, `standard`, and `full` modes. The default
`minimal` reads and `receipt` writes return only the JSON envelope, avoiding
duplicate facts. Task selectors are explicit objects:

```json
{ "globalId": 451 }
{ "identifier": "ALPHA-263" }
{ "projectIndex": 263 }
```

`projectIndex` also requires `projectSelector`. Bare numbers and strings are
rejected, which removes the old ambiguity between a global database ID and a
human project reference. Human-facing output uses the full identifier, while
structured receipts retain the global ID required by Vikunja URLs and API calls.
Task lists default to 20 projected items and cap each project page at 100. Use
`fields`, `includeUrl`, `titleMaxChars`, and `maxResponseChars` to pay only for
needed data; use `countOnly` for totals and follow `nextCursor` when
`incomplete` is true. Request `responseMode: "standard"` for ordinary expanded
task fields or `responseMode: "full"` for explicit bundled detail.
Use `vikunja_task_read` with `action: "my_tasks"` to list tasks assigned to the
authenticated user. Pass exactly one of `projectSelector`, `projects`, or
`allProjects: true`; `state` defaults to `open` and also accepts `closed` or
`all`. The response includes only the current user's `id` and `username`.

The project migration is intentionally fail-closed. Preview reports
estimated API calls. `cancel` records a durable stop request checked before the
next destination write and before source archival. The workflow writes a versioned,
public-sanitized manifest, uses durable per-task receipts, verifies complete
issue and comment content at GitHub, and closes a source task only after that
read-back succeeds. Binary attachments are represented as metadata unless a
future destination capability explicitly supports transfer. The GitHub token
is read only from the process environment and is sent only to an approved host.

### Operational Limits

- Bulk update: 100 explicit task selectors per call. Title and description
  replacements must use individual updates with each task's `expectedUpdatedAt`.
- Bulk create/upsert: 100 tasks per call; composed, continue-on-error, and
  non-atomic.
- Bulk assign/unassign: 100 explicit task selectors per call, with optional
  dry-run.
- Bulk delete: 100 explicit task selectors per call; composed, non-atomic, and requires
  `confirm: true`.
- CSV import and file transfer: 100 MiB by default through
  `VIKUNJA_MAX_ATTACHMENT_BYTES`. Vikunja controls CSV row limits.
- Attachment upload: at most 20 files per call, with both per-file and aggregate
  byte limits. Read paths must stay under `VIKUNJA_ATTACHMENT_SOURCE_ROOTS`.
- Full task get: five comments and 20 attachments by default, each configurable
  up to 100. Every response mode obeys `maxResponseChars`.
- Project export: 1,000 tasks by default with or without rich data. Per-task
  rich collections default to 100 items and fail explicitly rather than
  silently truncating.
- Idempotent CSV import: 1,000 rows per call. Same-key reruns skip rows recorded
  in the durable local ledger. Native migration remains faster.
- Multi-project lists page each project independently. Prefer `countOnly`
  when only totals are needed.

## Develop

```bash
npm test
npm run typecheck
npm run docs:api
npm run docs:api:check
```

## License

MIT — see `LICENSE` and `AUTHORS.md`.
