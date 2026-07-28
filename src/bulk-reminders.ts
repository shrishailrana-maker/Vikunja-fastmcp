import { createHash } from 'node:crypto';
import { VikunjaApiClient } from './api.js';
import { redactSecrets, VikunjaError } from './errors.js';
import { resolveTaskInput as resolveTask, type TaskSelectorInput } from './identity.js';
import {
  createTask,
  deleteTask,
  patchTaskFields,
  resolveUser,
  updateTask,
  upsertTask,
} from './tasks.js';
import { markdownToHtml } from './markdown.js';
import { durableOperationKey, idempotency, payloadFingerprint } from './idempotency.js';

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
  expectedUpdatedAt?: string;
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

function projectFingerprint(project?: { id?: number; title?: string }): unknown {
  if (!project) return null;
  if (project.id !== undefined) return { id: project.id };
  return { title: project.title?.trim().toLowerCase() };
}

interface BulkOperationContext {
  operationId: string;
  recordKey: string;
  acquired: boolean;
  state: any;
  leaseToken?: string;
}

const BULK_LEASE_MS = 120_000;

function bulkOperation(
  action: string,
  idempotencyKey: string | undefined,
  payload: unknown,
  initialState: Record<string, unknown>,
): BulkOperationContext | null {
  if (!idempotencyKey) return null;
  const fingerprint = payloadFingerprint(payload);
  const keyHash = createHash('sha256').update(idempotencyKey).digest('hex').slice(0, 12);
  const operationId = `${action}-${keyHash}-${fingerprint.slice(0, 12)}`;
  const claimKey = `bulk-claim:${action}:${keyHash}`;
  const existingClaim = idempotency.claim(claimKey, { fingerprint, operationId });
  if (existingClaim && existingClaim.fingerprint !== fingerprint) {
    throw new VikunjaError({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      method: 'TOOLS_CALL',
      path: `vikunja_task_bulk.${action}`,
      message: 'This idempotencyKey was already used with a different bulk payload. Use a new key.',
      fieldErrors: [],
    });
  }
  const recordKey = `bulk-operation:${operationId}`;
  const leased = idempotency.acquireLease(
    recordKey,
    {
      ...initialState,
      operationId,
      status: 'running',
      receipts: [],
    },
    BULK_LEASE_MS,
  );
  return {
    operationId,
    recordKey,
    acquired: leased.acquired,
    state: leased.value,
    leaseToken: leased.leaseToken,
  };
}

function saveBulkOperation(context: BulkOperationContext | null, state: any): void {
  if (context) {
    if (state.status === 'running') {
      state.leaseUntil = Date.now() + BULK_LEASE_MS;
      if (context.leaseToken) {
        idempotency.renewLease(context.recordKey, context.leaseToken, BULK_LEASE_MS);
      }
    }
    idempotency.set(context.recordKey, state);
  }
}

export function getBulkOperationStatus(operationId: string): any {
  const result = idempotency.get(`bulk-operation:${operationId}`);
  if (!result) {
    throw new VikunjaError({
      status: 404,
      code: 'BULK_OPERATION_NOT_FOUND',
      method: 'TOOLS_CALL',
      path: 'vikunja_task_bulk.status',
      message: `No durable bulk operation receipt was found for "${operationId}".`,
      fieldErrors: [],
    });
  }
  return result;
}

function selectorId(selector: TaskSelectorInput): number | null {
  if (typeof selector === 'number') return selector;
  if (typeof selector === 'string' && /^\d+$/.test(selector.trim())) return Number(selector);
  if (typeof selector === 'object' && 'globalId' in selector) return selector.globalId;
  return null;
}

