/**
 * Security gate tests: redaction and path sandboxing.
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
import { attachFiles, resolveSafePath } from '../src/attachments.js';
import { runSelfCheck } from '../src/diagnostics.js';
import { redactSecrets, toErrorEnvelope, VikunjaError } from '../src/errors.js';
import { server } from '../src/index.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TEST_TOKEN = `tk_${'a'.repeat(40)}`;
const CONFIGURED_TOKEN = 'neutral-configured-secret-123';

function expectSecretFree(value: unknown): void {
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  expect(serialized).not.toContain(CONFIGURED_TOKEN);
  expect(serialized).not.toContain(`Bearer ${CONFIGURED_TOKEN}`);
}

describe('Security Gate tests', () => {
  describe('Token Redaction Audits', () => {
    beforeEach(() => {
      process.env.VIKUNJA_API_TOKEN = TEST_TOKEN;
    });

    afterEach(() => {
      delete process.env.VIKUNJA_API_TOKEN;
    });

    it('should redact secrets matching active token in VikunjaError constructor', () => {
      const err = new VikunjaError({
        status: 500,
        code: 'INTERNAL_ERROR',
        method: 'GET',
        path: '/test',
        message: `Failed to access database using token ${TEST_TOKEN}.`,
        fieldErrors: [],
      });

      expect(err.message).not.toContain(TEST_TOKEN);
      expect(err.message).toContain('[REDACTED_TOKEN]');
    });

    it('should redact authorization headers and general bearers', () => {
      const logMsg = `Sending request with Authorization: Bearer ${TEST_TOKEN}`;
      const redacted = redactSecrets(logMsg);

      expect(redacted).not.toContain(TEST_TOKEN);
      expect(redacted).toContain('Authorization: Bearer [REDACTED_TOKEN]');
    });

    it('redacts configured tokens from HTTP failures and field errors', async () => {
      delete process.env.VIKUNJA_API_TOKEN;
      const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () =>
          JSON.stringify({
            detail: `Authorization: Bearer ${CONFIGURED_TOKEN}`,
            errors: [
              { location: ['body', CONFIGURED_TOKEN], message: `denied ${CONFIGURED_TOKEN}` },
            ],
          }),
      } as Response);
      const client = new VikunjaApiClient({
        vikunjaUrl: 'https://vikunja.example.com/api/v2',
        vikunjaToken: CONFIGURED_TOKEN,
        vikunjaWebUrl: 'https://vikunja.example.com/',
        attachmentDownloadRoot: os.tmpdir(),
      });

      try {
        await client.request('GET', '/tasks/1');
        throw new Error('expected request to fail');
      } catch (error) {
        expectSecretFree(error instanceof Error ? error.message : error);
        expectSecretFree(toErrorEnvelope(error, CONFIGURED_TOKEN));
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('redacts configured tokens from attachment failure receipts', async () => {
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              id: 10,
              index: 2,
              identifier: 'ALPHA-2',
              title: 'Evidence',
              project_id: 7,
              project: { title: 'Alpha' },
            }),
        } as Response)
        .mockResolvedValueOnce({
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              success: [],
              errors: [{ error: `Authorization: Bearer ${CONFIGURED_TOKEN}` }],
            }),
        } as Response);
      const client = new VikunjaApiClient({
        vikunjaUrl: 'https://vikunja.example.com/api/v2',
        vikunjaToken: CONFIGURED_TOKEN,
        vikunjaWebUrl: 'https://vikunja.example.com/',
        attachmentDownloadRoot: os.tmpdir(),
      });

      try {
        const result = await attachFiles(client, { globalId: 10 }, [
          { filename: 'evidence.txt', base64Content: Buffer.from('x').toString('base64') },
        ]);
        expectSecretFree(result);
      } finally {
        fetchSpy.mockRestore();
      }
    });

    it('redacts validation, success, HTTP, and stack values from tool envelopes', async () => {
      process.env.VIKUNJA_URL = 'https://vikunja.example.com/api/v2';
      process.env.VIKUNJA_API_TOKEN = CONFIGURED_TOKEN;
      const handler = (server as any)._requestHandlers.get('tools/call');

      const invalid = await handler({
        method: 'tools/call',
        params: {
          name: 'vikunja_tasks',
          arguments: { action: 'get', actor: `Authorization: Bearer ${CONFIGURED_TOKEN}` },
        },
      });
      expectSecretFree(invalid);

      const fetchSpy = jest.spyOn(global, 'fetch');
      fetchSpy.mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({ id: 1, username: `Authorization: Bearer ${CONFIGURED_TOKEN}` }),
      } as Response);
      const success = await handler({
        method: 'tools/call',
        params: { name: 'vikunja_auth', arguments: { action: 'status' } },
      });
      expectSecretFree(success);

      fetchSpy.mockResolvedValueOnce({
        ok: false,
        status: 403,
        statusText: 'Forbidden',
        text: async () => JSON.stringify({ detail: `Authorization: Bearer ${CONFIGURED_TOKEN}` }),
      } as Response);
      const failure = await handler({
        method: 'tools/call',
        params: { name: 'vikunja_auth', arguments: { action: 'status' } },
      });
      expectSecretFree(failure);
      expectSecretFree(redactSecrets(`Error\n    at token (${CONFIGURED_TOKEN}:1:1)`));
      fetchSpy.mockRestore();
    });

    it('redacts configured tokens from self-check failures', async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vikunja-self-check-redaction-'));
      process.env.VIKUNJA_URL = 'https://vikunja.example.com/api/v2';
      process.env.VIKUNJA_API_TOKEN = CONFIGURED_TOKEN;
      process.env.VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT = root;
      const fetchSpy = jest
        .spyOn(global, 'fetch')
        .mockRejectedValueOnce(new Error(`Authorization: Bearer ${CONFIGURED_TOKEN}`));
      try {
        expectSecretFree(await runSelfCheck([], 'basic'));
      } finally {
        fetchSpy.mockRestore();
        delete process.env.VIKUNJA_URL;
        delete process.env.VIKUNJA_API_TOKEN;
        delete process.env.VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT;
        await fs.rm(root, { recursive: true, force: true });
      }
    });
  });

  describe('Sandbox Boundaries', () => {
    const sandboxRoot = '/var/lib/vikunja/attachments';

    it('should allow relative paths within the download root', () => {
      const resolved = resolveSafePath(sandboxRoot, 'task_10/invoice.pdf');
      expect(resolved.replace(/\\/g, '/')).toContain(
        '/var/lib/vikunja/attachments/task_10/invoice.pdf',
      );
    });

    it('should reject relative path traversal (../) escaping the root', () => {
      expect(() => {
        resolveSafePath(sandboxRoot, '../../etc/passwd');
      }).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'FORBIDDEN',
        }),
      );
    });

    it('should reject absolute paths escaping the root', () => {
      expect(() => {
        resolveSafePath(sandboxRoot, '/etc/passwd');
      }).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'FORBIDDEN',
        }),
      );
    });

    it('should reject a sibling directory whose name shares the root prefix', () => {
      // "<root>-evil" would pass a naive startsWith(root) containment check
      // even though it is outside the root directory.
      expect(() => {
        resolveSafePath(sandboxRoot, '../attachments-evil/loot.bin');
      }).toThrow(
        expect.objectContaining({
          status: 403,
          code: 'FORBIDDEN',
        }),
      );
    });

    it('should allow the download root itself', () => {
      const resolved = resolveSafePath(sandboxRoot, '.');
      expect(resolved.replace(/\\/g, '/')).toContain('/var/lib/vikunja/attachments');
    });
  });
});
