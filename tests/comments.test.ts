/**
 * Tests for comments and compound operations.
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
  createComment,
  listComments,
  getComment,
  updateComment,
  deleteComment,
} from '../src/comments.js';
import { createIfAbsent, closeWithEvidence } from '../src/tasks.js';
import { idempotency } from '../src/idempotency.js';

describe('Comments and Compound Operations tests', () => {
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

  describe('Comment CRUD', () => {
    it('should create comment and convert Markdown to HTML', async () => {
      // Mock task resolve
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

      // Mock comment create
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 2001,
            comment: '<p><strong>Bold comment</strong></p>',
            author: { id: 1, username: 'tester' },
            created: '2026-07-12T00:00:00Z',
          }),
      } as Response);

      const result = await createComment(client, 9005, '**Bold comment**');
      expect(result.id).toBe(2001);
      expect(result.comment).toBe('**Bold comment**');

      // Verify that markdown was converted to html in body
      const postCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall[1].body);
      expect(body.comment).toBe('<p><strong>Bold comment</strong></p>');
    });

    it('should respect idempotency key for comment creation', async () => {
      // Mock task resolve
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

      // Mock comment create
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 2001,
            comment: 'hello',
            author: { id: 1, username: 'tester' },
          }),
      } as Response);

      const res1 = await createComment(client, 9005, 'hello', undefined, 'idemp-comment-key');
      expect(res1.id).toBe(2001);

      // Second call should return cached without fetch
      mockFetch.mockClear();
      const res2 = await createComment(client, 9005, 'hello', undefined, 'idemp-comment-key');
      expect(res2.id).toBe(2001);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('should list one bounded page of comments with truthful pagination', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 2001,
                comment: '<p>c1</p>',
                author: { id: 1 },
                created: '2026-07-12T00:00:00Z',
              },
            ],
            page: 2,
            per_page: 10,
            total: 21,
            total_pages: 3,
          }),
      } as Response);

      const list = await listComments(client, 9005, undefined, 2, 10);
      expect(list.comments).toHaveLength(1);
      expect(list.comments[0].comment).toBe('c1');
      expect(list.pagination).toMatchObject({
        page: 2,
        perPage: 10,
        total: 21,
        totalPages: 3,
        hasMore: true,
        nextPage: 3,
      });
      expect(mockFetch.mock.calls[1][0]).toContain('/tasks/9005/comments?page=2&per_page=10');
    });

    it('should get comment details', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 2001,
            comment: '<p>c1</p>',
            author: { id: 1 },
            created: '2026-07-12T00:00:00Z',
          }),
      } as Response);

      const comment = await getComment(client, 9005, 2001);
      expect(comment.id).toBe(2001);
      expect(comment.comment).toBe('c1');
    });

    it('should update comment text', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 2001,
            comment: '<p><strong>updated</strong></p>',
            author: { id: 1 },
            created: '2026-07-12T00:00:00Z',
          }),
      } as Response);

      const comment = await updateComment(client, 9005, 2001, '**updated**');
      expect(comment.comment).toBe('**updated**');
    });

    it('should delete comment successfully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 204,
        text: async () => '',
      } as Response);

      const res = await deleteComment(client, 9005, 2001);
      expect(res.ok).toBe(true);
      expect(res.commentId).toBe(2001);
    });
  });

  describe('createIfAbsent', () => {
    it('should find existing task and return it without creating a new task', async () => {
      // 1. Resolve project
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      // 2. Mock project tasks search returning matching task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 9005,
                index: 305,
                title: 'Duplicate Title',
                project_id: 101,
              },
            ],
          }),
      } as Response);

      const echo = await createIfAbsent(client, { id: 101 }, { title: 'Duplicate Title' });
      expect(echo.action).toBe('exists');
      expect(echo.target.id).toBe(9005);
      expect(echo.target.title).toBe('Duplicate Title');

      // Safe titles use server-side title equality filter.
      const searchUrl = mockFetch.mock.calls[1][0] as string;
      expect(searchUrl).toContain('filter=');
      expect(decodeURIComponent(searchUrl)).toContain("title = 'Duplicate Title'");

      // Verify no POST task creation calls were made
      const postCalls = mockFetch.mock.calls.filter((c: any) => c[1]?.method === 'POST');
      expect(postCalls.length).toBe(0);
    });

    it('handles a title with parentheses/brackets via q (not filter DSL)', async () => {
      const title = '[MCP] Login bug (v2.3.0-991)';
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
            items: [{ id: 9010, index: 7, title, project_id: 101 }],
            total: 1,
            page: 1,
            total_pages: 1,
          }),
      } as Response);

      const echo = await createIfAbsent(client, { id: 101 }, { title });
      expect(echo.action).toBe('exists');
      expect(echo.target.id).toBe(9010);
      // Special characters must not go to the filter parser.
      const searchUrl = mockFetch.mock.calls[1][0] as string;
      expect(searchUrl).toContain('q=');
      expect(searchUrl).not.toContain('filter=');
    });

    it('should create task if search returns no matches', async () => {
      // 1. Resolve project
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      // 2. Mock project tasks search returning no matching tasks
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ items: [] }),
      } as Response);

      // 3. Mock second project resolution inside createTask
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
      } as Response);

      // 4. Mock task create POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9006,
            index: 306,
            title: 'Unique Title',
            project_id: 101,
          }),
      } as Response);

      const echo = await createIfAbsent(client, { id: 101 }, { title: 'Unique Title' });
      expect(echo.action).toBe('created');
      expect(echo.target.id).toBe(9006);

      const postCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'POST');
      expect(postCall).toBeDefined();
    });
  });

  describe('closeWithEvidence', () => {
    it('should comment first, then update task status to done', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Audit Task',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // 2. Comment create resolve task (nested within comment creation)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Audit Task',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // 3. Mock comment create POST
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            id: 2001,
            comment: 'evidence text',
            author: { id: 1 },
          }),
      } as Response);

      // 4. Update task resolve task (nested within updateTask)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Audit Task',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // 5. Update task current GET (nested within updateTask)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Audit Task',
            project_id: 101,
            done: false,
          }),
      } as Response);

      // 6. Update task PATCH
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Audit Task',
            project_id: 101,
            done: true,
          }),
      } as Response);

      const res = await closeWithEvidence(client, 9005, 'evidence text');
      expect(res.comment.id).toBe(2001);
      expect(res.task.action).toBe('closed');
      expect(res.composedCalls).toEqual(['POST /tasks/9005/comments', 'PATCH /tasks/9005']);
    });

    it('should fail and not close the task if comment creation fails', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            title: 'Audit Task',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // 2. Resolve task for comment create
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);

      // 3. Mock comment create returning 500 error
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: 'Internal Error',
        text: async () => 'Database write failed',
      } as Response);

      await expect(closeWithEvidence(client, 9005, 'evidence text')).rejects.toThrow();

      // Verify no PATCH call was made to tasks endpoint
      const patchCalls = mockFetch.mock.calls.filter((c: any) => c[1]?.method === 'PATCH');
      expect(patchCalls.length).toBe(0);
    });
  });
});
