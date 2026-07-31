/**
 * Tests for attachment upload, download, and safety.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { jest } from '@jest/globals';
import { VikunjaApiClient } from '../src/api.js';
import {
  uploadAttachment,
  attachFiles,
  downloadAttachment,
  deleteAttachment,
  listAttachments,
  resolveSafePath,
} from '../src/attachments.js';
import { idempotency } from '../src/idempotency.js';
import { cache } from '../src/identity.js';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

describe('Attachment Upload, Verification and Download tests', () => {
  const config = {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    vikunjaToken: 'tk_token',
    vikunjaWebUrl: 'https://vikunja.example.com/',
    attachmentDownloadRoot: path.join(os.tmpdir(), 'vikunja-fastmcp-test', 'attachments'),
  };

  let client: VikunjaApiClient;
  let mockFetch: any;

  beforeEach(() => {
    client = new VikunjaApiClient(config);
    mockFetch = jest.spyOn(global, 'fetch');
    idempotency.clear();
    cache.clearProjects();
  });

  afterEach(() => {
    mockFetch.mockRestore();
    jest.restoreAllMocks();
  });

  describe('resolveSafePath', () => {
    it('should allow paths within root', () => {
      const safe = resolveSafePath(config.attachmentDownloadRoot, 'sub/file.txt');
      expect(safe.toLowerCase()).toContain('attachments');
      expect(safe.toLowerCase()).toContain('sub');
      expect(safe.toLowerCase()).toContain('file.txt');
    });

    it('should reject traversal attempts outside root', () => {
      expect(() => {
        resolveSafePath(config.attachmentDownloadRoot, '../../Windows/System32/cmd.exe');
      }).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'FORBIDDEN',
        }),
      );
    });
  });

  describe('Upload Attachment', () => {
    it('should upload file buffer using multipart boundary and decode base64', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Mock upload POST response
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            success: [
              {
                id: 3001,
                created: '2026-07-12T00:00:00Z',
                file: {
                  name: 'test.txt',
                  mime: 'text/plain',
                  size: 5,
                },
              },
            ],
          }),
      } as Response);

      const base64Content = Buffer.from('hello').toString('base64');
      const att = await uploadAttachment(client, 9005, 'test.txt', 'text/plain', base64Content);

      expect(att.id).toBe(3001);
      expect(att.fileName).toBe('test.txt');

      // Verify multipart payload format
      const postCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'POST');
      expect(postCall).toBeDefined();
      const contentType = postCall[1].headers['Content-Type'];
      expect(contentType).toContain('multipart/form-data; boundary=');

      // Content has the boundary
      const bodyBuffer = postCall[1].body;
      expect(bodyBuffer.toString()).toContain('test.txt');
      expect(bodyBuffer.toString()).toContain('text/plain');
    });

    it('should fail-closed on empty mime type or filename', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      await expect(uploadAttachment(client, 9005, '', 'text/plain', 'YmFzZTY0')).rejects.toThrow(
        expect.objectContaining({
          status: 400,
          code: 'INVALID_FILENAME',
        }),
      );
    });
  });

  describe('Download Attachment', () => {
    it('should download file, verify Content-Length, and write safely to filesystem', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Mock download GET response returning 5 bytes
      const fileBuffer = Buffer.from('hello');
      const cleanArrayBuffer = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength,
      );
      const mockHeaders = new Headers();
      mockHeaders.set('Content-Length', '5');

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: mockHeaders,
        arrayBuffer: async () => cleanArrayBuffer,
      } as unknown as Response);

      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-download-'));
      const localClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
      try {
        const res = await downloadAttachment(localClient, 9005, 3001, 'downloaded.txt');
        expect(res.success).toBe(true);
        expect(res.size).toBe(5);
        expect(await fs.readFile(path.join(root, 'downloaded.txt'))).toEqual(fileBuffer);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('streams a response body to disk in chunks (no full-buffer read)', async () => {
      const crypto = await import('crypto');
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Download response exposes a streaming body, not arrayBuffer.
      const chunks = [Buffer.from('hel'), Buffer.from('lo')];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: (async function* () {
          for (const c of chunks) yield c;
        })(),
      } as unknown as Response);

      const writes: Buffer[] = [];
      const handle = {
        write: jest.fn(async (b: Buffer) => {
          writes.push(b);
        }),
        close: jest.fn(async () => {}),
      };
      jest.spyOn(fs, 'open').mockResolvedValue(handle as any);

      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-download-stream-'));
      const localClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
      try {
        const res = await downloadAttachment(localClient, 9005, 3001, 'streamed.bin');
        expect(res.size).toBe(5);
        expect(handle.write).toHaveBeenCalledTimes(2);
        expect(Buffer.concat(writes).toString()).toBe('hello');
        expect(res.checksum).toBe(crypto.createHash('sha256').update('hello').digest('hex'));
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('should throw SIZE_MISMATCH if downloaded size mismatches Content-Length', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Mock response returning size mismatch
      const fileBuffer = Buffer.from('hello'); // 5 bytes
      const cleanArrayBuffer = fileBuffer.buffer.slice(
        fileBuffer.byteOffset,
        fileBuffer.byteOffset + fileBuffer.byteLength,
      );
      const mockHeaders = new Headers();
      mockHeaders.set('Content-Length', '10'); // expects 10 bytes

      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: mockHeaders,
        arrayBuffer: async () => cleanArrayBuffer,
      } as unknown as Response);

      await expect(downloadAttachment(client, 9005, 3001, 'mismatch.txt')).rejects.toThrow(
        expect.objectContaining({
          status: 500,
          code: 'SIZE_MISMATCH',
        }),
      );
    });

    it('should list attachments', async () => {
      // 1. Resolve task
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
      } as Response);

      // 2. Mock list request
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              {
                id: 3001,
                created: '2026-07-12T00:00:00Z',
                file: {
                  name: 'test.txt',
                  mime: 'text/plain',
                  size: 5,
                },
              },
            ],
            page: 1,
            per_page: 50,
            total: 1,
            total_pages: 1,
          }),
      } as Response);

      const list = await listAttachments(client, 9005);
      expect(list.length).toBe(1);
      expect(list[0].fileName).toBe('test.txt');
    });

    it('returns an exact bounded page and count for a filename prefix', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            identifier: 'ALPHA-305',
            title: 'Build evidence',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [
              { id: 3001, created: 't1', file: { name: 'build-a.zip', size: 10 } },
              { id: 3002, created: 't2', file: { name: 'notes.txt', size: 20 } },
              { id: 3003, created: 't3', file: { name: 'build-b.zip', size: 30 } },
            ],
            page: 1,
            per_page: 1000,
            total: 3,
            total_pages: 1,
          }),
      } as Response);

      const result = await listAttachments(client, { globalId: 9005 }, undefined, {
        page: 2,
        perPage: 1,
        filenamePrefix: 'BUILD-',
      });

      expect(result).toMatchObject({
        task: { id: 9005, portalRef: 'ALPHA-305', title: 'Build evidence' },
        page: 2,
        perPage: 1,
        total: 2,
        hasMore: false,
        nextPage: null,
        countOnly: false,
      });
      expect(result.attachments).toEqual([
        expect.objectContaining({ id: 3003, fileName: 'build-b.zip' }),
      ]);
      expect(String(mockFetch.mock.calls[1][0])).toContain('q=BUILD-');
    });

    it('returns count-only attachment metadata without item bodies', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            id: 9005,
            index: 305,
            identifier: 'ALPHA-305',
            title: 'Build evidence',
            project_id: 101,
            project: { title: 'Alpha' },
          }),
      } as Response);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items: [{ id: 3001, file: { name: 'build.zip', size: 10 } }],
            page: 1,
            per_page: 1,
            total: 41,
            total_pages: 41,
          }),
      } as Response);

      const result = await listAttachments(client, { globalId: 9005 }, undefined, {
        countOnly: true,
      });

      expect(result).toMatchObject({ total: 41, hasMore: true, nextPage: 2, countOnly: true });
      expect(result.attachments).toEqual([]);
      expect(String(mockFetch.mock.calls[1][0])).toContain('per_page=1');
    });
  });

  describe('Delete Attachment', () => {
    const taskResponse = {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 9005,
          index: 305,
          identifier: 'ALPHA-305',
          title: 'Build evidence',
          project_id: 101,
        }),
    } as Response;
    const projectResponse = {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ id: 101, title: 'Alpha' }),
    } as Response;
    const attachmentResponse = (items: any[]) =>
      ({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            items,
            page: 1,
            per_page: 1000,
            total: items.length,
            total_pages: items.length > 0 ? 1 : 0,
          }),
      }) as Response;

    it('requires confirmation, project scope, actor, and an idempotency key before I/O', async () => {
      await expect(
        deleteAttachment(
          client,
          { globalId: 9005 },
          3001,
          { id: 101 },
          false,
          'Codex',
          'delete-old-build',
        ),
      ).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' });
      await expect(
        deleteAttachment(
          client,
          { globalId: 9005 },
          3001,
          {} as any,
          true,
          'Codex',
          'delete-old-build',
        ),
      ).rejects.toMatchObject({ code: 'PROJECT_SCOPE_REQUIRED' });
      await expect(
        deleteAttachment(
          client,
          { globalId: 9005 },
          3001,
          { id: 101 },
          true,
          '',
          'delete-old-build',
        ),
      ).rejects.toMatchObject({ code: 'ACTOR_REQUIRED' });
      await expect(
        deleteAttachment(client, { globalId: 9005 }, 3001, { id: 101 }, true, 'Codex', ''),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' });
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it('verifies ownership, deletes once, and returns a durable retry receipt', async () => {
      mockFetch
        .mockResolvedValueOnce(taskResponse)
        .mockResolvedValueOnce(projectResponse)
        .mockResolvedValueOnce(
          attachmentResponse([
            {
              id: 3001,
              created: '2026-07-31T00:00:00Z',
              file: { name: 'old-build.zip', mime: 'application/zip', size: 50 },
            },
            {
              id: 3002,
              created: '2026-07-31T00:01:00Z',
              file: { name: 'current-build.zip', mime: 'application/zip', size: 60 },
            },
          ]),
        )
        .mockResolvedValueOnce({ ok: true, status: 204, text: async () => '' } as Response);

      const first = await deleteAttachment(
        client,
        { globalId: 9005 },
        3001,
        { id: 101 },
        true,
        'Codex',
        'delete-old-build',
      );
      const callsAfterFirst = mockFetch.mock.calls.length;
      const second = await deleteAttachment(
        client,
        { globalId: 9005 },
        3001,
        { id: 101 },
        true,
        'Codex',
        'delete-old-build',
      );

      expect(first).toEqual(second);
      expect(first).toMatchObject({
        action: 'deleted',
        task: { id: 9005, portalRef: 'ALPHA-305', title: 'Build evidence' },
        attachment: { id: 3001, fileName: 'old-build.zip' },
        remainingAttachmentCount: 1,
        actor: 'Codex',
      });
      expect(mockFetch.mock.calls).toHaveLength(callsAfterFirst);
      expect(mockFetch.mock.calls.filter((call: any) => call[1]?.method === 'DELETE')).toHaveLength(
        1,
      );
      expect(String(mockFetch.mock.calls.at(-1)?.[0])).toMatch(/\/tasks\/9005\/attachments\/3001$/);
    });

    it('never deletes an attachment that is not listed on the resolved task', async () => {
      mockFetch
        .mockResolvedValueOnce(taskResponse)
        .mockResolvedValueOnce(projectResponse)
        .mockResolvedValueOnce(
          attachmentResponse([
            { id: 4001, created: 't', file: { name: 'belongs-here.txt', size: 1 } },
          ]),
        );

      await expect(
        deleteAttachment(
          client,
          { globalId: 9005 },
          3001,
          { id: 101 },
          true,
          'Codex',
          'wrong-task-attachment',
        ),
      ).rejects.toMatchObject({ status: 404, code: 'ATTACHMENT_NOT_FOUND' });
      expect(mockFetch.mock.calls.some((call: any) => call[1]?.method === 'DELETE')).toBe(false);
    });
  });

  describe('attachFiles (multi-file and local paths)', () => {
    const okTask = {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 9005,
          index: 305,
          title: 'Evidence task',
          project_id: 101,
          project: { title: 'Alpha' },
        }),
    } as Response;

    const uploadOk = (id: number, name: string) =>
      ({
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            success: [{ id, created: 't', file: { name, mime: 'text/plain', size: 1 } }],
          }),
      }) as Response;

    it('uploads multiple base64 files and returns per-file metadata', async () => {
      mockFetch.mockResolvedValueOnce(okTask);
      mockFetch.mockResolvedValueOnce(uploadOk(3001, 'a.txt'));
      mockFetch.mockResolvedValueOnce(uploadOk(3002, 'b.txt'));

      const res = await attachFiles(client, 9005, [
        { filename: 'a.txt', base64Content: Buffer.from('a').toString('base64') },
        { filename: 'b.txt', base64Content: Buffer.from('b').toString('base64') },
      ]);

      expect(res.uploaded.map((u) => u.id)).toEqual([3001, 3002]);
      expect(res.failed.length).toBe(0);
      expect(res.task).toEqual({ id: 9005, portalRef: '#305', title: 'Evidence task' });
    });

    it('returns the cached task-to-attachment mapping on an idempotent retry', async () => {
      mockFetch.mockResolvedValueOnce(okTask);
      mockFetch.mockResolvedValueOnce(uploadOk(3001, 'a.txt'));

      const first = await attachFiles(
        client,
        9005,
        [{ filename: 'a.txt', base64Content: Buffer.from('a').toString('base64') }],
        undefined,
        'attach-once',
      );
      const calls = mockFetch.mock.calls.length;
      mockFetch.mockResolvedValueOnce(okTask);
      const second = await attachFiles(
        client,
        9005,
        [{ filename: 'a.txt', base64Content: Buffer.from('a').toString('base64') }],
        undefined,
        'attach-once',
      );

      expect(second).toEqual(first);
      expect(second.task).toEqual({ id: 9005, portalRef: '#305', title: 'Evidence task' });
      expect(mockFetch.mock.calls.filter((call: any) => call[1]?.method === 'POST')).toHaveLength(
        1,
      );
      expect(mockFetch).toHaveBeenCalledTimes(calls + 1);
    });

    it('sanitizes filename and mimeType to prevent multipart header injection', async () => {
      mockFetch.mockResolvedValueOnce(okTask);
      mockFetch.mockResolvedValueOnce(uploadOk(3009, 'evil.txt'));

      const evilName = 'evil.txt"\r\nContent-Disposition: form-data; name="hack"\r\n\r\ninjected';
      const evilMime = 'text/plain\r\nX-Evil: 1';
      await attachFiles(client, 9005, [
        {
          filename: evilName,
          mimeType: evilMime,
          base64Content: Buffer.from('data').toString('base64'),
        },
      ]);

      const postCall = mockFetch.mock.calls.find((c: any) => c[1]?.method === 'POST');
      const body = postCall[1].body.toString();

      // CR/LF stripped and quote escaped: no injected header line survives.
      expect(body).not.toContain('name="hack"');
      expect(body).not.toContain('evil.txt"');
      expect(body).toContain('evil.txt\\"');
      // Malformed mimeType with CRLF is replaced by a safe default.
      expect(body).not.toContain('X-Evil');
      expect(body).toContain('Content-Type: application/octet-stream');
    });

    it('rejects an oversized base64 payload before decoding it', async () => {
      const smallClient = new VikunjaApiClient({ ...config, maxAttachmentBytes: 3 });
      mockFetch.mockResolvedValueOnce(okTask);

      const res = await attachFiles(smallClient, 9005, [
        { filename: 'big.bin', base64Content: Buffer.from('abcdef').toString('base64') },
      ]);

      expect(res.uploaded.length).toBe(0);
      expect(res.failed[0].error).toMatch(/exceeding the 3-byte limit/);
      // No upload request was attempted (only the task-resolve fetch ran).
      expect(mockFetch.mock.calls.filter((c: any) => c[1]?.method === 'POST').length).toBe(0);
    });

    it('rejects malformed base64 instead of silently decoding partial bytes', async () => {
      mockFetch.mockResolvedValueOnce(okTask);

      const res = await attachFiles(client, 9005, [
        { filename: 'broken.bin', base64Content: '%%%not-base64%%%' },
      ]);

      expect(res.uploaded).toHaveLength(0);
      expect(res.failed[0].error).toContain('valid base64');
      expect(mockFetch.mock.calls.filter((c: any) => c[1]?.method === 'POST')).toHaveLength(0);
    });

    it('checks a local file size before reading it into memory', async () => {
      const smallClient = new VikunjaApiClient({ ...config, maxAttachmentBytes: 3 });
      mockFetch.mockResolvedValueOnce(okTask);
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 10, isFile: () => true } as any);
      const readSpy = jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.alloc(10) as any);

      const res = await attachFiles(smallClient, 9005, [{ filePath: '/tmp/large.log' }]);

      expect(res.uploaded).toHaveLength(0);
      expect(res.failed[0].error).toMatch(/exceeding the 3-byte limit/);
      expect(readSpy).not.toHaveBeenCalled();
    });

    it('reads a local filePath, infers metadata, and uploads it', async () => {
      jest.spyOn(fs, 'stat').mockResolvedValue({ size: 5, isFile: () => true } as any);
      const readSpy = jest.spyOn(fs, 'readFile').mockResolvedValue(Buffer.from('hello') as any);
      mockFetch.mockResolvedValueOnce(okTask);
      mockFetch.mockResolvedValueOnce(uploadOk(3003, 'notes.txt'));

      const res = await attachFiles(client, 9005, [{ filePath: '/tmp/notes.txt' }]);

      expect(readSpy).toHaveBeenCalledWith('/tmp/notes.txt');
      expect(res.uploaded[0].id).toBe(3003);
    });

    it('reports a per-file failure without aborting the batch', async () => {
      mockFetch.mockResolvedValueOnce(okTask);

      // Spec with neither filePath nor base64Content is rejected per-file.
      const res = await attachFiles(client, 9005, [{ filename: 'x.txt' }]);

      expect(res.uploaded.length).toBe(0);
      expect(res.failed).toEqual([expect.objectContaining({ file: 'x.txt' })]);
    });
  });

  describe('download safety', () => {
    const okTask = {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ id: 9005, index: 305, project_id: 101, project: { title: 'Alpha' } }),
    } as Response;

    it('refuses to overwrite an existing file unless overwrite=true', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-download-existing-'));
      const existing = path.join(root, 'existing.txt');
      await fs.writeFile(existing, 'keep');
      const localClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
      mockFetch.mockResolvedValueOnce(okTask);
      try {
        await expect(downloadAttachment(localClient, 9005, 3001, 'existing.txt')).rejects.toThrow(
          expect.objectContaining({ status: 409, code: 'FILE_EXISTS' }),
        );
        expect(await fs.readFile(existing, 'utf8')).toBe('keep');
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    });

    it('rejects a destination whose parent escapes through a symlink or junction', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-download-root-'));
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-download-outside-'));
      const linkedParent = path.join(root, 'linked');
      await fs.symlink(outside, linkedParent, process.platform === 'win32' ? 'junction' : 'dir');
      const localClient = new VikunjaApiClient({ ...config, attachmentDownloadRoot: root });
      mockFetch.mockResolvedValueOnce(okTask);
      try {
        await expect(
          downloadAttachment(localClient, 9005, 3001, path.join('linked', 'escape.txt')),
        ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
        await expect(fs.stat(path.join(outside, 'escape.txt'))).rejects.toMatchObject({
          code: 'ENOENT',
        });
      } finally {
        await fs.rm(root, { recursive: true, force: true });
        await fs.rm(outside, { recursive: true, force: true });
      }
    });

    it('rejects an attachment larger than the configured limit', async () => {
      const smallClient = new VikunjaApiClient({ ...config, maxAttachmentBytes: 3 });
      mockFetch.mockResolvedValueOnce(okTask);
      jest.spyOn(fs, 'access').mockRejectedValue(new Error('ENOENT')); // does not exist

      const headers = new Headers();
      headers.set('Content-Length', '10');
      mockFetch.mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers,
        arrayBuffer: async () => new ArrayBuffer(10),
      } as unknown as Response);

      await expect(downloadAttachment(smallClient, 9005, 3001, 'toobig.bin')).rejects.toThrow(
        expect.objectContaining({ status: 413, code: 'ATTACHMENT_TOO_LARGE' }),
      );
    });
  });
});
