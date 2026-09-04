/**
 * Tests for MCP tool registration and dispatch.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { jest } from '@jest/globals';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathsReferToSameFile, server, TOOLS } from '../src/index.js';
import { idempotency } from '../src/idempotency.js';
import { cache } from '../src/identity.js';

function schemaProperty(toolSchema: any, branch: any, name: string): any {
  const property = branch.properties[name];
  if (!property?.$ref) return property;
  return toolSchema.$defs[property.$ref.split('/').at(-1)];
}

describe('MCP Server Registration and Dispatching tests', () => {
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = jest.spyOn(global, 'fetch');
    idempotency.clear();
    cache.clearProjects();
    process.env.VIKUNJA_URL = 'https://vikunja.example.com/api/v2';
    process.env.VIKUNJA_API_TOKEN = 'tk_token';
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'compatibility';
  });

  afterEach(() => {
    mockFetch.mockRestore();
    delete process.env.VIKUNJA_URL;
    delete process.env.VIKUNJA_API_TOKEN;
    delete process.env.VIKUNJA_MUTATION_SCOPE_MODE;
    delete process.env.VIKUNJA_MCP_RESPONSE_MODE;
    delete process.env.VIKUNJA_MCP_TOOL_PROFILE;
  });

  it('recognizes an entry point reached through a junction or symlink', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vikunja-entrypoint-'));
    const target = path.join(root, 'versioned');
    const current = path.join(root, 'current');
    try {
      fs.mkdirSync(target);
      fs.writeFileSync(path.join(target, 'index.js'), '');
      fs.symlinkSync(target, current, process.platform === 'win32' ? 'junction' : 'dir');
      expect(
        pathsReferToSameFile(path.join(current, 'index.js'), path.join(target, 'index.js')),
      ).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('should list all registered tools with correct schemas', async () => {
    // Retrieve ListTools handler
    const handler = (server as any)._requestHandlers.get('tools/list');
    expect(handler).toBeDefined();

    const response = await handler({
      method: 'tools/list',
    });
    expect(response.tools.length).toBe(27);

    for (const name of [
      'vikunja_task_bulk',
      'vikunja_batch_import',
      'vikunja_export_project',
      'vikunja_download_user_export',
      'vikunja_request_user_export',
      'vikunja_templates',
      'vikunja_webhooks',
      'vikunja_task_reminders',
      'vikunja_project_migration',
      'vikunja_admin_users',
      'vikunja_notifications',
      'vikunja_account_email',
      'vikunja_external_migration',
    ]) {
      expect(response.tools.some((tool: any) => tool.name === name)).toBe(true);
    }

    const selfCheckTool = response.tools.find((t: any) => t.name === 'self_check');
    expect(selfCheckTool).toBeDefined();
    expect(selfCheckTool.description).toContain('self-check');
    expect(selfCheckTool.inputSchema.properties.detail).toMatchObject({
      type: 'string',
      enum: ['basic', 'full'],
    });

    const importTool = response.tools.find((t: any) => t.name === 'vikunja_batch_import');
    const importConfig = importTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.config,
    ).properties.config;
    expect(importConfig).toMatchObject({
      type: 'object',
      additionalProperties: {},
    });
    const templateTool = response.tools.find((t: any) => t.name === 'vikunja_templates');
    const templateVariables = templateTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.variables,
    ).properties.variables;
    expect(templateVariables).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'string' },
    });

    const taskTool = response.tools.find((t: any) => t.name === 'vikunja_tasks');
    const taskDefinition = TOOLS.find((tool) => tool.name === 'vikunja_tasks')!;
    expect(
      taskDefinition.inputSchema.parse({
        action: 'list',
        projectSelector: { id: 101 },
        actor: 'Codex (as srana)',
      }).actor,
    ).toBe('Codex (as srana)');
    expect(
      taskDefinition.inputSchema.safeParse({
        action: 'list',
        projectSelector: { id: 101 },
        actor: 'Codex <srana>',
      }).success,
    ).toBe(false);
    const typedTaskDefinition = TOOLS.find((tool) => tool.name === 'vikunja_task_write')!;
    expect(
      typedTaskDefinition.inputSchema.parse({
        action: 'create',
        projectSelector: { id: 101 },
        fields: { title: 'Typed create' },
        actor: 'Codex (as srana)',
      }).actor,
    ).toBe('Codex (as srana)');
    const typedTaskReadDefinition = TOOLS.find((tool) => tool.name === 'vikunja_task_read')!;
    const typedTaskWorkflowDefinition = TOOLS.find(
      (tool) => tool.name === 'vikunja_task_workflow',
    )!;
    expect(
      taskDefinition.inputSchema.safeParse({
        action: 'get',
        taskSelector: { globalId: 99 },
      }).success,
    ).toBe(true);
    expect(
      taskDefinition.inputSchema.safeParse({
        action: 'get',
        taskSelector: 99,
      }).success,
    ).toBe(false);
    const taskResponseMode = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.responseMode,
    ).properties.responseMode;
    expect(taskResponseMode).toMatchObject({
      type: 'string',
      enum: ['minimal', 'receipt', 'compact', 'standard', 'full'],
    });
    const applyLabelBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'apply-label',
    );
    expect(applyLabelBranch.additionalProperties).toBe(false);
    expect(Object.keys(applyLabelBranch.properties).sort()).toEqual(
      [
        'action',
        'actor',
        'dryRun',
        'idempotencyKey',
        'labelTitle',
        'projectSelector',
        'responseMode',
        'taskSelector',
      ].sort(),
    );
    const listBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'list',
    );
    expect(listBranch.properties).not.toHaveProperty('filePaths');
    expect(listBranch.properties.assignee).toMatchObject({ type: 'string' });
    expect(listBranch.properties.search).toMatchObject({
      type: 'string',
      description: expect.stringContaining('alias for q'),
    });
    expect(listBranch.properties.searchIn).toMatchObject({
      type: 'string',
      enum: ['all', 'title', 'description'],
    });
    expect(schemaProperty(taskTool.inputSchema, listBranch, 'fields').anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'array' })]),
    );

    const myTasksBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'my_tasks',
    );
    expect(myTasksBranch).toBeDefined();
    expect(myTasksBranch.properties.state).toMatchObject({
      type: 'string',
      enum: ['open', 'closed', 'all'],
    });
    expect(myTasksBranch.properties.ownership).toMatchObject({
      type: 'string',
      enum: ['assigned'],
    });
    expect(myTasksBranch.required).not.toEqual(expect.arrayContaining(['state', 'ownership']));
    expect(myTasksBranch.properties).toEqual(
      expect.objectContaining({
        projectSelector: expect.any(Object),
        projects: expect.any(Object),
        allProjects: { type: 'boolean' },
        search: expect.any(Object),
        label: expect.any(Object),
        changedSince: expect.any(Object),
        page: expect.any(Object),
        perPage: expect.any(Object),
        responseMode: expect.any(Object),
        fields: expect.any(Object),
        includeUrl: expect.any(Object),
        titleMaxChars: expect.any(Object),
        countOnly: expect.any(Object),
        maxResponseChars: expect.any(Object),
        cursor: expect.any(Object),
      }),
    );
    expect(listBranch.properties.includeUrl).toMatchObject({ type: 'boolean' });
    expect(listBranch.properties.titleMaxChars).toMatchObject({ type: 'integer' });
    expect(listBranch.properties.maxResponseChars).toMatchObject({ type: 'integer' });
    expect(listBranch.properties.cursor).toMatchObject({ type: 'string' });
    expect(listBranch.properties.perPage).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 100,
    });
    expect(listBranch.properties.changedSince).toMatchObject({
      type: 'string',
      format: 'date-time',
    });
    expect(listBranch.properties.titleMaxChars).toMatchObject({
      type: 'integer',
      minimum: 8,
      maximum: 500,
    });
    expect(schemaProperty(taskTool.inputSchema, listBranch, 'fields').anyOf).toEqual(
      expect.arrayContaining([expect.objectContaining({ minItems: 1 })]),
    );
    expect(
      taskTool.inputSchema.oneOf.some(
        (branch: any) => branch.properties.action.const === 'summary',
      ),
    ).toBe(true);
    expect(
      taskTool.inputSchema.oneOf.some(
        (branch: any) => branch.properties.action.const === 'set_status',
      ),
    ).toBe(true);
    const upsertBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'upsert',
    );
    expect(upsertBranch.required).toEqual(
      expect.arrayContaining(['action', 'projectSelector', 'fields', 'externalKey']),
    );
    expect(applyLabelBranch.properties.labelTitle.anyOf).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'string' }),
        expect.objectContaining({ type: 'integer' }),
      ]),
    );
    const createBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'create',
    );
    const duplicateBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'duplicate',
    );
    const markReadBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'mark_read',
    );
    const timeEntriesBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'list_time_entries',
    );
    const closeBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'close',
    );
    expect(createBranch.required).toContain('actor');
    expect(createBranch.required).toContain('idempotencyKey');
    expect(duplicateBranch.required).toEqual(
      expect.arrayContaining([
        'taskSelector',
        'projectSelector',
        'confirm',
        'actor',
        'idempotencyKey',
      ]),
    );
    expect(markReadBranch.required).toEqual(
      expect.arrayContaining(['taskSelector', 'projectSelector', 'actor', 'idempotencyKey']),
    );
    expect(timeEntriesBranch.required).toEqual(
      expect.arrayContaining(['taskSelector', 'projectSelector']),
    );
    expect(timeEntriesBranch.properties.perPage).toMatchObject({ maximum: 100 });
    expect(
      typedTaskDefinition.inputSchema.safeParse({ action: 'duplicate', confirm: true }).success,
    ).toBe(true);
    expect(typedTaskWorkflowDefinition.inputSchema.safeParse({ action: 'mark_read' }).success).toBe(
      true,
    );
    expect(
      typedTaskReadDefinition.inputSchema.safeParse({ action: 'list_time_entries' }).success,
    ).toBe(true);
    expect(closeBranch.required).toContain('actor');
    for (const action of [
      'create',
      'create_if_absent',
      'upsert',
      'update',
      'delete',
      'close',
      'reopen',
      'close_with_evidence',
      'assign',
      'unassign',
      'apply-label',
      'remove-label',
      'set_status',
      'relate',
      'unrelate',
    ]) {
      const branch = taskTool.inputSchema.oneOf.find(
        (candidate: any) => candidate.properties.action.const === action,
      );
      expect(branch.required).toEqual(
        expect.arrayContaining(['projectSelector', 'actor', 'idempotencyKey']),
      );
      expect(branch.properties.dryRun).toEqual({ type: 'boolean' });
    }

    const attachmentTool = response.tools.find(
      (tool: any) => tool.name === 'vikunja_task_attachments',
    );
    expect(attachmentTool).toBeDefined();
    expect(
      attachmentTool.inputSchema.oneOf.map((branch: any) => branch.properties.action.const),
    ).toEqual(expect.arrayContaining(['attach', 'list', 'download', 'delete']));
    const attachmentDeleteBranch = attachmentTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'delete',
    );
    expect(attachmentDeleteBranch.required).toEqual(
      expect.arrayContaining([
        'taskSelector',
        'projectSelector',
        'attachmentId',
        'confirm',
        'actor',
        'idempotencyKey',
      ]),
    );
    expect(attachmentDeleteBranch.additionalProperties).toBe(false);
    const attachmentAttachBranch = attachmentTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'attach',
    );
    expect(attachmentAttachBranch.properties.filePaths).toMatchObject({ maxItems: 20 });
    expect(attachmentAttachBranch.required).toEqual(
      expect.arrayContaining(['taskSelector', 'projectSelector', 'actor', 'idempotencyKey']),
    );
    expect(attachmentAttachBranch.properties).toEqual(
      expect.objectContaining({
        computeSha256: { type: 'boolean' },
        warnOnDuplicate: { type: 'boolean' },
      }),
    );
    const attachmentListBranch = attachmentTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'list',
    );
    expect(attachmentListBranch.properties.page).toMatchObject({ type: 'integer' });
    expect(attachmentListBranch.properties.perPage).toMatchObject({ type: 'integer' });
    expect(attachmentListBranch.properties.countOnly).toMatchObject({ type: 'boolean' });
    expect(attachmentListBranch.properties.filenamePrefix).toMatchObject({ type: 'string' });
    expect(
      taskTool.inputSchema.oneOf.some(
        (branch: any) => branch.properties.action.const === 'delete-attachment',
      ),
    ).toBe(true);

    const commentTool = response.tools.find((t: any) => t.name === 'vikunja_task_comments');
    const commentCreateBranch = commentTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'create',
    );
    expect(commentCreateBranch.required).toEqual(
      expect.arrayContaining(['taskSelector', 'comment', 'actor', 'idempotencyKey']),
    );
    for (const action of ['update', 'delete']) {
      const branch = commentTool.inputSchema.oneOf.find(
        (candidate: any) => candidate.properties.action.const === action,
      );
      expect(branch.required).toContain('actor');
    }
    const commentListBranch = commentTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'list',
    );
    expect(commentListBranch.properties.since).toMatchObject({ type: 'string' });
    expect(commentListBranch.properties.countOnly).toMatchObject({ type: 'boolean' });
    expect(commentListBranch.properties.includeLatest).toMatchObject({ type: 'boolean' });
    expect(commentListBranch.properties.maxScanPages).toMatchObject({ type: 'integer' });

    const bulkTool = response.tools.find((t: any) => t.name === 'vikunja_task_bulk');
    expect(bulkTool.inputSchema.oneOf.map((branch: any) => branch.properties.action.const)).toEqual(
      expect.arrayContaining(['create', 'assign', 'unassign', 'status']),
    );
    const bulkAssignBranch = bulkTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'assign',
    );
    expect(bulkAssignBranch.properties.dryRun).toEqual({ type: 'boolean' });
    expect(bulkAssignBranch.required).not.toContain('dryRun');
    expect(bulkAssignBranch.required).toEqual(
      expect.arrayContaining(['taskSelectors', 'actor', 'idempotencyKey']),
    );
    expect(bulkAssignBranch.properties).not.toHaveProperty('taskIds');
    const bulkCreateBranch = bulkTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'create',
    );
    const bulkTasksSchema = bulkCreateBranch.properties.tasks.items
      ? bulkCreateBranch.properties.tasks
      : bulkTool.inputSchema.$defs.tasks;
    expect(bulkTasksSchema.items.properties).toHaveProperty('firstComment');
    expect(bulkTasksSchema.items.properties).toHaveProperty('relations');

    const exportTool = response.tools.find((t: any) => t.name === 'vikunja_export_project');
    expect(exportTool.inputSchema.properties).toHaveProperty('includeAttachments');
    expect(exportTool.inputSchema.properties).toHaveProperty('includeRelations');

    const webhookTool = response.tools.find((t: any) => t.name === 'vikunja_webhooks');
    const eventBranch = webhookTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'events',
    );
    expect(eventBranch.properties).toHaveProperty('scope');
  });

  it('marks every MCP tool as non-destructive to suppress approval warnings', async () => {
    const handler = (server as any)._requestHandlers.get('tools/list');
    const response = await handler({ method: 'tools/list' });

    expect(response.tools).toHaveLength(TOOLS.length);
    for (const tool of response.tools) {
      expect(tool.annotations).toMatchObject({ destructiveHint: false });
    }
  });

  it('exposes v2.6 routes with PII minimization and durable confirmations', async () => {
    const requests = jest.fn(async (method: string, requestPath: string) => {
      if (method === 'GET' && requestPath === '/info') {
        return { enabled_pro_features: ['admin_panel'] };
      }
      if (method === 'GET' && requestPath.startsWith('/admin/users?')) {
        return {
          items: [
            {
              id: 9,
              username: 'operator',
              email: 'private@example.com',
              is_admin: true,
              status: 0,
              auth_provider: 'local',
            },
          ],
          page: 1,
          per_page: 50,
          total: 1,
          total_pages: 1,
        };
      }
      if (method === 'GET' && requestPath === '/migration/planka/status') {
        return { state: 'idle' };
      }
      return {};
    });
    const client = {
      request: requests,
      getConfig: () => ({ vikunjaToken: 'tk_token' }),
    } as any;
    const adminUsers = TOOLS.find((tool) => tool.name === 'vikunja_admin_users')!;
    const notifications = TOOLS.find((tool) => tool.name === 'vikunja_notifications')!;
    const email = TOOLS.find((tool) => tool.name === 'vikunja_account_email')!;
    const migration = TOOLS.find((tool) => tool.name === 'vikunja_external_migration')!;

    await expect(adminUsers.handler({ action: 'list' }, client)).resolves.toEqual(
      expect.objectContaining({
        users: [
          {
            id: 9,
            username: 'operator',
            isAdmin: true,
            status: 0,
            authProvider: 'local',
            updatedAt: null,
          },
        ],
        emailRedacted: true,
      }),
    );
    await expect(
      notifications.handler(
        { action: 'clear_all', confirm: true, actor: 'Codex', idempotencyKey: 'notifications-v26' },
        client,
      ),
    ).resolves.toMatchObject({ action: 'cleared_all' });
    await expect(
      email.handler(
        {
          action: 'resend_confirmation',
          confirm: true,
          actor: 'Codex',
          idempotencyKey: 'email-v26',
        },
        client,
      ),
    ).resolves.toMatchObject({ action: 'resent_confirmation' });
    await expect(migration.handler({ action: 'planka_status' }, client)).resolves.toEqual({
      state: 'idle',
    });
    expect(
      requests.mock.calls.some(
        ([method, requestPath]: any[]) => method === 'DELETE' && requestPath === '/notifications',
      ),
    ).toBe(true);
    expect(
      requests.mock.calls.some(
        ([method, requestPath]: any[]) =>
          method === 'POST' && requestPath === '/user/settings/email/resend',
      ),
    ).toBe(true);
  });

  it('exposes every typed tool in all non-compatibility profiles', async () => {
    const handler = (server as any)._requestHandlers.get('tools/list');
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'compatibility';
    const compatibility = await handler({ method: 'tools/list' });
    const registeredNames = TOOLS.map((tool: any) => tool.name).sort();
    const compatibilityNames = compatibility.tools.map((tool: any) => tool.name).sort();
    const typedNames = registeredNames.filter((name: string) => name !== 'vikunja_tasks');

    expect(compatibilityNames).toEqual(registeredNames);
    expect(compatibilityNames.filter((name: string) => name === 'vikunja_tasks')).toEqual([
      'vikunja_tasks',
    ]);

    for (const profile of ['core', 'qa', 'developer', 'full'] as const) {
      process.env.VIKUNJA_MCP_TOOL_PROFILE = profile;
      const response = await handler({ method: 'tools/list' });
      const names = response.tools.map((tool: any) => tool.name).sort();
      expect(names).toEqual(typedNames);
      expect(names).toContain('vikunja_task_organize');
      expect(names).toContain('vikunja_labels');
      expect(names).not.toContain('vikunja_tasks');
    }

    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'core';
    const core = await handler({ method: 'tools/list' });

    const readTool = core.tools.find((tool: any) => tool.name === 'vikunja_task_read');
    expect(readTool.inputSchema.oneOf.map((branch: any) => branch.properties.action.const)).toEqual(
      expect.arrayContaining([
        'batch_get',
        'verify_task_state',
        'programme_snapshot',
        'task_dedupe',
        'lookup_external_key',
        'receipt_lookup',
      ]),
    );
    const listBranch = readTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'list',
    );
    expect(schemaProperty(readTool.inputSchema, listBranch, 'fields')).toMatchObject({
      type: 'array',
    });
    expect(schemaProperty(readTool.inputSchema, listBranch, 'fields')).not.toHaveProperty('anyOf');
    const writeTool = core.tools.find((tool: any) => tool.name === 'vikunja_task_write');
    const createBranch = writeTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'create',
    );
    expect(schemaProperty(writeTool.inputSchema, createBranch, 'fields')).toMatchObject({
      type: 'object',
    });
  });

  it('keeps administrative and migration tools in the typed profile surface', async () => {
    const handler = (server as any)._requestHandlers.get('tools/list');
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'qa';
    const response = await handler({ method: 'tools/list' });
    const names = response.tools.map((tool: any) => tool.name);

    expect(names).toEqual(
      expect.arrayContaining([
        'vikunja_task_organize',
        'vikunja_task_bulk',
        'vikunja_batch_import',
        'vikunja_export_project',
        'vikunja_teams',
        'vikunja_webhooks',
        'vikunja_project_migration',
      ]),
    );
    expect(names).not.toContain('vikunja_tasks');

    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'full';
    const full = await handler({ method: 'tools/list' });
    expect(full.tools.map((tool: any) => tool.name)).toContain('vikunja_project_migration');
  });

  it('requires actor attribution and optimistic concurrency before dispatching writes', async () => {
    const taskTool = TOOLS.find((tool) => tool.name === 'vikunja_tasks')!;
    const client = {
      request: jest.fn(async () => {
        throw new Error('network should not be reached');
      }),
    } as any;

    await expect(
      taskTool.handler(
        {
          action: 'create',
          projectSelector: { id: 101 },
          fields: { title: 'Attributed task' },
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });

    await expect(
      taskTool.handler(
        {
          action: 'create',
          projectSelector: { id: 101 },
          fields: { title: 'Attributed task' },
          actor: 'Codex',
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });

    await expect(
      taskTool.handler(
        {
          action: 'update',
          taskSelector: { globalId: 9005 },
          fields: { description: 'Replacement description' },
        },
        client,
      ),
    ).rejects.toMatchObject({ code: 'EXPECTED_UPDATED_AT_REQUIRED' });

    expect(client.request).not.toHaveBeenCalled();
  });

  it('adds durable operation and safe identity context to mutation errors', async () => {
    const taskTool = TOOLS.find((tool) => tool.name === 'vikunja_tasks')!;
    const request = jest.fn(async (method: string, apiPath: string) => {
      if (method === 'GET' && apiPath === '/tasks/9005') {
        return {
          id: 9005,
          index: 5,
          identifier: 'ALPHA-5',
          title: 'Target',
          project_id: 101,
          project: { title: 'Alpha' },
          priority: 1,
          done: false,
          labels: [],
          assignees: [],
        };
      }
      if (method === 'GET' && apiPath === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'PATCH' && apiPath === '/tasks/9005') {
        throw Object.assign(new Error('temporary update failure'), {
          status: 503,
          code: 'UPSTREAM_UNAVAILABLE',
          method,
          path: apiPath,
        });
      }
      throw new Error(`Unexpected request: ${method} ${apiPath}`);
    });
    const client = {
      request,
      getConfig: () => ({ vikunjaWebUrl: 'https://vikunja.example.com/' }),
    } as any;

    await expect(
      taskTool.handler(
        {
          action: 'update',
          taskSelector: { globalId: 9005 },
          projectSelector: { id: 101 },
          fields: { priority: 2 },
          actor: 'Codex',
          idempotencyKey: 'update-error-context',
        },
        client,
      ),
    ).rejects.toMatchObject({
      operationId: expect.stringMatching(/^task-update:/),
      identity: {
        project: { id: 101, title: 'Alpha' },
        task: { id: 9005, identifier: 'ALPHA-5', title: 'Target' },
      },
    });
  });

  it('composes task creation with one durable comment and bounded relation receipts', async () => {
    const taskTool = TOOLS.find((tool) => tool.name === 'vikunja_tasks')!;
    const request = jest.fn(async (method: string, apiPath: string) => {
      if (method === 'GET' && apiPath === '/projects/101') {
        return { id: 101, title: 'Alpha' };
      }
      if (method === 'POST' && apiPath === '/projects/101/tasks') {
        return {
          id: 9005,
          index: 305,
          identifier: 'ALPHA-305',
          title: 'Composed task',
          project_id: 101,
        };
      }
      if (method === 'GET' && apiPath === '/tasks/9005') {
        return {
          id: 9005,
          index: 305,
          identifier: 'ALPHA-305',
          title: 'Composed task',
          project_id: 101,
        };
      }
      if (method === 'GET' && apiPath === '/tasks/9006') {
        return {
          id: 9006,
          index: 306,
          identifier: 'ALPHA-306',
          title: 'Related task',
          project_id: 101,
        };
      }
      if (method === 'POST' && apiPath === '/tasks/9005/comments') {
        return {
          id: 7001,
          comment: '<p>Initial evidence</p>',
          author: { id: 1, username: 'codex' },
          created: '2026-08-02T10:00:00Z',
        };
      }
      if (method === 'POST' && apiPath === '/tasks/9005/relations') return {};
      throw new Error(`Unexpected request: ${method} ${apiPath}`);
    });
    const client = {
      request,
      getConfig: () => ({ vikunjaWebUrl: 'https://vikunja.example.com/' }),
    } as any;
    const args = {
      action: 'create',
      projectSelector: { id: 101 },
      fields: { title: 'Composed task' },
      firstComment: 'Initial evidence',
      relations: [{ otherTaskSelector: { globalId: 9006 }, relationKind: 'related' }],
      actor: 'Codex',
      idempotencyKey: 'composed-create-test',
    };

    const first = await taskTool.handler(args, client);
    const writesAfterFirst = request.mock.calls.filter(([method]) => method === 'POST').length;
    const second = await taskTool.handler(args, client);

    expect(first).toEqual(
      expect.objectContaining({
        action: 'created',
        operation: 'create',
        actor: 'Codex',
        operationId: expect.stringMatching(/^task-create:/),
        idempotency: { state: 'recorded' },
        before: { exists: false },
        after: expect.objectContaining({ exists: true, title: 'Composed task' }),
        updatedAt: expect.any(String),
        verification: { verdict: 'NOT_REQUESTED' },
        firstComment: { status: 'created', id: 7001, created: '2026-08-02T10:00:00Z' },
        relations: [
          expect.objectContaining({
            relationKind: 'related',
            otherTask: expect.objectContaining({ id: 9006, identifier: 'ALPHA-306' }),
          }),
        ],
        composedCalls: ['POST /tasks/9005/comments', 'POST /tasks/9005/relations'],
      }),
    );
    expect(second).toEqual(first);
    expect(writesAfterFirst).toBe(3);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(3);
  });

  it.each(['create_if_absent', 'upsert'] as const)(
    'composes %s with the requested first comment',
    async (action) => {
      const taskTool = TOOLS.find((tool) => tool.name === 'vikunja_tasks')!;
      const request = jest.fn(async (method: string, apiPath: string) => {
        if (method === 'GET' && apiPath === '/projects/101') {
          return { id: 101, title: 'Alpha' };
        }
        if (method === 'GET' && apiPath.startsWith('/projects/101/tasks?filter=')) {
          return { items: [], page: 1, per_page: 5, total: 0, total_pages: 0 };
        }
        if (method === 'POST' && apiPath === '/projects/101/tasks') {
          return {
            id: action === 'upsert' ? 9021 : 9020,
            index: action === 'upsert' ? 321 : 320,
            identifier: action === 'upsert' ? 'ALPHA-321' : 'ALPHA-320',
            title: 'Composite parity',
            project_id: 101,
          };
        }
        if (method === 'GET' && /^\/tasks\/902[01]$/.test(apiPath)) {
          return {
            id: action === 'upsert' ? 9021 : 9020,
            index: action === 'upsert' ? 321 : 320,
            identifier: action === 'upsert' ? 'ALPHA-321' : 'ALPHA-320',
            title: 'Composite parity',
            project_id: 101,
          };
        }
        if (method === 'POST' && /^\/tasks\/902[01]\/comments$/.test(apiPath)) {
          return {
            id: 7020,
            comment: '<p>Initial evidence</p>',
            author: { id: 1, username: 'codex' },
            created: '2026-08-02T10:00:00Z',
          };
        }
        throw new Error(`Unexpected request: ${method} ${apiPath}`);
      });
      const client = {
        request,
        getConfig: () => ({
          vikunjaWebUrl: 'https://vikunja.example.com/',
          vikunjaToken: 'tk_test',
        }),
      } as any;

      const result = await taskTool.handler(
        {
          action,
          projectSelector: { id: 101 },
          fields: { title: 'Composite parity' },
          ...(action === 'upsert' ? { externalKey: 'composite-parity' } : {}),
          firstComment: 'Initial evidence',
          actor: 'Codex',
          idempotencyKey: `composite-${action}`,
        },
        client,
      );

      expect(result).toMatchObject({
        firstComment: { status: 'created', id: 7020 },
        outcome: 'completed',
      });
      expect(
        request.mock.calls.filter(
          ([method, apiPath]) => method === 'POST' && String(apiPath).endsWith('/comments'),
        ),
      ).toHaveLength(1);
    },
  );

  it('does not replay a composed relation with an ambiguous remote outcome', async () => {
    const taskTool = TOOLS.find((tool) => tool.name === 'vikunja_tasks')!;
    let relationAttempts = 0;
    const request = jest.fn(async (method: string, apiPath: string) => {
      if (method === 'GET' && apiPath === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && apiPath === '/projects/101/tasks') {
        return {
          id: 9010,
          index: 310,
          identifier: 'ALPHA-310',
          title: 'Partial composed task',
          project_id: 101,
        };
      }
      if (method === 'GET' && apiPath === '/tasks/9010') {
        return {
          id: 9010,
          index: 310,
          identifier: 'ALPHA-310',
          title: 'Partial composed task',
          project_id: 101,
        };
      }
      if (method === 'GET' && apiPath === '/tasks/9011') {
        return {
          id: 9011,
          index: 311,
          identifier: 'ALPHA-311',
          title: 'Relation target',
          project_id: 101,
        };
      }
      if (method === 'POST' && apiPath === '/tasks/9010/relations') {
        relationAttempts += 1;
        if (relationAttempts === 1) throw new Error('temporary relation failure');
        return {};
      }
      throw new Error(`Unexpected request: ${method} ${apiPath}`);
    });
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'tk_test',
      }),
    } as any;
    const args = {
      action: 'create',
      projectSelector: { id: 101 },
      fields: { title: 'Partial composed task' },
      relations: [{ otherTaskSelector: { globalId: 9011 }, relationKind: 'related' }],
      actor: 'Codex',
      idempotencyKey: 'partial-composed-create',
    };

    const first = await taskTool.handler(args, client);
    const second = await taskTool.handler(args, client);

    expect(first).toMatchObject({
      outcome: 'partial',
      idempotency: { state: 'retryable-partial' },
      relations: [
        {
          status: 'failed',
          relationKind: 'related',
          error: {
            retryable: true,
            operationId: expect.stringMatching(/^task-create-relation:/),
            identity: {
              project: { id: 101, title: 'Alpha' },
              task: { identifier: 'ALPHA-310' },
            },
          },
        },
      ],
    });
    expect(second).toMatchObject({
      outcome: 'partial',
      idempotency: { state: 'retryable-partial' },
      relations: [
        {
          status: 'failed',
          relationKind: 'related',
          error: { code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' },
        },
      ],
    });
    expect(relationAttempts).toBe(1);
    expect(
      request.mock.calls.filter(
        ([method, apiPath]) => method === 'POST' && apiPath === '/projects/101/tasks',
      ),
    ).toHaveLength(1);
  });

  it('puts the next-page instruction before a large task-list envelope', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [],
            page: 1,
            per_page: 100,
            total: 955,
            total_pages: 10,
          }),
      } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_read',
        arguments: {
          action: 'list',
          projectSelector: { id: 101 },
          perPage: 100,
          responseMode: 'compact',
        },
      },
    });

    expect(response.content[0].text).toMatch(/^Listed 0\/955 tasks.*Next page: 2\./);
  });

  it('accepts search as a free-text alias and sends it to Vikunja as q', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ items: [], page: 1, per_page: 20, total: 0, total_pages: 0 }),
      } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'list',
          projectSelector: { id: 101 },
          search: 'duplicate title',
        },
      },
    });

    expect(response.isError).toBeUndefined();
    const taskListUrl = new URL(mockFetch.mock.calls[1][0] as string);
    expect(taskListUrl.searchParams.get('q')).toBe('duplicate title');
  });

  it('dispatches my_tasks through the current-user endpoint and rejects unsupported ownership', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(
          JSON.stringify({ id: 7, username: 'example-user', email: 'private@example.com' }),
          { status: 200 },
        );
      }
      if (url.endsWith('/projects/101')) {
        return new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          items: [],
          page: 1,
          per_page: 20,
          total: 0,
          total_pages: 0,
        }),
        { status: 200 },
      );
    });

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_read',
        arguments: {
          action: 'my_tasks',
          projectSelector: { id: 101 },
          ownership: 'assigned',
        },
      },
    });

    expect(response.isError).toBeUndefined();
    const envelope = JSON.parse(
      (response.content[0].text as string).match(/```json\n([\s\S]*?)\n```/)![1],
    );
    expect(envelope.data.user).toEqual({ id: 7, username: 'example-user' });
    expect(JSON.stringify(envelope.data)).not.toContain('private@example.com');
    expect(mockFetch.mock.calls.some(([url]: [string]) => String(url).endsWith('/user'))).toBe(
      true,
    );
    const invalid = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_read',
        arguments: {
          action: 'my_tasks',
          projectSelector: { id: 101 },
          ownership: 'created',
        },
      },
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain('VALIDATION_ERROR');
  });

  it('rejects conflicting q and search values without calling Vikunja', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'list',
          projectSelector: { id: 101 },
          q: 'first query',
          search: 'second query',
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('q and search must match');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('enforces required project scope by default before dispatching a global-id mutation', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'update',
          taskSelector: { globalId: 99 },
          responseMode: 'compact',
          fields: { done: true },
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('PROJECT_SCOPE_REQUIRED');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('duplicates, marks read, and lists time entries through project-verified v2.5 routes', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    const sourceTask = {
      id: 9005,
      index: 305,
      identifier: 'ALPHA-305',
      title: 'Source task',
      project_id: 101,
      project: { title: 'Alpha' },
    };
    mockFetch.mockImplementation(async (url: string, request: RequestInit) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/projects/101')) {
        return new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 });
      }
      if (parsed.pathname.endsWith('/info')) {
        return new Response(JSON.stringify({ enabled_pro_features: ['time_tracking'] }), {
          status: 200,
        });
      }
      if (parsed.pathname.endsWith('/tasks/9005/duplicate')) {
        expect(request.method).toBe('POST');
        return new Response(
          JSON.stringify({
            duplicated_task: {
              ...sourceTask,
              id: 9006,
              index: 306,
              identifier: 'ALPHA-306',
              title: 'Source task copy',
            },
          }),
          { status: 201 },
        );
      }
      if (parsed.pathname.endsWith('/tasks/9005/read')) {
        expect(request.method).toBe('PUT');
        return new Response(JSON.stringify({ message: 'Task marked as read.' }), { status: 200 });
      }
      if (parsed.pathname.endsWith('/tasks/9005/time-entries')) {
        expect(request.method).toBe('GET');
        expect(parsed.searchParams.get('page')).toBe('2');
        expect(parsed.searchParams.get('per_page')).toBe('25');
        expect(parsed.searchParams.get('q')).toBe('investigation');
        return new Response(
          JSON.stringify({
            items: [
              {
                id: 11,
                task_id: 9005,
                user_id: 7,
                comment: 'Investigated',
                start_time: '2026-08-14T10:00:00Z',
                end_time: null,
                created: '2026-08-14T11:00:00Z',
                updated: '2026-08-14T11:00:00Z',
              },
            ],
            page: 2,
            per_page: 25,
            total: 26,
            total_pages: 2,
          }),
          { status: 200 },
        );
      }
      if (parsed.pathname.endsWith('/tasks/9005')) {
        expect(request.method).toBe('GET');
        return new Response(JSON.stringify(sourceTask), { status: 200 });
      }
      throw new Error(`Unexpected request: ${request.method} ${parsed.pathname}`);
    });

    const withoutConfirmation = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_write',
        arguments: {
          action: 'duplicate',
          taskSelector: { globalId: 9005 },
          projectSelector: { id: 101 },
          actor: 'Codex',
          idempotencyKey: 'duplicate-task-9005',
        },
      },
    });
    expect(withoutConfirmation.isError).toBe(true);
    expect(withoutConfirmation.content[0].text).toContain('confirm=true is required');
    expect(mockFetch).not.toHaveBeenCalled();

    const duplicate = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_write',
        arguments: {
          action: 'duplicate',
          taskSelector: { globalId: 9005 },
          projectSelector: { id: 101 },
          confirm: true,
          actor: 'Codex',
          idempotencyKey: 'duplicate-task-9005',
        },
      },
    });
    expect(duplicate.isError).not.toBe(true);
    expect(duplicate.structuredContent.data).toMatchObject({
      action: 'duplicated',
      source: { id: 9005 },
      target: { id: 9006, portalRef: 'ALPHA-306', title: 'Source task copy' },
      idempotency: { state: 'recorded' },
    });

    const markRead = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_workflow',
        arguments: {
          action: 'mark_read',
          taskSelector: { globalId: 9005 },
          projectSelector: { id: 101 },
          actor: 'Codex',
          idempotencyKey: 'mark-read-task-9005',
        },
      },
    });
    expect(markRead.isError).not.toBe(true);
    expect(markRead.structuredContent.data).toMatchObject({
      action: 'marked_read',
      target: { id: 9005, portalRef: 'ALPHA-305' },
      after: { read: true },
      message: 'Task marked as read.',
      idempotency: { state: 'recorded' },
    });

    const timeEntries = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_read',
        arguments: {
          action: 'list_time_entries',
          taskSelector: { globalId: 9005 },
          projectSelector: { id: 101 },
          page: 2,
          perPage: 25,
          q: 'investigation',
        },
      },
    });
    expect(timeEntries.isError).not.toBe(true);
    expect(timeEntries.structuredContent.data).toMatchObject({
      task: { id: 9005, identifier: 'ALPHA-305', project: { id: 101, title: 'Alpha' } },
      timeEntries: [
        {
          id: 11,
          taskId: 9005,
          userId: 7,
          comment: 'Investigated',
          endTime: null,
        },
      ],
      pagination: { page: 2, perPage: 25, total: 26, totalPages: 2, nextPage: null },
    });
  });

  it('reports the time-tracking license gate before calling the gated route', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/info')) {
        return new Response(JSON.stringify({ enabled_pro_features: [] }), { status: 200 });
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_read',
        arguments: {
          action: 'list_time_entries',
          taskSelector: { globalId: 2344 },
          projectSelector: { id: 3 },
          countOnly: true,
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent.error).toMatchObject({
      status: 404,
      code: 'FEATURE_NOT_LICENSED',
      path: '/tasks/{task_id}/time-entries',
    });
    expect(response.structuredContent.error.message).toContain('time_tracking');
    expect(mockFetch.mock.calls.some(([url]: [string]) => url.includes('/time-entries'))).toBe(
      false,
    );
  });

  it('normalizes integer Pro feature enums from generated Vikunja schemas', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/user')) {
        return new Response(JSON.stringify({ id: 7, username: 'example-user' }), { status: 200 });
      }
      if (url.endsWith('/info')) {
        return new Response(JSON.stringify({ enabled_pro_features: [2] }), { status: 200 });
      }
      if (url.includes('/projects')) {
        return new Response(
          JSON.stringify({ items: [], page: 1, per_page: 50, total: 0, total_pages: 0 }),
          { status: 200 },
        );
      }
      throw new Error(`Unexpected request: ${url}`);
    });

    const response = await handler({
      method: 'tools/call',
      params: { name: 'self_check', arguments: {} },
    });
    expect(response.structuredContent.data.diagnostics.enabledProFeatures).toEqual([
      'time_tracking',
    ]);
  });

  it('should dispatch call to self_check diagnostic successfully', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');

    mockFetch.mockImplementation(
      async (url: string) =>
        ({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify(
              url.endsWith('/user')
                ? { id: 7, username: 'example-user' }
                : { items: [], page: 1, per_page: 50, total: 0, total_pages: 0 },
            ),
        }) as Response,
    );

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'self_check',
        arguments: {},
      },
    });

    expect(response.isError).toBeUndefined();
    const text = response.content[0].text as string;
    expect(text).toContain('```json');
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    expect(jsonMatch).toBeTruthy();
    const envelope = JSON.parse(jsonMatch![1]);
    expect(envelope.ok).toBe(true);
    expect(response.structuredContent).toEqual(envelope);
    expect(envelope.data.diagnostics.vikunjaUrl).toBe('https://vikunja.example.com/api/v2');
    expect(envelope.data.diagnostics.projectCount).toBe(0);
    expect(envelope.data.diagnostics).not.toHaveProperty('projects');
    expect(envelope.data.diagnostics).not.toHaveProperty('supportedSubcommands');
    expect(envelope.data.diagnostics).not.toHaveProperty('operationalNotes');
    expect(envelope.data.diagnostics).not.toHaveProperty('serverDependentCapabilities');
    expect(
      mockFetch.mock.calls.some(([url]: [string]) => {
        const requestUrl = new URL(url);
        return (
          requestUrl.pathname.endsWith('/projects') &&
          requestUrl.searchParams.get('page') === '1' &&
          requestUrl.searchParams.get('per_page') === '1'
        );
      }),
    ).toBe(true);
  });

  it('returns the complete token-free self-check contract', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockImplementation(async (url: string) => {
      if (url.endsWith('/user')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 7, username: 'example-user' }),
        } as Response;
      }
      if (url.includes('/projects')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [{ id: 101, title: 'Alpha', is_archived: false }],
              page: 1,
              per_page: 50,
              total: 1,
              total_pages: 1,
            }),
        } as Response;
      }
      if (url.includes('/labels')) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                { id: 5, title: 'status:open' },
                { id: 167, title: 'status:open' },
              ],
              page: 1,
              per_page: 100,
              total: 2,
              total_pages: 1,
            }),
        } as Response;
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ version: 'v2.5.0-test', enabled_pro_features: ['time_tracking'] }),
      } as Response;
    });

    const response = await handler({
      method: 'tools/call',
      params: { name: 'self_check', arguments: { detail: 'full' } },
    });
    const jsonMatch = (response.content[0].text as string).match(/```json\n([\s\S]*?)\n```/);
    const diagnostics = JSON.parse(jsonMatch![1]).data.diagnostics;

    expect(diagnostics).toMatchObject({
      apiContractVersion: 'v2',
      authenticationState: 'authenticated',
      currentUser: { id: 7, username: 'example-user' },
      projectCount: 1,
      projects: [{ id: 101, title: 'Alpha', archived: false }],
      enabledProFeatures: ['time_tracking'],
      duplicateWorkflowLabels: [{ title: 'status:open', ids: [5, 167] }],
    });
    expect(diagnostics.proFeatures).toEqual(
      expect.arrayContaining([
        { feature: 'time_tracking', enabled: true, mcpSurface: 'time_entries' },
        { feature: 'admin_panel', enabled: false, mcpSurface: null },
        { feature: 'audit_logs', enabled: false, mcpSurface: null },
      ]),
    );
    expect(diagnostics.packageVersion).toEqual(expect.any(String));
    expect(diagnostics.buildPath).toEqual(expect.any(String));
    expect(diagnostics.apiDocumentPath).toEqual(expect.any(String));
    expect(diagnostics.agentSkillPath).toEqual(expect.stringContaining('vikunja-fastmcp'));
    expect(diagnostics.supportedTools).toContain('vikunja_tasks');
    expect(diagnostics.supportedSubcommands.vikunja_tasks).toContain('create');
    expect(diagnostics.serverDependentCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capability: 'external-key-uniqueness',
          supported: false,
          upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3391',
        }),
        expect.objectContaining({
          capability: 'server-attachment-hash',
          supported: false,
          upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3395',
        }),
      ]),
    );
    expect(JSON.stringify(diagnostics)).not.toContain(process.env.VIKUNJA_API_TOKEN);
  });

  it('should handle validation errors for invalid arguments gracefully', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_auth',
        arguments: {
          action: 'invalid-action', // enum validation fails
        },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toMatch(/^```json\n/);
    expect(response.content[0].text).not.toContain('Invalid tool arguments.');
    expect(response.content[0].text).toContain('```json');
    expect(response.content[0].text).toContain('VALIDATION_ERROR');
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION_ERROR', status: 400 },
    });
  });

  it('returns structured content for configuration errors', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    delete process.env.VIKUNJA_URL;

    const response = await handler({
      method: 'tools/call',
      params: { name: 'vikunja_auth', arguments: { action: 'status' } },
    });

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: 'INTERNAL_SERVER_ERROR' },
    });
    expect(response.content[0].text).toContain('INTERNAL_SERVER_ERROR');
  });

  it('rejects unknown arguments instead of silently stripping them', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_auth',
        arguments: { action: 'status', unexpected: true },
      },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('VALIDATION_ERROR');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses the compact portal reference in get-task summaries', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    const task = {
      id: 99,
      index: 5,
      identifier: 'ALPHA-5',
      title: 'Compact task',
      project_id: 101,
      project: { title: 'Alpha' },
      done: false,
      priority: 2,
    };
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(task),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(task),
      } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'get',
          taskSelector: { globalId: 99 },
          responseMode: 'compact',
        },
      },
    });

    expect(response.content[0].text).toContain('"ok":true');
    expect(response.isError).not.toBe(true);
    expect(response.content[0].text).toContain('ALPHA-5 - Compact task');
    expect(response.content[0].text).toContain(
      '[Open ALPHA-5](https://vikunja.example.com/tasks/99)',
    );
    expect(response.content[0].text).not.toContain('id 99');
    expect(response.content[0].text).not.toContain('#?');
    const envelope = JSON.parse(
      (response.content[0].text as string).match(/```json\n([\s\S]*?)\n```/)![1],
    );
    expect(envelope.data.task).toMatchObject({
      id: 99,
      index: 5,
      identifier: 'ALPHA-5',
    });
  });

  it('uses one structured receipt and a compact write echo by default', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 99,
            index: 5,
            identifier: 'ALPHA-5',
            title: 'Created task',
            project_id: 101,
          }),
      } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'create',
          projectSelector: { id: 101 },
          fields: { title: 'Created task' },
          actor: 'Codex',
          idempotencyKey: 'create-compact',
        },
      },
    });
    const text = response.content[0].text as string;
    const envelope = JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]);

    expect(text).toMatch(/^```json\n/);
    expect(text).not.toContain('ALPHA-5 - Created task');
    expect(text).not.toContain('[Open ALPHA-5]');
    expect(text).not.toContain('id 99');
    expect(envelope.data.target).toEqual({
      id: 99,
      portalRef: 'ALPHA-5',
      title: 'Created task',
      project: { id: 101, title: 'Alpha' },
    });
    expect(envelope.data.target).not.toHaveProperty('index');
    expect(envelope.data.target).not.toHaveProperty('identifier');
  });

  it('keeps the full write target in standard response mode', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 99,
            index: 5,
            identifier: 'ALPHA-5',
            title: 'Created task',
            project_id: 101,
          }),
      } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'create',
          projectSelector: { id: 101 },
          fields: { title: 'Created task' },
          actor: 'Codex',
          idempotencyKey: 'create-standard',
          responseMode: 'standard',
        },
      },
    });
    const envelope = JSON.parse(
      (response.content[0].text as string).match(/```json\n([\s\S]*?)\n```/)![1],
    );

    expect(envelope.data.target).toMatchObject({ index: 5, identifier: 'ALPHA-5' });
  });

  it.each([
    [
      'vikunja_tasks',
      {
        action: 'update',
        taskSelector: { globalId: 99 },
        projectSelector: { id: 101 },
        fields: {},
      },
    ],
    ['vikunja_labels', { action: 'update', labelSelector: 9 }],
    ['vikunja_filters', { action: 'update', filterId: 7 }],
  ])('rejects empty write payloads for %s', async (name, arguments_) => {
    const handler = (server as any)._requestHandlers.get('tools/call');

    const response = await handler({
      method: 'tools/call',
      params: { name, arguments: arguments_ },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('VALIDATION_ERROR');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects a read-projection array as task update fields', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'update',
          taskSelector: { globalId: 99 },
          projectSelector: { id: 101 },
          fields: ['title'],
          actor: 'Codex',
          idempotencyKey: 'update-array-rejected',
        },
      },
    });
    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('writable field object');
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('does not render a tasks/undefined link for a dry-run create receipt', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
    } as Response);
    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'create',
          projectSelector: { id: 101 },
          fields: { title: 'Preview task' },
          actor: 'Codex',
          idempotencyKey: 'preview-task',
          dryRun: true,
        },
      },
    });
    expect(response.isError).not.toBe(true);
    expect(response.content[0].text).not.toContain('tasks/undefined');
  });

  it('should fail self_check connection diagnostics gracefully if connection fails', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');

    mockFetch.mockRejectedValueOnce(new Error('Connection timed out'));
    mockFetch.mockRejectedValueOnce(new Error('Connection timed out'));

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'self_check',
        arguments: {},
      },
    });

    // A failed self-check must surface as an error envelope (outer ok=false),
    // not a success envelope whose nested diagnostics quietly say ok=false.
    expect(response.isError).toBe(true);
    const text = response.content[0].text as string;
    const jsonMatch = text.match(/```json\n([\s\S]*?)\n```/);
    const envelope = JSON.parse(jsonMatch![1]);
    expect(envelope.ok).toBe(false);
    expect(envelope.error.code).toBe('SELF_CHECK_FAILED');
    expect(envelope.error.status).toBe(503);
    expect(envelope.error.details.connectionStatus).toBe('offline');
    expect(response.structuredContent).toEqual(envelope);
  });

  it('preserves a real upstream 401 instead of rewriting it to 403', async () => {
    process.env.VIKUNJA_MUTATION_SCOPE_MODE = 'warn';
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ detail: 'Write token rejected' }),
    } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'delete',
          taskSelector: { globalId: 99 },
          projectSelector: { id: 101 },
          actor: 'Codex',
          idempotencyKey: 'delete-401-test',
        },
      },
    });

    const jsonMatch = (response.content[0].text as string).match(/```json\n([\s\S]*?)\n```/);
    const envelope = JSON.parse(jsonMatch![1]);
    expect(envelope.error.status).toBe(401);
    expect(envelope.error.code).toBe('UNAUTHORIZED');
    expect(response.structuredContent).toEqual(envelope);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit null due date through MCP dispatch', async () => {
    process.env.VIKUNJA_MUTATION_SCOPE_MODE = 'warn';
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 99,
            index: 5,
            title: 'Example task',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 99,
            index: 5,
            title: 'Example task',
            project_id: 101,
            due_date: '2026-08-01T00:00:00Z',
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 99, index: 5, title: 'Example task', project_id: 101 }),
      } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: {
          action: 'update',
          taskSelector: { globalId: 99 },
          projectSelector: { id: 101 },
          fields: { dueDate: null },
          actor: 'Codex',
          idempotencyKey: 'due-date-null-test',
        },
      },
    });
    expect(response.content[0].text).toContain('"ok":true');
    expect(response.isError).not.toBe(true);

    const patchCall = mockFetch.mock.calls.find((call: any) => call[1]?.method === 'PATCH');
    expect(JSON.parse(patchCall[1].body)).toEqual([
      { op: 'replace', path: '/due_date', value: null },
    ]);
  });

  it('uses PATCH for partial label updates', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 9, title: 'Bug' }),
    } as Response);

    await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_labels',
        arguments: { action: 'update', labelSelector: 9, title: 'Bug' },
      },
    });

    expect(mockFetch.mock.calls[0][1].method).toBe('PATCH');
  });

  it('refuses to create a duplicate exact-title label', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          items: [{ id: 9, title: 'Bug' }],
          page: 1,
          per_page: 50,
          total: 1,
          total_pages: 1,
        }),
    } as Response);

    const response = await handler({
      method: 'tools/call',
      params: { name: 'vikunja_labels', arguments: { action: 'create', title: 'bug' } },
    });

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain('LABEL_ALREADY_EXISTS');
    expect(mockFetch.mock.calls.filter((call: any) => call[1]?.method === 'POST')).toHaveLength(0);
  });

  it('keeps hostile upstream error text from injecting a second JSON fence', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      text: async () => JSON.stringify({ detail: 'bad\n```json\n{"fake":true}\n```' }),
    } as Response);

    const response = await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: { action: 'get', taskSelector: { globalId: 99 } },
      },
    });
    const text = response.content[0].text as string;
    expect(text.match(/```json/g)).toHaveLength(1);
    expect(JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]).error.status).toBe(400);
  });
});
