import { createHash } from 'node:crypto';
import { VikunjaApiClient } from './api.js';
import { redactSecrets, VikunjaError } from './errors.js';
import { resolveTaskInput as resolveTask, type TaskSelectorInput } from './identity.js';
import {
  createTask,
  closeWithEvidence,
  deleteTask,
  applyLabel,
  patchTaskFields,
  removeLabel,
  resolveUser,
  setTaskStatus,
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

type BulkRowState = 'changed' | 'unchanged' | 'skipped' | 'failed';

function bulkRowReceipt(
  row: number,
  state: BulkRowState,
  details: Record<string, unknown>,
  previous?: any,
) {
  const receipt = {
    row,
    ok: state !== 'failed',
    state,
    selected: true,
    changed: state === 'changed',
    unchanged: state === 'unchanged',
    skipped: false,
    failed: state === 'failed',
    retryCount: previous ? Number(previous.retryCount ?? 0) + 1 : 0,
    ...details,
  };
  return { ...receipt, resultHash: payloadFingerprint(receipt) };
}

function retryableBulkError(error: any): boolean {
  const status = Number(error?.status ?? error?.error?.status);
  if (!Number.isFinite(status)) return true;
  return status === 408 || status === 429 || status >= 500;
}

function skipRecordedRow(state: any, row: number): boolean {
  const receipt = state.receipts?.find((candidate: any) => candidate.row === row);
  if (!receipt) return false;
  const reason = receipt.ok
    ? 'already-complete'
    : receipt.retryable === false
      ? 'non-retryable'
      : null;
  if (!reason) return false;
  receipt.skipped = true;
  receipt.skipReason = reason;
  return true;
}

function bulkSummary(state: any) {
  const receipts = Array.isArray(state.receipts) ? state.receipts : [];
  const receiptState = (receipt: any): BulkRowState => {
    if (receipt.state) return receipt.state;
    if (receipt.ok === false) return 'failed';
    if (receipt.outcome === 'alreadyCorrect' || receipt.action === 'unchanged') return 'unchanged';
    return 'changed';
  };
  const count = (name: BulkRowState) => {
    if (name === 'skipped')
      return receipts.filter((receipt: any) => receipt.skipped === true).length;
    if (name === 'failed') return receipts.filter((receipt: any) => receipt.ok === false).length;
    return receipts.filter((receipt: any) => receiptState(receipt) === name).length;
  };
  return {
    operationId: state.operationId,
    status: state.status,
    requested: state.requested,
    selected: state.requested,
    changed: count('changed'),
    unchanged: count('unchanged'),
    skipped: count('skipped'),
    failed: count('failed'),
    actor: state.actor,
  };
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

function reusedBulkSummary(context: BulkOperationContext): any {
  const responseState = structuredClone(context.state);
  for (const receipt of responseState.receipts ?? []) {
    skipRecordedRow(responseState, receipt.row);
  }
  return bulkSummary(responseState);
}

export function getBulkOperationStatus(
  operationId: string,
  cursor?: string,
  perPage = 50,
  countOnly = false,
): any {
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
  const receipts = Array.isArray(result.receipts)
    ? [...result.receipts].sort((left: any, right: any) => left.row - right.row)
    : [];
  const offset = cursor === undefined ? 0 : Number(cursor);
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw validationError('cursor must be a non-negative integer string.');
  const safePerPage = Math.min(100, Math.max(1, perPage));
  if (countOnly) {
    return {
      ...bulkSummary(result),
      receipts: [],
      returnedCount: 0,
      totalCount: receipts.length,
      nextCursor: null,
      incomplete: false,
    };
  }
  const page = receipts.slice(offset, offset + safePerPage);
  const nextOffset = offset + page.length;
  return {
    ...bulkSummary(result),
    receipts: page,
    returnedCount: page.length,
    totalCount: receipts.length,
    nextCursor: nextOffset < receipts.length ? String(nextOffset) : null,
    incomplete: nextOffset < receipts.length,
  };
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
  dryRun = false,
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
  if (dryRun) {
    const receipts = [];
    for (const [index, taskSelector] of taskSelectors.entries()) {
      try {
        const echo = await updateTask(client, taskSelector, fields, project, undefined, true);
        receipts.push(
          bulkRowReceipt(index + 1, echo.action === 'unchanged' ? 'unchanged' : 'changed', {
            action: echo.action,
            finalIdentity: echo.target,
          }),
        );
      } catch (error: any) {
        receipts.push(
          bulkRowReceipt(index + 1, 'failed', {
            taskSelector,
            error: redactSecrets(
              error?.message || 'Task update preview failed',
              client.getConfig().vikunjaToken,
            ),
          }),
        );
      }
    }
    return {
      ...bulkSummary({ requested: taskSelectors.length, status: 'preview', receipts, actor }),
      dryRun: true,
    };
  }
  const legacyNative = taskSelectors.every((selector) => typeof selector !== 'object');
  if (!idempotencyKey) {
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
  if (!operation.acquired) return reusedBulkSummary(operation);
  const result = operation.state;
  for (const [index, taskSelector] of taskSelectors.entries()) {
    if (skipRecordedRow(result, index + 1)) {
      saveBulkOperation(operation, result);
      continue;
    }
    const previous = result.receipts.find((receipt: any) => receipt.row === index + 1);
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
      result.receipts.push(
        bulkRowReceipt(
          index + 1,
          echo.action === 'unchanged' ? 'unchanged' : 'changed',
          { action: echo.action, finalIdentity: updated },
          previous,
        ),
      );
    } catch (error: any) {
      const failure = {
        row: index + 1,
        taskId: selectorId(taskSelector),
        taskSelector,
        error: redactSecrets(
          error?.message || 'Task update failed',
          client.getConfig().vikunjaToken,
        ),
        retryable: retryableBulkError(error),
      };
      result.failed.push(failure);
      result.receipts.push(bulkRowReceipt(index + 1, 'failed', failure, previous));
    }
    saveBulkOperation(operation, result);
  }
  result.status = result.failed.length === 0 ? 'completed' : 'partial';
  delete result.leaseUntil;
  saveBulkOperation(operation, result);
  return bulkSummary(result);
}

export async function bulkCreateTasks(
  client: VikunjaApiClient,
  project: { id?: number; title?: string },
  tasks: BulkCreateTaskFields[],
  idempotencyKey?: string,
  actor?: string,
  dryRun = false,
): Promise<any> {
  if (tasks.length === 0 || tasks.length > 100 || tasks.some((task) => !task.title)) {
    throw validationError('Bulk create requires 1-100 tasks, each with a title.');
  }
  const payload = {
    project: projectFingerprint(project),
    tasks,
    actor,
  };
  if (dryRun) {
    const receipts = [];
    for (const [index, task] of tasks.entries()) {
      try {
        const echo = task.externalKey
          ? await upsertTask(
              client,
              project,
              task,
              task.externalKey,
              task.expectedUpdatedAt,
              actor,
              true,
            )
          : await createTask(client, project, task, undefined, undefined, actor, true);
        receipts.push(
          bulkRowReceipt(index + 1, echo.action === 'unchanged' ? 'unchanged' : 'changed', {
            action: echo.action,
            finalIdentity: echo.target,
          }),
        );
      } catch (error: any) {
        receipts.push(
          bulkRowReceipt(index + 1, 'failed', {
            title: task.title,
            error: redactSecrets(
              error?.message || 'Task create preview failed',
              client.getConfig().vikunjaToken,
            ),
          }),
        );
      }
    }
    return {
      ...bulkSummary({ requested: tasks.length, status: 'preview', receipts, actor }),
      dryRun: true,
    };
  }
  const operation = bulkOperation('create', idempotencyKey, payload, {
    requested: tasks.length,
    created: [],
    failed: [],
    actor,
  });
  if (operation && !operation.acquired) return reusedBulkSummary(operation) as any;

  const result: BulkCreateResult & Record<string, any> = operation?.state ?? {
    requested: tasks.length,
    created: [],
    failed: [],
  };
  for (const [index, task] of tasks.entries()) {
    if (operation && skipRecordedRow(operation.state, index + 1)) {
      saveBulkOperation(operation, operation.state);
      continue;
    }
    const previous = operation?.state.receipts.find((receipt: any) => receipt.row === index + 1);
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
      result.receipts?.push(
        bulkRowReceipt(
          index + 1,
          echo.action === 'exists' || echo.action === 'unchanged' ? 'unchanged' : 'changed',
          { action: echo.action, finalIdentity: created },
          previous,
        ),
      );
    } catch (error: any) {
      const failure = {
        row: index + 1,
        title: task.title,
        error: redactSecrets(
          error?.message || 'Task creation failed',
          client.getConfig().vikunjaToken,
        ),
        ...(operation ? { retryable: retryableBulkError(error) } : {}),
      };
      result.failed.push(failure);
      result.receipts?.push(bulkRowReceipt(index + 1, 'failed', failure, previous));
    }
    saveBulkOperation(operation, result);
  }
  if (operation) {
    result.status = result.failed.length === 0 ? 'completed' : 'partial';
    result.operationId = operation.operationId;
    delete result.leaseUntil;
    saveBulkOperation(operation, result);
  }
  return operation ? (bulkSummary(result) as any) : result;
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
): Promise<any> {
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
  if (operation && !operation.acquired) return reusedBulkSummary(operation);

  const userId = await resolveUser(client, userSelector);
  const result: BulkAssignmentResult & Record<string, any> = operation?.state ?? {
    requested: taskSelectors.length,
    changed: 0,
    alreadyCorrect: 0,
    failed: [],
    dryRun,
  };

  for (const [index, taskSelector] of taskSelectors.entries()) {
    if (operation && skipRecordedRow(operation.state, index + 1)) {
      saveBulkOperation(operation, operation.state);
      continue;
    }
    const previous = operation?.state.receipts.find((receipt: any) => receipt.row === index + 1);
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
        result.receipts?.push(
          bulkRowReceipt(
            index + 1,
            'unchanged',
            {
              outcome: 'alreadyCorrect',
              finalIdentity: {
                id: task.id,
                portalRef: task.identifier || `#${task.index}`,
                title: task.title,
              },
            },
            previous,
          ),
        );
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
      result.receipts?.push(
        bulkRowReceipt(
          index + 1,
          'changed',
          {
            outcome: dryRun ? 'wouldChange' : 'changed',
            finalIdentity: {
              id: task.id,
              portalRef: task.identifier || `#${task.index}`,
              title: task.title,
            },
          },
          previous,
        ),
      );
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
            retryable: retryableBulkError(error),
          }
        : { taskId: selectorId(taskSelector), error: errorMessage };
      result.failed.push(failure);
      result.receipts?.push(bulkRowReceipt(index + 1, 'failed', failure, previous));
    }
    saveBulkOperation(operation, result);
  }
  if (operation) {
    result.status = result.failed.length === 0 ? 'completed' : 'partial';
    result.operationId = operation.operationId;
    delete result.leaseUntil;
    saveBulkOperation(operation, result);
  }
  return operation ? bulkSummary(result) : result;
}

