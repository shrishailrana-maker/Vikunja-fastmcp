# Vikunja FastMCP V2

Clean-room **Vikunja `/api/v2` only** Model Context Protocol server. Direct Node 24 LTS `fetch`, runtime deps: `@modelcontextprotocol/sdk` and `zod`.

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
npm install -g vikunja-fastmcp
```

Restart the MCP client after installing or updating so it starts the new process.

### Copy-Paste Agent Install Prompt

Paste this into any coding agent (Claude, Codex, or another MCP-capable
client) to have it install and configure the server. Replace nothing; the
agent asks you for the two values it needs.

```text
Install the Vikunja MCP server for this user:
1. Run npm install -g vikunja-fastmcp (requires Node.js 24+). Verify with npm list -g vikunja-fastmcp --depth=0 and locate the executable with (Get-Command vikunja-mcp).Source on Windows or command -v vikunja-mcp on macOS/Linux.
2. Ask me for my Vikunja server URL and API token (created in Vikunja under Settings -> API Tokens). Never print or log the token.
3. Register the server in this client's MCP configuration: stdio server named "vikunja", command "vikunja-mcp" (no args, never a checkout/dist path), env VIKUNJA_URL and VIKUNJA_API_TOKEN.
4. Optional: use npm root -g to copy the bundled skills/vikunja-fastmcp folder to this client's user-wide skill directory; if this client has no skill folders, add the contents of its SKILL.md to persistent agent instructions.
5. Restart the MCP client, then call the self_check tool and confirm it reports ok with connectionStatus online.
6. Report the installed version, executable path, and config file you edited, without showing secrets.
```

### Copy-Paste Agent Update Prompt

```text
Update Vikunja FastMCP globally for this user: npm install -g vikunja-fastmcp@latest
Verify npm list -g vikunja-fastmcp --depth=0; locate it with (Get-Command vikunja-mcp).Source on Windows or command -v vikunja-mcp on macOS/Linux.
Ensure the MCP config uses command "vikunja-mcp", never a checkout/dist path; use npm root -g to copy bundled skills/vikunja-fastmcp to the agent's user-wide skill directory (for example ~/.codex/skills/vikunja-fastmcp or ~/.claude/skills/vikunja-fastmcp).
Preserve existing VIKUNJA_URL and VIKUNJA_API_TOKEN without printing secrets, then restart the agent.
Report the installed version, executable path, and skill path; confirm the installed version matches npm view vikunja-fastmcp version.
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

| Variable                           | Required | Description                                                                           |
| ---------------------------------- | -------- | ------------------------------------------------------------------------------------- |
| `VIKUNJA_URL`                      | yes      | Server root or `…/api/v2` (e.g. `http://host:3456`)                                   |
| `VIKUNJA_API_TOKEN`                | yes      | Bearer token (`tk_…`)                                                                 |
| `VIKUNJA_WEB_URL`                  | no       | Browser base for task/project links                                                   |
| `VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT` | no       | Sandboxed download root (defaults under the OS temp directory)                        |
| `VIKUNJA_MAX_ATTACHMENT_BYTES`     | no       | Upload/download size ceiling (default 100 MiB)                                        |
| `VIKUNJA_TEMPLATE_FILE`            | no       | Machine-local template JSON path (defaults under the user home directory)             |
| `VIKUNJA_MCP_RESPONSE_MODE`        | no       | Default task response size: `compact` (default), `standard`, or `full`                |
| `VIKUNJA_REQUEST_TIMEOUT_MS`       | no       | Positive per-request timeout in milliseconds (default 30000)                          |
| `VIKUNJA_TRANSFER_TIMEOUT_MS`      | no       | Streamed and multipart transfer timeout in milliseconds (default 60000)               |
| `VIKUNJA_MUTATION_SCOPE_MODE`      | no       | Global-ID mutation policy: `require` (default), `warn`, or `off`                      |
| `VIKUNJA_STATUS_LABEL_PREFIX`      | no       | Prefix whose labels form one mutually exclusive task-status group (default `status:`) |

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

MCP clients should launch `dist/index.js` over stdio with the env vars above.

## Emergency Python Fallback

The supported path is the npm-installed MCP. For a one-time emergency where
the MCP cannot start, [`fallback/vikunja-cli.py`](fallback/vikunja-cli.py) provides a
standalone `/api/v2` CLI with explicit setup, safety limits, and offline unit
tests documented in [`fallback/README.md`](fallback/README.md). Do not run both
as independent tracker writers.

## Tools

- `self_check` / `vikunja_auth` — compact diagnostics and current user (no email); use `detail: "full"` only for capabilities and local paths
- `vikunja_projects` — list / get
- `vikunja_tasks` — CRUD, stable-key upsert, list (default **open only**), project summary, create_if_absent, assignees, labels, mutually exclusive status switching, relations, attachments
- `vikunja_task_comments` — comment lists default to 20 items per page and accept `page` / `perPage` (max 100)
- `vikunja_labels` — global labels (title or id)
- `vikunja_users`
- `vikunja_teams` — teams/members (`userId` is the Vikunja user id)
- `vikunja_filters` — create/get/update/delete (**no list**; API has no collection GET)
- `vikunja_task_bulk` — native bulk update; bounded composed create/upsert, delete, assign, and unassign with dry-run support
- `vikunja_task_reminders` — list/add/remove task reminders
- `vikunja_batch_import` — detect/preview/import/status for native-fast or MCP-idempotent CSV migration
- `vikunja_export_project` — local JSON/CSV task export with optional comments, attachments, and relations
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

See generated `MCP_API.md` for inputs. Responses are Markdown summary + one JSON envelope (`ok` / `error`).
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
- Bulk create/upsert: 100 tasks per call; composed, continue-on-error, and non-atomic.
- Bulk assign/unassign: 100 global task IDs per call, with optional dry-run.
- Bulk delete: 100 task IDs per call; composed, non-atomic, and requires `confirm: true`.
- CSV import and file transfer: 100 MiB by default through `VIKUNJA_MAX_ATTACHMENT_BYTES`; Vikunja controls CSV row limits.
- Idempotent CSV import: 1,000 rows per call and up to 100 process-local import-ledger keys; same-key reruns skip rows already recorded. Native migration remains faster and non-idempotent.
- Multi-project lists page each project independently. Prefer `countOnly` when only totals are needed.

## Develop

```bash
npm test
npm run typecheck
npm run docs:api
npm run docs:api:check
```

## License

MIT — see `LICENSE` and `AUTHORS.md`.
