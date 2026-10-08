/**
 * Sliding-window rate limiter that queues requests locally instead of
 * letting data.gov.sg reply with HTTP 429.
 *
 * data.gov.sg limits are counted per API key (or per IP when no key is sent)
 * over a 10-second window, separately for each API family. Each bucket here is
 * identified by `<key identity>:<category>`.
 */

import { RATE_MAX_WAIT_MS, RATE_WINDOW_MS } from '../config.js';

export class RateLimitError extends Error {
  constructor(
    message: string,
    public readonly retryAfterSeconds: number
  ) {
    super(message);
    this.name = 'RateLimitError';
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class SlidingWindowLimiter {
  /** Timestamps of recent calls per bucket */
  private stamps = new Map<string, number[]>();
  /** Per-bucket promise chain so waiters are served in order */
  private queues = new Map<string, Promise<void>>();

  constructor(private readonly windowMs: number = RATE_WINDOW_MS) {
    const timer = setInterval(() => this.cleanup(), 60_000);
    timer.unref?.();
  }

  /**
   * Wait until a slot is free in `bucket` (max `limit` calls per window).
   * Throws RateLimitError if the wait would exceed `maxWaitMs`.
   */
  async acquire(
    bucket: string,
    limit: number,
    maxWaitMs: number = RATE_MAX_WAIT_MS
  ): Promise<void> {
    const previous = this.queues.get(bucket) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => (release = resolve));
    const chained = previous.then(() => current);
    this.queues.set(bucket, chained);

    const startedAt = Date.now();
    await previous;
    try {
      for (;;) {
        const now = Date.now();
        const recent = (this.stamps.get(bucket) ?? []).filter((t) => now - t < this.windowMs);
        if (recent.length < limit) {
          recent.push(now);
          this.stamps.set(bucket, recent);
          return;
        }
        const waitMs = this.windowMs - (now - recent[0]) + 25;
        if (now + waitMs - startedAt > maxWaitMs) {
          throw new RateLimitError(
            'Too many requests queued for this data.gov.sg API right now.',
            Math.ceil(waitMs / 1000)
          );
        }
        await sleep(waitMs);
      }
    } finally {
      release();
      // Drop the chain once nobody else is waiting on it
      if (this.queues.get(bucket) === chained) this.queues.delete(bucket);
    }
  }

  /** Remember a call made outside acquire() (e.g. a retry after 429). */
  penalise(bucket: string, limit: number): void {
    // Fill the window so the next caller waits a full window
    const now = Date.now();
    this.stamps.set(bucket, new Array(limit).fill(now));
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [bucket, times] of this.stamps) {
      if (times.every((t) => now - t >= this.windowMs)) this.stamps.delete(bucket);
    }
  }
}

export const limiter = new SlidingWindowLimiter();
