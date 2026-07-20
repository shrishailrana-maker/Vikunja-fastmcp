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
import { pathsReferToSameFile, server } from '../src/index.js';

describe('MCP Server Registration and Dispatching tests', () => {
  let mockFetch: any;

  beforeEach(() => {
    mockFetch = jest.spyOn(global, 'fetch');
    process.env.VIKUNJA_URL = 'https://vikunja.example.com/api/v2';
    process.env.VIKUNJA_API_TOKEN = 'tk_token';
  });

  afterEach(() => {
    mockFetch.mockRestore();
    delete process.env.VIKUNJA_URL;
    delete process.env.VIKUNJA_API_TOKEN;
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
    expect(response.tools.length).toBe(17);

    for (const name of [
      'vikunja_task_bulk',
      'vikunja_batch_import',
      'vikunja_export_project',
      'vikunja_download_user_export',
      'vikunja_request_user_export',
      'vikunja_templates',
      'vikunja_webhooks',
      'vikunja_task_reminders',
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
    expect(importTool.inputSchema.properties.config).toMatchObject({
      type: 'object',
      additionalProperties: {},
    });
    const templateTool = response.tools.find((t: any) => t.name === 'vikunja_templates');
    expect(templateTool.inputSchema.properties.variables).toMatchObject({
      type: 'object',
      additionalProperties: { type: 'string' },
    });

    const taskTool = response.tools.find((t: any) => t.name === 'vikunja_tasks');
    expect(taskTool.inputSchema.properties.responseMode).toMatchObject({
      type: 'string',
      enum: ['compact', 'standard', 'full'],
    });
    const applyLabelBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'apply-label',
    );
    expect(applyLabelBranch.additionalProperties).toBe(false);
    expect(Object.keys(applyLabelBranch.properties).sort()).toEqual(
      ['action', 'labelTitle', 'projectSelector', 'taskSelector'].sort(),
    );
    const listBranch = taskTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'list',
    );
    expect(listBranch.properties).not.toHaveProperty('filePaths');
    expect(listBranch.properties.assignee).toMatchObject({ type: 'string' });

    const webhookTool = response.tools.find((t: any) => t.name === 'vikunja_webhooks');
    const eventBranch = webhookTool.inputSchema.oneOf.find(
      (branch: any) => branch.properties.action.const === 'events',
    );
    expect(eventBranch.properties).toHaveProperty('scope');
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
        name: 'vikunja_tasks',
        arguments: { action: 'list', projectSelector: { id: 101 }, perPage: 1000 },
      },
    });

    expect(response.content[0].text).toMatch(/^Listed 0\/955 tasks.*Next page: 2\./);
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
    expect(envelope.data.diagnostics.vikunjaUrl).toBe('https://vikunja.example.com/api/v2');
    expect(envelope.data.diagnostics.projectCount).toBe(0);
    expect(envelope.data.diagnostics).not.toHaveProperty('projects');
    expect(envelope.data.diagnostics).not.toHaveProperty('supportedSubcommands');
    expect(envelope.data.diagnostics).not.toHaveProperty('operationalNotes');
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
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ version: 'v2.3.0-test' }),
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
    });
    expect(diagnostics.packageVersion).toEqual(expect.any(String));
    expect(diagnostics.buildPath).toEqual(expect.any(String));
    expect(diagnostics.apiDocumentPath).toEqual(expect.any(String));
    expect(diagnostics.agentSkillPath).toEqual(expect.stringContaining('vikunja-fastmcp'));
    expect(diagnostics.supportedTools).toContain('vikunja_tasks');
    expect(diagnostics.supportedSubcommands.vikunja_tasks).toContain('create');
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
    expect(response.content[0].text).toContain('```json');
    expect(response.content[0].text).toContain('VALIDATION_ERROR');
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
  });

  it('preserves a real upstream 401 instead of rewriting it to 403', async () => {
    const handler = (server as any)._requestHandlers.get('tools/call');
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      text: async () => JSON.stringify({ detail: 'Write token rejected' }),
    } as Response);

    const response = await handler({
      method: 'tools/call',
      params: { name: 'vikunja_tasks', arguments: { action: 'delete', taskSelector: 99 } },
    });

    const jsonMatch = (response.content[0].text as string).match(/```json\n([\s\S]*?)\n```/);
    const envelope = JSON.parse(jsonMatch![1]);
    expect(envelope.error.status).toBe(401);
    expect(envelope.error.code).toBe('UNAUTHORIZED');
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('preserves an explicit null due date through MCP dispatch', async () => {
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

    await handler({
      method: 'tools/call',
      params: {
        name: 'vikunja_tasks',
        arguments: { action: 'update', taskSelector: 99, fields: { dueDate: null } },
      },
    });

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
      params: { name: 'vikunja_tasks', arguments: { action: 'get', taskSelector: 99 } },
    });
    const text = response.content[0].text as string;
    expect(text.match(/```json/g)).toHaveLength(1);
    expect(JSON.parse(text.match(/```json\n([\s\S]*?)\n```/)![1]).error.status).toBe(400);
  });
});
