/**
 * Task CRUD, write echoes, and safe compound task operations.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { VikunjaApiClient } from './api.js';
import type { ResponseMode } from './config.js';
import {
  resolveProject,
  resolveTaskInput as resolveTask,
  ProjectRef,
  cache,
  listAllLabels,
  type TaskSelectorInput,
} from './identity.js';
import { toErrorEnvelope, VikunjaError } from './errors.js';
import {
  normalizePagination,
  normalizeDatesAndNulls,
  normalizeZeroDate,
  htmlToMarkdown,
  markdownToHtml,
  toItemArray,
  fetchAllCollectionItems,
} from './format.js';
import {
  durableOperationKey,
  lookupDurableOperationReceipt,
  payloadFingerprint,
  runDurableOperation,
} from './idempotency.js';
import { createComment } from './comments.js';
import { attachFiles, AttachmentInfo } from './attachments.js';
import { withActorAttribution } from './mutation-policy.js';

const MAX_AGENT_PAGE_SIZE = 100;
const MAX_PROJECT_SCOPE = 25;
const DEFAULT_MINIMAL_RESPONSE_CHARS = 4_000;

export const TASK_READ_FIELDS = [
  'id',
  'portalRef',
  'title',
  'done',
  'priority',
  'creator',
  'project',
  'labels',
  'assignees',
  'dueDate',
  'updated',
] as const;
export type TaskReadField = (typeof TASK_READ_FIELDS)[number];

export interface TaskProjectionOptions {
  fields?: TaskReadField[];
  includeUrl?: boolean;
  titleMaxChars?: number;
  attachmentLimit?: number;
  maxResponseChars?: number;
}

export interface Task {
  id: number;
  index: number;
  identifier?: string;
  project: { id: number; title: string };
  title: string;
  description: string | null;
  done: boolean;
  priority: number;
  dueDate: string | null;
  creator: { id: number; username: string } | null;
  labels: { id: number; title: string }[];
  assignees: { id: number; username: string }[];
  taskUrl: string;
  projectUrl: string;
  updated?: string;
}

export type TaskListItem = Pick<
  Task,
  | 'id'
  | 'index'
  | 'identifier'
  | 'project'
  | 'title'
  | 'done'
  | 'priority'
  | 'creator'
  | 'labels'
  | 'taskUrl'
  | 'projectUrl'
>;

export interface CompactTaskListItem {
  id: number;
  portalRef: string;
  title: string;
  done: boolean;
  priority: number;
  creator: string | null;
}

export interface CompactTask extends CompactTaskListItem {
  index: number;
  identifier?: string;
  project: { id: number; title: string };
  taskUrl: string;
}

export interface WriteEcho {
  action: 'created' | 'exists' | 'updated' | 'unchanged' | 'deleted' | 'closed' | 'reopened';
  target: {
    id: number;
    index: number;
    identifier?: string;
    project: { id: number; title: string };
    title: string;
  };
  // Present only when the caller supplied attachments to create/create_if_absent.
  attachments?: AttachmentInfo[];
  attachmentErrors?: { file: string; error: string }[];
  attachmentUnknown?: { file: string; error: string; code: string }[];
}

export interface UpsertEcho extends WriteEcho {
  externalKey: string;
  actor?: string;
}

export interface TaskCreationRelationInput {
  otherTaskSelector: TaskSelectorInput;
  relationKind: string;
}

export interface TaskCreationCompositionOptions {
  firstComment?: string;
  relations?: TaskCreationRelationInput[];
  idempotencyKey?: string;
  actor?: string;
  projectSelector?: { id?: number; title?: string };
  dryRun?: boolean;
}

export async function composeTaskCreation(
  client: VikunjaApiClient,
  created: any,
  options: TaskCreationCompositionOptions,
) {
  if (!options.firstComment && !options.relations?.length) return created;
  if (options.dryRun === true) {
    return {
      ...created,
      planned: {
        firstComment: Boolean(options.firstComment),
        relations: options.relations?.length ?? 0,
      },
      composedCalls: [],
    };
  }
  if (!options.idempotencyKey) {
    throw new VikunjaError({
      status: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      method: 'TOOLS_CALL',
      path: 'idempotencyKey',
      message: 'idempotencyKey is required for a composite task creation.',
      fieldErrors: [],
    });
  }

  const composedCalls: string[] = [];
  let partial = false;
  let firstComment: any;
  if (options.firstComment) {
    composedCalls.push(`POST /tasks/${created.target.id}/comments`);
    const commentKey = `${options.idempotencyKey}:first-comment`;
    try {
      const comment = await createComment(
        client,
        { globalId: created.target.id },
        options.firstComment,
        options.projectSelector,
        commentKey,
        options.actor,
      );
      firstComment = { status: 'created', id: comment.id, created: comment.created };
    } catch (error) {
      partial = true;
      const contextual = error as any;
      contextual.operationId ??= durableOperationKey('comment-create', commentKey, {
        taskSelector: { globalId: created.target.id },
        projectSelector: options.projectSelector,
        comment: options.firstComment,
        actor: options.actor,
      });
      contextual.identity ??= { project: created.target.project, task: created.target };
      firstComment = {
        status: 'failed',
        error: toErrorEnvelope(contextual, client.getConfig().vikunjaToken).error,
      };
    }
  }

  const relations = [];
  for (const [index, relation] of (options.relations ?? []).entries()) {
    composedCalls.push(`POST /tasks/${created.target.id}/relations`);
    // Keep the original create-composition key and payload shape so receipts
    // written by earlier releases remain reusable after an upgrade.
    const relationKey = `${options.idempotencyKey}:${index}`;
    const payload = {
      taskId: created.target.id,
      otherTaskSelector: relation.otherTaskSelector,
      relationKind: relation.relationKind,
    };
    try {
      const receipt = await runDurableOperation('task-create-relation', relationKey, payload, () =>
        relateTask(
          client,
          { globalId: created.target.id },
          relation.otherTaskSelector,
          relation.relationKind,
          options.projectSelector,
        ),
      );
      relations.push({
        status: 'created',
        relationKind: relation.relationKind,
        otherTask: receipt.otherTask,
        action: receipt.action,
      });
    } catch (error) {
      partial = true;
      const contextual = error as any;
      contextual.operationId ??= durableOperationKey('task-create-relation', relationKey, payload);
      contextual.identity ??= {
        project: created.target.project,
        task: created.target,
        otherTask: relation.otherTaskSelector,
      };
      relations.push({
        status: 'failed',
        relationKind: relation.relationKind,
        otherTaskSelector: relation.otherTaskSelector,
        error: toErrorEnvelope(contextual, client.getConfig().vikunjaToken).error,
      });
    }
  }

  return {
    ...created,
    firstComment,
    relations,
    composedCalls,
    outcome: partial ? 'partial' : 'completed',
  };
}

export const EXTERNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./#]{0,119}$/;

// Upload local files to a just-created/found task and fold the honest
// per-file outcome (uploaded vs failed) into its write echo.
async function attachToEcho(
  client: VikunjaApiClient,
  echo: WriteEcho,
  attachments?: string[],
  idempotencyKey?: string,
  actor?: string,
): Promise<WriteEcho> {
  if (!attachments || attachments.length === 0) {
    return echo;
  }
  const result = await attachFiles(
    client,
    echo.target.id,
    attachments.map((filePath) => ({ filePath })),
    undefined,
    idempotencyKey,
    { actor },
  );
  echo.attachments = result.uploaded;
  if (result.failed.length > 0) {
    echo.attachmentErrors = result.failed;
  }
  if (result.unknown.length > 0) {
    echo.attachmentUnknown = result.unknown;
  }
  return echo;
}

export interface ListTasksOptions {
  project?: { id?: number; title?: string };
  projects?: { id?: number; title?: string }[];
  allProjects?: boolean;
  page?: number;
  perPage?: number;
  /** When set, filter by done state. When omitted, defaults to open only (done=false). */
  done?: boolean;
  /** When true, do not apply the default open-only filter (return open+closed). */
  allStates?: boolean;
  priority?: number;
  label?: string | number;
  /** Vikunja task filters require an assignee username, not a numeric user ID. */
  assignee?: string;
  titleContains?: string;
  descriptionContains?: string;
  changedSince?: string;
  actor?: string;
  q?: string;
  countOnly?: boolean;
  filter?: string;
  responseMode?: ResponseMode;
  fields?: TaskReadField[];
  includeUrl?: boolean;
  titleMaxChars?: number;
  maxResponseChars?: number;
  cursor?: string;
  /** Internal stable delta boundary decoded from cursor. */
  afterUpdated?: string;
  /** Internal stable delta tie-breaker decoded from cursor. */
  afterId?: number;
}

export function escapeFilterString(val: string): string {
  return `'${val.replace(/'/g, "''")}'`;
}

export function buildFilterString(options: ListTasksOptions): string {
  const parts: string[] = [];

  // Contract default: open tasks only. Pass done explicitly, or allStates:true for both.
  if (options.done !== undefined) {
    parts.push(`done = ${options.done}`);
  } else if (!options.allStates) {
    parts.push('done = false');
  }
  if (options.priority !== undefined) {
    parts.push(`priority = ${options.priority}`);
  }
  if (options.label !== undefined) {
    parts.push(
      typeof options.label === 'number'
        ? `labels = ${options.label}`
        : `labels = ${escapeFilterString(options.label)}`,
    );
  }
  if (options.assignee !== undefined) {
    parts.push(`assignees in ${escapeFilterString(options.assignee)}`);
  }
  if (options.titleContains !== undefined) {
    parts.push(`title like ${escapeFilterString(`%${options.titleContains}%`)}`);
  }
  if (options.descriptionContains !== undefined) {
    parts.push(`description like ${escapeFilterString(`%${options.descriptionContains}%`)}`);
  }
  if (options.actor !== undefined) {
    // No parentheses in the pattern: Vikunja's filter tokenizer rejects "(" and
    // ")" inside quoted strings (live-verified 2026-07-23), so match the
    // attribution text "by <actor>" without the surrounding parens.
    parts.push(`description like ${escapeFilterString(`%by ${options.actor}%`)}`);
  }
  if (options.changedSince !== undefined) {
    parts.push(`updated >= ${escapeFilterString(options.changedSince)}`);
  }
  if (options.afterUpdated !== undefined && options.afterId !== undefined) {
    parts.push(
      `(updated > ${escapeFilterString(options.afterUpdated)} || (updated = ${escapeFilterString(options.afterUpdated)} && id > ${options.afterId}))`,
    );
  }
  if (options.filter) {
    parts.push(`(${options.filter})`);
  }

  return parts.join(' && ');
}

/**
 * True when a title is safe to embed in a Vikunja filter equality expression.
 * Excludes grouping/quoting characters AND the DSL's own operators (= & | < >),
 * so any title that could alter or break the parse is routed to the q-search path.
 */
export function isFilterSafeTitle(title: string): boolean {
  return !/[()[\]{}'"`\\=&|<>]/.test(title);
}

export function normalizeTask(task: any, projectRef: ProjectRef, webUrl: string): Task {
  const normalized = normalizeDatesAndNulls(task);

  const labels = Array.isArray(normalized.labels)
    ? normalized.labels.map((l: any) => ({ id: l.id, title: l.title }))
    : [];

  const assignees = Array.isArray(normalized.assignees)
    ? normalized.assignees.map((a: any) => ({ id: a.id, username: a.username }))
    : [];

  return {
    id: normalized.id,
    index: normalized.index,
    identifier: normalized.identifier,
    project: { id: projectRef.id, title: projectRef.title },
    title: normalized.title,
    description: normalized.description ? htmlToMarkdown(normalized.description) : null,
    done: !!normalized.done,
    priority: normalized.priority || 0,
    dueDate: normalized.due_date || normalized.dueDate || null,
    creator: normalized.created_by
      ? { id: normalized.created_by.id, username: normalized.created_by.username }
      : null,
    labels,
    assignees,
    taskUrl: `${webUrl}tasks/${normalized.id}`,
    projectUrl: `${webUrl}projects/${projectRef.id}`,
    updated: normalized.updated || normalized.updatedAt || undefined,
  };
}

function normalizeTaskListItem(task: any, projectRef: ProjectRef, webUrl: string): TaskListItem {
  const full = normalizeTask(task, projectRef, webUrl);
  return {
    id: full.id,
    index: full.index,
    identifier: full.identifier,
    project: full.project,
    title: full.title,
    done: full.done,
    priority: full.priority,
    creator: full.creator,
    labels: full.labels,
    taskUrl: full.taskUrl,
    projectUrl: full.projectUrl,
  };
}

function normalizeCompactTask(task: any, projectRef: ProjectRef, webUrl: string): CompactTask {
  return {
    id: task.id,
    index: task.index,
    identifier: task.identifier,
    portalRef: task.identifier || `#${task.index}`,
    project: { id: projectRef.id, title: projectRef.title },
    title: task.title,
    done: !!task.done,
    priority: task.priority || 0,
    creator: task.created_by?.username ?? null,
    taskUrl: `${webUrl}tasks/${task.id}`,
  };
}

function normalizeCompactTaskListItem(task: any): CompactTaskListItem {
  return {
    id: task.id,
    portalRef: task.identifier || `#${task.index}`,
    title: task.title,
    done: !!task.done,
    priority: task.priority || 0,
    creator: task.created_by?.username ?? null,
  };
}

function selectedResponseMode(
  client: VikunjaApiClient,
  requested: ResponseMode | undefined,
): ResponseMode {
  return requested ?? client.getConfig().responseMode ?? 'minimal';
}

interface ListCursor {
  projectId: number;
  page?: number;
  offset?: number;
  perPage?: number;
  updated?: string;
  id?: number;
  scopeProjectIds?: number[];
  changedSince?: string;
  queryHash?: string;
}

function encodeListCursor(cursor: ListCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

function decodeListCursor(value: string | undefined): ListCursor | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as ListCursor;
    if (
      !Number.isInteger(parsed.projectId) ||
      parsed.projectId <= 0 ||
      !(
        (Number.isInteger(parsed.page) &&
          parsed.page! > 0 &&
          Number.isInteger(parsed.offset) &&
          parsed.offset! >= 0 &&
          Number.isInteger(parsed.perPage) &&
          parsed.perPage! > 0 &&
          parsed.perPage! <= MAX_AGENT_PAGE_SIZE) ||
        (typeof parsed.updated === 'string' &&
          Number.isFinite(Date.parse(parsed.updated)) &&
          Number.isInteger(parsed.id) &&
          parsed.id! > 0)
      ) ||
      (parsed.scopeProjectIds !== undefined &&
        (!Array.isArray(parsed.scopeProjectIds) ||
          parsed.scopeProjectIds.length === 0 ||
          parsed.scopeProjectIds.some((id) => !Number.isInteger(id) || id <= 0))) ||
      (parsed.changedSince !== undefined && !Number.isFinite(Date.parse(parsed.changedSince))) ||
      (parsed.queryHash !== undefined && !/^[a-f0-9]{64}$/.test(parsed.queryHash))
    ) {
      throw new Error('invalid cursor values');
    }
    return parsed;
  } catch {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_CURSOR',
      method: 'GET',
      path: '/tasks',
      message: 'The task-list cursor is invalid or expired. Restart from page 1.',
      fieldErrors: [],
    });
  }
}

