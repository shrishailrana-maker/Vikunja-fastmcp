#!/usr/bin/env node
/**
 * MCP server entry point: tool registration, Zod→MCP schema mapping, and stdio dispatch.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { loadConfig } from './config.js';
import { VikunjaApiClient } from './api.js';
import { runSelfCheck } from './diagnostics.js';
import {
  toItemArray,
  formatSuccessEnvelope,
  formatFailureEnvelope,
  fetchAllCollectionItems,
} from './format.js';
import { toErrorEnvelope, VikunjaError, redactSecrets } from './errors.js';
import { resolveLabel } from './tasks.js';
import { cache, resolveProject } from './identity.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { TOOL_OPERATION_DOCS } from './tool-contract.js';
import { createTypedTaskTools } from './task-tools.js';
import { loadToolProfile, selectToolsForProfile } from './tool-profiles.js';
import {
  listTasks,
  createTask,
  createIfAbsent,
  upsertTask,
  EXTERNAL_KEY_PATTERN,
  getTask,
  updateTask,
  deleteTask,
  closeWithEvidence,
  assignTask,
  unassignTask,
  listAssignees,
  applyLabel,
  removeLabel,
  listLabels,
  relateTask,
  unrelateTask,
  listRelations,
  projectSummary,
  setTaskStatus,
  TASK_READ_FIELDS,
} from './tasks.js';
import {
  createComment,
  listComments,
  getComment,
  updateComment,
  deleteComment,
} from './comments.js';
import {
  attachFiles,
  deleteAttachment,
  downloadAttachment,
  listAttachments,
  AttachFileSpec,
} from './attachments.js';
import {
  createTeam,
  getTeam,
  listTeams,
  updateTeam,
  deleteTeam,
  addTeamMember,
  removeTeamMember,
  setTeamMemberAdmin,
} from './teams.js';
import {
  createSavedFilter,
  getSavedFilter,
  updateSavedFilter,
  deleteSavedFilter,
} from './filters.js';
import {
  addTaskReminder,
  bulkAssignTasks,
  bulkCreateTasks,
  bulkDeleteTasks,
  getBulkOperationStatus,
  bulkUnassignTasks,
  bulkUpdateTasks,
  listTaskReminders,
  removeTaskReminder,
} from './bulk-reminders.js';
import {
  detectCsvImport,
  downloadUserExport,
  exportProject,
  getCsvImportStatus,
  getUserExportStatus,
  previewCsvImport,
  requestUserExport,
  startCsvImport,
} from './data.js';
import {
  getIdempotentImportStatus,
  importCsvIdempotently,
  previewIdempotentCsvImport,
} from './csv-import.js';
import { enforceMutationProjectScope } from './mutation-policy.js';
import {
  createWebhook,
  deleteWebhook,
  listWebhookEvents,
  listWebhooks,
  updateWebhook,
} from './webhooks.js';
import { instantiateTemplate, TemplateStore } from './templates.js';

const PACKAGE_VERSION = String(
  JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version,
);
const templateStore = new TemplateStore();

// Construct Server
export const server = new Server(
  {
    name: 'vikunja-fastmcp',
    version: PACKAGE_VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  },
);

function unwrapZod(schema: z.ZodTypeAny): { schema: z.ZodTypeAny; optional: boolean } {
  let current: z.ZodTypeAny = schema;
  let optional = false;
  for (let i = 0; i < 6; i++) {
    if (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
      optional = true;
      current = (current as any)._def.innerType;
      continue;
    }
    if (current instanceof z.ZodNullable) {
      current = (current as any)._def.innerType;
      continue;
    }
    break;
  }
  return { schema: current, optional };
}

function zodTypeToJsonSchema(schema: z.ZodTypeAny): any {
  const { schema: current } = unwrapZod(schema);
  const description = schema.description ?? current.description;
  const describe = (jsonSchema: any) => (description ? { ...jsonSchema, description } : jsonSchema);

  if (current instanceof z.ZodString) {
    return describe({ type: 'string' });
  }
  if (current instanceof z.ZodNumber) {
    return describe({ type: 'number' });
  }
  if (current instanceof z.ZodBoolean) {
    return describe({ type: 'boolean' });
  }
  if (current instanceof z.ZodEnum) {
    return describe({ type: 'string', enum: (current as any)._def.values });
  }
  if (current instanceof z.ZodArray) {
    const inner = (current as any)._def.type;
    return describe({ type: 'array', items: zodTypeToJsonSchema(inner) });
  }
  if (current instanceof z.ZodUnion) {
    const options = (current as any)._def.options as z.ZodTypeAny[];
    return describe({ anyOf: options.map((o) => zodTypeToJsonSchema(o)) });
  }
  if (current instanceof z.ZodObject) {
    return describe(zodToMcpSchema(current));
  }
  if (current instanceof z.ZodRecord) {
    return describe({
      type: 'object',
      additionalProperties: zodTypeToJsonSchema((current as any)._def.valueType),
    });
  }
  if (current instanceof z.ZodAny || current instanceof z.ZodUnknown) {
    return {};
  }
  return { type: 'object' };
}

// Map Zod schemas to MCP JSON Schema (nested objects/arrays preserved).
function zodToMcpSchema(zodSchema: z.ZodObject<any>): any {
  const shape = zodSchema.shape;
  const properties: Record<string, any> = {};
  const required: string[] = [];

  for (const [key, value] of Object.entries(shape)) {
    const { optional } = unwrapZod(value as z.ZodTypeAny);
    if (!optional) {
      required.push(key);
    }
    properties[key] = zodTypeToJsonSchema(value as z.ZodTypeAny);
  }

  return {
    type: 'object',
    properties,
    required: required.length > 0 ? required : undefined,
  };
}

function addActionRequirements(toolName: string, schema: any): any {
  const operations = TOOL_OPERATION_DOCS[toolName];
  if (!operations || !schema.properties?.action) return schema;

  const propertyNames = Object.keys(schema.properties);
  const branches = operations.map((operation) => {
    const documented = [...(operation.required ?? []), ...(operation.optional ?? [])].join(' ');
    const allowed = propertyNames.filter(
      (name) => name === 'action' || new RegExp(`\\b${name}\\b`).test(documented),
    );
    const required = (operation.required ?? [])
      .map((name) => name.match(/^([A-Za-z][A-Za-z0-9]*)(?:\.[A-Za-z][A-Za-z0-9]*)?$/)?.[1])
      .filter((name): name is string => !!name && name in schema.properties);
    return {
      type: 'object',
      properties: Object.fromEntries(
        allowed.map((name) => [
          name,
          name === 'action' ? { const: operation.action } : schema.properties[name],
        ]),
      ),
      required: ['action', ...required],
      additionalProperties: false,
    };
  });
  return { ...schema, oneOf: branches };
}

function toolDescription(tool: McpToolDefinition): string {
  const operations = TOOL_OPERATION_DOCS[tool.name];
  if (!operations) return tool.description;
  const actionGuide = operations
    .map((operation) => {
      const required = operation.required?.length
        ? ` requires ${operation.required.join(', ')}`
        : '';
      return `${operation.action}${required}`;
    })
    .join('; ');
  return `${tool.description} Actions: ${actionGuide}.`;
}

function taskLink(webUrl: string, taskId: number, portalRef: string): string {
  return `[Open ${safeSummaryText(portalRef)}](${webUrl}tasks/${taskId})`;
}

function summaryFor(toolName: string, args: any, result: any, webUrl: string): string {
  if (toolName === 'self_check' || (toolName === 'vikunja_auth' && args?.action === 'self-check')) {
    return result?.ok ? 'Self-check passed.' : 'Self-check reported problems.';
  }
  if (result?.action && result?.target) {
    const portalRef =
      result.target.identifier || result.target.portalRef || `#${result.target.index ?? '?'}`;
    return `${result.action}: ${safeSummaryText(portalRef)} - ${safeSummaryText(result.target.title || 'task')} in **${safeSummaryText(result.target.project?.title || 'project')}**. ${taskLink(webUrl, result.target.id, portalRef)}`;
  }
  if (result?.task?.title) {
    const portalRef =
      result.task.portalRef || result.task.identifier || `#${result.task.index ?? '?'}`;
    return `${safeSummaryText(portalRef)} - ${safeSummaryText(result.task.title)}. ${taskLink(webUrl, result.task.id, portalRef)}`;
  }
  if (result?.count !== undefined && result?.project) {
    return `Count ${result.count} in **${safeSummaryText(result.project.title)}**.`;
  }
  if (result?.total !== undefined && result?.byPriority && result?.project) {
    return `Summarized ${result.total} tasks in **${safeSummaryText(result.project.title)}**.`;
  }
  if (result?.pagination?.total !== undefined && result?.project) {
    const continuation = result.pagination.nextPage
      ? ` Next page: ${result.pagination.nextPage}.`
      : '';
    return `Listed ${result.tasks?.length ?? 0}/${result.pagination.total} tasks in **${safeSummaryText(result.project.title)}**.${continuation}`;
  }
  if (Array.isArray(result?.projects)) {
    return `Multi-project list with ${result.projects.length} group(s).`;
  }
  if (Array.isArray(result)) {
    return `Returned ${result.length} item(s).`;
  }
  return `Completed \`${toolName}\`${args?.action ? ` / ${args.action}` : ''}.`;
}

function safeSummaryText(value: unknown): string {
  return String(value)
    .replace(/[\r\n]+/g, ' ')
    .replace(/([\\`*_[\]<>])/g, '\\$1')
    .trim();
}

function safeEnvelopeText(text: string, configuredToken?: string): string {
  return redactSecrets(text, configuredToken ?? process.env.VIKUNJA_API_TOKEN);
}

// Handler precondition failures are caller mistakes (missing/invalid args), so
// they must surface as a 400 VALIDATION_ERROR, not a generic 500 from the
// non-VikunjaError branch of toErrorEnvelope.
function badRequest(message: string): VikunjaError {
  return new VikunjaError({
    status: 400,
    code: 'VALIDATION_ERROR',
    method: 'TOOLS_CALL',
    path: 'arguments',
    message,
    fieldErrors: [],
  });
}

function policyError(code: string, message: string): VikunjaError {
  return new VikunjaError({
    status: 400,
    code,
    method: 'TOOLS_CALL',
    path: 'arguments',
    message,
    fieldErrors: [],
  });
}

function requireActor(actor: string | undefined, action: string): string {
  if (!actor) {
    throw policyError('ACTOR_REQUIRED', `actor is required for ${action}.`);
  }
  return actor;
}

function requireIdempotencyKey(key: string | undefined, action: string): string {
  if (!key) {
    throw policyError('IDEMPOTENCY_KEY_REQUIRED', `idempotencyKey is required for ${action}.`);
  }
  return key;
}

function hasDefinedValue(value: Record<string, unknown> | undefined): boolean {
  return !!value && Object.values(value).some((field) => field !== undefined);
}

const actorValueSchema = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N} ._-]+$/u, 'actor contains unsupported characters');
const actorSchema = actorValueSchema.optional();

const taskSelectorSchema = z.union([
  z
    .object({
      globalId: z.number().int().positive().describe('Vikunja global database task ID.'),
    })
    .strict(),
  z
    .object({
      identifier: z
        .string()
        .trim()
        .regex(/^.+-\d+$/)
        .describe('Full human task identifier, for example ALPHA-517.'),
    })
    .strict(),
  z
    .object({
      projectIndex: z
        .number()
        .int()
        .positive()
        .describe('Project-local task index; projectSelector is also required.'),
    })
    .strict(),
]);

export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<any>;
  handler: (args: any, client: VikunjaApiClient) => Promise<any>;
}

function getToolManifest() {
  return getActiveTools().map((tool) => {
    const action = tool.inputSchema.shape.action as z.ZodTypeAny | undefined;
    const inner = action ? unwrapZod(action).schema : undefined;
    return {
      name: tool.name,
      subcommands: inner instanceof z.ZodEnum ? [...(inner as any)._def.values] : [],
    };
  });
}

export const TOOLS: McpToolDefinition[] = [
  {
    name: 'self_check',
    description:
      'Run a compact configuration and connection self-check; use detail=full only for diagnostics.',
    inputSchema: z.object({
      detail: z.enum(['basic', 'full']).optional(),
    }),
    handler: async (args) => {
      return runSelfCheck(getToolManifest(), args.detail);
    },
  },
  {
    name: 'vikunja_auth',
    description:
      'Check connection and get currently authenticated user details or connection status.',
    inputSchema: z.object({
      action: z.enum(['status', 'self-check']),
      detail: z.enum(['basic', 'full']).optional(),
    }),
    handler: async (args, client) => {
      if (args.action === 'self-check') {
        return runSelfCheck(getToolManifest(), args.detail);
      }
      // Query current user profile (no email — minimize PII in agent context)
      const user = await client.request<any>('GET', '/user');
      return {
        connection: 'online',
        user: {
          id: user.id,
          username: user.username,
        },
      };
    },
  },
  {
    name: 'vikunja_projects',
    description: 'List visible projects or retrieve a specific project details.',
    inputSchema: z.object({
      action: z.enum(['list', 'get']),
      project: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
    }),
    handler: async (args, client) => {
      if (args.action === 'list') {
        const raw = await fetchAllCollectionItems(
          async (path) => client.request<any>('GET', path),
          '/projects',
        );
        return raw.map((p: any) => ({
          id: p.id,
          title: p.title,
          archived: !!p.is_archived,
        }));
      }

      if (!args.project?.id && !args.project?.title) {
        throw badRequest('Project id or title is required for get action.');
      }

      const resolved = await resolveProject(client, args.project);
      // Fetch full project details
      const detail = await client.request<any>('GET', `/projects/${resolved.id}`);
      return {
        id: detail.id,
        title: detail.title,
        description: detail.description || null,
        created: detail.created,
        updated: detail.updated,
      };
    },
  },
  {
    name: 'vikunja_tasks',
    description: 'Create, update, delete, close, assign, label, relate, or attach files to tasks.',
    inputSchema: z.object({
      action: z.enum([
        'create',
        'create_if_absent',
        'upsert',
        'get',
        'list',
        'summary',
        'update',
        'delete',
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
        'attach',
        'list-attachments',
        'download-attachment',
        'delete-attachment',
      ]),
      taskSelector: taskSelectorSchema.optional(),
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      projects: z
        .array(
          z.object({
            id: z.number().int().positive().optional(),
            title: z.string().trim().min(1).optional(),
          }),
        )
        .optional(),
      allProjects: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(1000).optional(),
      commentLimit: z.number().int().min(0).max(100).optional(),
      done: z.boolean().optional(),
      allStates: z.boolean().optional(),
      priority: z.number().int().min(0).max(5).optional(),
      label: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
      assignee: z
        .string()
        .trim()
        .min(1)
        .optional()
        .describe(
          'Exact assignee username for task lists; Vikunja filters do not accept user IDs.',
        ),
      descriptionContains: z.string().optional(),
      q: z
        .string()
        .optional()
        .describe('Free-text task search. Sent to Vikunja as the q query parameter.'),
      search: z
        .string()
        .optional()
        .describe('Free-text task search alias for q; no filter DSL lookup is needed.'),
      countOnly: z.boolean().optional(),
      filter: z.string().optional(),
      responseMode: z.enum(['minimal', 'receipt', 'compact', 'standard', 'full']).optional(),
      fields: z
        .union([
          z.object({
            title: z.string().trim().min(1).optional(),
            description: z.string().optional(),
            appendDescription: z.string().optional(),
            done: z.boolean().optional(),
            priority: z.number().int().min(0).max(5).optional(),
            dueDate: z.string().nullable().optional(),
          }),
          z.array(z.enum(TASK_READ_FIELDS)).min(1),
        ])
        .optional(),
      includeUrl: z.boolean().optional(),
      titleMaxChars: z.number().int().min(8).max(500).optional(),
      maxResponseChars: z.number().int().min(500).max(100_000).optional(),
      cursor: z.string().min(1).optional(),
      expectedUpdatedAt: z.string().optional(),
      evidenceComment: z.string().trim().min(1).optional(),
      actor: actorSchema,
      userSelector: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
      labelTitle: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
      statusLabel: z.string().trim().min(1).optional(),
      createIfMissing: z.boolean().optional(),
      otherTaskSelector: taskSelectorSchema.optional(),
      relationKind: z.string().optional(),
      // Attachment inputs. `attach` accepts local `filePaths` and/or a single
      // base64 file (filename + optional mimeType + base64Content). `create` and
      // `create_if_absent` accept `attachments` (local file paths).
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      base64Content: z.string().optional(),
      filePaths: z.array(z.string()).optional(),
      attachments: z.array(z.string()).optional(),
      // download-attachment inputs.
      attachmentId: z.number().int().positive().optional(),
      destinationPath: z.string().optional(),
      overwrite: z.boolean().optional(),
      filenamePrefix: z.string().max(255).optional(),
      confirm: z.boolean().optional(),
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      externalKey: z.string().regex(EXTERNAL_KEY_PATTERN).optional(),
    }),
    handler: async (args, client) => {
      switch (args.action) {
        case 'list':
          if (args.q !== undefined && args.search !== undefined && args.q !== args.search) {
            throw badRequest('q and search must match when both are supplied.');
          }
          return listTasks(client, {
            project: args.projectSelector,
            projects: args.projects,
            allProjects: args.allProjects,
            page: args.page,
            perPage: args.perPage,
            done: args.done,
            allStates: args.allStates,
            priority: args.priority,
            label: args.label,
            assignee: args.assignee,
            descriptionContains: args.descriptionContains,
            actor: args.actor,
            q: args.q ?? args.search,
            countOnly: args.countOnly,
            filter: args.filter,
            responseMode: args.responseMode,
            fields: Array.isArray(args.fields) ? args.fields : undefined,
            includeUrl: args.includeUrl,
            titleMaxChars: args.titleMaxChars,
            maxResponseChars: args.maxResponseChars,
            cursor: args.cursor,
          });
        case 'summary':
          if (!args.projectSelector) throw badRequest('projectSelector is required for summary.');
          return projectSummary(client, args.projectSelector);
        case 'create':
          requireActor(args.actor, 'task creation');
          requireIdempotencyKey(args.idempotencyKey, 'task creation');
          if (!args.projectSelector) throw badRequest('projectSelector is required for create.');
          if (!args.fields?.title) throw badRequest('fields.title is required for create.');
          return createTask(
            client,
            args.projectSelector,
            {
              title: args.fields.title,
              description: args.fields.description,
              done: args.fields.done,
              priority: args.fields.priority,
              dueDate: args.fields.dueDate,
            },
            args.idempotencyKey,
            args.attachments,
            args.actor,
          );
        case 'create_if_absent':
          requireActor(args.actor, 'task creation');
          requireIdempotencyKey(args.idempotencyKey, 'task creation');
          if (!args.projectSelector) throw badRequest('projectSelector is required.');
          if (!args.fields?.title) throw badRequest('fields.title is required.');
          return createIfAbsent(
            client,
            args.projectSelector,
            {
              title: args.fields.title,
              description: args.fields.description,
              done: args.fields.done,
              priority: args.fields.priority,
              dueDate: args.fields.dueDate,
            },
            args.idempotencyKey,
            args.attachments,
            args.actor,
          );
        case 'upsert':
          requireActor(args.actor, 'task upsert');
          if (!args.projectSelector) throw badRequest('projectSelector is required for upsert.');
          if (!args.fields?.title) throw badRequest('fields.title is required for upsert.');
          if (!args.externalKey) throw badRequest('externalKey is required for upsert.');
          return upsertTask(
            client,
            args.projectSelector,
            {
              title: args.fields.title,
              description: args.fields.description,
              done: args.fields.done,
              priority: args.fields.priority,
              dueDate: args.fields.dueDate,
            },
            args.externalKey,
            args.expectedUpdatedAt,
            args.actor,
          );
        case 'get':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          return getTask(
            client,
            args.taskSelector,
            args.projectSelector,
            args.commentLimit ?? 5,
            args.responseMode,
            {
              fields: Array.isArray(args.fields) ? args.fields : undefined,
              includeUrl: args.includeUrl,
              titleMaxChars: args.titleMaxChars,
            },
          );
        case 'update':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!hasDefinedValue(args.fields)) {
            throw badRequest('At least one task field is required for update.');
          }
          if (
            (args.fields.title !== undefined || args.fields.description !== undefined) &&
            !args.expectedUpdatedAt
          ) {
            throw policyError(
              'EXPECTED_UPDATED_AT_REQUIRED',
              'expectedUpdatedAt is required when replacing a task title or description.',
            );
          }
          return updateTask(
            client,
            args.taskSelector,
            {
              title: args.fields.title,
              description: args.fields.description,
              appendDescription: args.fields.appendDescription,
              done: args.fields.done,
              priority: args.fields.priority,
              dueDate: args.fields.dueDate,
            },
            args.projectSelector,
            args.expectedUpdatedAt,
          );
        case 'delete':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          return deleteTask(client, args.taskSelector, args.projectSelector);
        case 'close':
          requireActor(args.actor, 'task close');
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          return {
            ...(await updateTask(client, args.taskSelector, { done: true }, args.projectSelector)),
            actor: args.actor,
          };
        case 'reopen':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          return updateTask(client, args.taskSelector, { done: false }, args.projectSelector);
        case 'close_with_evidence':
          requireActor(args.actor, 'task close');
          requireIdempotencyKey(args.idempotencyKey, 'close_with_evidence');
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.evidenceComment) throw badRequest('evidenceComment is required.');
          return closeWithEvidence(
            client,
            args.taskSelector,
            args.evidenceComment,
            args.projectSelector,
            args.idempotencyKey,
            args.actor,
          );
        case 'assign':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.userSelector) throw badRequest('userSelector is required.');
          return assignTask(client, args.taskSelector, args.userSelector, args.projectSelector);
        case 'unassign':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.userSelector) throw badRequest('userSelector is required.');
          return unassignTask(client, args.taskSelector, args.userSelector, args.projectSelector);
        case 'list-assignees':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          return listAssignees(client, args.taskSelector, args.projectSelector);
        case 'apply-label':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.labelTitle) throw badRequest('labelTitle is required.');
          return applyLabel(client, args.taskSelector, args.labelTitle, args.projectSelector);
        case 'remove-label':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.labelTitle) throw badRequest('labelTitle is required.');
          return removeLabel(client, args.taskSelector, args.labelTitle, args.projectSelector);
        case 'list-labels':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          return listLabels(client, args.taskSelector, args.projectSelector);
        case 'set_status':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.statusLabel) throw badRequest('statusLabel is required.');
          return setTaskStatus(
            client,
            args.taskSelector,
            args.statusLabel,
            args.projectSelector,
            args.createIfMissing,
          );
        case 'relate':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.otherTaskSelector) throw badRequest('otherTaskSelector is required.');
          if (!args.relationKind) throw badRequest('relationKind is required.');
          return relateTask(
            client,
            args.taskSelector,
            args.otherTaskSelector,
            args.relationKind,
            args.projectSelector,
          );
        case 'unrelate':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (!args.otherTaskSelector) throw badRequest('otherTaskSelector is required.');
          if (!args.relationKind) throw badRequest('relationKind is required.');
          return unrelateTask(
            client,
            args.taskSelector,
            args.otherTaskSelector,
            args.relationKind,
            args.projectSelector,
          );
        case 'list-relations':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          return listRelations(client, args.taskSelector, args.projectSelector, args.responseMode);
        case 'attach': {
          requireIdempotencyKey(args.idempotencyKey, 'attachment upload');
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          const files: AttachFileSpec[] = [];
          if (Array.isArray(args.filePaths)) {
            for (const fp of args.filePaths) files.push({ filePath: fp });
          }
          if (args.base64Content) {
            if (!args.filename) {
              throw badRequest('filename is required when attaching base64Content.');
            }
            files.push({
              filename: args.filename,
              mimeType: args.mimeType,
              base64Content: args.base64Content,
            });
          }
          if (files.length === 0) {
            throw badRequest('Provide filePaths[] and/or base64Content with a filename to attach.');
          }
          return attachFiles(
            client,
            args.taskSelector,
            files,
            args.projectSelector,
            args.idempotencyKey,
          );
        }
        case 'list-attachments':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (
            args.page === undefined &&
            args.perPage === undefined &&
            args.countOnly === undefined &&
            args.filenamePrefix === undefined
          ) {
            return listAttachments(client, args.taskSelector, args.projectSelector);
          }
          return listAttachments(client, args.taskSelector, args.projectSelector, {
            page: args.page,
            perPage: args.perPage,
            countOnly: args.countOnly,
            filenamePrefix: args.filenamePrefix,
          });
        case 'download-attachment':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (args.attachmentId === undefined) throw badRequest('attachmentId is required.');
          return downloadAttachment(
            client,
            args.taskSelector,
            args.attachmentId,
            args.destinationPath,
            args.projectSelector,
            { overwrite: args.overwrite },
          );
        case 'delete-attachment':
          if (!args.taskSelector) throw badRequest('taskSelector is required.');
          if (args.attachmentId === undefined) throw badRequest('attachmentId is required.');
          if (!args.projectSelector) throw badRequest('projectSelector is required.');
          return deleteAttachment(
            client,
            args.taskSelector,
            args.attachmentId,
            args.projectSelector,
            args.confirm,
            requireActor(args.actor, 'attachment deletion'),
            requireIdempotencyKey(args.idempotencyKey, 'attachment deletion'),
          );
        default:
          throw badRequest(`Unknown tasks action: ${args.action}`);
      }
    },
  },
  {
    name: 'vikunja_task_attachments',
    description:
      'Typed task attachment operations: upload, bounded list/count, authenticated download, and ownership-safe deletion.',
    inputSchema: z.object({
      action: z.enum(['attach', 'list', 'download', 'delete']),
      taskSelector: taskSelectorSchema,
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      filename: z.string().optional(),
      mimeType: z.string().optional(),
      base64Content: z.string().optional(),
      filePaths: z.array(z.string()).optional(),
      attachmentId: z.number().int().positive().optional(),
      destinationPath: z.string().optional(),
      overwrite: z.boolean().optional(),
      page: z.number().int().min(1).optional(),
      perPage: z.number().int().min(1).max(1000).optional(),
      countOnly: z.boolean().optional(),
      filenamePrefix: z.string().max(255).optional(),
      confirm: z.boolean().optional(),
      actor: actorSchema,
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
    }),
    handler: async (args, client) => {
      switch (args.action) {
        case 'attach': {
          requireIdempotencyKey(args.idempotencyKey, 'attachment upload');
          const files: AttachFileSpec[] = [];
          if (Array.isArray(args.filePaths)) {
            for (const filePath of args.filePaths) files.push({ filePath });
          }
          if (args.base64Content) {
            if (!args.filename) {
              throw badRequest('filename is required when attaching base64Content.');
            }
            files.push({
              filename: args.filename,
              mimeType: args.mimeType,
              base64Content: args.base64Content,
            });
          }
          if (files.length === 0) {
            throw badRequest('Provide filePaths[] and/or base64Content with a filename to attach.');
          }
          return attachFiles(
            client,
            args.taskSelector,
            files,
            args.projectSelector,
            args.idempotencyKey,
          );
        }
        case 'list':
          return listAttachments(client, args.taskSelector, args.projectSelector, {
            page: args.page,
            perPage: args.perPage,
            countOnly: args.countOnly,
            filenamePrefix: args.filenamePrefix,
          });
        case 'download':
          if (args.attachmentId === undefined) throw badRequest('attachmentId is required.');
          return downloadAttachment(
            client,
            args.taskSelector,
            args.attachmentId,
            args.destinationPath,
            args.projectSelector,
            { overwrite: args.overwrite },
          );
        case 'delete':
          if (args.attachmentId === undefined) throw badRequest('attachmentId is required.');
          if (!args.projectSelector) throw badRequest('projectSelector is required.');
          return deleteAttachment(
            client,
            args.taskSelector,
            args.attachmentId,
            args.projectSelector,
            args.confirm,
            requireActor(args.actor, 'attachment deletion'),
            requireIdempotencyKey(args.idempotencyKey, 'attachment deletion'),
          );
        default:
          throw badRequest(`Unknown attachment action: ${args.action}`);
      }
    },
  },
  {
    name: 'vikunja_task_comments',
    description: 'Manage task comments (create, list, get, update, delete).',
    inputSchema: z.object({
      action: z.enum(['create', 'list', 'get', 'update', 'delete']),
      taskSelector: taskSelectorSchema,
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      commentId: z.number().int().positive().optional(),
      comment: z.string().trim().min(1).optional(),
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      actor: actorSchema,
      page: z.number().int().positive().optional(),
      perPage: z.number().int().min(1).max(100).optional(),
    }),
    handler: async (args, client) => {
      switch (args.action) {
        case 'create':
          requireActor(args.actor, 'comment creation');
          requireIdempotencyKey(args.idempotencyKey, 'comment creation');
          if (!args.comment) throw badRequest('comment text is required.');
          return createComment(
            client,
            args.taskSelector,
            args.comment,
            args.projectSelector,
            args.idempotencyKey,
            args.actor,
          );
        case 'list':
          return listComments(
            client,
            args.taskSelector,
            args.projectSelector,
            args.page,
            args.perPage,
          );
        case 'get':
          if (!args.commentId) throw badRequest('commentId is required.');
          return getComment(client, args.taskSelector, args.commentId, args.projectSelector);
        case 'update':
          requireActor(args.actor, 'comment update');
          if (!args.commentId) throw badRequest('commentId is required.');
          if (!args.comment) throw badRequest('comment text is required.');
          return updateComment(
            client,
            args.taskSelector,
            args.commentId,
            args.comment,
            args.projectSelector,
            args.actor,
          );
        case 'delete':
          requireActor(args.actor, 'comment deletion');
          if (!args.commentId) throw badRequest('commentId is required.');
          return deleteComment(
            client,
            args.taskSelector,
            args.commentId,
            args.projectSelector,
            args.actor,
          );
        default:
          throw badRequest(`Unknown comments action: ${args.action}`);
      }
    },
  },
  {
    name: 'vikunja_labels',
    description: 'List, get, create, update, or delete global labels.',
    inputSchema: z.object({
      action: z.enum(['list', 'get', 'create', 'update', 'delete']),
      labelSelector: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
      title: z.string().trim().min(1).optional(),
      description: z.string().optional(),
      hexColor: z.string().optional(),
    }),
    handler: async (args, client) => {
      if (args.action === 'list') {
        const items = await fetchAllCollectionItems(
          async (path) => client.request<any>('GET', path),
          '/labels',
        );
        return items.map((l: any) => ({
          id: l.id,
          title: l.title,
          description: l.description || null,
          hexColor: l.hex_color || null,
        }));
      }

      if (args.action === 'create') {
        if (!args.title) throw badRequest('title is required.');
        try {
          const existingId = await resolveLabel(client, args.title);
          throw new VikunjaError({
            status: 409,
            code: 'LABEL_ALREADY_EXISTS',
            method: 'POST',
            path: '/labels',
            message: `Label "${args.title}" already exists with ID ${existingId}. Reuse that label instead of creating a duplicate.`,
            fieldErrors: [],
          });
        } catch (error) {
          if (!(error instanceof VikunjaError) || error.code !== 'LABEL_NOT_FOUND') throw error;
        }
        const created = await client.request<any>('POST', '/labels', {
          body: {
            title: args.title,
            description: args.description,
            hex_color: args.hexColor,
          },
        });
        cache.clearLabels();
        return created;
      }

      if (
        args.action === 'update' &&
        !hasDefinedValue({
          title: args.title,
          description: args.description,
          hexColor: args.hexColor,
        })
      ) {
        throw badRequest('At least one label field is required for update.');
      }

      if (!args.labelSelector) throw badRequest('labelSelector is required.');
      const labelId = await resolveLabel(client, args.labelSelector);

      if (args.action === 'get') {
        return client.request<any>('GET', `/labels/${labelId}`);
      }

      if (args.action === 'update') {
        const updated = await client.request<any>('PATCH', `/labels/${labelId}`, {
          body: {
            title: args.title,
            description: args.description,
            hex_color: args.hexColor,
          },
          headers: { 'Content-Type': 'application/merge-patch+json' },
        });
        cache.clearLabels();
        return updated;
      }

      if (args.action === 'delete') {
        await client.request<any>('DELETE', `/labels/${labelId}`);
        cache.clearLabels();
        return { ok: true, labelId };
      }

      throw badRequest(`Unknown labels action: ${args.action}`);
    },
  },
  {
    name: 'vikunja_users',
    description: 'Get current user profile or search other users.',
    inputSchema: z.object({
      action: z.enum(['current', 'search']),
      q: z.string().optional(),
    }),
    handler: async (args, client) => {
      // Allowlist identity fields only; do not leak email/other PII into agent
      // context (consistent with vikunja_auth status).
      if (args.action === 'current') {
        const user = await client.request<any>('GET', '/user');
        return { id: user.id, username: user.username };
      }
      const results = toItemArray<any>(
        await client.request<any>('GET', `/users?q=${encodeURIComponent(args.q || '')}`),
      );
      return results.map((u) => ({ id: u.id, username: u.username }));
    },
  },
  {
    name: 'vikunja_teams',
    description: 'Manage teams and team members.',
    inputSchema: z.object({
      action: z.enum([
        'list',
        'get',
        'create',
        'update',
        'delete',
        'add-member',
        'remove-member',
        'set-member-admin',
      ]),
      teamId: z.number().int().positive().optional(),
      name: z.string().trim().min(1).optional(),
      usernameOrId: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
      admin: z.boolean().optional(),
    }),
    handler: async (args, client) => {
      switch (args.action) {
        case 'list':
          return listTeams(client);
        case 'create':
          if (!args.name) throw badRequest('name is required.');
          return createTeam(client, args.name);
      }

      if (!args.teamId) throw badRequest('teamId is required.');

      switch (args.action) {
        case 'get':
          return getTeam(client, args.teamId);
        case 'update':
          if (!args.name) throw badRequest('name is required.');
          return updateTeam(client, args.teamId, args.name);
        case 'delete':
          return deleteTeam(client, args.teamId);
        case 'add-member':
          if (!args.usernameOrId) throw badRequest('usernameOrId is required.');
          return addTeamMember(client, args.teamId, args.usernameOrId);
        case 'remove-member':
          if (!args.usernameOrId) throw badRequest('usernameOrId is required.');
          return removeTeamMember(client, args.teamId, args.usernameOrId);
        case 'set-member-admin':
          if (!args.usernameOrId) throw badRequest('usernameOrId is required.');
          if (args.admin === undefined) throw badRequest('admin flag is required.');
          return setTeamMemberAdmin(client, args.teamId, args.usernameOrId, args.admin);
        default:
          throw badRequest(`Unknown teams action: ${args.action}`);
      }
    },
  },
  {
    name: 'vikunja_filters',
    description:
      'Create, read, update, or delete saved filters. Listing is unsupported (no collection route in the Vikunja v2 API); see self_check.unsupportedOperations.',
    inputSchema: z.object({
      action: z.enum(['create', 'get', 'update', 'delete']),
      filterId: z.number().int().positive().optional(),
      title: z.string().trim().min(1).optional(),
      filterQuery: z.any().optional(),
      description: z.string().optional(),
      isFavorite: z.boolean().optional(),
    }),
    handler: async (args, client) => {
      if (args.action === 'create') {
        if (!args.title) throw badRequest('title is required.');
        if (args.filterQuery === undefined) throw badRequest('filterQuery is required.');
        return createSavedFilter(
          client,
          args.title,
          args.filterQuery,
          args.description,
          args.isFavorite,
        );
      }

      if (!args.filterId) throw badRequest('filterId is required.');

      switch (args.action) {
        case 'get':
          return getSavedFilter(client, args.filterId);
        case 'update':
          if (
            !hasDefinedValue({
              title: args.title,
              filterQuery: args.filterQuery,
              description: args.description,
              isFavorite: args.isFavorite,
            })
          ) {
            throw badRequest('At least one saved-filter field is required for update.');
          }
          return updateSavedFilter(client, args.filterId, {
            title: args.title,
            filterQuery: args.filterQuery,
            description: args.description,
            isFavorite: args.isFavorite,
          });
        case 'delete':
          return deleteSavedFilter(client, args.filterId);
        default:
          throw badRequest(`Unknown filters action: ${args.action}`);
      }
    },
  },
  {
    name: 'vikunja_task_bulk',
    description:
      'Preferred way to create or upsert several tasks in one call. Supports durable resumable update, delete, assign, and unassign batches plus status lookup.',
    inputSchema: z.object({
      action: z.enum(['update', 'create', 'delete', 'assign', 'unassign', 'status']),
      taskSelectors: z.array(taskSelectorSchema).min(1).max(100).optional(),
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      fields: z
        .object({
          title: z.string().trim().min(1).optional(),
          description: z.string().optional(),
          done: z.boolean().optional(),
          priority: z.number().int().min(0).max(5).optional(),
          dueDate: z.string().nullable().optional(),
        })
        .optional(),
      tasks: z
        .array(
          z.object({
            title: z.string().trim().min(1),
            description: z.string().optional(),
            done: z.boolean().optional(),
            priority: z.number().int().min(0).max(5).optional(),
            dueDate: z.string().nullable().optional(),
            externalKey: z.string().regex(EXTERNAL_KEY_PATTERN).optional(),
            expectedUpdatedAt: z.string().optional(),
          }),
        )
        .min(1)
        .max(100)
        .optional(),
      userSelector: z.union([z.string().trim().min(1), z.number().int().positive()]).optional(),
      dryRun: z.boolean().optional(),
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      operationId: z.string().trim().min(1).max(120).optional(),
      actor: actorSchema,
      confirm: z.boolean().optional(),
    }),
    handler: async (args, client) => {
      if (args.action === 'status') {
        if (!args.operationId) throw badRequest('operationId is required for bulk status.');
        return getBulkOperationStatus(args.operationId);
      }
      requireActor(args.actor, `bulk ${args.action}`);
      if (!args.idempotencyKey) {
        throw policyError(
          'IDEMPOTENCY_KEY_REQUIRED',
          `idempotencyKey is required for bulk ${args.action}.`,
        );
      }
      switch (args.action) {
        case 'update':
          if (!args.taskSelectors) {
            throw badRequest('taskSelectors is required for bulk update.');
          }
          if (!args.fields) throw badRequest('fields is required for bulk update.');
          if (args.fields.title !== undefined || args.fields.description !== undefined) {
            throw policyError(
              'EXPECTED_UPDATED_AT_REQUIRED',
              'Bulk replacement of title or description is disabled because each task requires its own expectedUpdatedAt. Use individual update calls.',
            );
          }
          return bulkUpdateTasks(
            client,
            args.taskSelectors,
            args.fields,
            args.projectSelector,
            args.idempotencyKey,
            args.actor,
          );
        case 'create':
          if (!args.projectSelector) {
            throw badRequest('projectSelector is required for bulk create.');
          }
          if (!args.tasks) throw badRequest('tasks is required for bulk create.');
          return bulkCreateTasks(
            client,
            args.projectSelector,
            args.tasks,
            args.idempotencyKey,
            args.actor,
          );
        case 'delete':
          if (!args.taskSelectors) {
            throw badRequest('taskSelectors is required for bulk delete.');
          }
          if (args.confirm !== true) throw badRequest('confirm=true is required for bulk delete.');
          return bulkDeleteTasks(
            client,
            args.taskSelectors,
            args.projectSelector,
            args.idempotencyKey,
            args.actor,
          );
        case 'assign':
          if (!args.taskSelectors) {
            throw badRequest('taskSelectors is required for bulk assign.');
          }
          if (args.userSelector === undefined) {
            throw badRequest('userSelector is required for bulk assign.');
          }
          return bulkAssignTasks(
            client,
            args.taskSelectors,
            args.userSelector,
            args.projectSelector,
            args.dryRun ?? false,
            args.idempotencyKey,
            args.actor,
          );
        case 'unassign':
          if (!args.taskSelectors) {
            throw badRequest('taskSelectors is required for bulk unassign.');
          }
          if (args.userSelector === undefined) {
            throw badRequest('userSelector is required for bulk unassign.');
          }
          return bulkUnassignTasks(
            client,
            args.taskSelectors,
            args.userSelector,
            args.projectSelector,
            args.dryRun ?? false,
            args.idempotencyKey,
            args.actor,
          );
        default:
          throw badRequest(`Unknown bulk action: ${args.action}`);
      }
    },
  },
  {
    name: 'vikunja_task_reminders',
    description: 'List, add, or remove reminders stored on a task.',
    inputSchema: z.object({
      action: z.enum(['list', 'add', 'remove']),
      taskSelector: taskSelectorSchema,
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      reminder: z.string().optional(),
      relativePeriod: z.number().int().optional(),
      relativeTo: z.string().trim().min(1).optional(),
      reminderIndex: z.number().int().min(0).optional(),
    }),
    handler: async (args, client) => {
      switch (args.action) {
        case 'list':
          return listTaskReminders(client, args.taskSelector, args.projectSelector);
        case 'add':
          return addTaskReminder(
            client,
            args.taskSelector,
            {
              reminder: args.reminder,
              relativePeriod: args.relativePeriod,
              relativeTo: args.relativeTo,
            },
            args.projectSelector,
          );
        case 'remove':
          if (args.reminderIndex === undefined) {
            throw badRequest('reminderIndex is required for remove.');
          }
          return removeTaskReminder(
            client,
            args.taskSelector,
            args.reminderIndex,
            args.projectSelector,
          );
      }
    },
  },
  {
    name: 'vikunja_batch_import',
    description:
      'Detect, preview, import, or inspect CSV data through native-fast or MCP-idempotent mode.',
    inputSchema: z.object({
      action: z.enum(['detect', 'preview', 'import', 'status']),
      mode: z.enum(['native', 'idempotent']).optional(),
      filePath: z.string().trim().min(1).optional(),
      config: z.record(z.unknown()).optional(),
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      idempotencyKey: z.string().trim().min(1).max(200).optional(),
      actor: actorSchema,
    }),
    handler: async (args, client) => {
      const mode = args.mode ?? 'native';
      if (args.action === 'status') {
        if (mode === 'native') return getCsvImportStatus(client);
        if (!args.idempotencyKey) {
          throw badRequest('idempotencyKey is required for idempotent import status.');
        }
        return getIdempotentImportStatus(args.idempotencyKey);
      }
      if (!args.filePath) throw badRequest('filePath is required.');
      if (args.action === 'detect') return detectCsvImport(client, args.filePath);
      if (!args.config) throw badRequest('config is required for preview and import.');
      if (args.action === 'preview') {
        return mode === 'idempotent'
          ? previewIdempotentCsvImport(
              args.filePath,
              args.config,
              args.projectSelector,
              client.getConfig().maxAttachmentBytes,
            )
          : previewCsvImport(client, args.filePath, args.config);
      }
      requireActor(args.actor, 'CSV import');
      if (mode === 'idempotent') {
        if (!args.idempotencyKey) {
          throw badRequest('idempotencyKey is required for idempotent import mode.');
        }
        return importCsvIdempotently(
          client,
          args.filePath,
          args.config,
          args.idempotencyKey,
          args.projectSelector,
          args.actor,
        );
      }
      return {
        mode: 'native',
        idempotent: false,
        actor: args.actor,
        ...(await startCsvImport(client, args.filePath, args.config)),
      };
    },
  },
  {
    name: 'vikunja_export_project',
    description: 'Export one project task list to a local JSON or CSV file.',
    inputSchema: z.object({
      projectSelector: z.object({
        id: z.number().int().positive().optional(),
        title: z.string().trim().min(1).optional(),
      }),
      format: z.enum(['json', 'csv']).optional(),
      destinationPath: z.string().optional(),
      includeComments: z.boolean().optional(),
      includeAttachments: z.boolean().optional(),
      includeRelations: z.boolean().optional(),
    }),
    handler: async (args, client) =>
      exportProject(
        client,
        args.projectSelector,
        args.format,
        args.destinationPath,
        args.includeComments,
        args.includeAttachments,
        args.includeRelations,
      ),
  },
  {
    name: 'vikunja_request_user_export',
    description: 'Request a native Vikunja user-data export. Password input is never returned.',
    inputSchema: z.object({ password: z.string().optional() }),
    handler: async (args, client) => requestUserExport(client, args.password),
  },
  {
    name: 'vikunja_download_user_export',
    description: 'Check user-export status or download the ready archive to sandboxed local disk.',
    inputSchema: z.object({
      action: z.enum(['status', 'download']),
      password: z.string().optional(),
      destinationPath: z.string().optional(),
    }),
    handler: async (args, client) => {
      if (args.action === 'status') return getUserExportStatus(client);
      return downloadUserExport(client, args.password, args.destinationPath);
    },
  },
  {
    name: 'vikunja_templates',
    description: 'Manage machine-local task templates or instantiate one in an explicit project.',
    inputSchema: z.object({
      action: z.enum(['create', 'list', 'get', 'delete', 'instantiate']),
      templateSelector: z.string().trim().min(1).optional(),
      name: z.string().trim().min(1).optional(),
      fields: z
        .object({
          title: z.string().trim().min(1),
          description: z.string().optional(),
          priority: z.number().int().min(0).max(5).optional(),
          dueDate: z.string().nullable().optional(),
        })
        .optional(),
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      variables: z.record(z.string()).optional(),
    }),
    handler: async (args, client) => {
      switch (args.action) {
        case 'list':
          return templateStore.list();
        case 'create':
          if (!args.name) throw badRequest('name is required for template create.');
          if (!args.fields) throw badRequest('fields is required for template create.');
          return templateStore.create(args.name, args.fields);
        case 'get':
          if (!args.templateSelector) throw badRequest('templateSelector is required.');
          return templateStore.get(args.templateSelector);
        case 'delete':
          if (!args.templateSelector) throw badRequest('templateSelector is required.');
          return templateStore.delete(args.templateSelector);
        case 'instantiate':
          if (!args.templateSelector) throw badRequest('templateSelector is required.');
          if (!args.projectSelector) throw badRequest('projectSelector is required.');
          return instantiateTemplate(
            client,
            templateStore,
            args.templateSelector,
            args.projectSelector,
            args.variables,
          );
        default:
          throw badRequest(`Unknown templates action: ${args.action}`);
      }
    },
  },
  {
    name: 'vikunja_webhooks',
    description: 'List webhook events or manage project-scoped and user-scoped webhooks.',
    inputSchema: z.object({
      action: z.enum(['events', 'list', 'create', 'update', 'delete']),
      scope: z.enum(['project', 'user']).optional(),
      projectSelector: z
        .object({
          id: z.number().int().positive().optional(),
          title: z.string().trim().min(1).optional(),
        })
        .optional(),
      webhookId: z.number().int().positive().optional(),
      targetUrl: z.string().url().optional(),
      events: z.array(z.string().trim().min(1)).optional(),
      secret: z.string().optional(),
      basicAuthUser: z.string().optional(),
      basicAuthPassword: z.string().optional(),
    }),
    handler: async (args, client) => {
      if (args.action === 'events') return listWebhookEvents(client, args.scope);
      const project = args.scope === 'user' ? undefined : args.projectSelector;
      if (args.scope !== 'user' && !project) {
        throw badRequest('projectSelector is required unless scope is user.');
      }
      if (args.action === 'list') return listWebhooks(client, project);
      if (!args.webhookId && ['update', 'delete'].includes(args.action)) {
        throw badRequest('webhookId is required for update and delete.');
      }
      if (args.action === 'delete') return deleteWebhook(client, args.webhookId!, project);
      if (!args.events?.length) throw badRequest('events is required.');
      if (args.action === 'update') {
        if (
          args.targetUrl !== undefined ||
          args.secret !== undefined ||
          args.basicAuthUser !== undefined ||
          args.basicAuthPassword !== undefined
        ) {
          throw badRequest(
            'Webhook update accepts only events; target and credentials are immutable.',
          );
        }
        return updateWebhook(client, args.webhookId!, project, args.events);
      }
      if (!args.targetUrl) throw badRequest('targetUrl is required for create.');
      const secrets = {
        secret: args.secret,
        basicAuthUser: args.basicAuthUser,
        basicAuthPassword: args.basicAuthPassword,
      };
      return createWebhook(client, project, args.targetUrl, args.events, secrets);
    },
  },
];

const legacyTaskTool = TOOLS.find((tool) => tool.name === 'vikunja_tasks');
if (!legacyTaskTool) throw new Error('Internal task router is not registered.');
TOOLS.push(
  ...createTypedTaskTools((args, client) => legacyTaskTool.handler(args, client)),
);

function getActiveTools(): McpToolDefinition[] {
  return selectToolsForProfile(TOOLS, loadToolProfile());
}

// Register Stdio Handlers
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: getActiveTools().map((t) => ({
      name: t.name,
      description: toolDescription(t),
      inputSchema: addActionRequirements(t.name, zodToMcpSchema(t.inputSchema)),
    })),
  };
});

const TASK_MUTATIONS = new Set([
  'update',
  'delete',
  'close',
  'reopen',
  'close_with_evidence',
  'assign',
  'unassign',
  'apply-label',
  'remove-label',
  'set_status',
  'relate',
  'unrelate',
  'attach',
  'delete-attachment',
]);

function enforceToolMutationScope(
  name: string,
  args: Record<string, any>,
  client: VikunjaApiClient,
): void {
  const mode = client.getConfig().mutationScopeMode ?? 'require';
  if (
    ['vikunja_tasks', 'vikunja_task_write', 'vikunja_task_workflow'].includes(name) &&
    TASK_MUTATIONS.has(args.action)
  ) {
    enforceMutationProjectScope(
      mode,
      `${name}.${args.action}`,
      args.taskSelector,
      args.projectSelector,
    );
  } else if (name === 'vikunja_task_attachments' && ['attach', 'delete'].includes(args.action)) {
    enforceMutationProjectScope(
      mode,
      `${name}.${args.action}`,
      args.taskSelector,
      args.projectSelector,
    );
  } else if (
    name === 'vikunja_task_comments' &&
    ['create', 'update', 'delete'].includes(args.action)
  ) {
    enforceMutationProjectScope(
      mode,
      `${name}.${args.action}`,
      args.taskSelector,
      args.projectSelector,
    );
  } else if (name === 'vikunja_task_reminders' && ['add', 'remove'].includes(args.action)) {
    enforceMutationProjectScope(
      mode,
      `${name}.${args.action}`,
      args.taskSelector,
      args.projectSelector,
    );
  } else if (
    name === 'vikunja_task_bulk' &&
    ['update', 'delete', 'assign', 'unassign'].includes(args.action) &&
    Array.isArray(args.taskSelectors) &&
    args.taskSelectors.length > 0
  ) {
    for (const selector of args.taskSelectors) {
      enforceMutationProjectScope(
        mode,
        `${name}.${args.action} (${args.taskSelectors.length} tasks)`,
        selector,
        args.projectSelector,
      );
    }
  }
}

function compactWriteTarget(target: any): any {
  return {
    id: target.id,
    portalRef: target.portalRef || target.identifier || `#${target.index}`,
    title: target.title,
    project: {
      id: target.project?.id,
      title: target.project?.title,
    },
  };
}

function compactWriteEchoes(result: any): any {
  if (!result || typeof result !== 'object') return result;
  let compact = result;
  if (result.action && result.target) {
    compact = { ...result, target: compactWriteTarget(result.target) };
  }
  if (result.task?.action && result.task?.target) {
    compact = {
      ...compact,
      task: {
        ...result.task,
        target: compactWriteTarget(result.task.target),
      },
    };
  }
  return compact;
}

function structuredOnlyMode(mode: unknown): boolean {
  return mode === 'minimal' || mode === 'receipt';
}

function requestedResponseMode(args: any): string {
  if (typeof args?.responseMode === 'string') return args.responseMode;
  return process.env.VIKUNJA_MCP_RESPONSE_MODE?.trim() || 'minimal';
}

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = getActiveTools().find((t) => t.name === name);

  if (!tool) {
    const envelope = safeEnvelopeText(
      formatFailureEnvelope(
        'Unknown tool.',
        toErrorEnvelope(badRequest(`Tool not found: ${name}`)).error,
        { structuredOnly: structuredOnlyMode(requestedResponseMode(args)) },
      ),
    );
    return {
      isError: true,
      content: [{ type: 'text', text: envelope }],
    };
  }

  // Parse args
  let parsedArgs: any;
  try {
    parsedArgs = tool.inputSchema.strict().parse(args || {});
  } catch (err: any) {
    const envelope = safeEnvelopeText(
      formatFailureEnvelope(
        'Invalid tool arguments.',
        toErrorEnvelope(
          new VikunjaError({
            status: 400,
            code: 'VALIDATION_ERROR',
            method: 'TOOLS_CALL',
            path: name,
            message: err.message || 'Invalid tool arguments',
            fieldErrors: [],
          }),
        ).error,
        { structuredOnly: structuredOnlyMode(requestedResponseMode(args)) },
      ),
    );
    return {
      isError: true,
      content: [{ type: 'text', text: envelope }],
    };
  }

  // Load config & instantiate client
  let client: VikunjaApiClient;
  try {
    const config = loadConfig();
    client = new VikunjaApiClient(config);
  } catch (err: any) {
    // If config fails, only self_check is allowed to proceed (to report diagnostics)
    if (name === 'self_check' || (name === 'vikunja_auth' && parsedArgs.action === 'self-check')) {
      client = new VikunjaApiClient({
        vikunjaUrl: 'http://localhost/api/v2',
        vikunjaToken: 'dummy',
        vikunjaWebUrl: 'http://localhost/',
        attachmentDownloadRoot: '/tmp',
      });
    } else {
      const envelope = safeEnvelopeText(
        formatFailureEnvelope('Configuration error.', toErrorEnvelope(err).error, {
          structuredOnly: structuredOnlyMode(requestedResponseMode(parsedArgs)),
        }),
      );
      return {
        isError: true,
        content: [{ type: 'text', text: envelope }],
      };
    }
  }

  try {
    enforceToolMutationScope(name, parsedArgs, client);
    const rawResult = await tool.handler(parsedArgs, client);
    const effectiveResponseMode =
      parsedArgs.responseMode ?? client.getConfig().responseMode ?? 'minimal';
    const result =
      [
        'vikunja_tasks',
        'vikunja_task_write',
        'vikunja_task_workflow',
        'vikunja_task_bulk',
      ].includes(name) &&
      ['minimal', 'receipt', 'compact'].includes(effectiveResponseMode)
        ? compactWriteEchoes(rawResult)
        : rawResult;
    const summary = summaryFor(name, parsedArgs, result, client.getConfig().vikunjaWebUrl);
    // Diagnostics carry their own `ok`. A failed self-check must surface as an
    // error envelope so an agent checking only the outer `ok` sees the failure.
    const isDiag =
      name === 'self_check' || (name === 'vikunja_auth' && parsedArgs.action === 'self-check');
    if (isDiag && result && result.ok === false) {
      // Standard error shape for agents; full diagnostics nested under details.
      const errorPayload = {
        status: 503,
        code: 'SELF_CHECK_FAILED',
        method: 'SELF_CHECK',
        path: name,
        message: summary,
        fieldErrors: [] as { location: string; message: string }[],
        details: result.diagnostics ?? result,
      };
      return {
        isError: true,
        content: [
          {
            type: 'text',
            text: safeEnvelopeText(
              formatFailureEnvelope(summary, errorPayload, {
                structuredOnly: structuredOnlyMode(effectiveResponseMode),
              }),
              client.getConfig().vikunjaToken,
            ),
          },
        ],
      };
    }
    return {
      content: [
        {
          type: 'text',
          text: safeEnvelopeText(
            formatSuccessEnvelope(summary, result, {
              structuredOnly: ['minimal', 'receipt'].includes(effectiveResponseMode),
            }),
            client.getConfig().vikunjaToken,
          ),
        },
      ],
    };
  } catch (err: any) {
    const failure = toErrorEnvelope(err, client.getConfig().vikunjaToken);
    const envelope = safeEnvelopeText(
      formatFailureEnvelope(
        `ERROR ${failure.error.code}: ${safeSummaryText(failure.error.message)}`,
        failure.error,
        {
          structuredOnly: structuredOnlyMode(
            parsedArgs.responseMode ?? client.getConfig().responseMode ?? 'minimal',
          ),
        },
      ),
      client.getConfig().vikunjaToken,
    );
    return {
      isError: true,
      content: [{ type: 'text', text: envelope }],
    };
  }
});

export function pathsReferToSameFile(left: string, right: string): boolean {
  const canonicalize = (candidate: string): string => {
    try {
      const realPath = fs.realpathSync.native(path.resolve(candidate));
      return process.platform === 'win32' ? realPath.toLowerCase() : realPath;
    } catch {
      const resolved = path.resolve(candidate);
      return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
    }
  };
  return canonicalize(left) === canonicalize(right);
}

// Compare real paths so versioned junctions such as `current` still start.
const isDirectEntryPoint =
  !!process.argv[1] && pathsReferToSameFile(process.argv[1], fileURLToPath(import.meta.url));
if (
  isDirectEntryPoint &&
  process.env.NODE_ENV !== 'test' &&
  !process.argv.includes('--check') &&
  !process.argv.includes('--help')
) {
  const transport = new StdioServerTransport();
  server.connect(transport).catch((e) => {
    // Redact before logging so a token can never reach stderr.
    console.error(redactSecrets(e?.stack || e?.message || String(e)));
  });
}

export function getVersion(): string {
  return PACKAGE_VERSION;
}
