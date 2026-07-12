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
}

function taskLabels(task: any): { id: number; title: string }[] {
  return Array.isArray(task.labels)
    ? task.labels.map((label: any) => ({ id: label.id, title: label.title }))
    : [];
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class IdentityCache {
  private projectCache = new Map<string, CacheEntry<ProjectRef>>();
  private labelCache = new Map<string, CacheEntry<number>>();

  getProject(title: string): ProjectRef | null {
    const key = title.toLowerCase();
    const entry = this.projectCache.get(key);
    if (entry && entry.expiresAt > Date.now()) {
      return entry.value;
    }
    this.projectCache.delete(key);
    return null;
  }

  setProject(title: string, ref: ProjectRef) {
    const key = title.toLowerCase();
    this.projectCache.set(key, {
      value: { id: ref.id, title: ref.title },
      expiresAt: Date.now() + 45000,
    });
  }

  invalidateProject(title: string) {
    this.projectCache.delete(title.toLowerCase());
  }

  clearProjects() {
    this.projectCache.clear();
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

async function listAllProjects(client: VikunjaApiClient): Promise<any[]> {
  return fetchAllCollectionItems(async (path) => client.request<any>('GET', path), '/projects');
}

export async function listAllLabels(client: VikunjaApiClient): Promise<any[]> {
  return fetchAllCollectionItems(async (path) => client.request<any>('GET', path), '/labels');
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

    try {
      const project = await client.request<any>('GET', `/projects/${selector.id}`);
      if (
        selector.title !== undefined &&
        project.title.toLowerCase() !== selector.title.toLowerCase()
      ) {
        throw new VikunjaError({
          status: 400,
          code: 'PROJECT_SELECTOR_MISMATCH',
          method: 'GET',
          path: `/projects/${selector.id}`,
          message: `Project ID ${selector.id} is "${project.title}", not "${selector.title}".`,
          fieldErrors: [],
        });
      }
      return { id: project.id, title: project.title };
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
    const cached = cache.getProject(selector.title);
    if (cached !== null) {
      return cached;
    }

    const projects = await listAllProjects(client);
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
  taskSelector: string | number,
  projectSelector?: { id?: number; title?: string },
): Promise<TaskRef> {
  const selectorStr = String(taskSelector).trim();
  const isDigits = /^\d+$/.test(selectorStr);

  if (isDigits && !selectorStr.startsWith('#')) {
    const globalId = Number(selectorStr);
    if (!Number.isInteger(globalId) || globalId <= 0) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_TASK_SELECTOR',
        method: 'GET',
        path: '/tasks',
        message: `Invalid task selector: "${taskSelector}".`,
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

  let index: number | null = null;
  if (selectorStr.startsWith('#')) {
    if (selectorStr.length < 2) {
      throw new VikunjaError({
        status: 400,
        code: 'INVALID_TASK_SELECTOR',
        method: 'GET',
        path: '/tasks',
        message: `Invalid task selector: "${taskSelector}". Use #index with a positive portal number.`,
        fieldErrors: [],
      });
    }
    index = Number(selectorStr.slice(1));
  } else if (selectorStr.includes('-')) {
    const parts = selectorStr.split('-');
    const lastPart = parts[parts.length - 1];
    if (/^\d+$/.test(lastPart)) {
      index = Number(lastPart);
    }
  }

  if (index === null || !Number.isInteger(index) || index <= 0 || isNaN(index)) {
    throw new VikunjaError({
      status: 400,
      code: 'INVALID_TASK_SELECTOR',
      method: 'GET',
      path: '/tasks',
      message: `Invalid task selector: "${taskSelector}". Use a numeric global ID, or a project-scoped #index or short-identifier (e.g. PRJ-123).`,
      fieldErrors: [],
    });
  }

  if (!projectSelector) {
    throw new VikunjaError({
      status: 400,
      code: 'PROJECT_CONTEXT_REQUIRED',
      method: 'GET',
      path: '/tasks',
      message: `Project title or ID context is required to resolve project-scoped task reference: "${taskSelector}"`,
      fieldErrors: [],
    });
  }

  const project = await resolveProject(client, projectSelector);

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
      selectorStr.includes('-') &&
      task.identifier &&
      task.identifier.toLowerCase() !== selectorStr.toLowerCase()
    ) {
      throw new VikunjaError({
        status: 400,
        code: 'IDENTIFIER_MISMATCH',
        method: 'GET',
        path: lookupPath,
        message: `Task identifier "${task.identifier}" does not match specified selector "${selectorStr}"`,
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