function listQueryHash(options: ListTasksOptions, responseMode: ResponseMode): string {
  return payloadFingerprint({
    done: options.done,
    allStates: options.allStates,
    priority: options.priority,
    label: options.label,
    assignee: options.assignee,
    titleContains: options.titleContains,
    descriptionContains: options.descriptionContains,
    actor: options.actor,
    q: options.q,
    filter: options.filter,
    responseMode,
    fields: options.fields,
    includeUrl: options.includeUrl,
    titleMaxChars: options.titleMaxChars,
    maxResponseChars: options.maxResponseChars,
  });
}

function truncateTitle(title: string, maxChars: number | undefined): string {
  if (!maxChars || title.length <= maxChars) return title;
  return `${title.slice(0, Math.max(1, maxChars - 3)).trimEnd()}...`;
}

function projectTask(
  task: any,
  project: ProjectRef,
  webUrl: string,
  options: TaskProjectionOptions,
): Record<string, unknown> {
  const requested = new Set<TaskReadField>(
    options.fields ?? ['portalRef', 'title', 'done', 'priority'],
  );
  const result: Record<string, unknown> = {};
  const portalRef = task.identifier || `#${task.index}`;
  const values: Record<TaskReadField, unknown> = {
    id: task.id,
    portalRef,
    title: truncateTitle(String(task.title ?? ''), options.titleMaxChars),
    done: !!task.done,
    priority: task.priority || 0,
    creator: task.created_by?.username ?? null,
    project: { id: project.id, title: project.title },
    labels: Array.isArray(task.labels)
      ? task.labels.map((label: any) => ({ id: label.id, title: label.title }))
      : [],
    assignees: Array.isArray(task.assignees)
      ? task.assignees.map((assignee: any) => ({ id: assignee.id, username: assignee.username }))
      : [],
    dueDate: normalizeZeroDate(task.due_date ?? task.dueDate ?? null),
    updated: task.updated ?? task.updatedAt ?? null,
  };
  for (const field of requested) result[field] = values[field];
  if (options.includeUrl) result.taskUrl = `${webUrl}tasks/${task.id}`;
  return result;
}

interface MinimalProjectPage {
  project: ProjectRef;
  tasks: Record<string, unknown>[];
  rawTasks: any[];
  pagination: ReturnType<typeof normalizePagination>;
  startOffset: number;
  stableDelta: boolean;
}

function responseItemTooLarge(project: ProjectRef): VikunjaError {
  return new VikunjaError({
    status: 413,
    code: 'RESPONSE_ITEM_TOO_LARGE',
    method: 'GET',
    path: `/projects/${project.id}/tasks`,
    message:
      'One projected task cannot fit maxResponseChars. Request fewer fields or a smaller titleMaxChars value.',
    fieldErrors: [],
  });
}

function boundedMinimalPages(
  pages: MinimalProjectPage[],
  scopeProjectIds: number[],
  groupedScope: boolean,
  totalCount: number,
  maxResponseChars: number,
  cursorMetadata: Pick<ListCursor, 'changedSince' | 'queryHash'>,
): Record<string, unknown> {
  const envelopeOverhead = '```json\n{"ok":true,"data":}\n```'.length;
  if (pages.length === 0) {
    return {
      projects: [],
      returnedCount: 0,
      totalCount: 0,
      nextCursor: null,
      incomplete: false,
    };
  }
  const cursorScope = groupedScope ? scopeProjectIds : undefined;
  const groups: {
    project: { id: number; title: string };
    tasks: Record<string, unknown>[];
    returnedCount: number;
    totalCount: number;
  }[] = [];
  let returnedCount = 0;

  const makeCursor = (pageIndex: number, offset: number): string => {
    const page = pages[pageIndex];
    return encodeListCursor({
      projectId: page.project.id,
      page: page.pagination.page,
      offset,
      perPage: page.pagination.perPage,
      scopeProjectIds: cursorScope,
      ...cursorMetadata,
    });
  };

  const continuationAfter = (
    pageIndex: number,
    nextOffset: number,
    lastRaw: any,
  ): string | null => {
    const page = pages[pageIndex];
    if (
      page.stableDelta &&
      lastRaw &&
      (nextOffset < page.tasks.length || page.pagination.hasMore)
    ) {
      return encodeListCursor({
        projectId: page.project.id,
        updated: String(lastRaw.updated),
        id: Number(lastRaw.id),
        scopeProjectIds: cursorScope,
        ...cursorMetadata,
      });
    }
    if (nextOffset < page.tasks.length) return makeCursor(pageIndex, nextOffset);
    if (page.pagination.hasMore) {
      return encodeListCursor({
        projectId: page.project.id,
        page: page.pagination.page + 1,
        offset: 0,
        perPage: page.pagination.perPage,
        scopeProjectIds: cursorScope,
        ...cursorMetadata,
      });
    }
    const nextPage = pages[pageIndex + 1];
    return nextPage
      ? encodeListCursor({
          projectId: nextPage.project.id,
          page: nextPage.pagination.page,
          offset: nextPage.startOffset,
          perPage: nextPage.pagination.perPage,
          scopeProjectIds: cursorScope,
          ...cursorMetadata,
        })
      : null;
  };

  const build = (nextCursor: string | null): Record<string, unknown> => {
    if (!groupedScope) {
      const page = pages[0];
      const group = groups[0] ?? {
        project: { id: page.project.id, title: page.project.title },
        tasks: [],
        returnedCount: 0,
        totalCount,
      };
      return { ...group, nextCursor, incomplete: nextCursor !== null };
    }
    return {
      projects: groups,
      returnedCount,
      totalCount,
      nextCursor,
      incomplete: nextCursor !== null,
    };
  };

  for (const [pageIndex, page] of pages.entries()) {
    const remaining = page.tasks.slice(page.startOffset);
    if (remaining.length === 0 && page.pagination.total === 0) {
      const emptyGroup = {
        project: { id: page.project.id, title: page.project.title },
        tasks: [],
        returnedCount: 0,
        totalCount: 0,
      };
      const nextCursor = continuationAfter(pageIndex, page.startOffset, undefined);
      groups.push(emptyGroup);
      if (JSON.stringify(build(nextCursor)).length + envelopeOverhead > maxResponseChars) {
        groups.pop();
      }
      continue;
    }

    for (const [relativeIndex, task] of remaining.entries()) {
      const absoluteOffset = page.startOffset + relativeIndex;
      let group = groups.find((entry) => entry.project.id === page.project.id);
      const createdGroup = !group;
      if (!group) {
        group = {
          project: { id: page.project.id, title: page.project.title },
          tasks: [],
          returnedCount: 0,
          totalCount: page.pagination.total,
        };
        groups.push(group);
      }
      group.tasks.push(task);
      group.returnedCount += 1;
      returnedCount += 1;
      const nextCursor = continuationAfter(
        pageIndex,
        absoluteOffset + 1,
        page.rawTasks[absoluteOffset],
      );
      if (JSON.stringify(build(nextCursor)).length + envelopeOverhead > maxResponseChars) {
        group.tasks.pop();
        group.returnedCount -= 1;
        returnedCount -= 1;
        if (createdGroup) groups.pop();
        if (returnedCount === 0) throw responseItemTooLarge(page.project);
        return build(
          continuationAfter(pageIndex, absoluteOffset, page.rawTasks[absoluteOffset - 1]),
        );
      }
    }

    if (page.pagination.hasMore) {
      return build(
        continuationAfter(pageIndex, page.tasks.length, page.rawTasks.at(-1)) ??
          encodeListCursor({
            projectId: page.project.id,
            page: page.pagination.page + 1,
            offset: 0,
            perPage: page.pagination.perPage,
            scopeProjectIds: cursorScope,
            ...cursorMetadata,
          }),
      );
    }
  }
  return build(null);
}

async function listProjectTasksInternal(
  client: VikunjaApiClient,
  project: ProjectRef,
  options: ListTasksOptions,
): Promise<any> {
  const queryParams = new URLSearchParams();
  queryParams.set('page', String(options.page || 1));
  // For a count-only request we only need the total from the pagination
  // metadata, so fetch the smallest possible page instead of 20 task bodies.
  queryParams.set(
    'per_page',
    String(options.countOnly ? 1 : Math.min(options.perPage || 20, MAX_AGENT_PAGE_SIZE)),
  );

  if (options.q) {
    queryParams.set('q', options.q);
  }

  const filterStr = buildFilterString(options);
  if (filterStr) {
    queryParams.set('filter', filterStr);
  }

  if (options.changedSince || options.afterUpdated) {
    queryParams.append('sort_by', 'updated');
    queryParams.append('sort_by', 'id');
    queryParams.append('order_by', 'asc');
    queryParams.append('order_by', 'asc');
  }

  // NOTE: do not add `expand`. Labels and assignees are always embedded in each
  // task; the v2 `expand` param only accepts subtasks/buckets/reactions/etc., so
  // `expand=labels,assignees` is rejected with HTTP 422.

  const queryString = queryParams.toString();
  const path = `/projects/${project.id}/tasks?${queryString}`;

  return client.request<any>('GET', path);
}

