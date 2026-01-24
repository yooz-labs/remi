/**
 * BulletContentRegistry - Stores full bullet content for on-demand expansion.
 *
 * Session-scoped storage for truncated bullet content.
 * Bullets are keyed by their bulletId.
 * Pruning happens based on max entries and age.
 */

/** Registry configuration */
export interface BulletContentRegistryConfig {
  /** Maximum bullets to store. Default: 5000 */
  readonly maxBullets?: number;
  /** Content age before pruning (ms). Default: 1 hour */
  readonly maxAgeMs?: number;
}

/** Stored content entry */
interface ContentEntry {
  readonly fullContent: string;
  readonly storedAt: number;
}

const DEFAULT_MAX_BULLETS = 5000;
const DEFAULT_MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

/**
 * Registry for storing full content of truncated bullets.
 * Used for on-demand expansion when client requests full content.
 */
export class BulletContentRegistry {
  private readonly content: Map<number, ContentEntry> = new Map();
  private readonly maxBullets: number;
  private readonly maxAgeMs: number;
  private getCallCount = 0;
  private static readonly PRUNE_EVERY_N_GETS = 100;

  constructor(config?: BulletContentRegistryConfig) {
    this.maxBullets = config?.maxBullets ?? DEFAULT_MAX_BULLETS;
    this.maxAgeMs = config?.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  }

  /**
   * Store full content for a bullet.
   * Called during truncation to preserve original content.
   */
  store(bulletId: number, fullContent: string): void {
    // Prune old entries before storing
    this.prune();

    // If at capacity, remove oldest entries to make room
    if (this.content.size >= this.maxBullets) {
      this.removeOldest(Math.ceil(this.maxBullets * 0.1)); // Remove 10%
    }

    this.content.set(bulletId, {
      fullContent,
      storedAt: Date.now(),
    });
  }

  /**
   * Get full content for a bullet.
   * Returns null if not found or expired.
   */
  get(bulletId: number): string | null {
    // Periodically prune expired entries on reads
    this.getCallCount++;
    if (this.getCallCount >= BulletContentRegistry.PRUNE_EVERY_N_GETS) {
      this.getCallCount = 0;
      this.prune();
    }

    const entry = this.content.get(bulletId);
    if (!entry) {
      return null;
    }

    // Check if expired
    if (Date.now() - entry.storedAt > this.maxAgeMs) {
      this.content.delete(bulletId);
      return null;
    }

    return entry.fullContent;
  }

  /**
   * Check if we have content for a bullet.
   */
  has(bulletId: number): boolean {
    return this.get(bulletId) !== null;
  }

  /**
   * Clear all stored content.
   */
  clear(): void {
    this.content.clear();
  }

  /**
   * Get the number of stored entries.
   */
  get size(): number {
    return this.content.size;
  }

  /**
   * Prune expired entries.
   * Called automatically on store, but can be called manually.
   */
  prune(): void {
    const now = Date.now();
    const expiredIds: number[] = [];

    for (const [bulletId, entry] of this.content) {
      if (now - entry.storedAt > this.maxAgeMs) {
        expiredIds.push(bulletId);
      }
    }

    for (const id of expiredIds) {
      this.content.delete(id);
    }
  }

  /**
   * Remove the oldest N entries.
   */
  private removeOldest(count: number): void {
    // Get entries sorted by storedAt (oldest first)
    const entries = Array.from(this.content.entries()).sort(
      ([, a], [, b]) => a.storedAt - b.storedAt,
    );

    // Remove oldest entries
    const toRemove = entries.slice(0, count);
    for (const [bulletId] of toRemove) {
      this.content.delete(bulletId);
    }
  }
}
