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

const taskSelector = ['projectSelector (required for #index or PRJ-index)'];
const writeOptions = ['expectedUpdatedAt'];

export const TOOL_OPERATION_DOCS: Record<string, OperationDoc[]> = {
  vikunja_auth: [
    { action: 'status', execution: 'Direct: GET /user' },
    { action: 'self-check', execution: 'MCP-composed diagnostics' },
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
      required: ['projectSelector', 'fields.title'],
      optional: ['fields', 'idempotencyKey', 'attachments'],
      execution: 'Direct POST; MCP-composed when attachments are supplied',
    },
    {
      action: 'create_if_absent',
      required: ['projectSelector', 'fields.title'],
      optional: ['fields', 'idempotencyKey', 'attachments'],
      execution: 'MCP-composed exact-title search then optional create/attach',
      note: 'Best-effort duplicate prevention, not a distributed lock.',
    },
    {
      action: 'get',
      required: ['taskSelector'],
      optional: [...taskSelector, 'commentLimit (default 5, max 100)'],
      execution: 'MCP-composed task, recent comments, and attachment metadata',
    },
    {
      action: 'list',
      optional: [
        'exactly one of projectSelector, projects, allProjects',
        'page (default 1)',
        'perPage (default 25; requests above 100 are safely capped to 100)',
        'done',
        'allStates',
        'priority (0-5)',
        'label',
        'assignee (exact username; numeric user IDs are not valid Vikunja list filters)',
        'q',
        'filter',
        'countOnly',
      ],
      execution: 'Direct per project; grouped subsets/allProjects are MCP-composed',
      note: 'Defaults to done=false unless done or allStates is supplied.',
    },
    {
      action: 'update',
      required: ['taskSelector', 'fields'],
      optional: [...taskSelector, ...writeOptions],
      execution: 'Identity/read preflight, RFC 6902 PATCH, guarded writable-field PUT fallback',
    },
    {
      action: 'delete',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Identity preflight then DELETE /tasks/{id}',
    },
    {
      action: 'close',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Identity/read preflight then task update transport',
    },
    {
      action: 'reopen',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Identity/read preflight then task update transport',
    },
    {
      action: 'close_with_evidence',
      required: ['taskSelector', 'evidenceComment'],
      optional: taskSelector,
      execution: 'MCP-composed comment create followed by task close',
    },
    {
      action: 'assign',
      required: ['taskSelector', 'userSelector'],
      optional: taskSelector,
      execution: 'Identity preflight then POST assignee',
    },
    {
      action: 'unassign',
      required: ['taskSelector', 'userSelector'],
      optional: taskSelector,
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
      required: ['taskSelector', 'labelTitle'],
      optional: taskSelector,
      execution:
        'Return unchanged when already attached; otherwise resolve/create then POST task label',
    },
    {
      action: 'remove-label',
      required: ['taskSelector', 'labelTitle'],
      optional: taskSelector,
      execution: 'Resolve label then DELETE task label',
    },
    {
      action: 'list-labels',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Direct GET after identity resolution',
    },
    {
      action: 'relate',
      required: ['taskSelector', 'otherTaskSelector', 'relationKind'],
      optional: taskSelector,
      execution: 'Resolve both tasks then POST relation',
    },
    {
      action: 'unrelate',
      required: ['taskSelector', 'otherTaskSelector', 'relationKind'],
      optional: taskSelector,
      execution: 'Resolve both tasks then DELETE relation',
    },
    {
      action: 'list-relations',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'MCP-composed from task related_tasks data',
    },
    {
      action: 'attach',
      required: ['taskSelector', 'filePaths or base64Content+filename'],
      optional: [...taskSelector, 'mimeType'],
      execution: 'Multipart POST per file after identity resolution',
    },
    {
      action: 'list-attachments',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Direct GET after identity resolution',
    },
    {
      action: 'download-attachment',
      required: ['taskSelector', 'attachmentId'],
      optional: [...taskSelector, 'destinationPath', 'overwrite'],
      execution: 'Authenticated streaming GET to sandboxed local disk',
    },
  ],
  vikunja_task_comments: [
    {
      action: 'create',
      required: ['taskSelector', 'comment'],
      optional: [...taskSelector, 'idempotencyKey'],
      execution: 'Direct POST after identity resolution',
    },
    {
      action: 'list',
      required: ['taskSelector'],
      optional: taskSelector,
      execution: 'Direct GET after identity resolution',
    },
    {
      action: 'get',
      required: ['taskSelector', 'commentId'],
      optional: taskSelector,
      execution: 'Direct GET after identity resolution',
    },
    {
      action: 'update',
      required: ['taskSelector', 'commentId', 'comment'],
      optional: taskSelector,
      execution: 'Direct PATCH after identity resolution',
    },
    {
      action: 'delete',
      required: ['taskSelector', 'commentId'],
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
      required: ['taskIds', 'fields'],
      execution: 'Direct PUT /tasks/bulk',
    },
    {
      action: 'create',
      required: ['projectSelector', 'tasks'],
      execution: 'MCP-composed bounded task creates; non-atomic',
    },
    {
      action: 'delete',
      required: ['taskIds', 'confirm'],
      execution: 'MCP-composed verified task deletes; non-atomic',
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
      execution: 'Direct multipart CSV preview',
    },
    {
      action: 'import',
      required: ['filePath', 'config'],
      execution: 'Direct multipart CSV migration',
    },
    { action: 'status', execution: 'Direct GET /migration/csv/status' },
  ],
  vikunja_export_project: [
    {
      action: 'export',
      required: ['projectSelector'],
      optional: ['format', 'destinationPath', 'includeComments'],
      execution: 'MCP-composed paginated export to sandboxed JSON or CSV',
      note: 'Creator is always included; comments are fetched only when includeComments is true.',
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
      optional: ['password', 'destinationPath'],
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