export function bulkAssignTasks(
  client: VikunjaApiClient,
  taskSelectors: TaskSelectorInput[],
  userSelector: string | number,
  project?: { id?: number; title?: string },
  dryRun = false,
  idempotencyKey?: string,
  actor?: string,
): Promise<any> {
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
): Promise<any> {
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
  dryRun = false,
): Promise<unknown> {
  if (taskSelectors.length === 0 || taskSelectors.length > 100)
    throw validationError('Bulk delete requires 1-100 task selectors.');
  const payload = {
    project: projectFingerprint(project),
    taskSelectors,
    actor,
  };
  if (dryRun) {
    const receipts = [];
    for (const [index, taskSelector] of taskSelectors.entries()) {
      try {
        const echo = await deleteTask(client, taskSelector, project, true);
        receipts.push(
          bulkRowReceipt(index + 1, 'changed', { action: echo.action, finalIdentity: echo.target }),
        );
      } catch (error: any) {
        receipts.push(
          bulkRowReceipt(index + 1, 'failed', {
            taskSelector,
            error: redactSecrets(
              error?.message || 'Task delete preview failed',
              client.getConfig().vikunjaToken,
            ),
          }),
        );
      }
    }
    return {
      ...bulkSummary({ requested: taskSelectors.length, status: 'preview', receipts, actor }),
      dryRun: true,
    };
  }
  const operation = bulkOperation('delete', idempotencyKey, payload, {
    requested: taskSelectors.length,
    deleted: [],
    failed: [],
    actor,
  });
  if (operation && !operation.acquired) return reusedBulkSummary(operation);
  if (!operation) {
    const deleted = [];
    for (const selector of taskSelectors) {
      deleted.push(await deleteTask(client, selector, project));
    }
    return deleted;
  }

  const result = operation.state;
  for (const [index, taskSelector] of taskSelectors.entries()) {
    if (skipRecordedRow(result, index + 1)) {
      saveBulkOperation(operation, result);
      continue;
    }
    const previous = result.receipts.find((receipt: any) => receipt.row === index + 1);
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
      result.receipts.push(
        bulkRowReceipt(index + 1, 'changed', { finalIdentity: deleted }, previous),
      );
    } catch (error: any) {
      const failure = {
        row: index + 1,
        taskId: selectorId(taskSelector),
        taskSelector,
        error: redactSecrets(
          error?.message || 'Task deletion failed',
          client.getConfig().vikunjaToken,
        ),
        retryable: retryableBulkError(error),
      };
      result.failed.push(failure);
      result.receipts.push(bulkRowReceipt(index + 1, 'failed', failure, previous));
    }
    saveBulkOperation(operation, result);
  }
  result.status = result.failed.length === 0 ? 'completed' : 'partial';
  delete result.leaseUntil;
  saveBulkOperation(operation, result);
  return bulkSummary(result);
}

