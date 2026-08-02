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

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as Response;
}

function projectPage(projects: unknown[]): unknown {
  return {
    items: projects,
    page: 1,
    per_page: 100,
    total: projects.length,
    total_pages: 1,
  };
}

function taskPage(task: unknown): unknown {
  return {
    items: [task],
    page: 1,
    per_page: 2,
    total: 1,
    total_pages: 1,
  };
}

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
    it('rejects a project response that omits its title', async () => {
      mockFetch.mockResolvedValueOnce(jsonResponse({ id: 101 }));
      await expect(resolveProject(client, { id: 101 })).rejects.toMatchObject({
        status: 502,
        code: 'INVALID_API_RESPONSE',
      });
    });
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

      mockFetch.mockClear();
      await expect(resolveProject(client, { id: 101 })).resolves.toEqual({
        id: 101,
        title: 'Alpha',
      });
      expect(mockFetch).not.toHaveBeenCalled();
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
        text: async () =>
          JSON.stringify({
            items: mockProjects,
            page: 1,
            per_page: 100,
            total: mockProjects.length,
            total_pages: 1,
          }),
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
        text: async () =>
          JSON.stringify({
            items: [{ id: 1, title: 'Alpha' }],
            page: 1,
            per_page: 100,
            total: 1,
            total_pages: 1,
          }),
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
          JSON.stringify({
            items: [
              { id: 101, title: 'Alpha' },
              { id: 102, title: 'Alpha' },
            ],
            page: 1,
            per_page: 100,
            total: 2,
            total_pages: 1,
          }),
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
    it('resolves an explicit globalId selector without project context', async () => {
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

      const ref = await resolveTask(client, { globalId: 9005 });
      expect(ref).toEqual({
        id: 9005,
        index: 305,
        identifier: undefined,
        project: { id: 101, title: 'Alpha' },
        title: 'My Task',
        labels: [],
        assignees: [],
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

      const ref = await resolveTask(client, { globalId: 9005 });
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

      await expect(resolveTask(client, { globalId: 9005 }, { id: 102 })).rejects.toThrow(
        expect.objectContaining({
          status: 400,
          code: 'PROJECT_MISMATCH',
        }),
      );
    });

    it('requires project context for an explicit projectIndex selector', async () => {
      await expect(resolveTask(client, { projectIndex: 305 })).rejects.toThrow(
        expect.objectContaining({
          status: 400,
          code: 'PROJECT_CONTEXT_REQUIRED',
        }),
      );
    });

    it('rejects legacy bare numeric and string selectors', async () => {
      await expect(resolveTask(client, 9005 as any)).rejects.toMatchObject({
        code: 'INVALID_TASK_SELECTOR',
      });
      await expect(resolveTask(client, 'ALPHA-517' as any)).rejects.toMatchObject({
        code: 'INVALID_TASK_SELECTOR',
      });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('resolves ALPHA-517 from its project identifier without project context', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(
            projectPage([
              { id: 101, title: 'Alpha', identifier: 'ALPHA' },
              { id: 102, title: 'Beta', identifier: 'BETA' },
            ]),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            taskPage({
              id: 9005,
              index: 517,
              identifier: 'ALPHA-517',
              title: 'Alpha task',
              project_id: 101,
            }),
          ),
        );

      await expect(resolveTask(client, { identifier: 'ALPHA-517' })).resolves.toMatchObject({
        id: 9005,
        identifier: 'ALPHA-517',
        project: { id: 101, title: 'Alpha' },
      });
    });

    it('resolves BETA-517 independently from ALPHA-517', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(
            projectPage([
              { id: 101, title: 'Alpha', identifier: 'ALPHA' },
              { id: 102, title: 'Beta', identifier: 'BETA' },
            ]),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            taskPage({
              id: 9006,
              index: 517,
              identifier: 'BETA-517',
              title: 'Beta task',
              project_id: 102,
            }),
          ),
        );

      await expect(resolveTask(client, { identifier: 'BETA-517' })).resolves.toMatchObject({
        id: 9006,
        identifier: 'BETA-517',
        project: { id: 102, title: 'Beta' },
      });
    });

    it('matches a project identifier case-insensitively without project context', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(projectPage([{ id: 101, title: 'Alpha', identifier: 'ALPHA' }])),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            taskPage({
              id: 9005,
              index: 517,
              identifier: 'ALPHA-517',
              title: 'Alpha task',
              project_id: 101,
            }),
          ),
        );

      await expect(resolveTask(client, { identifier: 'alpha-517' })).resolves.toMatchObject({
        id: 9005,
        identifier: 'ALPHA-517',
      });
    });

    it('rejects an unknown project identifier instead of guessing from the index', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(projectPage([{ id: 101, title: 'Alpha', identifier: 'ALPHA' }])),
      );

      await expect(resolveTask(client, { identifier: 'NOSUCH-1' })).rejects.toMatchObject({
        status: 400,
        code: 'UNKNOWN_PROJECT_IDENTIFIER',
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('rejects an ambiguous project identifier and lists its candidates', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          projectPage([
            { id: 101, title: 'Alpha Primary', identifier: 'ALPHA' },
            { id: 102, title: 'Alpha Archive', identifier: 'alpha' },
          ]),
        ),
      );

      await expect(resolveTask(client, { identifier: 'ALPHA-1' })).rejects.toMatchObject({
        status: 400,
        code: 'AMBIGUOUS_PROJECT_IDENTIFIER',
        message: expect.stringContaining('Alpha Archive'),
      });
    });

    it('rejects a projectSelector that conflicts with the identifier prefix', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse(
          projectPage([
            { id: 101, title: 'Alpha', identifier: 'ALPHA' },
            { id: 102, title: 'Beta', identifier: 'BETA' },
          ]),
        ),
      );

      await expect(
        resolveTask(client, { identifier: 'ALPHA-517' }, { title: 'Beta' }),
      ).rejects.toMatchObject({
        status: 400,
        code: 'PROJECT_SCOPE_MISMATCH',
        message: expect.stringContaining('Beta'),
      });
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('resolves an explicit globalId without treating it as a project index', async () => {
      mockFetch.mockResolvedValueOnce(
        jsonResponse({
          id: 517,
          index: 1,
          identifier: '#1',
          title: 'Global task',
          project_id: 1,
          project: { title: 'Inbox' },
        }),
      );

      await expect(resolveTask(client, { globalId: 517 })).resolves.toMatchObject({
        id: 517,
        index: 1,
        project: { id: 1, title: 'Inbox' },
      });
      expect(mockFetch.mock.calls[0][0]).toContain('/tasks/517');
    });

    it('reuses the project identifier cache across task lookups', async () => {
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(projectPage([{ id: 101, title: 'Alpha', identifier: 'ALPHA' }])),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            taskPage({
              id: 9005,
              index: 517,
              identifier: 'ALPHA-517',
              title: 'First task',
              project_id: 101,
            }),
          ),
        )
        .mockResolvedValueOnce(
          jsonResponse(
            taskPage({
              id: 9006,
              index: 518,
              identifier: 'ALPHA-518',
              title: 'Second task',
              project_id: 101,
            }),
          ),
        );

      await resolveTask(client, { identifier: 'ALPHA-517' });
      await resolveTask(client, { identifier: 'ALPHA-518' });

      const projectListCalls = mockFetch.mock.calls.filter(([url]: [string]) =>
        url.includes('/projects?'),
      );
      expect(projectListCalls).toHaveLength(1);
    });

    it('should resolve project-scoped task index successfully', async () => {
      // Mock project fetch (to resolve Beta title -> id 102)
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

      const ref = await resolveTask(client, { projectIndex: 305 }, { title: 'Beta' });
      expect(ref).toEqual({
        id: 9005,
        index: 305,
        identifier: undefined,
        project: { id: 102, title: 'Beta' },
        title: 'Task Title',
        labels: [],
        assignees: [],
      });
      const lookupUrl = mockFetch.mock.calls[1][0] as string;
      expect(new URL(lookupUrl).searchParams.get('filter')).toBe('index = 305');
    });

    it('matches a full task identifier case-insensitively', async () => {
      mockFetch
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [{ id: 102, title: 'Beta', identifier: 'BETA' }],
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

      await expect(
        resolveTask(client, { identifier: 'beta-305' }, { id: 102 }),
      ).resolves.toMatchObject({
        id: 9005,
      });
    });

    it('refreshes a cached project catalog once for a newly assigned identifier', async () => {
      cache.setProjectIdentifiers([{ id: 101, title: 'Alpha', identifier: 'OLD' }]);
      mockFetch
        .mockResolvedValueOnce(
          jsonResponse(projectPage([{ id: 101, title: 'Alpha', identifier: 'ALPHA' }])),
        )
        .mockResolvedValueOnce(
          jsonResponse({
            items: [
              {
                id: 9005,
                index: 5,
                identifier: 'ALPHA-5',
                title: 'Task',
                project_id: 101,
              },
            ],
            page: 1,
            per_page: 2,
            total: 1,
            total_pages: 1,
          }),
        );

      await expect(resolveTask(client, { identifier: 'ALPHA-5' })).resolves.toMatchObject({
        id: 9005,
      });
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('Cache TTL and Invalidation', () => {
    it('preserves duplicate project-title ambiguity after cache population', async () => {
      cache.setProjectIdentifiers([
        { id: 101, title: 'Alpha', identifier: 'A1' },
        { id: 102, title: 'alpha', identifier: 'A2' },
      ]);

      await expect(resolveProject(client, { title: 'ALPHA' })).rejects.toMatchObject({
        status: 409,
        code: 'PROJECT_TITLE_AMBIGUOUS',
      });
      expect(global.fetch).not.toHaveBeenCalled();
    });

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
