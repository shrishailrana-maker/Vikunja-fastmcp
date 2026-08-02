import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VikunjaApiClient } from '../src/api.js';
import { bulkUpdateTasks, listTaskReminders, addTaskReminder } from '../src/bulk-reminders.js';
import { listWebhooks, createWebhook, listWebhookEvents, updateWebhook } from '../src/webhooks.js';
import {
  previewCsvImport,
  getUserExportStatus,
  downloadUserExport,
  exportProject,
} from '../src/data.js';
import { TemplateStore } from '../src/templates.js';
import { cache } from '../src/identity.js';
import { setTeamMemberAdmin } from '../src/teams.js';

const config = {
  vikunjaUrl: 'https://vikunja.example.com/api/v2',
  vikunjaToken: 'test-token',
  vikunjaWebUrl: 'https://vikunja.example.com/',
  attachmentDownloadRoot: path.join(os.tmpdir(), 'vikunja-compat-tests'),
};

describe('restored compatibility capabilities', () => {
  const client = new VikunjaApiClient(config);
  let mockFetch: jest.SpiedFunction<typeof fetch>;

  beforeEach(() => {
    mockFetch = jest.spyOn(global, 'fetch');
    cache.clearProjects();
  });

  afterEach(() => mockFetch.mockRestore());

  it('uses the native v2 bulk task update route', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          tasks: [
            {
              $schema: '/api/v2/schemas/Task.json',
              id: 10,
              index: 4,
              identifier: 'ALPHA-4',
              project_id: 2,
              title: 'Updated task',
              description: '<p>Long body</p>',
              done: true,
              priority: 3,
              due_date: '2026-08-01T00:00:00Z',
            },
          ],
        }),
    } as Response);

    const result = await bulkUpdateTasks(client, [10, 11], { done: true });
    expect(result.updated).toEqual([
      {
        id: 10,
        index: 4,
        identifier: 'ALPHA-4',
        projectId: 2,
        title: 'Updated task',
        done: true,
        priority: 3,
        dueDate: '2026-08-01T00:00:00Z',
      },
    ]);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://vikunja.example.com/api/v2/tasks/bulk',
      expect.objectContaining({ method: 'PUT' }),
    );
    expect(JSON.parse((mockFetch.mock.calls[0][1] as RequestInit).body as string)).toEqual({
      task_ids: [10, 11],
      fields: ['done'],
      values: { done: true },
    });
  });

  it('lists and adds task reminders through the task update field', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 10,
            index: 3,
            title: 'Task',
            project_id: 2,
            project: { title: 'Alpha' },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 10, reminders: [{ reminder: '2026-08-01T10:00:00Z' }] }),
      } as Response);
    expect(await listTaskReminders(client, 10)).toEqual([
      { reminder: '2026-08-01T10:00:00Z', relativePeriod: null, relativeTo: null },
    ]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 10,
            index: 3,
            title: 'Task',
            project_id: 2,
            project: { title: 'Alpha' },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 10, reminders: [] }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 10 }),
      } as Response);
    await addTaskReminder(client, 10, { reminder: '2026-08-02T10:00:00Z' });
    const patch = mockFetch.mock.calls.find((call) => (call[1] as RequestInit)?.method === 'PATCH');
    expect(JSON.parse((patch![1] as RequestInit).body as string)).toEqual([
      { op: 'replace', path: '/reminders', value: [{ reminder: '2026-08-02T10:00:00Z' }] },
    ]);
  });

  it('uses scoped project webhook routes and never returns write-only secrets', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [{ id: 4, target_url: 'https://hooks.example.com/a', events: ['task.created'] }],
            page: 1,
            per_page: 50,
            total: 1,
            total_pages: 1,
          }),
      } as Response);
    expect(await listWebhooks(client, { id: 2 })).toEqual([
      {
        id: 4,
        targetUrl: 'https://hooks.example.com/a',
        events: ['task.created'],
        projectId: null,
        userId: null,
      },
    ]);

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 5,
            target_url: 'https://hooks.example.com/a',
            events: ['task.created'],
          }),
      } as Response);
    const created = await createWebhook(
      client,
      { id: 2 },
      'https://hooks.example.com/a',
      ['task.created'],
      { secret: 'write-only' },
    );
    expect(created).not.toHaveProperty('secret');
  });

  it.each([
    'http://hooks.example.com/a',
    'https://127.0.0.1/a',
    'https://10.0.0.5/a',
    'https://user:password@hooks.example.com/a',
    'not a url',
  ])('rejects unsafe webhook target %s before any request', async (targetUrl) => {
    await expect(
      createWebhook(client, { id: 2 }, targetUrl, ['task.created']),
    ).rejects.toMatchObject({ code: 'UNSAFE_WEBHOOK_URL' });
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('uses the user event catalog and updates only mutable webhook events', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(['user.updated']),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 8,
            target_url: 'https://hooks.example.com/user',
            events: ['user.updated'],
            user_id: 1,
          }),
      } as Response);

    expect(await listWebhookEvents(client, 'user')).toEqual(['user.updated']);
    await updateWebhook(client, 8, undefined, ['user.updated']);

    expect(mockFetch.mock.calls[0][0]).toBe(
      'https://vikunja.example.com/api/v2/user/settings/webhooks/events',
    );
    expect(JSON.parse((mockFetch.mock.calls[1][1] as RequestInit).body as string)).toEqual({
      events: ['user.updated'],
    });
  });

  it('uses multipart CSV preview and reports user export status', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-csv-'));
    const csv = path.join(root, 'tasks.csv');
    await fs.writeFile(csv, 'title\nExample\n');
    try {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ total_rows: 1, tasks: [{ title: 'Example' }] }),
      } as Response);
      expect((await previewCsvImport(client, csv, { title: 'title' })).totalRows).toBe(1);
      expect((mockFetch.mock.calls[0][1] as RequestInit).headers).toEqual(
        expect.objectContaining({
          'Content-Type': expect.stringContaining('multipart/form-data; boundary='),
        }),
      );

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 8,
            size: 2048,
            created: '2026-07-12T00:00:00Z',
            expires: '2026-07-19T00:00:00Z',
          }),
      } as Response);
      expect((await getUserExportStatus(client)).size).toBe(2048);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => 'null',
      } as Response);
      expect(await getUserExportStatus(client)).toEqual({ available: false });

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => '{}',
      } as Response);
      expect(await getUserExportStatus(client)).toEqual({ available: false });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('neutralizes spreadsheet formulas in CSV project exports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-project-export-'));
    const localClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 10,
                index: 1,
                identifier: 'ALPHA-1',
                title: '=HYPERLINK("https://example.invalid")',
                description: '+SUM(1,1)',
                project_id: 2,
              },
            ],
            page: 1,
            per_page: 1000,
            total: 1,
            total_pages: 1,
          }),
      } as Response);

    try {
      await exportProject(localClient, { id: 2 }, 'csv', 'tasks.csv');
      const csv = await fs.readFile(path.join(root, 'tasks.csv'), 'utf8');
      expect(csv).toContain('"\'=HYPERLINK(""https://example.invalid"")"');
      expect(csv).toContain('"\'+SUM(1,1)"');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('enforces the download size ceiling for user exports', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-user-export-'));
    const limitedClient = new VikunjaApiClient({
      ...config,
      attachmentDownloadRoot: root,
      maxAttachmentBytes: 10,
    });
    try {
      mockFetch.mockResolvedValueOnce(
        new Response('01234567890', {
          status: 200,
          headers: { 'Content-Length': '11', 'Content-Type': 'application/zip' },
        }),
      );
      await expect(downloadUserExport(limitedClient, '', 'export.zip')).rejects.toMatchObject({
        status: 413,
        code: 'ATTACHMENT_TOO_LARGE',
      });
      await expect(fs.stat(path.join(root, 'export.zip'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects a truncated user export and removes the partial file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-user-export-'));
    const exportClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
    try {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'Content-Length': '10', 'Content-Type': 'application/zip' }),
        body: (async function* () {
          yield Buffer.from('short');
        })(),
      } as unknown as Response);

      await expect(downloadUserExport(exportClient, '', 'export.zip')).rejects.toMatchObject({
        status: 500,
        code: 'SIZE_MISMATCH',
      });
      await expect(fs.stat(path.join(root, 'export.zip'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('overwrites a user export only when overwrite is explicitly true', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-user-export-'));
    const exportClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
    const destination = path.join(root, 'export.zip');
    await fs.writeFile(destination, 'old');
    try {
      mockFetch.mockResolvedValueOnce(new Response('new', { status: 200 }));
      await expect(downloadUserExport(exportClient, '', 'export.zip')).rejects.toMatchObject({
        code: 'FILE_EXISTS',
      });

      mockFetch.mockResolvedValueOnce(new Response('new', { status: 200 }));
      await expect(downloadUserExport(exportClient, '', 'export.zip', true)).resolves.toMatchObject(
        {
          size: 3,
        },
      );
      expect(await fs.readFile(destination, 'utf8')).toBe('new');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exports task creators and optionally includes normalized comments', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-project-export-'));
    const exportClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
    try {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                {
                  id: 10,
                  index: 4,
                  identifier: 'ALPHA-4',
                  title: 'Exported task',
                  created_by: { id: 7, username: 'example-tester' },
                  labels: [],
                  assignees: [],
                },
              ],
              page: 1,
              per_page: 100,
              total: 1,
              total_pages: 1,
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                {
                  id: 50,
                  comment: '<p><strong>Verified</strong> in build 12.</p>',
                  author: { id: 9, username: 'example-developer' },
                  created: '2026-07-12T00:00:00Z',
                },
              ],
              page: 1,
              per_page: 100,
              total: 1,
              total_pages: 1,
            }),
        } as Response);

      const result = await exportProject(exportClient, { id: 2 }, 'json', 'alpha.json', true);
      const exported = JSON.parse(await fs.readFile(result.path, 'utf8'));

      expect(exported.tasks[0].creator).toEqual({ id: 7, username: 'example-tester' });
      expect(exported.tasks[0].comments).toEqual([
        {
          id: 50,
          comment: '**Verified** in build 12.',
          author: { id: 9, username: 'example-developer' },
          created: '2026-07-12T00:00:00Z',
          updated: null,
        },
      ]);
      expect(exported.tasks[0].commentCount).toBe(1);

      mockFetch.mockClear();
      cache.clearProjects();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                {
                  id: 10,
                  index: 4,
                  title: 'Exported task',
                  created_by: { id: 7, username: 'example-tester' },
                },
              ],
              page: 1,
              per_page: 100,
              total: 1,
              total_pages: 1,
            }),
        } as Response);

      const compact = await exportProject(
        exportClient,
        { id: 2 },
        'json',
        'alpha-without-comments.json',
      );
      const compactExport = JSON.parse(await fs.readFile(compact.path, 'utf8'));
      expect(compactExport.tasks[0]).not.toHaveProperty('comments');
      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('exports attachment and relation metadata with per-task counts', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-project-export-'));
    const exportClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
    const task = {
      id: 10,
      index: 4,
      identifier: 'ALPHA-4',
      title: 'Exported task',
      project_id: 2,
      labels: [],
      assignees: [],
    };
    try {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ items: [task], page: 1, per_page: 100, total: 1, total_pages: 1 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                {
                  id: 70,
                  file: { name: 'run.log', mime: 'text/plain', size: 321 },
                },
              ],
              page: 1,
              per_page: 100,
              total: 1,
              total_pages: 1,
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              ...task,
              related_tasks: {
                blocking: [{ id: 11, title: 'Blocked task' }],
              },
            }),
        } as Response);

      const result = await exportProject(
        exportClient,
        { id: 2 },
        'json',
        'complete.json',
        false,
        true,
        true,
      );
      const exported = JSON.parse(await fs.readFile(result.path, 'utf8'));
      expect(exported.tasks[0]).toMatchObject({
        attachmentCount: 1,
        relationCount: 1,
        attachments: [{ id: 70, fileName: 'run.log', mime: 'text/plain', fileSize: 321 }],
        relations: [{ kind: 'blocking', taskId: 11, title: 'Blocked task' }],
      });

      mockFetch.mockClear();
      cache.clearProjects();
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ items: [task], page: 1, per_page: 100, total: 1, total_pages: 1 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ items: [], page: 1, per_page: 100, total: 0, total_pages: 0 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ...task, related_tasks: {} }),
        } as Response);
      const csvResult = await exportProject(
        exportClient,
        { id: 2 },
        'csv',
        'attachments.csv',
        false,
        true,
        true,
      );
      const csv = await fs.readFile(csvResult.path, 'utf8');
      expect(csv.split('\n')[0]).toContain('attachmentCount');
      expect(csv.split('\n')[0]).toContain('attachments');
      expect(csv.split('\n')[0]).toContain('relationCount');
      expect(csv.split('\n')[0]).toContain('relations');
      expect(csv.split('\n')[0]).not.toContain('comments');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('rejects rich exports above the bounded 1000-task default before detail fan-out', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 2, title: 'Alpha' }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ items: [], page: 1, per_page: 100, total: 1001, total_pages: 11 }),
      } as Response);

    await expect(
      exportProject(client, { id: 2 }, 'json', 'bounded.json', true),
    ).rejects.toMatchObject({ status: 413, code: 'EXPORT_TASK_LIMIT_EXCEEDED' });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('stores templates atomically in one explicit local file', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-template-'));
    const file = path.join(root, 'templates.json');
    try {
      const store = new TemplateStore(file);
      const created = await store.create('Bug', { title: 'Bug: {{title}}', priority: 3 });
      expect((await store.list()).map((item) => item.name)).toEqual(['Bug']);
      expect((await store.get(created.id)).fields.priority).toBe(3);
      await store.delete(created.id);
      expect(await store.list()).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('serializes concurrent template mutations across store instances', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-template-lock-'));
    const file = path.join(root, 'templates.json');
    try {
      await Promise.all([
        new TemplateStore(file).create('Bug', { title: 'Bug' }),
        new TemplateStore(file).create('Feature', { title: 'Feature' }),
      ]);
      expect((await new TemplateStore(file).list()).map((item) => item.name).sort()).toEqual([
        'Bug',
        'Feature',
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('fails closed when a team-admin toggle cannot be verified by read-back', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 8,
            name: 'Alpha',
            members: [{ id: 7, username: 'dev', admin: false }],
          }),
      } as Response)
      .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '{}' } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 8, name: 'Alpha', members: [] }),
      } as Response);

    await expect(setTeamMemberAdmin(client, 8, 'dev', true)).rejects.toMatchObject({
      code: 'MEMBER_ADMIN_UPDATE_UNVERIFIED',
    });
  });
});
