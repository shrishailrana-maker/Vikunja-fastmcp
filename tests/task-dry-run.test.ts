import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import { cache } from '../src/identity.js';
import {
  applyLabel,
  assignTask,
  closeWithEvidence,
  createTask,
  deleteTask,
  relateTask,
  setTaskStatus,
  updateTask,
} from '../src/tasks.js';

const config = {
  vikunjaUrl: 'https://vikunja.example.com/api/v2',
  vikunjaToken: 'tk_test',
  vikunjaWebUrl: 'https://vikunja.example.com/',
  attachmentDownloadRoot: '/tmp',
  statusLabelPrefix: 'status:',
};

describe('task mutation dry runs', () => {
  let client: VikunjaApiClient;
  let request: jest.SpiedFunction<VikunjaApiClient['request']>;

  beforeEach(() => {
    cache.clearProjects();
    cache.clearLabels();
    client = new VikunjaApiClient(config);
    request = jest.spyOn(client, 'request').mockImplementation(async (method, path) => {
      if (method !== 'GET') throw new Error(`unexpected write ${method} ${path}`);
      if (path === '/projects/101') return { id: 101, title: 'Alpha' };
      if (path === '/tasks/9006') {
        return {
          id: 9006,
          index: 6,
          identifier: 'ALPHA-6',
          project_id: 101,
          project: { title: 'Alpha' },
          title: 'Other task',
          labels: [],
          assignees: [],
        };
      }
      if (path === '/tasks/9005') {
        return {
          id: 9005,
          index: 5,
          identifier: 'ALPHA-5',
          project_id: 101,
          project: { title: 'Alpha' },
          title: 'Target task',
          description: '<p>Current</p>',
          done: false,
          priority: 1,
          labels: [{ id: 10, title: 'status:todo' }],
          assignees: [],
          updated: '2026-07-23T00:00:00Z',
        };
      }
      if (path.startsWith('/labels')) {
        return { items: [], page: 1, per_page: 50, total: 0, total_pages: 0 };
      }
      throw new Error(`unexpected read ${path}`);
    });
  });

  afterEach(() => jest.restoreAllMocks());

  it('previews every task mutation family without issuing a write', async () => {
    const project = { id: 101 };
    const task = { globalId: 9005 } as const;

    await expect(
      createTask(client, project, { title: 'New task' }, undefined, undefined, 'Codex', true),
    ).resolves.toMatchObject({ action: 'would_create', dryRun: true });
    await expect(
      updateTask(client, task, { priority: 5 }, project, undefined, true),
    ).resolves.toMatchObject({
      action: 'would_update',
      changed: ['priority'],
      before: { priority: 1 },
      after: { priority: 5 },
      dryRun: true,
    });
    await expect(deleteTask(client, task, project, true)).resolves.toMatchObject({
      action: 'would_delete',
      dryRun: true,
    });
    await expect(assignTask(client, task, 7, project, true)).resolves.toMatchObject({
      operation: 'assign',
      before: { assigneeIds: [] },
      after: { assigneeIds: [7] },
      dryRun: true,
    });
    await expect(applyLabel(client, task, 'new-label', project, true)).resolves.toMatchObject({
      operation: 'apply-label',
      wouldCreateLabel: 'new-label',
      dryRun: true,
    });
    await expect(
      setTaskStatus(client, task, 'status:review', project, true, true),
    ).resolves.toMatchObject({
      operation: 'set_status',
      wouldCreateLabel: true,
      before: { statusLabels: ['status:todo'] },
      after: { statusLabels: ['status:review'] },
      dryRun: true,
    });
    await expect(
      relateTask(client, task, { globalId: 9006 }, 'blocking', project, true),
    ).resolves.toMatchObject({
      operation: 'relate',
      otherTask: { identifier: 'ALPHA-6', title: 'Other task' },
      dryRun: true,
    });
    await expect(
      closeWithEvidence(client, task, 'PASS', project, 'dry-run-close', 'Codex', true),
    ).resolves.toMatchObject({ dryRun: true, changed: ['comment', 'done', 'labels'] });

    expect(request.mock.calls.every(([method]) => method === 'GET')).toBe(true);
  });
});