export async function listTasks(client: VikunjaApiClient, options: ListTasksOptions): Promise<any> {
  const webUrl = client.getConfig().vikunjaWebUrl;
  const responseMode = selectedResponseMode(client, options.responseMode);
  const cursor = decodeListCursor(options.cursor);
  if (
    cursor?.changedSince &&
    options.changedSince &&
    cursor.changedSince !== options.changedSince
  ) {
    throw new VikunjaError({
      status: 400,
      code: 'CURSOR_QUERY_MISMATCH',
      method: 'GET',
      path: '/tasks',
      message: 'The continuation cursor must be resumed with the same changedSince boundary.',
      fieldErrors: [],
    });
  }
  const effectiveChangedSince = options.changedSince ?? cursor?.changedSince;
  const effectiveBase =
    options.label !== undefined
      ? { ...options, label: await resolveLabel(client, options.label) }
      : options;
  const effectiveOptions = { ...effectiveBase, changedSince: effectiveChangedSince };
  const queryHash = listQueryHash(effectiveOptions, responseMode);
  let projectsToQuery: ProjectRef[] = [];

  const scopeCount =
    (options.project ? 1 : 0) + (options.projects ? 1 : 0) + (options.allProjects ? 1 : 0);
  if (scopeCount > 1) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_SCOPE',
      method: 'GET',
      path: '/tasks',
      message: 'Specify exactly one of "project", "projects", or "allProjects".',
      fieldErrors: [],
    });
  }

  if (options.project) {
    const proj = await resolveProject(client, options.project);
    projectsToQuery = [proj];
  } else if (options.projects) {
    if (options.projects.length === 0) {
      throw new VikunjaError({
        status: 400,
        code: 'SCOPE_REQUIRED',
        method: 'GET',
        path: '/tasks',
        message: 'The explicit "projects" scope must contain at least one project.',
        fieldErrors: [],
      });
    }
    if (options.projects.length > MAX_PROJECT_SCOPE) {
      throw new VikunjaError({
        status: 400,
        code: 'PROJECT_SCOPE_TOO_LARGE',
        method: 'GET',
        path: '/tasks',
        message: `Explicit project subsets accept at most ${MAX_PROJECT_SCOPE} projects.`,
        fieldErrors: [],
      });
    }
    const resolved = await Promise.all(options.projects.map((p) => resolveProject(client, p)));
    projectsToQuery = [...new Map(resolved.map((project) => [project.id, project])).values()];
  } else if (options.allProjects) {
    const allProjs = await fetchAllCollectionItems(
      async (path) => client.request<any>('GET', path),
      '/projects',
    );
    projectsToQuery = allProjs.map((p: any) => ({ id: p.id, title: p.title }));
  } else {
    throw new VikunjaError({
      status: 400,
      code: 'SCOPE_REQUIRED',
      method: 'GET',
      path: '/tasks',
      message: 'List operation requires a scope: "project", "projects", or "allProjects".',
      fieldErrors: [],
    });
  }

  const scopeProjectIds = projectsToQuery.map((project) => project.id);
  const groupedScope = Boolean(options.projects || options.allProjects);
  const cursorProjectIndex = cursor
    ? projectsToQuery.findIndex((project) => project.id === cursor.projectId)
    : 0;
  if (cursor && cursorProjectIndex < 0) {
    throw new VikunjaError({
      status: 400,
      code: 'CURSOR_SCOPE_MISMATCH',
      method: 'GET',
      path: '/tasks',
      message: 'The continuation cursor belongs to a different project scope.',
      fieldErrors: [],
    });
  }
  if (cursor && (cursor.scopeProjectIds !== undefined || groupedScope)) {
    const sameScope =
      groupedScope &&
      cursor.scopeProjectIds?.length === scopeProjectIds.length &&
      cursor.scopeProjectIds.every((id, index) => id === scopeProjectIds[index]);
    if (!sameScope) {
      throw new VikunjaError({
        status: 400,
        code: 'CURSOR_SCOPE_MISMATCH',
        method: 'GET',
        path: '/tasks',
        message: 'The continuation cursor must be resumed with the same ordered project scope.',
        fieldErrors: [],
      });
    }
  }
  if (cursor?.queryHash && cursor.queryHash !== queryHash) {
    throw new VikunjaError({
      status: 400,
      code: 'CURSOR_QUERY_MISMATCH',
      method: 'GET',
      path: '/tasks',
      message: 'The continuation cursor belongs to a different task-list query.',
      fieldErrors: [],
    });
  }
  if (
    cursor?.page !== undefined &&
    options.perPage !== undefined &&
    Math.min(options.perPage, MAX_AGENT_PAGE_SIZE) !== cursor.perPage
  ) {
    throw new VikunjaError({
      status: 400,
      code: 'CURSOR_PAGE_SIZE_MISMATCH',
      method: 'GET',
      path: '/tasks',
      message: `Resume this cursor with perPage ${cursor.perPage}.`,
      fieldErrors: [],
    });
  }

  const results = [];
  const minimalPages: MinimalProjectPage[] = [];
  let minimalTotalCount = 0;
  for (const [projectIndex, proj] of projectsToQuery.entries()) {
    const beforeCursor = Boolean(cursor && projectIndex < cursorProjectIndex);
    const atCursor = Boolean(cursor && projectIndex === cursorProjectIndex);
    const projectOptions = beforeCursor
      ? { ...effectiveOptions, page: 1, countOnly: true }
      : atCursor
        ? cursor!.updated
          ? {
              ...effectiveOptions,
              page: 1,
              afterUpdated: cursor!.updated,
              afterId: cursor!.id,
            }
          : { ...effectiveOptions, page: cursor!.page, perPage: cursor!.perPage }
        : effectiveOptions;
    const rawRes = await listProjectTasksInternal(client, proj, projectOptions);
    const pagination = normalizePagination(rawRes);
    minimalTotalCount += pagination.total;

    if (options.countOnly) {
      results.push({
        project: { id: proj.id, title: proj.title },
        count: pagination.total,
      });
    } else {
      const rawTasks = toItemArray(rawRes);
      if (responseMode === 'minimal' || responseMode === 'receipt') {
        if (beforeCursor) continue;
        const projected = rawTasks.map((task: any) =>
          projectTask(task, proj, webUrl, {
            fields: options.fields,
            includeUrl: options.includeUrl,
            titleMaxChars: options.titleMaxChars,
          }),
        );
        minimalPages.push({
          project: proj,
          tasks: projected,
          rawTasks,
          pagination,
          startOffset: atCursor && !cursor?.updated ? (cursor?.offset ?? 0) : 0,
          stableDelta: Boolean(effectiveChangedSince || (atCursor && cursor?.updated)),
        });
        continue;
      }
      const tasks = rawTasks.map((task: any) => {
        if (responseMode === 'compact') {
          return normalizeCompactTaskListItem(task);
        }
        if (responseMode === 'full') {
          return normalizeTask(task, proj, webUrl);
        }
        return normalizeTaskListItem(task, proj, webUrl);
      });
      results.push({
        project: { id: proj.id, title: proj.title },
        tasks,
        pagination,
        truncated: pagination.hasMore,
      });
    }
  }

  if (!options.countOnly && (responseMode === 'minimal' || responseMode === 'receipt')) {
    return boundedMinimalPages(
      minimalPages,
      scopeProjectIds,
      groupedScope,
      minimalTotalCount,
      options.maxResponseChars ?? DEFAULT_MINIMAL_RESPONSE_CHARS,
      { changedSince: effectiveChangedSince, queryHash },
    );
  }

  const response = options.project ? results[0] : { projects: results };
  if (
    options.maxResponseChars !== undefined &&
    JSON.stringify(response).length + '```json\n{"ok":true,"data":}\n```'.length >
      options.maxResponseChars
  ) {
    throw new VikunjaError({
      status: 413,
      code: 'RESPONSE_TOO_LARGE',
      method: 'GET',
      path: '/tasks',
      message:
        'The requested responseMode exceeds maxResponseChars. Use minimal mode, fewer fields, or a smaller page.',
      fieldErrors: [],
    });
  }
  return response;
}

export type MyTasksState = 'open' | 'closed' | 'all';

export interface MyTasksOptions extends Omit<ListTasksOptions, 'assignee' | 'done' | 'allStates'> {
  state?: MyTasksState;
  ownership?: 'assigned';
  search?: string;
}

/**
 * List tasks assigned to the authenticated Vikunja user.
 *
 * The current username comes from GET /user so the server can apply its exact
 * assignee filter. Listing, scoping, projection, cursors, and budgets remain
 * owned by listTasks.
 */
export async function listMyTasks(client: VikunjaApiClient, options: MyTasksOptions): Promise<any> {
  const { state = 'open', ownership = 'assigned', search, ...listOptions } = options;
  if (ownership !== 'assigned') {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_OWNERSHIP',
      method: 'TOOLS_CALL',
      path: 'ownership',
      message: 'my_tasks only supports ownership="assigned".',
      fieldErrors: [],
    });
  }

  if (state !== 'open' && state !== 'closed' && state !== 'all') {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_STATE',
      method: 'TOOLS_CALL',
      path: 'state',
      message: 'my_tasks state must be open, closed, or all.',
      fieldErrors: [],
    });
  }

  const scopeCount =
    (options.project ? 1 : 0) + (options.projects ? 1 : 0) + (options.allProjects ? 1 : 0);
  if (scopeCount > 1) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_SCOPE',
      method: 'GET',
      path: '/tasks',
      message: 'Specify exactly one of "project", "projects", or "allProjects".',
      fieldErrors: [],
    });
  }
  if (scopeCount === 0) {
    throw new VikunjaError({
      status: 400,
      code: 'SCOPE_REQUIRED',
      method: 'GET',
      path: '/tasks',
      message: 'List operation requires a scope: "project", "projects", or "allProjects".',
      fieldErrors: [],
    });
  }

  const user = await client.request<any>('GET', '/user');
  const rawUsername = typeof user?.username === 'string' ? user.username : '';
  const username = rawUsername.trim();
  const userId = user?.id;
  if (!username || !Number.isInteger(userId) || userId <= 0) {
    throw new VikunjaError({
      status: 502,
      code: 'INVALID_CURRENT_USER',
      method: 'GET',
      path: '/user',
      message:
        'Vikunja returned no usable positive user id and username for the authenticated user.',
      fieldErrors: [],
    });
  }

  const responseMode = selectedResponseMode(client, options.responseMode);
  const responseBudget =
    options.maxResponseChars ??
    (responseMode === 'minimal' || responseMode === 'receipt'
      ? DEFAULT_MINIMAL_RESPONSE_CHARS
      : undefined);
  const userFieldOverhead =
    JSON.stringify({ user: { id: userId, username: rawUsername } }).length - 1;
  const envelopeOverhead = '```json\n{"ok":true,"data":}\n```'.length;
  const listMaxResponseChars =
    responseBudget === undefined ? undefined : responseBudget - userFieldOverhead;
  if (listMaxResponseChars !== undefined && listMaxResponseChars <= envelopeOverhead) {
    throw new VikunjaError({
      status: 413,
      code: 'RESPONSE_TOO_LARGE',
      method: 'GET',
      path: '/tasks',
      message:
        'The requested my_tasks response cannot fit maxResponseChars with the user identity. Use a larger budget.',
      fieldErrors: [],
    });
  }

  const listed = await listTasks(client, {
    ...listOptions,
    q: listOptions.q ?? search,
    assignee: rawUsername,
    done: state === 'open' ? false : state === 'closed' ? true : undefined,
    allStates: state === 'all',
    maxResponseChars: listMaxResponseChars,
  });
  const response = {
    ...listed,
    user: {
      id: userId,
      username: rawUsername,
    },
  };

  if (
    responseBudget !== undefined &&
    JSON.stringify(response).length + '```json\n{"ok":true,"data":}\n```'.length > responseBudget
  ) {
    throw new VikunjaError({
      status: 413,
      code: 'RESPONSE_TOO_LARGE',
      method: 'GET',
      path: '/tasks',
      message:
        'The requested my_tasks response exceeds maxResponseChars. Use minimal mode, fewer fields, or a smaller page.',
      fieldErrors: [],
    });
  }
  return response;
}

interface LabelAggregate {
  label: string;
  total: number;
  open: number;
  done: number;
}

function incrementLabelAggregate(
  aggregates: Map<string, LabelAggregate>,
  label: string,
  done: boolean,
): void {
  const key = label.toLowerCase();
  const current = aggregates.get(key) ?? { label, total: 0, open: 0, done: 0 };
  current.total += 1;
  current[done ? 'done' : 'open'] += 1;
  aggregates.set(key, current);
}

export async function projectSummary(
  client: VikunjaApiClient,
  projectSelector: { id?: number; title?: string },
) {
  const project = await resolveProject(client, projectSelector);
  const tasks = await fetchAllCollectionItems<any>(
    (requestPath) => client.request('GET', requestPath),
    `/projects/${project.id}/tasks`,
  );
  const byPriority: Record<string, number> = {};
  const labels = new Map<string, LabelAggregate>();
  let done = 0;

  for (const task of tasks) {
    const isDone = Boolean(task.done);
    if (isDone) done += 1;
    const priority = String(Number.isInteger(task.priority) ? task.priority : 0);
    byPriority[priority] = (byPriority[priority] ?? 0) + 1;
    for (const label of Array.isArray(task.labels) ? task.labels : []) {
      if (label?.title) incrementLabelAggregate(labels, String(label.title), isDone);
    }
  }

  const byLabel = [...labels.values()].sort((left, right) =>
    left.label.localeCompare(right.label, undefined, { sensitivity: 'base' }),
  );
  const statusPrefix = client.getConfig().statusLabelPrefix ?? 'status:';

  return {
    project,
    total: tasks.length,
    open: tasks.length - done,
    done,
    byPriority,
    statusPrefix,
    byStatusLabel: byLabel.filter((item) =>
      item.label.toLowerCase().startsWith(statusPrefix.toLowerCase()),
    ),
    byLabel,
  };
}

export interface ProgrammeSnapshotOptions {
  staleDays?: number;
  changedSince?: string;
  changedLimit?: number;
  cursor?: string;
  preset?: 'programme' | 'mpf';
  now?: Date;
}

