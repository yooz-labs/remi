/**
 * Sliding-window rate limiter for the signaling worker.
 *
 * Tracks request counts per key (typically client IP) within a time window.
 * Workers reuse isolates across requests, so in-memory state persists
 * for the lifetime of the isolate (typically minutes to hours).
 */

interface WindowEntry {
  count: number;
  windowStart: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, WindowEntry>();
  private readonly maxRequests: number;
  private readonly windowMs: number;
  private lastCleanup = 0;
  private readonly cleanupIntervalMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.cleanupIntervalMs = windowMs * 2;
  }

  /** Returns true if the request is allowed, false if rate-limited. */
  check(key: string): boolean {
    const now = Date.now();
    this.maybeCleanup(now);

    const entry = this.windows.get(key);
    if (!entry || now - entry.windowStart >= this.windowMs) {
      this.windows.set(key, { count: 1, windowStart: now });
      return true;
    }

    entry.count++;
    return entry.count <= this.maxRequests;
  }

  private maybeCleanup(now: number): void {
    if (now - this.lastCleanup < this.cleanupIntervalMs) return;
    this.lastCleanup = now;

    for (const [key, entry] of this.windows) {
      if (now - entry.windowStart >= this.windowMs) {
        this.windows.delete(key);
      }
    }
  }
}
