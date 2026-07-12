import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { VikunjaApiClient } from './api.js';
import { resolveSafePath } from './attachments.js';
import { fetchAllCollectionItems, htmlToMarkdown } from './format.js';
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
  const safeName = path.basename(fileName).replace(/["\r\n]/g, '_');
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
  try {
    stat = await fs.stat(filePath);
  } catch {
    throw fileError('CSV import file does not exist or cannot be read.');
  }
  const max = client.getConfig().maxAttachmentBytes ?? 100 * 1024 * 1024;
  if (!stat.isFile() || stat.size > max)
    throw fileError('CSV import file is invalid or exceeds the configured size limit.');
  const form = multipart(filePath, await fs.readFile(filePath), config);
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

export async function getUserExportStatus(client: VikunjaApiClient) {
  const value = await client.request<any>('GET', '/user/export');
  if (!value) return { available: false };
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

async function streamResponse(
  response: Response,
  destination: string,
  maxBytes: number,
): Promise<number> {
  const advertised = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(advertised) && advertised > maxBytes) {
    throw downloadTooLarge(advertised, maxBytes);
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  let size = 0;
  const handle = await fs.open(destination, 'wx');
  try {
    if (!response.body) throw new Error('Download response had no body.');
    for await (const chunk of response.body as any) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw downloadTooLarge(size, maxBytes);
      await handle.write(buffer);
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
) {
  const root = client.getConfig().attachmentDownloadRoot;
  const destination = resolveSafePath(root, destinationPath);
  const response = await client.request<Response>('POST', '/user/export/download', {
    body: { password },
    isStreamResponse: true,
  });
  const maxBytes = client.getConfig().maxAttachmentBytes ?? 100 * 1024 * 1024;
  const size = await streamResponse(response, destination, maxBytes);
  return { path: destination, size };
}

function csvCell(value: unknown) {
  const text = value === null || value === undefined ? '' : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export async function exportProject(
  client: VikunjaApiClient,
  selector: { id?: number; title?: string },
  format: 'json' | 'csv' = 'json',
  destinationPath?: string,
  includeComments = false,
) {
  const project = await resolveProject(client, selector);
  const raw = await fetchAllCollectionItems<any>(
    (requestPath) => client.request('GET', requestPath),
    `/projects/${project.id}/tasks`,
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
    creator: task.created_by
      ? { id: task.created_by.id, username: task.created_by.username }
      : null,
    labels: Array.isArray(task.labels) ? task.labels.map((label: any) => label.title) : [],
    assignees: Array.isArray(task.assignees)
      ? task.assignees.map((user: any) => user.username)
      : [],
  }));

  if (includeComments) {
    for (const task of tasks) {
      const comments = await fetchAllCollectionItems<any>(
        (requestPath) => client.request('GET', requestPath),
        `/tasks/${task.id}/comments`,
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
    }
  }
  const fileName = destinationPath || `project-${project.id}-tasks.${format}`;
  const destination = resolveSafePath(client.getConfig().attachmentDownloadRoot, fileName);
  await fs.mkdir(path.dirname(destination), { recursive: true });
  if (format === 'json') {
    await fs.writeFile(destination, JSON.stringify({ project, tasks }, null, 2), { flag: 'wx' });
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
      'creatorId',
      'creatorUsername',
      'labels',
      'assignees',
      ...(includeComments ? ['comments'] : []),
    ];
    const csvTasks = tasks.map((task) => ({
      ...task,
      creatorId: task.creator?.id ?? '',
      creatorUsername: task.creator?.username ?? '',
      ...(includeComments ? { comments: JSON.stringify(task.comments) } : {}),
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
    await fs.writeFile(destination, `${lines.join('\n')}\n`, { flag: 'wx' });
  }
  return { project, format, path: destination, taskCount: tasks.length };
}
