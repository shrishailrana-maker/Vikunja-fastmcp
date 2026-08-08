import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import {
  configureIdempotencyScope,
  claimDurableOperation,
  durableOperationKey,
  idempotency,
  IdempotencyCache,
  lookupDurableOperationReceipt,
  runDurableOperation,
} from '../src/idempotency.js';

describe('durable idempotency ledger', () => {
  it('isolates durable operation keys by configured credential', () => {
    configureIdempotencyScope('neutral-token-a');
    const first = durableOperationKey('task-update', 'same-key', { taskId: 1 });
    configureIdempotencyScope('neutral-token-b');
    const second = durableOperationKey('task-update', 'same-key', { taskId: 1 });
    expect(second).not.toBe(first);
    configureIdempotencyScope('test-token');
  });
  it('retains a receipt after the cache is closed and reopened', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vikunja-fastmcp-ledger-'));
    const databasePath = join(directory, 'idempotency.sqlite');

    try {
      const first = new IdempotencyCache({ databasePath });
      first.set('comment:99:retry-key', { id: 5001, action: 'created' });
      first.close();

      const reopened = new IdempotencyCache({ databasePath });
      expect(reopened.get('comment:99:retry-key')).toEqual({
        id: 5001,
        action: 'created',
      });
      reopened.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('atomically shares one claim across two local processes', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vikunja-fastmcp-claim-'));
    const databasePath = join(directory, 'idempotency.sqlite');

    try {
      const first = new IdempotencyCache({ databasePath });
      const second = new IdempotencyCache({ databasePath });
      expect(first.claim('task-create:claim:key', { operationKey: 'first' })).toBeNull();
      expect(second.claim('task-create:claim:key', { operationKey: 'second' })).toEqual({
        operationKey: 'first',
      });
      first.close();
      second.close();
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('renews an active lease and marks an expired running write outcome unknown', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vikunja-fastmcp-lease-'));
    const databasePath = join(directory, 'idempotency.sqlite');
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    let first: IdempotencyCache | undefined;
    let second: IdempotencyCache | undefined;

    try {
      first = new IdempotencyCache({ databasePath });
      second = new IdempotencyCache({ databasePath });
      const acquired = first.acquireLease('task-create:lease', { status: 'running' }, 100);

      expect(acquired.acquired).toBe(true);
      expect(acquired.leaseToken).toEqual(expect.any(String));

      now.mockReturnValue(1_080);
      expect(first.renewLease('task-create:lease', acquired.leaseToken!, 100)).toBe(true);

      now.mockReturnValue(1_150);
      expect(second.acquireLease('task-create:lease', { status: 'running' }, 100).acquired).toBe(
        false,
      );

      now.mockReturnValue(1_181);
      const takeover = second.acquireLease('task-create:lease', { status: 'running' }, 100);
      expect(takeover).toMatchObject({ acquired: false, value: { status: 'outcome_unknown' } });
      expect(first.renewLease('task-create:lease', acquired.leaseToken!, 100)).toBe(false);
    } finally {
      first?.close();
      second?.close();
      now.mockRestore();
      rmSync(directory, { force: true, recursive: true });
    }
  });

  it('persists operation state only for the current unexpired lease owner', () => {
    const cache = new IdempotencyCache({ databasePath: ':memory:' });
    const now = jest.spyOn(Date, 'now').mockReturnValue(1_000);
    try {
      const acquired = cache.acquireLease('migration:lease', { status: 'running' }, 100);
      expect(
        cache.setIfLeaseOwner('migration:lease', acquired.leaseToken!, {
          status: 'running',
          receipts: [{ row: 1 }],
        }),
      ).toBe(true);
      expect(cache.setIfLeaseOwner('migration:lease', 'wrong-token', { status: 'completed' })).toBe(
        false,
      );
      now.mockReturnValue(1_101);
      expect(
        cache.setIfLeaseOwner('migration:lease', acquired.leaseToken!, { status: 'completed' }),
      ).toBe(false);
      expect(cache.get('migration:lease')).toMatchObject({
        status: 'running',
        receipts: [{ row: 1 }],
      });
    } finally {
      now.mockRestore();
      cache.close();
    }
  });

  it('does not let a stale worker mark or release another owner lease', () => {
    const cache = new IdempotencyCache({ databasePath: ':memory:' });
    try {
      const acquired = cache.acquireLease('task-create:owned', { status: 'running' }, 10_000);
      expect(cache.markOutcomeUnknown('task-create:owned', 'stale-token')).toBe(false);
      expect(cache.renewLease('task-create:owned', acquired.leaseToken!, 10_000)).toBe(true);
      expect(cache.markOutcomeUnknown('task-create:owned', acquired.leaseToken!)).toBe(true);
      expect(cache.get('task-create:owned')).toMatchObject({ status: 'outcome_unknown' });
      expect(cache.renewLease('task-create:owned', acquired.leaseToken!, 10_000)).toBe(false);
    } finally {
      cache.close();
    }
  });

  it('lists operation receipts by namespace for resumable bulk status', () => {
    const cache = new IdempotencyCache({ databasePath: ':memory:' });
    cache.set('bulk-operation:alpha', { operationId: 'alpha', status: 'partial' });
    cache.set('bulk-operation:beta', { operationId: 'beta', status: 'completed' });
    cache.set('comment:1:key', { id: 10 });

    expect(cache.list('bulk-operation:')).toEqual([
      { operationId: 'alpha', status: 'partial' },
      { operationId: 'beta', status: 'completed' },
    ]);
    cache.close();
  });

  it('rejects a caller key reused with a different payload', () => {
    idempotency.clear();
    expect(claimDurableOperation('comment-create', 'retry-1', { comment: 'First' })).toBe(
      claimDurableOperation('comment-create', 'retry-1', { comment: 'First' }),
    );
    expect(() =>
      claimDurableOperation('comment-create', 'retry-1', { comment: 'Different' }),
    ).toThrow(expect.objectContaining({ code: 'IDEMPOTENCY_KEY_REUSED', status: 409 }));
  });

  it('releases a claim when explicit preflight fails before the remote write starts', async () => {
    idempotency.clear();
    const write = jest.fn(async () => ({ id: 7001, action: 'created' }));

    await expect(
      runDurableOperation('task-create', 'preflight-key', { project: 'Missing' }, write, {
        preflight: async () => {
          throw new Error('project lookup failed');
        },
      }),
    ).rejects.toThrow('project lookup failed');
    await expect(
      runDurableOperation('task-create', 'preflight-key', { project: 101 }, write),
    ).resolves.toMatchObject({ id: 7001 });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('returns a completed receipt without rerunning preflight', async () => {
    idempotency.clear();
    const preflight = jest.fn(async () => {});
    const write = jest.fn(async () => ({ id: 7001, action: 'created' }));
    const options = { preflight };

    await runDurableOperation('task-create', 'receipt-preflight', { project: 101 }, write, options);
    await runDurableOperation('task-create', 'receipt-preflight', { project: 101 }, write, options);

    expect(preflight).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('prevents parallel duplicate writes and returns the durable result on retry', async () => {
    idempotency.clear();
    let release!: () => void;
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    const write = jest.fn(async () => {
      started();
      await releasePromise;
      return { id: 7001, action: 'created' };
    });

    const first = runDurableOperation('task-create', 'parallel-key', { title: 'A' }, write);
    await startedPromise;
    await expect(
      runDurableOperation('task-create', 'parallel-key', { title: 'A' }, write),
    ).rejects.toMatchObject({
      code: 'IDEMPOTENCY_OPERATION_IN_PROGRESS',
      status: 409,
    });
    release();
    await expect(first).resolves.toEqual({ id: 7001, action: 'created' });
    await expect(
      runDurableOperation('task-create', 'parallel-key', { title: 'A' }, write),
    ).resolves.toEqual({ id: 7001, action: 'created' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('does not finalize a durable operation after lease ownership is lost', async () => {
    idempotency.clear();
    const renew = jest.spyOn(idempotency, 'renewLease').mockReturnValue(false);
    const persist = jest.spyOn(idempotency, 'setIfLeaseOwner');
    const write = jest.fn(async () => ({ id: 7001, action: 'created' }));

    await expect(
      runDurableOperation('task-create', 'lost-lease', { title: 'A' }, write),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_LEASE_LOST' });

    expect(write).not.toHaveBeenCalled();
    expect(
      idempotency.get(durableOperationKey('task-create', 'lost-lease', { title: 'A' }))?.status,
    ).not.toBe('failed');
    expect(persist).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.objectContaining({ status: 'completed' }),
    );
    renew.mockRestore();
    persist.mockRestore();
  });

  it('looks up a completed receipt by its caller idempotency key', async () => {
    idempotency.clear();
    await runDurableOperation('task-create', 'human-retry-key', { title: 'A' }, async () => ({
      action: 'created',
      target: { portalRef: 'ALPHA-5' },
    }));

    expect(lookupDurableOperationReceipt('task-create', 'human-retry-key')).toMatchObject({
      operation: 'task-create',
      status: 'completed',
      result: { action: 'created', target: { portalRef: 'ALPHA-5' } },
      updatedAt: expect.any(String),
    });
  });

  it('does not cache a partial workflow receipt as completed', async () => {
    const write = jest
      .fn<() => Promise<any>>()
      .mockResolvedValueOnce({ action: 'partial', outcome: 'partial' })
      .mockResolvedValueOnce({ action: 'updated', outcome: 'completed' });

    const first = await runDurableOperation('workflow', 'retry-partial', { task: 1 }, write);
    const second = await runDurableOperation('workflow', 'retry-partial', { task: 1 }, write);

    expect(first).toMatchObject({ outcome: 'partial' });
    expect(second).toMatchObject({ outcome: 'completed' });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('blocks replay when a remote write result is ambiguous', async () => {
    idempotency.clear();
    const write = jest.fn(async () => {
      throw new Error('socket closed after dispatch');
    });

    await expect(
      runDurableOperation('task-create', 'ambiguous-write', { title: 'A' }, write),
    ).rejects.toThrow('socket closed after dispatch');
    await expect(
      runDurableOperation('task-create', 'ambiguous-write', { title: 'A' }, write),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('blocks replay when lease ownership is lost after the remote write returns', async () => {
    idempotency.clear();
    const renew = jest
      .spyOn(idempotency, 'renewLease')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    const write = jest.fn(async () => ({ id: 7001, action: 'created' }));

    await expect(
      runDurableOperation('task-create', 'post-write-lease-loss', { title: 'A' }, write),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_LEASE_LOST' });
    await expect(
      runDurableOperation('task-create', 'post-write-lease-loss', { title: 'A' }, write),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_OUTCOME_UNKNOWN' });

    expect(write).toHaveBeenCalledTimes(1);
    renew.mockRestore();
  });
});
