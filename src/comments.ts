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
import { VikunjaError } from './errors.js';

export interface Comment {
  id: number;
  comment: string;
  author: {
    id: number;
    username: string;
  };
  created: string;
}

export interface CommentListOptions {
  since?: string;
  countOnly?: boolean;
  includeLatest?: boolean;
  maxScanPages?: number;
}

function normalizeComment(comment: any): Comment {
  return {
    id: comment.id,
    comment: htmlToMarkdown(comment.comment),
    author: {
      id: comment.author?.id,
      username: comment.author?.username || 'unknown',
    },
    created: comment.created,
  };
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
  options: CommentListOptions = {},
) {
  const task = await resolveTask(client, taskSelector, projectSelector);
  const safePage = Math.max(1, page);
  const safePerPage = Math.min(100, Math.max(1, perPage));
  const countOnly = options.countOnly === true;
  const since = options.since?.trim();
  let sinceTime: number | undefined;
  if (since) {
    sinceTime = Date.parse(since);
    if (!Number.isFinite(sinceTime)) {
      throw new VikunjaError({
        status: 400,
        code: 'VALIDATION_ERROR',
        method: 'TOOLS_CALL',
        path: 'since',
        message: 'since must be a valid ISO date-time.',
        fieldErrors: [],
      });
    }
  }

  if (sinceTime !== undefined) {
    const maxScanPages = Math.min(50, Math.max(1, options.maxScanPages ?? 20));
    const matches: Comment[] = [];
    let scanPage = 1;
    let complete = false;
    let latestCommentAt: string | null = null;
    for (; scanPage <= maxScanPages; scanPage += 1) {
      const rawPage = await client.request<any>(
        'GET',
        `/tasks/${task.id}/comments?sort_by=created&order_by=desc&page=${scanPage}&per_page=100`,
      );
      const items = toItemArray(rawPage).map(normalizeComment);
      if (scanPage === 1) latestCommentAt = items[0]?.created ?? null;
      if (items.length === 0) {
        complete = true;
        break;
      }
      for (const comment of items) {
        if (Date.parse(comment.created) < sinceTime) {
          complete = true;
          break;
        }
        matches.push(comment);
      }
      const pagination = normalizePagination(rawPage);
      if (complete || !pagination.hasMore) {
        complete = true;
        break;
      }
    }
    const start = (safePage - 1) * safePerPage;
    const comments = countOnly ? [] : matches.slice(start, start + safePerPage);
    const totalPages = matches.length === 0 ? 0 : Math.ceil(matches.length / safePerPage);
    const hasMore = safePage < totalPages;
    return {
      comments,
      pagination: {
        page: safePage,
        perPage: safePerPage,
        total: matches.length,
        totalPages,
        hasMore,
        nextPage: hasMore ? safePage + 1 : null,
      },
      returnedCount: comments.length,
      totalCount: matches.length,
      nextCursor: hasMore ? String(safePage + 1) : null,
      incomplete: !complete,
      latestCommentAt,
      since,
      countOnly,
    };
  }

  const requestPage = countOnly ? 1 : safePage;
  const requestPerPage = countOnly ? 1 : safePerPage;
  const rawComments = await client.request<any>(
    'GET',
    `/tasks/${task.id}/comments?page=${requestPage}&per_page=${requestPerPage}`,
  );
  const normalized = toItemArray(rawComments).map(normalizeComment);
  let latestCommentAt: string | null = null;
  if (options.includeLatest) {
    const latest = await client.request<any>(
      'GET',
      `/tasks/${task.id}/comments?sort_by=created&order_by=desc&page=1&per_page=1`,
    );
    latestCommentAt = toItemArray(latest)[0]?.created ?? null;
  }
  const upstreamPagination = normalizePagination(rawComments);
  const totalPages =
    upstreamPagination.total === 0 ? 0 : Math.ceil(upstreamPagination.total / safePerPage);
  const pagination = countOnly
    ? {
        page: safePage,
        perPage: safePerPage,
        total: upstreamPagination.total,
        totalPages,
        hasMore: safePage < totalPages,
        nextPage: safePage < totalPages ? safePage + 1 : null,
      }
    : upstreamPagination;

  return {
    comments: countOnly ? [] : normalized,
    pagination,
    returnedCount: countOnly ? 0 : normalized.length,
    totalCount: pagination.total,
    nextCursor: pagination.nextPage === null ? null : String(pagination.nextPage),
    incomplete: false,
    latestCommentAt,
    countOnly,
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