export type BulkWorkflowAction =
  'set_status' | 'apply-label' | 'remove-label' | 'close_with_evidence';

export interface BulkWorkflowOptions {
  statusLabel?: string;
  labelTitle?: string | number;
  evidenceComment?: string;
  createIfMissing?: boolean;
  dryRun?: boolean;
  idempotencyKey?: string;
  actor?: string;
}

export async function bulkWorkflowTasks(
  client: VikunjaApiClient,
  action: BulkWorkflowAction,
  taskSelectors: TaskSelectorInput[],
  project: { id?: number; title?: string },
  options: BulkWorkflowOptions,
): Promise<any> {
  if (taskSelectors.length === 0 || taskSelectors.length > 100) {
    throw validationError('Bulk workflow requires 1-100 task selectors.');
  }
  if (action === 'set_status' && !options.statusLabel) {
    throw validationError('statusLabel is required for bulk set_status.');
  }
  if ((action === 'apply-label' || action === 'remove-label') && !options.labelTitle) {
    throw validationError('labelTitle is required for bulk label changes.');
  }
  if (action === 'close_with_evidence' && !options.evidenceComment) {
    throw validationError('evidenceComment is required for bulk close_with_evidence.');
  }
  const payload = {
    project: projectFingerprint(project),
    taskSelectors,
    action,
    statusLabel: options.statusLabel,
    labelTitle: options.labelTitle,
    evidenceComment: options.evidenceComment,
    createIfMissing: options.createIfMissing,
    actor: options.actor,
  };
  const operation = options.dryRun
    ? null
    : bulkOperation(action, options.idempotencyKey, payload, {
        requested: taskSelectors.length,
        actor: options.actor,
        failed: [],
      });
  if (operation && !operation.acquired) return reusedBulkSummary(operation);
  const state: any = operation?.state ?? {
    requested: taskSelectors.length,
    status: 'preview',
    actor: options.actor,
    receipts: [],
  };

  for (const [index, taskSelector] of taskSelectors.entries()) {
    const row = index + 1;
    if (operation && skipRecordedRow(state, row)) {
      saveBulkOperation(operation, state);
      continue;
    }
    const previous = state.receipts.find((receipt: any) => receipt.row === row);
    state.receipts = state.receipts.filter((receipt: any) => receipt.row !== row);
    try {
      let echo: any;
      if (action === 'set_status') {
        echo = await setTaskStatus(
          client,
          taskSelector,
          options.statusLabel!,
          project,
          options.createIfMissing ?? false,
          options.dryRun ?? false,
        );
      } else if (action === 'apply-label') {
        echo = await applyLabel(
          client,
          taskSelector,
          options.labelTitle!,
          project,
          options.dryRun ?? false,
        );
      } else if (action === 'remove-label') {
        echo = await removeLabel(
          client,
          taskSelector,
          options.labelTitle!,
          project,
          options.dryRun ?? false,
        );
      } else {
        echo = await closeWithEvidence(
          client,
          taskSelector,
          options.evidenceComment!,
          project,
          options.dryRun ? undefined : `${options.idempotencyKey}:row:${row}`,
          options.actor,
          options.dryRun ?? false,
        );
      }
      const target = echo.target ?? echo.task?.target;
      const partial = echo.outcome === 'partial' || echo.action === 'partial';
      state.receipts.push(
        bulkRowReceipt(
          row,
          partial ? 'failed' : echo.action === 'unchanged' ? 'unchanged' : 'changed',
          {
            action: echo.action ?? echo.task?.action,
            finalIdentity: target,
            ...(partial
              ? {
                  error: echo.error?.message ?? 'Workflow partially completed',
                  retryable: echo.error?.retryable ?? retryableBulkError(echo.error),
                }
              : {}),
          },
          previous,
        ),
      );
    } catch (error: any) {
      state.receipts.push(
        bulkRowReceipt(
          row,
          'failed',
          {
            taskSelector,
            error: redactSecrets(
              error?.message || 'Bulk workflow row failed',
              client.getConfig().vikunjaToken,
            ),
            retryable: retryableBulkError(error),
          },
          previous,
        ),
      );
    }
    saveBulkOperation(operation, state);
  }
  state.status = options.dryRun
    ? 'preview'
    : state.receipts.some((receipt: any) => receipt.state === 'failed')
      ? 'partial'
      : 'completed';
  if (operation) {
    state.operationId = operation.operationId;
    delete state.leaseUntil;
    saveBulkOperation(operation, state);
  }
  return { ...bulkSummary(state), dryRun: options.dryRun ?? false };
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
