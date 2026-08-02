import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import { openSafeDestination, resolveSafePath } from './attachments.js';
import { exportProject } from './data.js';
import { redactSecrets, VikunjaError } from './errors.js';
import { GitHubIssueDestination, type GitHubDestinationConfig } from './github-destination.js';
import { claimDurableOperation, idempotency, payloadFingerprint } from './idempotency.js';
import { closeWithEvidence } from './tasks.js';
import type { VikunjaApiClient } from './api.js';

export interface ProjectMigrationOptions {
  projectSelector: { id?: number; title?: string };
  destination: GitHubDestinationConfig;
  actor: string;
  idempotencyKey: string;
  archiveSource?: boolean;
  publicSanitize?: boolean;
}

interface MigrationManifest {
  schemaVersion: 1;
  operationFingerprint: string;
  generatedAt: string;
  source: { project: any };
  destination: { type: 'github'; owner: string; repo: string; apiUrl: string };
  capabilities: { binaryAttachments: false; attachmentMetadata: true };
  tasks: any[];
  sanitizationCount: number;
}

const MIGRATION_LEASE_MS = 120_000;

function privateNetworkHostname(value: string): boolean {
  const hostname = value
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  const ipVersion = isIP(hostname);
  if (ipVersion === 4) {
    const [first, second] = hostname.split('.').map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && second === 168) ||
      first >= 224
    );
  }
  if (ipVersion === 6) {
    return (
      hostname === '::' ||
      hostname === '::1' ||
      hostname.startsWith('::ffff:') ||
      hostname.startsWith('fc') ||
      hostname.startsWith('fd') ||
      hostname.startsWith('fe8') ||
      hostname.startsWith('fe9') ||
      hostname.startsWith('fea') ||
      hostname.startsWith('feb')
    );
  }
  return (
    hostname === 'localhost' ||
    !hostname.includes('.') ||
    ['.local', '.localhost', '.internal', '.lan', '.home', '.corp'].some((suffix) =>
      hostname.endsWith(suffix),
    )
  );
}

