import { createHash } from 'node:crypto';
import { VikunjaApiClient } from './api.js';
import { redactSecrets, VikunjaError } from './errors.js';
import { resolveTask } from './identity.js';
import { createTask, deleteTask, patchTaskFields, resolveUser, upsertTask } from './tasks.js';
import { markdownToHtml } from './markdown.js';
import { idempotency } from './idempotency.js';

export interface BulkTaskFields {
  title?: string;
  description?: string;
  done?: boolean;
  priority?: number;
  dueDate?: string | null;
}

export interface BulkCreateTaskFields extends BulkTaskFields {
  title: string;
  externalKey?: string;
}

export interface BulkCreateResult {
  requested: number;
  created: { id: number; portalRef: string; title: string }[];
  failed: { row: number; title: string; error: string }[];
}

export interface TaskReminderInput {
  reminder?: string;
  relativePeriod?: number;
  relativeTo?: string;
}

function validationError(message: string): VikunjaError {
  return new VikunjaError({
    status: 400,
    code: 'VALIDATION_ERROR',
    method: 'TOOLS_CALL',
    path: 'arguments',
    message,
    fieldErrors: [],
  });
}

function apiFields(fields: BulkTaskFields): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  if (fields.title !== undefined) values.title = fields.title;
  if (fields.description !== undefined) values.description = markdownToHtml(fields.description);
  if (fields.done !== undefined) values.done = fields.done;
  if (fields.priority !== undefined) values.priority = fields.priority;
  if (fields.dueDate !== undefined) values.due_date = fields.dueDate;
  return values;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function projectFingerprint(project?: { id?: number; title?: string }): unknown {
  if (!project) return null;
  if (project.id !== undefined) return { id: project.id };
  return { title: project.title?.trim().toLowerCase() };
}

function bulkCacheKey(
  action: string,
  idempotencyKey: string | undefined,
  payload: unknown,
): string {
  if (!idempotencyKey) return '';
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
  return `bulk-${action}:${idempotencyKey}:${fingerprint}`;
}

export async function bulkUpdateTasks(
  client: VikunjaApiClient,
  taskIds: number[],
  fields: BulkTaskFields,
  project?: { id?: number; title?: string },
  idempotencyKey?: string,
): Promise<{ requested: number; updated: unknown[] }> {
  const values = apiFields(fields);
  if (taskIds.length === 0 || Object.keys(values).length === 0) {
    throw new VikunjaError({
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'PUT',
      path: '/tasks/bulk',
      message: 'Bulk update requires taskIds and at least one field.',
      fieldErrors: [],
    });
  }
  const cacheKey = bulkCacheKey('update', idempotencyKey, {
    project: projectFingerprint(project),
    taskIds,
    values,
  });
  if (cacheKey) {
    const cached = idempotency.get(cacheKey);
    if (cached) return cached;
  }
  if (project) {
    for (const taskId of taskIds) await resolveTask(client, taskId, project);
  }
  const response = await client.request<any>('PUT', '/tasks/bulk', {
    body: { task_ids: taskIds, fields: Object.keys(values), values },
  });
  const updated = Array.isArray(response.tasks)
    ? response.tasks.map((task: any) => ({
        id: task.id,
        index: task.index,
        identifier: task.identifier || `#${task.index}`,
        projectId: task.project_id,
        title: task.title,
        done: !!task.done,
        priority: task.priority || 0,
        dueDate:
          !task.due_date || String(task.due_date).startsWith('0001-01-01') ? null : task.due_date,
      }))
    : [];
  const result = {
    requested: taskIds.length,
    updated,
  };
  if (cacheKey) idempotency.set(cacheKey, result);
  return result;
}

export async function bulkCreateTasks(
  client: VikunjaApiClient,
  project: { id?: number; title?: string },
  tasks: BulkCreateTaskFields[],
  idempotencyKey?: string,
): Promise<BulkCreateResult> {
  if (tasks.length === 0 || tasks.length > 100 || tasks.some((task) => !task.title)) {
    throw validationError('Bulk create requires 1-100 tasks, each with a title.');
  }
  const cacheKey = bulkCacheKey('create', idempotencyKey, {
    project: projectFingerprint(project),
    tasks,
  });
  if (cacheKey) {
    const cached = idempotency.get(cacheKey);
    if (cached) return cached;
  }

  const result: BulkCreateResult = {
    requested: tasks.length,
    created: [],
    failed: [],
  };
  for (const [index, task] of tasks.entries()) {
    try {
      const echo = task.externalKey
        ? await upsertTask(client, project, task, task.externalKey)
        : await createTask(client, project, task);
      result.created.push({
        id: echo.target.id,
        portalRef: echo.target.identifier || `#${echo.target.index}`,
        title: echo.target.title,
      });
    } catch (error: any) {
      result.failed.push({
        row: index + 1,
        title: task.title,
        error: redactSecrets(
          error?.message || 'Task creation failed',
          client.getConfig().vikunjaToken,
        ),
      });
    }
  }
  if (cacheKey) {
    idempotency.set(cacheKey, result);
  }
  return result;
}

export interface BulkAssignmentResult {
  requested: number;
  changed: number;
  alreadyCorrect: number;
  failed: { taskId: number; error: string }[];
  dryRun: boolean;
}

