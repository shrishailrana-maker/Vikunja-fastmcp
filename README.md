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
- Vikunja API token with access to the projects you need

## Install

Install the prebuilt public release globally:

```bash
npm install -g vikunja-fastmcp
```

Restart the MCP client after installing or updating so it starts the new process.

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

| Variable | Required | Description |
| --- | --- | --- |
| `VIKUNJA_URL` | yes | Server root or `…/api/v2` (e.g. `http://host:3456`) |
| `VIKUNJA_API_TOKEN` | yes | Bearer token (`tk_…`) |
| `VIKUNJA_WEB_URL` | no | Browser base for task/project links |
| `VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT` | no | Sandboxed download root (defaults under the OS temp directory) |
| `VIKUNJA_MAX_ATTACHMENT_BYTES` | no | Upload/download size ceiling (default 100 MiB) |
| `VIKUNJA_TEMPLATE_FILE` | no | Machine-local template JSON path (defaults under the user home directory) |
| `VIKUNJA_MCP_RESPONSE_MODE` | no | Default task response size: `compact` (default), `standard`, or `full` |

Never commit tokens. Rejects `/api/v1` URLs.

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
- `vikunja_tasks` — CRUD, list (default **open only**), create_if_absent, assignees, labels, relations, attachments
- `vikunja_task_comments` — comment lists default to 20 items per page and accept `page` / `perPage` (max 100)
- `vikunja_labels` — global labels (title or id)
- `vikunja_users`
- `vikunja_teams` — teams/members (`userId` is the Vikunja user id)
- `vikunja_filters` — create/get/update/delete (**no list**; API has no collection GET)
- `vikunja_task_bulk` — native bulk update; bounded composed create/delete
- `vikunja_task_reminders` — list/add/remove task reminders
- `vikunja_batch_import` — detect/preview/import/status for native CSV migration
- `vikunja_export_project` — local JSON/CSV task export
- `vikunja_request_user_export` / `vikunja_download_user_export`
- `vikunja_templates` — machine-local templates and task instantiation
- `vikunja_webhooks` — project/user webhooks and event discovery

Templates default to `~/.vikunja-fastmcp/templates.json` and may be relocated
with `VIKUNJA_TEMPLATE_FILE`. Downloads and exports remain inside
`VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT`. Composed batch create/delete operations are
bounded to 100 tasks and are not atomic.

Vikunja permissions still apply per operation. Applying a label may be denied
even when ordinary task updates are allowed. Some Vikunja builds also require
JWT/local-password authentication for user-data export routes; the MCP
preserves the real `401` instead of presenting false JWT advice.

See generated `MCP_API.md` for inputs. Responses are Markdown summary + one JSON envelope (`ok` / `error`).
Task lists default to 20 compact items and cap each project page at 100; use
`countOnly` for totals and pagination for larger result sets. Compact task
responses retain global ID, portal reference, project identity where needed,
title, done state, and priority. Request `responseMode: "standard"` for ordinary
expanded task fields or `responseMode: "full"` for explicit bundled detail.

### Operational Limits

- Bulk update/close: 100 global task IDs per call.
- Bulk create: 100 tasks per call; composed and non-atomic.
- Bulk delete: 100 task IDs per call; composed, non-atomic, and requires `confirm: true`.
- CSV import and file transfer: 100 MiB by default through `VIKUNJA_MAX_ATTACHMENT_BYTES`; Vikunja controls CSV row limits.
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
