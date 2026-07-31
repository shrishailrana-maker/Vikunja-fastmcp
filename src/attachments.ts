/**
 * Attachment upload/download with path sandboxing and size limits.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { VikunjaApiClient } from './api.js';
import { resolveTaskInput as resolveTask, type TaskSelectorInput } from './identity.js';
import { redactSecrets, VikunjaError } from './errors.js';
import { runDurableOperation } from './idempotency.js';
import { DEFAULT_MAX_ATTACHMENT_BYTES } from './config.js';
import { fetchAllCollectionItems, normalizePagination, toItemArray } from './format.js';
import path from 'path';
import fs from 'fs/promises';
import crypto from 'crypto';
import { createReadStream } from 'node:fs';

export interface AttachmentInfo {
  id: number;
  fileName: string;
  mime: string;
  fileSize: number;
  created: string;
}

export interface AttachmentListOptions {
  page?: number;
  perPage?: number;
  countOnly?: boolean;
  filenamePrefix?: string;
}

export interface AttachmentListResult {
  task: { id: number; portalRef: string; title: string };
  attachments: AttachmentInfo[];
  page: number;
  perPage: number;
  total: number;
  hasMore: boolean;
  nextPage: number | null;
  countOnly: boolean;
}

export interface DeleteAttachmentResult {
  action: 'deleted';
  task: { id: number; portalRef: string; title: string };
  attachment: AttachmentInfo;
  remainingAttachmentCount: number;
  actor: string;
}

function normalizeAttachment(att: any): AttachmentInfo {
  return {
    id: att.id,
    fileName: att.file?.name || att.file_name || 'unknown',
    mime: att.file?.mime || att.mime || 'application/octet-stream',
    fileSize: att.file?.size || att.file_size || 0,
    created: att.created,
  };
}

function attachmentTaskSummary(task: {
  id: number;
  index: number;
  identifier?: string;
  title: string;
}): { id: number; portalRef: string; title: string } {
  return {
    id: task.id,
    portalRef: task.identifier || `#${task.index}`,
    title: task.title,
  };
}

async function fetchAllAttachments(
  client: VikunjaApiClient,
  taskId: number,
  filenamePrefix?: string,
): Promise<AttachmentInfo[]> {
  const prefix = filenamePrefix?.trim();
  const query = prefix ? `?q=${encodeURIComponent(prefix)}` : '';
  const raw = await fetchAllCollectionItems<any>(
    (requestPath) => client.request<any>('GET', requestPath),
    `/tasks/${taskId}/attachments${query}`,
    1000,
  );
  const normalized = raw.map(normalizeAttachment);
  if (!prefix) return normalized;
  const foldedPrefix = prefix.toLocaleLowerCase();
  return normalized.filter((attachment) =>
    attachment.fileName.toLocaleLowerCase().startsWith(foldedPrefix),
  );
}

// Minimal extension→MIME map for local-file uploads where the caller did not
// supply an explicit type. Anything unknown falls back to octet-stream.
const MIME_BY_EXT: Record<string, string> = {
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.html': 'text/html',
  '.xml': 'application/xml',
};

export function inferMimeType(filename: string): string {
  return MIME_BY_EXT[path.extname(filename).toLowerCase()] || 'application/octet-stream';
}

function maxBytesFor(client: VikunjaApiClient): number {
  return client.getConfig().maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
}

// Drop control characters (codepoints < 0x20 plus DEL). Done by codepoint rather
// than a regex so it does not trip eslint's no-control-regex rule.
function stripControlChars(s: string): string {
  return Array.from(s)
    .filter((ch) => {
      const c = ch.codePointAt(0) ?? 0;
      return c >= 0x20 && c !== 0x7f;
    })
    .join('');
}

// Neutralize a filename before it enters a multipart Content-Disposition header.
// A raw filename can carry CR/LF (to inject extra headers or smuggle another
// part) or a double-quote (to break out of filename="..."). Strip path
// components and control chars, then escape backslash and quote per RFC 7578.
function sanitizeHeaderFilename(name: string): string {
  const base = stripControlChars(name.split(/[\\/]/).pop() ?? 'file');
  const escaped = base.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return escaped.trim() === '' ? 'file' : escaped;
}

// Only a well-formed MIME token pair is allowed into the Content-Type header;
// anything else (including CR/LF injection attempts) falls back to a safe type.
function sanitizeMimeType(mime: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*$/.test(mime)
    ? mime
    : 'application/octet-stream';
}

// Estimate decoded byte length from a base64 string so an oversized payload can
// be rejected before it is materialized into a Buffer.
function estimatedBase64Bytes(b64: string): number {
  const s = b64.replace(/\s/g, '');
  const padding = s.endsWith('==') ? 2 : s.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((s.length * 3) / 4) - padding);
}

function decodeBase64(base64Content: string, pathUrl: string): Buffer {
  const normalized = base64Content.replace(/\s/g, '');
  const hasValidAlphabet = /^[A-Za-z0-9+/]*={0,2}$/.test(normalized);
  const hasValidLength = normalized.length % 4 !== 1;
  const hasValidPadding = !normalized.includes('=') || normalized.length % 4 === 0;
  if (!normalized || !hasValidAlphabet || !hasValidLength || !hasValidPadding) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_BASE64',
      method: 'POST',
      path: pathUrl,
      message: 'Content is not valid base64 encoded data.',
      fieldErrors: [],
    });
  }

  const buffer = Buffer.from(normalized, 'base64');
  if (
    buffer.length === 0 ||
    buffer.toString('base64').replace(/=+$/, '') !== normalized.replace(/=+$/, '')
  ) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_BASE64',
      method: 'POST',
      path: pathUrl,
      message: 'Content is not valid base64 encoded data.',
      fieldErrors: [],
    });
  }
  return buffer;
}

export function resolveSafePath(root: string, target: string): string {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.isAbsolute(target)
    ? path.resolve(target)
    : path.resolve(root, target);

  // Containment must be tested on a path-separator boundary. A plain
  // startsWith lets a sibling directory whose name merely begins with the
  // root (e.g. "<root>-evil") slip through as if it were inside the root.
  const rootWithSep = absoluteRoot.endsWith(path.sep) ? absoluteRoot : absoluteRoot + path.sep;
  if (absoluteTarget !== absoluteRoot && !absoluteTarget.startsWith(rootWithSep)) {
    throw new VikunjaError({
      status: 403,
      code: 'FORBIDDEN',
      method: 'GET',
      path: '/attachments',
      message: `Access denied. Target path "${target}" lies outside the allowed download directory "${root}".`,
      fieldErrors: [],
    });
  }

  return absoluteTarget;
}

function forbiddenDestination(message: string): VikunjaError {
  return new VikunjaError({
    status: 403,
    code: 'FORBIDDEN',
    method: 'WRITE',
    path: '/downloads',
    message,
    fieldErrors: [],
  });
}

function fileExistsError(destination: string): VikunjaError {
  return new VikunjaError({
    status: 409,
    code: 'FILE_EXISTS',
    method: 'WRITE',
    path: '/downloads',
    message: `Refusing to overwrite existing file "${destination}". Pass overwrite=true to replace it.`,
    fieldErrors: [],
  });
}

export async function validateSafeDestination(
  root: string,
  target: string,
  overwrite = false,
): Promise<string> {
  const destination = resolveSafePath(root, target);
  const parent = path.dirname(destination);
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(parent, { recursive: true });

  const [realRoot, realParent] = await Promise.all([fs.realpath(root), fs.realpath(parent)]);
  const relativeParent = path.relative(realRoot, realParent);
  if (
    relativeParent.startsWith('..' + path.sep) ||
    relativeParent === '..' ||
    path.isAbsolute(relativeParent)
  ) {
    throw forbiddenDestination(
      'Download destination escapes the configured sandbox through a symbolic link.',
    );
  }

  try {
    const existing = await fs.lstat(destination);
    if (existing.isSymbolicLink()) {
      throw forbiddenDestination('Refusing to write through a symbolic-link destination.');
    }
    if (!existing.isFile()) {
      throw forbiddenDestination('Download destination must be a regular file.');
    }
    if (!overwrite) throw fileExistsError(destination);
  } catch (error: any) {
    if (error instanceof VikunjaError) throw error;
    if (error?.code !== 'ENOENT') throw error;
  }

  return destination;
}

export async function openSafeDestination(root: string, target: string, overwrite = false) {
  const destination = await validateSafeDestination(root, target, overwrite);
  try {
    return { destination, handle: await fs.open(destination, overwrite ? 'w' : 'wx') };
  } catch (error: any) {
    if (error?.code === 'EEXIST') throw fileExistsError(destination);
    throw error;
  }
}

export async function uploadAttachment(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  filename: string,
  mimeType: string,
  base64Content: string,
  projectSelector?: { id?: number; title?: string },
  idempotencyKey?: string,
): Promise<AttachmentInfo> {
  const payload = {
    taskSelector,
    projectSelector,
    filename,
    mimeType,
    contentHash: crypto.createHash('sha256').update(base64Content).digest('hex'),
  };
  const execute = async (): Promise<AttachmentInfo> => {
    const task = await resolveTask(client, taskSelector, projectSelector);
    const pathUrl = `/tasks/${task.id}/attachments`;

    if (!filename || filename.trim() === '') {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_FILENAME',
        method: 'POST',
        path: pathUrl,
        message: 'Filename cannot be undefined or empty.',
        fieldErrors: [],
      });
    }
    if (!mimeType || mimeType.trim() === '') {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_MIME_TYPE',
        method: 'POST',
        path: pathUrl,
        message: 'Mime-type cannot be undefined or empty.',
        fieldErrors: [],
      });
    }
    if (!base64Content || base64Content.trim() === '') {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_CONTENT',
        method: 'POST',
        path: pathUrl,
        message: 'Base64 content cannot be undefined or empty.',
        fieldErrors: [],
      });
    }

    assertWithinSizeLimit(client, filename, estimatedBase64Bytes(base64Content), pathUrl);
    const fileBuffer = decodeBase64(base64Content, pathUrl);
    assertWithinSizeLimit(client, filename, fileBuffer.length, pathUrl);
    return uploadBufferToTask(client, task.id, filename, mimeType, fileBuffer);
  };

  return idempotencyKey
    ? runDurableOperation('attachment-upload', idempotencyKey, payload, execute)
    : execute();
}

// Throw a 413 when a single attachment exceeds the configured size ceiling.
function assertWithinSizeLimit(
  client: VikunjaApiClient,
  name: string,
  size: number,
  pathUrl: string,
): void {
  const max = maxBytesFor(client);
  if (size > max) {
    throw new VikunjaError({
      status: 413,
      code: 'ATTACHMENT_TOO_LARGE',
      method: 'POST',
      path: pathUrl,
      message: `Attachment "${name}" is ${size} bytes, exceeding the ${max}-byte limit.`,
      fieldErrors: [],
    });
  }
}

// Shared multipart upload primitive: streams one file to a task and returns the
// server's normalized metadata (read back so the caller can verify the upload).
async function uploadBufferToTask(
  client: VikunjaApiClient,
  taskId: number,
  filename: string,
  mimeType: string,
  fileBuffer: Buffer,
): Promise<AttachmentInfo> {
  const boundary = `----VikunjaMcpBoundary${crypto.randomBytes(16).toString('hex')}`;
  // Sanitize both values: they are caller-controlled and flow into raw header
  // lines, so an unescaped quote or CR/LF would allow header injection.
  const safeFilename = sanitizeHeaderFilename(filename);
  const safeMime = sanitizeMimeType(mimeType);
  const header = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="files"; filename="${safeFilename}"\r\n` +
      `Content-Type: ${safeMime}\r\n\r\n`,
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
  const bodyBuffer = Buffer.concat([header, fileBuffer, footer]);

  const pathUrl = `/tasks/${taskId}/attachments`;
  const uploadRes = await client.request<any>('POST', pathUrl, {
    body: bodyBuffer,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
    },
    isMultipart: true,
  });

  const successList = Array.isArray(uploadRes.success) ? uploadRes.success : [];
  if (successList.length === 0) {
    const errorList = Array.isArray(uploadRes.errors) ? uploadRes.errors : [];
    const firstErr = errorList[0]?.error || 'Unknown upload error';
    throw new VikunjaError({
      status: 500,
      code: 'UPLOAD_FAILED',
      method: 'POST',
      path: pathUrl,
      message: `Attachment upload failed: ${firstErr}`,
      fieldErrors: [],
    });
  }

  const att = successList[0];
  return {
    id: att.id,
    fileName: att.file?.name || filename,
    mime: att.file?.mime || mimeType,
    fileSize: att.file?.size || fileBuffer.length,
    created: att.created,
  };
}

// One item in an `attach` request: either a local file to read, or inline
// base64 content with an explicit filename.
export interface AttachFileSpec {
  filePath?: string;
  filename?: string;
  mimeType?: string;
  base64Content?: string;
}

export interface AttachResult {
  task: { id: number; portalRef: string; title: string };
  uploaded: AttachmentInfo[];
  failed: { file: string; error: string }[];
}

async function attachmentPayload(files: AttachFileSpec[]): Promise<unknown[]> {
  return Promise.all(
    files.map(async (file) => {
      let contentHash: string | undefined;
      if (file.base64Content !== undefined) {
        contentHash = crypto.createHash('sha256').update(file.base64Content).digest('hex');
      } else if (file.filePath) {
        try {
          const hash = crypto.createHash('sha256');
          for await (const chunk of createReadStream(file.filePath)) hash.update(chunk);
          contentHash = hash.digest('hex');
        } catch (error: any) {
          contentHash = `unreadable:${error?.code ?? 'error'}`;
        }
      }
      return {
        filePath: file.filePath,
        filename: file.filename,
        mimeType: file.mimeType,
        contentHash,
      };
    }),
  );
}

// Turn one spec into an in-memory buffer plus its filename and MIME type.
async function materializeFile(
  client: VikunjaApiClient,
  spec: AttachFileSpec,
  pathUrl: string,
): Promise<{ filename: string; mimeType: string; buffer: Buffer }> {
  if (spec.filePath) {
    const fileInfo = await fs.stat(spec.filePath);
    if (!fileInfo.isFile()) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_CONTENT',
        method: 'POST',
        path: pathUrl,
        message: `Attachment path "${spec.filePath}" is not a regular file.`,
        fieldErrors: [],
      });
    }
    assertWithinSizeLimit(client, spec.filePath, fileInfo.size, pathUrl);
    const buffer = await fs.readFile(spec.filePath);
    const filename = spec.filename || path.basename(spec.filePath);
    const mimeType = spec.mimeType || inferMimeType(filename);
    return { filename, mimeType, buffer };
  }
  if (spec.base64Content !== undefined) {
    if (!spec.filename || spec.filename.trim() === '') {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_FILENAME',
        method: 'POST',
        path: '/attachments',
        message: 'A filename is required when attaching base64 content.',
        fieldErrors: [],
      });
    }
    const buffer = decodeBase64(spec.base64Content, pathUrl);
    const mimeType = spec.mimeType || inferMimeType(spec.filename);
    return { filename: spec.filename, mimeType, buffer };
  }
  throw new VikunjaError({
    status: 400,
    code: 'INVALID_CONTENT',
    method: 'POST',
    path: '/attachments',
    message: 'Each attachment must provide either a filePath or base64Content.',
    fieldErrors: [],
  });
}

// Attach one or more files to a task. Files are uploaded one request each so a
// single failure is attributed to its file and never aborts the others; the
// result honestly separates uploaded metadata from per-file failures.
export async function attachFiles(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  files: AttachFileSpec[],
  projectSelector?: { id?: number; title?: string },
  idempotencyKey?: string,
): Promise<AttachResult> {
  if (!Array.isArray(files) || files.length === 0) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_CONTENT',
      method: 'POST',
      path: '/attachments',
      message: 'At least one file is required to attach.',
      fieldErrors: [],
    });
  }

  const task = await resolveTask(client, taskSelector, projectSelector);
  const payload = {
    taskId: task.id,
    files: idempotencyKey ? await attachmentPayload(files) : [],
  };
  const execute = async (): Promise<AttachResult> => {
    const pathUrl = `/tasks/${task.id}/attachments`;
    const uploaded: AttachmentInfo[] = [];
    const failed: { file: string; error: string }[] = [];

    for (const spec of files) {
      const label = spec.filePath || spec.filename || 'unnamed';
      try {
        if (spec.base64Content !== undefined) {
          assertWithinSizeLimit(client, label, estimatedBase64Bytes(spec.base64Content), pathUrl);
        }
        const { filename, mimeType, buffer } = await materializeFile(client, spec, pathUrl);
        if (buffer.length === 0) {
          throw new VikunjaError({
            status: 400,
            code: 'INVALID_CONTENT',
            method: 'POST',
            path: pathUrl,
            message: `Attachment "${label}" is empty.`,
            fieldErrors: [],
          });
        }
        assertWithinSizeLimit(client, filename, buffer.length, pathUrl);
        uploaded.push(await uploadBufferToTask(client, task.id, filename, mimeType, buffer));
      } catch (err: any) {
        failed.push({
          file: label,
          error: redactSecrets(err.message || 'Upload failed', client.getConfig().vikunjaToken),
        });
      }
    }

    return {
      task: {
        id: task.id,
        portalRef: task.identifier || `#${task.index}`,
        title: task.title,
      },
      uploaded,
      failed,
    };
  };

  return idempotencyKey
    ? runDurableOperation('attach', idempotencyKey, payload, execute)
    : execute();
}

export interface DownloadResult {
  success: boolean;
  path: string;
  fileName: string;
  mime: string;
  size: number;
  checksum: string; // sha256 hex of the downloaded bytes
  taskId: number;
  attachmentId: number;
  attachmentUrl: string; // authenticated API URL, no token embedded
  taskUrl: string; // browser-friendly link for a signed-in human
}

export async function downloadAttachment(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  attachmentId: number,
  destinationPath?: string,
  projectSelector?: { id?: number; title?: string },
  options: { overwrite?: boolean } = {},
): Promise<DownloadResult> {
  const task = await resolveTask(client, taskSelector, projectSelector);
  const config = client.getConfig();
  const downloadRoot = config.attachmentDownloadRoot;
  const maxBytes = maxBytesFor(client);

  // Decide where the file lands. An explicit destinationPath is honored (still
  // sandboxed to the download root); otherwise fall back to a deterministic
  // path <root>/<task-id>/<attachment-id>/<filename>, looking the filename up
  // from attachment metadata.
  let fileName: string;
  let safeDestPath: string;
  if (destinationPath && destinationPath.trim() !== '') {
    safeDestPath = resolveSafePath(downloadRoot, destinationPath);
    fileName = path.basename(safeDestPath);
  } else {
    const meta = (await listAttachments(client, task.id)).find((a) => a.id === attachmentId);
    fileName = path.basename(
      meta && meta.fileName && meta.fileName !== 'unknown'
        ? meta.fileName
        : `attachment-${attachmentId}`,
    );
    safeDestPath = resolveSafePath(
      downloadRoot,
      path.join(String(task.id), String(attachmentId), fileName),
    );
  }

  await validateSafeDestination(downloadRoot, safeDestPath, options.overwrite === true);

  const response = await client.request<Response>(
    'GET',
    `/tasks/${task.id}/attachments/${attachmentId}`,
    {
      isStreamResponse: true,
    },
  );

  // Enforce the size ceiling up front when the server advertises a length.
  const expectedSizeHeader = response.headers.get('Content-Length');
  if (expectedSizeHeader) {
    const advertised = parseInt(expectedSizeHeader, 10);
    if (Number.isFinite(advertised) && advertised > maxBytes) {
      throw new VikunjaError({
        status: 413,
        code: 'ATTACHMENT_TOO_LARGE',
        method: 'GET',
        path: `/tasks/${task.id}/attachments/${attachmentId}`,
        message: `Attachment is ${advertised} bytes, exceeding the ${maxBytes}-byte download limit.`,
        fieldErrors: [],
      });
    }
  }

  const apiPath = `/tasks/${task.id}/attachments/${attachmentId}`;
  const expectedSize =
    expectedSizeHeader && Number.isFinite(parseInt(expectedSizeHeader, 10))
      ? parseInt(expectedSizeHeader, 10)
      : undefined;
  const tooLarge = (bytes: number) =>
    new VikunjaError({
      status: 413,
      code: 'ATTACHMENT_TOO_LARGE',
      method: 'GET',
      path: apiPath,
      message: `Attachment is ${bytes} bytes, exceeding the ${maxBytes}-byte download limit.`,
      fieldErrors: [],
    });
  const sizeMismatch = (bytes: number) =>
    new VikunjaError({
      status: 500,
      code: 'SIZE_MISMATCH',
      method: 'GET',
      path: apiPath,
      message: `Attachment verification failed: Downloaded size (${bytes} bytes) does not match expected Content-Length (${expectedSize} bytes).`,
      fieldErrors: [],
    });

  const hash = crypto.createHash('sha256');
  let size = 0;
  const body: any = (response as unknown as { body?: any }).body;
  const { handle } = await openSafeDestination(
    downloadRoot,
    safeDestPath,
    options.overwrite === true,
  );

  try {
    if (body && typeof body[Symbol.asyncIterator] === 'function') {
      // Stream chunks straight to disk so a large attachment never buffers wholly
      // in memory; abort (and remove the partial file) past the ceiling.
      for await (const chunk of body) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        size += buf.length;
        if (size > maxBytes) throw tooLarge(size);
        hash.update(buf);
        await handle.write(buf);
      }
      if (expectedSize !== undefined && size !== expectedSize) throw sizeMismatch(size);
    } else {
      // Fallback (mocks / non-streaming bodies): buffer, verify, then write.
      const fileData = Buffer.from(await response.arrayBuffer());
      size = fileData.length;
      if (expectedSize !== undefined && size !== expectedSize) throw sizeMismatch(size);
      if (size > maxBytes) throw tooLarge(size);
      hash.update(fileData);
      await handle.writeFile(fileData);
    }
  } catch (err) {
    await handle.close();
    await fs.unlink(safeDestPath).catch(() => {});
    throw err;
  }
  await handle.close();

  const checksum = hash.digest('hex');

  return {
    success: true,
    path: safeDestPath,
    fileName,
    mime: inferMimeType(fileName),
    size,
    checksum,
    taskId: task.id,
    attachmentId,
    attachmentUrl: `${config.vikunjaUrl}/tasks/${task.id}/attachments/${attachmentId}`,
    taskUrl: `${config.vikunjaWebUrl}tasks/${task.id}`,
  };
}

export async function listAttachments(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
): Promise<AttachmentInfo[]>;
export async function listAttachments(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector: { id?: number; title?: string } | undefined,
  options: AttachmentListOptions,
): Promise<AttachmentListResult>;
export async function listAttachments(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  options?: AttachmentListOptions,
): Promise<AttachmentInfo[] | AttachmentListResult> {
  const task = await resolveTask(client, taskSelector, projectSelector);
  if (options === undefined) {
    const rawList = await client.request<any>('GET', `/tasks/${task.id}/attachments`);
    return toItemArray(rawList).map(normalizeAttachment);
  }

  const page = options.page ?? 1;
  const perPage = options.perPage ?? 20;
  const countOnly = options.countOnly === true;
  const prefix = options.filenamePrefix?.trim();
  let attachments: AttachmentInfo[];
  let total: number;

  if (prefix) {
    const matches = await fetchAllAttachments(client, task.id, prefix);
    total = matches.length;
    const start = (page - 1) * perPage;
    attachments = countOnly ? [] : matches.slice(start, start + perPage);
  } else {
    const requestPage = countOnly ? 1 : page;
    const requestPerPage = countOnly ? 1 : perPage;
    const rawList = await client.request<any>(
      'GET',
      `/tasks/${task.id}/attachments?page=${requestPage}&per_page=${requestPerPage}`,
    );
    total = normalizePagination(rawList).total;
    attachments = countOnly ? [] : toItemArray(rawList).map(normalizeAttachment);
  }

  const totalPages = total === 0 ? 0 : Math.ceil(total / perPage);
  const hasMore = page < totalPages;
  return {
    task: attachmentTaskSummary(task),
    attachments,
    page,
    perPage,
    total,
    hasMore,
    nextPage: hasMore ? page + 1 : null,
    countOnly,
  };
}

export async function deleteAttachment(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  attachmentId: number,
  projectSelector: { id?: number; title?: string },
  confirm: boolean,
  actor: string,
  idempotencyKey: string,
): Promise<DeleteAttachmentResult> {
  if (!projectSelector || (!projectSelector.id && !projectSelector.title?.trim())) {
    throw new VikunjaError({
      status: 400,
      code: 'PROJECT_SCOPE_REQUIRED',
      method: 'DELETE',
      path: '/attachments',
      message: 'projectSelector is required for attachment deletion.',
      fieldErrors: [],
    });
  }
  if (confirm !== true) {
    throw new VikunjaError({
      status: 400,
      code: 'CONFIRMATION_REQUIRED',
      method: 'DELETE',
      path: '/attachments',
      message: 'confirm:true is required for attachment deletion.',
      fieldErrors: [],
    });
  }
  if (!actor?.trim()) {
    throw new VikunjaError({
      status: 400,
      code: 'ACTOR_REQUIRED',
      method: 'DELETE',
      path: '/attachments',
      message: 'actor is required for attachment deletion.',
      fieldErrors: [],
    });
  }
  if (!idempotencyKey?.trim()) {
    throw new VikunjaError({
      status: 400,
      code: 'IDEMPOTENCY_KEY_REQUIRED',
      method: 'DELETE',
      path: '/attachments',
      message: 'idempotencyKey is required for attachment deletion.',
      fieldErrors: [],
    });
  }

  const payload = { taskSelector, projectSelector, attachmentId, actor: actor.trim() };
  return runDurableOperation('attachment-delete', idempotencyKey, payload, async () => {
    const task = await resolveTask(client, taskSelector, projectSelector);
    const attachments = await fetchAllAttachments(client, task.id);
    const attachment = attachments.find((candidate) => candidate.id === attachmentId);
    const apiPath = `/tasks/${task.id}/attachments/${attachmentId}`;
    if (!attachment) {
      throw new VikunjaError({
        status: 404,
        code: 'ATTACHMENT_NOT_FOUND',
        method: 'DELETE',
        path: apiPath,
        message: `Attachment ${attachmentId} was not found on the resolved task; nothing was deleted.`,
        fieldErrors: [],
      });
    }

    await client.request('DELETE', apiPath);
    return {
      action: 'deleted',
      task: attachmentTaskSummary(task),
      attachment,
      remainingAttachmentCount: attachments.length - 1,
      actor: actor.trim(),
    };
  });
}
