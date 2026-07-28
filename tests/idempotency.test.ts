import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jest } from '@jest/globals';
import {
  claimDurableOperation,
  idempotency,
  IdempotencyCache,
  runDurableOperation,
} from '../src/idempotency.js';

describe('durable idempotency ledger', () => {
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
});
