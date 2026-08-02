import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import { VikunjaError } from '../src/errors.js';
import { cache } from '../src/identity.js';
import {
  appendEvidenceIfChanged,
  closeIfVerified,
  closeWithEvidence,
  type VerificationEvidence,
} from '../src/tasks.js';

const config = {
  vikunjaUrl: 'https://vikunja.example.com/api/v2',
  vikunjaToken: 'tk_test',
  vikunjaWebUrl: 'https://vikunja.example.com/',
  attachmentDownloadRoot: '/tmp',
};

const task = {
  id: 9005,
  index: 5,
  identifier: 'ALPHA-5',
  project_id: 101,
  project: { title: 'Alpha' },
  title: 'Evidence target',
  description: '<p>Body</p>',
  done: false,
  priority: 1,
  labels: [],
  assignees: [],
  updated: '2026-07-23T00:00:00Z',
};

const evidence: VerificationEvidence = {
  command: 'npm test',
  result: 'PASS: 12 tests',
  timestamp: '2026-07-23T12:00:00Z',
  evidenceKey: 'revision:abc123',
  revision: 'abc123',
};

describe('structured evidence workflows', () => {
  let client: VikunjaApiClient;

  beforeEach(() => {
    cache.clearProjects();
    client = new VikunjaApiClient(config);
  });

  afterEach(() => jest.restoreAllMocks());

  it('returns NO CHANGE when the same evidence key is already present', async () => {
    const request = jest.spyOn(client, 'request').mockImplementation(async (method, path) => {
      if (method !== 'GET') throw new Error(`unexpected write ${method}`);
      if (path === '/tasks/9005') return task;
      if (path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (path.startsWith('/tasks/9005/comments')) {
        return {
          items: [{ id: 7, comment: '<p>PASS</p><p>[vfm-evidence:revision:abc123]</p>' }],
          page: 1,
          per_page: 100,
          total: 1,
          total_pages: 1,
        };
      }
      throw new Error(`unexpected read ${path}`);
    });

    const result = await appendEvidenceIfChanged(
      client,
      { globalId: 9005 },
      evidence,
      { id: 101 },
      'evidence-existing',
      'Codex',
    );

    expect(result).toMatchObject({
      action: 'unchanged',
      evidenceKey: 'revision:abc123',
      commentId: 7,
    });
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('reports a partial outcome when evidence persists but closing fails', async () => {
    let patchAttempted = false;
    jest.spyOn(client, 'request').mockImplementation(async (method, path) => {
      if (method === 'GET' && path === '/tasks/9005') {
        return patchAttempted ? { ...task, done: true } : task;
      }
      if (method === 'GET' && path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (method === 'POST' && path === '/tasks/9005/comments') {
        return {
          id: 8,
          comment: '<p>PASS</p><p>(by Codex)</p>',
          author: { id: 1, username: 'example-user' },
          created: '2026-07-23T12:01:00Z',
        };
      }
      if (method === 'PATCH' && path === '/tasks/9005') {
        patchAttempted = true;
        throw new VikunjaError({
          status: 503,
          code: 'TEMPORARY_FAILURE',
          method,
          path,
          message: 'Close failed after comment persisted.',
          fieldErrors: [],
        });
      }
      throw new Error(`unexpected ${method} ${path}`);
    });

    const result = await closeWithEvidence(
      client,
      { globalId: 9005 },
      'PASS',
      { id: 101 },
      undefined,
      'Codex',
    );

    expect(result).toMatchObject({
      outcome: 'partial',
      evidenceStatus: 'created',
      taskStatus: 'closed',
      changed: ['comment'],
      error: { status: 503, code: 'TEMPORARY_FAILURE' },
    });
  });

  it('previews a verified close without writing', async () => {
    const request = jest.spyOn(client, 'request').mockImplementation(async (method, path) => {
      if (method !== 'GET') throw new Error(`unexpected write ${method}`);
      if (path === '/tasks/9005') return task;
      if (path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (path.startsWith('/tasks/9005/comments')) {
        return {
          items: [{ id: 9, comment: '<p>PASS: verified</p>', created: '2026-07-23T12:02:00Z' }],
          page: 1,
          per_page: 100,
          total: 1,
          total_pages: 1,
        };
      }
      throw new Error(`unexpected read ${path}`);
    });

    const result = await closeIfVerified(client, { globalId: 9005 }, { id: 101 }, true);
    expect(result).toMatchObject({
      action: 'would_update',
      operation: 'close_if_verified',
      verification: { commentId: 9 },
      dryRun: true,
    });
    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });

  it('does not close when a newer FAIL supersedes an older PASS verdict', async () => {
    jest.spyOn(client, 'request').mockImplementation(async (method, path) => {
      if (method !== 'GET') throw new Error(`unexpected write ${method}`);
      if (path === '/tasks/9005') return task;
      if (path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (path.startsWith('/tasks/9005/comments')) {
        return {
          items: [
            {
              id: 9,
              comment: '<p>PASS: earlier run</p>',
              created: '2026-07-23T12:01:00Z',
            },
            {
              id: 10,
              comment: '<p>FAIL: tests did not pass</p>',
              created: '2026-07-23T12:02:00Z',
            },
          ],
          page: 1,
          per_page: 100,
          total: 2,
          total_pages: 1,
        };
      }
      throw new Error(`unexpected read ${path}`);
    });

    await expect(
      closeIfVerified(client, { globalId: 9005 }, { id: 101 }, true),
    ).rejects.toMatchObject({ code: 'VERIFICATION_REQUIRED', status: 409 });
  });
});
