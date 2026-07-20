/**
 * Tests for task listing, scoping, and CRUD.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import {
  listTasks,
  buildFilterString,
  createTask,
  getTask,
  updateTask,
  deleteTask,
  closeWithEvidence,
} from '../src/tasks.js';
import { idempotency } from '../src/idempotency.js';

describe('Tasks List and Scoping tests', () => {
  const config = {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    vikunjaToken: 'tk_token',
    vikunjaWebUrl: 'https://vikunja.example.com/',
    attachmentDownloadRoot: '/tmp',
  };

  let client: VikunjaApiClient;
  let mockFetch: any;

  beforeEach(() => {
    client = new VikunjaApiClient(config);
    mockFetch = jest.spyOn(global, 'fetch');
    idempotency.clear();
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe('buildFilterString', () => {
    it('should compose done, priority, label, and explicit filter with AND semantics', () => {
      const filter = buildFilterString({
        done: false,
        priority: 5,
        label: 'bug',
        filter: 'due_date is null',
      });
      expect(filter).toBe("done = false && priority = 5 && labels = 'bug' && (due_date is null)");
    });

    it('should preserve exact priority 0 and default open-only', () => {
      const filter = buildFilterString({
        priority: 0,
      });
      expect(filter).toBe('done = false && priority = 0');
    });

    it('should omit done filter when allStates is true', () => {
      const filter = buildFilterString({
        allStates: true,
        priority: 1,
      });
      expect(filter).toBe('priority = 1');
    });

    it('should escape quotes in labels', () => {
      const filter = buildFilterString({
        label: "owner's priority",
      });
      expect(filter).toBe("done = false && labels = 'owner''s priority'");
    });

    it('should filter open tasks by assignee username', () => {
      const filter = buildFilterString({
        assignee: 'sudhir',
      });
      expect(filter).toBe("done = false && assignees in 'sudhir'");
    });

    it('should escape quotes in assignee usernames', () => {
      const filter = buildFilterString({
        assignee: "owner's-agent",
      });
      expect(filter).toBe("done = false && assignees in 'owner''s-agent'");
    });
  });

  describe('listTasks', () => {
    it('should query a single project and format response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      const mockTasksResponse = {
        page: 1,
        per_page: 25,
        total: 1,
        total_pages: 1,
        items: [
          {
            id: 1,
            index: 10,
            title: 'Task 1',
            description: '<p>Large evidence body that lists must omit.</p>',
            done: false,
            priority: 3,
            created_by: { id: 7, username: 'example-tester' },
            labels: [],
            assignees: [],
          },
        ],
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockTasksResponse),
      } as Response);

      const result = await listTasks(client, {
        project: { id: 101 },
        responseMode: 'standard',
      });
      expect(result.project).toEqual({ id: 101, title: 'Alpha' });
      expect(result.tasks.length).toBe(1);
      expect(result.tasks[0].title).toBe('Task 1');
      expect(result.tasks[0].creator).toEqual({ id: 7, username: 'example-tester' });
      expect(result.tasks[0].description).toBeUndefined();

      // Must NOT send `expand=labels,assignees`: those are always embedded and
      // are not valid expand values, so the live server rejects them with 422.
      const taskListUrl = mockFetch.mock.calls[1][0] as string;
      expect(taskListUrl).toContain('/projects/101/tasks');
      expect(taskListUrl).not.toContain('expand');
      expect(result.pagination).toEqual({
        page: 1,
        perPage: 25,
        total: 1,
        totalPages: 1,
        hasMore: false,
        nextPage: null,
      });
    });

    it('caps oversized agent pages while preserving truthful pagination', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [],
              page: 1,
              per_page: 100,
              total: 955,
              total_pages: 20,
            }),
        } as Response);

      const result = await listTasks(client, { project: { id: 101 }, perPage: 1000 });
      expect(mockFetch.mock.calls[1][0]).toContain('per_page=100');
      expect(result.pagination).toMatchObject({
        perPage: 100,
        total: 955,
        hasMore: true,
        nextPage: 2,
      });
    });

    it('offers a compact 100-task response at least 60 percent smaller than standard', async () => {
      const items = Array.from({ length: 100 }, (_, offset) => ({
        id: 9000 + offset,
        index: 300 + offset,
        identifier: `ALPHA-${300 + offset}`,
        title: `Example task ${offset + 1} with a realistic concise title`,
        done: false,
        priority: (offset % 5) + 1,
        created_by: { id: 7, username: 'example-tester' },
        labels: [
          { id: 9, title: 'bug' },
          { id: 12, title: 'open' },
        ],
      }));
      const listResponse = {
        items,
        page: 1,
        per_page: 100,
        total: 225,
        total_pages: 3,
      };

      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(listResponse),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(listResponse),
        } as Response);

      const standard = await listTasks(client, {
        project: { id: 101 },
        perPage: 100,
        responseMode: 'standard',
      });
      const compact = await listTasks(client, {
        project: { id: 101 },
        perPage: 100,
      });

      expect(compact.tasks[0]).toEqual({
        id: 9000,
        portalRef: 'ALPHA-300',
        title: 'Example task 1 with a realistic concise title',
        done: false,
        priority: 1,
        creator: 'example-tester',
      });
      expect(compact.truncated).toBe(true);
      expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(standard).length * 0.4);
    });

    it('should group subset query results by project with independent pagination', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 102, title: 'Beta' }]),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            page: 1,
            per_page: 2,
            total: 3,
            total_pages: 2,
            items: [{ id: 1, index: 1, title: 'Alpha Task' }],
          }),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            page: 1,
            per_page: 2,
            total: 1,
            total_pages: 1,
            items: [{ id: 2, index: 1, title: 'Beta Task' }],
          }),
      } as Response);

      const result = await listTasks(client, {
        projects: [{ id: 101 }, { title: 'Beta' }],
        page: 1,
        perPage: 2,
      });

      expect(result.projects.length).toBe(2);
      expect(result.projects[0].project.title).toBe('Alpha');
      expect(result.projects[0].pagination.hasMore).toBe(true);
      expect(result.projects[1].project.title).toBe('Beta');
      expect(result.projects[1].pagination.hasMore).toBe(false);
    });

    it('should support countOnly mode and return totals with zero items', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            page: 1,
            per_page: 1,
            total: 12,
            total_pages: 12,
            items: [],
          }),
      } as Response);

      const result = await listTasks(client, {
        project: { id: 101 },
        countOnly: true,
      });

      expect(result.project).toEqual({ id: 101, title: 'Alpha' });
      expect(result.count).toBe(12);
      expect(result.tasks).toBeUndefined();

      // countOnly must request the smallest page (only the total is needed).
      const listUrl = mockFetch.mock.calls[1][0] as string;
      expect(listUrl).toContain('per_page=1');
    });

    it('resolves a label title to its numeric v2 filter value', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [{ id: 9, title: 'bug' }],
              page: 1,
              per_page: 50,
              total: 1,
              total_pages: 1,
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ items: [], page: 1, per_page: 1, total: 0, total_pages: 0 }),
        } as Response);

      await listTasks(client, { project: { id: 101 }, label: 'bug', countOnly: true });

      const listUrl = mockFetch.mock.calls.at(-1)?.[0] as string;
      expect(new URL(listUrl).searchParams.get('filter')).toContain('labels = 9');
    });

    it('rejects an empty explicit project subset', async () => {
      await expect(listTasks(client, { projects: [] })).rejects.toMatchObject({
        code: 'SCOPE_REQUIRED',
      });
    });
  });

  describe('Task Mutation (CRUD) tests', () => {
    it('should create a task and return a write echo response', async () => {
      // Mock project Alpha resolution
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      // Mock task create endpoint
      const mockCreatedTask = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'New Bug',
        description: '<p>HTML desc</p>',
        done: false,
        priority: 4,
        project_id: 101,
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockCreatedTask),
      } as Response);

      const echo = await createTask(
        client,
        { id: 101 },
        {
          title: 'New Bug',
          description: 'New Bug',
          priority: 4,
        },
      );

      expect(echo.action).toBe('created');
      expect(echo.target).toEqual({
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        project: { id: 101, title: 'Alpha' },
        title: 'New Bug',
      });
    });

    it('should get consolidated details in getTask', async () => {
      // Mock task resolution
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Task Title',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // Mock get task by ID with comments embedded via expand=comments.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Task Title',
            project_id: 101,
            description: '<p>hello</p>',
            created_by: { id: 7, username: 'example-tester' },
            comments: [
              { id: 2001, comment: '<p>A comment</p>', author: { id: 1, username: 'tester' } },
            ],
          }),
      } as Response);

      // Mock attachments (v2 nests file metadata under `file`).
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { id: 3001, created: 't', file: { name: 'log.txt', mime: 'text/plain', size: 100 } },
          ]),
      } as Response);

      const details = await getTask(client, 9005, undefined, 5, 'full');
      expect(details.task.id).toBe(9005);
      expect(details.task.description).toBe('hello');
      expect(details.task.creator).toEqual({ id: 7, username: 'example-tester' });
      expect(details.comments.length).toBe(1);
      expect(details.comments[0].comment).toBe('A comment');
      expect(details.attachments.length).toBe(1);
      expect(details.attachments[0].fileName).toBe('log.txt');
      // Comments came from the embedded expand, so no separate /comments call.
      expect(details.composedCalls).toEqual([
        'GET /tasks/9005?expand=comments',
        'GET /tasks/9005/attachments',
      ]);
      const urls = mockFetch.mock.calls.map((c: any) => c[0]);
      expect(urls.some((u: string) => u.includes('expand=comments'))).toBe(true);
      expect(urls.some((u: string) => /\/comments$/.test(u))).toBe(false);
    });

    it('defaults to a compact task without fetching comments or attachments', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            identifier: 'ALPHA-305',
            title: 'Task Title',
            project_id: 101,
            project: { title: 'Alpha' },
            description: '<p>Large evidence body.</p>',
            done: false,
            priority: 4,
            created_by: { id: 7, username: 'example-tester' },
            labels: [{ id: 9, title: 'bug' }],
            assignees: [{ id: 8, username: 'developer' }],
          }),
      } as Response);

      const details = await getTask(client, 9005);

      expect(details).toEqual({
        task: {
          id: 9005,
          portalRef: 'ALPHA-305',
          project: { id: 101, title: 'Alpha' },
          title: 'Task Title',
          done: false,
          priority: 4,
          creator: 'example-tester',
        },
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(mockFetch.mock.calls[0][0]).not.toContain('expand=comments');
    });

    it('falls back to the comments endpoint when the server does not embed them', async () => {
      // resolve
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'T',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);
      // task GET without an embedded comments array
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 9005, index: 305, title: 'T', project_id: 101 }),
      } as Response);
      // fallback comments endpoint (wrapped shape)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ items: [{ id: 2002, comment: '<p>hi</p>', author: {} }] }),
      } as Response);
      // attachments
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [] }),
      } as Response);

      const details = await getTask(client, 9005, undefined, 5, 'full');
      expect(details.comments.length).toBe(1);
      expect(details.comments[0].comment).toBe('hi');
      expect(details.composedCalls).toContain('GET /tasks/9005/comments');
    });

    it('should perform conditional updates and PATCH changed fields only', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Old Title',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // 2. Mock GET task for expectedUpdatedAt verification
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Old Title',
            project_id: 101,
            updated: '2026-07-12T00:00:00Z',
          }),
      } as Response);

      // 3. Mock PATCH response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'New Title',
            project_id: 101,
          }),
      } as Response);

      const echo = await updateTask(
        client,
        9005,
        { title: 'New Title', done: false }, // done is unchanged, shouldn't be patched
        undefined,
        '2026-07-12T00:00:00Z',
      );

      expect(echo.action).toBe('updated');
      expect(echo.target.title).toBe('New Title');

      // Verify that PATCH body only contains changed fields
      const patchCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'PATCH');
      expect(patchCall).toBeDefined();
      expect(patchCall[1].headers['Content-Type']).toBe('application/json-patch+json');
      const body = JSON.parse(patchCall[1].body);
      expect(body).toEqual([{ op: 'replace', path: '/title', value: 'New Title' }]);
      expect(body.some((operation: any) => operation.path === '/done')).toBe(false);
    });

    it('reports an unchanged receipt when an update has no effective changes', async () => {
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Already current',
        project_id: 101,
        project: { title: 'Alpha' },
        done: false,
        priority: 3,
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(existing),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(existing),
        } as Response);

      const echo = await updateTask(client, 9005, { title: 'Already current', priority: 3 });

      expect(echo.action).toBe('unchanged');
      expect(mockFetch.mock.calls.some((call: any) => call[1]?.method === 'PATCH')).toBe(false);
    });

    it('makes close_with_evidence retry-safe and reports only fields actually changed', async () => {
      const task = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Already closed',
        project_id: 101,
        project: { title: 'Alpha' },
        done: true,
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(task),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(task),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              id: 77,
              comment: '<p>Verified.</p>',
              author: { id: 4, username: 'tester' },
              created: '2026-07-20T00:00:00Z',
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(task),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(task),
        } as Response);

      const first = await closeWithEvidence(client, 9005, 'Verified.', undefined, 'close-once');
      const callCount = mockFetch.mock.calls.length;
      const second = await closeWithEvidence(client, 9005, 'Verified.', undefined, 'close-once');

      expect(first.task.action).toBe('unchanged');
      expect(first.changed).toEqual(['comment']);
      expect(second).toEqual(first);
      expect(mockFetch).toHaveBeenCalledTimes(callCount);
    });

    it('falls back to a writable-field PUT when Vikunja rejects its own subscription on PATCH', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              title: 'Assigned task',
              project_id: 101,
              project: { title: 'Alpha' },
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              title: 'Assigned task',
              description: '<p>Keep this evidence.</p>',
              project_id: 101,
              priority: 4,
              done: false,
              subscription: { entity: 'task', entity_id: 9005 },
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          text: async () =>
            JSON.stringify({
              title: 'Validation Error',
              status: 422,
              detail: 'validation failed',
              errors: [
                {
                  location: 'body.subscription.entity',
                  message: 'expected integer',
                  value: 'task',
                },
              ],
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              title: 'Assigned task',
              description: '<p>Keep this evidence.</p>',
              project_id: 101,
              priority: 4,
              done: true,
            }),
        } as Response);

      const echo = await updateTask(client, 9005, { done: true });

      expect(echo.action).toBe('closed');
      const putCall = mockFetch.mock.calls.find((call: any) => call[1]?.method === 'PUT');
      expect(putCall).toBeDefined();
      expect(JSON.parse(putCall[1].body)).toEqual(
        expect.objectContaining({
          title: 'Assigned task',
          description: '<p>Keep this evidence.</p>',
          project_id: 101,
          priority: 4,
          done: true,
        }),
      );
      expect(JSON.parse(putCall[1].body)).not.toHaveProperty('subscription');
    });

    it('clears a due date by sending an explicit null in PATCH', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              title: 'Task',
              project_id: 101,
              project: { title: 'Alpha' },
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              title: 'Task',
              project_id: 101,
              due_date: '2026-08-01T00:00:00Z',
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ id: 9005, index: 305, title: 'Task', project_id: 101 }),
        } as Response);

      await updateTask(client, 9005, { dueDate: null });

      const patchCall = mockFetch.mock.calls.find((call: any) => call[1]?.method === 'PATCH');
      expect(JSON.parse(patchCall[1].body)).toEqual([
        { op: 'replace', path: '/due_date', value: null },
      ]);
    });

    it('does not hide a comments API failure behind an empty consolidated list', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              title: 'Task',
              project_id: 101,
              project: { title: 'Alpha' },
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({ id: 9005, index: 305, title: 'Task', project_id: 101 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 403,
          statusText: 'Forbidden',
          text: async () => JSON.stringify({ detail: 'Comments are forbidden' }),
        } as Response);

      await expect(getTask(client, 9005, undefined, 5, 'full')).rejects.toMatchObject({
        status: 403,
      });
    });

    it('should throw 409 CONFLICT on expectedUpdatedAt mismatch', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Task',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // 2. Mock GET task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Task',
            project_id: 101,
            updated: '2026-07-12T00:05:00Z', // Mismatch!
          }),
      } as Response);

      await expect(
        updateTask(client, 9005, { title: 'New' }, undefined, '2026-07-12T00:00:00Z'),
      ).rejects.toThrow(
        expect.objectContaining({
          status: 409,
          code: 'CONFLICT',
        }),
      );
    });

    it('should delete task and return write echo', async () => {
      // Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Task to Delete',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // Mock delete request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const echo = await deleteTask(client, 9005);
      expect(echo.action).toBe('deleted');
      expect(echo.target.id).toBe(9005);
      expect(echo.target.title).toBe('Task to Delete');
    });
  });
});
