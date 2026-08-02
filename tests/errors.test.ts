/**
 * Tests for structured errors and secret redaction.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { VikunjaError, redactSecrets, mapStatusToCode, toErrorEnvelope } from '../src/errors.js';

const TEST_TOKEN = `tk_${'a'.repeat(40)}`;

describe('Errors and Redaction tests', () => {
  describe('redactSecrets', () => {
    it('should redact token-like string from text', () => {
      const input = `Received error for token ${TEST_TOKEN} and token tk_abc123`;
      const output = redactSecrets(input);
      // tk_abc123 is too short (only 9 chars) so it shouldn't be redacted by the pattern, but the long one should be
      expect(output).toBe('Received error for token [REDACTED_TOKEN] and token tk_abc123');
    });

    it('should redact specific token passed as parameter', () => {
      const token = 'my-secret-token-123';
      const input = `headers: { Authorization: 'Bearer my-secret-token-123' }`;
      const output = redactSecrets(input, token);
      expect(output).toBe("headers: { Authorization: 'Bearer [REDACTED_TOKEN]' }");
    });

    it('should redact Authorization header format in general', () => {
      const input = 'Authorization: Bearer tk_some_long_auth_token_here_12345';
      expect(redactSecrets(input)).toContain('[REDACTED_TOKEN]');
    });
  });

  describe('mapStatusToCode', () => {
    it('should map standard status codes correctly', () => {
      expect(mapStatusToCode(400)).toBe('VALIDATION_ERROR');
      expect(mapStatusToCode(422)).toBe('VALIDATION_ERROR');
      expect(mapStatusToCode(401)).toBe('UNAUTHORIZED');
      expect(mapStatusToCode(403)).toBe('PERMISSION_DENIED');
      expect(mapStatusToCode(404)).toBe('NOT_FOUND');
      expect(mapStatusToCode(405)).toBe('METHOD_NOT_ALLOWED');
      expect(mapStatusToCode(409)).toBe('CONFLICT');
      expect(mapStatusToCode(413)).toBe('ATTACHMENT_TOO_LARGE');
      expect(mapStatusToCode(500)).toBe('INTERNAL_SERVER_ERROR');
    });
  });

  describe('toErrorEnvelope', () => {
    it('should format a VikunjaError into standard error envelope', () => {
      const err = new VikunjaError({
        status: 403,
        code: 'PERMISSION_DENIED',
        method: 'POST',
        path: '/tasks/100/assignees',
        message: `No permission to modify assignees for token ${TEST_TOKEN}`,
        fieldErrors: [{ location: 'body.user_id', message: 'User is invalid' }],
      });

      const envelope = toErrorEnvelope(err, TEST_TOKEN);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.status).toBe(403);
      expect(envelope.error.code).toBe('PERMISSION_DENIED');
      expect(envelope.error.method).toBe('POST');
      expect(envelope.error.path).toBe('/tasks/100/assignees');
      expect(envelope.error.message).toBe(
        'No permission to modify assignees for token [REDACTED_TOKEN]',
      );
      expect(envelope.error.fieldErrors[0].location).toBe('body.user_id');
      expect(envelope.error.fieldErrors[0].message).toBe('User is invalid');
      expect(envelope.error).toMatchObject({
        retryable: false,
        remediation: 'Check the caller and target-project permissions.',
        capability: { apiContract: 'v2', packageVersion: expect.any(String) },
      });
      expect(envelope.error.operationId).toBeUndefined();
    });

    it('preserves a real durable operation id and safe identity context', () => {
      const err = new VikunjaError({
        status: 503,
        code: 'UPSTREAM_UNAVAILABLE',
        method: 'PATCH',
        path: '/tasks/99',
        message: 'temporary failure',
        fieldErrors: [],
        operationId: 'task-update:caller-hash:payload-hash',
        identity: { project: { id: 2 }, task: { identifier: 'ALPHA-5' } },
      });

      expect(toErrorEnvelope(err).error).toMatchObject({
        operationId: 'task-update:caller-hash:payload-hash',
        identity: { project: { id: 2 }, task: { identifier: 'ALPHA-5' } },
        retryable: true,
        capability: { apiContract: 'v2', packageVersion: expect.any(String) },
      });
    });

    it('should format generic Error into standard error envelope', () => {
      const err = new Error(`Failed to connect to ${TEST_TOKEN}`);
      const envelope = toErrorEnvelope(err, TEST_TOKEN);
      expect(envelope.ok).toBe(false);
      expect(envelope.error.status).toBe(500);
      expect(envelope.error.code).toBe('INTERNAL_SERVER_ERROR');
      expect(envelope.error.message).toBe('Failed to connect to [REDACTED_TOKEN]');
      expect(envelope.error.retryable).toBe(true);
      expect(envelope.error.remediation).toContain('Retry the same idempotent operation');
    });

    it('normalizes non-string field error locations without crashing redaction', () => {
      const err = new VikunjaError({
        status: 422,
        code: 'VALIDATION_ERROR',
        method: 'PATCH',
        path: '/tasks/1',
        message: 'Invalid field',
        fieldErrors: [{ location: ['body', 'due_date'] as unknown as string, message: 'bad' }],
      });

      expect(toErrorEnvelope(err).error.fieldErrors[0].location).toBe('body.due_date');
    });
  });
});
