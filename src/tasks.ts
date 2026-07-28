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
import { VikunjaError } from './errors.js';
import {
  normalizePagination,
  normalizeDatesAndNulls,
  normalizeZeroDate,
  htmlToMarkdown,
  markdownToHtml,
  toItemArray,
  fetchAllCollectionItems,
} from './format.js';
import { runDurableOperation } from './idempotency.js';
import { createComment } from './comments.js';
import { attachFiles, AttachmentInfo } from './attachments.js';
import { withActorAttribution } from './mutation-policy.js';

const MAX_AGENT_PAGE_SIZE = 100;

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
}

export interface UpsertEcho extends WriteEcho {
  externalKey: string;
  actor?: string;
}

export const EXTERNAL_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_\-./#]{0,119}$/;

// Upload local files to a just-created/found task and fold the honest
// per-file outcome (uploaded vs failed) into its write echo.
async function attachToEcho(
  client: VikunjaApiClient,
  echo: WriteEcho,
  attachments?: string[],
): Promise<WriteEcho> {
  if (!attachments || attachments.length === 0) {
    return echo;
  }
  const result = await attachFiles(
    client,
    echo.target.id,
    attachments.map((filePath) => ({ filePath })),
  );
  echo.attachments = result.uploaded;
  if (result.failed.length > 0) {
    echo.attachmentErrors = result.failed;
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
  descriptionContains?: string;
  actor?: string;
  q?: string;
  countOnly?: boolean;
  filter?: string;
  responseMode?: ResponseMode;
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
  if (options.descriptionContains !== undefined) {
    parts.push(`description like ${escapeFilterString(`%${options.descriptionContains}%`)}`);
  }
  if (options.actor !== undefined) {
    // No parentheses in the pattern: Vikunja's filter tokenizer rejects "(" and
    // ")" inside quoted strings (live-verified 2026-07-23), so match the
    // attribution text "by <actor>" without the surrounding parens.
    parts.push(`description like ${escapeFilterString(`%by ${options.actor}%`)}`);
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
  return requested ?? client.getConfig().responseMode ?? 'compact';
}

async function listProjectTasksInternal(
  client: VikunjaApiClient,
  project: ProjectRef,
  options: ListTasksOptions,
): Promise<any> {
  const queryParams: Record<string, string> = {
    page: String(options.page || 1),
    // For a count-only request we only need the total from the pagination
    // metadata, so fetch the smallest possible page instead of 20 task bodies.
    per_page: String(options.countOnly ? 1 : Math.min(options.perPage || 20, MAX_AGENT_PAGE_SIZE)),
  };

  if (options.q) {
    queryParams.q = options.q;
  }

  const filterStr = buildFilterString(options);
  if (filterStr) {
    queryParams.filter = filterStr;
  }

  // NOTE: do not add `expand`. Labels and assignees are always embedded in each
  // task; the v2 `expand` param only accepts subtasks/buckets/reactions/etc., so
  // `expand=labels,assignees` is rejected with HTTP 422.

  const queryString = new URLSearchParams(queryParams).toString();
  const path = `/projects/${project.id}/tasks?${queryString}`;

  return client.request<any>('GET', path);
}

export async function listTasks(client: VikunjaApiClient, options: ListTasksOptions): Promise<any> {
  const webUrl = client.getConfig().vikunjaWebUrl;
  const responseMode = selectedResponseMode(client, options.responseMode);
  const effectiveOptions =
    options.label !== undefined
      ? { ...options, label: await resolveLabel(client, options.label) }
      : options;
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

  const results = [];
  for (const proj of projectsToQuery) {
    const rawRes = await listProjectTasksInternal(client, proj, effectiveOptions);
    const pagination = normalizePagination(rawRes);

    if (options.countOnly) {
      results.push({
        project: { id: proj.id, title: proj.title },
        count: pagination.total,
      });
    } else {
      const rawTasks = toItemArray(rawRes);
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

  if (options.project) {
    return results[0];
  } else {
    return { projects: results };
  }
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
): Promise<WriteEcho> {
  if (idempotencyKey) {
    return runDurableOperation(
      'task-create',
      idempotencyKey,
      {
        projectSelector,
        fields,
        attachments,
        actor,
      },
      () => createTask(client, projectSelector, fields, undefined, attachments, actor),
    );
  }

  const project = await resolveProject(client, projectSelector);
  const webUrl = client.getConfig().vikunjaWebUrl;

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

  // Upload any attachments to the new task, then cache the full echo so a
  // retry with the same idempotencyKey never creates a second task.
  await attachToEcho(client, echo, attachments);

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
): Promise<WriteEcho> {
  if (idempotencyKey) {
    return runDurableOperation(
      'task-create-absent',
      idempotencyKey,
      {
        projectSelector,
        fields,
        attachments,
        actor,
      },
      () => createIfAbsent(client, projectSelector, fields, undefined, attachments, actor),
    );
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
    echo = await createTask(client, { id: project.id }, fields, undefined, attachments, actor);
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
): Promise<UpsertEcho> {
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
  );
  return { ...echo, externalKey, actor };
}

export interface ConsolidatedTaskDetails {
  task: Task;
  comments: any[];
  attachments: any[];
  composedCalls: string[];
}

export interface CompactTaskDetails {
  task: CompactTask;
}

export interface StandardTaskDetails {
  task: Task;
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
): Promise<ConsolidatedTaskDetails>;
export function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  commentLimit?: number,
  requestedResponseMode?: ResponseMode,
): Promise<ConsolidatedTaskDetails | StandardTaskDetails | CompactTaskDetails>;
export async function getTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  commentLimit = 5,
  requestedResponseMode?: ResponseMode,
): Promise<ConsolidatedTaskDetails | StandardTaskDetails | CompactTaskDetails> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector, {
    includeRawTask: true,
  });
  const webUrl = client.getConfig().vikunjaWebUrl;
  const responseMode = selectedResponseMode(client, requestedResponseMode);

  const includeBundledDetails = responseMode === 'full';
  const taskPath =
    includeBundledDetails && commentLimit > 0
      ? `/tasks/${taskRef.id}?expand=comments`
      : `/tasks/${taskRef.id}`;
  const rawTask =
    includeBundledDetails && commentLimit > 0
      ? await client.request<any>('GET', taskPath)
      : taskRef.rawTask;

  if (responseMode === 'compact') {
    return { task: normalizeCompactTask(rawTask, taskRef.project, webUrl) };
  }

  const task = normalizeTask(rawTask, taskRef.project, webUrl);

  if (responseMode === 'standard') {
    return { task };
  }

  const composedCalls = [`GET ${taskPath}`];
  let comments: any[] = [];
  let attachments: any[] = [];

  if (commentLimit > 0) {
    // Prefer the comments embedded by expand; fall back to the dedicated
    // endpoint only if this server did not populate them.
    let rawComments: any = rawTask.comments;
    if (!Array.isArray(rawComments)) {
      composedCalls.push(`GET /tasks/${task.id}/comments`);
      rawComments = await client.request<any>('GET', `/tasks/${task.id}/comments`);
    }
    const commentItems = Array.isArray(rawComments) ? rawComments : toItemArray(rawComments);
    comments = normalizeDatesAndNulls(commentItems)
      .map((c: any) => ({
        id: c.id,
        comment: htmlToMarkdown(c.comment),
        author: { id: c.author?.id, username: c.author?.username },
        created: c.created,
      }))
      .sort((a: any, b: any) => String(b.created || '').localeCompare(String(a.created || '')))
      .slice(0, commentLimit);
  }

  composedCalls.push(`GET /tasks/${task.id}/attachments`);
  const rawAttachments = await client.request<any>('GET', `/tasks/${task.id}/attachments`);
  attachments = toItemArray(rawAttachments).map((att: any) => ({
    id: att.id,
    fileName: att.file?.name || att.file_name || 'unknown',
    mime: att.file?.mime || att.mime || 'application/octet-stream',
    fileSize: att.file?.size || att.file_size || 0,
    created: att.created,
  }));

  return {
    task,
    comments,
    attachments,
    composedCalls,
  };
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
): Promise<WriteEcho> {
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
    const htmlDesc = markdownToHtml(fields.description);
    if (htmlDesc !== currentRaw.description) {
      body.description = htmlDesc;
    }
  } else if (fields.appendDescription !== undefined) {
    const currentDescription = currentTask.description ?? '';
    const lines = currentDescription.trimEnd().split('\n');
    const trailingMarker = /^\[vfm-key:[A-Za-z0-9][A-Za-z0-9:_\-./#]{0,119}\]$/.test(
      lines.at(-1)?.trim() ?? '',
    )
      ? lines.pop()!.trim()
      : undefined;
    const existingBody = lines.join('\n').trimEnd();
    const appendedBody = existingBody
      ? `${existingBody}\n\n${fields.appendDescription}`
      : fields.appendDescription;
    const nextDescription = trailingMarker
      ? `${appendedBody.trimEnd()}\n\n${trailingMarker}`
      : appendedBody;
    const htmlDesc = markdownToHtml(nextDescription);
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
): Promise<WriteEcho> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);

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
  };
}

