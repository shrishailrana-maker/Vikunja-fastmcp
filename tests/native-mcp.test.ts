import { beforeEach, afterEach, describe, expect, it, jest } from '@jest/globals';
import { createServer, type Server as HttpServer } from 'node:http';
import fs from 'node:fs';
import { VikunjaApiClient } from '../src/api.js';
import { closeNativeConnections, getNativeMcp, nativeResultData } from '../src/native-mcp.js';
import { nativeArguments, nativeRoutes, NATIVE_ACTIONS } from '../src/native-routes.js';
import { createComment, listComments } from '../src/comments.js';
import { idempotency } from '../src/idempotency.js';
import { cache } from '../src/identity.js';
import { loadConfig, type Config } from '../src/config.js';
import { server as shellServer } from '../src/index.js';
import { closeWithStructuredEvidence, createTask, getTask } from '../src/tasks.js';
import { toErrorEnvelope } from '../src/errors.js';

const realSpec = JSON.parse(
  fs.readFileSync(new URL('../docs/vikunja-v2-openapi.json', import.meta.url), 'utf8'),
);

const schema = (name: string, location = 'path', type = 'integer') => ({
  name,
  in: location,
  schema: { type },
});
const openapi = {
  paths: {
    '/tasks/{projecttask}': {
      get: { operationId: 'tasks-read', parameters: [schema('projecttask')] },
      put: { operationId: 'tasks-update', parameters: [schema('projecttask')] },
      patch: { operationId: 'patch-tasks-read', parameters: [schema('projecttask')] },
    },
    '/tasks/{task}/comments': {
      get: {
        operationId: 'task-comments-list',
        parameters: [schema('task'), schema('page', 'query'), schema('per_page', 'query')],
      },
      post: { operationId: 'task-comments-create', parameters: [schema('task')] },
    },
    '/projects/{id}': { get: { operationId: 'projects-read', parameters: [schema('id')] } },
    '/projects/{project}/tasks/by-index/{index}': {
      get: { operationId: 'tasks-read-by-index', parameters: [schema('project'), schema('index')] },
    },
    '/user': { get: { operationId: 'user-show' } },
  },
};

