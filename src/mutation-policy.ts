/** Mutation scoping and durable actor-attribution helpers. */

import type { MutationScopeMode } from './config.js';
import { VikunjaError } from './errors.js';
import type { TaskSelectorInput } from './identity.js';

export interface ProjectSelector {
  id?: number;
  title?: string;
}

type WarningSink = (message: string) => void;

function hasProjectScope(project: ProjectSelector | undefined): boolean {
  return project?.id !== undefined || Boolean(project?.title?.trim());
}

function isGlobalTaskId(selector: TaskSelectorInput | undefined): boolean {
  if (selector === undefined) return false;
  if (typeof selector === 'object') return 'globalId' in selector;
  return /^\d+$/.test(String(selector).trim());
}

function defaultWarningSink(message: string): void {
  process.stderr.write(`[vikunja-fastmcp] ${message}\n`);
}

export function enforceMutationProjectScope(
  mode: MutationScopeMode,
  operation: string,
  taskSelector: TaskSelectorInput | undefined,
  projectSelector?: ProjectSelector,
  warn: WarningSink = defaultWarningSink,
): void {
  if (mode === 'off' || !isGlobalTaskId(taskSelector) || hasProjectScope(projectSelector)) return;

  const globalId =
    typeof taskSelector === 'object' && 'globalId' in taskSelector
      ? taskSelector.globalId
      : String(taskSelector).trim();
  const message = `${operation} received global task id ${globalId} without projectSelector.`;
  if (mode === 'warn') {
    warn(
      `${message} Allowed because VIKUNJA_MUTATION_SCOPE_MODE=warn; add explicit project scope.`,
    );
    return;
  }

  throw new VikunjaError({
    status: 400,
    code: 'PROJECT_SCOPE_REQUIRED',
    method: 'TOOLS_CALL',
    path: operation,
    message: `${message} Supply projectSelector or set VIKUNJA_MUTATION_SCOPE_MODE=warn during migration.`,
    fieldErrors: [],
  });
}

export function canonicalizeActor(actor: string): string {
  const normalized = actor
    .trim()
    .replace(
      /\s+\(as\s+([\p{L}\p{N} ._-]+)\)$/iu,
      (_match, delegatedIdentity: string) => ` as ${delegatedIdentity.trim()}`,
    );
  if (!/^[\p{L}\p{N} ._-]+$/u.test(normalized)) {
    throw new VikunjaError({
      status: 400,
      code: 'ACTOR_INVALID',
      method: 'TOOLS_CALL',
      path: 'actor',
      message:
        'actor contains unsupported characters. Use only letters, numbers, spaces, dots, underscores, or hyphens; an optional delegated suffix may use "(as NAME)" (for example, "Codex (as srana)").',
      fieldErrors: [],
    });
  }
  return normalized;
}

function generatedAttributionLine(line: string): boolean {
  return /^(?:\(\s*by\s+[^)\r\n]+\s*\)|by\s+[^\r\n]+|actor\s*:\s*[^\r\n]+)[.!]?$/iu.test(
    line.trim(),
  );
}

export function stripGeneratedAttribution(text: string | undefined): string {
  if (!text) return '';
  return text
    .split(/\r?\n/)
    .filter((line) => !generatedAttributionLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd();
}

export function withActorAttribution(text: string | undefined, actor?: string): string | undefined {
  if (!actor) return text;
  const canonicalActor = canonicalizeActor(actor);
  const suffix = `(by ${canonicalActor})`;
  let body = stripGeneratedAttribution(text);
  const markerMatch = body.match(/(?:^|\n)(\[vfm-key:[A-Za-z0-9][A-Za-z0-9:_\-./#]{0,119}\])\s*$/i);
  const stableMarker = markerMatch?.[1];
  if (stableMarker) body = body.slice(0, markerMatch!.index).trimEnd();
  const escapedActor = canonicalActor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const attributionLine = new RegExp(
    `^(?:\\(\\s*by\\s+${escapedActor}(?:\\s+\\(as\\s+[^)\\r\\n]+\\))?\\s*\\)|by\\s+${escapedActor}(?:\\s+\\(as\\s+[^)\\r\\n]+\\))?|actor\\s*:\\s*${escapedActor})[.!]?$`,
    'iu',
  );
  const lines = body.split(/\r?\n/);
  while (lines.length > 0) {
    const last = lines.at(-1)?.trim() ?? '';
    if (last === '') {
      lines.pop();
      continue;
    }
    if (!attributionLine.test(last)) break;
    lines.pop();
  }
  body = lines.join('\n').trimEnd();
  const attributed = body ? `${body}\n\n${suffix}` : suffix;
  return stableMarker ? `${attributed}\n\n${stableMarker}` : attributed;
}
