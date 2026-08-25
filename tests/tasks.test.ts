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
  listMyTasks,
  buildFilterString,
  createTask,
  upsertTask,
  getTask,
  updateTask,
  deleteTask,
  closeWithEvidence,
} from '../src/tasks.js';
import { idempotency } from '../src/idempotency.js';
import { cache } from '../src/identity.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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
    cache.clearProjects();
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
        assignee: 'example-user',
      });
      expect(filter).toBe("done = false && assignees in 'example-user'");
    });

    it('builds precise title and changed-since filters without broad q search', () => {
      expect(
        buildFilterString({
          titleContains: 'release gate',
          changedSince: '2026-07-01T00:00:00Z',
          allStates: true,
        }),
      ).toBe("title like '%release gate%' && updated >= '2026-07-01T00:00:00Z'");
    });

    it('should escape quotes in assignee usernames', () => {
      const filter = buildFilterString({
        assignee: "owner's-agent",
      });
      expect(filter).toBe("done = false && assignees in 'owner''s-agent'");
    });

    it('combines description and actor filters with the default open-state filter', () => {
      const filter = buildFilterString({
        descriptionContains: "parser's report",
        actor: 'Example Agent',
      });
      // No parens in the actor pattern: Vikunja's filter tokenizer rejects
      // "(" and ")" inside quoted strings.
      expect(filter).toBe(
        "done = false && description like '%parser''s report%' && description like '%by Example Agent%'",
      );
    });

    it('canonicalizes delegated actor syntax before building a parser-safe filter', () => {
      expect(buildFilterString({ actor: 'Codex (as srana)' })).toBe(
        "done = false && description like '%by Codex as srana%'",
      );
    });
  });

  describe('listTasks', () => {
    it('lists assigned tasks for the authenticated user with a compact identity', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ id: 7, username: 'example-user', email: 'private@example.com' }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: 1,
                  index: 10,
                  identifier: 'ALPHA-10',
                  title: 'Closed task',
                  done: true,
                  priority: 2,
                  assignees: [{ id: 7, username: 'example-user' }],
                },
              ],
              page: 1,
              per_page: 20,
              total: 1,
              total_pages: 1,
            }),
            { status: 200 },
          ),
        );

      const result = await listMyTasks(client, {
        project: { id: 101 },
        state: 'closed',
        responseMode: 'compact',
      });

      expect(result.user).toEqual({ id: 7, username: 'example-user' });
      expect(result.user).not.toHaveProperty('email');
      expect(result.tasks[0]).toMatchObject({
        id: 1,
        portalRef: 'ALPHA-10',
        done: true,
      });
      const taskListUrl = new URL(mockFetch.mock.calls[2][0] as string);
      expect(taskListUrl.searchParams.get('filter')).toContain('done = true');
      expect(taskListUrl.searchParams.get('filter')).toContain("assignees in 'example-user'");
    });

    it('preserves the exact non-empty username while validating it with trim', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 7, username: ' example-user ' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ items: [], page: 1, per_page: 20, total: 0, total_pages: 0 }),
            { status: 200 },
          ),
        );

      const result = await listMyTasks(client, {
        project: { id: 101 },
        responseMode: 'compact',
      });

      expect(result.user).toEqual({ id: 7, username: ' example-user ' });
      expect(new URL(mockFetch.mock.calls[2][0] as string).searchParams.get('filter')).toContain(
        "assignees in ' example-user '",
      );
    });

    it('defaults to open assigned tasks and keeps count-only responses body-free', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 7, username: 'example-user' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ items: [], page: 1, per_page: 1, total: 4, total_pages: 4 }),
            { status: 200 },
          ),
        );

      const result = await listMyTasks(client, {
        project: { id: 101 },
        countOnly: true,
      });

      expect(result.user).toEqual({ id: 7, username: 'example-user' });
      expect(result.project).toEqual({ id: 101, title: 'Alpha' });
      expect(result.count).toBe(4);
      expect(result).not.toHaveProperty('tasks');
      const taskListUrl = new URL(mockFetch.mock.calls[2][0] as string);
      expect(taskListUrl.searchParams.get('per_page')).toBe('1');
      expect(taskListUrl.searchParams.get('filter')).toContain('done = false');
      expect(taskListUrl.searchParams.get('filter')).toContain("assignees in 'example-user'");
    });

    it('forwards cursor and response budget options through my_tasks', async () => {
      mockFetch.mockImplementation(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ id: 7, username: 'example-user' }), {
            status: 200,
          });
        }
        if (url.endsWith('/projects/101')) {
          return new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 });
        }
        if (url.includes('/projects/101/tasks')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  id: 9001,
                  index: 1,
                  identifier: 'ALPHA-1',
                  title: 'A task',
                  done: false,
                  assignees: [{ id: 7, username: 'example-user' }],
                },
              ],
              page: 1,
              per_page: 1,
              total: 2,
              total_pages: 2,
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected request ${url}`);
      });

      const result = await listMyTasks(client, {
        project: { id: 101 },
        search: 'A task',
        perPage: 1,
        maxResponseChars: 1_000,
      });

      expect(result.user).toEqual({ id: 7, username: 'example-user' });
      expect(result.nextCursor).toEqual(expect.any(String));
      expect(JSON.stringify(result).length).toBeLessThanOrEqual(1_000);
      const taskListUrl = new URL(
        mockFetch.mock.calls.find(([input]: [string]) =>
          String(input).includes('/tasks'),
        )![0] as string,
      );
      expect(taskListUrl.searchParams.get('q')).toBe('A task');
    });

    it('keeps the default minimal budget after adding user identity and resumes at the cursor', async () => {
      const items = Array.from({ length: 100 }, (_, index) => ({
        id: 7000 + index,
        index: index + 1,
        identifier: `ALPHA-${index + 1}`,
        title: `Boundary task ${index + 1} ${'x'.repeat(96)}`,
        done: false,
      }));
      mockFetch.mockImplementation(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/user')) {
          return new Response(JSON.stringify({ id: 7, username: 'example-user' }), {
            status: 200,
          });
        }
        if (url.endsWith('/projects/101')) {
          return new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 });
        }
        if (url.includes('/projects/101/tasks')) {
          return new Response(
            JSON.stringify({
              items,
              page: 1,
              per_page: 100,
              total: 100,
              total_pages: 1,
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected request ${url}`);
      });

      const options = {
        project: { id: 101 },
        responseMode: 'minimal' as const,
        fields: ['portalRef', 'title'] as ('portalRef' | 'title')[],
        titleMaxChars: 100,
      };
      const first = await listMyTasks(client, options);
      const envelopeOverhead = '```json\n{"ok":true,"data":}\n```'.length;

      expect(JSON.stringify(first).length + envelopeOverhead).toBeLessThanOrEqual(4_000);
      expect(first.returnedCount).toBeGreaterThan(0);
      expect(first.nextCursor).toEqual(expect.any(String));

      const resumed = await listMyTasks(client, { ...options, cursor: first.nextCursor });
      expect(JSON.stringify(resumed).length + envelopeOverhead).toBeLessThanOrEqual(4_000);
      expect(resumed.tasks[0].portalRef).toBe(`ALPHA-${first.returnedCount + 1}`);
    });

    it('rejects a malformed current-user response before listing tasks', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 7, username: '   ' }), { status: 200 }),
      );

      await expect(listMyTasks(client, { project: { id: 101 } })).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_CURRENT_USER',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('rejects a current-user response without a positive integer id', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 0, username: 'example-user' }), { status: 200 }),
      );

      await expect(listMyTasks(client, { project: { id: 101 } })).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_CURRENT_USER',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

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

      const result = await listTasks(client, {
        project: { id: 101 },
        perPage: 1000,
        responseMode: 'compact',
      });
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
      cache.clearProjects();
      const compact = await listTasks(client, {
        project: { id: 101 },
        perPage: 100,
        responseMode: 'compact',
      });
      cache.clearProjects();
      const minimal = await listTasks(client, {
        project: { id: 101 },
        perPage: 100,
        responseMode: 'minimal',
        fields: ['portalRef', 'title'],
        titleMaxChars: 32,
        maxResponseChars: 3800,
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
      expect(minimal.tasks[0]).toEqual({
        portalRef: 'ALPHA-300',
        title: 'Example task 1 with a realist...',
      });
      expect(minimal.project).toEqual({ id: 101, title: 'Alpha' });
      expect(minimal.returnedCount).toBeLessThan(100);
      expect(minimal.totalCount).toBe(225);
      expect(minimal.incomplete).toBe(true);
      expect(minimal.nextCursor).toEqual(expect.any(String));
      expect(JSON.stringify(minimal).length).toBeLessThanOrEqual(3800);

      cache.clearProjects();
      const resumed = await listTasks(client, {
        project: { id: 101 },
        perPage: 100,
        responseMode: 'minimal',
        fields: ['portalRef', 'title'],
        titleMaxChars: 32,
        maxResponseChars: 3800,
        cursor: minimal.nextCursor,
      });
      expect(resumed.tasks[0].portalRef).toBe(`ALPHA-${300 + minimal.returnedCount}`);
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
        text: async () =>
          JSON.stringify({
            items: [{ id: 102, title: 'Beta' }],
            page: 1,
            per_page: 100,
            total: 1,
            total_pages: 1,
          }),
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
        responseMode: 'compact',
      });

      expect(result.projects.length).toBe(2);
      expect(result.projects[0].project.title).toBe('Alpha');
      expect(result.projects[0].pagination.hasMore).toBe(true);
      expect(result.projects[1].project.title).toBe('Beta');
      expect(result.projects[1].pagination.hasMore).toBe(false);
    });

    it('enforces one minimal response budget and advances a multi-project cursor', async () => {
      mockFetch.mockImplementation(async (input: string) => {
        const url = String(input);
        if (url.endsWith('/projects/101')) {
          return new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 });
        }
        if (url.endsWith('/projects/102')) {
          return new Response(JSON.stringify({ id: 102, title: 'Beta' }), { status: 200 });
        }
        if (url.includes('/projects/101/tasks')) {
          return new Response(
            JSON.stringify({
              page: 1,
              per_page: 20,
              total: 3,
              total_pages: 1,
              items: [1, 2, 3].map((index) => ({
                id: 9000 + index,
                index,
                identifier: `ALPHA-${index}`,
                title: `Alpha task ${index} ${'x'.repeat(40)}`,
              })),
            }),
            { status: 200 },
          );
        }
        if (url.includes('/projects/102/tasks')) {
          return new Response(
            JSON.stringify({
              page: 1,
              per_page: 20,
              total: 2,
              total_pages: 1,
              items: [1, 2].map((index) => ({
                id: 9100 + index,
                index,
                identifier: `BETA-${index}`,
                title: `Beta task ${index} ${'y'.repeat(40)}`,
              })),
            }),
            { status: 200 },
          );
        }
        throw new Error(`Unexpected request ${url}`);
      });

      const options = {
        projects: [{ id: 101 }, { id: 102 }],
        responseMode: 'minimal' as const,
        fields: ['portalRef', 'title'] as ('portalRef' | 'title')[],
        maxResponseChars: 500,
      };
      const first = await listTasks(client, options);
      const second = await listTasks(client, { ...options, cursor: first.nextCursor });
      const envelopeOverhead = '```json\n{"ok":true,"data":}\n```'.length;

      expect(JSON.stringify(first).length + envelopeOverhead).toBeLessThanOrEqual(500);
      expect(first.returnedCount).toBeGreaterThan(0);
      expect(first.nextCursor).toEqual(expect.any(String));
      expect(second.returnedCount).toBeGreaterThan(0);
      expect(second.nextCursor).not.toBe(first.nextCursor);
      expect(first.projects.flatMap((project: any) => project.tasks)[0]).not.toHaveProperty(
        'project',
      );

      await expect(
        listTasks(client, {
          project: { id: 101 },
          responseMode: 'minimal',
          cursor: first.nextCursor,
        }),
      ).rejects.toMatchObject({ status: 400, code: 'CURSOR_SCOPE_MISMATCH' });
    });

    it('preserves grouped output for a one-project subset selector', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              page: 1,
              per_page: 20,
              total: 1,
              total_pages: 1,
              items: [{ id: 9001, index: 1, identifier: 'ALPHA-1', title: 'Task' }],
            }),
            { status: 200 },
          ),
        );

      const result = await listTasks(client, { projects: [{ id: 101 }] });

      expect(result).toMatchObject({
        projects: [
          {
            project: { id: 101, title: 'Alpha' },
            tasks: [{ portalRef: 'ALPHA-1', title: 'Task' }],
          },
        ],
        returnedCount: 1,
        totalCount: 1,
      });
    });

    it('rejects explicit subsets above 25 projects before listing tasks', async () => {
      await expect(
        listTasks(client, {
          projects: Array.from({ length: 26 }, (_, index) => ({ id: index + 1 })),
        }),
      ).rejects.toMatchObject({ status: 400, code: 'PROJECT_SCOPE_TOO_LARGE' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('enforces maxResponseChars for explicit full lists', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [
                {
                  id: 1,
                  index: 1,
                  identifier: 'ALPHA-1',
                  title: 'Task',
                  description: `<p>${'x'.repeat(2000)}</p>`,
                },
              ],
              page: 1,
              per_page: 20,
              total: 1,
              total_pages: 1,
            }),
            { status: 200 },
          ),
        );

      await expect(
        listTasks(client, {
          project: { id: 101 },
          responseMode: 'full',
          maxResponseChars: 500,
        }),
      ).rejects.toMatchObject({ status: 413, code: 'RESPONSE_TOO_LARGE' });
    });

    it('fails clearly when one projected item cannot fit the response budget', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              page: 1,
              per_page: 20,
              total: 1,
              total_pages: 1,
              items: [
                {
                  id: 9001,
                  index: 1,
                  identifier: 'ALPHA-1',
                  title: 'x'.repeat(1000),
                },
              ],
            }),
            { status: 200 },
          ),
        );

      await expect(
        listTasks(client, {
          project: { id: 101 },
          responseMode: 'minimal',
          fields: ['portalRef', 'title'],
          titleMaxChars: 500,
          maxResponseChars: 500,
        }),
      ).rejects.toMatchObject({ status: 413, code: 'RESPONSE_ITEM_TOO_LARGE' });
    });

    it('uses stable updated/id ordering for changed-since reads', async () => {
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
              per_page: 20,
              total: 0,
              total_pages: 0,
            }),
        } as Response);

      await listTasks(client, {
        project: { id: 101 },
        changedSince: '2026-07-01T00:00:00Z',
      });

      const url = String(mockFetch.mock.calls[1][0]);
      expect(url).toContain('sort_by=updated');
      expect(url).toContain('sort_by=id');
      expect(url).toContain('order_by=asc');
      expect(decodeURIComponent(url).replaceAll('+', ' ')).toContain(
        "updated >= '2026-07-01T00:00:00Z'",
      );
    });

    it('resumes changed-since reads after the exact updated/id boundary', async () => {
      const updated = '2026-07-23T10:00:00Z';
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
              items: [
                {
                  id: 10,
                  index: 1,
                  identifier: 'ALPHA-1',
                  title: `First ${'x'.repeat(220)}`,
                  updated,
                },
                {
                  id: 11,
                  index: 2,
                  identifier: 'ALPHA-2',
                  title: `Second ${'y'.repeat(220)}`,
                  updated,
                },
              ],
              page: 1,
              per_page: 20,
              total: 2,
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
            JSON.stringify({
              items: [],
              page: 1,
              per_page: 20,
              total: 0,
              total_pages: 0,
            }),
        } as Response);

      const first = await listTasks(client, {
        project: { id: 101 },
        changedSince: '2026-07-01T00:00:00Z',
        fields: ['portalRef', 'title'],
        maxResponseChars: 650,
      });
      expect(first.returnedCount).toBe(1);
      expect(first.nextCursor).toEqual(expect.any(String));

      cache.clearProjects();
      await listTasks(client, {
        project: { id: 101 },
        fields: ['portalRef', 'title'],
        maxResponseChars: 650,
        cursor: first.nextCursor,
      });

      const resumeUrl = decodeURIComponent(String(mockFetch.mock.calls[3][0])).replaceAll('+', ' ');
      expect(resumeUrl).toContain("updated >= '2026-07-01T00:00:00Z'");
      expect(resumeUrl).toContain(
        `(updated > '${updated}' || (updated = '${updated}' && id > 10))`,
      );
      expect(resumeUrl).toContain('sort_by=updated');
      expect(resumeUrl).toContain('sort_by=id');
    });

    it('uses the exact changed-since boundary when a full server page fits', async () => {
      const updated = '2026-07-23T11:00:00Z';
      mockFetch
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: [{ id: 12, index: 3, identifier: 'ALPHA-3', title: 'Third', updated }],
              page: 1,
              per_page: 1,
              total: 2,
              total_pages: 2,
            }),
            { status: 200 },
          ),
        );

      const result = await listTasks(client, {
        project: { id: 101 },
        changedSince: '2026-07-01T00:00:00Z',
        perPage: 1,
      });
      const cursor = JSON.parse(Buffer.from(result.nextCursor, 'base64url').toString('utf8'));

      expect(cursor).toMatchObject({ projectId: 101, updated, id: 12 });
      expect(cursor).not.toHaveProperty('page');
    });

    it('rejects a regular cursor resumed with a different page size', async () => {
      const cursor = Buffer.from(
        JSON.stringify({ projectId: 101, page: 2, offset: 0, perPage: 20 }),
        'utf8',
      ).toString('base64url');
      mockFetch.mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 101, title: 'Alpha' }), { status: 200 }),
      );

      await expect(
        listTasks(client, { project: { id: 101 }, perPage: 100, cursor }),
      ).rejects.toMatchObject({ status: 400, code: 'CURSOR_PAGE_SIZE_MISMATCH' });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('returns an empty bounded result when allProjects has no visible projects', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ items: [], page: 1, per_page: 100, total: 0, total_pages: 0 }),
          { status: 200 },
        ),
      );

      await expect(listTasks(client, { allProjects: true })).resolves.toEqual({
        projects: [],
        returnedCount: 0,
        totalCount: 0,
        nextCursor: null,
        incomplete: false,
      });
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
    it('does not burn an idempotency key when project preflight fails before the first write', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [{ id: 101, title: 'Alpha' }],
              page: 1,
              per_page: 100,
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
          status: 201,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              identifier: 'ALPHA-305',
              title: 'Recovered create',
              project_id: 101,
            }),
        } as Response);

      await expect(
        createTask(
          client,
          { title: 'Missing' },
          { title: 'Recovered create' },
          'preflight-retry',
          undefined,
          'Codex',
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_NOT_FOUND' });

      await expect(
        createTask(
          client,
          { id: 101 },
          { title: 'Recovered create' },
          'preflight-retry',
          undefined,
          'Codex',
        ),
      ).resolves.toMatchObject({ action: 'created', target: { id: 9005 } });
      expect(mockFetch.mock.calls.filter((call: any) => call[1]?.method === 'POST')).toHaveLength(
        1,
      );
    });

    it('upsert creates a marked task with actor attribution before the stable key', async () => {
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
            JSON.stringify({ items: [], page: 1, per_page: 5, total: 0, total_pages: 0 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              identifier: 'ALPHA-305',
              title: 'Stable finding',
              project_id: 101,
            }),
        } as Response);

      const result = await upsertTask(
        client,
        { id: 101 },
        { title: 'Stable finding', description: 'Evidence' },
        'detector:file.ts:10',
        undefined,
        'Codex',
      );

      expect(result).toMatchObject({ action: 'created', externalKey: 'detector:file.ts:10' });
      const createCall = mockFetch.mock.calls.find((call: any) => call[1]?.method === 'POST');
      const description = JSON.parse(createCall[1].body).description as string;
      expect(description).toContain('Evidence');
      expect(description.indexOf('(by Codex)')).toBeLessThan(
        description.indexOf('[vfm-key:detector:file.ts:10]'),
      );
      expect(description.trim().endsWith('</p>')).toBe(true);
      expect(description).toContain('[vfm-key:detector:file.ts:10]');
    });

    it('upsert applies requested labels and returns them in the write receipt', async () => {
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
            JSON.stringify({ items: [], page: 1, per_page: 5, total: 0, total_pages: 0 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              id: 9005,
              index: 305,
              identifier: 'ALPHA-305',
              title: 'Labeled finding',
              project_id: 101,
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 9005, labels: [] }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [{ id: 12, title: 'status:open' }],
              page: 1,
              per_page: 100,
              total: 1,
              total_pages: 1,
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ labels: [{ id: 12, title: 'status:open' }] }),
        } as Response);

      const result = await upsertTask(
        client,
        { id: 101 },
        { title: 'Labeled finding', labels: [12] },
        'detector:labels:12',
      );

      expect(result).toMatchObject({
        action: 'created',
        labels: [{ id: 12, title: 'status:open' }],
      });
      const labelPut = mockFetch.mock.calls.find(
        (call: any) => call[1]?.method === 'PUT' && String(call[0]).endsWith('/labels/bulk'),
      );
      expect(JSON.parse(labelPut[1].body)).toEqual({
        labels: [{ id: 12, title: 'status:open' }],
      });
    });

    it('upsert updates the one exact stable-key match without creating a second task', async () => {
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Old wording',
        description: '<p>Evidence</p><p>[vfm-key:detector:file.ts:10]</p>',
        project_id: 101,
        project: { title: 'Alpha' },
        updated: '2026-07-28T10:00:00Z',
        done: false,
        priority: 0,
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
          text: async () =>
            JSON.stringify({ items: [existing], page: 1, per_page: 5, total: 1, total_pages: 1 }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(existing),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(existing),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ...existing, title: 'Reworded finding' }),
        } as Response);

      const result = await upsertTask(
        client,
        { id: 101 },
        { title: 'Reworded finding' },
        'detector:file.ts:10',
        '2026-07-28T10:00:00Z',
      );

      expect(result).toMatchObject({
        action: 'updated',
        externalKey: 'detector:file.ts:10',
        target: { id: 9005, title: 'Reworded finding' },
      });
      expect(mockFetch.mock.calls.filter((call: any) => call[1]?.method === 'POST')).toHaveLength(
        0,
      );
    });

    it('upsert matches a stable key even after the title was reworded', async () => {
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Completely different title',
        description: '<p>[vfm-key:detector:file.ts:10]</p>',
        project_id: 101,
        project: { title: 'Alpha' },
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
          text: async () => JSON.stringify({ items: [existing] }),
        } as Response)
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

      const result = await upsertTask(
        client,
        { id: 101 },
        { title: 'Completely different title' },
        'detector:file.ts:10',
      );
      expect(result.action).toBe('unchanged');
      expect(result.target.id).toBe(9005);
    });

    it('records the actor without forcing an unchanged upsert to replace the description', async () => {
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Stable title',
        description: '<p>Evidence</p><p>[vfm-key:detector:file.ts:10]</p>',
        project_id: 101,
        project: { title: 'Alpha' },
        done: false,
        priority: 0,
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
          text: async () =>
            JSON.stringify({ items: [existing], page: 1, per_page: 5, total: 1, total_pages: 1 }),
        } as Response)
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

      await expect(
        upsertTask(
          client,
          { id: 101 },
          { title: 'Stable title' },
          'detector:file.ts:10',
          undefined,
          'Codex',
        ),
      ).resolves.toMatchObject({
        action: 'unchanged',
        actor: 'Codex',
        externalKey: 'detector:file.ts:10',
      });
      expect(mockFetch.mock.calls.some((call: any) => call[1]?.method === 'PATCH')).toBe(false);
    });

    it('upsert fails closed when one stable key matches multiple tasks', async () => {
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
              items: [
                {
                  id: 9005,
                  description: '<p>[vfm-key:duplicate:key]</p>',
                },
                {
                  id: 9006,
                  description: '<p>[vfm-key:duplicate:key]</p>',
                },
              ],
            }),
        } as Response);

      await expect(
        upsertTask(client, { id: 101 }, { title: 'Finding' }, 'duplicate:key'),
      ).rejects.toMatchObject({ status: 409, code: 'EXTERNAL_KEY_AMBIGUOUS' });
    });

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
      expect(echo.taskUrl).toBe('https://vikunja.example.com/tasks/9005');
    });

    it('reuses the created task while retrying only failed attachments', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vfm-create-attachment-'));
      const file = path.join(root, 'evidence.txt');
      await fs.writeFile(file, 'evidence');
      const createdTask = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'New Bug',
        project_id: 101,
      };
      try {
        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
          } as Response)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify(createdTask),
          } as Response)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ...createdTask, project: { title: 'Alpha' } }),
          } as Response)
          .mockResolvedValueOnce({
            ok: false,
            status: 422,
            text: async () => JSON.stringify({ detail: 'temporary upload rejection' }),
          } as Response);

        const first = await createTask(
          client,
          { id: 101 },
          { title: 'New Bug' },
          'create-with-attachment',
          [file],
          'Codex',
        );
        expect(first).toMatchObject({ action: 'created', attachmentErrors: [{ file }] });

        mockFetch
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () => JSON.stringify({ ...createdTask, project: { title: 'Alpha' } }),
          } as Response)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            text: async () =>
              JSON.stringify({
                success: [
                  { id: 3001, file: { name: 'evidence.txt', mime: 'text/plain', size: 8 } },
                ],
                errors: [],
              }),
          } as Response);
        const second = await createTask(
          client,
          { id: 101 },
          { title: 'New Bug' },
          'create-with-attachment',
          [file],
          'Codex',
        );

        expect(second).toMatchObject({
          action: 'created',
          attachments: [{ id: 3001, fileName: 'evidence.txt' }],
        });
        expect(second.attachmentErrors).toBeUndefined();
        expect(
          mockFetch.mock.calls.filter(
            (call: any) =>
              call[1]?.method === 'POST' && String(call[0]).includes('/projects/101/tasks'),
          ),
        ).toHaveLength(1);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('should get consolidated details in getTask', async () => {
      // Task resolution already returns full task fields.
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
            description: '<p>hello</p>',
            created_by: { id: 7, username: 'example-tester' },
          }),
      } as Response);

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              { id: 2001, comment: '<p>A comment</p>', author: { id: 1, username: 'tester' } },
            ],
            page: 1,
            per_page: 5,
            total: 1,
            total_pages: 1,
          }),
      } as Response);

      // Mock attachments (v2 nests file metadata under `file`).
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 3001,
                created: 't',
                file: { name: 'log.txt', mime: 'text/plain', size: 100 },
              },
            ],
            page: 1,
            per_page: 50,
            total: 1,
            total_pages: 1,
          }),
      } as Response);

      const details = await getTask(client, 9005, undefined, 5, 'full');
      expect(details.task.id).toBe(9005);
      expect(details.task.description).toBe('hello');
      expect(details.task.creator).toEqual({ id: 7, username: 'example-tester' });
      expect(details.comments.length).toBe(1);
      expect(details.comments[0].comment).toBe('A comment');
      expect(details.attachments.length).toBe(1);
      expect(details.attachments[0].fileName).toBe('log.txt');
      expect(details.composedCalls).toEqual([
        'GET /tasks/9005',
        'GET /tasks/9005/comments?sort_by=created&order_by=desc&page=1&per_page=5',
        'GET /tasks/9005/attachments?page=1&per_page=20',
      ]);
      const urls = mockFetch.mock.calls.map((c: any) => c[0]);
      expect(urls.some((u: string) => u.includes('expand=comments'))).toBe(false);
      expect(
        urls.some((u: string) =>
          u.includes('/comments?sort_by=created&order_by=desc&page=1&per_page=5'),
        ),
      ).toBe(true);
    });

    it('defaults to a minimal projected task without fetching comments or attachments', async () => {
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
            created: '2026-08-20T10:00:00Z',
            updated: '2026-08-21T10:00:00Z',
            created_by: { id: 7, username: 'example-tester' },
            labels: [{ id: 9, title: 'status:review' }],
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
          createdBy: { id: 7, username: 'example-tester' },
          createdAt: '2026-08-20T10:00:00Z',
          updatedAt: '2026-08-21T10:00:00Z',
          lastEditor: null,
          labels: [{ id: 9, title: 'status:review' }],
          workflowStatus: { state: 'single', label: 'review' },
          descriptionVersion: '2026-08-21T10:00:00Z',
          taskUrl: 'https://vikunja.example.com/tasks/9005',
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
      // Bounded comments endpoint (wrapped shape)
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
      expect(details.composedCalls).toContain(
        'GET /tasks/9005/comments?sort_by=created&order_by=desc&page=1&per_page=5',
      );
    });

    it('bounds full task comments and attachments with truthful metadata', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 9005,
              index: 305,
              identifier: 'ALPHA-305',
              title: 'Task',
              project_id: 101,
              project: { title: 'Alpha' },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: Array.from({ length: 5 }, (_, id) => ({ id, comment: '<p>x</p>' })),
              page: 1,
              per_page: 5,
              total: 1000,
              total_pages: 200,
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              items: Array.from({ length: 3 }, (_, id) => ({
                id,
                file: { name: `log-${id}.txt`, size: 1 },
              })),
              page: 1,
              per_page: 3,
              total: 1000,
              total_pages: 334,
            }),
            { status: 200 },
          ),
        );

      const details = await getTask(client, 9005, undefined, 5, 'full', {
        attachmentLimit: 3,
      });

      expect(details.comments).toHaveLength(5);
      expect(details.attachments).toHaveLength(3);
      expect(details.commentPagination).toEqual({
        returnedCount: 5,
        totalCount: 1000,
        incomplete: true,
        nextPage: 2,
      });
      expect(details.attachmentPagination).toEqual({
        returnedCount: 3,
        totalCount: 1000,
        incomplete: true,
        nextPage: 2,
      });
    });

    it('enforces maxResponseChars on a full task get', async () => {
      mockFetch
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              id: 9005,
              index: 305,
              title: 'Task with a large description',
              description: `<p>${'x'.repeat(1000)}</p>`,
              project_id: 101,
              project: { title: 'Alpha' },
            }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ items: [], total: 0, page: 1, per_page: 5, total_pages: 1 }),
            {
              status: 200,
            },
          ),
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ items: [], total: 0, page: 1, per_page: 20, total_pages: 1 }),
            { status: 200 },
          ),
        );

      await expect(
        getTask(client, 9005, undefined, 5, 'full', { maxResponseChars: 500 }),
      ).rejects.toMatchObject({ status: 413, code: 'RESPONSE_TOO_LARGE' });
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

    it('recovers a subscription schema error only when readback proves the patch applied', async () => {
      const openTask = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Verified task',
        project_id: 101,
        project: { title: 'Alpha' },
        done: false,
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(openTask),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(openTask),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          text: async () =>
            JSON.stringify({
              detail: 'Validation failed',
              errors: [
                {
                  location: ['subscription', 'entity'],
                  message: 'expected integer',
                },
              ],
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ ...openTask, done: true }),
        } as Response);

      await expect(updateTask(client, 9005, { done: true })).resolves.toMatchObject({
        action: 'closed',
        target: { id: 9005, identifier: 'ALPHA-305' },
      });
    });

    it('preserves the subscription schema error when readback shows no update', async () => {
      const openTask = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Still open',
        project_id: 101,
        project: { title: 'Alpha' },
        done: false,
      };
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(openTask),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(openTask),
        } as Response)
        .mockResolvedValueOnce({
          ok: false,
          status: 422,
          statusText: 'Unprocessable Entity',
          text: async () =>
            JSON.stringify({
              detail: 'Validation failed',
              errors: [
                {
                  location: ['subscription', 'entity'],
                  message: 'expected integer',
                },
              ],
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(openTask),
        } as Response);

      await expect(updateTask(client, 9005, { done: true })).rejects.toMatchObject({
        code: 'VIKUNJA_SUBSCRIPTION_SCHEMA_BUG',
        status: 502,
      });
    });

    it('appends description text before a stable-key marker', async () => {
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Marked task',
        description: '<p>Existing body</p><p>[vfm-key:detector:file.ts:10]</p>',
        project_id: 101,
        project: { title: 'Alpha' },
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
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify(existing),
        } as Response);

      await updateTask(client, 9005, { appendDescription: 'New evidence' });

      const patchCall = mockFetch.mock.calls.find((call: any) => call[1]?.method === 'PATCH');
      const description = JSON.parse(patchCall[1].body)[0].value as string;
      expect(description.indexOf('Existing body')).toBeLessThan(
        description.indexOf('New evidence'),
      );
      expect(description.indexOf('New evidence')).toBeLessThan(
        description.indexOf('[vfm-key:detector:file.ts:10]'),
      );
      expect(description).toContain('<p>Existing body</p>');
    });

    it('preserves unsupported rich HTML byte-for-byte while appending Markdown', async () => {
      const rich =
        '<table data-layout="wide"><tbody><tr><td><img src="https://vikunja.example.com/a.png"></td></tr></tbody></table>';
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Rich task',
        description: `${rich}<p>[vfm-key:rich:1]</p>`,
        project_id: 101,
        project: { title: 'Alpha' },
      };
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify(existing)))
        .mockResolvedValueOnce(new Response(JSON.stringify(existing)))
        .mockResolvedValueOnce(new Response(JSON.stringify(existing)));

      await updateTask(client, 9005, { appendDescription: '**New** evidence' });

      const patchCall = mockFetch.mock.calls.find((call: any) => call[1]?.method === 'PATCH');
      const description = JSON.parse(patchCall[1].body)[0].value as string;
      expect(description.startsWith(rich)).toBe(true);
      expect(description).toContain('<p><strong>New</strong> evidence</p>');
      expect(description.endsWith('<p>[vfm-key:rich:1]</p>')).toBe(true);
    });

    it('does not replace semantically identical description HTML', async () => {
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'Equivalent description',
        description: '<p>Line one<br>Line two</p>',
        project_id: 101,
        project: { title: 'Alpha' },
      };
      mockFetch
        .mockResolvedValueOnce(new Response(JSON.stringify(existing)))
        .mockResolvedValueOnce(new Response(JSON.stringify(existing)))
        .mockResolvedValueOnce(new Response(JSON.stringify(existing)));

      const result = await updateTask(client, 9005, { description: 'Line one\nLine two' });

      expect(result.action).toBe('unchanged');
      expect(mockFetch.mock.calls.some((call: any) => call[1]?.method === 'PATCH')).toBe(false);
    });

    it('rejects update requests that replace and append description together', async () => {
      await expect(
        updateTask(client, 9005, {
          description: 'Replacement',
          appendDescription: 'Appendix',
        }),
      ).rejects.toMatchObject({ status: 400, code: 'VALIDATION_ERROR' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('treats clearing an already-empty (zero-date) due date as unchanged', async () => {
      const existing = {
        id: 9005,
        index: 305,
        identifier: 'ALPHA-305',
        title: 'No due date',
        project_id: 101,
        project: { title: 'Alpha' },
        done: false,
        due_date: '0001-01-01T00:00:00Z',
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

      const echo = await updateTask(client, 9005, { dueDate: null });

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
