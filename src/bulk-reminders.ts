import { VikunjaApiClient } from './api.js';
import { VikunjaError } from './errors.js';
import { resolveTask } from './identity.js';
import { createTask, deleteTask, patchTaskFields } from './tasks.js';
import { markdownToHtml } from './markdown.js';

export interface BulkTaskFields {
  title?: string;
  description?: string;
  done?: boolean;
  priority?: number;
  dueDate?: string | null;
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

export async function bulkUpdateTasks(
  client: VikunjaApiClient,
  taskIds: number[],
  fields: BulkTaskFields,
  project?: { id?: number; title?: string },
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
  return {
    requested: taskIds.length,
    updated,
  };
}

export async function bulkCreateTasks(
  client: VikunjaApiClient,
  project: { id?: number; title?: string },
  tasks: BulkTaskFields[],
): Promise<unknown[]> {
  if (tasks.length === 0 || tasks.length > 100 || tasks.some((task) => !task.title)) {
    throw validationError('Bulk create requires 1-100 tasks, each with a title.');
  }
  const created = [];
  for (const task of tasks) {
    created.push(await createTask(client, project, task as BulkTaskFields & { title: string }));
  }
  return created;
}

export async function bulkDeleteTasks(
  client: VikunjaApiClient,
  taskIds: number[],
  project?: { id?: number; title?: string },
): Promise<unknown[]> {
  if (taskIds.length === 0 || taskIds.length > 100)
    throw validationError('Bulk delete requires 1-100 task IDs.');
  const deleted = [];
  for (const id of taskIds) deleted.push(await deleteTask(client, id, project));
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