export interface CloseWithEvidenceResult {
  comment: { id: number; author: { id?: number; username?: string }; created?: string };
  task: WriteEcho;
  changed: ('comment' | 'done')[];
  composedCalls: string[];
}

export async function closeWithEvidence(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  evidenceComment: string,
  projectSelector?: { id?: number; title?: string },
  idempotencyKey?: string,
  actor?: string,
): Promise<CloseWithEvidenceResult> {
  const payload = { taskSelector, projectSelector, evidenceComment, actor };
  const execute = async (): Promise<CloseWithEvidenceResult> => {
    const taskRef = await resolveTask(client, taskSelector, projectSelector);
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

    const taskEcho = await updateTask(client, taskRef.id, { done: true });
    if (taskEcho.action !== 'unchanged') composedCalls.push(`PATCH /tasks/${taskRef.id}`);

    return {
      comment: {
        id: comment.id,
        author: comment.author,
        created: comment.created,
      },
      task: taskEcho,
      changed: taskEcho.action === 'unchanged' ? ['comment'] : ['comment', 'done'],
      composedCalls,
    };
  };

  return idempotencyKey
    ? runDurableOperation('close-with-evidence', idempotencyKey, payload, execute)
    : execute();
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
  const exact = items.find((u: any) => u.username.toLowerCase() === selectorStr.toLowerCase());

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
): Promise<WriteEcho> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const userId = await resolveUser(client, userSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };

  if (taskRef.assignees.some((user) => user.id === userId)) {
    return { action: 'unchanged', target };
  }

  await client.request<any>('POST', `/tasks/${taskRef.id}/assignees`, {
    body: { user_id: userId },
  });

  return {
    action: 'updated',
    target,
  };
}

