import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import { VikunjaApiClient } from './api.js';
import {
  openSafeDestination,
  resolveSafePath,
  resolveSafeSourceFile,
  sanitizeHeaderFilename,
} from './attachments.js';
import { htmlToMarkdown, normalizePagination, toItemArray } from './format.js';
import { resolveProject } from './identity.js';
import { VikunjaError } from './errors.js';

function fileError(message: string): VikunjaError {
  return new VikunjaError({
    status: 400,
    code: 'VALIDATION_ERROR',
    method: 'TOOLS_CALL',
    path: 'filePath',
    message,
    fieldErrors: [],
  });
}

function multipart(fileName: string, file: Buffer, config?: unknown) {
  const boundary = `----VikunjaMcpBoundary${crypto.randomBytes(16).toString('hex')}`;
  const parts: Buffer[] = [];
  if (config !== undefined) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="config"\r\n\r\n${JSON.stringify(config)}\r\n`,
      ),
    );
  }
  const safeName = sanitizeHeaderFilename(fileName);
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="import"; filename="${safeName}"\r\nContent-Type: text/csv\r\n\r\n`,
    ),
  );
  parts.push(file, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

async function csvRequest(
  client: VikunjaApiClient,
  action: 'detect' | 'preview' | 'migrate',
  filePath: string,
  config?: unknown,
) {
  let stat;
  let safePath: string;
  try {
    safePath = await resolveSafeSourceFile(
      client.getConfig().attachmentSourceRoots ?? [process.cwd(), os.tmpdir()],
      filePath,
    );
    stat = await fs.stat(safePath);
  } catch (error) {
    if (error instanceof VikunjaError) throw error;
    throw fileError('CSV import file does not exist or cannot be read.');
  }
  const max = client.getConfig().maxAttachmentBytes ?? 100 * 1024 * 1024;
  if (!stat.isFile() || stat.size > max)
    throw fileError('CSV import file is invalid or exceeds the configured size limit.');
  const form = multipart(safePath, await fs.readFile(safePath), config);
  return client.request<any>('POST', `/migration/csv/${action}`, {
    body: form.body,
    headers: { 'Content-Type': form.contentType },
    isMultipart: true,
  });
}

export async function detectCsvImport(client: VikunjaApiClient, filePath: string) {
  const value: any = await csvRequest(client, 'detect', filePath);
  return {
    columns: Array.isArray(value.columns) ? value.columns : [],
    dateFormat: value.date_format || null,
    delimiter: value.delimiter || null,
    quoteChar: value.quote_char || null,
    previewRows: Array.isArray(value.preview_rows) ? value.preview_rows : [],
    suggestedMapping: Array.isArray(value.suggested_mapping)
      ? value.suggested_mapping.map((mapping: any) => ({
          columnIndex: mapping.column_index,
          columnName: mapping.column_name,
          attribute: mapping.attribute,
        }))
      : [],
  };
}

export async function previewCsvImport(
  client: VikunjaApiClient,
  filePath: string,
  config: unknown,
) {
  const value = await csvRequest(client, 'preview', filePath, config);
  return {
    totalRows: value.total_rows ?? 0,
    tasks: Array.isArray(value.tasks)
      ? value.tasks.map((task: any) => ({
          title: task.title || '',
          description: task.description || '',
          done: !!task.done,
          priority: task.priority || 0,
          project: task.project || null,
          dueDate: normalizeDate(task.due_date),
          startDate: normalizeDate(task.start_date),
          endDate: normalizeDate(task.end_date),
          labels: Array.isArray(task.labels) ? task.labels : [],
        }))
      : [],
  };
}

export async function startCsvImport(client: VikunjaApiClient, filePath: string, config: unknown) {
  const value: any = await csvRequest(client, 'migrate', filePath, config);
  return { started: true, message: value.message || 'CSV import completed.' };
}

export async function getCsvImportStatus(client: VikunjaApiClient) {
  const value: any = await client.request('GET', '/migration/csv/status');
  return {
    id: value.id,
    migratorName: value.migrator_name || 'csv',
    startedAt: normalizeDate(value.started_at),
    finishedAt: normalizeDate(value.finished_at),
  };
}

function normalizeDate(value: unknown): string | null {
  if (!value || String(value).startsWith('0001-01-01')) return null;
  return String(value);
}

const DEFAULT_EXPORT_TASK_LIMIT = 1000;
const DEFAULT_RICH_EXPORT_TASK_LIMIT = 1000;
const DEFAULT_EXPORT_DETAIL_LIMIT = 100;

async function fetchBoundedCollection<T>(
  client: VikunjaApiClient,
  basePath: string,
  limit: number,
  code: string,
): Promise<T[]> {
  const items: T[] = [];
  const perPage = Math.min(100, limit);
  for (let page = 1; ; page += 1) {
    const separator = basePath.includes('?') ? '&' : '?';
    const response = await client.request<any>(
      'GET',
      `${basePath}${separator}page=${page}&per_page=${perPage}`,
    );
    const pagination = normalizePagination(response);
    if (pagination.total > limit) {
      throw new VikunjaError({
        status: 413,
        code,
        method: 'GET',
        path: basePath,
        message: `Export source contains ${pagination.total} items, exceeding the configured limit of ${limit}.`,
        fieldErrors: [],
      });
    }
    const pageItems = toItemArray<T>(response);
    items.push(...pageItems);
    if (items.length > limit) {
      throw new VikunjaError({
        status: 413,
        code,
        method: 'GET',
        path: basePath,
        message: `Export source exceeds the configured limit of ${limit} items.`,
        fieldErrors: [],
      });
    }
    if (pageItems.length === 0 || page >= pagination.totalPages) break;
  }
  return items;
}

export async function getUserExportStatus(client: VikunjaApiClient) {
  const value = await client.request<any>('GET', '/user/export');
  if (!value || typeof value !== 'object' || !Number.isInteger(Number(value.id))) {
    return { available: false };
  }
  return {
    available: true,
    id: value.id,
    size: value.size,
    created: value.created || null,
    expires: value.expires || null,
  };
}

export async function requestUserExport(client: VikunjaApiClient, password = '') {
  const value: any = await client.request('POST', '/user/export/request', { body: { password } });
  return { requested: true, message: value?.message || 'User export requested.' };
}

function downloadTooLarge(bytes: number, maxBytes: number): VikunjaError {
  return new VikunjaError({
    status: 413,
    code: 'ATTACHMENT_TOO_LARGE',
    method: 'POST',
    path: '/user/export/download',
    message: `User export is ${bytes} bytes, exceeding the ${maxBytes}-byte limit.`,
    fieldErrors: [],
  });
}

function downloadSizeMismatch(bytes: number, expectedBytes: number): VikunjaError {
  return new VikunjaError({
    status: 500,
    code: 'SIZE_MISMATCH',
    method: 'POST',
    path: '/user/export/download',
    message: `User export verification failed: downloaded ${bytes} of ${expectedBytes} advertised bytes.`,
    fieldErrors: [],
  });
}

async function streamResponse(
  response: Response,
  root: string,
  destination: string,
  maxBytes: number,
  overwrite = false,
): Promise<number> {
  const contentLength = response.headers.get('Content-Length');
  const advertised = contentLength === null ? undefined : Number(contentLength);
  if (advertised !== undefined && Number.isFinite(advertised) && advertised > maxBytes) {
    if (typeof response.body?.cancel === 'function') {
      await response.body.cancel().catch(() => {});
    }
    throw downloadTooLarge(advertised, maxBytes);
  }
  let size = 0;
  const { handle } = await openSafeDestination(root, destination, overwrite);
  try {
    if (!response.body) throw new Error('Download response had no body.');
    for await (const chunk of response.body as any) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw downloadTooLarge(size, maxBytes);
      await handle.write(buffer);
    }
    if (advertised !== undefined && Number.isFinite(advertised) && size !== advertised) {
      throw downloadSizeMismatch(size, advertised);
    }
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(destination).catch(() => {});
    throw error;
  }
  await handle.close();
  return size;
}

