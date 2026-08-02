/**
 * Tests for config loading and URL normalization.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { normalizeUrl, loadConfig } from '../src/config.js';
import path from 'node:path';

const TEST_TOKEN = `tk_${'a'.repeat(40)}`;

describe('Config tests', () => {
  describe('normalizeUrl', () => {
    it('should normalize server root url without api/v2', () => {
      const { apiUrl, webUrl } = normalizeUrl('https://vikunja.example.com');
      expect(apiUrl).toBe('https://vikunja.example.com/api/v2');
      expect(webUrl).toBe('https://vikunja.example.com/');
    });

    it('should normalize server root url with trailing slash', () => {
      const { apiUrl, webUrl } = normalizeUrl('https://vikunja.example.com/');
      expect(apiUrl).toBe('https://vikunja.example.com/api/v2');
      expect(webUrl).toBe('https://vikunja.example.com/');
    });

    it('should normalize server root url with api/v2', () => {
      const { apiUrl, webUrl } = normalizeUrl('https://vikunja.example.com/api/v2');
      expect(apiUrl).toBe('https://vikunja.example.com/api/v2');
      expect(webUrl).toBe('https://vikunja.example.com/');
    });

    it('should normalize server root url with api/v2/', () => {
      const { apiUrl, webUrl } = normalizeUrl('https://vikunja.example.com/api/v2/');
      expect(apiUrl).toBe('https://vikunja.example.com/api/v2');
      expect(webUrl).toBe('https://vikunja.example.com/');
    });

    it('normalizes the v2 suffix case-insensitively without appending it twice', () => {
      const { apiUrl, webUrl } = normalizeUrl('https://vikunja.example.com/API/V2');
      expect(apiUrl).toBe('https://vikunja.example.com/API/V2');
      expect(webUrl).toBe('https://vikunja.example.com/');
    });

    it('should reject v1 URLs', () => {
      expect(() => normalizeUrl('https://vikunja.example.com/api/v1')).toThrow(
        'Vikunja FastMCP V2 does not support v1 API routes (/api/v1).',
      );
    });

    it.each(['ftp://vikunja.example.com', 'file:///tmp/vikunja'])(
      'should reject non-HTTP API URLs: %s',
      (url) => {
        expect(() => normalizeUrl(url)).toThrow('must use http:// or https://');
      },
    );

    it('should throw on invalid URLs', () => {
      expect(() => normalizeUrl('invalid-url')).toThrow('Invalid VIKUNJA_URL');
    });
  });

  describe('loadConfig', () => {
    it('should load config from environment variables successfully', () => {
      const env = {
        VIKUNJA_URL: 'https://vikunja.example.com',
        VIKUNJA_API_TOKEN: TEST_TOKEN,
        VIKUNJA_WEB_URL: 'https://vikunja-web.example.com',
      };
      const config = loadConfig(env);
      expect(config.vikunjaUrl).toBe('https://vikunja.example.com/api/v2');
      expect(config.vikunjaToken).toBe(TEST_TOKEN);
      expect(config.vikunjaWebUrl).toBe('https://vikunja-web.example.com/');
      expect(config.responseMode).toBe('minimal');
      expect(config.toolProfile).toBe('core');
      expect(config.requestTimeoutMs).toBe(30_000);
      expect(config.transferTimeoutMs).toBe(60_000);
      expect(config.attachmentSourceRoots).toEqual(
        expect.arrayContaining([expect.stringMatching(/vikunja-fastmcp|MCP|Temp/i)]),
      );
    });

    it('accepts an operator-selected MCP response mode', () => {
      const config = loadConfig({
        VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
        VIKUNJA_API_TOKEN: TEST_TOKEN,
        VIKUNJA_MCP_RESPONSE_MODE: 'receipt',
      });

      expect(config.responseMode).toBe('receipt');
    });

    it('rejects an invalid MCP response mode', () => {
      expect(() =>
        loadConfig({
          VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
          VIKUNJA_API_TOKEN: TEST_TOKEN,
          VIKUNJA_MCP_RESPONSE_MODE: 'verbose',
        }),
      ).toThrow('VIKUNJA_MCP_RESPONSE_MODE');
    });

    it('accepts a focused MCP tool profile and rejects unknown profiles', () => {
      const config = loadConfig({
        VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
        VIKUNJA_API_TOKEN: TEST_TOKEN,
        VIKUNJA_MCP_TOOL_PROFILE: 'qa',
      });
      expect(config.toolProfile).toBe('qa');
      expect(() =>
        loadConfig({
          VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
          VIKUNJA_API_TOKEN: TEST_TOKEN,
          VIKUNJA_MCP_TOOL_PROFILE: 'everything-plus',
        }),
      ).toThrow('VIKUNJA_MCP_TOOL_PROFILE');
    });

    it('accepts an operator-selected request timeout', () => {
      const config = loadConfig({
        VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
        VIKUNJA_API_TOKEN: TEST_TOKEN,
        VIKUNJA_REQUEST_TIMEOUT_MS: '45000',
      });

      expect(config.requestTimeoutMs).toBe(45_000);
    });

    it.each(['0', '-1', 'not-a-number'])('rejects an invalid request timeout: %s', (value) => {
      expect(() =>
        loadConfig({
          VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
          VIKUNJA_API_TOKEN: TEST_TOKEN,
          VIKUNJA_REQUEST_TIMEOUT_MS: value,
        }),
      ).toThrow('VIKUNJA_REQUEST_TIMEOUT_MS');
    });

    it('accepts an operator-selected transfer timeout', () => {
      const config = loadConfig({
        VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
        VIKUNJA_API_TOKEN: TEST_TOKEN,
        VIKUNJA_TRANSFER_TIMEOUT_MS: '90000',
      });

      expect(config.transferTimeoutMs).toBe(90_000);
    });

    it.each(['0', '-1', 'not-a-number'])('rejects an invalid transfer timeout: %s', (value) => {
      expect(() =>
        loadConfig({
          VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
          VIKUNJA_API_TOKEN: TEST_TOKEN,
          VIKUNJA_TRANSFER_TIMEOUT_MS: value,
        }),
      ).toThrow('VIKUNJA_TRANSFER_TIMEOUT_MS');
    });

    it('rejects a non-HTTP web URL', () => {
      expect(() =>
        loadConfig({
          VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
          VIKUNJA_API_TOKEN: TEST_TOKEN,
          VIKUNJA_WEB_URL: 'javascript:alert(1)',
        }),
      ).toThrow('VIKUNJA_WEB_URL must use http:// or https://');
    });

    it('should fall back to API root base for webUrl if not set', () => {
      const env = {
        VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
        VIKUNJA_API_TOKEN: TEST_TOKEN,
      };
      const config = loadConfig(env);
      expect(config.vikunjaWebUrl).toBe('https://vikunja.example.com/');
    });

    it('allows an operator-selected attachment sandbox root', () => {
      const config = loadConfig({
        VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
        VIKUNJA_API_TOKEN: 'test-token',
        VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT: './durable-attachments',
      });
      expect(config.attachmentDownloadRoot).toMatch(/durable-attachments$/);
    });

    it('accepts multiple local attachment source roots', () => {
      const config = loadConfig({
        VIKUNJA_URL: 'https://vikunja.example.com/api/v2',
        VIKUNJA_API_TOKEN: 'test-token',
        VIKUNJA_ATTACHMENT_SOURCE_ROOTS: ['one', 'two'].join(path.delimiter),
      });
      expect(config.attachmentSourceRoots).toHaveLength(2);
      expect(config.attachmentSourceRoots?.[0]).toMatch(/one$/);
      expect(config.attachmentSourceRoots?.[1]).toMatch(/two$/);
    });

    it('should throw if URL is missing', () => {
      expect(() => loadConfig({ VIKUNJA_API_TOKEN: 'tk_123' })).toThrow(
        'VIKUNJA_URL environment variable is not set.',
      );
    });

    it('should throw if token is missing', () => {
      expect(() => loadConfig({ VIKUNJA_URL: 'https://foo.com' })).toThrow(
        'VIKUNJA_API_TOKEN environment variable is not set.',
      );
    });
  });
});