export async function unassignTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  userSelector: string | number,
  projectSelector?: { id?: number; title?: string },
): Promise<WriteEcho> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const userId = await resolveUser(client, userSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };

  if (!taskRef.assignees.some((user) => user.id === userId)) {
    return { action: 'unchanged', target };
  }

  await client.request<any>('DELETE', `/tasks/${taskRef.id}/assignees/${userId}`);

  return {
    action: 'updated',
    target,
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
): Promise<WriteEcho> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
  const numericSelector = typeof labelTitle === 'number' || /^\d+$/.test(String(labelTitle).trim());
  if (
    !numericSelector &&
    taskRef.labels.some((label) => label.title.toLowerCase() === String(labelTitle).toLowerCase())
  ) {
    return { action: 'unchanged', target };
  }
  const labelId = await resolveOrCreateLabel(client, labelTitle);

  if (taskRef.labels.some((label) => label.id === labelId)) {
    return { action: 'unchanged', target };
  }

  await client.request<any>('POST', `/tasks/${taskRef.id}/labels`, {
    body: { label_id: labelId },
  });

  return {
    action: 'updated',
    target,
  };
}

export async function removeLabel(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  labelTitle: string | number,
  projectSelector?: { id?: number; title?: string },
): Promise<WriteEcho> {
  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const target = {
    id: taskRef.id,
    index: taskRef.index,
    identifier: taskRef.identifier,
    project: taskRef.project,
    title: taskRef.title,
  };
  const numericSelector = typeof labelTitle === 'number' || /^\d+$/.test(String(labelTitle).trim());
  const appliedLabel = taskRef.labels.find((label) =>
    numericSelector
      ? label.id === Number(labelTitle)
      : label.title.toLowerCase() === String(labelTitle).toLowerCase(),
  );
  if (!appliedLabel) {
    return { action: 'unchanged', target };
  }

  await client.request<any>('DELETE', `/tasks/${taskRef.id}/labels/${appliedLabel.id}`);

  return {
    action: 'updated',
    target,
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
): Promise<SetStatusResult> {
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

  if (currentStatusLabels.length === 1 && requestedCurrent) {
    return {
      action: 'unchanged',
      target,
      statusLabel: requestedCurrent.title,
      removedStatusLabels: [],
      repaired: false,
    };
  }

  const labelId =
    requestedCurrent?.id ?? (await resolveOrCreateLabel(client, statusLabel, { createIfMissing }));
  const retained = taskRef.labels
    .filter((label) => !label.title.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((label) => ({ id: label.id, title: label.title }));

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

export async function relateTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  otherTaskSelector: TaskSelectorInput,
  relationKind: string,
  projectSelector?: { id?: number; title?: string },
): Promise<WriteEcho> {
  if (!VALID_RELATION_KINDS.includes(relationKind)) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_RELATION_KIND',
      method: 'POST',
      path: `/tasks/${taskSelector}/relations`,
      message: `Invalid relation kind: "${relationKind}". Valid kinds are: ${VALID_RELATION_KINDS.join(', ')}`,
      fieldErrors: [],
    });
  }

  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const otherTaskRef = await resolveTask(
    client,
    otherTaskSelector,
    otherTaskProjectContext(otherTaskSelector, projectSelector),
  );

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
  };
}

export async function unrelateTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  otherTaskSelector: TaskSelectorInput,
  relationKind: string,
  projectSelector?: { id?: number; title?: string },
): Promise<WriteEcho> {
  if (!VALID_RELATION_KINDS.includes(relationKind)) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_RELATION_KIND',
      method: 'DELETE',
      path: `/tasks/${taskSelector}/relations/${relationKind}/${otherTaskSelector}`,
      message: `Invalid relation kind: "${relationKind}". Valid kinds are: ${VALID_RELATION_KINDS.join(', ')}`,
      fieldErrors: [],
    });
  }

  const taskRef = await resolveTask(client, taskSelector, projectSelector);
  const otherTaskRef = await resolveTask(
    client,
    otherTaskSelector,
    otherTaskProjectContext(otherTaskSelector, projectSelector),
  );

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
          task:
            responseMode === 'compact'
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