describe('native MCP shell transport', () => {
  let http: HttpServer;
  let config: Config;
  let client: VikunjaApiClient;
  let calls: { method: string; path: string; rpc?: any }[];
  let forbidden: boolean;
  let writeFailure: boolean;
  let noOp: boolean;
  let deniedAction: boolean;
  let spec: any;
  let nativeHttpStatus: number;
  let sessions: boolean;
  let expireSession: boolean;
  let persistExpiry: boolean;
  let initializations: number;
  let successfulText: string | undefined;
  let toolError: string | undefined;
  let missingUpdated: boolean;
  let oldNativeEnv: Record<string, string | undefined>;
  const task = {
    id: 12,
    index: 2,
    identifier: 'ALPHA-2',
    project_id: 7,
    project: { title: 'Alpha' },
    title: 'Evidence task',
    done: false,
    updated: '2026-10-05T00:00:00Z',
  };

  beforeEach(async () => {
    oldNativeEnv = Object.fromEntries(
      [
        'VIKUNJA_URL',
        'VIKUNJA_API_TOKEN',
        'VIKUNJA_MCP_TOOL_PROFILE',
        'VIKUNJA_MCP_BACKEND',
        'VIKUNJA_API_TOKEN_FILE',
      ].map((name) => [name, process.env[name]]),
    );
    calls = [];
    forbidden = false;
    writeFailure = false;
    noOp = false;
    deniedAction = false;
    spec = openapi;
    nativeHttpStatus = 0;
    sessions = false;
    expireSession = false;
    persistExpiry = false;
    initializations = 0;
    successfulText = undefined;
    toolError = undefined;
    missingUpdated = false;
    idempotency.clear();
    cache.clearProjects();
    http = createServer(async (request, response) => {
      const path = request.url ?? '';
      let bytes = '';
      for await (const chunk of request) bytes += chunk;
      const rpc = bytes ? JSON.parse(bytes) : undefined;
      calls.push({ method: request.method ?? '', path, rpc });
      response.setHeader('Content-Type', 'application/json');
      if (path === '/api/v2/openapi.json') {
        response.end(JSON.stringify(spec));
        return;
      }
      if (path === '/api/v2/user') {
        response.end(JSON.stringify({ id: 1, username: 'tester' }));
        return;
      }
      if (path !== '/api/v2/mcp') {
        response.statusCode = 500;
        response.end('{}');
        return;
      }
      if (forbidden) {
        response.statusCode = 403;
        response.end(JSON.stringify({ detail: 'Missing mcp:access' }));
        return;
      }
      if (nativeHttpStatus) {
        response.statusCode = nativeHttpStatus;
        response.end('{}');
        return;
      }
      if (request.method !== 'POST') {
        response.statusCode = 405;
        response.end('{}');
        return;
      }
      if (rpc.id === undefined) {
        response.statusCode = 202;
        response.end();
        return;
      }
      let result: any;
      if (rpc.method === 'initialize') {
        initializations += 1;
        if (sessions) response.setHeader('Mcp-Session-Id', `session-${initializations}`);
        result = {
          protocolVersion: '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'vikunja', version: 'v2.7.0' },
        };
      } else if (rpc.method === 'tools/list') {
        result = {
          tools: [
            {
              name: 'tasks_read',
              inputSchema: {
                type: 'object',
                properties: { projecttask: { type: 'integer' } },
                required: ['projecttask'],
              },
            },
            ...(!deniedAction ? [{ name: 'tasks_update', inputSchema: { type: 'object' } }] : []),
            { name: 'task_comments_create', inputSchema: { type: 'object' } },
            { name: 'task_comments_list', inputSchema: { type: 'object' } },
            { name: 'projects_read', inputSchema: { type: 'object' } },
            { name: 'project_tasks_list', inputSchema: { type: 'object' } },
            { name: 'task_attachments_list', inputSchema: { type: 'object' } },
            { name: 'tasks_create', inputSchema: { type: 'object' } },
            { name: 'find_action', inputSchema: { type: 'object' } },
            { name: 'do_action', inputSchema: { type: 'object' } },
          ],
        };
      } else if (rpc.params.name === 'find_action') {
        result = {
          content: [
            { type: 'text', text: JSON.stringify({ actions: [{ name: 'tasks_read_by_index' }] }) },
          ],
        };
      } else if (
        expireSession &&
        rpc.method === 'tools/call' &&
        rpc.params.name === 'tasks_read' &&
        (persistExpiry || request.headers['mcp-session-id'] === 'session-1')
      ) {
        response.statusCode = 404;
        response.end('{}');
        return;
      } else if (rpc.params.name === 'tasks_update' && successfulText !== undefined) {
        result = { isError: false, content: [{ type: 'text', text: successfulText }] };
      } else if (rpc.params.name === 'tasks_update' && toolError !== undefined) {
        result = { isError: true, content: [{ type: 'text', text: toolError }] };
      } else if (rpc.params.name === 'tasks_update' && writeFailure) {
        result = {
          isError: true,
          content: [{ type: 'text', text: '503 Service Unavailable: write may have been applied' }],
        };
      } else if (rpc.params.name === 'tasks_update' && noOp) {
        result = { content: [], structuredContent: { ok: true, unchanged: true } };
      } else if (rpc.params.name === 'task_comments_create') {
        result = {
          content: [],
          structuredContent: {
            id: 42,
            comment: rpc.params.arguments.comment,
            created: '2026-10-05T01:00:00Z',
            author: { id: 1, username: 'tester' },
          },
        };
      } else if (rpc.params.name === 'task_comments_list') {
        result = {
          content: [],
          structuredContent: { items: [], page: 1, per_page: 100, total: 0, total_pages: 0 },
        };
      } else if (
        rpc.params.name === 'task_attachments_list' ||
        rpc.params.name === 'project_tasks_list'
      ) {
        result = {
          content: [],
          structuredContent: { items: [], page: 1, per_page: 100, total: 0, total_pages: 0 },
        };
      } else if (rpc.params.name === 'projects_read') {
        result = { content: [], structuredContent: { id: 7, title: 'Alpha' } };
      } else {
        result = {
          content: [
            {
              type: 'text',
              text: JSON.stringify({ ...task, ...(missingUpdated ? { updated: undefined } : {}) }),
            },
          ],
        };
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const address = http.address() as { port: number };
    config = {
      vikunjaUrl: `http://127.0.0.1:${address.port}/api/v2`,
      vikunjaWebUrl: `http://127.0.0.1:${address.port}/`,
      vikunjaToken: 'neutral-native-test-token',
      attachmentDownloadRoot: '/tmp',
      backend: 'native',
      requestTimeoutMs: 3000,
    };
    client = new VikunjaApiClient(config);
  });

  afterEach(async () => {
    await closeNativeConnections();
    http.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      http.close((error) => (error ? reject(error) : resolve())),
    );
    for (const [name, value] of Object.entries(oldNativeEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it('coalesces initialization and routes ordinary reads through native tools', async () => {
    const results = await Promise.all([
      client.request('GET', '/tasks/12'),
      client.request('GET', '/tasks/12'),
    ]);
    expect(results).toEqual([task, task]);
    expect(calls.filter((call) => call.rpc?.method === 'initialize')).toHaveLength(1);
    expect(calls.filter((call) => call.path === '/api/v2/tasks/12')).toHaveLength(0);
    expect(calls.filter((call) => call.rpc?.params?.name === 'tasks_read')).toHaveLength(2);
  });

  it('reads default five comments and since/includeLatest lists through the real 2.7 spec', async () => {
    spec = realSpec;
    const details = await getTask(client, { globalId: 12 }, undefined, undefined, 'full');
    expect(details).toHaveProperty('comments', []);
    await expect(
      listComments(client, { globalId: 12 }, undefined, 1, 20, {
        since: '2026-10-01T00:00:00Z',
        includeLatest: true,
      }),
    ).resolves.toHaveProperty('comments', []);
    await expect(
      listComments(client, { globalId: 12 }, undefined, 1, 20, {
        includeLatest: true,
      }),
    ).resolves.toHaveProperty('comments', []);
    const commentCalls = calls.filter((call) => call.rpc?.params?.name === 'task_comments_list');
    expect(commentCalls.map((call) => call.rpc.params.arguments)).toEqual(
      expect.arrayContaining([
        { task: 12, order_by: 'desc', page: 1, per_page: 5 },
        { task: 12, order_by: 'desc', page: 1, per_page: 100 },
        { task: 12, order_by: 'desc', page: 1, per_page: 1 },
      ]),
    );
    for (const call of commentCalls)
      expect(call.rpc.params.arguments).not.toHaveProperty('sort_by');
  });

  it('passes both nullable-array sort keys and orders from the real spec to native', async () => {
    spec = realSpec;
    await client.request(
      'GET',
      '/projects/7/tasks?sort_by=updated&sort_by=id&order_by=desc&order_by=asc',
    );
    expect(
      calls.find((call) => call.rpc?.params?.name === 'project_tasks_list')?.rpc.params.arguments,
    ).toEqual({ project: 7, sort_by: ['updated', 'id'], order_by: ['desc', 'asc'] });
  });

  it('reconnects exactly once when an established native session expires', async () => {
    sessions = true;
    expireSession = true;
    await expect(client.request('GET', '/tasks/12')).resolves.toEqual(task);
    expect(initializations).toBe(2);
    expect(calls.filter((call) => call.rpc?.params?.name === 'tasks_read')).toHaveLength(2);
  });

  it('reports persistent session expiry as 503 rather than task not found', async () => {
    sessions = true;
    expireSession = true;
    persistExpiry = true;
    await expect(client.request('GET', '/tasks/12')).rejects.toMatchObject({
      status: 503,
      code: 'NATIVE_SESSION_EXPIRED',
    });
    expect(initializations).toBe(2);
    expect(calls.filter((call) => call.rpc?.params?.name === 'tasks_read')).toHaveLength(2);
  });

  it.each([404, 405])(
    'explains missing native MCP HTTP %i with explicit REST remediation',
    async (status) => {
      nativeHttpStatus = status;
      await expect(client.request('GET', '/tasks/12')).rejects.toMatchObject({
        status: 503,
        code: 'NATIVE_MCP_UNAVAILABLE',
        message: 'Vikunja 2.7+ native MCP not found at /api/v2/mcp; set VIKUNJA_MCP_BACKEND=rest',
      });
    },
  );

  it.each(['', 'Write completed'])(
    'keeps successful text %j as a successful single write',
    async (text) => {
      successfulText = text;
      await expect(client.request('PATCH', '/tasks/12', { body: { done: true } })).resolves.toEqual(
        text ? { message: text } : {},
      );
      expect(calls.filter((call) => call.rpc?.params?.name === 'tasks_update')).toHaveLength(1);
    },
  );

  it.each([
    ['Label 412 missing', 422, 'NATIVE_TOOL_ERROR', false],
    ['403 forbidden', 403, 'PERMISSION_DENIED', false],
    ['Timeout mentioned by a tool is not an SDK timeout', 422, 'NATIVE_TOOL_ERROR', false],
  ])(
    'maps native error %s without parsing embedded numbers or timeout prose',
    async (text, status, code, retryable) => {
      toolError = String(text);
      try {
        await client.request('PATCH', '/tasks/12', { body: { done: true } });
        throw new Error('Expected native error');
      } catch (error) {
        expect(toErrorEnvelope(error).error).toMatchObject({ status, code, retryable });
      }
    },
  );

  it('keeps missing server updatedAt null in creation and shell mutation receipts', async () => {
    spec = realSpec;
    missingUpdated = true;
    const receipt = await createTask(
      client,
      { id: 7 },
      { title: 'Evidence task' },
      'native-no-time',
      undefined,
      'Codex',
    );
    expect(receipt).toMatchObject({ updatedAt: null, recordedAt: expect.any(String) });
    process.env.VIKUNJA_URL = config.vikunjaUrl;
    process.env.VIKUNJA_API_TOKEN = config.vikunjaToken;
    process.env.VIKUNJA_API_TOKEN_FILE = '';
    process.env.VIKUNJA_MCP_BACKEND = 'native';
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'native';
    const call = (shellServer as any)._requestHandlers.get('tools/call');
    const result = await call({
      method: 'tools/call',
      params: {
        name: 'vikunja_task_write',
        arguments: {
          action: 'create',
          projectSelector: { id: 7 },
          fields: { title: 'Evidence task' },
          idempotencyKey: 'native-shell-no-time',
          actor: 'Codex',
        },
      },
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent.data).toMatchObject({
      updatedAt: null,
      recordedAt: expect.any(String),
    });
  });

  it('lists static shell tools including self_check while native fetch fails', async () => {
    process.env.VIKUNJA_URL = config.vikunjaUrl;
    process.env.VIKUNJA_API_TOKEN = config.vikunjaToken;
    process.env.VIKUNJA_API_TOKEN_FILE = '';
    process.env.VIKUNJA_MCP_BACKEND = 'native';
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'native';
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('fetch failed'));
    try {
      const list = (shellServer as any)._requestHandlers.get('tools/list');
      const result = await list({ method: 'tools/list' });
      expect(result.tools.map((tool: any) => tool.name)).toEqual(
        expect.arrayContaining(['self_check', 'find_action', 'do_action']),
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      fetchMock.mockRestore();
    }
  });

  it('normalizes REST with trailing whitespace for all shell backend decisions', async () => {
    process.env.VIKUNJA_URL = config.vikunjaUrl;
    process.env.VIKUNJA_API_TOKEN = config.vikunjaToken;
    process.env.VIKUNJA_API_TOKEN_FILE = '';
    process.env.VIKUNJA_MCP_BACKEND = 'REST ';
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'native';
    const list = (shellServer as any)._requestHandlers.get('tools/list');
    const result = await list({ method: 'tools/list' });
    expect(result.tools.map((tool: any) => tool.name)).toContain('vikunja_projects');
    expect(result.tools.map((tool: any) => tool.name)).not.toContain('find_action');
    const call = (shellServer as any)._requestHandlers.get('tools/call');
    const unknown = await call({
      method: 'tools/call',
      params: { name: 'tasks_read', arguments: {} },
    });
    expect(unknown.structuredContent.error.message).toBe('Tool not found: tasks_read');
    expect(initializations).toBe(0);
  });

  it('rejects a hidden local tool rather than forwarding it as a native permission error', async () => {
    process.env.VIKUNJA_URL = config.vikunjaUrl;
    process.env.VIKUNJA_API_TOKEN = config.vikunjaToken;
    process.env.VIKUNJA_API_TOKEN_FILE = '';
    process.env.VIKUNJA_MCP_BACKEND = 'native';
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'native';
    const call = (shellServer as any)._requestHandlers.get('tools/call');
    const result = await call({
      method: 'tools/call',
      params: { name: 'vikunja_projects', arguments: {} },
    });
    expect(result.structuredContent.error).toMatchObject({
      status: 400,
      message: 'Tool not found: vikunja_projects',
    });
    await expect(getNativeMcp(config).callShellTool('vikunja_projects', {})).rejects.toMatchObject({
      status: 400,
    });
    expect(calls.filter((entry) => entry.rpc?.params?.name === 'vikunja_projects')).toHaveLength(0);
  });

  it('calls catalog actions through do_action and retains the native tool schemas', async () => {
    await expect(client.request('GET', '/projects/7/tasks/by-index/2')).resolves.toEqual(task);
    expect(
      calls.find((call) => call.rpc?.params?.name === 'do_action')?.rpc.params.arguments,
    ).toEqual({ action: 'tasks_read_by_index', arguments: { project: 7, index: 2 } });
    const tools = await getNativeMcp(config).listTools();
    expect(tools.find((tool) => tool.name === 'tasks_read')?.inputSchema.required).toEqual([
      'projecttask',
    ]);
  });

  it('converts top-level JSON Patch and reads back a native no-op response', async () => {
    noOp = true;
    await expect(
      client.request('PATCH', '/tasks/12', {
        body: [{ op: 'replace', path: '/done', value: false }],
      }),
    ).resolves.toEqual(task);
    expect(
      calls.find((call) => call.rpc?.params?.name === 'tasks_update')?.rpc.params.arguments,
    ).toEqual({ projecttask: 12, done: false });
  });

  it('retains durable comment receipts across native retries', async () => {
    const first = await createComment(
      client,
      { globalId: 12 },
      'sample_import_batches',
      undefined,
      'comment-native-1',
      'Codex',
    );
    const retry = await createComment(
      client,
      { globalId: 12 },
      'sample_import_batches',
      undefined,
      'comment-native-1',
      'Codex',
    );
    expect(retry).toEqual(first);
    expect(calls.filter((call) => call.rpc?.params?.name === 'task_comments_create')).toHaveLength(
      1,
    );
  });

  it('retains an honest partial evidence-closure result on a failed native task write', async () => {
    writeFailure = true;
    const receipt = await closeWithStructuredEvidence(
      client,
      { globalId: 12 },
      {
        command: 'verify',
        result: 'PASS',
        timestamp: '2026-10-05T01:00:00Z',
        evidenceKey: 'native-evidence',
      },
      { id: 7 },
      'native-evidence-close',
      'Codex',
    );
    expect(receipt).toMatchObject({
      action: 'partial',
      outcome: 'partial',
      evidence: { created: true },
      taskStatus: 'open',
      error: { status: 503 },
    });
    expect(calls.filter((call) => call.rpc?.params?.name === 'task_comments_create')).toHaveLength(
      1,
    );
    expect(calls.filter((call) => call.path === '/api/v2/tasks/12')).toHaveLength(0);
  });

  it('exposes native tools and campaign wrappers through one local MCP server', async () => {
    process.env.VIKUNJA_URL = config.vikunjaUrl;
    process.env.VIKUNJA_API_TOKEN = config.vikunjaToken;
    process.env.VIKUNJA_API_TOKEN_FILE = '';
    process.env.VIKUNJA_MCP_BACKEND = 'native';
    process.env.VIKUNJA_MCP_TOOL_PROFILE = 'native';
    const list = (shellServer as any)._requestHandlers.get('tools/list');
    const listed = await list({ method: 'tools/list' });
    expect(listed.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining([
        'find_action',
        'do_action',
        'vikunja_task_workflow',
        'vikunja_task_bulk',
      ]),
    );
    expect(listed.tools.map((tool: any) => tool.name)).not.toContain('vikunja_tasks');
    expect(listed.tools.map((tool: any) => tool.name)).not.toContain('tasks_read');
    expect(JSON.stringify(listed.tools).length).toBeLessThan(60000);
    const call = (shellServer as any)._requestHandlers.get('tools/call');
    const found = await call({
      method: 'tools/call',
      params: { name: 'find_action', arguments: { action: 'tasks_read' } },
    });
    expect(found.structuredContent.actions).toEqual([
      expect.objectContaining({
        name: 'tasks_read',
        input_schema: expect.objectContaining({ required: ['projecttask'] }),
      }),
    ]);
    const result = await call({
      method: 'tools/call',
      params: {
        name: 'do_action',
        arguments: { action: 'tasks_read', arguments: { projecttask: 12 } },
      },
    });
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toContain('ALPHA-2');
  });

  it('never retries a failed native write using REST', async () => {
    writeFailure = true;
    await expect(
      client.request('PATCH', '/tasks/12', {
        body: [{ op: 'replace', path: '/done', value: true }],
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(calls.filter((call) => call.path === '/api/v2/tasks/12')).toHaveLength(0);
    expect(calls.filter((call) => call.rpc?.params?.name === 'tasks_update')).toHaveLength(1);
  });

  it('does not turn denied discovery into a REST fallback', async () => {
    deniedAction = true;
    await expect(
      client.request('PATCH', '/tasks/12', {
        body: [{ op: 'replace', path: '/done', value: true }],
      }),
    ).rejects.toMatchObject({ status: 403, code: 'NATIVE_ACTION_FORBIDDEN' });
    expect(calls.filter((call) => call.path === '/api/v2/tasks/12')).toHaveLength(0);
  });

  it('explains missing MCP access without falling back or exposing credentials', async () => {
    forbidden = true;
    await expect(client.request('GET', '/tasks/12')).rejects.toMatchObject({
      status: 403,
      message: expect.stringContaining('Settings > MCP'),
    });
    expect(calls.filter((call) => call.path === '/api/v2/tasks/12')).toHaveLength(0);
  });

  it('keeps unexposed REST utilities while rejecting unsupported native headers', async () => {
    await expect(client.request('GET', '/user')).resolves.toEqual({ id: 1, username: 'tester' });
    await expect(
      client.request('PATCH', '/tasks/12', {
        body: { done: true },
        headers: { 'If-Match': 'example' },
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_HEADER_UNSUPPORTED' });
  });
});

describe('native route conversion', () => {
  it('accepts empty success content without inventing an API failure', () => {
    expect(nativeResultData({ isError: false, content: [] })).toEqual({});
  });

  it('normalizes nullable numeric and boolean scalar types', () => {
    const routes = nativeRoutes(
      {
        paths: {
          '/tasks/{task}': {
            get: {
              operationId: 'tasks-read',
              parameters: [
                { name: 'task', in: 'path', schema: { type: ['integer', 'null'] } },
                { name: 'flag', in: 'query', schema: { type: ['boolean', 'null'] } },
                { name: 'value', in: 'query', schema: { type: ['number', 'null'] } },
              ],
            },
          },
        },
      },
      NATIVE_ACTIONS,
    );
    expect(nativeArguments(routes[0], '/tasks/12?flag=true&value=1.5')).toEqual({
      task: 12,
      flag: true,
      value: 1.5,
    });
  });
  it('rejects nested JSON Patch rather than silently changing its meaning', () => {
    const route = nativeRoutes(openapi, NATIVE_ACTIONS).find((item) => item.method === 'PATCH')!;
    expect(() =>
      nativeArguments(route, '/tasks/12', [{ op: 'replace', path: '/labels/0', value: 3 }]),
    ).toThrow(expect.objectContaining({ code: 'NATIVE_ARGUMENT_UNSUPPORTED' }));
  });

  it('preserves repeated array query arguments and numeric path selectors', () => {
    const spec = {
      paths: {
        '/tasks': {
          get: {
            operationId: 'tasks-list',
            parameters: [
              {
                name: 'sort_by',
                in: 'query',
                schema: { type: 'array', items: { type: 'string' } },
              },
            ],
          },
        },
      },
    };
    expect(
      nativeArguments(nativeRoutes(spec, NATIVE_ACTIONS)[0], '/tasks?sort_by=updated&sort_by=id'),
    ).toEqual({ sort_by: ['updated', 'id'] });
  });

  it('loads native defaults and an explicit REST compatibility backend', () => {
    const env = {
      VIKUNJA_URL: 'https://vikunja.example.com',
      VIKUNJA_API_TOKEN: 'neutral-test-token',
    };
    expect(loadConfig(env)).toMatchObject({ backend: 'native', toolProfile: 'native' });
    expect(loadConfig({ ...env, VIKUNJA_MCP_BACKEND: 'rest' }).backend).toBe('rest');
    expect(() => loadConfig({ ...env, VIKUNJA_MCP_BACKEND: 'automatic' })).toThrow(
      'must be native or rest',
    );
  });
});
