import { jest } from '@jest/globals';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VikunjaApiClient } from '../src/api.js';
import { bulkUpdateTasks, listTaskReminders, addTaskReminder } from '../src/bulk-reminders.js';
import { listWebhooks, createWebhook, listWebhookEvents, updateWebhook } from '../src/webhooks.js';
import { previewCsvImport, getUserExportStatus, downloadUserExport } from '../src/data.js';
import { TemplateStore } from '../src/templates.js';

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

  it('preserves task fields when Vikunja rejects reminder PATCH after assignment', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 10,
            index: 3,
            title: 'Assigned task',
            project_id: 2,
            project: { title: 'Alpha' },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 10,
            title: 'Assigned task',
            done: false,
            priority: 3,
            reminders: [],
            subscription: { entity: 'task', entity_id: 10 },
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        text: async () =>
          JSON.stringify({
            title: 'Validation error',
            status: 422,
            detail: 'Invalid task',
            errors: [
              {
                location: 'body.subscription.entity',
                message: 'Expected integer',
              },
            ],
          }),
      } as Response)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 10 }),
      } as Response);

    await addTaskReminder(client, 10, { reminder: '2026-08-03T10:00:00Z' });

    const put = mockFetch.mock.calls.find((call) => (call[1] as RequestInit)?.method === 'PUT');
    const body = JSON.parse((put![1] as RequestInit).body as string);
    expect(body).toMatchObject({
      title: 'Assigned task',
      done: false,
      priority: 3,
      reminders: [{ reminder: '2026-08-03T10:00:00Z' }],
    });
    expect(body).not.toHaveProperty('subscription');
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
});