export async function programmeSnapshot(
  client: VikunjaApiClient,
  projectSelector: { id?: number; title?: string },
  options: ProgrammeSnapshotOptions = {},
) {
  const project = await resolveProject(client, projectSelector);
  const tasks = await fetchAllCollectionItems<any>(
    (requestPath) => client.request('GET', requestPath),
    `/projects/${project.id}/tasks`,
  );
  const statusPrefix = client.getConfig().statusLabelPrefix ?? 'status:';
  const byPriority: Record<string, number> = {};
  const byAssignee: Record<string, number> = {};
  const byStatusLabel: Record<string, number> = {};
  const byPhaseLabel: Record<string, number> = {};
  const staleBefore =
    (options.now ?? new Date()).getTime() - Math.max(1, options.staleDays ?? 14) * 86_400_000;
  let done = 0;
  let blocked = 0;
  let stale = 0;
  let unassignedOpen = 0;
  let missingStatus = 0;
  let multipleStatus = 0;

  for (const task of tasks) {
    const isDone = Boolean(task.done);
    if (isDone) done += 1;
    const priority = String(Number.isInteger(task.priority) ? task.priority : 0);
    byPriority[priority] = (byPriority[priority] ?? 0) + 1;
    for (const assignee of Array.isArray(task.assignees) ? task.assignees : []) {
      if (assignee?.username) {
        byAssignee[assignee.username] = (byAssignee[assignee.username] ?? 0) + 1;
      }
    }
    const assignees = Array.isArray(task.assignees) ? task.assignees : [];
    if (!isDone && assignees.length === 0) unassignedOpen += 1;
    const labels = Array.isArray(task.labels) ? task.labels : [];
    const statusLabels = labels.filter((label: any) =>
      String(label?.title ?? '')
        .toLowerCase()
        .startsWith(statusPrefix.toLowerCase()),
    );
    if (!isDone && statusLabels.length === 0) missingStatus += 1;
    if (!isDone && statusLabels.length > 1) multipleStatus += 1;
    for (const label of labels) {
      const title = String(label?.title ?? '');
      if (title.toLowerCase().startsWith(statusPrefix.toLowerCase())) {
        byStatusLabel[title] = (byStatusLabel[title] ?? 0) + 1;
      }
      if (title.toLowerCase().startsWith('phase:')) {
        byPhaseLabel[title] = (byPhaseLabel[title] ?? 0) + 1;
      }
    }
    const relations =
      task.related_tasks && typeof task.related_tasks === 'object'
        ? Object.entries(task.related_tasks)
        : [];
    if (
      relations.some(
        ([kind, values]) =>
          kind.toLowerCase().includes('blocked') && Array.isArray(values) && values.length > 0,
      )
    ) {
      blocked += 1;
    }
    const updatedMs = Date.parse(String(task.updated ?? ''));
    if (!isDone && Number.isFinite(updatedMs) && updatedMs < staleBefore) stale += 1;
  }

  const cursor = decodeListCursor(options.cursor);
  if (cursor && cursor.projectId !== project.id) {
    throw new VikunjaError({
      status: 400,
      code: 'CURSOR_SCOPE_MISMATCH',
      method: 'GET',
      path: `/projects/${project.id}/tasks`,
      message: 'The programme snapshot cursor belongs to a different project.',
      fieldErrors: [],
    });
  }
  if (
    cursor?.changedSince &&
    options.changedSince &&
    cursor.changedSince !== options.changedSince
  ) {
    throw new VikunjaError({
      status: 400,
      code: 'CURSOR_QUERY_MISMATCH',
      method: 'GET',
      path: `/projects/${project.id}/tasks`,
      message: 'The programme snapshot cursor must use the same changedSince boundary.',
      fieldErrors: [],
    });
  }
  const effectiveChangedSince = options.changedSince ?? cursor?.changedSince;
  const changedSinceMs = effectiveChangedSince ? Date.parse(effectiveChangedSince) : undefined;
  const allChanged = effectiveChangedSince
    ? tasks
        .filter((task) => {
          const updatedMs = Date.parse(String(task.updated ?? ''));
          return (
            Number.isFinite(updatedMs) &&
            Number.isFinite(changedSinceMs) &&
            updatedMs >= changedSinceMs!
          );
        })
        .sort(
          (left, right) =>
            Date.parse(String(left.updated ?? '')) - Date.parse(String(right.updated ?? '')) ||
            left.id - right.id,
        )
    : [];
  const remainingChanged = cursor?.updated
    ? allChanged.filter((task) => {
        const updated = String(task.updated ?? '');
        const updatedMs = Date.parse(updated);
        const cursorMs = Date.parse(cursor.updated!);
        return updatedMs > cursorMs || (updatedMs === cursorMs && task.id > cursor.id!);
      })
    : allChanged;
  const changedLimit = Math.min(Math.max(options.changedLimit ?? 20, 1), 100);
  const changedPage = remainingChanged.slice(0, changedLimit);
  const lastChanged = changedPage.at(-1);
  const nextCursor =
    lastChanged && remainingChanged.length > changedPage.length
      ? encodeListCursor({
          projectId: project.id,
          updated: String(lastChanged.updated),
          id: Number(lastChanged.id),
          changedSince: effectiveChangedSince,
        })
      : null;
  const changedTasks = changedPage.map((task) => ({
    identifier: task.identifier || `#${task.index}`,
    title: task.title,
    done: Boolean(task.done),
  }));

  return {
    project,
    total: tasks.length,
    open: tasks.length - done,
    done,
    blocked,
    stale,
    byPriority,
    byStatusLabel,
    byAssignee,
    changedSince: effectiveChangedSince ?? null,
    changedCount: allChanged.length,
    changedTasks,
    returnedCount: changedTasks.length,
    totalCount: allChanged.length,
    nextCursor,
    incomplete: nextCursor !== null,
    ...(options.preset === 'mpf'
      ? {
          reconciliation: {
            unassignedOpen,
            missingStatus,
            multipleStatus,
            byPhaseLabel,
          },
        }
      : {}),
  };
}

export async function batchGetTasks(
  client: VikunjaApiClient,
  identifiers: string[],
  options: TaskProjectionOptions = {},
) {
  const tasks: Record<string, unknown>[] = [];
  const failed: { identifier: string; error: string }[] = [];
  for (const identifier of identifiers) {
    try {
      const result = await getTask(client, { identifier }, undefined, 0, 'minimal', options);
      tasks.push(result.task);
    } catch (error: any) {
      failed.push({ identifier, error: String(error?.message ?? error) });
    }
  }
  return {
    requested: identifiers.length,
    returnedCount: tasks.length,
    tasks,
    failed,
    incomplete: failed.length > 0,
  };
}

export async function verifyTaskState(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
) {
  const resolutionProject =
    typeof taskSelector === 'object' && 'projectIndex' in taskSelector
      ? projectSelector
      : undefined;
  const taskRef = await resolveTask(client, taskSelector, resolutionProject, {
    includeRawTask: true,
  });
  if (projectSelector?.id !== undefined && projectSelector.id !== taskRef.project.id) {
    throw new VikunjaError({
      status: 400,
      code: 'PROJECT_MISMATCH',
      method: 'GET',
      path: `/tasks/${taskRef.id}`,
      message: `Task ${taskRef.identifier || `#${taskRef.index}`} belongs to project ID ${taskRef.project.id}, not project ID ${projectSelector.id}.`,
      fieldErrors: [],
    });
  }
  if (
    projectSelector?.title !== undefined &&
    projectSelector.title.toLowerCase() !== taskRef.project.title.toLowerCase()
  ) {
    throw new VikunjaError({
      status: 400,
      code: 'PROJECT_MISMATCH',
      method: 'GET',
      path: `/tasks/${taskRef.id}`,
      message: `Task ${taskRef.identifier || `#${taskRef.index}`} belongs to project "${taskRef.project.title}", not "${projectSelector.title}".`,
      fieldErrors: [],
    });
  }
  const rawTask = taskRef.rawTask ?? {};
  const commentsRaw = await client.request<any>(
    'GET',
    `/tasks/${taskRef.id}/comments?sort_by=created&order_by=desc&page=1&per_page=5`,
  );
  const attachmentRaw = await client.request<any>(
    'GET',
    `/tasks/${taskRef.id}/attachments?page=1&per_page=100`,
  );
  const comments = toItemArray<any>(commentsRaw);
  const attachments = toItemArray<any>(attachmentRaw).map((attachment) => ({
    id: attachment.id,
    fileName: attachment.file?.name ?? attachment.file_name ?? 'unknown',
  }));
  const relations = Object.entries(rawTask.related_tasks ?? {}).flatMap(([kind, values]) =>
    Array.isArray(values)
      ? values.map((task: any) => ({
          kind,
          identifier: task.identifier || `#${task.index}`,
          title: task.title,
        }))
      : [],
  );
  const latest = comments
    .map((comment) => ({
      ...comment,
      markdown: htmlToMarkdown(String(comment.comment ?? '')),
    }))
    .sort((left, right) =>
      String(right.created ?? '').localeCompare(String(left.created ?? '')),
    )[0];
  const verdictMatch = latest?.markdown.match(/\b(PASS|FAIL)\b/i);

  return {
    identifier: taskRef.identifier || `#${taskRef.index}`,
    project: taskRef.project,
    title: taskRef.title,
    done: Boolean(rawTask.done),
    labels: taskRef.labels.map((label) => label.title),
    assignees: taskRef.assignees.map((assignee) => assignee.username),
    attachmentCount: Number(attachmentRaw.total ?? attachments.length),
    attachments,
    attachmentsIncomplete: Number(attachmentRaw.total ?? attachments.length) > attachments.length,
    relationCount: relations.length,
    relations,
    commentCount: Number(commentsRaw.total ?? comments.length),
    latestCommentAt: latest?.created ?? null,
    latestVerification: verdictMatch
      ? {
          id: latest.id,
          verdict: verdictMatch[1].toUpperCase(),
          actor: latest.author?.username ?? null,
        }
      : null,
  };
}

export async function createTask(
  client: VikunjaApiClient,
  projectSelector: { id?: number; title?: string },
  fields: {
    title: string;
    description?: string;
    done?: boolean;
    priority?: number;
    dueDate?: string | null;
  },
  idempotencyKey?: string,
  attachments?: string[],
  actor?: string,
  dryRun = false,
): Promise<any> {
  if (idempotencyKey && !dryRun) {
    const echo = await runDurableOperation(
      'task-create',
      idempotencyKey,
      {
        projectSelector,
        fields,
        actor,
      },
      () => createTask(client, projectSelector, fields, undefined, undefined, actor, false),
    );
    return attachToEcho(client, echo, attachments, idempotencyKey, actor);
  }

  const project = await resolveProject(client, projectSelector);
  const webUrl = client.getConfig().vikunjaWebUrl;
  if (dryRun) {
    return {
      action: 'would_create',
      operation: 'create',
      target: { project: { id: project.id, title: project.title }, title: fields.title },
      changed: ['task'],
      before: { exists: false },
      after: { exists: true, title: fields.title },
      dryRun: true,
    };
  }

  const body: Record<string, any> = {
    title: fields.title,
  };
  const attributedDescription = withActorAttribution(fields.description, actor);
  if (attributedDescription !== undefined) {
    body.description = markdownToHtml(attributedDescription);
  }
  if (fields.done !== undefined) {
    body.done = fields.done;
  }
  if (fields.priority !== undefined) {
    body.priority = fields.priority;
  }
  if (fields.dueDate !== undefined) {
    body.due_date = fields.dueDate;
  }

  const path = `/projects/${project.id}/tasks`;
  const rawTask = await client.request<any>('POST', path, { body });
  const task = normalizeTask(rawTask, project, webUrl);

  const echo: WriteEcho = {
    action: 'created',
    target: {
      id: task.id,
      index: task.index,
      identifier: task.identifier,
      project: { id: project.id, title: project.title },
      title: task.title,
    },
  };
  (echo as any).updatedAt = task.updated || new Date().toISOString();
  (echo as any).before = { exists: false };
  (echo as any).after = {
    exists: true,
    title: task.title,
    done: task.done,
    priority: task.priority,
    dueDate: task.dueDate,
  };

  // Upload any attachments to the new task, then cache the full echo so a
  // retry with the same idempotencyKey never creates a second task.
  await attachToEcho(client, echo, attachments, idempotencyKey, actor);

  return echo;
}

export async function createIfAbsent(
  client: VikunjaApiClient,
  projectSelector: { id?: number; title?: string },
  fields: {
    title: string;
    description?: string;
    done?: boolean;
    priority?: number;
    dueDate?: string | null;
  },
  idempotencyKey?: string,
  attachments?: string[],
  actor?: string,
  dryRun = false,
): Promise<any> {
  if (idempotencyKey && !dryRun) {
    const echo = await runDurableOperation(
      'task-create-absent',
      idempotencyKey,
      {
        projectSelector,
        fields,
        actor,
      },
      () => createIfAbsent(client, projectSelector, fields, undefined, undefined, actor, false),
    );
    return echo.action === 'created'
      ? attachToEcho(client, echo, attachments, idempotencyKey, actor)
      : echo;
  }

  const project = await resolveProject(client, projectSelector);
  const webUrl = client.getConfig().vikunjaWebUrl;
  const title = fields.title.trim();

  // Prefer server-side title equality when the title is filter-safe. Fall back
  // to q + exact match (paginated) when the filter DSL would reject the title.
  let exactMatch: any | undefined;

  if (isFilterSafeTitle(title)) {
    const filter = `title = ${escapeFilterString(title)}`;
    const path = `/projects/${project.id}/tasks?filter=${encodeURIComponent(filter)}&per_page=5`;
    const searchRes = await client.request<any>('GET', path);
    const items = toItemArray(searchRes);
    exactMatch = items.find((t: any) => t.title.trim().toLowerCase() === title.toLowerCase());
  } else {
    // Paginate q results and require an exact title match. Fail closed if the
    // collection is larger than we can scan rather than creating a duplicate.
    const perPage = 100;
    let page = 1;
    let scanned = 0;
    let total = Infinity;
    while (page <= 50 && scanned < total) {
      const path = `/projects/${project.id}/tasks?q=${encodeURIComponent(title)}&page=${page}&per_page=${perPage}`;
      const searchRes = await client.request<any>('GET', path);
      const items = toItemArray(searchRes);
      const pagination = normalizePagination(searchRes);
      total = pagination.total || items.length;
      scanned += items.length;
      exactMatch = items.find((t: any) => t.title.trim().toLowerCase() === title.toLowerCase());
      if (exactMatch) break;
      if (!pagination.hasMore || items.length === 0) break;
      page += 1;
    }
    if (!exactMatch && scanned < total) {
      throw new VikunjaError({
        status: 409,
        code: 'EXACT_TITLE_SEARCH_INCOMPLETE',
        method: 'GET',
        path: `/projects/${project.id}/tasks`,
        message: `Could not prove absence of title "${fields.title}" after scanning ${scanned} of ${total} candidates. Narrow the title or retry.`,
        fieldErrors: [],
      });
    }
  }

  let echo: WriteEcho;

  if (exactMatch) {
    const task = normalizeTask(exactMatch, project, webUrl);
    echo = {
      action: 'exists',
      target: {
        id: task.id,
        index: task.index,
        identifier: task.identifier,
        project: { id: project.id, title: project.title },
        title: task.title,
      },
    };
    // Do not re-upload attachments when the task already exists.
  } else {
    // Create with attachments only on the create path (not on exists).
    echo = await createTask(
      client,
      { id: project.id },
      fields,
      undefined,
      attachments,
      actor,
      dryRun,
    );
  }

  return echo;
}

