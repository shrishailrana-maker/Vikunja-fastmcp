/**
 * Tests for the Vikunja HTTP client.
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
import { VikunjaError } from '../src/errors.js';

const TEST_TOKEN = `tk_${'a'.repeat(40)}`;

describe('VikunjaApiClient tests', () => {
  const config = {
    vikunjaUrl: 'https://vikunja.example.com/api/v2',
    vikunjaToken: TEST_TOKEN,
    vikunjaWebUrl: 'https://vikunja.example.com/',
    attachmentDownloadRoot: '/tmp/vikunja-fastmcp/attachments',
  };

  let client: VikunjaApiClient;
  let mockFetch: any;

  beforeEach(() => {
    client = new VikunjaApiClient(config);
    mockFetch = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    mockFetch.mockRestore();
  });

  it('should handle successful JSON response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: async () => JSON.stringify({ key: 'value' }),
    } as Response);

    const result = await client.request('GET', '/projects');
    expect(result).toEqual({ key: 'value' });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://vikunja.example.com/api/v2/projects',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: `Bearer ${TEST_TOKEN}`,
        }),
      }),
    );
  });

  it('should handle 204 No Content response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 204,
      statusText: 'No Content',
      text: async () => '',
    } as Response);

    const result = await client.request('DELETE', '/tasks/1');
    expect(result).toEqual({});
  });

  it('preserves an explicit JSON Merge Patch content type', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ done: true }),
    } as Response);

    await client.request('PATCH', '/tasks/1', {
      body: { done: true },
      headers: { 'Content-Type': 'application/merge-patch+json' },
    });

    expect(mockFetch.mock.calls[0][1].headers['Content-Type']).toBe('application/merge-patch+json');
  });

  it('should parse structured Vikunja error model on failure', async () => {
    const mockErrorBody = {
      code: 10001,
      detail: 'The task does not exist.',
      errors: [
        {
          location: 'query.task_id',
          message: 'Must be a valid integer',
        },
      ],
      status: 404,
      title: 'Not Found',
    };

    mockFetch.mockResolvedValue({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      text: async () => JSON.stringify(mockErrorBody),
    } as Response);

    await expect(client.request('GET', '/tasks/999')).rejects.toThrow(
      new VikunjaError({
        status: 404,
        code: 'NOT_FOUND',
        method: 'GET',
        path: '/tasks/999',
        message: 'The task does not exist.',
        fieldErrors: [
          {
            location: 'query.task_id',
            message: 'Must be a valid integer',
          },
        ],
      }),
    );
  });

  it('should handle non-JSON error response from server', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      text: async () => 'Gateway Timeout',
    } as Response);

    await expect(client.request('GET', '/projects')).rejects.toThrow(
      expect.objectContaining({
        status: 502,
        code: 'INTERNAL_SERVER_ERROR',
        message: 'HTTP error 502: Bad Gateway',
      }),
    );
  });

  it('should handle network connection failures', async () => {
    mockFetch.mockRejectedValue(new Error('fetch failed'));

    await expect(client.request('GET', '/projects')).rejects.toThrow(
      expect.objectContaining({
        status: 500,
        code: 'NETWORK_ERROR',
        message: 'fetch failed',
      }),
    );
  });

  it('passes a timeout signal to fetch and reports timeouts as 504', async () => {
    mockFetch.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError',
      }),
    );

    await expect(client.request('GET', '/projects')).rejects.toMatchObject({
      status: 504,
      code: 'REQUEST_TIMEOUT',
      message: 'Vikunja request timed out after 30000 ms.',
    });
    expect(mockFetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it.each([
    ['streamed responses', { isStreamResponse: true }],
    ['multipart transfers', { body: Buffer.from('file'), isMultipart: true }],
  ])('uses the 60-second transfer timeout for %s', async (_label, options) => {
    const timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
    mockFetch.mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ success: [] }),
    } as Response);

    await client.request('POST', '/transfer', options);

    expect(timeoutSpy).toHaveBeenLastCalledWith(60_000);
    timeoutSpy.mockRestore();
  });
});
