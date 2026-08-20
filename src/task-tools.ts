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
  z
    .object({
      identifier: z
        .string()
        .trim()
        .regex(/^.+-\d+$/),
    })
    .strict(),
  z.object({ projectIndex: z.number().int().positive() }).strict(),
]);
const actorSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(
    /^[\p{L}\p{N} ._()_-]+$/u,
    'actor may contain only letters, numbers, spaces, dots, underscores, or hyphens; use an optional "(as NAME)" suffix for delegation (for example, "Codex (as srana)")',
  )
  .optional();
const taskFieldsSchema = z
  .object({
    title: z.string().trim().min(1).optional(),
    description: z.string().optional(),
    appendDescription: z.string().optional(),
    done: z.boolean().optional(),
    priority: z.number().int().min(0).max(5).optional(),
    dueDate: z.string().nullable().optional(),
    labels: z
      .array(z.union([z.string().trim().min(1), z.number().int().positive()]))
      .max(50)
      .optional()
      .describe('Labels to add after task creation or upsert; titles must be unambiguous.'),
  })
  .strict();
const verificationEvidenceSchema = z
  .object({
    command: z.string().trim().min(1),
    result: z.string().trim().min(1),
    timestamp: z.string().datetime(),
    evidenceKey: z.string().regex(EXTERNAL_KEY_PATTERN),
    revision: z.string().trim().min(1).optional(),
    taskState: z.string().trim().min(1).optional(),
  })
  .strict();

export function createTypedTaskTools(dispatch: TaskDispatcher): TypedTaskToolDefinition[] {
  return [
    {
      name: 'vikunja_task_read',
      description:
        'Read, list, count, search, summarize, or inspect bounded task time entries in Vikunja.',
      inputSchema: z.object({
        action: z.enum([
          'get',
          'list',
          'my_tasks',
          'summary',
          'batch_get',
          'verify_task_state',
          'programme_snapshot',
          'task_dedupe',
          'lookup_external_key',
          'receipt_lookup',
          'list_time_entries',
        ]),
        taskSelector: taskSelectorSchema.optional(),
        projectSelector: projectSelectorSchema.optional(),
        projects: z.array(projectSelectorSchema).optional(),
        allProjects: z.boolean().optional(),
        page: z.number().int().min(1).optional(),
        perPage: z.number().int().min(1).max(100).optional(),
        commentLimit: z.number().int().min(0).max(100).optional(),
        attachmentLimit: z.number().int().min(0).max(100).optional(),
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
        state: z.enum(['open', 'closed', 'all']).optional(),
        ownership: z.enum(['assigned']).optional(),
        countOnly: z.boolean().optional(),
        filter: z.string().optional(),
        responseMode: responseModeSchema,
        fields: z.array(z.enum(TASK_READ_FIELDS)).min(1).optional(),
        includeUrl: z.boolean().optional(),
        titleMaxChars: z.number().int().min(8).max(500).optional(),
        maxResponseChars: z.number().int().min(500).max(100_000).optional(),
        cursor: z.string().min(1).optional(),
        identifiers: z
          .array(
            z
              .string()
              .trim()
              .regex(/^.+-\d+$/),
          )
          .min(1)
          .max(100)
          .optional(),
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
      description:
        'Create, duplicate, upsert, update, or delete Vikunja tasks with identity and write guards.',
      inputSchema: z.object({
        action: z.enum(['create', 'create_if_absent', 'upsert', 'update', 'delete', 'duplicate']),
        taskSelector: taskSelectorSchema.optional(),
        projectSelector: projectSelectorSchema.optional(),
        fields: taskFieldsSchema.optional(),
        expectedUpdatedAt: z.string().optional(),
        actor: actorSchema,
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        confirm: z.boolean().optional(),
        externalKey: z.string().regex(EXTERNAL_KEY_PATTERN).optional(),
        attachments: z.array(z.string()).optional(),
        firstComment: z.string().trim().min(1).optional(),
        relations: z
          .array(
            z
              .object({
                otherTaskSelector: taskSelectorSchema,
                relationKind: z.string().trim().min(1),
              })
              .strict(),
          )
          .max(20)
          .optional(),
        dryRun: z.boolean().optional(),
        responseMode: responseModeSchema,
      }),
      handler: dispatch,
    },
    {
      name: 'vikunja_task_workflow',
      description:
        'Mark read, close, reopen, and record verification evidence through guarded workflows.',
      inputSchema: z.object({
        action: z.enum([
          'close',
          'reopen',
          'mark_read',
          'close_with_evidence',
          'append_evidence_if_changed',
          'close_if_verified',
          'transition_with_evidence',
        ]),
        taskSelector: taskSelectorSchema.optional(),
        projectSelector: projectSelectorSchema.optional(),
        evidenceComment: z.string().trim().min(1).optional(),
        evidence: verificationEvidenceSchema.optional(),
        expectedUpdatedAt: z.string().optional(),
        actor: actorSchema,
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        statusLabel: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
        createIfMissing: z.boolean().optional(),
        dryRun: z.boolean().optional(),
        responseMode: responseModeSchema,
      }),
      handler: dispatch,
    },
    {
      name: 'vikunja_task_organize',
      description: 'Assign, label, set status, and relate tasks through guarded workflows.',
      inputSchema: z.object({
        action: z.enum([
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
        actor: actorSchema,
        idempotencyKey: z.string().trim().min(1).max(200).optional(),
        userSelector: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
        labelTitle: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
        statusLabel: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
        createIfMissing: z.boolean().optional(),
        otherTaskSelector: taskSelectorSchema.optional(),
        relationKind: z.string().optional(),
        dryRun: z.boolean().optional(),
        responseMode: responseModeSchema,
      }),
      handler: dispatch,
    },
  ];
}
