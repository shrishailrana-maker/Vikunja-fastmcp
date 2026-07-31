/**
 * Mutation policy, attribution, project summary, and status-label workflow tests.
 */

import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import { loadConfig } from '../src/config.js';
import { createComment } from '../src/comments.js';
import { cache } from '../src/identity.js';
import { enforceMutationProjectScope, withActorAttribution } from '../src/mutation-policy.js';
import { createTask, projectSummary, setTaskStatus } from '../src/tasks.js';

const TEST_TOKEN = `tk_${'a'.repeat(40)}`;

describe('workflow policy and compact project workflows', () => {
  const baseConfig = {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    vikunjaToken: TEST_TOKEN,
    vikunjaWebUrl: 'https://vikunja.example.com/',
    attachmentDownloadRoot: '/tmp/vikunja-tests',
    mutationScopeMode: 'warn' as const,
    statusLabelPrefix: 'status:',
  };

  let client: VikunjaApiClient;
  let mockFetch: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    cache.clearLabels();
    cache.clearProjects();
    client = new VikunjaApiClient(baseConfig);
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
    jest.restoreAllMocks();
  });

  it('defaults mutation scoping to require and accepts warn explicitly', () => {
    const baseEnv = {
      VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
      VIKUNJA_API_TOKEN: TEST_TOKEN,
    };
    expect(loadConfig(baseEnv).mutationScopeMode).toBe('require');
    expect(loadConfig({ ...baseEnv, VIKUNJA_MUTATION_SCOPE_MODE: 'warn' }).mutationScopeMode).toBe(
      'warn',
    );
  });

  it('warns for an unscoped global-id mutation and can require scope', () => {
    const warn = jest.fn();
    enforceMutationProjectScope('warn', 'vikunja_tasks.update', 42, undefined, warn);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('42'));

    expect(() =>
      enforceMutationProjectScope('require', 'vikunja_tasks.update', '42', undefined, warn),
    ).toThrow(expect.objectContaining({ status: 400, code: 'PROJECT_SCOPE_REQUIRED' }));

    expect(() =>
      enforceMutationProjectScope('require', 'vikunja_tasks.update', 42, { id: 7 }, warn),
    ).not.toThrow();
  });

  it('appends actor attribution once and persists it on task/comment creation', async () => {
    expect(withActorAttribution('Verified.', 'Codex')).toBe('Verified.\n\n(by Codex)');
    expect(withActorAttribution('Verified.\n\n(by Codex)', 'Codex')).toBe(
      'Verified.\n\n(by Codex)',
    );
    expect(withActorAttribution('Verified.\n\nby Codex', 'Codex')).toBe('Verified.\n\n(by Codex)');
    expect(withActorAttribution('Verified.\n\nActor: Codex', 'Codex')).toBe(
      'Verified.\n\n(by Codex)',
    );
    expect(withActorAttribution('Verified.\n\nby Codex (as example-user)', 'Codex')).toBe(
      'Verified.\n\n(by Codex)',
    );
    expect(withActorAttribution('Verified.\n\n(by Codex)\n\n(by Codex)', 'Codex')).toBe(
      'Verified.\n\n(by Codex)',
    );

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 7, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({ id: 42, index: 5, title: 'Attributed task', project_id: 7 }),
      } as Response);

    await createTask(
      client,
      { id: 7 },
      { title: 'Attributed task', description: 'Created from a verified report.\n\nby Codex' },
      undefined,
      undefined,
      'Codex',
    );
    const taskPost = mockFetch.mock.calls.find(
      (call) => (call[1] as RequestInit)?.method === 'POST',
    );
    const taskDescription = JSON.parse((taskPost![1] as RequestInit).body as string)
      .description as string;
    expect(taskDescription).toContain('(by Codex)');
    expect(taskDescription.match(/by Codex/g)).toHaveLength(1);

    mockFetch.mockReset();
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 42,
            index: 5,
            title: 'Attributed task',
            project_id: 7,
            project: { title: 'Alpha' },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 9,
            comment: '<p>Evidence.</p><p>(by Claude)</p>',
            author: { id: 1, username: 'example-user' },
            created: '2026-07-22T00:00:00Z',
          }),
      } as Response);

    await createComment(client, 42, 'Evidence.\n\nActor: Claude', undefined, undefined, 'Claude');
    const commentPost = mockFetch.mock.calls.find(
      (call) => (call[1] as RequestInit)?.method === 'POST',
    );
    const commentBody = JSON.parse((commentPost![1] as RequestInit).body as string)
      .comment as string;
    expect(commentBody).toContain('(by Claude)');
    expect(commentBody.match(/by Claude/g)).toHaveLength(1);
  });

  it('returns a project-only aggregate without task bodies', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 7, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 1,
                done: false,
                priority: 5,
                labels: [
                  { id: 10, title: 'status:review' },
                  { id: 11, title: 'phase:one' },
                ],
              },
              {
                id: 2,
                done: true,
                priority: 2,
                labels: [{ id: 10, title: 'status:review' }],
              },
              { id: 3, done: false, priority: 0, labels: [] },
            ],
            page: 1,
            per_page: 100,
            total: 3,
            total_pages: 1,
          }),
      } as Response);

    const result = await projectSummary(client, { id: 7 });
    expect(result).toMatchObject({
      project: { id: 7, title: 'Alpha' },
      total: 3,
      open: 2,
      done: 1,
      byPriority: { '0': 1, '2': 1, '5': 1 },
      byStatusLabel: [{ label: 'status:review', total: 2, open: 1, done: 1 }],
    });
    expect(JSON.stringify(result)).not.toContain('items');
    expect(result.byLabel).toContainEqual({ label: 'phase:one', total: 1, open: 1, done: 0 });
  });

  it('replaces all status labels in one bulk request and reports repair', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 42,
            index: 5,
            identifier: 'ALPHA-5',
            title: 'Status task',
            project_id: 7,
            project: { title: 'Alpha' },
            labels: [
              { id: 1, title: 'bug' },
              { id: 2, title: 'status:todo' },
              { id: 3, title: 'status:blocked' },
            ],
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [{ id: 4, title: 'status:review' }],
            page: 1,
            per_page: 50,
            total: 1,
            total_pages: 1,
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ labels: [] }),
      } as Response);

    const result = await setTaskStatus(client, 42, 'status:review', undefined, false);
    expect(result).toMatchObject({
      action: 'updated',
      statusLabel: 'status:review',
      removedStatusLabels: ['status:todo', 'status:blocked'],
      repaired: true,
    });
    const bulkPut = mockFetch.mock.calls.find((call) =>
      String(call[0]).endsWith('/tasks/42/labels/bulk'),
    );
    expect((bulkPut![1] as RequestInit).method).toBe('PUT');
    expect(JSON.parse((bulkPut![1] as RequestInit).body as string)).toEqual({
      labels: [
        { id: 1, title: 'bug' },
        { id: 4, title: 'status:review' },
      ],
    });
  });

  it('does not create a missing status label unless explicitly requested', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 42,
            index: 5,
            identifier: 'ALPHA-5',
            title: 'Status task',
            project_id: 7,
            project: { title: 'Alpha' },
            labels: [{ id: 1, title: 'bug' }],
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ items: [], page: 1, per_page: 50, total: 0, total_pages: 0 }),
      } as Response);

    await expect(setTaskStatus(client, 42, 'status:review')).rejects.toMatchObject({
      status: 404,
      code: 'LABEL_NOT_FOUND',
    });
    expect(mockFetch.mock.calls.some((call) => (call[1] as RequestInit)?.method === 'POST')).toBe(
      false,
    );
  });
});
