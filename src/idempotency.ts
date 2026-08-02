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
import { createHash, randomUUID } from 'node:crypto';
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
  leaseToken?: string;
}

interface StoredLease {
  token: string;
  expires_at: number;
}

const DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const OPERATION_LEASE_MS = 120_000;
let activeCredentialScope = 'default-credential';

export function configureIdempotencyScope(token: string): void {
  activeCredentialScope = createHash('sha256').update(token).digest('hex');
}

function operationLeaseLost(namespace: string): VikunjaError {
  return new VikunjaError({
    status: 409,
    code: 'IDEMPOTENCY_LEASE_LOST',
    method: 'TOOLS_CALL',
    path: namespace,
    message:
      'Durable operation lease ownership was lost. No receipt was finalized; retry the identical operation with the same idempotencyKey.',
    fieldErrors: [],
  });
}

function operationOutcomeUnknown(namespace: string): VikunjaError {
  return new VikunjaError({
    status: 409,
    code: 'IDEMPOTENCY_OUTCOME_UNKNOWN',
    method: 'TOOLS_CALL',
    path: namespace,
    message:
      'A previous identical operation may have reached Vikunja, but its result was not confirmed. Inspect the target or receipt before retrying with a new idempotencyKey.',
    fieldErrors: [],
  });
}

function hasAmbiguousRemoteOutcome(error: unknown): boolean {
  const status = Number((error as any)?.status);
  return (
    !Number.isFinite(status) || status === 408 || status === 409 || status === 429 || status >= 500
  );
}

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

function callerKeyHash(callerKey: string): string {
  return createHash('sha256').update(callerKey).digest('hex').slice(0, 16);
}

