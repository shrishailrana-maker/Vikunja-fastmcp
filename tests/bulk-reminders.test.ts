import { jest } from '@jest/globals';
import {
  bulkAssignTasks,
  bulkCreateTasks,
  bulkDeleteTasks,
  bulkUnassignTasks,
  bulkUpdateTasks,
  bulkWorkflowTasks,
  getBulkOperationStatus,
} from '../src/bulk-reminders.js';
import { idempotency } from '../src/idempotency.js';
import { IdempotencyCache } from '../src/idempotency.js';
import { VikunjaError } from '../src/errors.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

  it('never sends a nonnumeric legacy selector as NaN to the native bulk route', async () => {
    const request = jest.fn(async (_method: string, _path: string) => ({ tasks: [] }));
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;

    await expect(bulkUpdateTasks(client, ['not-a-task'], { done: true })).rejects.toMatchObject({
      status: 400,
    });
    expect(
      request.mock.calls.some(([method, path]) => method === 'PUT' && path === '/tasks/bulk'),
    ).toBe(false);
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

    expect(first).toMatchObject({ changed: 1, skipped: 0 });
    expect(second).toMatchObject({ changed: 1, skipped: 1 });
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(writes);
  });

  it('composes a bulk-created task with a durable first comment', async () => {
    const request = jest.fn(async (method: string, requestPath: string, options?: any) => {
      if (method === 'GET' && requestPath === '/projects/101') {
        return { id: 101, title: 'Alpha' };
      }
      if (method === 'POST' && requestPath === '/projects/101/tasks') {
        return {
          id: 9050,
          index: 50,
          identifier: 'ALPHA-50',
          title: options.body.title,
          project_id: 101,
        };
      }
      if (method === 'GET' && requestPath === '/tasks/9050') {
        return {
          id: 9050,
          index: 50,
          identifier: 'ALPHA-50',
          title: 'First',
          project_id: 101,
        };
      }
      if (method === 'POST' && requestPath === '/tasks/9050/comments') {
        return {
          id: 7050,
          comment: '<p>Initial evidence</p>',
          author: { id: 1, username: 'codex' },
          created: '2026-08-02T10:00:00Z',
        };
      }
      throw new Error(`Unexpected ${method} ${requestPath}`);
    });
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;
    const tasks = [{ title: 'First', firstComment: 'Initial evidence' }];

    const first = await bulkCreateTasks(client, { id: 101 }, tasks, 'bulk-composite', 'Codex');
    const writesAfterFirst = request.mock.calls.filter(([method]) => method === 'POST').length;
    const status = getBulkOperationStatus(first.operationId);
    const second = await bulkCreateTasks(client, { id: 101 }, tasks, 'bulk-composite', 'Codex');

    expect(status.receipts[0]).toMatchObject({
      state: 'changed',
      firstComment: { status: 'created', id: 7050 },
    });
    expect(second).toMatchObject({ operationId: first.operationId, skipped: 1 });
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(
      writesAfterFirst,
    );
  });

  it('reports a created task and preserves a non-retryable composition failure', async () => {
    const request = jest.fn(async (method: string, requestPath: string, options?: any) => {
      if (method === 'GET' && requestPath === '/projects/101') {
        return { id: 101, title: 'Alpha' };
      }
      if (method === 'POST' && requestPath === '/projects/101/tasks') {
        return {
          id: 9051,
          index: 51,
          identifier: 'ALPHA-51',
          title: options.body.title,
          project_id: 101,
        };
      }
      if (method === 'GET' && requestPath === '/tasks/9051') {
        return {
          id: 9051,
          index: 51,
          identifier: 'ALPHA-51',
          title: 'First',
          project_id: 101,
          related_tasks: {},
        };
      }
      if (method === 'GET' && requestPath === '/tasks/9052') {
        return {
          id: 9052,
          index: 52,
          identifier: 'ALPHA-52',
          title: 'Second',
          project_id: 101,
        };
      }
      if (method === 'POST' && requestPath === '/tasks/9051/relations') {
        throw new VikunjaError({
          status: 422,
          code: 'VALIDATION_ERROR',
          method,
          path: requestPath,
          message: 'Relation rejected',
          fieldErrors: [],
        });
      }
      throw new Error(`Unexpected ${method} ${requestPath}`);
    });
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;
    const tasks = [
      {
        title: 'First',
        relations: [{ relationKind: 'related', otherTaskSelector: { globalId: 9052 } }],
      },
    ];

    const result = await bulkCreateTasks(client, { id: 101 }, tasks, 'bulk-partial', 'Codex');
    const status = getBulkOperationStatus(result.operationId);

    expect(result).toMatchObject({ created: 1, changed: 0, failed: 1 });
    expect(status.receipts[0]).toMatchObject({
      state: 'failed',
      retryable: false,
      finalIdentity: { id: 9051, portalRef: 'ALPHA-51' },
      relations: [{ status: 'failed', relationKind: 'related' }],
    });
  });

  it('does not persist response-only skip metadata without owning the bulk lease', async () => {
    let releaseSecondRow!: () => void;
    const secondRowReleased = new Promise<void>((resolve) => {
      releaseSecondRow = resolve;
    });
    let announceSecondRow!: () => void;
    const secondRowStarted = new Promise<void>((resolve) => {
      announceSecondRow = resolve;
    });
    const request = jest.fn(async (method: string, path: string, options?: any) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/projects/101/tasks') {
        if (options.body.title === 'Second') {
          announceSecondRow();
          await secondRowReleased;
        }
        const index = options.body.title === 'First' ? 1 : 2;
        return {
          id: 9000 + index,
          index,
          identifier: `ALPHA-${index}`,
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
    const rows = [{ title: 'First' }, { title: 'Second' }];

    const running = bulkCreateTasks(client, { id: 101 }, rows, 'concurrent-batch');
    await secondRowStarted;
    const writesBeforeRetry = request.mock.calls.filter(([method]) => method === 'POST').length;
    const retry = await bulkCreateTasks(client, { id: 101 }, rows, 'concurrent-batch');

    expect(retry).toMatchObject({ status: 'running', changed: 1, skipped: 1 });
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(
      writesBeforeRetry,
    );
    expect(getBulkOperationStatus(retry.operationId).receipts[0]).toMatchObject({
      row: 1,
      skipped: false,
    });

    releaseSecondRow();
    await expect(running).resolves.toMatchObject({ status: 'completed', changed: 2 });
  });

  it('stops before the next bulk write when lease renewal fails', async () => {
    const request = jest.fn(async (method: string, requestPath: string, options?: any) => {
      if (method === 'GET' && requestPath === '/projects/101') {
        return { id: 101, title: 'Alpha' };
      }
      if (method === 'POST' && requestPath === '/projects/101/tasks') {
        const index = options.body.title === 'First' ? 1 : 2;
        return {
          id: 9000 + index,
          index,
          identifier: `ALPHA-${index}`,
          title: options.body.title,
          project_id: 101,
        };
      }
      throw new Error(`Unexpected ${method} ${requestPath}`);
    });
    const client = {
      request,
      getConfig: () => ({
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;
    const renew = jest.spyOn(idempotency, 'renewLease').mockReturnValue(false);

    await expect(
      bulkCreateTasks(
        client,
        { id: 101 },
        [{ title: 'First' }, { title: 'Second' }],
        'lease-loss-batch',
      ),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_LEASE_LOST' });

    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
    renew.mockRestore();
  });

  it('rejects one bulk-create idempotency key reused for a different payload', async () => {
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

    expect(first).toMatchObject({ changed: 1, failed: 0, status: 'completed' });
    expect(getBulkOperationStatus(first.operationId).receipts[0]).toMatchObject({
      state: 'changed',
      finalIdentity: { id: 9001, portalRef: 'ALPHA-1' },
      resultHash: expect.any(String),
    });
    await expect(
      bulkCreateTasks(client, { id: 101 }, [{ title: 'Second' }], 'batch-1'),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED' });
    expect(request.mock.calls.filter(([method]) => method === 'POST')).toHaveLength(1);
  });

  it('resumes a partial bulk create without repeating successful rows', async () => {
    let brokenAttempts = 0;
    const request = jest.fn(async (method: string, path: string, options?: any) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/projects/101/tasks') {
        if (options.body.title === 'Broken' && brokenAttempts++ === 0) {
          throw new VikunjaError({
            status: 503,
            code: 'SERVICE_UNAVAILABLE',
            method,
            path,
            message: 'Temporary failure',
            fieldErrors: [],
          });
        }
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
    const rows = [{ title: 'First' }, { title: 'Broken' }];

    const first = (await bulkCreateTasks(client, { id: 101 }, rows, 'resume-1')) as any;

    expect(first.status).toBe('partial');
    expect(getBulkOperationStatus(first.operationId)).toMatchObject({
      status: 'partial',
      failed: 1,
      receipts: [
        { row: 1, state: 'changed' },
        { row: 2, state: 'failed', retryCount: 0 },
      ],
    });
    const second = (await bulkCreateTasks(client, { id: 101 }, rows, 'resume-1')) as any;
    expect(second.status).toBe('completed');
    expect(getBulkOperationStatus(second.operationId).status).toBe('completed');
    expect(second).toMatchObject({ changed: 2, skipped: 1, failed: 0, status: 'completed' });
    expect(getBulkOperationStatus(second.operationId).receipts[0]).toMatchObject({
      row: 1,
      skipped: true,
      skipReason: 'already-complete',
    });
    expect(getBulkOperationStatus(second.operationId).receipts[1]).toMatchObject({
      row: 2,
      state: 'changed',
      retryCount: 1,
      resultHash: expect.any(String),
    });
    expect(
      request.mock.calls.filter(
        ([method, , options]) => method === 'POST' && options.body.title === 'First',
      ),
    ).toHaveLength(1);
  });

  it('does not retry a permanent row failure and records the resume skip', async () => {
    let attempts = 0;
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/projects/101/tasks') {
        attempts += 1;
        throw new VikunjaError({
          status: 422,
          code: 'VALIDATION_ERROR',
          method,
          path,
          message: 'Permanent row error',
          fieldErrors: [],
        });
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
    const rows = [{ title: 'Invalid' }];

    const first = await bulkCreateTasks(client, { id: 101 }, rows, 'permanent-row');
    const second = await bulkCreateTasks(client, { id: 101 }, rows, 'permanent-row');
    const status = getBulkOperationStatus(second.operationId);

    expect(attempts).toBe(1);
    expect(first).toMatchObject({ status: 'partial', failed: 1, skipped: 0 });
    expect(second).toMatchObject({ status: 'partial', failed: 1, skipped: 1 });
    expect(status.receipts[0]).toMatchObject({
      row: 1,
      ok: false,
      state: 'failed',
      failed: true,
      retryable: false,
      retryCount: 0,
      skipped: true,
      skipReason: 'non-retryable',
    });
  });

  it('persists bulk-shaped row receipts across a ledger reopen', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-bulk-ledger-'));
    const databasePath = path.join(directory, 'operations.sqlite');
    const operationId = 'create-restart-proof';
    const first = new IdempotencyCache({ databasePath });
    first.set(`bulk-operation:${operationId}`, {
      operationId,
      status: 'partial',
      requested: 2,
      receipts: [
        {
          row: 1,
          ok: true,
          state: 'changed',
          selected: true,
          changed: true,
          unchanged: false,
          skipped: false,
          failed: false,
          retryCount: 0,
          resultHash: 'immutable-row-hash',
        },
      ],
    });
    first.close();

    const reopened = new IdempotencyCache({ databasePath });
    expect(reopened.get(`bulk-operation:${operationId}`)).toMatchObject({
      status: 'partial',
      receipts: [
        expect.objectContaining({ row: 1, state: 'changed', resultHash: 'immutable-row-hash' }),
      ],
    });
    reopened.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('returns compact mutation summaries and bounded durable receipt pages', async () => {
    const request = jest.fn(async (method: string, path: string, options?: any) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/projects/101/tasks') {
        const index = Number(String(options.body.title).split(' ')[1]);
        return {
          id: 9100 + index,
          index,
          identifier: `ALPHA-${index}`,
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

    const result = await bulkCreateTasks(
      client,
      { id: 101 },
      [{ title: 'Row 1' }, { title: 'Row 2' }, { title: 'Row 3' }],
      'paged-receipts',
      'Codex',
    );

    expect(result).toMatchObject({
      status: 'completed',
      requested: 3,
      selected: 3,
      changed: 3,
      unchanged: 0,
      skipped: 0,
      failed: 0,
      actor: 'Codex',
    });
    expect(result).not.toHaveProperty('receipts');

    const firstPage = getBulkOperationStatus(result.operationId, undefined, 2);
    expect(firstPage).toMatchObject({
      returnedCount: 2,
      totalCount: 3,
      nextCursor: '2',
      incomplete: true,
    });
    expect(firstPage.receipts).toEqual([
      expect.objectContaining({
        row: 1,
        state: 'changed',
        retryCount: 0,
        resultHash: expect.any(String),
        finalIdentity: expect.objectContaining({ portalRef: 'ALPHA-1' }),
      }),
      expect.objectContaining({ row: 2, state: 'changed' }),
    ]);
    expect(getBulkOperationStatus(result.operationId, firstPage.nextCursor, 2)).toMatchObject({
      returnedCount: 1,
      totalCount: 3,
      nextCursor: null,
      incomplete: false,
      receipts: [expect.objectContaining({ row: 3, state: 'changed' })],
    });
    expect(getBulkOperationStatus(result.operationId, undefined, 2, true)).toMatchObject({
      receipts: [],
      returnedCount: 0,
      totalCount: 3,
      nextCursor: null,
      incomplete: false,
    });
    expect(() => getBulkOperationStatus(result.operationId, '4', 2)).toThrow(
      expect.objectContaining({ status: 400, code: 'VALIDATION_ERROR' }),
    );
  });

  it('rejects direct bulk updates above the 100-task safety limit', async () => {
    const request = jest.fn();
    const client = { request, getConfig: () => ({ vikunjaToken: 'test-token' }) } as any;
    await expect(
      bulkUpdateTasks(
        client,
        Array.from({ length: 101 }, (_, index) => ({ globalId: index + 1 })),
        { done: true },
        { id: 101 },
      ),
    ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
    expect(request).not.toHaveBeenCalled();
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
    expect(assignedFirst).toMatchObject({ changed: 1, skipped: 0 });
    expect(assignedRetry).toMatchObject({ changed: 1, skipped: 1 });
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
    expect(unassignedFirst).toMatchObject({ changed: 1, skipped: 0 });
    expect(unassignedRetry).toMatchObject({ changed: 1, skipped: 1 });
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

  it('previews bulk create, update, and delete without writes or durable receipts', async () => {
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'GET' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          identifier: 'ALPHA-1',
          title: 'Preview target',
          project_id: 101,
          done: false,
          labels: [],
          assignees: [],
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

    const created = await bulkCreateTasks(
      client,
      { id: 101 },
      [{ title: 'Preview create' }],
      'dry-create',
      'Codex',
      true,
    );
    const updated = await bulkUpdateTasks(
      client,
      [{ globalId: 1 }],
      { title: 'Preview update' },
      { id: 101 },
      'dry-update',
      'Codex',
      true,
    );
    const deleted = await bulkDeleteTasks(
      client,
      [{ globalId: 1 }],
      { id: 101 },
      'dry-delete',
      'Codex',
      true,
    );

    expect([created, updated, deleted]).toEqual([
      expect.objectContaining({ status: 'preview', changed: 1, dryRun: true }),
      expect.objectContaining({ status: 'preview', changed: 1, dryRun: true }),
      expect.objectContaining({ status: 'preview', changed: 1, dryRun: true }),
    ]);
    expect([created, updated, deleted].every((result) => result.operationId === undefined)).toBe(
      true,
    );
    expect(
      request.mock.calls.some(([method]) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)),
    ).toBe(false);
  });

  it('previews status, label, and evidence-close workflows without writes', async () => {
    const request = jest.fn(async (method: string, path: string) => {
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'GET' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          identifier: 'ALPHA-1',
          title: 'Workflow preview',
          project_id: 101,
          done: false,
          labels: [
            { id: 7, title: 'status:todo' },
            { id: 8, title: 'status:review' },
          ],
          assignees: [],
        };
      }
      throw new Error(`Unexpected ${method} ${path}`);
    });
    const client = {
      request,
      getConfig: () => ({
        statusLabelPrefix: 'status:',
        vikunjaWebUrl: 'https://vikunja.example.com/',
        vikunjaToken: 'test-token',
      }),
    } as any;
    const common = {
      dryRun: true,
      idempotencyKey: 'workflow-preview',
      actor: 'Codex',
    };

    const status = await bulkWorkflowTasks(
      client,
      'set_status',
      [{ globalId: 1 }],
      { id: 101 },
      {
        ...common,
        statusLabel: 'status:review',
      },
    );
    const applied = await bulkWorkflowTasks(
      client,
      'apply-label',
      [{ globalId: 1 }],
      { id: 101 },
      {
        ...common,
        labelTitle: 9,
      },
    );
    const removed = await bulkWorkflowTasks(
      client,
      'remove-label',
      [{ globalId: 1 }],
      { id: 101 },
      {
        ...common,
        labelTitle: 7,
      },
    );
    const closed = await bulkWorkflowTasks(
      client,
      'close_with_evidence',
      [{ globalId: 1 }],
      { id: 101 },
      { ...common, evidenceComment: 'PASS: preview evidence' },
    );

    expect([status, applied, removed, closed]).toEqual([
      expect.objectContaining({ status: 'preview', changed: 1, dryRun: true }),
      expect.objectContaining({ status: 'preview', changed: 1, dryRun: true }),
      expect.objectContaining({ status: 'preview', changed: 1, dryRun: true }),
      expect.objectContaining({ status: 'preview', changed: 1, dryRun: true }),
    ]);
    expect(
      request.mock.calls.some(([method]) => ['POST', 'PATCH', 'PUT', 'DELETE'].includes(method)),
    ).toBe(false);
  });

  it('returns cached bulk-update and bulk-delete receipts without repeated writes', async () => {
    const request = jest.fn(async (method: string, path: string, options?: any) => {
      if (method === 'PATCH' && path === '/tasks/1') {
        return {
          id: 1,
          index: 1,
          identifier: 'ALPHA-1',
          project_id: 101,
          project: { id: 101, title: 'Alpha' },
          title: 'Delete target',
          done: options.body.done,
          labels: [],
          assignees: [],
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
    const updateWrites = request.mock.calls.filter(([method]) => method === 'PATCH').length;
    const updateRetry = await bulkUpdateTasks(client, [1], { done: true }, undefined, 'update-1');
    expect(updateRetry).toMatchObject({ changed: 1, skipped: 1 });
    expect(updateFirst).toMatchObject({ status: 'completed', changed: 1, failed: 0 });
    expect(request.mock.calls.filter(([method]) => method === 'PATCH')).toHaveLength(updateWrites);

    const deleteFirst = await bulkDeleteTasks(client, [1], undefined, 'delete-1');
    const deleteWrites = request.mock.calls.filter(([method]) => method === 'DELETE').length;
    const deleteRetry = await bulkDeleteTasks(client, [1], undefined, 'delete-1');
    expect(deleteFirst).toMatchObject({ changed: 1, skipped: 0 });
    expect(deleteRetry).toMatchObject({ changed: 1, skipped: 1 });
    expect(request.mock.calls.filter(([method]) => method === 'DELETE')).toHaveLength(deleteWrites);
  });
});
