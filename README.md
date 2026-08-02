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
- Vikunja 2.4.0 with `/api/v2`
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
- `VIKUNJA_MAX_ATTACHMENT_BYTES`: upload and download size ceiling. Defaults
  to 100 MiB.
- `VIKUNJA_TEMPLATE_FILE`: machine-local template JSON path. Defaults under
  the user home directory.
- `VIKUNJA_MCP_RESPONSE_MODE`: `minimal` (default), `receipt`, `compact`,
  `standard`, or `full`. `minimal` and `receipt` return structured JSON only.
- `VIKUNJA_MCP_TOOL_PROFILE`: `core` (default), `qa`, `developer`, `full`, or
  `compatibility`. Smaller profiles reduce the schema loaded into each agent
  session. `compatibility` alone exposes the legacy broad `vikunja_tasks`
  router.
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
  full-profile GitHub migration tool. It is never accepted as a tool argument.
- `VIKUNJA_GITHUB_API_HOSTS`: optional comma-separated trusted GitHub Enterprise
  hostnames. GitHub.com uses `api.github.com` without configuration. IP literals,
  localhost, and unapproved hosts are rejected before a token is loaded.
- `VIKUNJA_GITHUB_TIMEOUT_MS`: bounded GitHub request timeout for migration.
  Defaults to 30000 and accepts 1000 through 120000.

Never commit tokens. Rejects `/api/v1` URLs.
API and browser URLs must use `http://` or `https://`.

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

## Emergency Python Fallback

The supported path is the npm-installed MCP. For a one-time emergency where
the MCP cannot start, [`fallback/vikunja-cli.py`](fallback/vikunja-cli.py) provides a
standalone `/api/v2` CLI with explicit setup, safety limits, and offline unit
tests documented in [`fallback/README.md`](fallback/README.md). Do not run both
as independent tracker writers.

## Tools

The default `core` profile exposes small typed tools instead of the broad
compatibility router:

- `self_check` / `vikunja_auth` — compact diagnostics and current user. Use
  `detail: "full"` only for capabilities and local paths.
- `vikunja_projects` — project list and get.
- `vikunja_task_read` — scoped list/search, projected get, batch get, task
  verification, project/programme snapshots, and durable receipt lookup.
- `vikunja_task_write` — guarded create, upsert, update, close, reopen, delete,
  assignee, label, status, and relation mutations.
- `vikunja_task_workflow` — evidence append, verified close, and other composed
  evidence workflows with compact receipts.
- `vikunja_task_attachments` — typed upload, bounded list/count, authenticated
  download, optional local SHA-256/duplicate warnings, and ownership-verified
  deletion.
- `vikunja_task_comments` — bounded comment lists and deltas with `since`,
  `countOnly`, and optional latest-comment metadata.

The `qa` profile adds `vikunja_task_organize` for assignees, labels, status, and
relations, plus labels, users, durable bulk work, reminders, import, and export.
`developer` adds user export, templates, and webhooks. `full` adds every typed
tool, including portable project migration. `compatibility` exposes all tools
plus the old `vikunja_tasks` router and should be used only while moving an
existing client to typed tools.

Additional profile-dependent tools:

- `vikunja_labels` — global labels (title or id)
- `vikunja_users`
- `vikunja_teams` — teams/members (`userId` is the Vikunja user id)
- `vikunja_filters` — create/get/update/delete (**no list**; API has no collection GET)
- `vikunja_task_bulk` — resumable create/upsert, update, delete, assign, and
  unassign operations with durable per-row receipts, dry-run, and status lookup.
- `vikunja_task_reminders` — list/add/remove task reminders
- `vikunja_batch_import` — detect, preview, import, and status for native-fast
  or MCP-idempotent CSV migration.
- `vikunja_export_project` — local JSON/CSV export with optional comments,
  attachments, and relations.
- `vikunja_project_migration` — full-profile preview/run/status workflow for a
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

Use `upsert` with a stable `externalKey` when a detector or repeated agent run
must update the same finding instead of creating duplicates. For three or more
tasks, prefer `vikunja_task_bulk create`; each row can carry its own
`externalKey`, and every mutating batch requires an `idempotencyKey`. Bulk
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
matching include flag is enabled.

Create, comment-create/update/delete, close, evidence-close, import, and
mutating bulk operations require `actor` attribution. `summary` returns project
counts by done state, priority, label, and configured status label without
returning task bodies.

Attachment deletion additionally requires explicit `projectSelector`,
`confirm:true`, and `actor`. The MCP resolves the task, verifies the attachment
belongs to it, and returns the deleted metadata plus the remaining count. Use
`page`, `perPage`, `countOnly`, and `filenamePrefix` for bounded attachment
lists; an old `vikunja_tasks list-attachments` call without these options keeps
its original simple array response.

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

The full-profile migration is intentionally fail-closed. It writes a versioned,
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