export async function bulkUpdateTasks(
  client: VikunjaApiClient,
  taskSelectors: TaskSelectorInput[],
  fields: BulkTaskFields,
  project?: { id?: number; title?: string },
  idempotencyKey?: string,
  actor?: string,
): Promise<any> {
  const values = apiFields(fields);
  if (taskSelectors.length === 0 || Object.keys(values).length === 0) {
    throw new VikunjaError({
      status: 400,
      code: 'VALIDATION_ERROR',
      method: 'PUT',
      path: '/tasks/bulk',
      message: 'Bulk update requires task selectors and at least one field.',
      fieldErrors: [],
    });
  }
  const payload = {
    project: projectFingerprint(project),
    taskSelectors,
    values,
    actor,
  };
  const legacyNative = taskSelectors.every((selector) => typeof selector !== 'object');
  if (!idempotencyKey || legacyNative) {
    const cacheKey = idempotencyKey
      ? durableOperationKey('bulk-update-legacy', idempotencyKey, payload)
      : '';
    if (cacheKey) {
      const cached = idempotency.get(cacheKey);
      if (cached) return cached;
    }
    const taskIds: number[] = [];
    if (legacyNative && !project) {
      taskIds.push(...taskSelectors.map((selector) => Number(selector)));
    } else {
      for (const selector of taskSelectors) {
        const task = await resolveTask(client, selector, project);
        taskIds.push(task.id);
      }
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
    const result = { requested: taskSelectors.length, updated };
    if (cacheKey) idempotency.set(cacheKey, result);
    return result;
  }

  const operation = bulkOperation('update', idempotencyKey, payload, {
    requested: taskSelectors.length,
    updated: [],
    failed: [],
    actor,
  })!;
  if (!operation.acquired) return operation.state;
  const result = operation.state;
  for (const [index, taskSelector] of taskSelectors.entries()) {
    if (result.receipts.some((receipt: any) => receipt.row === index + 1 && receipt.ok)) continue;
    result.failed = result.failed.filter((failure: any) => failure.row !== index + 1);
    result.receipts = result.receipts.filter((receipt: any) => receipt.row !== index + 1);
    try {
      const echo = await updateTask(client, taskSelector, fields, project);
      const updated = {
        id: echo.target.id,
        portalRef: echo.target.identifier || `#${echo.target.index}`,
        title: echo.target.title,
        action: echo.action,
      };
      if (!result.updated.some((item: any) => item.id === updated.id)) {
        result.updated.push(updated);
      }
      result.receipts.push({ row: index + 1, ok: true, ...updated });
    } catch (error: any) {
      const failure = {
        row: index + 1,
        taskId: selectorId(taskSelector),
        taskSelector,
        error: redactSecrets(
          error?.message || 'Task update failed',
          client.getConfig().vikunjaToken,
        ),
      };
      result.failed.push(failure);
      result.receipts.push({ ...failure, ok: false });
    }
    saveBulkOperation(operation, result);
  }
  result.status = result.failed.length === 0 ? 'completed' : 'partial';
  delete result.leaseUntil;
  saveBulkOperation(operation, result);
  return result;
}

export async function bulkCreateTasks(
  client: VikunjaApiClient,
  project: { id?: number; title?: string },
  tasks: BulkCreateTaskFields[],
  idempotencyKey?: string,
  actor?: string,
): Promise<BulkCreateResult> {
  if (tasks.length === 0 || tasks.length > 100 || tasks.some((task) => !task.title)) {
    throw validationError('Bulk create requires 1-100 tasks, each with a title.');
  }
  const payload = {
    project: projectFingerprint(project),
    tasks,
    actor,
  };
  const operation = bulkOperation('create', idempotencyKey, payload, {
    requested: tasks.length,
    created: [],
    failed: [],
    actor,
  });
  if (operation && !operation.acquired) return operation.state;

  const result: BulkCreateResult & Record<string, any> = operation?.state ?? {
    requested: tasks.length,
    created: [],
    failed: [],
  };
  for (const [index, task] of tasks.entries()) {
    if (operation?.state.receipts.some((receipt: any) => receipt.row === index + 1 && receipt.ok)) {
      continue;
    }
    result.failed = result.failed.filter((failure: any) => failure.row !== index + 1);
    if (operation) {
      result.receipts = result.receipts.filter((receipt: any) => receipt.row !== index + 1);
    }
    try {
      const echo = task.externalKey
        ? await upsertTask(client, project, task, task.externalKey, task.expectedUpdatedAt, actor)
        : await createTask(client, project, task, undefined, undefined, actor);
      const created = {
        id: echo.target.id,
        portalRef: echo.target.identifier || `#${echo.target.index}`,
        title: echo.target.title,
      };
      if (!result.created.some((item: any) => item.id === created.id)) {
        result.created.push(created);
      }
      result.receipts?.push({ row: index + 1, ok: true, action: echo.action, ...created });
    } catch (error: any) {
      const failure = {
        row: index + 1,
        title: task.title,
        error: redactSecrets(
          error?.message || 'Task creation failed',
          client.getConfig().vikunjaToken,
        ),
      };
      result.failed.push(failure);
      result.receipts?.push({ ok: false, ...failure });
    }
    saveBulkOperation(operation, result);
  }
  if (operation) {
    result.status = result.failed.length === 0 ? 'completed' : 'partial';
    result.operationId = operation.operationId;
    delete result.leaseUntil;
    saveBulkOperation(operation, result);
  }
  return result;
}

export interface BulkAssignmentResult {
  requested: number;
  changed: number;
  alreadyCorrect: number;
  failed: { taskId: number | null; taskSelector?: TaskSelectorInput; error: string }[];
  dryRun: boolean;
}

async function bulkChangeAssignee(
  client: VikunjaApiClient,
  taskSelectors: TaskSelectorInput[],
  userSelector: string | number,
  project: { id?: number; title?: string } | undefined,
  dryRun: boolean,
  assign: boolean,
  idempotencyKey?: string,
  actor?: string,
): Promise<BulkAssignmentResult> {
  if (taskSelectors.length === 0 || taskSelectors.length > 100) {
    throw validationError('Bulk assign/unassign requires 1-100 task selectors.');
  }
  const action = assign ? 'assign' : 'unassign';
  const operation = dryRun
    ? null
    : bulkOperation(
        action,
        idempotencyKey,
        {
          project: projectFingerprint(project),
          taskSelectors,
          userSelector,
          actor,
        },
        {
          requested: taskSelectors.length,
          changed: 0,
          alreadyCorrect: 0,
          failed: [],
          dryRun,
          actor,
        },
      );
  if (operation && !operation.acquired) return operation.state;

  const userId = await resolveUser(client, userSelector);
  const result: BulkAssignmentResult & Record<string, any> = operation?.state ?? {
    requested: taskSelectors.length,
    changed: 0,
    alreadyCorrect: 0,
    failed: [],
    dryRun,
  };

  for (const [index, taskSelector] of taskSelectors.entries()) {
    if (operation?.state.receipts.some((receipt: any) => receipt.row === index + 1 && receipt.ok)) {
      continue;
    }
    result.failed = result.failed.filter((failure: any) => failure.row !== index + 1);
    if (operation) {
      result.receipts = result.receipts.filter((receipt: any) => receipt.row !== index + 1);
    }
    try {
      const task = await resolveTask(client, taskSelector, project);
      const isAssigned = task.assignees.some((user) => user.id === userId);
      const alreadyCorrect = assign ? isAssigned : !isAssigned;
      if (alreadyCorrect) {
        result.alreadyCorrect += 1;
        result.receipts?.push({
          row: index + 1,
          ok: true,
          taskId: task.id,
          outcome: 'alreadyCorrect',
        });
        saveBulkOperation(operation, result);
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
      result.receipts?.push({
        row: index + 1,
        ok: true,
        taskId: task.id,
        outcome: dryRun ? 'wouldChange' : 'changed',
      });
    } catch (error: any) {
      const errorMessage = redactSecrets(
        error?.message || 'Assignee update failed',
        client.getConfig().vikunjaToken,
      );
      const failure = operation
        ? {
            row: index + 1,
            taskId: selectorId(taskSelector),
            taskSelector,
            error: errorMessage,
          }
        : { taskId: selectorId(taskSelector), error: errorMessage };
      result.failed.push(failure);
      result.receipts?.push({ ...failure, ok: false });
    }
    saveBulkOperation(operation, result);
  }
  if (operation) {
    result.status = result.failed.length === 0 ? 'completed' : 'partial';
    result.operationId = operation.operationId;
    delete result.leaseUntil;
    saveBulkOperation(operation, result);
  }
  return result;
}

export function bulkAssignTasks(
  client: VikunjaApiClient,
  taskSelectors: TaskSelectorInput[],
  userSelector: string | number,
  project?: { id?: number; title?: string },
  dryRun = false,
  idempotencyKey?: string,
  actor?: string,
): Promise<BulkAssignmentResult> {
  return bulkChangeAssignee(
    client,
    taskSelectors,
    userSelector,
    project,
    dryRun,
    true,
    idempotencyKey,
    actor,
  );
}

export function bulkUnassignTasks(
  client: VikunjaApiClient,
  taskSelectors: TaskSelectorInput[],
  userSelector: string | number,
  project?: { id?: number; title?: string },
  dryRun = false,
  idempotencyKey?: string,
  actor?: string,
): Promise<BulkAssignmentResult> {
  return bulkChangeAssignee(
    client,
    taskSelectors,
    userSelector,
    project,
    dryRun,
    false,
    idempotencyKey,
    actor,
  );
}

export async function bulkDeleteTasks(
  client: VikunjaApiClient,
  taskSelectors: TaskSelectorInput[],
  project?: { id?: number; title?: string },
  idempotencyKey?: string,
  actor?: string,
): Promise<unknown> {
  if (taskSelectors.length === 0 || taskSelectors.length > 100)
    throw validationError('Bulk delete requires 1-100 task selectors.');
  const payload = {
    project: projectFingerprint(project),
    taskSelectors,
    actor,
  };
  const operation = bulkOperation('delete', idempotencyKey, payload, {
    requested: taskSelectors.length,
    deleted: [],
    failed: [],
    actor,
  });
  if (operation && !operation.acquired) return operation.state;
  if (!operation) {
    const deleted = [];
    for (const selector of taskSelectors) {
      deleted.push(await deleteTask(client, selector, project));
    }
    return deleted;
  }

  const result = operation.state;
  for (const [index, taskSelector] of taskSelectors.entries()) {
    if (result.receipts.some((receipt: any) => receipt.row === index + 1 && receipt.ok)) continue;
    result.failed = result.failed.filter((failure: any) => failure.row !== index + 1);
    result.receipts = result.receipts.filter((receipt: any) => receipt.row !== index + 1);
    try {
      const echo = await deleteTask(client, taskSelector, project);
      const deleted = {
        id: echo.target.id,
        portalRef: echo.target.identifier || `#${echo.target.index}`,
        title: echo.target.title,
      };
      result.deleted.push(deleted);
      result.receipts.push({ row: index + 1, ok: true, ...deleted });
    } catch (error: any) {
      const failure = {
        row: index + 1,
        taskId: selectorId(taskSelector),
        taskSelector,
        error: redactSecrets(
          error?.message || 'Task deletion failed',
          client.getConfig().vikunjaToken,
        ),
      };
      result.failed.push(failure);
      result.receipts.push({ ...failure, ok: false });
    }
    saveBulkOperation(operation, result);
  }
  result.status = result.failed.length === 0 ? 'completed' : 'partial';
  delete result.leaseUntil;
  saveBulkOperation(operation, result);
  return result;
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
  selector: TaskSelectorInput,
  project?: { id?: number; title?: string },
) {
  const task = await resolveTask(client, selector, project);
  const raw = await client.request<any>('GET', `/tasks/${task.id}`);
  return { task, raw, reminders: Array.isArray(raw.reminders) ? raw.reminders : [] };
}

export async function listTaskReminders(
  client: VikunjaApiClient,
  selector: TaskSelectorInput,
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
  selector: TaskSelectorInput,
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
  selector: TaskSelectorInput,
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
