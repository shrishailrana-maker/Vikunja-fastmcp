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

export interface Config {
  vikunjaUrl: string; // e.g. "https://vikunja.example.com/api/v2"
  vikunjaToken: string;
  vikunjaWebUrl: string; // e.g. "https://vikunja.example.com/"
  attachmentDownloadRoot: string;
  // Upper bound (bytes) for a single attachment upload or download. Optional so
  // existing Config literals keep compiling; consumers fall back to a default.
  maxAttachmentBytes?: number;
}

// Default single-attachment size ceiling (100 MiB) when the env var is unset.
export const DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export function normalizeUrl(urlStr: string): { apiUrl: string; webUrl: string } {
  if (!urlStr) {
    throw new Error('VIKUNJA_URL is required but not set.');
  }

  // Reject v1 URLs
  if (urlStr.includes('/api/v1')) {
    throw new Error('Vikunja FastMCP V2 does not support v1 API routes (/api/v1).');
  }

  // Parse URL
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    throw new Error(`Invalid VIKUNJA_URL: ${urlStr}`);
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

  if (!rawUrl) {
    throw new Error('VIKUNJA_URL environment variable is not set.');
  }
  if (!token) {
    throw new Error('VIKUNJA_API_TOKEN environment variable is not set.');
  }

  const { apiUrl, webUrl } = normalizeUrl(rawUrl);

  let normalizedWebUrl = webUrl;
  if (rawWebUrl) {
    try {
      const parsedWeb = new URL(rawWebUrl);
      normalizedWebUrl = parsedWeb.toString();
      if (!normalizedWebUrl.endsWith('/')) {
        normalizedWebUrl += '/';
      }
    } catch {
      throw new Error(`Invalid VIKUNJA_WEB_URL: ${rawWebUrl}`);
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

  return {
    vikunjaUrl: apiUrl,
    vikunjaToken: token,
    vikunjaWebUrl: normalizedWebUrl,
    attachmentDownloadRoot,
    maxAttachmentBytes,
  };
}
