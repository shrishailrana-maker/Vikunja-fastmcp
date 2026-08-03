/**
 * Public per-operation contract used by tools/list and generated MCP_API.md.
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

export interface OperationDoc {
  action: string;
  required?: string[];
  optional?: string[];
  execution: string;
  note?: string;
}

const taskSelector = [
  'projectSelector (required with taskSelector.projectIndex; optional guard otherwise)',
];
const writeOptions = ['expectedUpdatedAt'];
const mutationEnvelope = ['projectSelector', 'actor', 'idempotencyKey'];

export const TOOL_OPERATION_DOCS: Record<string, OperationDoc[]> = {
  vikunja_auth: [
    { action: 'status', execution: 'Direct: GET /user' },
    {
      action: 'self-check',
      optional: ['detail (basic default, full for capabilities and local paths)'],
      execution: 'MCP-composed diagnostics',
    },
  ],
  vikunja_projects: [
    { action: 'list', execution: 'Direct paginated GET /projects' },
    {
      action: 'get',
      required: ['project.id or project.title'],
      execution: 'Direct GET /projects/{id}',
    },
  ],
  vikunja_tasks: [
    {
      action: 'create',
      required: [...mutationEnvelope, 'fields.title'],
      optional: ['fields', 'attachments', 'firstComment', 'relations', 'dryRun', 'responseMode'],
      execution:
        'Direct POST; MCP-composed when attachments, a first comment, or relations are supplied',
      note: 'For 3 or more tasks use vikunja_task_bulk create instead of repeated create calls.',
    },
    {
      action: 'create_if_absent',
      required: [...mutationEnvelope, 'fields.title'],
      optional: ['fields', 'attachments', 'firstComment', 'relations', 'dryRun', 'responseMode'],
      execution: 'MCP-composed exact-title search then optional create/attach',
      note: 'Best-effort duplicate prevention, not a distributed lock.',
    },
    {
      action: 'upsert',
      required: [...mutationEnvelope, 'fields.title', 'externalKey'],
      optional: [
        'fields',
        'expectedUpdatedAt',
        'firstComment',
        'relations',
        'dryRun',
        'responseMode',
      ],
      execution: 'MCP-composed description-key lookup followed by create or conditional update',
      note: 'Requires server-side description filtering. Updating a matched title/description also requires expectedUpdatedAt.',
    },
    {
      action: 'get',
      required: ['taskSelector'],
      optional: [
        ...taskSelector,
        'commentLimit (full mode only; default 5, max 100)',
        'attachmentLimit (full mode only; default 20, max 100)',
        'fields (projected task fields in minimal mode)',
        'includeUrl (default false)',
        'titleMaxChars',
        'maxResponseChars',
        'responseMode (minimal default; receipt/compact/standard/full explicit)',
      ],
      execution: 'Direct compact/standard GET; full mode composes comments and attachments',
      note: 'taskSelector is exactly one of {globalId}, {identifier}, or {projectIndex}; bare numbers and strings are rejected.',
    },
    {
      action: 'list',
      optional: [
        'exactly one of projectSelector, projects, allProjects',
        'page (default 1)',
        'perPage (default 20; requests above 100 are safely capped to 100)',
        'done',
        'allStates',
        'priority (0-5)',
        'label',
        'assignee (exact username; numeric user IDs are not valid Vikunja list filters)',
        'titleContains (server-side title-only match)',
        'descriptionContains (requires server-side description filtering)',
        'changedSince (ISO timestamp)',
        'actor (matches stored "(by actor)" attribution; requires server-side description filtering)',
        'q',
        'search (free-text alias for q)',
        'searchIn (all default, title, or description)',
        'filter',
        'countOnly',
        'fields (projected task fields)',
        'includeUrl (default false)',
        'titleMaxChars',
        'maxResponseChars (default 4000 in minimal mode)',
        'cursor',
        'responseMode (minimal default; receipt/compact/standard/full explicit)',
      ],
      execution: 'Direct per project; grouped subsets/allProjects are MCP-composed',
      note: 'Defaults to done=false unless done or allStates is supplied.',
    },
    {
      action: 'my_tasks',
      optional: [
        'exactly one of projectSelector, projects, allProjects',
        'state (open default, closed, or all)',
        'ownership (assigned default; only assigned is supported)',
        'page (default 1)',
        'perPage (default 20; requests above 100 are safely capped to 100)',
        'search (free-text task search)',
        'label',
        'changedSince (ISO timestamp)',
        'countOnly',
        'fields (projected task fields)',
        'includeUrl (default false)',
        'titleMaxChars',
        'maxResponseChars (default 4000 in minimal mode)',
        'cursor',
        'responseMode (minimal default; receipt/compact/standard/full explicit)',
      ],
      execution:
        'GET /user for the authenticated username, then exact-assignee task listing through the existing list path',
      note: 'Returns only the current user id and username. The task scope remains exactly one projectSelector, projects, or allProjects:true.',
    },
    {
      action: 'summary',
      required: ['projectSelector'],
      execution: 'MCP-composed paginated counts by state, priority, and label',
    },
    {
      action: 'batch_get',
      required: ['identifiers'],
      optional: ['fields', 'includeUrl', 'titleMaxChars', 'responseMode'],
      execution: 'MCP-composed bounded identity resolution and projected task reads',
    },
    {
      action: 'verify_task_state',
      required: ['taskSelector'],
      optional: [...taskSelector, 'responseMode'],
      execution: 'MCP-composed task, latest comments, attachments, and relation metadata',
    },
    {
      action: 'programme_snapshot',
      required: ['projectSelector'],
      optional: ['staleDays', 'changedSince', 'changedLimit', 'cursor', 'preset', 'responseMode'],
      execution:
        'MCP-composed bounded programme aggregates and cursor-paged changed-task summary; preset=mpf adds reconciliation counts',
    },
    {
      action: 'task_dedupe',
      required: ['projectSelector', 'title'],
      optional: ['responseMode'],
      execution: 'Advisory server-side title candidate search',
    },
    {
      action: 'lookup_external_key',
      required: ['projectSelector', 'externalKey'],
      optional: ['responseMode'],
      execution: 'Direct server-side stable-marker lookup; never scans the whole project',
    },
    {
      action: 'receipt_lookup',
      required: ['operation', 'idempotencyKey'],
      optional: ['responseMode'],
      execution: 'Machine-local durable idempotency receipt lookup',
    },
    {
      action: 'update',
      required: ['taskSelector', 'fields', ...mutationEnvelope],
      optional: [
        ...taskSelector,
        ...writeOptions,
        'fields.appendDescription (mutually exclusive with fields.description)',
        'dryRun',
        'responseMode',
      ],
      execution: 'Identity/read preflight followed by RFC 6902 PATCH',
      note: 'Replacing title or description requires expectedUpdatedAt.',
    },
    {
      action: 'delete',
      required: ['taskSelector', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Identity preflight then DELETE /tasks/{id}',
    },
    {
      action: 'close',
      required: ['taskSelector', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Identity/read preflight then task update transport',
    },
    {
      action: 'reopen',
      required: ['taskSelector', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Identity/read preflight then task update transport',
    },
    {
      action: 'close_with_evidence',
      required: ['taskSelector', ...mutationEnvelope],
      optional: [
        'evidence (preferred structured form)',
        'evidenceComment (compatibility)',
        'dryRun',
        'responseMode',
      ],
      execution: 'MCP-composed comment create followed by task close',
    },
    {
      action: 'append_evidence_if_changed',
      required: ['taskSelector', 'evidence', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'MCP-composed evidence-key lookup followed by optional comment create',
    },
    {
      action: 'close_if_verified',
      required: ['taskSelector', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'MCP-composed PASS-comment verification followed by conditional close',
    },
    {
      action: 'transition_with_evidence',
      required: ['taskSelector', 'statusLabel', 'evidence', ...mutationEnvelope],
      optional: ['createIfMissing (default false)', 'dryRun', 'responseMode'],
      execution:
        'MCP-composed deduplicated evidence append followed by one status-label transition',
    },
    {
      action: 'assign',
      required: ['taskSelector', 'userSelector', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Identity preflight then POST assignee',
    },
    {
      action: 'unassign',
      required: ['taskSelector', 'userSelector', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Identity preflight then DELETE assignee',
    },
    {
      action: 'list-assignees',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Direct GET after identity resolution',
    },
    {
      action: 'apply-label',
      required: ['taskSelector', 'labelTitle', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution:
        'Return unchanged when already attached; otherwise resolve/create then POST task label',
      note: 'labelTitle accepts an exact title or numeric label ID.',
    },
    {
      action: 'remove-label',
      required: ['taskSelector', 'labelTitle', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Resolve label then DELETE task label',
      note: 'labelTitle accepts an exact title or numeric label ID.',
    },
    {
      action: 'list-labels',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Direct GET after identity resolution',
    },
    {
      action: 'set_status',
      required: ['taskSelector', 'statusLabel', ...mutationEnvelope],
      optional: ['createIfMissing (default false)', 'dryRun', 'responseMode'],
      execution: 'Identity preflight then one bulk label-set replacement',
      note: 'Preserves non-status labels and repairs multiple configured-prefix labels.',
    },
    {
      action: 'relate',
      required: ['taskSelector', 'otherTaskSelector', 'relationKind', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Resolve both tasks then POST relation',
    },
    {
      action: 'unrelate',
      required: ['taskSelector', 'otherTaskSelector', 'relationKind', ...mutationEnvelope],
      optional: ['dryRun', 'responseMode'],
      execution: 'Resolve both tasks then DELETE relation',
    },
    {
      action: 'list-relations',
      required: ['taskSelector'],
      optional: [...taskSelector, 'responseMode (compact default; standard/full explicit)'],
      execution: 'MCP-composed from task related_tasks data',
    },
    {
      action: 'attach',
      required: [
        'taskSelector',
        'projectSelector',
        'filePaths or base64Content+filename',
        'actor',
        'idempotencyKey',
      ],
      optional: ['mimeType', 'computeSha256', 'warnOnDuplicate', 'responseMode'],
      execution: 'Multipart POST per file after identity resolution',
      note: 'Local hashes and duplicate warnings are opt-in. Results separate uploaded, failed, and outcome-unknown files.',
    },
    {
      action: 'list-attachments',
      required: ['taskSelector'],
      optional: [...taskSelector, 'page', 'perPage', 'countOnly', 'filenamePrefix'],
      execution: 'Direct paginated GET or bounded MCP-side prefix page after identity resolution',
      note: 'Calls without paging/filter arguments retain the legacy attachment-array response.',
    },
    {
      action: 'download-attachment',
      required: ['taskSelector', 'attachmentId'],
      optional: [...taskSelector, 'destinationPath', 'overwrite'],
      execution: 'Authenticated streaming GET to sandboxed local disk',
    },
    {
      action: 'delete-attachment',
      required: [
        'taskSelector',
        'projectSelector',
        'attachmentId',
        'confirm',
        'actor',
        'idempotencyKey',
      ],
      execution: 'Resolve task, verify attachment ownership, then direct DELETE',
      note: 'confirm must be true; durable retries return the original deletion receipt.',
    },
  ],
  vikunja_task_attachments: [
    {
      action: 'attach',
      required: [
        'taskSelector',
        'projectSelector',
        'filePaths or base64Content+filename',
        'actor',
        'idempotencyKey',
      ],
      optional: ['mimeType', 'computeSha256', 'warnOnDuplicate'],
      execution: 'Multipart POST per file after identity resolution',
      note: 'Local hashes and duplicate warnings are opt-in; the server does not expose hashes.',
    },
    {
      action: 'list',
      required: ['taskSelector'],
      optional: [...taskSelector, 'page', 'perPage', 'countOnly', 'filenamePrefix'],
      execution: 'Bounded direct GET or MCP-side prefix page after identity resolution',
    },
    {
      action: 'download',
      required: ['taskSelector', 'attachmentId'],
      optional: [...taskSelector, 'destinationPath', 'overwrite'],
      execution: 'Authenticated streaming GET to sandboxed local disk',
    },
    {
      action: 'delete',
      required: [
        'taskSelector',
        'projectSelector',
        'attachmentId',
        'confirm',
        'actor',
        'idempotencyKey',
      ],
      execution: 'Resolve task, verify attachment ownership, then direct DELETE',
      note: 'Never deletes an attachment that is absent from the resolved task.',
    },
  ],
  vikunja_task_comments: [
    {
      action: 'create',
      required: ['taskSelector', 'comment', 'actor', 'idempotencyKey'],
      optional: taskSelector,
      execution: 'Direct POST after identity resolution',
    },
    {
      action: 'list',
      required: ['taskSelector'],
      optional: [
        ...taskSelector,
        'page (default 1)',
        'perPage (default 20, max 100)',
        'since',
        'countOnly',
        'includeLatest',
        'maxScanPages (default 20, max 50)',
      ],
      execution: 'Direct paginated GET or bounded newest-first MCP-side since scan',
      note: 'A capped since scan reports incomplete=true rather than silently truncating.',
    },
    {
      action: 'get',
      required: ['taskSelector', 'commentId'],
      optional: taskSelector,
      execution: 'Direct GET after identity resolution',
    },
    {
      action: 'update',
      required: ['taskSelector', 'commentId', 'comment', 'actor'],
      optional: taskSelector,
      execution: 'Direct PATCH after identity resolution',
    },
    {
      action: 'delete',
      required: ['taskSelector', 'commentId', 'actor'],
      optional: taskSelector,
      execution: 'Direct DELETE after identity resolution',
    },
  ],
  vikunja_labels: [
    { action: 'list', execution: 'Direct paginated GET /labels' },
    { action: 'get', required: ['labelSelector'], execution: 'Direct GET /labels/{id}' },
    {
      action: 'create',
      required: ['title'],
      optional: ['description', 'hexColor'],
      execution: 'Direct POST /labels',
    },
    {
      action: 'update',
      required: ['labelSelector'],
      optional: ['title', 'description', 'hexColor'],
      execution: 'Direct PATCH /labels/{id}',
    },
    { action: 'delete', required: ['labelSelector'], execution: 'Direct DELETE /labels/{id}' },
  ],
  vikunja_users: [
    { action: 'current', execution: 'Direct GET /user' },
    { action: 'search', optional: ['q'], execution: 'Direct GET /users?q=' },
  ],
  vikunja_teams: [
    { action: 'list', execution: 'Direct paginated GET /teams' },
    { action: 'get', required: ['teamId'], execution: 'Direct GET /teams/{id}' },
    { action: 'create', required: ['name'], execution: 'Direct POST /teams' },
    { action: 'update', required: ['teamId', 'name'], execution: 'Direct PATCH /teams/{id}' },
    { action: 'delete', required: ['teamId'], execution: 'Direct DELETE /teams/{id}' },
    {
      action: 'add-member',
      required: ['teamId', 'usernameOrId (username only for add)'],
      execution: 'POST then authoritative team readback',
    },
    {
      action: 'remove-member',
      required: ['teamId', 'usernameOrId'],
      execution: 'Optional team readback then DELETE member',
    },
    {
      action: 'set-member-admin',
      required: ['teamId', 'usernameOrId', 'admin'],
      execution: 'Team readback then conditional POST toggle',
    },
  ],
  vikunja_filters: [
    {
      action: 'create',
      required: ['title', 'filterQuery'],
      optional: ['description', 'isFavorite'],
      execution: 'Direct POST /filters',
    },
    { action: 'get', required: ['filterId'], execution: 'Direct GET /filters/{id}' },
    {
      action: 'update',
      required: ['filterId'],
      optional: ['title', 'filterQuery', 'description', 'isFavorite'],
      execution: 'Direct PATCH /filters/{id}',
    },
    { action: 'delete', required: ['filterId'], execution: 'Direct DELETE /filters/{id}' },
  ],
  vikunja_task_bulk: [
    {
      action: 'update',
      required: ['projectSelector', 'taskSelectors', 'fields', 'actor', 'idempotencyKey'],
      optional: ['dryRun'],
      execution: 'MCP-composed per-task updates with durable row receipts',
      note: 'Bulk title/description replacement is rejected; use individual optimistic updates.',
    },
    {
      action: 'create',
      required: ['projectSelector', 'tasks', 'actor', 'idempotencyKey'],
      optional: ['tasks[].externalKey', 'tasks[].firstComment', 'tasks[].relations', 'dryRun'],
      execution: 'MCP-composed bounded task creates with durable row receipts',
      note: 'Each row may provide externalKey, expectedUpdatedAt, firstComment, and relations. Repeating the same request resumes failed rows and skips recorded successes.',
    },
    {
      action: 'delete',
      required: ['projectSelector', 'taskSelectors', 'confirm', 'actor', 'idempotencyKey'],
      optional: ['dryRun'],
      execution: 'MCP-composed verified task deletes with durable row receipts',
    },
    {
      action: 'assign',
      required: ['projectSelector', 'taskSelectors', 'userSelector', 'actor', 'idempotencyKey'],
      optional: ['dryRun'],
      execution: 'Resolve user once, verify each task scope, then compose bounded assignee writes',
    },
    {
      action: 'unassign',
      required: ['projectSelector', 'taskSelectors', 'userSelector', 'actor', 'idempotencyKey'],
      optional: ['dryRun'],
      execution: 'Resolve user once, verify each task scope, then compose bounded assignee deletes',
    },
    {
      action: 'set_status',
      required: ['projectSelector', 'taskSelectors', 'statusLabel', 'actor', 'idempotencyKey'],
      optional: ['createIfMissing', 'dryRun'],
      execution: 'MCP-composed per-task status-label transitions with durable row receipts',
    },
    {
      action: 'apply-label',
      required: ['projectSelector', 'taskSelectors', 'labelTitle', 'actor', 'idempotencyKey'],
      optional: ['dryRun'],
      execution: 'MCP-composed per-task label application with durable row receipts',
    },
    {
      action: 'remove-label',
      required: ['projectSelector', 'taskSelectors', 'labelTitle', 'actor', 'idempotencyKey'],
      optional: ['dryRun'],
      execution: 'MCP-composed per-task label removal with durable row receipts',
    },
    {
      action: 'close_with_evidence',
      required: ['projectSelector', 'taskSelectors', 'evidenceComment', 'actor', 'idempotencyKey'],
      optional: ['dryRun'],
      execution: 'MCP-composed evidence comment plus close with resumable per-row receipts',
    },
    {
      action: 'status',
      required: ['operationId'],
      optional: ['cursor', 'perPage', 'countOnly'],
      execution: 'Read paginated durable local bulk-operation receipts',
    },
  ],
  vikunja_task_reminders: [
    {
      action: 'list',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Direct task read; reminders are embedded task fields',
    },
    {
      action: 'add',
      required: ['taskSelector'],
      optional: [...taskSelector, 'reminder', 'relativePeriod', 'relativeTo'],
      execution: 'Task read followed by RFC 6902 PATCH of reminders',
    },
    {
      action: 'remove',
      required: ['taskSelector', 'reminderIndex'],
      optional: taskSelector,
      execution: 'Task read followed by RFC 6902 PATCH of reminders',
    },
  ],
  vikunja_batch_import: [
    { action: 'detect', required: ['filePath'], execution: 'Direct multipart CSV detect' },
    {
      action: 'preview',
      required: ['filePath', 'config'],
      optional: ['mode (native default or idempotent)', 'projectSelector'],
      execution: 'Direct multipart native preview or MCP-local idempotent preview',
    },
    {
      action: 'import',
      required: ['filePath', 'config', 'actor'],
      optional: [
        'mode (native default or idempotent)',
        'idempotencyKey (required in idempotent mode)',
        'projectSelector',
      ],
      execution: 'Direct native migration or MCP-composed row-by-row task creation',
      note: 'Native mode is fast and non-idempotent; idempotent mode uses the durable local ledger.',
    },
    {
      action: 'status',
      optional: [
        'mode (native default or idempotent)',
        'idempotencyKey (required in idempotent mode)',
      ],
      execution: 'Direct native GET or compact durable local ledger status',
    },
  ],
  vikunja_export_project: [
    {
      action: 'export',
      required: ['projectSelector'],
      optional: [
        'format',
        'destinationPath',
        'includeComments',
        'includeAttachments',
        'includeRelations',
        'taskLimit (default 1000)',
        'detailLimit (default 100 per task)',
        'overwrite (default false)',
      ],
      execution: 'MCP-composed paginated export to sandboxed JSON or CSV',
      note: 'Creator is always included; comments, attachments, and relations are fetched only when their include flags are true. The receipt reports task count, API request count, elapsed time, and incomplete=false; bounded truncation fails explicitly.',
    },
  ],
  vikunja_project_migration: [
    {
      action: 'preview',
      required: ['projectSelector', 'destination', 'actor', 'idempotencyKey'],
      optional: ['publicSanitize (default true)', 'taskLimit', 'detailLimit'],
      execution: 'Versioned sanitized manifest written under the configured local sandbox',
      note: 'No GitHub write occurs; binary attachment transfer is reported unsupported.',
    },
    {
      action: 'run',
      required: ['projectSelector', 'destination', 'actor', 'idempotencyKey'],
      optional: ['archiveSource', 'publicSanitize (default true)', 'taskLimit', 'detailLimit'],
      execution:
        'Durable per-task GitHub create/reuse, comment copy, read-back, optional source close',
      note: 'GITHUB_TOKEN or GH_TOKEN is read from the process environment and never accepted as a tool argument.',
    },
    {
      action: 'status',
      required: ['operationId'],
      optional: ['cursor', 'perPage', 'countOnly'],
      execution: 'Paginated durable local migration receipts',
    },
    {
      action: 'cancel',
      required: ['operationId', 'actor'],
      execution:
        'Durable cancellation request checked before the next destination write and before source archival',
    },
  ],
  vikunja_request_user_export: [
    {
      action: 'request',
      optional: ['password'],
      execution: 'Direct POST /user/export/request; password is write-only',
      note: 'Some Vikunja servers require JWT/local-password authentication for user exports.',
    },
  ],
  vikunja_download_user_export: [
    { action: 'status', execution: 'Direct GET /user/export' },
    {
      action: 'download',
      optional: ['password', 'destinationPath', 'overwrite (default false)'],
      execution: 'Authenticated streaming POST to sandboxed local disk',
      note: 'Some Vikunja servers require JWT/local-password authentication for user exports.',
    },
  ],
  vikunja_templates: [
    { action: 'list', execution: 'Machine-local template store' },
    {
      action: 'create',
      required: ['name', 'fields'],
      execution: 'Atomic write to machine-local template store',
    },
    { action: 'get', required: ['templateSelector'], execution: 'Machine-local lookup' },
    { action: 'delete', required: ['templateSelector'], execution: 'Machine-local delete' },
    {
      action: 'instantiate',
      required: ['templateSelector', 'projectSelector'],
      optional: ['variables'],
      execution: 'Local substitution followed by direct task create',
    },
  ],
  vikunja_webhooks: [
    {
      action: 'events',
      optional: ['scope'],
      execution: 'Direct project or user event catalog',
    },
    {
      action: 'list',
      optional: ['scope', 'projectSelector'],
      execution: 'Direct project or user webhook list',
    },
    {
      action: 'create',
      required: ['targetUrl', 'events'],
      optional: ['scope', 'projectSelector', 'secret', 'basicAuthUser', 'basicAuthPassword'],
      execution: 'Direct project or user webhook create; credentials are write-only',
      note: 'Targets must be credential-free HTTPS URLs on public hosts.',
    },
    {
      action: 'update',
      required: ['webhookId', 'events'],
      optional: ['scope', 'projectSelector'],
      execution: 'Direct project or user webhook event update',
      note: 'Vikunja treats target URL and credentials as immutable after creation.',
    },
    {
      action: 'delete',
      required: ['webhookId'],
      optional: ['scope', 'projectSelector'],
      execution: 'Direct project or user webhook delete',
    },
  ],
};

const taskActions = (actions: string[]) =>
  TOOL_OPERATION_DOCS.vikunja_tasks.filter((operation) => actions.includes(operation.action));

TOOL_OPERATION_DOCS.vikunja_task_read = taskActions([
  'get',
  'list',
  'my_tasks',
  'summary',
  'batch_get',
  'verify_task_state',
  'programme_snapshot',
  'task_dedupe',
  'lookup_external_key',
  'receipt_lookup',
]);
TOOL_OPERATION_DOCS.vikunja_task_write = taskActions([
  'create',
  'create_if_absent',
  'upsert',
  'update',
  'delete',
]);
TOOL_OPERATION_DOCS.vikunja_task_workflow = taskActions([
  'close',
  'reopen',
  'close_with_evidence',
  'append_evidence_if_changed',
  'close_if_verified',
  'transition_with_evidence',
]);
TOOL_OPERATION_DOCS.vikunja_task_organize = taskActions([
  'assign',
  'unassign',
  'list-assignees',
  'apply-label',
  'remove-label',
  'list-labels',
  'set_status',
  'relate',
  'unrelate',
  'list-relations',
]);
