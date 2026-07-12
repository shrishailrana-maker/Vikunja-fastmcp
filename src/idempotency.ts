/**
 * Process-local idempotency cache for retried write operations.
 *
 * Part of Vikunja FastMCP — a clean, v2-only Model Context Protocol server for Vikunja.
 * Repository: https://github.com/shrishailrana-maker/Vikunja-fastmcp
 *
 * Copyright (c) 2026 Shrishail Rana
 * Authors: Shrishail Rana, Codex, Claude, AntiGravity, Grok
 * SPDX-License-Identifier: MIT
 */

interface IdempotencyRecord {
  result: any;
  timestamp: number;
}

export class IdempotencyCache {
  private cache = new Map<string, IdempotencyRecord>();
  private readonly ttl = 300000; // 5 minutes

  get(key: string): any | null {
    const record = this.cache.get(key);
    if (record) {
      if (Date.now() - record.timestamp < this.ttl) {
        return record.result;
      }
      this.cache.delete(key);
    }
    return null;
  }

  set(key: string, result: any) {
    this.cache.set(key, {
      result,
      timestamp: Date.now(),
    });

    // Bounded cache: evict the oldest by timestamp (not insertion order alone).
    if (this.cache.size > 1000) {
      let oldestKey: string | undefined;
      let oldestTs = Infinity;
      for (const [k, rec] of this.cache.entries()) {
        if (rec.timestamp < oldestTs) {
          oldestTs = rec.timestamp;
          oldestKey = k;
        }
      }
      if (oldestKey !== undefined) {
        this.cache.delete(oldestKey);
      }
    }
  }

  clear() {
    this.cache.clear();
  }
}

export const idempotency = new IdempotencyCache();
