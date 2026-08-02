# Emergency Python Fallback

`vikunja-cli.py` is a standalone, one-time fallback for machines where the normal
`vikunja-fastmcp` MCP process cannot be started or repaired promptly. It calls
the Vikunja 2.4.0 `/api/v2` REST API directly and emits the same human summary
plus one fenced JSON envelope used by the MCP. It intentionally carries no
workarounds for older Vikunja releases.

Use the npm MCP for normal agent work. This CLI is not an MCP server, is not
started automatically, and must not be configured alongside the MCP as a
second tracker writer.

## Setup

Python 3.10 or newer is recommended. Install its only external dependency:

```powershell
python -m pip install -r fallback\requirements.txt
```

Set credentials only in the local process environment:

```powershell
$env:VIKUNJA_URL = "https://vikunja.example.com/api/v2"
$env:VIKUNJA_API_TOKEN = "<LOCAL_TOKEN>"
$env:VIKUNJA_ATTACHMENT_SOURCE_ROOTS = "C:\safe\logs;$env:TEMP"
```

Never put the token in this repository, command arguments, output files, or
tracker comments.

## Verify

```powershell
python fallback\vikunja-cli.py self_check
python -m unittest fallback.test_vikunja_cli
```

## Examples

Always scope task operations to the intended project:

```powershell
python fallback\vikunja-cli.py vikunja_tasks list --project-id 2 --count-only
python fallback\vikunja-cli.py vikunja_tasks get --project-id 2 --task-selector "#305"
python fallback\vikunja-cli.py vikunja_tasks create --project-id 2 --title "Example bug"
python fallback\vikunja-cli.py vikunja_tasks update --project-id 2 --task-selector 9005 --fields-json '{"percent_done":0.5}'
```

Export comments only when needed because it performs an additional paginated
request for every exported task:

```powershell
python fallback\vikunja-cli.py vikunja_export_project export --project-id 2 --format json --include-comments
```

## Safety And Limits

- Numeric task selectors are global database IDs. `#index` requires an
  explicit project.
- Lists default to open tasks and 25 items. Each project page is capped at 100;
  follow `nextPage` for more.
- Bulk operations are limited to 100 tasks. Composed create/delete operations
  are not atomic.
- Downloads and exports stay under `VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT`, which
  defaults to the OS temporary directory.
- Uploads and CSV imports must be regular, non-symlink files under one of the
  path-delimited `VIKUNJA_ATTACHMENT_SOURCE_ROOTS`. The default roots are the
  current working directory and the OS temporary directory.
- Download/export paths reject symlink escapes, files are created with private
  permissions where the OS supports them, multipart filenames cannot inject
  headers, and CSV exports neutralize spreadsheet formulas.
- Requests time out after 30 seconds by default. Override with
  `VIKUNJA_REQUEST_TIMEOUT_SECONDS`.
- Arguments such as webhook secrets and export passwords may be visible in
  shell history or process inspection. Avoid those operations through the
  fallback unless the machine and session are trusted.
- Run one writer per task and follow the repository's Vikunja discipline rules.

The fallback is deliberately isolated from the production TypeScript runtime.
When the MCP works again, stop using this CLI and return to `vikunja-fastmcp`.
