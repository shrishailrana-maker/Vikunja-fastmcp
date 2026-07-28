/**
 * Durable idempotency ledger for retried write operations.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

import { chmodSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { VikunjaError } from './errors.js';

interface IdempotencyCacheOptions {
  databasePath?: string;
  ttlMs?: number;
}

interface StoredRow {
  result_json: string;
  updated_at: number;
}

interface LeaseResult {
  acquired: boolean;
  value: any;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPERATION_LEASE_MS = 120_000;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

export function durableOperationKey(
  namespace: string,
  callerKey: string,
  payload: unknown,
): string {
  const callerHash = createHash('sha256').update(callerKey).digest('hex').slice(0, 16);
  const payloadHash = payloadFingerprint(payload);
  return `${namespace}:${callerHash}:${payloadHash}`;
}

export function payloadFingerprint(payload: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(payload)))
    .digest('hex');
}

export function claimDurableOperation(
  namespace: string,
  callerKey: string,
  payload: unknown,
): string {
  const operationKey = durableOperationKey(namespace, callerKey, payload);
  const callerHash = operationKey.split(':')[1];
  const claimKey = `${namespace}:claim:${callerHash}`;
  const claim = idempotency.claim(claimKey, { operationKey });
  if (claim && claim.operationKey !== operationKey) {
    throw new VikunjaError({
      status: 409,
      code: 'IDEMPOTENCY_KEY_REUSED',
      method: 'TOOLS_CALL',
      path: namespace,
      message: 'This idempotencyKey was already used with a different payload. Use a new key.',
      fieldErrors: [],
    });
  }
  return operationKey;
}

export async function runDurableOperation<T>(
  namespace: string,
  callerKey: string,
  payload: unknown,
  operation: () => Promise<T>,
): Promise<T> {
  const operationKey = claimDurableOperation(namespace, callerKey, payload);
  const leased = idempotency.acquireLease(operationKey, { status: 'running' }, OPERATION_LEASE_MS);
  if (!leased.acquired) {
    if (leased.value?.status === 'completed') return leased.value.result as T;
    if (leased.value?.status === undefined) return leased.value as T;
    throw new VikunjaError({
      status: 409,
      code: 'IDEMPOTENCY_OPERATION_IN_PROGRESS',
      method: 'TOOLS_CALL',
      path: namespace,
      message: 'An identical operation is already running. Retry with the same idempotencyKey.',
      fieldErrors: [],
    });
  }

  try {
    const result = await operation();
    idempotency.set(operationKey, { status: 'completed', result });
    return result;
  } catch (error) {
    idempotency.delete(operationKey);
    throw error;
  }
}

function defaultDatabasePath(): string {
  if (process.env.JEST_WORKER_ID) return ':memory:';
  if (process.env.VIKUNJA_IDEMPOTENCY_DB_PATH?.trim()) {
    return process.env.VIKUNJA_IDEMPOTENCY_DB_PATH.trim();
  }
  const stateRoot =
    process.env.LOCALAPPDATA ?? process.env.XDG_STATE_HOME ?? join(homedir(), '.local', 'state');
  const instanceHash = createHash('sha256')
    .update(process.env.VIKUNJA_URL?.trim() || 'default-instance')
    .digest('hex')
    .slice(0, 16);
  return join(stateRoot, 'vikunja-fastmcp', `idempotency-${instanceHash}.sqlite`);
}

export class IdempotencyCache {
  private readonly database: DatabaseSync;
  private readonly ttlMs: number;

  constructor(options: IdempotencyCacheOptions = {}) {
    const databasePath = options.databasePath ?? defaultDatabasePath();
    if (databasePath !== ':memory:') {
      const directory = dirname(databasePath);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      try {
        chmodSync(directory, 0o700);
      } catch {
        // Windows protects the user profile directory through ACLs.
      }
    }

    const configuredTtl = Number(process.env.VIKUNJA_IDEMPOTENCY_TTL_MS);
    this.ttlMs =
      options.ttlMs ??
      (Number.isSafeInteger(configuredTtl) && configuredTtl > 0 ? configuredTtl : DEFAULT_TTL_MS);
    this.database = new DatabaseSync(databasePath);
    if (databasePath !== ':memory:') {
      try {
        chmodSync(databasePath, 0o600);
      } catch {
        // Windows protects the user profile directory through ACLs.
      }
    }
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS idempotency_records (
        key TEXT PRIMARY KEY,
        result_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  get(key: string): any | null {
    const row = this.database
      .prepare('SELECT result_json, updated_at FROM idempotency_records WHERE key = ?')
      .get(key) as unknown as StoredRow | undefined;
    if (!row) return null;

    if (Date.now() - row.updated_at >= this.ttlMs) {
      this.delete(key);
      return null;
    }
    return JSON.parse(row.result_json);
  }

  set(key: string, result: any): void {
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO idempotency_records (key, result_json, created_at, updated_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           result_json = excluded.result_json,
           updated_at = excluded.updated_at`,
      )
      .run(key, JSON.stringify(result), now, now);
  }

  claim(key: string, result: any): any | null {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare('SELECT result_json, updated_at FROM idempotency_records WHERE key = ?')
        .get(key) as unknown as StoredRow | undefined;
      const now = Date.now();
      if (row && now - row.updated_at < this.ttlMs) {
        this.database.exec('COMMIT');
        return JSON.parse(row.result_json);
      }
      if (row) {
        this.database.prepare('DELETE FROM idempotency_records WHERE key = ?').run(key);
      }
      this.database
        .prepare(
          `INSERT INTO idempotency_records (key, result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?)`,
        )
        .run(key, JSON.stringify(result), now, now);
      this.database.exec('COMMIT');
      return null;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  acquireLease(key: string, initial: any, leaseMs: number): LeaseResult {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare('SELECT result_json, updated_at FROM idempotency_records WHERE key = ?')
        .get(key) as unknown as StoredRow | undefined;
      const now = Date.now();
      const current = row && now - row.updated_at < this.ttlMs ? JSON.parse(row.result_json) : null;
      if (
        current &&
        (current.status === undefined ||
          current.status === 'completed' ||
          (typeof current.leaseUntil === 'number' && current.leaseUntil > now))
      ) {
        this.database.exec('COMMIT');
        return { acquired: false, value: current };
      }

      const next = {
        ...(current ?? initial),
        status: 'running',
        leaseUntil: now + leaseMs,
      };
      this.database
        .prepare(
          `INSERT INTO idempotency_records (key, result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             result_json = excluded.result_json,
             updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(next), now, now);
      this.database.exec('COMMIT');
      return { acquired: true, value: next };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  list(prefix: string): any[] {
    const rows = this.database
      .prepare(
        `SELECT key, result_json, updated_at
         FROM idempotency_records
         WHERE key LIKE ? ESCAPE '\\'
         ORDER BY key`,
      )
      .all(
        `${prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`,
      ) as unknown as (StoredRow & { key: string })[];
    const now = Date.now();
    const active: any[] = [];
    for (const row of rows) {
      if (now - row.updated_at >= this.ttlMs) {
        this.delete(row.key);
      } else {
        active.push(JSON.parse(row.result_json));
      }
    }
    return active;
  }

  delete(key: string): void {
    this.database.prepare('DELETE FROM idempotency_records WHERE key = ?').run(key);
  }

  deletePrefix(prefix: string): void {
    const escaped = prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    this.database
      .prepare(`DELETE FROM idempotency_records WHERE key LIKE ? ESCAPE '\\'`)
      .run(`${escaped}%`);
  }

  clear(): void {
    this.database.exec('DELETE FROM idempotency_records');
  }

  close(): void {
    this.database.close();
  }
}

export const idempotency = new IdempotencyCache();