function stableKeyMarker(externalKey: string): string {
  if (!EXTERNAL_KEY_PATTERN.test(externalKey)) {
    throw new VikunjaError({
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'TOOLS_CALL',
      path: 'externalKey',
      message:
        'externalKey must be 1-120 characters and use only letters, numbers, colon, underscore, hyphen, period, slash, or #.',
      fieldErrors: [],
    });
  }
  return `[vfm-key:${externalKey}]`;
}

export async function lookupTaskByExternalKey(
  client: VikunjaApiClient,
  projectSelector: { id?: number; title?: string },
  externalKey: string,
) {
  const marker = stableKeyMarker(externalKey);
  const project = await resolveProject(client, projectSelector);
  const filter = `description like ${escapeFilterString(`%${marker}%`)}`;
  const path = `/projects/${project.id}/tasks?filter=${encodeURIComponent(filter)}&per_page=5`;
  const candidates = toItemArray<any>(await client.request<any>('GET', path)).filter((candidate) =>
    String(candidate.description ?? '').includes(marker),
  );
  if (candidates.length > 1) {
    throw new VikunjaError({
      status: 409,
      code: 'EXTERNAL_KEY_AMBIGUOUS',
      method: 'GET',
      path,
      message: `External key "${externalKey}" matched multiple task IDs: ${candidates
        .map((candidate) => candidate.id)
        .join(', ')}.`,
      fieldErrors: [],
    });
  }
  const task = candidates[0];
  return {
    externalKey,
    task: task
      ? {
          id: task.id,
          portalRef: task.identifier || `#${task.index}`,
          title: task.title,
        }
      : null,
  };
}

export async function taskDedupe(
  client: VikunjaApiClient,
  projectSelector: { id?: number; title?: string },
  title: string,
) {
  const project = await resolveProject(client, projectSelector);
  const trimmed = title.trim();
  const query = isFilterSafeTitle(trimmed)
    ? `filter=${encodeURIComponent(`title like ${escapeFilterString(`%${trimmed}%`)}`)}`
    : `q=${encodeURIComponent(trimmed)}`;
  const path = `/projects/${project.id}/tasks?${query}&page=1&per_page=100`;
  const raw = await client.request<any>('GET', path);
  const pagination = normalizePagination(raw);
  const candidates = toItemArray<any>(raw).map((task) => ({
    id: task.id,
    portalRef: task.identifier || `#${task.index}`,
    title: task.title,
    exact:
      String(task.title ?? '')
        .trim()
        .toLowerCase() === trimmed.toLowerCase(),
  }));
  return {
    project,
    title: trimmed,
    candidates,
    exactCount: candidates.filter((candidate) => candidate.exact).length,
    totalCount: pagination.total,
    incomplete: pagination.hasMore,
    advisory: true,
  };
}

export function lookupTaskReceipt(operation: string, idempotencyKey: string) {
  return lookupDurableOperationReceipt(operation, idempotencyKey);
}

function stripTrailingMarker(description: string, marker: string): string {
  const lines = description.trimEnd().split('\n');
  if (lines.at(-1)?.trim() === marker) {
    lines.pop();
  }
  return lines.join('\n').trimEnd();
}

function descriptionWithStableKey(
  description: string | undefined,
  externalKey: string,
  actor?: string,
): string {
  const marker = stableKeyMarker(externalKey);
  const body = stripTrailingMarker(description ?? '', marker);
  const attributed = withActorAttribution(body || undefined, actor)?.trimEnd() ?? '';
  return attributed ? `${attributed}\n\n${marker}` : marker;
}

export async function upsertTask(
  client: VikunjaApiClient,
  projectSelector: { id?: number; title?: string },
  fields: {
    title: string;
    description?: string;
    done?: boolean;
    priority?: number;
    dueDate?: string | null;
  },
  externalKey: string,
  expectedUpdatedAt?: string,
  actor?: string,
  dryRun = false,
): Promise<any> {
  const marker = stableKeyMarker(externalKey);
  const project = await resolveProject(client, projectSelector);
  const filter = `description like ${escapeFilterString(`%${marker}%`)}`;
  const lookupPath = `/projects/${project.id}/tasks?filter=${encodeURIComponent(filter)}&per_page=5`;

  let candidates: any[];
  try {
    candidates = toItemArray(await client.request<any>('GET', lookupPath));
  } catch (error: any) {
    if (error instanceof VikunjaError && error.status >= 400 && error.status < 500) {
      throw new VikunjaError({
        status: 502,
        code: 'UPSERT_LOOKUP_UNSUPPORTED',
        method: 'GET',
        path: lookupPath,
        message:
          'This Vikunja server cannot filter task descriptions, so stable-key upsert is unavailable.',
        fieldErrors: [],
      });
    }
    throw error;
  }

  const matches = candidates.filter((candidate) =>
    String(candidate.description ?? '').includes(marker),
  );
  if (matches.length > 1) {
    throw new VikunjaError({
      status: 409,
      code: 'EXTERNAL_KEY_AMBIGUOUS',
      method: 'GET',
      path: lookupPath,
      message: `External key "${externalKey}" matched multiple task IDs: ${matches
        .map((candidate) => candidate.id)
        .join(', ')}.`,
      fieldErrors: [],
    });
  }

  if (matches.length === 0) {
    const echo = await createTask(
      client,
      { id: project.id },
      {
        ...fields,
        description: descriptionWithStableKey(fields.description, externalKey, actor),
      },
      undefined,
      undefined,
      actor,
      dryRun,
    );
    return { ...echo, externalKey, actor };
  }

  const existing = matches[0];
  const replacementRequested = fields.title !== existing.title || fields.description !== undefined;
  if (replacementRequested && !expectedUpdatedAt) {
    throw new VikunjaError({
      status: 400,
      code: 'EXPECTED_UPDATED_AT_REQUIRED',
      method: 'TOOLS_CALL',
      path: 'expectedUpdatedAt',
      message:
        'expectedUpdatedAt is required when upsert replaces the title or description of an existing task.',
      fieldErrors: [],
    });
  }
  const updateFields: {
    title?: string;
    description?: string;
    done?: boolean;
    priority?: number;
    dueDate?: string | null;
  } = {
    title: fields.title,
    done: fields.done,
    priority: fields.priority,
    dueDate: fields.dueDate,
  };
  if (fields.description !== undefined) {
    updateFields.description = descriptionWithStableKey(fields.description, externalKey, actor);
  }

  const echo = await updateTask(
    client,
    { globalId: existing.id },
    updateFields,
    { id: project.id },
    expectedUpdatedAt,
    dryRun,
  );
  return { ...echo, externalKey, actor };
}

export interface ConsolidatedTaskDetails {
  task: Task;
  comments: any[];
  attachments: any[];
  commentPagination: Record<string, unknown>;
  attachmentPagination: Record<string, unknown>;
  composedCalls: string[];
}

export interface CompactTaskDetails {
  task: CompactTask;
}

export interface StandardTaskDetails {
  task: Task;
}

function enforceTaskResponseBudget<T>(value: T, maxResponseChars?: number): T {
  if (
    maxResponseChars !== undefined &&
    JSON.stringify(value).length + '```json\n{"ok":true,"data":}\n```'.length > maxResponseChars
  ) {
    throw new VikunjaError({
      status: 413,
      code: 'RESPONSE_TOO_LARGE',
      method: 'GET',
      path: '/tasks',
      message:
        'The requested task response exceeds maxResponseChars. Request minimal mode, fewer fields, or smaller comment/attachment limits.',
      fieldErrors: [],
    });
  }
  return value;
}

export function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector: { id?: number; title?: string } | undefined,
  commentLimit: number,
  requestedResponseMode: 'compact',
): Promise<CompactTaskDetails>;
export function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector: { id?: number; title?: string } | undefined,
  commentLimit: number,
  requestedResponseMode: 'standard',
): Promise<StandardTaskDetails>;
export function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector: { id?: number; title?: string } | undefined,
  commentLimit: number,
  requestedResponseMode: 'full',
  projectionOptions?: TaskProjectionOptions,
): Promise<ConsolidatedTaskDetails>;
export function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector: { id?: number; title?: string } | undefined,
  commentLimit: number,
  requestedResponseMode: 'minimal' | 'receipt',
  projectionOptions?: TaskProjectionOptions,
): Promise<{ task: Record<string, unknown> }>;
export function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  commentLimit?: number,
  requestedResponseMode?: ResponseMode,
  projectionOptions?: TaskProjectionOptions,
): Promise<ConsolidatedTaskDetails | StandardTaskDetails | CompactTaskDetails>;
export async function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  commentLimit = 5,
  requestedResponseMode?: ResponseMode,
  projectionOptions: TaskProjectionOptions = {},
): Promise<
  | ConsolidatedTaskDetails
  | StandardTaskDetails
  | CompactTaskDetails
  | { task: Record<string, unknown> }
> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector, {
    includeRawTask: true,
  });
  const webUrl = client.getConfig().vikunjaWebUrl;
  const responseMode = selectedResponseMode(client, requestedResponseMode);

  const taskPath = `/tasks/${taskRef.id}`;
  const rawTask = taskRef.rawTask;

  if (responseMode === 'minimal' || responseMode === 'receipt') {
    return enforceTaskResponseBudget(
      {
        task: projectTask(rawTask, taskRef.project, webUrl, {
          ...projectionOptions,
          fields: projectionOptions.fields ?? ['portalRef', 'project', 'title', 'done', 'priority'],
        }),
      },
      projectionOptions.maxResponseChars,
    );
  }

  if (responseMode === 'compact') {
    return enforceTaskResponseBudget(
      { task: normalizeCompactTask(rawTask, taskRef.project, webUrl) },
      projectionOptions.maxResponseChars,
    );
  }

  const task = normalizeTask(rawTask, taskRef.project, webUrl);

  if (responseMode === 'standard') {
    return enforceTaskResponseBudget({ task }, projectionOptions.maxResponseChars);
  }

  const composedCalls = [`GET ${taskPath}`];
  let comments: any[] = [];
  let attachments: any[] = [];
  let commentPagination: Record<string, unknown> = {
    returnedCount: 0,
    totalCount: 0,
    incomplete: false,
    nextPage: null,
  };
  let attachmentPagination: Record<string, unknown> = {
    returnedCount: 0,
    totalCount: 0,
    incomplete: false,
    nextPage: null,
  };

  if (commentLimit > 0) {
    const commentPath = `/tasks/${task.id}/comments?sort_by=created&order_by=desc&page=1&per_page=${commentLimit}`;
    composedCalls.push(`GET ${commentPath}`);
    const rawComments = await client.request<any>('GET', commentPath);
    const pagination = normalizePagination(rawComments);
    const allCommentItems = toItemArray(rawComments);
    const commentItems = allCommentItems.slice(0, commentLimit);
    const commentTotal = Math.max(pagination.total, allCommentItems.length);
    comments = normalizeDatesAndNulls(commentItems)
      .map((c: any) => ({
        id: c.id,
        comment: htmlToMarkdown(c.comment),
        author: { id: c.author?.id, username: c.author?.username },
        created: c.created,
      }))
      .sort((a: any, b: any) => String(b.created || '').localeCompare(String(a.created || '')))
      .slice(0, commentLimit);
    commentPagination = {
      returnedCount: comments.length,
      totalCount: commentTotal,
      incomplete: commentTotal > comments.length,
      nextPage: commentTotal > comments.length ? 2 : null,
    };
  }

  const attachmentLimit = projectionOptions.attachmentLimit ?? 20;
  if (attachmentLimit > 0) {
    const attachmentPath = `/tasks/${task.id}/attachments?page=1&per_page=${attachmentLimit}`;
    composedCalls.push(`GET ${attachmentPath}`);
    const rawAttachments = await client.request<any>('GET', attachmentPath);
    const pagination = normalizePagination(rawAttachments);
    const allAttachmentItems = toItemArray(rawAttachments);
    const attachmentTotal = Math.max(pagination.total, allAttachmentItems.length);
    attachments = allAttachmentItems.slice(0, attachmentLimit).map((att: any) => ({
      id: att.id,
      fileName: att.file?.name || att.file_name || 'unknown',
      mime: att.file?.mime || att.mime || 'application/octet-stream',
      fileSize: att.file?.size || att.file_size || 0,
      created: att.created,
    }));
    attachmentPagination = {
      returnedCount: attachments.length,
      totalCount: attachmentTotal,
      incomplete: attachmentTotal > attachments.length,
      nextPage: attachmentTotal > attachments.length ? 2 : null,
    };
  }

  return enforceTaskResponseBudget(
    {
      task,
      comments,
      attachments,
      commentPagination,
      attachmentPagination,
      composedCalls,
    },
    projectionOptions.maxResponseChars,
  );
}

