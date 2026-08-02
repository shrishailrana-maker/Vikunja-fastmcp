/**
 * Environment configuration loading and Vikunja URL normalization.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import os from 'os';
import path from 'path';
import { loadToolProfile, type ToolProfile } from './tool-profiles.js';

export type ResponseMode = 'minimal' | 'receipt' | 'compact' | 'standard' | 'full';
export type MutationScopeMode = 'off' | 'warn' | 'require';

export interface Config {
  vikunjaUrl: string; // e.g. "https://vikunja.example.com/api/v2"
  vikunjaToken: string;
  vikunjaWebUrl: string; // e.g. "https://vikunja.example.com/"
  attachmentDownloadRoot: string;
  // Upper bound (bytes) for a single attachment upload or download. Optional so
  // existing Config literals keep compiling; consumers fall back to a default.
  maxAttachmentBytes?: number;
  // Optional so existing Config literals keep compiling; consumers use minimal
  // when no explicit mode is supplied.
  responseMode?: ResponseMode;
  toolProfile?: ToolProfile;
  // Per-request timeout for ordinary JSON API calls.
  requestTimeoutMs?: number;
  // Longer timeout for streamed responses and multipart transfers.
  transferTimeoutMs?: number;
  // Controls global task-id writes that omit an explicit project selector.
  mutationScopeMode?: MutationScopeMode;
  // Labels with this prefix form the mutually exclusive task-status group.
  statusLabelPrefix?: string;
}

// Default single-attachment size ceiling (100 MiB) when the env var is unset.
export const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_TRANSFER_TIMEOUT_MS = 60_000;

function requireHttpUrl(parsed: URL, variableName: string): void {
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${variableName} must use http:// or https://.`);
  }
}

function positiveIntegerEnv(
  env: NodeJS.ProcessEnv,
  variableName: string,
  defaultValue: number,
): number {
  if (env[variableName] === undefined) return defaultValue;
  const parsed = Number(env[variableName]);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${variableName} must be a positive integer.`);
  }
  return parsed;
}

export function normalizeUrl(urlStr: string): { apiUrl: string; webUrl: string } {
  if (!urlStr) {
    throw new Error('VIKUNJA_URL is required but not set.');
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error('Invalid VIKUNJA_URL.');
  }
  requireHttpUrl(parsed, 'VIKUNJA_URL');

  if (/\/api\/v1(?:\/|$)/i.test(parsed.pathname)) {
    throw new Error('Vikunja FastMCP V2 does not support v1 API routes (/api/v1).');
  }

  let origin = parsed.origin;
  let pathname = parsed.pathname;

  // Clean trailing slashes
  if (pathname.endsWith('/')) {
    pathname = pathname.slice(0, -1);
  }

  let apiUrl: string;
  let webUrl: string;

  if (pathname.endsWith('/api/v2')) {
    apiUrl = origin + pathname;
    webUrl = origin + '/';
  } else if (pathname.includes('/api/v2')) {
    // A path that embeds /api/v2 mid-way (e.g. "/api/v2/foo") is malformed;
    // appending another /api/v2 would produce a nonsense URL.
    throw new Error(
      `Invalid VIKUNJA_URL path "${pathname}": use the server root or a base ending in "/api/v2".`,
    );
  } else {
    // Root, or a sub-path deployment (e.g. "/vikunja") — append /api/v2.
    apiUrl = origin + (pathname ? pathname : '') + '/api/v2';
    webUrl = origin + (pathname ? pathname : '') + '/';
  }

  return { apiUrl, webUrl };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const rawUrl = env.VIKUNJA_URL || '';
  const token = env.VIKUNJA_API_TOKEN || '';
  const rawWebUrl = env.VIKUNJA_WEB_URL || '';
  const rawResponseMode = env.VIKUNJA_MCP_RESPONSE_MODE?.trim();
  const rawMutationScopeMode = env.VIKUNJA_MUTATION_SCOPE_MODE?.trim().toLowerCase();
  const statusLabelPrefix = env.VIKUNJA_STATUS_LABEL_PREFIX?.trim() || 'status:';

  if (!rawUrl) {
    throw new Error('VIKUNJA_URL environment variable is not set.');
  }
  if (!token) {
    throw new Error('VIKUNJA_API_TOKEN environment variable is not set.');
  }

  const { apiUrl, webUrl } = normalizeUrl(rawUrl);

  let normalizedWebUrl = webUrl;
  if (rawWebUrl) {
    let parsedWeb: URL;
    try {
      parsedWeb = new URL(rawWebUrl);
    } catch {
      throw new Error('Invalid VIKUNJA_WEB_URL.');
    }
    requireHttpUrl(parsedWeb, 'VIKUNJA_WEB_URL');
    normalizedWebUrl = parsedWeb.toString();
    if (!normalizedWebUrl.endsWith('/')) {
      normalizedWebUrl += '/';
    }
  }

  const attachmentDownloadRoot = env.VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT?.trim()
    ? path.resolve(env.VIKUNJA_ATTACHMENT_DOWNLOAD_ROOT)
    : path.join(os.tmpdir(), 'vikunja-fastmcp', 'attachments');

  // Allow operators to raise/lower the attachment size ceiling; ignore
  // non-positive or non-numeric values and fall back to the default.
  const rawMax = Number(env.VIKUNJA_MAX_ATTACHMENT_BYTES);
  const maxAttachmentBytes =
    Number.isFinite(rawMax) && rawMax > 0 ? rawMax : DEFAULT_MAX_ATTACHMENT_BYTES;

  let responseMode: ResponseMode = 'minimal';
  if (rawResponseMode) {
    if (!['minimal', 'receipt', 'compact', 'standard', 'full'].includes(rawResponseMode)) {
      throw new Error(
        'VIKUNJA_MCP_RESPONSE_MODE must be one of: minimal, receipt, compact, standard, full.',
      );
    }
    responseMode = rawResponseMode as ResponseMode;
  }

  let mutationScopeMode: MutationScopeMode = 'require';
  if (rawMutationScopeMode) {
    if (!['off', 'warn', 'require'].includes(rawMutationScopeMode)) {
      throw new Error('VIKUNJA_MUTATION_SCOPE_MODE must be one of: off, warn, require.');
    }
    mutationScopeMode = rawMutationScopeMode as MutationScopeMode;
  }
  if (statusLabelPrefix.length > 50) {
    throw new Error('VIKUNJA_STATUS_LABEL_PREFIX must not exceed 50 characters.');
  }

  const requestTimeoutMs = positiveIntegerEnv(
    env,
    'VIKUNJA_REQUEST_TIMEOUT_MS',
    DEFAULT_REQUEST_TIMEOUT_MS,
  );
  const transferTimeoutMs = positiveIntegerEnv(
    env,
    'VIKUNJA_TRANSFER_TIMEOUT_MS',
    DEFAULT_TRANSFER_TIMEOUT_MS,
  );

  return {
    vikunjaUrl: apiUrl,
    vikunjaToken: token,
    vikunjaWebUrl: normalizedWebUrl,
    attachmentDownloadRoot,
    maxAttachmentBytes,
    responseMode,
    toolProfile: loadToolProfile(env),
    requestTimeoutMs,
    transferTimeoutMs,
    mutationScopeMode,
    statusLabelPrefix,
  };
}
