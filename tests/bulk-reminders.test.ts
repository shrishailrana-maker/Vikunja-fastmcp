import { jest } from '@jest/globals';
import {
  bulkAssignTasks,
  bulkCreateTasks,
  bulkDeleteTasks,
  bulkUnassignTasks,
  bulkUpdateTasks,
} from '../src/bulk-reminders.js';
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

  it('does not collide when one bulk-create idempotency key is reused for different rows', async () => {
    const request = jest.fn(async (method: string, path: string, options?: any) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/projects/101/tasks') {
        return {
          id: options.body.title === 'First' ? 9001 : 9002,
          index: options.body.title === 'First' ? 1 : 2,
          identifier: options.body.title === 'First' ? 'ALPHA-1' : 'ALPHA-2',
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
    const second = await bulkCreateTasks(client, { id: 101 }, [{ title: 'Second' }], 'batch-1');

    expect(first.created[0].id).toBe(9001);
    expect(second.created[0].id).toBe(9002);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(2);
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

  it('returns cached bulk-assign and bulk-unassign receipts without repeated writes', async () => {
    const assigned = new Set<number>();
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/users?')) {
        return { items: [{ id: 42, username: 'developer' }], total: 1, total_pages: 1 };
      }
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'GET' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          identifier: 'ALPHA-1',
          title: 'Assignment target',
          project_id: 101,
          assignees: assigned.has(42) ? [{ id: 42, username: 'developer' }] : [],
        };
      }
      if (method === 'POST' && path === '/tasks/1/assignees') {
        assigned.add(42);
        return {};
      }
      if (method === 'DELETE' && path === '/tasks/1/assignees/42') {
        assigned.delete(42);
        return {};
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = { request, getConfig: () => ({ vikunjaToken: 'test-token' }) } as any;

    const assignedFirst = await bulkAssignTasks(
      client,
      [1],
      'developer',
      { id: 101 },
      false,
      'assign-1',
    );
    const assignWrites = request.mock.calls.filter(([method]) => method === 'POST').length;
    const assignedRetry = await bulkAssignTasks(
      client,
      [1],
      'developer',
      { id: 101 },
      false,
      'assign-1',
    );
    expect(assignedRetry).toEqual(assignedFirst);
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(assignWrites);

    const unassignedFirst = await bulkUnassignTasks(
      client,
      [1],
      'developer',
      { id: 101 },
      false,
      'unassign-1',
    );
    const unassignWrites = request.mock.calls.filter(([method]) => method === 'DELETE').length;
    const unassignedRetry = await bulkUnassignTasks(
      client,
      [1],
      'developer',
      { id: 101 },
      false,
      'unassign-1',
    );
    expect(unassignedRetry).toEqual(unassignedFirst);
    expect(request.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(
      unassignWrites,
    );
  });

  it('does not cache bulk-assignment dry runs', async () => {
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'GET' && path.startsWith('/users?')) {
        return { items: [{ id: 42, username: 'developer' }], total: 1, total_pages: 1 };
      }
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'GET' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          title: 'Dry-run target',
          project_id: 101,
          assignees: [],
        };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = { request, getConfig: () => ({ vikunjaToken: 'test-token' }) } as any;

    await bulkAssignTasks(client, [1], 'developer', { id: 101 }, true, 'dry-run-1');
    const callsAfterFirst = request.mock.calls.length;
    await bulkAssignTasks(client, [1], 'developer', { id: 101 }, true, 'dry-run-1');

    expect(request.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('returns cached bulk-update and bulk-delete receipts without repeated writes', async () => {
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'PUT' && path === '/tasks/bulk') {
        return {
          tasks: [
            {
              id: 1,
              index: 1,
              identifier: 'ALPHA-1',
              project_id: 101,
              title: 'Updated',
              done: true,
            },
          ],
        };
      }
      if (method === 'GET' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          identifier: 'ALPHA-1',
          project_id: 101,
          project: { title: 'Alpha' },
          title: 'Delete target',
          labels: [],
          assignees: [],
        };
      }
      if (method === 'DELETE' && path === '/tasks/1') return {};
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;

    const updateFirst = await bulkUpdateTasks(client, [1], { done: true }, undefined, 'update-1');
    const updateWrites = request.mock.calls.filter(([method]) => method === 'PUT').length;
    const updateRetry = await bulkUpdateTasks(client, [1], { done: true }, undefined, 'update-1');
    expect(updateRetry).toEqual(updateFirst);
    expect(request.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(updateWrites);

    const deleteFirst = await bulkDeleteTasks(client, [1], undefined, 'delete-1');
    const deleteWrites = request.mock.calls.filter(([method]) => method === 'DELETE').length;
    const deleteRetry = await bulkDeleteTasks(client, [1], undefined, 'delete-1');
    expect(deleteRetry).toEqual(deleteFirst);
    expect(request.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(deleteWrites);
  });
});