export async function updateTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  fields: {
    title?: string;
    description?: string;
    appendDescription?: string;
    done?: boolean;
    priority?: number;
    dueDate?: string | null;
  },
  projectSelector?: { id?: number; title?: string },
  expectedUpdatedAt?: string,
  dryRun = false,
): Promise<any> {
  if (fields.description !== undefined && fields.appendDescription !== undefined) {
    throw new VikunjaError({
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'TOOLS_CALL',
      path: 'fields',
      message: 'Provide either description or appendDescription, not both.',
      fieldErrors: [],
    });
  }
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const webUrl = client.getConfig().vikunjaWebUrl;

  const currentRaw = await client.request<any>('GET', `/tasks/${taskRef.id}`);
  const currentTask = normalizeTask(currentRaw, taskRef.project, webUrl);
  const beforeState = {
    title: currentTask.title,
    done: currentTask.done,
    priority: currentTask.priority,
    dueDate: currentTask.dueDate,
    updatedAt: currentTask.updated || null,
  };

  if (expectedUpdatedAt) {
    const currentUpdated = currentTask.updated || '';
    if (currentUpdated !== expectedUpdatedAt) {
      throw new VikunjaError({
        status: 409,
        code: 'CONFLICT',
        method: 'PATCH',
        path: `/tasks/${taskRef.id}`,
        message: `Task update conflict. Expected task state updated at "${expectedUpdatedAt}", but current server state was updated at "${currentUpdated}".`,
        fieldErrors: [],
      });
    }
  }

  const body: Record<string, any> = {};

  if (fields.title !== undefined && fields.title !== currentTask.title) {
    body.title = fields.title;
  }
  if (fields.description !== undefined) {
    const normalizeMarkdown = (value: string) => value.replace(/\r\n/g, '\n').trim();
    if (
      normalizeMarkdown(fields.description) !== normalizeMarkdown(currentTask.description ?? '')
    ) {
      body.description = markdownToHtml(fields.description);
    }
  } else if (fields.appendDescription !== undefined) {
    const currentHtml = String(currentRaw.description ?? '');
    const appendHtml = markdownToHtml(fields.appendDescription);
    const markerPattern =
      /(?:<p(?:\s[^>]*)?>\s*)?\[vfm-key:[A-Za-z0-9][A-Za-z0-9:_\-./#]{0,119}\](?:\s*<\/p>)?\s*$/i;
    const marker = currentHtml.match(markerPattern);
    const insertionPoint = marker?.index ?? currentHtml.length;
    const beforeMarker = currentHtml.slice(0, insertionPoint);
    const markerAndTrailing = currentHtml.slice(insertionPoint);
    const separator = beforeMarker.length > 0 && !beforeMarker.endsWith('\n') ? '\n' : '';
    const htmlDesc = marker
      ? `${beforeMarker}${separator}${appendHtml}\n${markerAndTrailing}`
      : `${beforeMarker}${separator}${appendHtml}`;
    if (htmlDesc !== currentRaw.description) {
      body.description = htmlDesc;
    }
  }
  if (fields.done !== undefined && fields.done !== currentTask.done) {
    body.done = fields.done;
  }
  if (fields.priority !== undefined && fields.priority !== currentTask.priority) {
    body.priority = fields.priority;
  }
  if (fields.dueDate !== undefined) {
    const apiDueDate = fields.dueDate === null ? null : fields.dueDate;
    // Treat the server's zero date as "no due date" so clearing an already
    // empty due date reports unchanged instead of issuing a no-op PATCH.
    if (apiDueDate !== (normalizeZeroDate(currentRaw.due_date) || null)) {
      body.due_date = apiDueDate;
    }
  }

  if (Object.keys(body).length > 0) {
    if (dryRun) {
      return {
        action: 'would_update',
        operation: 'update',
        target: {
          id: currentTask.id,
          index: currentTask.index,
          identifier: currentTask.identifier,
          project: currentTask.project,
          title: currentTask.title,
        },
        changed: Object.keys(body),
        before: beforeState,
        after: {
          ...beforeState,
          ...(body.title !== undefined ? { title: body.title } : {}),
          ...(body.done !== undefined ? { done: body.done } : {}),
          ...(body.priority !== undefined ? { priority: body.priority } : {}),
          ...(body.due_date !== undefined ? { dueDate: body.due_date } : {}),
        },
        dryRun: true,
      };
    }
    const patchOperations = Object.entries(body).map(([field, value]) => ({
      op: 'replace',
      path: `/${field}`,
      value,
    }));
    let rawUpdated: any;
    try {
      rawUpdated = await patchTaskFields(client, taskRef.id, patchOperations);
    } catch (error: any) {
      if (!(error instanceof VikunjaError) || error.code !== 'VIKUNJA_SUBSCRIPTION_SCHEMA_BUG') {
        throw error;
      }
      const verified = await client.request<any>('GET', `/tasks/${taskRef.id}`);
      const applied = Object.entries(body).every(([field, value]) => {
        if (field === 'done') return Boolean(verified.done) === value;
        if (field === 'priority') return (verified.priority ?? 0) === value;
        if (field === 'due_date') return (normalizeZeroDate(verified.due_date) || null) === value;
        return verified[field] === value;
      });
      if (!applied) throw error;
      rawUpdated = verified;
    }
    const task = normalizeTask(rawUpdated, taskRef.project, webUrl);
    const action =
      fields.done === true && !currentTask.done
        ? 'closed'
        : fields.done === false && currentTask.done
          ? 'reopened'
          : 'updated';

    return {
      action,
      target: {
        id: task.id,
        index: task.index,
        identifier: task.identifier,
        project: task.project,
        title: task.title,
      },
      before: beforeState,
      after: {
        title: task.title,
        done: task.done,
        priority: task.priority,
        dueDate: task.dueDate,
        updatedAt: task.updated || null,
      },
    };
  }

  return {
    action: 'unchanged',
    target: {
      id: currentTask.id,
      index: currentTask.index,
      identifier: currentTask.identifier,
      project: currentTask.project,
      title: currentTask.title,
    },
    before: beforeState,
    after: beforeState,
  };
}

export async function patchTaskFields(
  client: VikunjaApiClient,
  taskId: number,
  patchOperations: { op: string; path: string; value: unknown }[],
): Promise<any> {
  return client.request<any>('PATCH', `/tasks/${taskId}`, {
    body: patchOperations,
    headers: { 'Content-Type': 'application/json-patch+json' },
  });
}

export async function deleteTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);

  if (dryRun) {
    return {
      action: 'would_delete',
      operation: 'delete',
      target: {
        id: taskRef.id,
        index: taskRef.index,
        identifier: taskRef.identifier,
        project: taskRef.project,
        title: taskRef.title,
      },
      changed: ['task'],
      before: { exists: true },
      after: { exists: false },
      dryRun: true,
    };
  }

  await client.request<any>('DELETE', `/tasks/${taskRef.id}`);

  return {
    action: 'deleted',
    target: {
      id: taskRef.id,
      index: taskRef.index,
      identifier: taskRef.identifier,
      project: taskRef.project,
      title: taskRef.title,
    },
    before: { exists: true },
    after: { exists: false },
  };
}

export interface CloseWithEvidenceResult {
  comment: { id: number; author: { id?: number; username?: string }; created?: string };
  task: WriteEcho;
  changed: ('comment' | 'done')[];
  composedCalls: string[];
  outcome?: 'completed' | 'partial' | 'preview';
  evidenceStatus?: 'created' | 'not-created' | 'would-create';
  taskStatus?: 'open' | 'closed' | 'would-close' | 'unknown';
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  verification?: { verdict: string };
  error?: ReturnType<typeof toErrorEnvelope>['error'];
}

async function readBackTaskStatus(
  client: VikunjaApiClient,
  taskId: number,
): Promise<'open' | 'closed' | 'unknown'> {
  try {
    const current = await client.request<any>('GET', `/tasks/${taskId}`);
    return current.done === true ? 'closed' : 'open';
  } catch {
    return 'unknown';
  }
}

export async function closeWithEvidence(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  evidenceComment: string,
  projectSelector?: { id?: number; title?: string },
  idempotencyKey?: string,
  actor?: string,
  dryRun = false,
  expectedUpdatedAt?: string,
): Promise<any> {
  const payload = { taskSelector, projectSelector, evidenceComment, actor, expectedUpdatedAt };
  const execute = async (): Promise<CloseWithEvidenceResult> => {
    const taskRef = await resolveTask(client, taskSelector, projectSelector, {
      includeRawTask: true,
    });
    if (dryRun) {
      return {
        task: {
          action: 'would_update',
          target: {
            id: taskRef.id,
            index: taskRef.index,
            identifier: taskRef.identifier,
            project: taskRef.project,
            title: taskRef.title,
          },
        } as any,
        comment: { id: 0, author: {}, created: undefined },
        changed: ['comment', 'done'],
        composedCalls: [],
        outcome: 'preview',
        evidenceStatus: 'would-create',
        taskStatus: 'would-close',
        before: { done: Boolean(taskRef.rawTask?.done), evidencePresent: false },
        after: { done: true, evidencePresent: true },
        verification: { verdict: 'RECORDED' },
        dryRun: true,
      } as any;
    }
    const composedCalls = [];

    composedCalls.push(`POST /tasks/${taskRef.id}/comments`);
    const comment = await createComment(
      client,
      taskRef.id,
      evidenceComment,
      undefined,
      idempotencyKey ? `close-with-evidence:${idempotencyKey}` : undefined,
      actor,
    );

    let taskEcho: WriteEcho;
    try {
      taskEcho = await updateTask(
        client,
        taskRef.id,
        { done: true },
        projectSelector,
        expectedUpdatedAt,
      );
      if (taskEcho.action !== 'unchanged') composedCalls.push(`PATCH /tasks/${taskRef.id}`);
    } catch (error) {
      const taskStatus = await readBackTaskStatus(client, taskRef.id);
      return {
        comment: {
          id: comment.id,
          author: comment.author,
          created: comment.created,
        },
        task: {
          action: 'unchanged',
          target: {
            id: taskRef.id,
            index: taskRef.index,
            identifier: taskRef.identifier,
            project: taskRef.project,
            title: taskRef.title,
          },
        },
        changed: ['comment'],
        composedCalls,
        outcome: 'partial',
        evidenceStatus: 'created',
        taskStatus,
        before: { done: Boolean(taskRef.rawTask?.done), evidencePresent: false },
        after: {
          done: taskStatus === 'unknown' ? null : taskStatus === 'closed',
          evidencePresent: true,
        },
        verification: { verdict: 'RECORDED' },
        error: toErrorEnvelope(error).error,
      };
    }

    return {
      comment: {
        id: comment.id,
        author: comment.author,
        created: comment.created,
      },
      task: taskEcho,
      changed: taskEcho.action === 'unchanged' ? ['comment'] : ['comment', 'done'],
      composedCalls,
      outcome: 'completed',
      evidenceStatus: 'created',
      taskStatus: 'closed',
      before: { ...(taskEcho as any).before, evidencePresent: false },
      after: { ...(taskEcho as any).after, evidencePresent: true },
      verification: { verdict: 'RECORDED' },
    };
  };

  return idempotencyKey && !dryRun
    ? runDurableOperation('close-with-evidence', idempotencyKey, payload, execute)
    : execute();
}

export interface VerificationEvidence {
  command: string;
  result: string;
  timestamp: string;
  evidenceKey: string;
  revision?: string;
  taskState?: string;
}

function evidenceMarker(evidenceKey: string): string {
  if (!EXTERNAL_KEY_PATTERN.test(evidenceKey)) {
    throw new VikunjaError({
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'TOOLS_CALL',
      path: 'evidence.evidenceKey',
      message: 'evidenceKey must use the same safe 1-120 character format as externalKey.',
      fieldErrors: [],
    });
  }
  return `[vfm-evidence:${evidenceKey}]`;
}

function evidenceMarkdown(evidence: VerificationEvidence): string {
  const lines = [
    '### Verification evidence',
    `- Command: ${evidence.command}`,
    `- Result: ${evidence.result}`,
    `- Timestamp: ${evidence.timestamp}`,
  ];
  if (evidence.revision) lines.push(`- Revision: ${evidence.revision}`);
  if (evidence.taskState) lines.push(`- Task state: ${evidence.taskState}`);
  lines.push('', evidenceMarker(evidence.evidenceKey));
  return lines.join('\n');
}

function verificationVerdict(markdown: string): 'PASS' | 'FAIL' | null {
  const match = /(?:^|\n)\s*(?:[-*]\s*)?(?:Result:\s*)?(PASS|FAIL)\b/i.exec(markdown);
  return match ? (match[1].toUpperCase() as 'PASS' | 'FAIL') : null;
}