export function durableOperationKey(
  namespace: string,
  callerKey: string,
  payload: unknown,
): string {
  const callerHash = callerKeyHash(`${activeCredentialScope}\0${callerKey}`);
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
    if (leased.value?.status === 'outcome_unknown') throw operationOutcomeUnknown(namespace);
    throw new VikunjaError({
      status: 409,
      code: 'IDEMPOTENCY_OPERATION_IN_PROGRESS',
      method: 'TOOLS_CALL',
      path: namespace,
      message: 'An identical operation is already running. Retry with the same idempotencyKey.',
      fieldErrors: [],
    });
  }

  if (!leased.leaseToken) throw operationLeaseLost(namespace);

  let leaseLost = false;
  let operationStarted = false;
  const renewLease = () => {
    if (
      leaseLost ||
      !idempotency.renewLease(operationKey, leased.leaseToken!, OPERATION_LEASE_MS)
    ) {
      leaseLost = true;
      return false;
    }
    return true;
  };

  const heartbeat = setInterval(
    () => {
      try {
        renewLease();
      } catch {
        leaseLost = true;
      }
    },
    Math.floor(OPERATION_LEASE_MS / 3),
  );
  heartbeat?.unref();

  try {
    if (!renewLease()) throw operationLeaseLost(namespace);
    operationStarted = true;
    const result = await operation();
    if (!renewLease()) throw operationLeaseLost(namespace);
    const partial =
      result !== null &&
      typeof result === 'object' &&
      ((result as any).outcome === 'partial' ||
        (result as any).action === 'partial' ||
        (result as any).status === 'partial');
    if (partial) {
      if (
        !idempotency.setIfLeaseOwner(operationKey, leased.leaseToken, {
          status: 'partial',
          result,
        })
      ) {
        leaseLost = true;
        throw operationLeaseLost(namespace);
      }
    } else {
      if (
        !idempotency.setIfLeaseOwner(operationKey, leased.leaseToken, {
          status: 'completed',
          result,
        })
      ) {
        leaseLost = true;
        throw operationLeaseLost(namespace);
      }
    }
    return result;
  } catch (error) {
    if (operationStarted && (leaseLost || hasAmbiguousRemoteOutcome(error))) {
      idempotency.markOutcomeUnknown(operationKey, leased.leaseToken);
    } else if (!leaseLost) {
      idempotency.setIfLeaseOwner(operationKey, leased.leaseToken, {
        status: 'failed',
      });
    }
    throw error;
  } finally {
    clearInterval(heartbeat);
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
    .update('\0')
    .update(
      createHash('sha256')
        .update(process.env.VIKUNJA_API_TOKEN?.trim() || 'default-credential')
        .digest('hex'),
    )
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
      CREATE TABLE IF NOT EXISTS idempotency_leases (
        key TEXT PRIMARY KEY,
        token TEXT NOT NULL,
        expires_at INTEGER NOT NULL
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
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(
          `INSERT INTO idempotency_records (key, result_json, created_at, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             result_json = excluded.result_json,
             updated_at = excluded.updated_at`,
        )
        .run(key, JSON.stringify(result), now, now);
      if (result?.status !== 'running') {
        this.database.prepare('DELETE FROM idempotency_leases WHERE key = ?').run(key);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
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
        this.database.prepare('DELETE FROM idempotency_leases WHERE key = ?').run(key);
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
      const lease = this.database
        .prepare('SELECT token, expires_at FROM idempotency_leases WHERE key = ?')
        .get(key) as unknown as StoredLease | undefined;
      const now = Date.now();
      const current = row && now - row.updated_at < this.ttlMs ? JSON.parse(row.result_json) : null;
      if (current?.status === 'running' && (lease?.expires_at ?? 0) <= now) {
        const unknown = { ...current, status: 'outcome_unknown' };
        this.database
          .prepare('UPDATE idempotency_records SET result_json = ?, updated_at = ? WHERE key = ?')
          .run(JSON.stringify(unknown), now, key);
        this.database.prepare('DELETE FROM idempotency_leases WHERE key = ?').run(key);
        this.database.exec('COMMIT');
        return { acquired: false, value: unknown };
      }
      if (
        current &&
        (current.status === undefined ||
          current.status === 'completed' ||
          current.status === 'outcome_unknown' ||
          current.status === 'running' ||
          (lease?.expires_at ?? 0) > now)
      ) {
        this.database.exec('COMMIT');
        return { acquired: false, value: current };
      }

      const leaseToken = randomUUID();
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
      this.database
        .prepare(
          `INSERT INTO idempotency_leases (key, token, expires_at)
           VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET
             token = excluded.token,
             expires_at = excluded.expires_at`,
        )
        .run(key, leaseToken, now + leaseMs);
      this.database.exec('COMMIT');
      return { acquired: true, value: next, leaseToken };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  markOutcomeUnknown(key: string, leaseToken: string): boolean {
    const now = Date.now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare('SELECT result_json FROM idempotency_records WHERE key = ?')
        .get(key) as unknown as Pick<StoredRow, 'result_json'> | undefined;
      const lease = this.database
        .prepare('SELECT token, expires_at FROM idempotency_leases WHERE key = ?')
        .get(key) as unknown as StoredLease | undefined;
      if (!lease || lease.token !== leaseToken) {
        this.database.exec('COMMIT');
        return false;
      }
      if (row) {
        const current = JSON.parse(row.result_json);
        if (current.status === 'running') {
          this.database
            .prepare('UPDATE idempotency_records SET result_json = ?, updated_at = ? WHERE key = ?')
            .run(JSON.stringify({ ...current, status: 'outcome_unknown' }), now, key);
        }
      }
      this.database
        .prepare('DELETE FROM idempotency_leases WHERE key = ? AND token = ?')
        .run(key, leaseToken);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  renewLease(key: string, leaseToken: string, leaseMs: number): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.database
        .prepare('SELECT token, expires_at FROM idempotency_leases WHERE key = ?')
        .get(key) as unknown as StoredLease | undefined;
      if (!lease || lease.token !== leaseToken) {
        this.database.exec('COMMIT');
        return false;
      }

      const row = this.database
        .prepare('SELECT result_json, updated_at FROM idempotency_records WHERE key = ?')
        .get(key) as unknown as StoredRow | undefined;
      if (!row) {
        this.database.prepare('DELETE FROM idempotency_leases WHERE key = ?').run(key);
        this.database.exec('COMMIT');
        return false;
      }

      const current = JSON.parse(row.result_json);
      if (current.status !== 'running') {
        this.database.prepare('DELETE FROM idempotency_leases WHERE key = ?').run(key);
        this.database.exec('COMMIT');
        return false;
      }

      const now = Date.now();
      current.leaseUntil = now + leaseMs;
      this.database
        .prepare(
          `UPDATE idempotency_records
           SET result_json = ?, updated_at = ?
           WHERE key = ?`,
        )
        .run(JSON.stringify(current), now, key);
      this.database
        .prepare('UPDATE idempotency_leases SET expires_at = ? WHERE key = ? AND token = ?')
        .run(now + leaseMs, key, leaseToken);
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  setIfLeaseOwner(key: string, leaseToken: string, result: any): boolean {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const lease = this.database
        .prepare('SELECT token, expires_at FROM idempotency_leases WHERE key = ?')
        .get(key) as unknown as StoredLease | undefined;
      const now = Date.now();
      if (!lease || lease.token !== leaseToken || lease.expires_at <= now) {
        this.database.exec('COMMIT');
        return false;
      }
      const update = this.database
        .prepare(
          `UPDATE idempotency_records
           SET result_json = ?, updated_at = ?
           WHERE key = ?`,
        )
        .run(JSON.stringify(result), now, key);
      if (Number(update.changes) !== 1) {
        this.database.exec('COMMIT');
        return false;
      }
      if (result?.status !== 'running') {
        this.database
          .prepare('DELETE FROM idempotency_leases WHERE key = ? AND token = ?')
          .run(key, leaseToken);
      }
      this.database.exec('COMMIT');
      return true;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  list(prefix: string): any[] {
    return this.entries(prefix).map((entry) => entry.value);
  }

  entries(prefix: string): { key: string; value: any; updatedAt: number }[] {
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
    const active: { key: string; value: any; updatedAt: number }[] = [];
    for (const row of rows) {
      if (now - row.updated_at >= this.ttlMs) {
        this.delete(row.key);
      } else {
        active.push({
          key: row.key,
          value: JSON.parse(row.result_json),
          updatedAt: row.updated_at,
        });
      }
    }
    return active;
  }

  delete(key: string): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('DELETE FROM idempotency_leases WHERE key = ?').run(key);
      this.database.prepare('DELETE FROM idempotency_records WHERE key = ?').run(key);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  deletePrefix(prefix: string): void {
    const escaped = prefix.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
    const pattern = `${escaped}%`;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database
        .prepare(`DELETE FROM idempotency_leases WHERE key LIKE ? ESCAPE '\\'`)
        .run(pattern);
      this.database
        .prepare(`DELETE FROM idempotency_records WHERE key LIKE ? ESCAPE '\\'`)
        .run(pattern);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  clear(): void {
    this.database.exec('DELETE FROM idempotency_leases; DELETE FROM idempotency_records;');
  }

  close(): void {
    this.database.close();
  }
}

export const idempotency = new IdempotencyCache();

export function lookupDurableOperationReceipt(namespace: string, callerKey: string) {
  const prefix = `${namespace}:${callerKeyHash(`${activeCredentialScope}\0${callerKey}`)}:`;
  const entry = idempotency.entries(prefix)[0];
  if (!entry) return null;
  return {
    operation: namespace,
    status: entry.value?.status ?? 'completed',
    result: entry.value?.result ?? entry.value,
    updatedAt: new Date(entry.updatedAt).toISOString(),
  };
}
