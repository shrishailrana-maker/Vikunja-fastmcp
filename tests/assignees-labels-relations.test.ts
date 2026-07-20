/**
 * Tests for assignees, labels, and relations.
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
  assignTask,
  unassignTask,
  listAssignees,
  applyLabel,
  removeLabel,
  listLabels,
  relateTask,
  unrelateTask,
  listRelations,
  resolveLabel,
} from '../src/tasks.js';
import { cache } from '../src/identity.js';

describe('Assignees, Labels and Relations tests', () => {
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
    cache.clearLabels();
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe('Assignees', () => {
    it('should assign a user by username and preserve assignees', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            project_id: 101,
            project: { title: 'Alpha' },
            assignees: [],
          }),
      } as Response);

      // 2. Resolve user by username
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [{ id: 42, username: 'bob' }] }),
      } as Response);

      // 3. Mock assign POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 9005 }),
      } as Response);

      const echo = await assignTask(client, 9005, 'bob');
      expect(echo.action).toBe('updated');
      expect(echo.target.id).toBe(9005);

      const postCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body).toEqual({ user_id: 42 });
    });

    it('should unassign a user', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            project_id: 101,
            project: { title: 'Alpha' },
            assignees: [{ id: 42, username: 'bob' }],
          }),
      } as Response);

      // 2. Resolve user by ID directly (digit string)
      // 3. Mock unassign DELETE
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const echo = await unassignTask(client, 9005, 42);
      expect(echo.target.id).toBe(9005);

      const deleteCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'DELETE');
      expect(deleteCall).toBeDefined();
      expect(deleteCall[0]).toContain('/tasks/9005/assignees/42');
    });

    it('treats assigning an existing assignee as unchanged', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Assigned task',
            project_id: 101,
            project: { title: 'Alpha' },
            assignees: [{ id: 42, username: 'bob' }],
          }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [{ id: 42, username: 'bob' }] }),
      } as Response);

      const echo = await assignTask(client, 9005, 'bob');

      expect(echo.action).toBe('unchanged');
      expect(mockFetch.mock.calls.some((call: any) => call[1]?.method === 'POST')).toBe(false);
    });

    it('treats removing an absent assignee as unchanged', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Unassigned task',
            project_id: 101,
            project: { title: 'Alpha' },
            assignees: [],
          }),
      } as Response);

      const echo = await unassignTask(client, 9005, 42);

      expect(echo.action).toBe('unchanged');
      expect(mockFetch.mock.calls.some((call: any) => call[1]?.method === 'DELETE')).toBe(false);
    });

    it('should list assignees', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 42, username: 'bob' }]),
      } as Response);

      const list = await listAssignees(client, 9005);
      expect(list.length).toBe(1);
      expect(list[0].username).toBe('bob');
    });
  });

  describe('Labels', () => {
    it('treats an already-applied label as a harmless no-op', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Existing bug',
            project_id: 101,
            project: { title: 'Alpha' },
            labels: [{ id: 801, title: 'frontend' }],
          }),
      } as Response);

      const echo = await applyLabel(client, 9005, 'FRONTEND');

      expect(echo.action).toBe('unchanged');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should resolve and create label if absent, caching the ID', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Search labels (absent)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [] }),
      } as Response);

      // 3. Create label
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({ id: 801, title: 'frontend' }),
      } as Response);

      // 4. Apply label
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({}),
      } as Response);

      const echo = await applyLabel(client, 9005, 'frontend');
      expect(echo.action).toBe('updated');

      // Verify label is now cached
      expect(cache.getLabel('frontend')).toBe(801);

      // Call applyLabel again - should reuse cache and not call GET/POST label APIs
      mockFetch.mockClear();

      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      // 2. Apply label
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({}),
      } as Response);

      await applyLabel(client, 9005, 'frontend');

      // No GET /labels or POST /labels should have been made
      const labelCalls = mockFetch.mock.calls.filter(
        (c: any) => c[0].includes('/labels') && c[1]?.method !== 'POST',
      );
      expect(labelCalls.length).toBe(0);
    });

    it('should remove a label', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            project_id: 101,
            project: { title: 'Alpha' },
            labels: [{ id: 801, title: 'frontend' }],
          }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const echo = await removeLabel(client, 9005, 'frontend');
      expect(echo.target.id).toBe(9005);
    });

    it('treats removing an absent label as unchanged without a label lookup', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Task without label',
            project_id: 101,
            project: { title: 'Alpha' },
            labels: [],
          }),
      } as Response);

      const echo = await removeLabel(client, 9005, 'frontend');

      expect(echo.action).toBe('unchanged');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should list labels', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 801, title: 'frontend' }]),
      } as Response);

      const list = await listLabels(client, 9005);
      expect(list.length).toBe(1);
      expect(list[0].title).toBe('frontend');
    });

    it('fails rather than guessing when duplicate labels share the same title', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              { id: 801, title: 'bug' },
              { id: 802, title: 'Bug' },
            ],
            page: 1,
            per_page: 50,
            total: 2,
            total_pages: 1,
          }),
      } as Response);

      await expect(resolveLabel(client, 'bug')).rejects.toMatchObject({
        code: 'LABEL_TITLE_AMBIGUOUS',
      });
    });
  });

  describe('Relations', () => {
    it('should add blocking relation and reject invalid kinds', async () => {
      // 1. Resolve task 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Resolve task 2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9006, index: 306, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 3. Mock relate POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({}),
      } as Response);

      const echo = await relateTask(client, 9005, 9006, 'blocking');
      expect(echo.action).toBe('updated');

      // Verify it checks relation enum
      await expect(relateTask(client, 9005, 9006, 'super-related')).rejects.toThrow(
        expect.objectContaining({
          status: 400,
          code: 'INVALID_RELATION_KIND',
        }),
      );
    });

    it('relates to a global-id task in a DIFFERENT project without PROJECT_MISMATCH', async () => {
      // Primary task resolved with project context (id 101).
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      // resolveProject(projectSelector) for the primary mismatch check.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);
      // Other task is a GLOBAL id living in project 999 — must NOT inherit
      // project 101 (that would throw PROJECT_MISMATCH).
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9006, index: 12, project_id: 999, project: { title: 'Beta' } }),
      } as Response);
      // relate POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({}),
      } as Response);

      const echo = await relateTask(client, 9005, 9006, 'blocking', { id: 101 });
      expect(echo.action).toBe('updated');
      expect(mockFetch.mock.calls.some((c: any) => c[1]?.method === 'POST')).toBe(true);
    });

    it('should list relations from task details object only', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Get task details containing related_tasks
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            title: 'Main task',
            related_tasks: {
              subtask: [
                {
                  id: 9006,
                  title: 'Sub task',
                  index: 306,
                  done: false,
                },
              ],
            },
          }),
      } as Response);

      const relations = await listRelations(client, 9005);
      expect(relations.length).toBe(1);
      expect(relations[0].relationKind).toBe('subtask');
      expect(relations[0].task.id).toBe(9006);
    });

    it('should remove a task relation', async () => {
      // 1. Resolve task 1
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Resolve task 2
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9006, index: 306, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 3. Mock unrelate DELETE
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const echo = await unrelateTask(client, 9005, 9006, 'subtask');
      expect(echo.target.id).toBe(9005);
    });

    it('unrelates a global-id task in a DIFFERENT project without PROJECT_MISMATCH', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9006, index: 12, project_id: 999, project: { title: 'Beta' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const echo = await unrelateTask(client, 9005, 9006, 'blocking', { id: 101 });
      expect(echo.action).toBe('updated');
      expect(mockFetch.mock.calls.some((c: any) => c[1]?.method === 'DELETE')).toBe(true);
    });
  });
});
