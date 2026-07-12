/**
 * Tests for project/task identity resolution.
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
import { resolveProject, resolveTask, cache } from '../src/identity.js';

describe('Identity and Resolution Cache tests', () => {
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
    cache.clearProjects();
    cache.clearLabels();
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  describe('resolveProject', () => {
    it('should resolve project by ID successfully', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      const ref = await resolveProject(client, { id: 101 });
      expect(ref).toEqual({ id: 101, title: 'Alpha' });
      expect(mockFetch).toHaveBeenCalledWith(
        'https://vikunja.example.com/api/v2/projects/101',
        expect.anything(),
      );
    });

    it('rejects contradictory project id and title selectors', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      await expect(resolveProject(client, { id: 101, title: 'Beta' })).rejects.toMatchObject({
        code: 'PROJECT_SELECTOR_MISMATCH',
      });
    });

    it('should resolve project by exact title and cache it', async () => {
      const mockProjects = [
        { id: 101, title: 'Alpha' },
        { id: 102, title: 'Beta' },
      ];
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify(mockProjects),
      } as Response);

      const ref1 = await resolveProject(client, { title: 'Beta' });
      expect(ref1).toEqual({ id: 102, title: 'Beta' });

      // Second call should hit the cache (no fetch should be made)
      mockFetch.mockClear();
      const ref2 = await resolveProject(client, { title: 'Beta' });
      expect(ref2).toEqual({ id: 102, title: 'Beta' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should resolve by title when /projects returns the v2 paginated wrapper', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              { id: 101, title: 'Alpha' },
              { id: 102, title: 'Beta' },
            ],
            page: 1,
            per_page: 50,
            total: 2,
            total_pages: 1,
          }),
      } as Response);

      const ref = await resolveProject(client, { title: 'Alpha' });
      expect(ref).toEqual({ id: 101, title: 'Alpha' });
    });

    it('should throw PROJECT_NOT_FOUND if title matches no project', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 1, title: 'Alpha' }]),
      } as Response);

      await expect(resolveProject(client, { title: 'Beta' })).rejects.toThrow(
        expect.objectContaining({
          status: 404,
          code: 'PROJECT_NOT_FOUND',
        }),
      );
    });

    it('should throw PROJECT_TITLE_AMBIGUOUS on multiple exact title matches', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify([
            { id: 101, title: 'Alpha' },
            { id: 102, title: 'Alpha' },
          ]),
      } as Response);

      await expect(resolveProject(client, { title: 'Alpha' })).rejects.toThrow(
        expect.objectContaining({
          status: 409,
          code: 'PROJECT_TITLE_AMBIGUOUS',
        }),
      );
    });
  });

  describe('resolveTask', () => {
    it('should resolve global task ID without project context', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'My Task',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      const ref = await resolveTask(client, 9005);
      expect(ref).toEqual({
        id: 9005,
        index: 305,
        identifier: undefined,
        project: { id: 101, title: 'Alpha' },
        title: 'My Task',
        labels: [],
      });
    });

    it('should resolve the real project title when the task GET omits it (not "Unknown Project")', async () => {
      // The live v2 single-task GET returns project_id but no project title.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, title: 'My Task', project_id: 101 }),
      } as Response);
      // resolveTask must then resolve the project to echo an honest title.
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      const ref = await resolveTask(client, 9005);
      expect(ref.project).toEqual({ id: 101, title: 'Alpha' });
      expect(mockFetch.mock.calls[1][0]).toContain('/projects/101');
    });

    it('should throw PROJECT_MISMATCH if task project does not match supplied project context', async () => {
      // First fetch for tasks get
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'My Task',
            project_id: 101, // belongs to 101
            project: { title: 'Alpha' },
          }),
      } as Response);

      // Second fetch for projects get to resolve project ID 102
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 102, title: 'Beta' }),
      } as Response);

      await expect(resolveTask(client, 9005, { id: 102 })).rejects.toThrow(
        expect.objectContaining({
          status: 400,
          code: 'PROJECT_MISMATCH',
        }),
      );
    });

    it('should require project context for #index reference', async () => {
      await expect(resolveTask(client, '#305')).rejects.toThrow(
        expect.objectContaining({
          status: 400,
          code: 'PROJECT_CONTEXT_REQUIRED',
        }),
      );
    });

    it('should resolve project-scoped task index successfully', async () => {
      // Mock project fetch (to resolve Beta title -> id 102)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify([{ id: 102, title: 'Beta' }]),
      } as Response);

      // Mock task by index fetch
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 9005,
                index: 305,
                title: 'Task Title',
                project_id: 102,
              },
            ],
            page: 1,
            per_page: 2,
            total: 1,
            total_pages: 1,
          }),
      } as Response);

      const ref = await resolveTask(client, '#305', { title: 'Beta' });
      expect(ref).toEqual({
        id: 9005,
        index: 305,
        identifier: undefined,
        project: { id: 102, title: 'Beta' },
        title: 'Task Title',
        labels: [],
      });
      const lookupUrl = mockFetch.mock.calls[1][0] as string;
      expect(new URL(lookupUrl).searchParams.get('filter')).toBe('index = 305');
    });

    it('matches a full task identifier case-insensitively', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ id: 102, title: 'Beta' }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                {
                  id: 9005,
                  index: 305,
                  identifier: 'BETA-305',
                  title: 'Task Title',
                  project_id: 102,
                },
              ],
              page: 1,
              per_page: 2,
              total: 1,
              total_pages: 1,
            }),
        } as Response);

      await expect(resolveTask(client, 'beta-305', { id: 102 })).resolves.toMatchObject({
        id: 9005,
      });
    });
  });

  describe('Cache TTL and Invalidation', () => {
    it('should expire entries after 45s', () => {
      const now = Date.now();
      jest.useFakeTimers();
      jest.setSystemTime(now);

      cache.setProject('Alpha', { id: 101, title: 'Alpha' });
      expect(cache.getProject('Alpha')).toEqual({ id: 101, title: 'Alpha' });

      // Advance time by 46 seconds
      jest.advanceTimersByTime(46000);
      expect(cache.getProject('Alpha')).toBeNull();

      jest.useRealTimers();
    });

    it('should invalidate specific project or label on demand', () => {
      cache.setProject('Alpha', { id: 101, title: 'Alpha' });
      expect(cache.getProject('Alpha')).toEqual({ id: 101, title: 'Alpha' });
      cache.invalidateProject('Alpha');
      expect(cache.getProject('Alpha')).toBeNull();
    });
  });
});
