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
import { resolveTaskInput as resolveTask, type TaskSelectorInput } from './identity.js';
import { htmlToMarkdown, markdownToHtml, normalizePagination, toItemArray } from './format.js';
import { runDurableOperation } from './idempotency.js';
import { withActorAttribution } from './mutation-policy.js';

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
  taskSelector: TaskSelectorInput,
  comment: string,
  projectSelector?: { id?: number; title?: string },
  idempotencyKey?: string,
  actor?: string,
): Promise<Comment> {
  const payload = { taskSelector, projectSelector, comment, actor };
  const execute = async (): Promise<Comment> => {
    const task = await resolveTask(client, taskSelector, projectSelector);
    const htmlComment = markdownToHtml(withActorAttribution(comment, actor)!);
    const path = `/tasks/${task.id}/comments`;
    const rawComment = await client.request<any>('POST', path, {
      body: { comment: htmlComment },
    });

    return {
      id: rawComment.id,
      comment: htmlToMarkdown(rawComment.comment),
      author: {
        id: rawComment.author?.id,
        username: rawComment.author?.username || 'unknown',
      },
      created: rawComment.created,
    };
  };

  return idempotencyKey
    ? runDurableOperation('comment-create', idempotencyKey, payload, execute)
    : execute();
}

export async function listComments(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
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
  taskSelector: TaskSelectorInput,
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
  taskSelector: TaskSelectorInput,
  commentId: number,
  comment: string,
  projectSelector?: { id?: number; title?: string },
  actor?: string,
): Promise<Comment> {
  const task = await resolveTask(client, taskSelector, projectSelector);
  const htmlComment = markdownToHtml(withActorAttribution(comment, actor)!);

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
  taskSelector: TaskSelectorInput,
  commentId: number,
  projectSelector?: { id?: number; title?: string },
  actor?: string,
): Promise<{ ok: boolean; commentId: number; actor?: string }> {
  const task = await resolveTask(client, taskSelector, projectSelector);
  await client.request<any>('DELETE', `/tasks/${task.id}/comments/${commentId}`);

  return {
    ok: true,
    commentId,
    actor,
  };
}
