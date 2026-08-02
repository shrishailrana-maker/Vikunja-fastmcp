/**
 * self_check diagnostics and declared unsupported operations.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { loadConfig } from './config.js';
import { VikunjaApiClient } from './api.js';
import { fetchAllCollectionItems, normalizePagination } from './format.js';
import { redactSecrets } from './errors.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Operations that are intentionally not registered because the Vikunja v2 API
// exposes no route for them. Surfaced here so tools/list, MCP_API.md, and
// self-check agree on the supported surface.
export const UNSUPPORTED_OPERATIONS: { operation: string; reason: string }[] = [
  {
    operation: 'vikunja_filters:list',
    reason: 'The Vikunja v2 API has no collection GET /filters route.',
  },
];

export const OPERATIONAL_NOTES: string[] = [
  'Task list defaults to open tasks only (done=false). Pass allStates:true for open+closed, or done:true for closed-only.',
  'create_if_absent is best-effort (not a distributed lock). Uses server title equality when safe; otherwise paginated q+exact match.',
  'Team add-member returns userId (Vikunja user id). Do not treat membership row ids as user ids.',
  'Bulk writes use durable local row receipts and resume, but remain non-atomic across hosts.',
  'Templates are machine-local JSON, not Vikunja server entities. Set VIKUNJA_TEMPLATE_FILE to relocate the store.',
  'CSV imports, exports, and downloads obey the configured attachment size/path sandbox.',
  'User-data export authentication is server-specific; some Vikunja builds reject API tokens and require JWT/local-password confirmation.',
  'Task label operations require the caller to have the corresponding label and project permissions.',
];

export const SERVER_DEPENDENT_CAPABILITIES = [
  {
    capability: 'external-key-uniqueness',
    supported: false,
    upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3391',
    fallback: 'Bounded lookup plus durable local idempotency; concurrent hosts can still race.',
  },
  {
    capability: 'task-write-if-match',
    supported: false,
    upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3392',
    fallback:
      'Replacement updates require expectedUpdatedAt and perform a best-effort preflight check.',
  },
  {
    capability: 'atomic-evidence-transition',
    supported: false,
    upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3393',
    fallback: 'MCP-composed comment then transition with truthful partial receipts and read-back.',
  },
  {
    capability: 'cross-host-task-lease',
    supported: false,
    upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3394',
    fallback: 'SQLite/WAL leases coordinate one machine only.',
  },
  {
    capability: 'server-attachment-hash',
    supported: false,
    upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3395',
    fallback: 'Optional local SHA-256 receipts and filename/size duplicate warnings.',
  },
  {
    capability: 'collection-etag',
    supported: false,
    upstreamIssue: 'https://github.com/go-vikunja/vikunja/issues/3396',
    fallback:
      'Only short-lived identity-resolution caches are used; task/list content is never cached.',
  },
] as const;

export interface DiagnosticResult {
  ok: boolean;
  diagnostics: {
    vikunjaUrl: string;
    connectionStatus: 'online' | 'offline';
    authenticationState: 'authenticated' | 'unauthenticated' | 'unknown';
    currentUser?: { id: number; username: string };
    connectionError?: string;
    apiContractVersion: 'v2';
    packageVersion: string;
    attachmentDownloadRootWritable: boolean;
    projectCount: number;
    projects?: { id: number; title: string; archived: boolean }[];
    tokenPresent?: boolean;
    buildPath?: string;
    apiDocumentPath?: string;
    agentSkillPath?: string;
    attachmentDownloadRoot?: string;
    supportedTools?: string[];
    supportedSubcommands?: Record<string, string[]>;
    unsupportedOperations?: { operation: string; reason: string }[];
    operationalNotes?: string[];
    serverDependentCapabilities?: typeof SERVER_DEPENDENT_CAPABILITIES;
  };
}

export interface DiagnosticToolManifest {
  name: string;
  subcommands: string[];
}

export async function runSelfCheck(
  toolManifest: DiagnosticToolManifest[] = [],
  detail: 'basic' | 'full' = 'basic',
): Promise<DiagnosticResult> {
  const buildPath = fileURLToPath(import.meta.url);
  const packageRoot = path.resolve(path.dirname(buildPath), '..');
  let packageVersion = 'unknown';
  try {
    const packageJson = JSON.parse(
      await fs.readFile(path.join(packageRoot, 'package.json'), 'utf8'),
    );
    packageVersion = String(packageJson.version ?? 'unknown');
  } catch {
    // A missing package file is reported in diagnostics without exposing paths or secrets.
  }

  const diagnostics: DiagnosticResult['diagnostics'] = {
    vikunjaUrl: 'unknown',
    connectionStatus: 'offline',
    authenticationState: 'unknown',
    apiContractVersion: 'v2',
    packageVersion,
    attachmentDownloadRootWritable: false,
    projectCount: 0,
  };
  if (detail === 'full') {
    Object.assign(diagnostics, {
      tokenPresent: false,
      buildPath,
      apiDocumentPath: path.join(packageRoot, 'MCP_API.md'),
      agentSkillPath: path.join(packageRoot, 'skills', 'vikunja-fastmcp', 'SKILL.md'),
      attachmentDownloadRoot: 'unknown',
      projects: [],
      supportedTools: toolManifest.map((tool) => tool.name),
      supportedSubcommands: Object.fromEntries(
        toolManifest.map((tool) => [tool.name, tool.subcommands]),
      ),
      unsupportedOperations: UNSUPPORTED_OPERATIONS,
      operationalNotes: OPERATIONAL_NOTES,
      serverDependentCapabilities: SERVER_DEPENDENT_CAPABILITIES,
    });
  }

  let config;
  try {
    config = loadConfig();
    diagnostics.vikunjaUrl = config.vikunjaUrl;
    if (detail === 'full') {
      diagnostics.tokenPresent = !!config.vikunjaToken;
      diagnostics.attachmentDownloadRoot = config.attachmentDownloadRoot;
    }
  } catch (err: any) {
    return {
      ok: false,
      diagnostics: {
        ...diagnostics,
        connectionError: `Configuration error: ${redactSecrets(err.message)}`,
      },
    };
  }

  // 1. Verify attachment root is writable
  try {
    await fs.mkdir(config.attachmentDownloadRoot, { recursive: true });
    const tempFile = path.join(
      config.attachmentDownloadRoot,
      `.self-check-write-test-${Date.now()}`,
    );
    await fs.writeFile(tempFile, 'write test');
    await fs.unlink(tempFile);
    diagnostics.attachmentDownloadRootWritable = true;
  } catch (err: any) {
    diagnostics.attachmentDownloadRootWritable = false;
    diagnostics.connectionError = `Download root write failure: ${redactSecrets(err.message, config.vikunjaToken)}`;
  }

  // 2. Verify authenticated server access and return compact project orientation.
  const client = new VikunjaApiClient(config);
  try {
    const user = await client.request<any>('GET', '/user');
    diagnostics.currentUser = { id: user.id, username: user.username };
    diagnostics.authenticationState = 'authenticated';
    diagnostics.connectionStatus = 'online';
    if (detail === 'full') {
      const projects = await fetchAllCollectionItems<any>(
        async (requestPath) => client.request<any>('GET', requestPath),
        '/projects',
      );
      const projectSummaries = projects.map((project) => ({
        id: project.id,
        title: project.title,
        archived: !!project.is_archived,
      }));
      diagnostics.projectCount = projectSummaries.length;
      diagnostics.projects = projectSummaries;
    } else {
      const projectPage = await client.request<any>('GET', '/projects?page=1&per_page=1');
      diagnostics.projectCount = normalizePagination(projectPage).total;
    }
  } catch (err: any) {
    diagnostics.authenticationState = err?.status === 401 ? 'unauthenticated' : 'unknown';
    diagnostics.connectionStatus = err?.code === 'NETWORK_ERROR' ? 'offline' : 'online';
    diagnostics.connectionError = redactSecrets(
      err.message || 'Failed to connect to Vikunja server',
      config.vikunjaToken,
    );
  }

  // If download directory is not writable or connection is offline, ok is false
  const ok =
    diagnostics.attachmentDownloadRootWritable &&
    diagnostics.connectionStatus === 'online' &&
    diagnostics.authenticationState === 'authenticated' &&
    packageVersion !== 'unknown';

  return {
    ok,
    diagnostics,
  };
}
