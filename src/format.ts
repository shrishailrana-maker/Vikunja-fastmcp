/**
 * Success/failure envelopes, pagination, and date/null normalization.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { htmlToMarkdown, markdownToHtml } from './markdown.js';
import { VikunjaError } from './errors.js';

export interface PaginationInfo {
  page: number;
  perPage: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
  nextPage: number | null;
}

export function normalizeZeroDate(val: any): any {
  if (typeof val === 'string') {
    if (val.startsWith('0001-01-01') || val === '') {
      return null;
    }
  }
  return val;
}

export function normalizeDatesAndNulls<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return null as unknown as T;
  }
  if (Array.isArray(obj)) {
    return obj.map((item) => normalizeDatesAndNulls(item)) as unknown as T;
  }
  if (typeof obj === 'object') {
    const res: Record<string, any> = {};
    for (const key of Object.keys(obj as any)) {
      const val = (obj as any)[key];
      res[key] = normalizeZeroDate(val);
      if (res[key] !== null && typeof res[key] === 'object') {
        res[key] = normalizeDatesAndNulls(res[key]);
      }
    }
    return res as unknown as T;
  }
  return obj;
}

function invalidCollectionResponse(): VikunjaError {
  return new VikunjaError({
    status: 502,
    code: 'INVALID_COLLECTION_RESPONSE',
    method: 'GET',
    path: 'collection',
    message: 'Vikunja returned an invalid collection response; expected an items wrapper.',
    fieldErrors: [],
  });
}

// Vikunja v2 list endpoints return `{ items, page, per_page, total,
// total_pages }`. Reject any other shape so API drift cannot masquerade as an
// empty result.
export function toItemArray<T = any>(res: any): T[] {
  if (res && Array.isArray(res.items)) return res.items;
  throw invalidCollectionResponse();
}

export function normalizePagination(raw: any): PaginationInfo {
  if (!raw || Array.isArray(raw) || !Array.isArray(raw.items)) throw invalidCollectionResponse();

  const page = Number(raw?.page || 1);
  const perPage = Number(raw?.per_page || raw?.perPage || 25);
  const total = Number(raw?.total || 0);
  let totalPages = Number(raw?.total_pages || raw?.totalPages || 0);
  if (!totalPages && perPage > 0 && total > 0) {
    totalPages = Math.ceil(total / perPage);
  }
  const hasMore = page < totalPages;
  const nextPage = hasMore ? page + 1 : null;

  return {
    page,
    perPage,
    total,
    totalPages,
    hasMore,
    nextPage,
  };
}

/**
 * Fetch every page of a Vikunja v2 collection endpoint until exhausted.
 * Used for title/name resolution so labels/projects beyond page 1 are found.
 */
export async function fetchAllCollectionItems<T = any>(
  request: (path: string) => Promise<any>,
  basePath: string,
  perPage = 100,
  maxPages = 50,
): Promise<T[]> {
  const items: T[] = [];
  let page = 1;
  let lastTotal = 0;
  const seenPages = new Set<number>();
  const seenBatchSignatures = new Set<string>();
  const seenIds = new Set<unknown>();
  const sep = basePath.includes('?') ? '&' : '?';

  while (page <= maxPages) {
    const raw = await request(`${basePath}${sep}page=${page}&per_page=${perPage}`);
    const batch = toItemArray<T>(raw);
    const pagination = normalizePagination(raw);
    const batchSignature = JSON.stringify(
      batch.map((item: any) => (item && typeof item === 'object' && 'id' in item ? item.id : item)),
    );
    if (seenPages.has(pagination.page) || seenBatchSignatures.has(batchSignature)) {
      throw new VikunjaError({
        status: 502,
        code: 'COLLECTION_PAGE_REPEATED',
        method: 'GET',
        path: basePath,
        message: `The server repeated collection page ${pagination.page} for "${basePath}"; completeness cannot be guaranteed.`,
        fieldErrors: [],
      });
    }
    seenPages.add(pagination.page);
    seenBatchSignatures.add(batchSignature);
    for (const item of batch as any[]) {
      const id = item && typeof item === 'object' ? item.id : undefined;
      if (id !== undefined) {
        if (seenIds.has(id)) continue;
        seenIds.add(id);
      }
      items.push(item as T);
    }
    lastTotal = pagination.total;
    if (!pagination.hasMore || batch.length === 0) {
      break;
    }
    page += 1;
  }

  // Fail closed rather than silently returning a partial collection: a caller
  // doing title/name resolution could otherwise get a false NOT_FOUND (or create
  // a duplicate) for an item on an unscanned page.
  if (lastTotal && items.length < lastTotal) {
    throw new VikunjaError({
      status: 502,
      code: 'COLLECTION_TRUNCATED',
      method: 'GET',
      path: basePath,
      message: `Fetched ${items.length} of ${lastTotal} items from "${basePath}" before the page cap; cannot guarantee completeness. Narrow the query or raise the cap.`,
      fieldErrors: [],
    });
  }

  return items;
}

export interface EnvelopeFormatOptions {
  structuredOnly?: boolean;
}

function renderEnvelope(
  summary: string,
  envelope: unknown,
  options?: EnvelopeFormatOptions,
): string {
  const jsonBlock = `\`\`\`json\n${stringifyEnvelope(envelope)}\n\`\`\``;
  return options?.structuredOnly ? jsonBlock : `${summary}\n\n${jsonBlock}`;
}

export function formatSuccessEnvelope(
  summary: string,
  data: any,
  options?: EnvelopeFormatOptions,
): string {
  const normalizedData = normalizeDatesAndNulls(data);
  const envelope = {
    ok: true,
    data: normalizedData,
  };
  return renderEnvelope(summary, envelope, options);
}

export function formatFailureEnvelope(
  summary: string,
  errorDetails: any,
  options?: EnvelopeFormatOptions,
): string {
  const envelope = {
    ok: false,
    error: errorDetails,
  };
  return renderEnvelope(summary, envelope, options);
}

function stringifyEnvelope(envelope: unknown): string {
  // Keep arbitrary upstream/user text from introducing a second literal fence.
  // JSON.parse restores the exact backticks from these Unicode escapes.
  return JSON.stringify(envelope).replace(/```/g, '\\u0060\\u0060\\u0060');
}

export { htmlToMarkdown, markdownToHtml };
