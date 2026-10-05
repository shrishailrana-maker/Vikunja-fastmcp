import { beforeEach, afterEach, describe, expect, it } from '@jest/globals';
import { createServer, type Server as HttpServer } from 'node:http';
import { VikunjaApiClient } from '../src/api.js';
import { closeNativeConnections, getNativeMcp } from '../src/native-mcp.js';
import { nativeArguments, nativeRoutes, NATIVE_ACTIONS } from '../src/native-routes.js';
import { createComment } from '../src/comments.js';
import { idempotency } from '../src/idempotency.js';
import { cache } from '../src/identity.js';
import { loadConfig, type Config } from '../src/config.js';
import { server as shellServer } from '../src/index.js';
import { closeWithStructuredEvidence } from '../src/tasks.js';

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
        response.end(JSON.stringify(openapi));
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
      } else if (rpc.params.name === 'projects_read') {
        result = { content: [], structuredContent: { id: 7, title: 'Alpha' } };
      } else {
        result = { content: [{ type: 'text', text: JSON.stringify(task) }] };
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