export async function downloadUserExport(
  client: VikunjaApiClient,
  password = '',
  destinationPath = 'vikunja-user-export.zip',
  overwrite = false,
) {
  const root = client.getConfig().attachmentDownloadRoot;
  const destination = resolveSafePath(root, destinationPath);
  const response = await client.request<Response>('POST', '/user/export/download', {
    body: { password },
    isStreamResponse: true,
  });
  const maxBytes = client.getConfig().maxAttachmentBytes ?? 100 * 1024 * 1024;
  const size = await streamResponse(response, root, destination, maxBytes, overwrite);
  return { path: destination, size };
}

function csvCell(value: unknown) {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text.trimStart())) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeExportFile(
  root: string,
  destination: string,
  content: string,
  overwrite = false,
): Promise<void> {
  const { handle } = await openSafeDestination(root, destination, overwrite);
  try {
    await handle.writeFile(content);
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(destination).catch(() => {});
    throw error;
  }
  await handle.close();
}

export async function exportProject(
  client: VikunjaApiClient,
  selector: { id?: number; title?: string },
  format: 'json' | 'csv' = 'json',
  destinationPath?: string,
  includeComments = false,
  includeAttachments = false,
  includeRelations = false,
  limits: { taskLimit?: number; detailLimit?: number } = {},
  overwrite = false,
) {
  const project = await resolveProject(client, selector);
  const rich = includeComments || includeAttachments || includeRelations;
  const taskLimit =
    limits.taskLimit ?? (rich ? DEFAULT_RICH_EXPORT_TASK_LIMIT : DEFAULT_EXPORT_TASK_LIMIT);
  const detailLimit = limits.detailLimit ?? DEFAULT_EXPORT_DETAIL_LIMIT;
  const raw = await fetchBoundedCollection<any>(
    client,
    `/projects/${project.id}/tasks`,
    taskLimit,
    'EXPORT_TASK_LIMIT_EXCEEDED',
  );
  const tasks: any[] = raw.map((task) => ({
    id: task.id,
    index: task.index,
    identifier: task.identifier,
    title: task.title,
    description: task.description ? htmlToMarkdown(task.description) : '',
    done: !!task.done,
    priority: task.priority || 0,
    dueDate: normalizeDate(task.due_date),
    updated: normalizeDate(task.updated),
    creator: task.created_by
      ? { id: task.created_by.id, username: task.created_by.username }
      : null,
    labels: Array.isArray(task.labels) ? task.labels.map((label: any) => label.title) : [],
    assignees: Array.isArray(task.assignees)
      ? task.assignees.map((user: any) => user.username)
      : [],
  }));

  if (rich) {
    for (let offset = 0; offset < tasks.length; offset += 5) {
      await Promise.all(
        tasks.slice(offset, offset + 5).map(async (task) => {
          if (includeComments) {
            const comments = await fetchBoundedCollection<any>(
              client,
              `/tasks/${task.id}/comments`,
              detailLimit,
              'EXPORT_DETAIL_LIMIT_EXCEEDED',
            );
            task.comments = comments.map((comment) => ({
              id: comment.id,
              comment: comment.comment ? htmlToMarkdown(comment.comment) : '',
              author: comment.author
                ? { id: comment.author.id, username: comment.author.username }
                : null,
              created: normalizeDate(comment.created),
              updated: normalizeDate(comment.updated),
            }));
            task.commentCount = task.comments.length;
          }
          if (includeAttachments) {
            const attachments = await fetchBoundedCollection<any>(
              client,
              `/tasks/${task.id}/attachments`,
              detailLimit,
              'EXPORT_DETAIL_LIMIT_EXCEEDED',
            );
            task.attachments = attachments.map((attachment) => ({
              id: attachment.id,
              fileName: attachment.file?.name || attachment.file_name || 'unknown',
              mime: attachment.file?.mime || attachment.mime || 'application/octet-stream',
              fileSize: attachment.file?.size || attachment.file_size || 0,
            }));
            task.attachmentCount = task.attachments.length;
          }
          if (includeRelations) {
            const detail = await client.request<any>('GET', `/tasks/${task.id}`);
            const relatedTasks = detail.related_tasks ?? {};
            task.relations = Object.entries(relatedTasks).flatMap(([kind, related]) =>
              Array.isArray(related)
                ? related.map((item: any) => ({
                    kind,
                    taskId: item.id,
                    identifier: item.identifier || (item.index ? `#${item.index}` : null),
                    title: item.title,
                  }))
                : [],
            );
            if (task.relations.length > detailLimit) {
              throw new VikunjaError({
                status: 413,
                code: 'EXPORT_DETAIL_LIMIT_EXCEEDED',
                method: 'GET',
                path: `/tasks/${task.id}`,
                message: `Task relations exceed the configured limit of ${detailLimit}.`,
                fieldErrors: [],
              });
            }
            task.relationCount = task.relations.length;
          }
        }),
      );
    }
  }
  const fileName = destinationPath || `project-${project.id}-tasks.${format}`;
  const exportRoot = client.getConfig().attachmentDownloadRoot;
  const destination = resolveSafePath(exportRoot, fileName);
  if (format === 'json') {
    await writeExportFile(
      exportRoot,
      destination,
      JSON.stringify({ project, tasks }, null, 2),
      overwrite,
    );
  } else {
    const header = [
      'id',
      'index',
      'identifier',
      'title',
      'description',
      'done',
      'priority',
      'dueDate',
      'updated',
      'creatorId',
      'creatorUsername',
      'labels',
      'assignees',
      ...(includeComments ? ['commentCount', 'comments'] : []),
      ...(includeAttachments ? ['attachmentCount', 'attachments'] : []),
      ...(includeRelations ? ['relationCount', 'relations'] : []),
    ];
    const csvTasks = tasks.map((task) => ({
      ...task,
      creatorId: task.creator?.id ?? '',
      creatorUsername: task.creator?.username ?? '',
      ...(includeComments ? { comments: JSON.stringify(task.comments) } : {}),
      ...(includeAttachments ? { attachments: JSON.stringify(task.attachments) } : {}),
      ...(includeRelations ? { relations: JSON.stringify(task.relations) } : {}),
    }));
    const lines = [
      header.join(','),
      ...csvTasks.map((task) =>
        header
          .map((field) =>
            csvCell(
              (task as any)[field] instanceof Array
                ? (task as any)[field].join(';')
                : (task as any)[field],
            ),
          )
          .join(','),
      ),
    ];
    await writeExportFile(exportRoot, destination, `${lines.join('\n')}\n`, overwrite);
  }
  return { project, format, path: destination, taskCount: tasks.length };
}