async function bulkChangeAssignee(
  client: VikunjaApiClient,
  taskIds: number[],
  userSelector: string | number,
  project: { id?: number; title?: string } | undefined,
  dryRun: boolean,
  assign: boolean,
  idempotencyKey?: string,
): Promise<BulkAssignmentResult> {
  if (taskIds.length === 0 || taskIds.length > 100) {
    throw validationError('Bulk assign/unassign requires 1-100 task IDs.');
  }
  const cacheKey = dryRun
    ? ''
    : bulkCacheKey(assign ? 'assign' : 'unassign', idempotencyKey, {
        project: projectFingerprint(project),
        taskIds,
        userSelector,
      });
  if (cacheKey) {
    const cached = idempotency.get(cacheKey);
    if (cached) return cached;
  }
  const userId = await resolveUser(client, userSelector);
  const result: BulkAssignmentResult = {
    requested: taskIds.length,
    changed: 0,
    alreadyCorrect: 0,
    failed: [],
    dryRun,
  };

  for (const taskId of taskIds) {
    try {
      const task = await resolveTask(client, taskId, project);
      const isAssigned = task.assignees.some((user) => user.id === userId);
      const alreadyCorrect = assign ? isAssigned : !isAssigned;
      if (alreadyCorrect) {
        result.alreadyCorrect += 1;
        continue;
      }
      if (dryRun) {
        result.changed += 1;
      } else {
        if (assign) {
          await client.request('POST', `/tasks/${task.id}/assignees`, {
            body: { user_id: userId },
          });
        } else {
          await client.request('DELETE', `/tasks/${task.id}/assignees/${userId}`);
        }
        result.changed += 1;
      }
    } catch (error: any) {
      result.failed.push({
        taskId,
        error: redactSecrets(
          error?.message || 'Assignee update failed',
          client.getConfig().vikunjaToken,
        ),
      });
    }
  }
  if (cacheKey) idempotency.set(cacheKey, result);
  return result;
}

export function bulkAssignTasks(
  client: VikunjaApiClient,
  taskIds: number[],
  userSelector: string | number,
  project?: { id?: number; title?: string },
  dryRun = false,
  idempotencyKey?: string,
): Promise<BulkAssignmentResult> {
  return bulkChangeAssignee(client, taskIds, userSelector, project, dryRun, true, idempotencyKey);
}

export function bulkUnassignTasks(
  client: VikunjaApiClient,
  taskIds: number[],
  userSelector: string | number,
  project?: { id?: number; title?: string },
  dryRun = false,
  idempotencyKey?: string,
): Promise<BulkAssignmentResult> {
  return bulkChangeAssignee(client, taskIds, userSelector, project, dryRun, false, idempotencyKey);
}

export async function bulkDeleteTasks(
  client: VikunjaApiClient,
  taskIds: number[],
  project?: { id?: number; title?: string },
  idempotencyKey?: string,
): Promise<unknown[]> {
  if (taskIds.length === 0 || taskIds.length > 100)
    throw validationError('Bulk delete requires 1-100 task IDs.');
  const cacheKey = bulkCacheKey('delete', idempotencyKey, {
    project: projectFingerprint(project),
    taskIds,
  });
  if (cacheKey) {
    const cached = idempotency.get(cacheKey);
    if (cached) return cached;
  }
  const deleted = [];
  for (const id of taskIds) deleted.push(await deleteTask(client, id, project));
  if (cacheKey) idempotency.set(cacheKey, deleted);
  return deleted;
}

function normalizeReminder(reminder: any) {
  return {
    reminder: reminder.reminder || null,
    relativePeriod: reminder.relative_period ?? null,
    relativeTo: reminder.relative_to ?? null,
  };
}

async function reminderState(
  client: VikunjaApiClient,
  selector: string | number,
  project?: { id?: number; title?: string },
) {
  const task = await resolveTask(client, selector, project);
  const raw = await client.request<any>('GET', `/tasks/${task.id}`);
  return { task, raw, reminders: Array.isArray(raw.reminders) ? raw.reminders : [] };
}

export async function listTaskReminders(
  client: VikunjaApiClient,
  selector: string | number,
  project?: { id?: number; title?: string },
) {
  const { reminders } = await reminderState(client, selector, project);
  return reminders.map(normalizeReminder);
}

async function replaceReminders(client: VikunjaApiClient, taskId: number, reminders: any[]) {
  await patchTaskFields(client, taskId, [{ op: 'replace', path: '/reminders', value: reminders }]);
  return reminders.map(normalizeReminder);
}

export async function addTaskReminder(
  client: VikunjaApiClient,
  selector: string | number,
  reminder: TaskReminderInput,
  project?: { id?: number; title?: string },
) {
  if (!reminder.reminder && reminder.relativePeriod === undefined)
    throw validationError('Provide an absolute reminder or relativePeriod.');
  const state = await reminderState(client, selector, project);
  const raw = {
    ...(reminder.reminder ? { reminder: reminder.reminder } : {}),
    ...(reminder.relativePeriod !== undefined ? { relative_period: reminder.relativePeriod } : {}),
    ...(reminder.relativeTo ? { relative_to: reminder.relativeTo } : {}),
  };
  return replaceReminders(client, state.task.id, [...state.reminders, raw]);
}

export async function removeTaskReminder(
  client: VikunjaApiClient,
  selector: string | number,
  index: number,
  project?: { id?: number; title?: string },
) {
  const state = await reminderState(client, selector, project);
  if (!Number.isInteger(index) || index < 0 || index >= state.reminders.length)
    throw validationError('reminderIndex is out of range.');
  return replaceReminders(
    client,
    state.task.id,
    state.reminders.filter((_reminder: unknown, current: number) => current !== index),
  );
}
