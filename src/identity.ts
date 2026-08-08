/**
 * Project and task identity resolution with a short-lived cache.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { VikunjaApiClient } from './api.js';
import { VikunjaError } from './errors.js';
import { fetchAllCollectionItems, toItemArray } from './format.js';

export interface ProjectRef {
  id: number;
  title: string;
}

export interface TaskRef {
  id: number;
  index: number;
  identifier?: string;
  project: ProjectRef;
  title: string;
  labels: { id: number; title: string }[];
  assignees: { id: number; username: string }[];
  rawTask?: any;
}

function projectRefFromApi(project: any, apiPath: string): ProjectRef {
  const id = Number(project?.id);
  const title = typeof project?.title === 'string' ? project.title.trim() : '';
  if (!Number.isInteger(id) || id <= 0 || title === '') {
    throw new VikunjaError({
      status: 502,
      code: 'INVALID_API_RESPONSE',
      method: 'GET',
      path: apiPath,
      message: 'Vikunja returned a project without a valid positive id and non-empty title.',
      fieldErrors: [],
    });
  }
  return { id, title };
}

export type TaskSelector = { globalId: number } | { identifier: string } | { projectIndex: number };
export type TaskSelectorInput = TaskSelector | string | number;

interface ResolveTaskOptions {
  includeRawTask?: boolean;
}

function taskLabels(task: any): { id: number; title: string }[] {
  return Array.isArray(task.labels)
    ? task.labels.map((label: any) => ({ id: label.id, title: label.title }))
    : [];
}

function taskAssignees(task: any): { id: number; username: string }[] {
  return Array.isArray(task.assignees)
    ? task.assignees.map((user: any) => ({ id: user.id, username: user.username }))
    : [];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class IdentityCache {
  private projectCache = new Map<string, CacheEntry<ProjectRef>>();
  private projectIdCache = new Map<number, CacheEntry<ProjectRef>>();
  private ambiguousProjectCache = new Map<string, CacheEntry<ProjectRef[]>>();
  private projectIdentifierCache = new Map<string, ProjectRef[]>();
  private projectIdentifierCacheExpiresAt = 0;
  private labelCache = new Map<string, CacheEntry<number>>();

  getProject(title: string): ProjectRef | null {
    const candidates = this.getProjectCandidates(title);
    return candidates?.length === 1 ? candidates[0] : null;
  }

  getProjectCandidates(title: string): ProjectRef[] | null {
    const key = title.toLowerCase();
    const ambiguous = this.ambiguousProjectCache.get(key);
    if (ambiguous && ambiguous.expiresAt > Date.now()) return ambiguous.value;
    this.ambiguousProjectCache.delete(key);
    const entry = this.projectCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return [entry.value];
    }
    this.projectCache.delete(key);
    return null;
  }

  getProjectById(id: number): ProjectRef | null {
    const entry = this.projectIdCache.get(id);
    if (entry && entry.expiresAt > Date.now()) return entry.value;
    this.projectIdCache.delete(id);
    return null;
  }

  setProject(title: string, ref: ProjectRef) {
    if (typeof title !== 'string' || title.trim() === '') {
      throw new VikunjaError({
        status: 502,
        code: 'INVALID_API_RESPONSE',
        method: 'GET',
        path: '/projects',
        message: 'Vikunja returned a project without a valid title.',
        fieldErrors: [],
      });
    }
    const key = title.toLowerCase();
    const current = this.getProjectCandidates(title) ?? [];
    const candidates = [...new Map([...current, ref].map((item) => [item.id, item])).values()];
    this.projectIdCache.set(ref.id, {
      value: { id: ref.id, title: ref.title },
      expiresAt: Date.now() + 45000,
    });
    if (candidates.length > 1) {
      this.projectCache.delete(key);
      this.ambiguousProjectCache.set(key, {
        value: candidates,
        expiresAt: Date.now() + 45000,
      });
      return;
    }
    this.ambiguousProjectCache.delete(key);
    this.projectCache.set(key, {
      value: { id: ref.id, title: ref.title },
      expiresAt: Date.now() + 45000,
    });
  }

  invalidateProject(title: string) {
    for (const [id, entry] of this.projectIdCache) {
      if (entry.value.title.toLowerCase() === title.toLowerCase()) this.projectIdCache.delete(id);
    }
    this.projectCache.delete(title.toLowerCase());
    this.ambiguousProjectCache.delete(title.toLowerCase());
    this.clearProjectIdentifiers();
  }

  clearProjects() {
    this.projectCache.clear();
    this.projectIdCache.clear();
    this.ambiguousProjectCache.clear();
    this.clearProjectIdentifiers();
  }

  getProjectsByIdentifier(identifier: string): ProjectRef[] | null {
    if (this.projectIdentifierCacheExpiresAt <= Date.now()) {
      this.clearProjectIdentifiers();
      return null;
    }
    return this.projectIdentifierCache.get(identifier.toLowerCase()) ?? [];
  }

  setProjectIdentifiers(projects: { id: number; title: string; identifier?: string }[]) {
    this.projectIdentifierCache.clear();
    for (const project of projects) {
      const identifier = typeof project?.identifier === 'string' ? project.identifier.trim() : '';
      if (!identifier) continue;
      const ref = projectRefFromApi(project, '/projects');
      this.setProject(ref.title, ref);
      const key = identifier.toLowerCase();
      this.projectIdentifierCache.set(key, [...(this.projectIdentifierCache.get(key) ?? []), ref]);
    }
    this.projectIdentifierCacheExpiresAt = Date.now() + 45000;
  }

  private clearProjectIdentifiers() {
    this.projectIdentifierCache.clear();
    this.projectIdentifierCacheExpiresAt = 0;
  }

  getLabel(title: string): number | null {
    const key = title.toLowerCase();
    const entry = this.labelCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value;
    }
    this.labelCache.delete(key);
    return null;
  }

  setLabel(title: string, id: number) {
    const key = title.toLowerCase();
    this.labelCache.set(key, {
      value: id,
      expiresAt: Date.now() + 45000,
    });
  }

  invalidateLabel(title: string) {
    this.labelCache.delete(title.toLowerCase());
  }

  clearLabels() {
    this.labelCache.clear();
  }
}

export const cache = new IdentityCache();

let projectCatalogInFlight: Promise<any[]> | null = null;
function fetchProjectCatalog(client: VikunjaApiClient): Promise<any[]> {
  return fetchAllCollectionItems(async (path) => client.request<any>('GET', path), '/projects');
}

async function listAllProjects(client: VikunjaApiClient): Promise<any[]> {
  if (!projectCatalogInFlight) {
    projectCatalogInFlight = (async () => {
      try {
        return await fetchProjectCatalog(client);
      } catch (error) {
        if (!(error instanceof VikunjaError) || error.status < 500 || error.status >= 600) {
          throw error;
        }
        return fetchProjectCatalog(client);
      }
    })().finally(() => {
      projectCatalogInFlight = null;
    });
  }
  return projectCatalogInFlight;
}

function invalidProjectCatalogForTitle(title: string): VikunjaError {
  return new VikunjaError({
    status: 502,
    code: 'INVALID_API_RESPONSE',
    method: 'GET',
    path: '/projects',
    message: `Vikunja returned a malformed project that could match "${title}"; title resolution cannot be proven complete.`,
    fieldErrors: [],
  });
}

async function validProjectsForTitle(client: VikunjaApiClient, title: string): Promise<any[]> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const valid: any[] = [];
    let couldMatchMalformed = false;
    for (const project of await listAllProjects(client)) {
      try {
        valid.push({ ...project, ...projectRefFromApi(project, '/projects') });
      } catch (error) {
        if (!(error instanceof VikunjaError) || error.code !== 'INVALID_API_RESPONSE') throw error;
        const rawTitle = typeof project?.title === 'string' ? project.title.trim() : '';
        if (!rawTitle || rawTitle.toLowerCase() === title.toLowerCase()) {
          couldMatchMalformed = true;
        }
      }
    }
    if (!couldMatchMalformed) return valid;
    if (attempt === 1) throw invalidProjectCatalogForTitle(title);
  }
  throw invalidProjectCatalogForTitle(title);
}

export async function listAllLabels(client: VikunjaApiClient): Promise<any[]> {
  return fetchAllCollectionItems(async (path) => client.request<any>('GET', path), '/labels');
}

async function resolveProjectIdentifier(
  client: VikunjaApiClient,
  identifier: string,
): Promise<ProjectRef> {
  let matches = cache.getProjectsByIdentifier(identifier);
  const usedCachedCatalog = matches !== null;
  if (matches === null) {
    cache.setProjectIdentifiers(await listAllProjects(client));
    matches = cache.getProjectsByIdentifier(identifier) ?? [];
  }

  // An identifier can be assigned while this long-running MCP holds a recent
  // project catalog. Refresh once before returning an unknown-prefix error.
  if (matches.length === 0 && usedCachedCatalog) {
    cache.clearProjects();
    cache.setProjectIdentifiers(await listAllProjects(client));
    matches = cache.getProjectsByIdentifier(identifier) ?? [];
  }

  if (matches.length === 0) {
    throw new VikunjaError({
      status: 400,
      code: 'UNKNOWN_PROJECT_IDENTIFIER',
      method: 'GET',
      path: '/projects',
      message: `No project uses identifier "${identifier}".`,
      fieldErrors: [],
    });
  }

  if (matches.length > 1) {
    throw new VikunjaError({
      status: 400,
      code: 'AMBIGUOUS_PROJECT_IDENTIFIER',
      method: 'GET',
      path: '/projects',
      message: `Multiple projects use identifier "${identifier}". Candidates: ${JSON.stringify(matches)}`,
      fieldErrors: [],
    });
  }

  return matches[0];
}

export async function resolveProject(
  client: VikunjaApiClient,
  selector: { id?: number; title?: string },
): Promise<ProjectRef> {
  if (selector.id !== undefined) {
    if (selector.id <= 0) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_PROJECT_ID',
        method: 'GET',
        path: `/projects/${selector.id}`,
        message: `Invalid project ID: ${selector.id}`,
        fieldErrors: [],
      });
    }

    const cached = cache.getProjectById(selector.id);
    if (cached) {
      if (
        selector.title !== undefined &&
        cached.title.toLowerCase() !== selector.title.toLowerCase()
      ) {
        throw new VikunjaError({
          status: 400,
          code: 'PROJECT_SELECTOR_MISMATCH',
          method: 'GET',
          path: `/projects/${selector.id}`,
          message: `Project ID ${selector.id} is "${cached.title}", not "${selector.title}".`,
          fieldErrors: [],
        });
      }
      return cached;
    }

    try {
      const project = await client.request<any>('GET', `/projects/${selector.id}`);
      const ref = projectRefFromApi(project, `/projects/${selector.id}`);
      if (
        selector.title !== undefined &&
        ref.title.toLowerCase() !== selector.title.toLowerCase()
      ) {
        throw new VikunjaError({
          status: 400,
          code: 'PROJECT_SELECTOR_MISMATCH',
          method: 'GET',
          path: `/projects/${selector.id}`,
          message: `Project ID ${selector.id} is "${ref.title}", not "${selector.title}".`,
          fieldErrors: [],
        });
      }
      cache.setProject(ref.title, ref);
      return ref;
    } catch (err: any) {
      if (err instanceof VikunjaError && err.status === 404) {
        throw new VikunjaError({
          status: 404,
          code: 'PROJECT_NOT_FOUND',
          method: 'GET',
          path: `/projects/${selector.id}`,
          message: `Project not found for ID: ${selector.id}`,
          fieldErrors: [],
        });
      }
      throw err;
    }
  }

  if (selector.title !== undefined) {
    const cached = cache.getProjectCandidates(selector.title);
    if (cached && cached.length > 1) {
      throw new VikunjaError({
        status: 409,
        code: 'PROJECT_TITLE_AMBIGUOUS',
        method: 'GET',
        path: '/projects',
        message: `Multiple projects match exact title: "${selector.title}". Candidates: ${JSON.stringify(cached)}`,
        fieldErrors: [],
      });
    }
    if (cached?.length === 1) {
      return cached[0];
    }

    const projects = await validProjectsForTitle(client, selector.title);
    const exactMatches = projects.filter(
      (p) => p.title.toLowerCase() === selector.title!.toLowerCase(),
    );

    if (exactMatches.length === 0) {
      throw new VikunjaError({
        status: 404,
        code: 'PROJECT_NOT_FOUND',
        method: 'GET',
        path: '/projects',
        message: `Project not found for title: "${selector.title}"`,
        fieldErrors: [],
      });
    }

    if (exactMatches.length > 1) {
      const candidates = exactMatches.map((p) => ({ id: p.id, title: p.title }));
      throw new VikunjaError({
        status: 409,
        code: 'PROJECT_TITLE_AMBIGUOUS',
        method: 'GET',
        path: '/projects',
        message: `Multiple projects match exact title: "${selector.title}". Candidates: ${JSON.stringify(candidates)}`,
        fieldErrors: [],
      });
    }

    cache.setProjectIdentifiers(projects);
    const resolved = exactMatches[0];
    const ref = { id: resolved.id, title: resolved.title };
    cache.setProject(selector.title, ref);
    return ref;
  }

  throw new VikunjaError({
    status: 400,
    code: 'PROJECT_SELECTOR_REQUIRED',
    method: 'GET',
    path: '/projects',
    message: 'Either project numeric ID or project title must be provided.',
    fieldErrors: [],
  });
}

export async function resolveTask(
  client: VikunjaApiClient,
  taskSelector: TaskSelector,
  projectSelector?: { id?: number; title?: string },
  options: ResolveTaskOptions = {},
): Promise<TaskRef> {
  if (!taskSelector || typeof taskSelector !== 'object' || Array.isArray(taskSelector)) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_TASK_SELECTOR',
      method: 'GET',
      path: '/tasks',
      message:
        'Use an explicit task selector: {globalId}, {identifier}, or {projectIndex}. Bare numbers and strings are not accepted.',
      fieldErrors: [],
    });
  }

  const keys = Object.keys(taskSelector);
  const allowedKeys = ['globalId', 'identifier', 'projectIndex'];
  if (keys.length !== 1 || !allowedKeys.includes(keys[0])) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_TASK_SELECTOR',
      method: 'GET',
      path: '/tasks',
      message: 'A task selector must contain exactly one of globalId, identifier, or projectIndex.',
      fieldErrors: [],
    });
  }

  if ('globalId' in taskSelector) {
    const globalId = taskSelector.globalId;
    if (!Number.isInteger(globalId) || globalId <= 0) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_TASK_SELECTOR',
        method: 'GET',
        path: '/tasks',
        message: `Invalid global task ID: ${globalId}.`,
        fieldErrors: [],
      });
    }

    try {
      const task = await client.request<any>('GET', `/tasks/${globalId}`);

      let project: ProjectRef;
      if (projectSelector) {
        const expectedProj = await resolveProject(client, projectSelector);
        if (expectedProj.id !== task.project_id) {
          throw new VikunjaError({
            status: 400,
            code: 'PROJECT_MISMATCH',
            method: 'GET',
            path: `/tasks/${globalId}`,
            message: `Task #${task.index} (ID ${globalId}) belongs to project ID ${task.project_id}, not the specified project "${expectedProj.title}" (ID ${expectedProj.id})`,
            fieldErrors: [],
          });
        }
        project = expectedProj;
      } else if (task.project?.title) {
        project = { id: task.project_id, title: task.project.title };
      } else {
        project = await resolveProject(client, { id: task.project_id });
      }

      return {
        id: task.id,
        index: task.index,
        identifier: task.identifier,
        project,
        title: task.title,
        labels: taskLabels(task),
        assignees: taskAssignees(task),
        ...(options.includeRawTask ? { rawTask: task } : {}),
      };
    } catch (err: any) {
      if (err instanceof VikunjaError && err.status === 404) {
        throw new VikunjaError({
          status: 404,
          code: 'TASK_NOT_FOUND',
          method: 'GET',
          path: `/tasks/${globalId}`,
          message: `Task not found for global ID: ${globalId}`,
          fieldErrors: [],
        });
      }
      throw err;
    }
  }

  let index: number;
  let identifierPrefix: string | null = null;
  let selectorLabel: string;
  if ('projectIndex' in taskSelector) {
    index = taskSelector.projectIndex;
    selectorLabel = `#${index}`;
  } else {
    const identifier = taskSelector.identifier.trim();
    const identifierMatch = /^(.+)-(\d+)$/.exec(identifier);
    if (!identifierMatch) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_TASK_SELECTOR',
        method: 'GET',
        path: '/tasks',
        message: `Invalid task identifier: "${taskSelector.identifier}". Use a full identifier such as PRJ-123.`,
        fieldErrors: [],
      });
    }
    identifierPrefix = identifierMatch[1];
    index = Number(identifierMatch[2]);
    selectorLabel = identifier;
  }

  if (!Number.isInteger(index) || index <= 0 || isNaN(index)) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_TASK_SELECTOR',
      method: 'GET',
      path: '/tasks',
      message: `Invalid project task index: ${index}.`,
      fieldErrors: [],
    });
  }

  if (!identifierPrefix && !projectSelector) {
    throw new VikunjaError({
      status: 400,
      code: 'PROJECT_CONTEXT_REQUIRED',
      method: 'GET',
      path: '/tasks',
      message: `Project title or ID context is required to resolve project-scoped task reference: "${selectorLabel}"`,
      fieldErrors: [],
    });
  }

  let project: ProjectRef;
  if (identifierPrefix) {
    const identifierProject = await resolveProjectIdentifier(client, identifierPrefix);
    if (projectSelector) {
      const scopedProject = await resolveProject(client, projectSelector);
      if (identifierProject.id !== scopedProject.id) {
        throw new VikunjaError({
          status: 400,
          code: 'PROJECT_SCOPE_MISMATCH',
          method: 'GET',
          path: '/projects',
          message: `Task identifier prefix "${identifierPrefix}" resolves to "${identifierProject.title}" (ID ${identifierProject.id}), but projectSelector resolves to "${scopedProject.title}" (ID ${scopedProject.id}).`,
          fieldErrors: [],
        });
      }
    }
    project = identifierProject;
  } else {
    project = await resolveProject(client, projectSelector!);
  }

  const filter = encodeURIComponent(`index = ${index}`);
  const lookupPath = `/projects/${project.id}/tasks?filter=${filter}&per_page=2`;
  try {
    const response = await client.request<any>('GET', lookupPath);
    const matches = toItemArray<any>(response).filter((task) => task.index === index);
    if (matches.length === 0) {
      throw new VikunjaError({
        status: 404,
        code: 'TASK_NOT_FOUND',
        method: 'GET',
        path: lookupPath,
        message: `Task #${index} not found in project "${project.title}" (ID ${project.id})`,
        fieldErrors: [],
      });
    }
    if (matches.length > 1) {
      throw new VikunjaError({
        status: 409,
        code: 'TASK_INDEX_AMBIGUOUS',
        method: 'GET',
        path: lookupPath,
        message: `Multiple tasks matched #${index} in project "${project.title}" (ID ${project.id}).`,
        fieldErrors: [],
      });
    }
    const task = matches[0];

    if (
      identifierPrefix &&
      task.identifier &&
      task.identifier.toLowerCase() !== selectorLabel.toLowerCase()
    ) {
      throw new VikunjaError({
        status: 400,
        code: 'IDENTIFIER_MISMATCH',
        method: 'GET',
        path: lookupPath,
        message: `Task identifier "${task.identifier}" does not match specified selector "${selectorLabel}"`,
        fieldErrors: [],
      });
    }

    return {
      id: task.id,
      index: task.index,
      identifier: task.identifier,
      project: { id: task.project_id, title: project.title },
      title: task.title,
      labels: taskLabels(task),
      assignees: taskAssignees(task),
      ...(options.includeRawTask ? { rawTask: task } : {}),
    };
  } catch (err: any) {
    if (err instanceof VikunjaError && err.status === 404) {
      throw new VikunjaError({
        status: 404,
        code: 'TASK_NOT_FOUND',
        method: 'GET',
        path: lookupPath,
        message: `Task #${index} not found in project "${project.title}" (ID ${project.id})`,
        fieldErrors: [],
      });
    }
    throw err;
  }
}

/**
 * Internal adapter for module-level helpers while their direct-call tests and
 * downstream imports migrate. MCP schemas never expose this legacy coercion.
 */
export async function resolveTaskInput(
  client: VikunjaApiClient,
  taskSelector: TaskSelectorInput,
  projectSelector?: { id?: number; title?: string },
  options: ResolveTaskOptions = {},
): Promise<TaskRef> {
  let explicit: TaskSelector;
  if (typeof taskSelector === 'number' || /^\d+$/.test(String(taskSelector).trim())) {
    explicit = { globalId: Number(taskSelector) };
  } else if (typeof taskSelector === 'string' && taskSelector.trim().startsWith('#')) {
    explicit = { projectIndex: Number(taskSelector.trim().slice(1)) };
  } else if (typeof taskSelector === 'string') {
    explicit = { identifier: taskSelector.trim() };
  } else {
    explicit = taskSelector;
  }
  return resolveTask(client, explicit, projectSelector, options);
}
