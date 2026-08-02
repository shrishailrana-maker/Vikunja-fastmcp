/** Small typed task tool schemas that delegate to the canonical task engine. */

import { z } from 'zod';
import type { VikunjaApiClient } from './api.js';
import { EXTERNAL_KEY_PATTERN, TASK_READ_FIELDS } from './tasks.js';

type TaskDispatcher = (args: any, client: VikunjaApiClient) => Promise<any>;

export interface TypedTaskToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: TaskDispatcher;
}

const responseModeSchema = z.enum(['minimal', 'receipt', 'compact', 'standard', 'full']).optional();
const projectSelectorSchema = z
  .object({
    id: z.number().int().positive().optional(),
    title: z.string().trim().min(1).optional(),
  })
  .strict();
const taskSelectorSchema = z.union([
  z.object({ globalId: z.number().int().positive() }).strict(),
  z.object({ identifier: z.string().trim().regex(/^.+-\d+$/) }).strict(),
  z.object({ projectIndex: z.number().int().positive() }).strict(),
]);
const actorSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} ._-]+$/u, 'actor contains unsupported characters')
  .optional();
const taskFieldsSchema = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  appendDescription: z.string().optional(),
  done: z.boolean().optional(),
  priority: z.number().int().min(0).max(5).optional(),
  dueDate: z.string().nullable().optional(),
});

export function createTypedTaskTools(dispatch: TaskDispatcher): TypedTaskToolDefinition[] {
  return [
    {
      name: 'vikunja_task_read',
      description: 'Read, list, count, search, or summarize Vikunja tasks with bounded output.',
      inputSchema: z.object({
        action: z.enum([
          'get',
          'list',
          'summary',
          'batch_get',
          'verify_task_state',
          'programme_snapshot',
          'task_dedupe',
          'lookup_external_key',
          'receipt_lookup',
        ]),
        taskSelector: taskSelectorSchema.optional(),
        projectSelector: projectSelectorSchema.optional(),
        projects: z.array(projectSelectorSchema).optional(),
        allProjects: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        perPage: z.number().int().min(1).max(1000).optional(),
        commentLimit: z.number().int().min(0).max(100).optional(),
        done: z.boolean().optional(),
        allStates: z.boolean().optional(),
        priority: z.number().int().min(0).max(5).optional(),
        label: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
        assignee: z.string().trim().min(1).optional(),
        descriptionContains: z.string().optional(),
        titleContains: z.string().optional(),
        changedSince: z.string().datetime().optional(),
        actor: actorSchema,
        q: z.string().optional(),
        search: z.string().optional(),
        searchIn: z.enum(['all', 'title', 'description']).optional(),
        countOnly: z.boolean().optional(),
        filter: z.string().optional(),
        responseMode: responseModeSchema,
        fields: z.array(z.enum(TASK_READ_FIELDS)).min(1).optional(),
        includeUrl: z.boolean().optional(),
        titleMaxChars: z.number().int().min(8).max(500).optional(),
        maxResponseChars: z.number().int().min(500).max(100_000).optional(),
        cursor: z.string().min(1).optional(),
        identifiers: z.array(z.string().trim().regex(/^.+-\d+$/)).min(1).max(100).optional(),
        staleDays: z.number().int().min(1).max(3650).optional(),
        changedLimit: z.number().int().min(1).max(100).optional(),
        preset: z.enum(['programme', 'mpf']).optional(),
        title: z.string().trim().min(1).optional(),
        externalKey: z.string().regex(EXTERNAL_KEY_PATTERN).optional(),
        operation: z
          .enum([
            'task-create',
            'task-create-absent',
            'close-with-evidence',
            'comment-create',
            'attachment-upload',
            'attachment-delete',
          ])
          .optional(),
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
      }),
      handler: dispatch,
    },
    {
      name: 'vikunja_task_write',
      description: 'Create, upsert, update, or delete Vikunja tasks with identity and write guards.',
      inputSchema: z.object({
        action: z.enum(['create', 'create_if_absent', 'upsert', 'update', 'delete']),
        taskSelector: taskSelectorSchema.optional(),
        projectSelector: projectSelectorSchema.optional(),
        fields: taskFieldsSchema.optional(),
        expectedUpdatedAt: z.string().optional(),
        actor: actorSchema,
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        externalKey: z.string().regex(EXTERNAL_KEY_PATTERN).optional(),
        attachments: z.array(z.string()).optional(),
        responseMode: responseModeSchema,
      }),
      handler: dispatch,
    },
    {
      name: 'vikunja_task_workflow',
      description: 'Close, assign, label, status, and relate tasks through guarded workflows.',
      inputSchema: z.object({
        action: z.enum([
          'close',
          'reopen',
          'close_with_evidence',
          'assign',
          'unassign',
          'list-assignees',
          'apply-label',
          'remove-label',
          'list-labels',
          'set_status',
          'relate',
          'unrelate',
          'list-relations',
        ]),
        taskSelector: taskSelectorSchema.optional(),
        projectSelector: projectSelectorSchema.optional(),
        evidenceComment: z.string().trim().min(1).optional(),
        expectedUpdatedAt: z.string().optional(),
        actor: actorSchema,
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        userSelector: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
        labelTitle: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
        statusLabel: z.string().trim().min(1).optional(),
        createIfMissing: z.boolean().optional(),
        otherTaskSelector: taskSelectorSchema.optional(),
        relationKind: z.string().optional(),
        responseMode: responseModeSchema,
      }),
      handler: dispatch,
    },
  ];
}
