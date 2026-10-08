/**
 * Small in-memory TTL cache with a size cap and in-flight de-duplication.
 *
 * - Only successful loads are cached (a thrown error is never stored).
 * - Concurrent requests for the same key share one upstream call.
 * - When the cache is full, the oldest inserted entry is evicted first.
 */

import { CACHE_MAX_ENTRIES } from '../config.js';

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache {
  private entries = new Map<string, Entry<unknown>>();
  private inflight = new Map<string, Promise<unknown>>();
  public hits = 0;
  public misses = 0;

  constructor(private readonly maxEntries: number = CACHE_MAX_ENTRIES) {
    // Periodically drop expired entries so idle keys do not pile up
    const timer = setInterval(() => this.prune(), 5 * 60_000);
    timer.unref?.();
  }

  get<T>(key: string): T | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (Date.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return undefined;
    }
    return entry.value as T;
  }

  set<T>(key: string, value: T, ttlMs: number): void {
    if (ttlMs <= 0) return;
    this.entries.delete(key); // re-insert so it becomes the newest
    this.entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  /**
   * Return a cached value, or run `loader` once (even if called concurrently)
   * and cache its result for `ttlMs`.
   */
  async getOrLoad<T>(key: string, ttlMs: number, loader: () => Promise<T>): Promise<T> {
    const cached = this.get<T>(key);
    if (cached !== undefined) {
      this.hits++;
      return cached;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.hits++;
      return pending as Promise<T>;
    }

    this.misses++;
    const promise = loader()
      .then((value) => {
        this.set(key, value, ttlMs);
        return value;
      })
      .finally(() => {
        this.inflight.delete(key);
      });
    this.inflight.set(key, promise);
    return promise;
  }

  prune(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (now >= entry.expiresAt) this.entries.delete(key);
    }
  }

  get size(): number {
    return this.entries.size;
  }
}

/** Shared cache for all upstream API responses. */
export const apiCache = new TtlCache();