export function sanitizePublicString(value: string, configuredToken?: string): string {
  let safe = value;
  const exactTokens = [configuredToken, process.env.GITHUB_TOKEN, process.env.GH_TOKEN]
    .filter((token): token is string => typeof token === 'string')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  for (const token of new Set(exactTokens)) safe = redactSecrets(safe, token);
  safe = safe.replace(/\bgithub_pat_[A-Za-z0-9_]{6,}\b/gi, '[REDACTED_TOKEN]');
  safe = safe.replace(/\b(?:tk|gh[pousr])_[A-Za-z0-9_-]{6,}\b/gi, '[REDACTED_TOKEN]');
  safe = safe.replace(/file:\/\/(?:\/|\\)?[^\s"'<>)]*/gi, '[private-path]');
  safe = safe.replace(/https?:\/\/(?:\[[^\]]+\]|[^\s/:?#)]+)(?::\d+)?[^\s)]*/gi, (url) => {
    try {
      return privateNetworkHostname(new URL(url).hostname) ? '[private-url]' : url;
    } catch {
      return '[private-url]';
    }
  });
  safe = safe.replace(/\b[A-Za-z]:\\[^\r\n"'<>|;,)]*/g, '[private-path]');
  safe = safe.replace(
    /\b(?:\/home|\/Users|\/root|\/tmp|\/var\/tmp|\/opt|\/srv|\/mnt|\/media)\/[^\s"'<>]+/g,
    '[private-path]',
  );
  safe = safe.replace(/\\\\[^\s\\]+\\[^\s"'<>]+/g, '[private-path]');
  return safe;
}

function sanitizeValue(value: unknown, configuredToken: string): { value: unknown; count: number } {
  if (typeof value === 'string') {
    const sanitized = sanitizePublicString(value, configuredToken);
    return { value: sanitized, count: sanitized === value ? 0 : 1 };
  }
  if (Array.isArray(value)) {
    const items = value.map((item) => sanitizeValue(item, configuredToken));
    return {
      value: items.map((item) => item.value),
      count: items.reduce((n, item) => n + item.count, 0),
    };
  }
  if (value && typeof value === 'object') {
    let count = 0;
    const entries = Object.entries(value).map(([key, item]) => {
      const sanitized = sanitizeValue(item, configuredToken);
      count += sanitized.count;
      return [key, sanitized.value];
    });
    return { value: Object.fromEntries(entries), count };
  }
  return { value, count: 0 };
}

function operationFileId(operationKey: string): string {
  return createHash('sha256').update(operationKey).digest('hex').slice(0, 20);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(root: string, filePath: string, value: unknown): Promise<void> {
  const { handle } = await openSafeDestination(root, filePath);
  try {
    await handle.writeFile(JSON.stringify(value, null, 2));
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(filePath).catch(() => {});
    throw error;
  }
  await handle.close();
}

function destinationIdentity(destination: GitHubDestinationConfig) {
  return {
    type: 'github' as const,
    owner: destination.owner,
    repo: destination.repo,
    apiUrl: destination.apiUrl?.trim().replace(/\/+$/, '') || 'https://api.github.com',
  };
}

function migrationOperationFingerprint(options: ProjectMigrationOptions): string {
  return payloadFingerprint({
    projectSelector: options.projectSelector,
    destination: destinationIdentity(options.destination),
    archiveSource: options.archiveSource === true,
    publicSanitize: true,
  });
}

function manifestFingerprint(manifest: MigrationManifest): string {
  return payloadFingerprint(manifest);
}

function validateManifest(
  manifest: any,
  expectedOperationFingerprint: string,
  expectedHash?: string,
): asserts manifest is MigrationManifest {
  const valid =
    manifest?.schemaVersion === 1 &&
    manifest?.operationFingerprint === expectedOperationFingerprint &&
    manifest?.source?.project &&
    Number.isSafeInteger(Number(manifest.source.project.id)) &&
    manifest?.destination?.type === 'github' &&
    typeof manifest.destination.owner === 'string' &&
    typeof manifest.destination.repo === 'string' &&
    typeof manifest.destination.apiUrl === 'string' &&
    Array.isArray(manifest.tasks) &&
    manifest?.capabilities?.binaryAttachments === false &&
    manifest?.capabilities?.attachmentMetadata === true;
  const actualHash = valid ? manifestFingerprint(manifest as MigrationManifest) : '';
  if (!valid || (expectedHash !== undefined && actualHash !== expectedHash)) {
    throw new VikunjaError({
      status: 409,
      code: 'MIGRATION_MANIFEST_INTEGRITY_ERROR',
      method: 'READ',
      path: 'migration.manifest',
      message: 'The saved migration manifest does not match this operation or its recorded hash.',
      fieldErrors: [],
    });
  }
}

function migrationMarkerPrefix(projectId: number, taskReference: string): string {
  return `<!-- vfm-migration:${projectId}:${taskReference}:`;
}

function migrationMarker(projectId: number, taskReference: string, contentHash: string): string {
  return `${migrationMarkerPrefix(projectId, taskReference)}sha256:${contentHash} -->`;
}

function commentMarker(
  projectId: number,
  taskReference: string,
  commentId: number,
  contentHash: string,
): string {
  return `<!-- vfm-migration-comment:${projectId}:${taskReference}:${commentId}:sha256:${contentHash} -->`;
}

function issuePayload(project: any, task: any): { body: string; marker: string } {
  const lines = [
    `Migrated from **${project.title}** as **${task.identifier || `#${task.index}`}**.`,
    '',
    `- Source state: ${task.done ? 'done' : 'open'}`,
    `- Priority: ${task.priority ?? 0}`,
    `- Labels: ${(task.labels ?? []).join(', ') || 'none'}`,
    `- Assignees: ${(task.assignees ?? []).join(', ') || 'none'}`,
    `- Attachments: ${task.attachmentCount ?? 0} (metadata only; binary transfer unsupported)`,
    `- Relations: ${task.relationCount ?? 0}`,
    '',
    task.description || '_No description._',
  ];
  if (Array.isArray(task.attachments) && task.attachments.length > 0) {
    lines.push('', '### Attachment metadata');
    for (const attachment of task.attachments) {
      lines.push(`- ${attachment.fileName} (${attachment.fileSize} bytes, ${attachment.mime})`);
    }
  }
  if (Array.isArray(task.relations) && task.relations.length > 0) {
    lines.push('', '### Source relations');
    for (const relation of task.relations) {
      lines.push(
        `- ${relation.kind}: ${relation.identifier || 'unknown reference'} — ${relation.title}`,
      );
    }
  }
  const baseBody = lines.join('\n');
  const reference = task.identifier || `#${task.index}`;
  const contentHash = payloadFingerprint({ title: task.title, body: baseBody });
  const marker = migrationMarker(project.id, reference, contentHash);
  const body = `${baseBody}\n\n${marker}`;
  if (body.length > 60_000) {
    throw new VikunjaError({
      status: 413,
      code: 'MIGRATION_ISSUE_BODY_TOO_LARGE',
      method: 'POST',
      path: 'github.issue.body',
      message: `Source task ${task.identifier || task.id} exceeds the 60,000-character migration limit.`,
      fieldErrors: [],
    });
  }
  return { body, marker };
}

async function buildManifest(
  client: VikunjaApiClient,
  operationKey: string,
  options: ProjectMigrationOptions,
  operationFingerprint: string,
  expectedHash?: string,
): Promise<{ manifest: MigrationManifest; manifestFileName: string; manifestHash: string }> {
  if (options.publicSanitize === false) {
    throw new VikunjaError({
      status: 400,
      code: 'PUBLIC_SANITIZATION_REQUIRED',
      method: 'TOOLS_CALL',
      path: 'publicSanitize',
      message: 'Public-content sanitization cannot be disabled for GitHub migration.',
      fieldErrors: [],
    });
  }
  const root = client.getConfig().attachmentDownloadRoot;
  const id = operationFileId(operationKey);
  const manifestFileName = `migration-${id}.manifest.json`;
  const manifestPath = resolveSafePath(root, manifestFileName);
  if (await pathExists(manifestPath)) {
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    validateManifest(manifest, operationFingerprint, expectedHash);
    return { manifest, manifestFileName, manifestHash: manifestFingerprint(manifest) };
  }
  const sourceFileName = `migration-${id}.source.json`;
  let exportedPath: string | undefined;
  let source: any;
  try {
    const exported = await exportProject(
      client,
      options.projectSelector,
      'json',
      sourceFileName,
      true,
      true,
      true,
    );
    exportedPath = exported.path;
    source = JSON.parse(await fs.readFile(exported.path, 'utf8'));
  } finally {
    if (exportedPath) await fs.unlink(exportedPath).catch(() => {});
  }
  const sanitized = sanitizeValue(source, client.getConfig().vikunjaToken);
  const value = sanitized.value as any;
  const manifest: MigrationManifest = {
    schemaVersion: 1,
    operationFingerprint,
    generatedAt: new Date().toISOString(),
    source: { project: value.project },
    destination: destinationIdentity(options.destination),
    capabilities: { binaryAttachments: false, attachmentMetadata: true },
    tasks: value.tasks,
    sanitizationCount: sanitized.count,
  };
  await writeJson(root, manifestPath, manifest);
  return { manifest, manifestFileName, manifestHash: manifestFingerprint(manifest) };
}

function retryable(error: any): boolean {
  const status = Number(error?.status);
  return !Number.isFinite(status) || status === 408 || status === 429 || status >= 500;
}

function migrationSummary(state: any) {
  const receipts = Array.isArray(state.receipts) ? state.receipts : [];
  return {
    operationId: state.operationId,
    status: state.status,
    requested: state.requested,
    migrated: receipts.filter((receipt: any) => receipt.status === 'verified').length,
    skipped: receipts.filter((receipt: any) => receipt.skipped === true).length,
    failed: receipts.filter((receipt: any) => receipt.status === 'failed').length,
    archived: receipts.filter((receipt: any) => receipt.sourceArchived === true).length,
    manifestFile: state.manifestFile,
    binaryAttachmentsTransferred: false,
  };
}

function migrationLeaseLost(): VikunjaError {
  return new VikunjaError({
    status: 409,
    code: 'MIGRATION_LEASE_LOST',
    method: 'TOOLS_CALL',
    path: 'vikunja_project_migration.run',
    message: 'Migration lease ownership was lost. No further source or destination writes ran.',
    fieldErrors: [],
  });
}

function migratedComments(projectId: number, sourceReference: string, comments: any[]) {
  return comments.map((comment: any) => {
    const metadata = [
      `_Source author: ${comment.author?.username ?? 'unknown'}_`,
      `_Source created: ${comment.created ?? 'unknown'}_`,
      `_Source updated: ${comment.updated ?? comment.created ?? 'unknown'}_`,
    ];
    const body = `${comment.comment}\n\n${metadata.join('\n')}`;
    const contentHash = payloadFingerprint({ body });
    return {
      sourceId: comment.id,
      body,
      marker: commentMarker(projectId, sourceReference, comment.id, contentHash),
    };
  });
}

export async function previewProjectMigration(
  client: VikunjaApiClient,
  options: ProjectMigrationOptions,
) {
  const operationKey = claimDurableOperation('project-migration-preview', options.idempotencyKey, {
    projectSelector: options.projectSelector,
    destination: options.destination,
    publicSanitize: options.publicSanitize !== false,
  });
  const operationFingerprint = migrationOperationFingerprint(options);
  const { manifest, manifestFileName } = await buildManifest(
    client,
    operationKey,
    options,
    operationFingerprint,
  );
  return {
    status: 'preview',
    taskCount: manifest.tasks.length,
    commentCount: manifest.tasks.reduce((count, task) => count + Number(task.commentCount ?? 0), 0),
    attachmentCount: manifest.tasks.reduce(
      (count, task) => count + Number(task.attachmentCount ?? 0),
      0,
    ),
    relationCount: manifest.tasks.reduce(
      (count, task) => count + Number(task.relationCount ?? 0),
      0,
    ),
    sanitizationCount: manifest.sanitizationCount,
    manifestFile: manifestFileName,
    binaryAttachmentTransferSupported: false,
  };
}

export async function runProjectMigration(
  client: VikunjaApiClient,
  options: ProjectMigrationOptions,
) {
  const operationKey = claimDurableOperation('project-migration', options.idempotencyKey, {
    projectSelector: options.projectSelector,
    destination: options.destination,
    archiveSource: options.archiveSource === true,
    publicSanitize: options.publicSanitize !== false,
    actor: options.actor,
  });
  const operationId = operationFileId(operationKey);
  const stateKey = `project-migration-state:${operationId}`;
  const operationFingerprint = migrationOperationFingerprint(options);
  const leased = idempotency.acquireLease(
    stateKey,
    {
      operationId,
      status: 'running',
      requested: 0,
      receipts: [],
      operationFingerprint,
    },
    MIGRATION_LEASE_MS,
  );
  if (!leased.acquired) return migrationSummary(leased.value);
  const state = leased.value;
  if (!leased.leaseToken) throw migrationLeaseLost();
  let leaseLost = false;
  const renewLease = () => {
    if (leaseLost || !idempotency.renewLease(stateKey, leased.leaseToken!, MIGRATION_LEASE_MS)) {
      leaseLost = true;
      throw migrationLeaseLost();
    }
  };
  const saveState = () => {
    if (!idempotency.setIfLeaseOwner(stateKey, leased.leaseToken!, state)) {
      leaseLost = true;
      throw migrationLeaseLost();
    }
  };
  const heartbeat = setInterval(
    () => {
      try {
        renewLease();
      } catch {
        leaseLost = true;
      }
    },
    Math.floor(MIGRATION_LEASE_MS / 3),
  );
  heartbeat.unref();

  try {
    renewLease();
    const { manifest, manifestFileName, manifestHash } = await buildManifest(
      client,
      operationKey,
      options,
      operationFingerprint,
      state.manifestHash,
    );
    state.requested = manifest.tasks.length;
    state.manifestFile = manifestFileName;
    state.manifestHash = manifestHash;
    state.operationFingerprint = operationFingerprint;
    saveState();
    const destination = new GitHubIssueDestination(options.destination, renewLease);

    for (const task of manifest.tasks) {
      renewLease();
      const existingReceipt = state.receipts.find(
        (receipt: any) => receipt.sourceTaskId === task.id,
      );
      if (existingReceipt?.status === 'verified' || existingReceipt?.retryable === false) {
        if (existingReceipt) existingReceipt.skipped = true;
        continue;
      }
      state.receipts = state.receipts.filter((receipt: any) => receipt.sourceTaskId !== task.id);
      try {
        const sourceReference = task.identifier || `#${task.index}`;
        const expectedIssue = issuePayload(manifest.source.project, task);
        let issue = await destination.findIssueByMarker(
          migrationMarkerPrefix(manifest.source.project.id, sourceReference),
        );
        const action = issue ? 'reused' : 'created';
        if (!issue) issue = await destination.createIssue(task.title, expectedIssue.body);
        const readBack = await destination.readIssue(issue.number);
        if (readBack.title !== task.title || readBack.body !== expectedIssue.body) {
          throw new VikunjaError({
            status: 502,
            code: 'MIGRATION_READBACK_MISMATCH',
            method: 'GET',
            path: `github.issue.${issue.number}`,
            message: `Destination issue ${issue.number} did not match the complete source payload.`,
            fieldErrors: [],
          });
        }
        const comments = migratedComments(
          manifest.source.project.id,
          sourceReference,
          task.comments ?? [],
        );
        const commentsCreated = await destination.migrateComments(issue.number, comments);
        await destination.verifyComments(issue.number, comments);
        renewLease();
        let sourceArchived = false;
        if (options.archiveSource) {
          const close = await closeWithEvidence(
            client,
            { globalId: task.id },
            `Migrated, not implemented. Destination: [#${issue.number}](${issue.url})`,
            { id: manifest.source.project.id },
            `migration:${operationId}:source:${task.id}`,
            options.actor,
          );
          renewLease();
          if (close.outcome === 'partial') {
            throw new VikunjaError({
              status: close.error?.status ?? 502,
              code: 'MIGRATION_SOURCE_ARCHIVE_PARTIAL',
              method: 'PATCH',
              path: `/tasks/${task.id}`,
              message:
                close.error?.message ?? 'Destination verified, but source closure was partial.',
              fieldErrors: [],
            });
          }
          sourceArchived = close.taskStatus === 'closed';
        }
        const receipt = {
          sourceTaskId: task.id,
          sourceIdentifier: sourceReference,
          status: 'verified',
          destination: { number: issue.number, url: issue.url },
          action,
          issueHash: payloadFingerprint({ title: task.title, body: expectedIssue.body }),
          commentsCreated,
          commentsVerified: comments.length,
          sourceArchived,
          skipped: false,
        };
        state.receipts.push({ ...receipt, resultHash: payloadFingerprint(receipt) });
      } catch (error: any) {
        if (error?.code === 'MIGRATION_LEASE_LOST') throw error;
        const message = redactSecrets(
          redactSecrets(
            String(error?.message ?? error),
            process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
          ),
          client.getConfig().vikunjaToken,
        );
        const receipt = {
          sourceTaskId: task.id,
          sourceIdentifier: task.identifier || `#${task.index}`,
          status: 'failed',
          error: message,
          retryable: retryable(error),
          skipped: false,
        };
        state.receipts.push({ ...receipt, resultHash: payloadFingerprint(receipt) });
      }
      state.status = 'running';
      saveState();
    }
    state.status = state.receipts.some((receipt: any) => receipt.status === 'failed')
      ? 'partial'
      : 'completed';
    saveState();
    return migrationSummary(state);
  } catch (error: any) {
    if (!leaseLost) {
      state.status = 'partial';
      state.operationError = redactSecrets(
        redactSecrets(
          String(error?.message ?? error),
          process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN,
        ),
        client.getConfig().vikunjaToken,
      );
      idempotency.setIfLeaseOwner(stateKey, leased.leaseToken, state);
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
  }
}

export function getProjectMigrationStatus(
  operationId: string,
  cursor = 0,
  perPage = 50,
  countOnly = false,
) {
  const state = idempotency.get(`project-migration-state:${operationId}`);
  if (!state) {
    throw new VikunjaError({
      status: 404,
      code: 'MIGRATION_OPERATION_NOT_FOUND',
      method: 'TOOLS_CALL',
      path: 'vikunja_project_migration.status',
      message: `No project migration operation was found for "${operationId}".`,
      fieldErrors: [],
    });
  }
  const receipts = [...(state.receipts ?? [])].sort(
    (left: any, right: any) => left.sourceTaskId - right.sourceTaskId,
  );
  const safeCursor = Math.max(0, cursor);
  const safePerPage = Math.min(100, Math.max(1, perPage));
  const page = countOnly ? [] : receipts.slice(safeCursor, safeCursor + safePerPage);
  const next = safeCursor + page.length;
  return {
    ...migrationSummary(state),
    receipts: page,
    returnedCount: page.length,
    totalCount: receipts.length,
    nextCursor: !countOnly && next < receipts.length ? String(next) : null,
    incomplete: !countOnly && next < receipts.length,
  };
}
