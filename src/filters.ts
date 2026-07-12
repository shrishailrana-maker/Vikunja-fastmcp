/**
 * Saved-filter create/get/update/delete.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { VikunjaApiClient } from './api.js';

export interface SavedFilter {
  id: number;
  title: string;
  description?: string;
  filters: any;
  is_favorite?: boolean;
  created: string;
  updated: string;
}

export async function createSavedFilter(
  client: VikunjaApiClient,
  title: string,
  filterQuery: any,
  description?: string,
  isFavorite?: boolean,
): Promise<SavedFilter> {
  const body: Record<string, any> = {
    title,
    filters: filterQuery,
  };
  if (description !== undefined) {
    body.description = description;
  }
  if (isFavorite !== undefined) {
    body.is_favorite = isFavorite;
  }

  return client.request<SavedFilter>('POST', '/filters', { body });
}

export async function getSavedFilter(client: VikunjaApiClient, id: number): Promise<SavedFilter> {
  return client.request<SavedFilter>('GET', `/filters/${id}`);
}

export async function updateSavedFilter(
  client: VikunjaApiClient,
  id: number,
  fields: {
    title?: string;
    filterQuery?: any;
    description?: string;
    isFavorite?: boolean;
  },
): Promise<SavedFilter> {
  const body: Record<string, any> = {};
  if (fields.title !== undefined) body.title = fields.title;
  if (fields.filterQuery !== undefined) body.filters = fields.filterQuery;
  if (fields.description !== undefined) body.description = fields.description;
  if (fields.isFavorite !== undefined) body.is_favorite = fields.isFavorite;

  return client.request<SavedFilter>('PATCH', `/filters/${id}`, {
    body,
    headers: { 'Content-Type': 'application/merge-patch+json' },
  });
}

export async function deleteSavedFilter(
  client: VikunjaApiClient,
  id: number,
): Promise<{ ok: boolean; filterId: number }> {
  await client.request<any>('DELETE', `/filters/${id}`);
  return { ok: true, filterId: id };
}

// NOTE: there is deliberately no listSavedFilters(). The Vikunja v2 API exposes
// no collection `GET /filters` route, so listing is an unsupported operation.
// It is unregistered from the `vikunja_filters` tool and surfaced by the
// self-check diagnostics under `unsupportedOperations` (see diagnostics.ts).