function compactTarget(taskRef: Awaited<ReturnType<typeof resolveTask>>) {
  return {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
}

export async function appendEvidenceIfChanged(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  evidence: VerificationEvidence,
  projectSelector?: { id?: number; title?: string },
  idempotencyKey?: string,
  actor?: string,
  dryRun = false,
): Promise<any> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const marker = evidenceMarker(evidence.evidenceKey);
  const comments = await fetchAllCollectionItems<any>(
    (path) => client.request<any>('GET', path),
    `/tasks/${taskRef.id}/comments`,
  );
  const existing = comments.find((comment) =>
    htmlToMarkdown(String(comment.comment ?? '')).includes(marker),
  );
  if (existing) {
    return {
      action: 'unchanged',
      target: compactTarget(taskRef),
      evidenceKey: evidence.evidenceKey,
      commentId: existing.id,
      changed: [],
      before: { evidencePresent: true },
      after: { evidencePresent: true },
      verification: {
        verdict: verificationVerdict(htmlToMarkdown(String(existing.comment ?? ''))),
      },
      dryRun,
    };
  }
  if (dryRun) {
    return {
      action: 'would_comment',
      target: compactTarget(taskRef),
      evidenceKey: evidence.evidenceKey,
      changed: ['comment'],
      before: { evidencePresent: false },
      after: { evidencePresent: true },
      verification: { verdict: verificationVerdict(evidence.result) },
      dryRun: true,
    };
  }
  const comment = await createComment(
    client,
    { globalId: taskRef.id },
    evidenceMarkdown(evidence),
    undefined,
    idempotencyKey,
    actor,
  );
  return {
    action: 'commented',
    target: compactTarget(taskRef),
    evidenceKey: evidence.evidenceKey,
    commentId: comment.id,
    changed: ['comment'],
    before: { evidencePresent: false },
    after: { evidencePresent: true },
    verification: { verdict: verificationVerdict(evidence.result) },
  };
}

export async function closeWithStructuredEvidence(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  evidence: VerificationEvidence,
  projectSelector: { id?: number; title?: string },
  idempotencyKey: string,
  actor: string,
  dryRun = false,
): Promise<any> {
  const evidenceReceipt = await appendEvidenceIfChanged(
    client,
    taskSelector,
    evidence,
    projectSelector,
    dryRun ? undefined : `${idempotencyKey}:evidence`,
    actor,
    dryRun,
  );
  try {
    const task = await updateTask(
      client,
      taskSelector,
      { done: true },
      projectSelector,
      undefined,
      dryRun,
    );
    return {
      action: dryRun ? 'would_close' : task.action,
      target: task.target,
      evidence: {
        key: evidence.evidenceKey,
        created: evidenceReceipt.action === 'commented',
        commentId: evidenceReceipt.commentId ?? null,
      },
      taskStatus: dryRun ? 'would-close' : 'closed',
      outcome: dryRun ? 'preview' : 'completed',
      changed: [...evidenceReceipt.changed, ...(task.action === 'unchanged' ? [] : ['done'])],
      before: { ...task.before, evidencePresent: evidenceReceipt.before.evidencePresent },
      after: { ...task.after, evidencePresent: true },
      verification: { verdict: verificationVerdict(evidence.result) ?? 'RECORDED' },
      dryRun,
    };
  } catch (error) {
    const taskStatus = await readBackTaskStatus(client, evidenceReceipt.target.id);
    return {
      action: 'partial',
      target: evidenceReceipt.target,
      evidence: {
        key: evidence.evidenceKey,
        created: evidenceReceipt.action === 'commented',
        commentId: evidenceReceipt.commentId ?? null,
      },
      taskStatus,
      outcome: 'partial',
      changed: evidenceReceipt.changed,
      before: { evidencePresent: evidenceReceipt.before.evidencePresent },
      after: { done: taskStatus === 'closed', evidencePresent: true },
      verification: { verdict: verificationVerdict(evidence.result) ?? 'RECORDED' },
      error: toErrorEnvelope(error).error,
    };
  }
}

export async function closeIfVerified(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const comments = await fetchAllCollectionItems<any>(
    (path) => client.request<any>('GET', path),
    `/tasks/${taskRef.id}/comments?order_by=desc`,
  );
  const latestVerdict = comments
    .map((comment) => ({
      ...comment,
      markdown: htmlToMarkdown(String(comment.comment ?? '')),
      verdict: verificationVerdict(htmlToMarkdown(String(comment.comment ?? ''))),
    }))
    .sort((left, right) => String(right.created ?? '').localeCompare(String(left.created ?? '')))
    .find((comment) => comment.verdict !== null);
  if (!latestVerdict || latestVerdict.verdict !== 'PASS') {
    throw new VikunjaError({
      status: 409,
      code: 'VERIFICATION_REQUIRED',
      method: 'TOOLS_CALL',
      path: `/tasks/${taskRef.id}/comments`,
      message: latestVerdict
        ? `Task ${taskRef.identifier || `#${taskRef.index}`} has a newer FAIL verification verdict.`
        : `Task ${taskRef.identifier || `#${taskRef.index}`} has no PASS verification verdict.`,
      fieldErrors: [],
    });
  }
  const task = await updateTask(
    client,
    { globalId: taskRef.id },
    { done: true },
    { id: taskRef.project.id },
    undefined,
    dryRun,
  );
  return {
    ...task,
    operation: 'close_if_verified',
    verification: {
      verdict: 'PASS',
      commentId: latestVerdict.id,
      timestamp: latestVerdict.created ?? null,
    },
    dryRun,
  };
}

export async function transitionWithEvidence(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  statusLabel: string,
  evidence: VerificationEvidence,
  projectSelector: { id?: number; title?: string },
  idempotencyKey: string,
  actor: string,
  createIfMissing = false,
  dryRun = false,
): Promise<any> {
  const evidenceReceipt = await appendEvidenceIfChanged(
    client,
    taskSelector,
    evidence,
    projectSelector,
    dryRun ? undefined : `${idempotencyKey}:evidence`,
    actor,
    dryRun,
  );
  try {
    const status = await setTaskStatus(
      client,
      taskSelector,
      statusLabel,
      projectSelector,
      createIfMissing,
      dryRun,
    );
    return {
      ...status,
      operation: 'transition_with_evidence',
      evidence: {
        key: evidence.evidenceKey,
        created: evidenceReceipt.action === 'commented',
        commentId: evidenceReceipt.commentId ?? null,
      },
      outcome: dryRun ? 'preview' : 'completed',
      changed: [...evidenceReceipt.changed, ...(status.action === 'unchanged' ? [] : ['status'])],
      before: { ...status.before, evidencePresent: evidenceReceipt.before.evidencePresent },
      after: { ...status.after, evidencePresent: true },
      verification: { verdict: verificationVerdict(evidence.result) ?? 'RECORDED' },
      dryRun,
    };
  } catch (error) {
    return {
      action: 'partial',
      target: evidenceReceipt.target,
      operation: 'transition_with_evidence',
      evidence: {
        key: evidence.evidenceKey,
        created: evidenceReceipt.action === 'commented',
        commentId: evidenceReceipt.commentId ?? null,
      },
      outcome: 'partial',
      changed: evidenceReceipt.changed,
      before: { evidencePresent: evidenceReceipt.before.evidencePresent },
      after: { evidencePresent: true, statusLabels: null },
      verification: { verdict: verificationVerdict(evidence.result) ?? 'RECORDED' },
      error: toErrorEnvelope(error).error,
    };
  }
}

export async function resolveUser(
  client: VikunjaApiClient,
  userSelector: string | number,
): Promise<number> {
  const selectorStr = String(userSelector).trim();
  if (/^\d+$/.test(selectorStr)) {
    const id = Number(selectorStr);
    if (!Number.isInteger(id) || id <= 0) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_USER_SELECTOR',
        method: 'GET',
        path: '/users',
        message: `Invalid user id: "${userSelector}"`,
        fieldErrors: [],
      });
    }
    return id;
  }

  // Search may be paginated; scan all pages for an exact username match.
  const items = await fetchAllCollectionItems(
    async (path) => client.request<any>('GET', path),
    `/users?q=${encodeURIComponent(selectorStr)}`,
  );
  const exact = items.find(
    (u: any) =>
      typeof u?.username === 'string' &&
      u.username.toLowerCase() === selectorStr.toLowerCase() &&
      Number.isInteger(Number(u.id)) &&
      Number(u.id) > 0,
  );

  if (!exact) {
    throw new VikunjaError({
      status: 404,
      code: 'USER_NOT_FOUND',
      method: 'GET',
      path: '/users',
      message: `User not found for username: "${userSelector}"`,
      fieldErrors: [],
    });
  }

  return exact.id;
}

export async function resolveLabel(
  client: VikunjaApiClient,
  labelSelector: string | number,
): Promise<number> {
  const selectorStr = String(labelSelector).trim();
  if (/^\d+$/.test(selectorStr)) {
    const id = Number(selectorStr);
    if (!Number.isInteger(id) || id <= 0) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_LABEL_SELECTOR',
        method: 'GET',
        path: '/labels',
        message: `Invalid label id: "${labelSelector}"`,
        fieldErrors: [],
      });
    }
    return id;
  }

  const cached = cache.getLabel(selectorStr);
  if (cached !== null) return cached;

  const items = await listAllLabels(client);
  const exactMatches = items.filter(
    (label: any) => label.title.toLowerCase() === selectorStr.toLowerCase(),
  );

  if (exactMatches.length === 0) {
    throw new VikunjaError({
      status: 404,
      code: 'LABEL_NOT_FOUND',
      method: 'GET',
      path: '/labels',
      message: `Label not found: "${labelSelector}"`,
      fieldErrors: [],
    });
  }

  if (exactMatches.length > 1) {
    throw new VikunjaError({
      status: 409,
      code: 'LABEL_TITLE_AMBIGUOUS',
      method: 'GET',
      path: '/labels',
      message: `Multiple labels match title "${labelSelector}". Use a numeric label ID. Candidates: ${JSON.stringify(exactMatches.map((label: any) => ({ id: label.id, title: label.title })))}`,
      fieldErrors: [],
    });
  }

  const exact = exactMatches[0];
  cache.setLabel(selectorStr, exact.id);
  return exact.id;
}

export async function resolveOrCreateLabel(
  client: VikunjaApiClient,
  labelSelector: string | number,
  options: { createIfMissing?: boolean } = { createIfMissing: true },
): Promise<number> {
  const selectorStr = String(labelSelector).trim();
  if (/^\d+$/.test(selectorStr)) {
    return resolveLabel(client, selectorStr);
  }

  try {
    return await resolveLabel(client, selectorStr);
  } catch (err: any) {
    if (!(err instanceof VikunjaError) || err.code !== 'LABEL_NOT_FOUND') {
      throw err;
    }
    if (options.createIfMissing === false) {
      throw err;
    }
  }

  const created = await client.request<any>('POST', '/labels', {
    body: { title: selectorStr },
  });
  cache.setLabel(selectorStr, created.id);
  return created.id;
}

export async function assignTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  userSelector: string | number,
  projectSelector?: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const userId = await resolveUser(client, userSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
  const beforeAssignees = taskRef.assignees.map((user) => user.id);
  const afterAssignees = [...new Set([...beforeAssignees, userId])];

  if (taskRef.assignees.some((user) => user.id === userId)) {
    return {
      action: 'unchanged',
      target,
      before: { assigneeIds: beforeAssignees },
      after: { assigneeIds: beforeAssignees },
    };
  }

  if (dryRun) {
    return {
      action: 'would_update',
      operation: 'assign',
      target,
      changed: ['assignee'],
      before: { assigneeIds: beforeAssignees },
      after: { assigneeIds: afterAssignees },
      dryRun: true,
    };
  }

  await client.request<any>('POST', `/tasks/${taskRef.id}/assignees`, {
    body: { user_id: userId },
  });

  return {
    action: 'updated',
    target,
    before: { assigneeIds: beforeAssignees },
    after: { assigneeIds: afterAssignees },
  };
}

export async function unassignTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  userSelector: string | number,
  projectSelector?: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const userId = await resolveUser(client, userSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
  const beforeAssignees = taskRef.assignees.map((user) => user.id);
  const afterAssignees = beforeAssignees.filter((id) => id !== userId);

  if (!taskRef.assignees.some((user) => user.id === userId)) {
    return {
      action: 'unchanged',
      target,
      before: { assigneeIds: beforeAssignees },
      after: { assigneeIds: beforeAssignees },
    };
  }

  if (dryRun) {
    return {
      action: 'would_update',
      operation: 'unassign',
      target,
      changed: ['assignee'],
      before: { assigneeIds: beforeAssignees },
      after: { assigneeIds: afterAssignees },
      dryRun: true,
    };
  }

  await client.request<any>('DELETE', `/tasks/${taskRef.id}/assignees/${userId}`);

  return {
    action: 'updated',
    target,
    before: { assigneeIds: beforeAssignees },
    after: { assigneeIds: afterAssignees },
  };
}

export async function listAssignees(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
): Promise<any[]> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const res = await client.request<any>('GET', `/tasks/${taskRef.id}/assignees`);
  return toItemArray(res).map((u: any) => ({
    id: u.id,
    username: u.username,
  }));
}

