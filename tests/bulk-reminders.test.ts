import { jest } from '@jest/globals';
import { bulkAssignTasks, bulkCreateTasks, bulkUnassignTasks } from '../src/bulk-reminders.js';
import { idempotency } from '../src/idempotency.js';
import { VikunjaError } from '../src/errors.js';

describe('bulk task composition', () => {
  beforeEach(() => idempotency.clear());

  it('continues after a failed create row and returns a compact result', async () => {
    const request = jest.fn(async (method: string, path: string, options?: any) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/projects/101/tasks') {
        if (options.body.title === 'Broken') {
          throw new VikunjaError({
            status: 422,
            code: 'VALIDATION_ERROR',
            method,
            path,
            message: 'Row rejected',
            fieldErrors: [],
          });
        }
        return {
          id: options.body.title === 'First' ? 9001 : 9003,
          index: options.body.title === 'First' ? 1 : 3,
          identifier: options.body.title === 'First' ? 'ALPHA-1' : 'ALPHA-3',
          title: options.body.title,
          project_id: 101,
        };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;

    const result = await bulkCreateTasks(client, { id: 101 }, [
      { title: 'First' },
      { title: 'Broken' },
      { title: 'Third' },
    ]);

    expect(result).toEqual({
      requested: 3,
      created: [
        { id: 9001, portalRef: 'ALPHA-1', title: 'First' },
        { id: 9003, portalRef: 'ALPHA-3', title: 'Third' },
      ],
      failed: [{ row: 2, title: 'Broken', error: 'Row rejected' }],
    });
  });

  it('returns a cached whole-batch result without creating again', async () => {
    const request = jest.fn(async (method: string, path: string, options?: any) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/projects/101/tasks') {
        return {
          id: 9001,
          index: 1,
          identifier: 'ALPHA-1',
          title: options.body.title,
          project_id: 101,
        };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;

    const first = await bulkCreateTasks(client, { id: 101 }, [{ title: 'First' }], 'batch-1');
    const writes = request.mock.calls.filter(([method]) => method === 'POST').length;
    const second = await bulkCreateTasks(client, { id: 101 }, [{ title: 'First' }], 'batch-1');

    expect(second).toEqual(first);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(writes);
  });

  it('bulk assigns a mixed batch and isolates a wrong-project task', async () => {
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/users?')) {
        return {
          items: [{ id: 42, username: 'developer' }],
          page: 1,
          per_page: 50,
          total: 1,
          total_pages: 1,
        };
      }
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'GET' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          identifier: 'ALPHA-1',
          title: 'Needs assignment',
          project_id: 101,
          assignees: [],
        };
      }
      if (method === 'GET' && path === '/tasks/2') {
        return {
          id: 2,
          index: 2,
          identifier: 'ALPHA-2',
          title: 'Already assigned',
          project_id: 101,
          assignees: [{ id: 42, username: 'developer' }],
        };
      }
      if (method === 'GET' && path === '/tasks/3') {
        return {
          id: 3,
          index: 1,
          identifier: 'BETA-1',
          title: 'Wrong project',
          project_id: 202,
          assignees: [],
        };
      }
      if (method === 'POST' && path === '/tasks/1/assignees') return {};
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = { request, getConfig: () => ({ vikunjaToken: 'test-token' }) } as any;

    const result = await bulkAssignTasks(client, [1, 2, 3], 'developer', { id: 101 });

    expect(result).toEqual({
      requested: 3,
      changed: 1,
      alreadyCorrect: 1,
      failed: [{ taskId: 3, error: expect.stringContaining('belongs to project ID 202') }],
      dryRun: false,
    });
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('bulk unassign dry-run performs no writes', async () => {
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/users?')) {
        return { items: [{ id: 42, username: 'developer' }], total: 1, total_pages: 1 };
      }
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'GET' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          title: 'Assigned',
          project_id: 101,
          assignees: [{ id: 42, username: 'developer' }],
        };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = { request, getConfig: () => ({ vikunjaToken: 'test-token' }) } as any;

    const result = await bulkUnassignTasks(client, [1], 'developer', { id: 101 }, true);

    expect(result).toEqual({
      requested: 1,
      changed: 1,
      alreadyCorrect: 0,
      failed: [],
      dryRun: true,
    });
    expect(request.mock.calls.some(([method]) => method === 'POST' || method === 'DELETE')).toBe(
      false,
    );
  });
});
