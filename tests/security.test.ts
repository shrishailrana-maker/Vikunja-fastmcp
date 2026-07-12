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

import { redactSecrets, VikunjaError } from '../src/errors.js';
import { resolveSafePath } from '../src/attachments.js';

const TEST_TOKEN = `tk_${'a'.repeat(40)}`;

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