export async function applyLabel(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  labelTitle: string | number,
  projectSelector?: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
  const beforeLabels = taskRef.labels.map((label) => ({ id: label.id, title: label.title }));
  const numericSelector = typeof labelTitle === 'number' || /^\d+$/.test(String(labelTitle).trim());
  if (
    !numericSelector &&
    taskRef.labels.some((label) => label.title.toLowerCase() === String(labelTitle).toLowerCase())
  ) {
    return {
      action: 'unchanged',
      target,
      before: { labels: beforeLabels },
      after: { labels: beforeLabels },
    };
  }
  let labelId: number;
  try {
    labelId = dryRun
      ? await resolveLabel(client, String(labelTitle))
      : await resolveOrCreateLabel(client, labelTitle);
  } catch (error: any) {
    if (dryRun && error instanceof VikunjaError && error.code === 'LABEL_NOT_FOUND') {
      return {
        action: 'would_update',
        operation: 'apply-label',
        target,
        changed: ['label'],
        wouldCreateLabel: String(labelTitle),
        before: { labels: beforeLabels },
        after: { labels: [...beforeLabels, { id: null, title: String(labelTitle) }] },
        dryRun: true,
      };
    }
    throw error;
  }

  if (taskRef.labels.some((label) => label.id === labelId)) {
    return {
      action: 'unchanged',
      target,
      before: { labels: beforeLabels },
      after: { labels: beforeLabels },
    };
  }
  const applied = { id: labelId, title: String(labelTitle) };

  if (dryRun) {
    return {
      action: 'would_update',
      operation: 'apply-label',
      target,
      changed: ['label'],
      before: { labels: beforeLabels },
      after: { labels: [...beforeLabels, applied] },
      dryRun: true,
    };
  }

  await client.request<any>('POST', `/tasks/${taskRef.id}/labels`, {
    body: { label_id: labelId },
  });

  return {
    action: 'updated',
    target,
    before: { labels: beforeLabels },
    after: { labels: [...beforeLabels, applied] },
  };
}

export async function removeLabel(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  labelTitle: string | number,
  projectSelector?: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
  const beforeLabels = taskRef.labels.map((label) => ({ id: label.id, title: label.title }));
  const numericSelector = typeof labelTitle === 'number' || /^\d+$/.test(String(labelTitle).trim());
  const appliedLabel = taskRef.labels.find((label) =>
    numericSelector
      ? label.id === Number(labelTitle)
      : label.title.toLowerCase() === String(labelTitle).toLowerCase(),
  );
  if (!appliedLabel) {
    return {
      action: 'unchanged',
      target,
      before: { labels: beforeLabels },
      after: { labels: beforeLabels },
    };
  }
  const afterLabels = beforeLabels.filter((label) => label.id !== appliedLabel.id);

  if (dryRun) {
    return {
      action: 'would_update',
      operation: 'remove-label',
      target,
      changed: ['label'],
      before: { labels: beforeLabels },
      after: { labels: afterLabels },
      dryRun: true,
    };
  }

  await client.request<any>('DELETE', `/tasks/${taskRef.id}/labels/${appliedLabel.id}`);

  return {
    action: 'updated',
    target,
    before: { labels: beforeLabels },
    after: { labels: afterLabels },
  };
}

export async function listLabels(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
): Promise<any[]> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const res = await client.request<any>('GET', `/tasks/${taskRef.id}/labels`);
  return toItemArray(res).map((l: any) => ({
    id: l.id,
    title: l.title,
  }));
}

export interface SetStatusResult extends WriteEcho {
  statusLabel: string;
  removedStatusLabels: string[];
  repaired: boolean;
}

export async function setTaskStatus(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  statusLabel: string,
  projectSelector?: { id?: number; title?: string },
  createIfMissing = false,
  dryRun = false,
): Promise<any> {
  const prefix = client.getConfig().statusLabelPrefix ?? 'status:';
  if (!statusLabel.toLowerCase().startsWith(prefix.toLowerCase())) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_STATUS_LABEL',
      method: 'TOOLS_CALL',
      path: 'statusLabel',
      message: `Status label must start with the configured prefix "${prefix}".`,
      fieldErrors: [],
    });
  }

  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
  const currentStatusLabels = taskRef.labels.filter((label) =>
    label.title.toLowerCase().startsWith(prefix.toLowerCase()),
  );
  const requestedCurrent = currentStatusLabels.find(
    (label) => label.title.toLowerCase() === statusLabel.toLowerCase(),
  );
  const beforeStatus = currentStatusLabels.map((label) => label.title);

  if (currentStatusLabels.length === 1 && requestedCurrent) {
    return {
      action: 'unchanged',
      target,
      statusLabel: requestedCurrent.title,
      removedStatusLabels: [],
      repaired: false,
      before: { statusLabels: beforeStatus },
      after: { statusLabels: beforeStatus },
    };
  }

  let labelId = requestedCurrent?.id;
  let wouldCreateLabel = false;
  if (!labelId) {
    if (dryRun) {
      try {
        labelId = await resolveLabel(client, statusLabel);
      } catch (error: any) {
        if (
          !(error instanceof VikunjaError) ||
          error.code !== 'LABEL_NOT_FOUND' ||
          !createIfMissing
        ) {
          throw error;
        }
        wouldCreateLabel = true;
        labelId = -1;
      }
    } else {
      labelId = await resolveOrCreateLabel(client, statusLabel, { createIfMissing });
    }
  }
  const retained = taskRef.labels
    .filter((label) => !label.title.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((label) => ({ id: label.id, title: label.title }));

  if (dryRun) {
    return {
      action: 'would_update',
      operation: 'set_status',
      target,
      statusLabel,
      removedStatusLabels: currentStatusLabels
        .filter((label) => label.id !== labelId)
        .map((label) => label.title),
      repaired: currentStatusLabels.length > 1,
      wouldCreateLabel,
      changed: ['labels'],
      before: { statusLabels: beforeStatus },
      after: { statusLabels: [statusLabel] },
      dryRun: true,
    };
  }

  await client.request<any>('PUT', `/tasks/${taskRef.id}/labels/bulk`, {
    body: { labels: [...retained, { id: labelId, title: statusLabel }] },
  });

  return {
    action: 'updated',
    target,
    statusLabel: requestedCurrent?.title ?? statusLabel,
    removedStatusLabels: currentStatusLabels
      .filter((label) => label.id !== labelId)
      .map((label) => label.title),
    repaired: currentStatusLabels.length > 1,
    before: { statusLabels: beforeStatus },
    after: { statusLabels: [requestedCurrent?.title ?? statusLabel] },
  };
}

const VALID_RELATION_KINDS = [
  'subtask',
  'parenttask',
  'related',
  'duplicateof',
  'duplicates',
  'blocking',
  'blocked',
  'precedes',
  'follows',
  'copiedfrom',
  'copiedto',
];

function taskSelectorForError(selector: TaskSelectorInput): string {
  return typeof selector === 'object' ? JSON.stringify(selector) : String(selector);
}

/**
 * Global numeric task ids are self-sufficient and may point at another project.
 * Portal/short refs (#n / PRJ-n) need project context from the primary call.
 */
function otherTaskProjectContext(
  otherTaskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
): { id?: number; title?: string } | undefined {
  const isGlobal =
    typeof otherTaskSelector === 'object'
      ? 'globalId' in otherTaskSelector
      : /^\d+$/.test(String(otherTaskSelector).trim());
  return isGlobal ? undefined : projectSelector;
}

function hasRelatedTask(rawTask: any, relationKind: string, otherTaskId: number): boolean {
  const related = rawTask?.related_tasks?.[relationKind];
  return Array.isArray(related) && related.some((task: any) => task?.id === otherTaskId);
}

export async function relateTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  otherTaskSelector: TaskSelectorInput,
  relationKind: string,
  projectSelector?: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  if (!VALID_RELATION_KINDS.includes(relationKind)) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_RELATION_KIND',
      method: 'POST',
      path: `/tasks/${encodeURIComponent(taskSelectorForError(taskSelector))}/relations`,
      message: `Invalid relation kind: "${relationKind}". Valid kinds are: ${VALID_RELATION_KINDS.join(', ')}`,
      fieldErrors: [],
    });
  }

  const taskRef = await resolveTask(client, taskSelector, projectSelector, {
    includeRawTask: true,
  });
  const otherTaskRef = await resolveTask(
    client,
    otherTaskSelector,
    otherTaskProjectContext(otherTaskSelector, projectSelector),
  );

  const otherTask = {
    id: otherTaskRef.id,
    identifier: otherTaskRef.identifier || `#${otherTaskRef.index}`,
    title: otherTaskRef.title,
    project: otherTaskRef.project,
  };
  const relationWasPresent = hasRelatedTask(taskRef.rawTask, relationKind, otherTaskRef.id);
  const before = {
    relation: { kind: relationKind, otherTaskId: otherTaskRef.id, present: relationWasPresent },
  };
  const after = { relation: { kind: relationKind, otherTaskId: otherTaskRef.id, present: true } };
  if (relationWasPresent) {
    return {
      action: 'unchanged',
      target: compactTarget(taskRef),
      otherTask,
      relationKind,
      before,
      after: before,
    };
  }
  if (dryRun) {
    return {
      action: 'would_update',
      operation: 'relate',
      target: {
        id: taskRef.id,
        index: taskRef.index,
        identifier: taskRef.identifier,
        project: taskRef.project,
        title: taskRef.title,
      },
      otherTask,
      relationKind,
      changed: ['relation'],
      before,
      after,
      dryRun: true,
    };
  }

  await client.request<any>('POST', `/tasks/${taskRef.id}/relations`, {
    body: {
      other_task_id: otherTaskRef.id,
      relation_kind: relationKind,
    },
  });

  return {
    action: 'updated',
    target: {
      id: taskRef.id,
      index: taskRef.index,
      identifier: taskRef.identifier,
      project: taskRef.project,
      title: taskRef.title,
    },
    otherTask,
    relationKind,
    before,
    after,
  };
}

export async function unrelateTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  otherTaskSelector: TaskSelectorInput,
  relationKind: string,
  projectSelector?: { id?: number; title?: string },
  dryRun = false,
): Promise<any> {
  if (!VALID_RELATION_KINDS.includes(relationKind)) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_RELATION_KIND',
      method: 'DELETE',
      path: `/tasks/${encodeURIComponent(taskSelectorForError(taskSelector))}/relations/${relationKind}/${encodeURIComponent(taskSelectorForError(otherTaskSelector))}`,
      message: `Invalid relation kind: "${relationKind}". Valid kinds are: ${VALID_RELATION_KINDS.join(', ')}`,
      fieldErrors: [],
    });
  }

  const taskRef = await resolveTask(client, taskSelector, projectSelector, {
    includeRawTask: true,
  });
  const otherTaskRef = await resolveTask(
    client,
    otherTaskSelector,
    otherTaskProjectContext(otherTaskSelector, projectSelector),
  );

  const otherTask = {
    id: otherTaskRef.id,
    identifier: otherTaskRef.identifier || `#${otherTaskRef.index}`,
    title: otherTaskRef.title,
    project: otherTaskRef.project,
  };
  const relationWasPresent = hasRelatedTask(taskRef.rawTask, relationKind, otherTaskRef.id);
  const before = {
    relation: { kind: relationKind, otherTaskId: otherTaskRef.id, present: relationWasPresent },
  };
  const after = { relation: { kind: relationKind, otherTaskId: otherTaskRef.id, present: false } };
  if (!relationWasPresent) {
    return {
      action: 'unchanged',
      target: compactTarget(taskRef),
      otherTask,
      relationKind,
      before,
      after: before,
    };
  }
  if (dryRun) {
    return {
      action: 'would_update',
      operation: 'unrelate',
      target: {
        id: taskRef.id,
        index: taskRef.index,
        identifier: taskRef.identifier,
        project: taskRef.project,
        title: taskRef.title,
      },
      otherTask,
      relationKind,
      changed: ['relation'],
      before,
      after,
      dryRun: true,
    };
  }

  await client.request<any>(
    'DELETE',
    `/tasks/${taskRef.id}/relations/${relationKind}/${otherTaskRef.id}`,
  );

  return {
    action: 'updated',
    target: {
      id: taskRef.id,
      index: taskRef.index,
      identifier: taskRef.identifier,
      project: taskRef.project,
      title: taskRef.title,
    },
    otherTask,
    relationKind,
    before,
    after,
  };
}

export async function listRelations(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  requestedResponseMode?: ResponseMode,
): Promise<any[]> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const webUrl = client.getConfig().vikunjaWebUrl;
  const responseMode = selectedResponseMode(client, requestedResponseMode);

  const rawTask = await client.request<any>('GET', `/tasks/${taskRef.id}`);
  const related = rawTask.related_tasks || {};
  const relations: any[] = [];
  const projectCache = new Map<number, ProjectRef>();
  projectCache.set(taskRef.project.id, taskRef.project);

  for (const [kind, taskList] of Object.entries(related)) {
    if (Array.isArray(taskList)) {
      for (const t of taskList as any[]) {
        const pid = t.project_id ?? t.project?.id ?? taskRef.project.id;
        let project = projectCache.get(pid);
        if (!project) {
          if (t.project?.title) {
            project = { id: pid, title: t.project.title };
          } else {
            project = await resolveProject(client, { id: pid });
          }
          projectCache.set(pid, project);
        }
        relations.push({
          relationKind: kind,
          task: ['minimal', 'receipt', 'compact'].includes(responseMode)
            ? normalizeCompactTask(t, project, webUrl)
            : responseMode === 'full'
              ? normalizeTask(t, project, webUrl)
              : normalizeTaskListItem(t, project, webUrl),
        });
      }
    }
  }

  return relations;
}
