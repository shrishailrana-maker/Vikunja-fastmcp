/**
 * Task comment create/list/get/update/delete.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { VikunjaApiClient } from './api.js';
import { resolveTask } from './identity.js';
import { htmlToMarkdown, markdownToHtml, normalizePagination, toItemArray } from './format.js';
import { idempotency } from './idempotency.js';

export interface Comment {
  id: number;
  comment: string;
  author: {
    id: number;
    username: string;
  };
  created: string;
}

export async function createComment(
  client: VikunjaApiClient,
  taskSelector: string | number,
  comment: string,
  projectSelector?: { id?: number; title?: string },
  idempotencyKey?: string,
): Promise<Comment> {
  const projectKey = projectSelector?.id ?? projectSelector?.title?.toLowerCase() ?? 'global';
  const cacheKey = idempotencyKey
    ? `comment-create:${projectKey}:${String(taskSelector).trim()}:${idempotencyKey}`
    : '';

  if (cacheKey) {
    const cached = idempotency.get(cacheKey);
    if (cached) return cached;
  }

  const task = await resolveTask(client, taskSelector, projectSelector);

  const htmlComment = markdownToHtml(comment);
  const path = `/tasks/${task.id}/comments`;
  const rawComment = await client.request<any>('POST', path, {
    body: { comment: htmlComment },
  });

  const normalized: Comment = {
    id: rawComment.id,
    comment: htmlToMarkdown(rawComment.comment),
    author: {
      id: rawComment.author?.id,
      username: rawComment.author?.username || 'unknown',
    },
    created: rawComment.created,
  };

  if (cacheKey) {
    idempotency.set(cacheKey, normalized);
  }

  return normalized;
}

export async function listComments(
  client: VikunjaApiClient,
  taskSelector: string | number,
  projectSelector?: { id?: number; title?: string },
  page = 1,
  perPage = 20,
) {
  const task = await resolveTask(client, taskSelector, projectSelector);
  const safePage = Math.max(1, page);
  const safePerPage = Math.min(100, Math.max(1, perPage));
  const rawComments = await client.request<any>(
    'GET',
    `/tasks/${task.id}/comments?page=${safePage}&per_page=${safePerPage}`,
  );

  return {
    comments: toItemArray(rawComments).map((c) => ({
      id: c.id,
      comment: htmlToMarkdown(c.comment),
      author: {
        id: c.author?.id,
        username: c.author?.username || 'unknown',
      },
      created: c.created,
    })),
    pagination: normalizePagination(rawComments),
  };
}

export async function getComment(
  client: VikunjaApiClient,
  taskSelector: string | number,
  commentId: number,
  projectSelector?: { id?: number; title?: string },
): Promise<Comment> {
  const task = await resolveTask(client, taskSelector, projectSelector);
  const c = await client.request<any>('GET', `/tasks/${task.id}/comments/${commentId}`);

  return {
    id: c.id,
    comment: htmlToMarkdown(c.comment),
    author: {
      id: c.author?.id,
      username: c.author?.username || 'unknown',
    },
    created: c.created,
  };
}

export async function updateComment(
  client: VikunjaApiClient,
  taskSelector: string | number,
  commentId: number,
  comment: string,
  projectSelector?: { id?: number; title?: string },
): Promise<Comment> {
  const task = await resolveTask(client, taskSelector, projectSelector);
  const htmlComment = markdownToHtml(comment);

  // Prefer PATCH for partial comment updates (OpenAPI also offers PUT).
  const c = await client.request<any>('PATCH', `/tasks/${task.id}/comments/${commentId}`, {
    body: { comment: htmlComment },
    headers: { 'Content-Type': 'application/merge-patch+json' },
  });

  return {
    id: c.id,
    comment: htmlToMarkdown(c.comment),
    author: {
      id: c.author?.id,
      username: c.author?.username || 'unknown',
    },
    created: c.created,
  };
}

export async function deleteComment(
  client: VikunjaApiClient,
  taskSelector: string | number,
  commentId: number,
  projectSelector?: { id?: number; title?: string },
): Promise<{ ok: boolean; commentId: number }> {
  const task = await resolveTask(client, taskSelector, projectSelector);
  await client.request<any>('DELETE', `/tasks/${task.id}/comments/${commentId}`);

  return {
    ok: true,
    commentId,
  };
}
