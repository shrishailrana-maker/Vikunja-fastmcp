import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import { cache } from '../src/identity.js';
import {
  batchGetTasks,
  lookupTaskByExternalKey,
  programmeSnapshot,
  verifyTaskState,
} from '../src/tasks.js';

const config = {
  vikunjaUrl: 'https://vikunja.example.com/api/v2',
  vikunjaToken: 'tk_test',
  vikunjaWebUrl: 'https://vikunja.example.com/',
  attachmentDownloadRoot: '/tmp',
};

function response(data: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) } as Response;
}

describe('bounded task read workflows', () => {
  let client: VikunjaApiClient;
  let mockFetch: any;

  beforeEach(() => {
    cache.clearProjects();
    client = new VikunjaApiClient(config);
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => mockFetch.mockRestore());

  it('gets several full human identifiers in one bounded MCP operation', async () => {
    mockFetch
      .mockResolvedValueOnce(
        response({
          items: [{ id: 101, title: 'Alpha', identifier: 'ALPHA' }],
          page: 1,
          per_page: 100,
          total: 1,
          total_pages: 1,
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [{ id: 9001, index: 1, identifier: 'ALPHA-1', project_id: 101, title: 'One' }],
          page: 1,
          per_page: 2,
          total: 1,
          total_pages: 1,
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [{ id: 9002, index: 2, identifier: 'ALPHA-2', project_id: 101, title: 'Two' }],
          page: 1,
          per_page: 2,
          total: 1,
          total_pages: 1,
        }),
      );

    const result = await batchGetTasks(client, ['ALPHA-1', 'ALPHA-2'], {
      fields: ['portalRef', 'title'],
    });

    expect(result).toEqual({
      requested: 2,
      returnedCount: 2,
      tasks: [
        { portalRef: 'ALPHA-1', title: 'One' },
        { portalRef: 'ALPHA-2', title: 'Two' },
      ],
      failed: [],
      incomplete: false,
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('returns QA state, latest evidence, attachments, and relations in three API calls', async () => {
    const task = {
      id: 9005,
      index: 5,
      identifier: 'ALPHA-5',
      project_id: 101,
      project: { title: 'Alpha' },
      title: 'Verification target',
      done: false,
      labels: [{ id: 2, title: 'status:review' }],
      assignees: [{ id: 7, username: 'developer' }],
      related_tasks: {
        blocked: [{ id: 9010, identifier: 'ALPHA-10', title: 'Dependency' }],
      },
    };
    mockFetch
      .mockResolvedValueOnce(response(task))
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 44,
              comment: '<p>PASS: verified</p>',
              author: { id: 8, username: 'tester' },
              created: '2026-07-20T10:00:00Z',
            },
          ],
          page: 1,
          per_page: 5,
          total: 1,
          total_pages: 1,
        }),
      )
      .mockResolvedValueOnce(
        response({
          items: [{ id: 55, file: { name: 'evidence.zip', mime: 'application/zip', size: 42 } }],
          page: 1,
          per_page: 100,
          total: 1,
          total_pages: 1,
        }),
      );

    const result = await verifyTaskState(client, { globalId: 9005 }, { id: 101 });

    expect(result).toMatchObject({
      identifier: 'ALPHA-5',
      done: false,
      labels: ['status:review'],
      assignees: ['developer'],
      attachmentCount: 1,
      attachments: [{ id: 55, fileName: 'evidence.zip' }],
      relationCount: 1,
      relations: [{ kind: 'blocked', identifier: 'ALPHA-10', title: 'Dependency' }],
      commentCount: 1,
      latestCommentAt: '2026-07-20T10:00:00Z',
      latestVerification: { id: 44, verdict: 'PASS', actor: 'tester' },
    });
    expect(mockFetch).toHaveBeenCalledTimes(3);
  });

  it('builds one programme snapshot with assignee, blocked, stale, and changed counts', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ id: 101, title: 'Alpha' }))
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 1,
              identifier: 'ALPHA-1',
              title: 'Open stale',
              done: false,
              priority: 5,
              updated: '2026-01-01T00:00:00Z',
              labels: [{ title: 'status:open' }],
              assignees: [{ username: 'developer' }],
              related_tasks: { blocked: [{ id: 9 }] },
            },
            {
              id: 2,
              identifier: 'ALPHA-2',
              title: 'Done',
              done: true,
              priority: 1,
              updated: '2026-07-20T00:00:00Z',
              labels: [{ title: 'status:done' }],
              assignees: [{ username: 'tester' }],
            },
          ],
          page: 1,
          per_page: 100,
          total: 2,
          total_pages: 1,
        }),
      );

    const result = await programmeSnapshot(client, { id: 101 }, {
      staleDays: 1,
      changedSince: '2026-07-01T00:00:00Z',
      now: new Date('2026-08-01T00:00:00Z'),
    });

    expect(result).toMatchObject({
      project: { id: 101, title: 'Alpha' },
      total: 2,
      open: 1,
      done: 1,
      blocked: 1,
      stale: 1,
      byAssignee: { developer: 1, tester: 1 },
      changedCount: 1,
      returnedCount: 1,
      totalCount: 1,
      nextCursor: null,
      incomplete: false,
    });
    expect(result.changedTasks).toEqual([{ identifier: 'ALPHA-2', title: 'Done', done: true }]);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('offers an MPF reconciliation preset without a second aggregation pass', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ id: 101, title: 'Alpha' }))
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 1,
              identifier: 'ALPHA-1',
              title: 'Needs status',
              done: false,
              labels: [{ title: 'phase:build' }],
              assignees: [],
            },
            {
              id: 2,
              identifier: 'ALPHA-2',
              title: 'Conflicting status',
              done: false,
              labels: [{ title: 'status:open' }, { title: 'status:review' }, { title: 'phase:test' }],
              assignees: [{ username: 'tester' }],
            },
          ],
          page: 1,
          per_page: 100,
          total: 2,
          total_pages: 1,
        }),
      );

    const result = await programmeSnapshot(client, { id: 101 }, { preset: 'mpf' });

    expect(result.reconciliation).toEqual({
      unassignedOpen: 1,
      missingStatus: 1,
      multipleStatus: 1,
      byPhaseLabel: { 'phase:build': 1, 'phase:test': 1 },
    });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('continues snapshot changes with a stable updated/id cursor', async () => {
    const items = [
      { id: 1, index: 1, identifier: 'ALPHA-1', title: 'One', updated: '2026-07-20T00:00:00Z' },
      { id: 2, index: 2, identifier: 'ALPHA-2', title: 'Two', updated: '2026-07-20T00:00:00Z' },
    ];
    const collection = { items, page: 1, per_page: 100, total: 2, total_pages: 1 };
    mockFetch
      .mockResolvedValueOnce(response({ id: 101, title: 'Alpha' }))
      .mockResolvedValueOnce(response(collection))
      .mockResolvedValueOnce(response({ id: 101, title: 'Alpha' }))
      .mockResolvedValueOnce(response(collection));

    const first = await programmeSnapshot(client, { id: 101 }, {
      changedSince: '2026-07-01T00:00:00Z',
      changedLimit: 1,
    });
    const second = await programmeSnapshot(client, { id: 101 }, {
      changedSince: '2026-07-01T00:00:00Z',
      changedLimit: 1,
      cursor: first.nextCursor ?? undefined,
    });

    expect(first.changedTasks.map((task: any) => task.identifier)).toEqual(['ALPHA-1']);
    expect(first.incomplete).toBe(true);
    expect(second.changedTasks.map((task: any) => task.identifier)).toEqual(['ALPHA-2']);
    expect(second.nextCursor).toBeNull();
  });

  it('looks up a stable external key without listing the whole project', async () => {
    mockFetch
      .mockResolvedValueOnce(response({ id: 101, title: 'Alpha' }))
      .mockResolvedValueOnce(
        response({
          items: [
            {
              id: 9005,
              index: 5,
              identifier: 'ALPHA-5',
              project_id: 101,
              title: 'Existing',
              description: 'Body\n\n[vfm-key:file:5]',
            },
          ],
          page: 1,
          per_page: 5,
          total: 1,
          total_pages: 1,
        }),
      );

    const result = await lookupTaskByExternalKey(client, { id: 101 }, 'file:5');
    expect(result).toEqual({
      externalKey: 'file:5',
      task: { id: 9005, portalRef: 'ALPHA-5', title: 'Existing' },
    });
    expect(String(mockFetch.mock.calls[1][0])).toContain('per_page=5');
  });
});
