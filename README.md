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

### Copy-Paste Agent Install Prompt

Paste this into any coding agent (Claude, Codex, or another MCP-capable
client) to have it install and configure the server. Replace nothing; the
agent asks you for the two values it needs.

```text
Install the Vikunja MCP server for this user:
1. Run: npm install -g vikunja-fastmcp@latest
2. Verify: npm list -g vikunja-fastmcp --depth=0
   Windows PowerShell: (Get-Command vikunja-mcp).Source
   macOS/Linux: command -v vikunja-mcp
3. Ask me for VIKUNJA_URL and VIKUNJA_API_TOKEN. The token comes from
   Vikunja Settings -> API Tokens. Never print or log it.
4. Register a stdio MCP server named "vikunja" with command "vikunja-mcp",
   no args, and those two environment variables. Never use a checkout or
   dist path.
5. Optional: use npm root -g to copy skills/vikunja-fastmcp into this
   agent's user-wide skill directory. Otherwise add SKILL.md to its rules.
6. Restart the MCP client, call self_check, and report the installed version,
   executable path, and edited config file without showing secrets.
```

### Copy-Paste Agent Update Prompt

```text
1. Run: npm install -g vikunja-fastmcp@latest
2. Verify: npm list -g vikunja-fastmcp --depth=0
   Windows PowerShell: (Get-Command vikunja-mcp).Source
   macOS/Linux: command -v vikunja-mcp
3. Keep command "vikunja-mcp" and preserve VIKUNJA_URL and
   VIKUNJA_API_TOKEN without printing secrets.
4. Use npm root -g to refresh skills/vikunja-fastmcp in the agent's
   user-wide skill directory, then restart the MCP client.
5. Report the executable and skill paths. Confirm the installed version with
   npm view vikunja-fastmcp version.
```

### Optional Agent Skill

The npm package includes a neutral `vikunja-fastmcp` skill containing the
scope, task-identity, pagination, write-safety, attachment, and error rules an
agent needs. `self_check` with `detail: "full"` reports its installed location
as `agentSkillPath`; the default basic check stays compact.

Install it for Codex on Windows PowerShell:

```powershell
$source = Join-Path (npm root -g) "vikunja-fastmcp\skills\vikunja-fastmcp"
$target = Join-Path $HOME ".codex\skills\vikunja-fastmcp"
New-Item -ItemType Directory -Force -Path (Split-Path $target) | Out-Null
Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
```

For Claude, use `$HOME\.claude\skills\vikunja-fastmcp` as the target. For an
agent without skill-folder support, place the contents of `SKILL.md` in that
client's persistent agent instructions or rules file. Restart the agent after
installing or updating the skill.

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
- `VIKUNJA_MCP_RESPONSE_MODE`: `compact` (default), `standard`, or `full`.
- `VIKUNJA_REQUEST_TIMEOUT_MS`: ordinary request timeout. Defaults to 30000.
- `VIKUNJA_TRANSFER_TIMEOUT_MS`: streamed and multipart inactivity timeout.
  Defaults to 60000.
- `VIKUNJA_MUTATION_SCOPE_MODE`: global-ID mutation policy. Defaults to
  `require`; `warn` and `off` are migration options.
- `VIKUNJA_STATUS_LABEL_PREFIX`: mutually exclusive task-status prefix.
  Defaults to `status:`.

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

- `self_check` / `vikunja_auth` — compact diagnostics and current user. Use
  `detail: "full"` only for capabilities and local paths.
- `vikunja_projects` — list / get
- `vikunja_tasks` — CRUD, stable-key upsert, open-task lists, project summary,
  create-if-absent, assignees, labels, status switching, relations, and
  attachments.
- `vikunja_task_comments` — paginated comment lists with a 20-item default and
  100-item maximum.
- `vikunja_labels` — global labels (title or id)
- `vikunja_users`
- `vikunja_teams` — teams/members (`userId` is the Vikunja user id)
- `vikunja_filters` — create/get/update/delete (**no list**; API has no collection GET)
- `vikunja_task_bulk` — native bulk update plus bounded create/upsert, delete,
  assign, and unassign operations with dry-run and idempotency support.
- `vikunja_task_reminders` — list/add/remove task reminders
- `vikunja_batch_import` — detect, preview, import, and status for native-fast
  or MCP-idempotent CSV migration.
- `vikunja_export_project` — local JSON/CSV export with optional comments,
  attachments, and relations.
- `vikunja_request_user_export` / `vikunja_download_user_export`
- `vikunja_templates` — machine-local templates and task instantiation
- `vikunja_webhooks` — project/user webhooks and event discovery

Templates default to `~/.vikunja-fastmcp/templates.json` and may be relocated
with `VIKUNJA_TEMPLATE_FILE`. Downloads and exports remain inside
`VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT`. Composed batch create/delete operations are
bounded to 100 tasks and are not atomic.

Task updates, assignment changes, and label removal return `unchanged` when the
requested state already exists. `close_with_evidence` accepts an
`idempotencyKey` so a process-local retry does not duplicate its evidence
comment.

Use `upsert` with a stable `externalKey` when a detector or repeated agent run
must update the same finding instead of creating duplicates. For three or more
tasks, prefer `vikunja_task_bulk create`; each row can carry its own
`externalKey`, and the batch can use an `idempotencyKey`. Bulk assign/unassign
accept `dryRun: true` and report changed, already-correct, and failed counts.

Use `appendDescription` to add evidence without replacing the full task
description. It is mutually exclusive with `description` and preserves a
stable-key marker as the final line. Project exports fetch comments,
attachments, or relations only when the matching include flag is enabled.

Create, comment, evidence-close, and idempotent-import operations accept
optional `actor` attribution. `summary` returns project counts by done state,
priority, label, and configured status label without returning task bodies.

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

See generated `MCP_API.md` for inputs. Responses contain a Markdown summary
and one JSON envelope (`ok` or `error`).
Task write summaries lead with the portal reference and always pair it with the
global ID, for example `ALPHA-263 (id 451)`; a bare numeric selector still means
the global ID.
Task lists default to 20 compact items and cap each project page at 100; use
`countOnly` for totals and pagination for larger result sets. Compact task
responses retain global ID, portal reference, project identity where needed,
title, done state, priority, and the creator username when available. Request
`responseMode: "standard"` for ordinary expanded task fields or
`responseMode: "full"` for explicit bundled detail.

### Operational Limits

- Bulk update/close: 100 global task IDs per call.
- Bulk create/upsert: 100 tasks per call; composed, continue-on-error, and
  non-atomic.
- Bulk assign/unassign: 100 global task IDs per call, with optional dry-run.
- Bulk delete: 100 task IDs per call; composed, non-atomic, and requires
  `confirm: true`.
- CSV import and file transfer: 100 MiB by default through
  `VIKUNJA_MAX_ATTACHMENT_BYTES`. Vikunja controls CSV row limits.
- Idempotent CSV import: 1,000 rows per call and up to 100 process-local ledger
  keys. Same-key reruns skip recorded rows. Native migration remains faster.
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
