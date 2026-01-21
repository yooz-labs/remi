import { describe, expect, it, beforeEach } from 'bun:test';
import { BulletContentRegistry } from '../src/api/bullet-content-registry.ts';

describe('BulletContentRegistry', () => {
  let registry: BulletContentRegistry;

  beforeEach(() => {
    registry = new BulletContentRegistry();
  });

  describe('store and get', () => {
    it('should store and retrieve content', () => {
      registry.store(1, 'full content for bullet 1');
      expect(registry.get(1)).toBe('full content for bullet 1');
    });

    it('should return null for non-existent bulletId', () => {
      expect(registry.get(999)).toBeNull();
    });

    it('should overwrite content for same bulletId', () => {
      registry.store(1, 'original content');
      registry.store(1, 'updated content');
      expect(registry.get(1)).toBe('updated content');
    });

    it('should store multiple bullets', () => {
      registry.store(1, 'content 1');
      registry.store(2, 'content 2');
      registry.store(3, 'content 3');

      expect(registry.get(1)).toBe('content 1');
      expect(registry.get(2)).toBe('content 2');
      expect(registry.get(3)).toBe('content 3');
    });
  });

  describe('has', () => {
    it('should return true for existing content', () => {
      registry.store(1, 'content');
      expect(registry.has(1)).toBe(true);
    });

    it('should return false for non-existent content', () => {
      expect(registry.has(999)).toBe(false);
    });
  });

  describe('clear', () => {
    it('should remove all content', () => {
      registry.store(1, 'content 1');
      registry.store(2, 'content 2');

      registry.clear();

      expect(registry.get(1)).toBeNull();
      expect(registry.get(2)).toBeNull();
      expect(registry.size).toBe(0);
    });
  });

  describe('size', () => {
    it('should return number of stored entries', () => {
      expect(registry.size).toBe(0);

      registry.store(1, 'content 1');
      expect(registry.size).toBe(1);

      registry.store(2, 'content 2');
      expect(registry.size).toBe(2);
    });
  });

  describe('capacity limits', () => {
    it('should respect maxBullets config', () => {
      const smallRegistry = new BulletContentRegistry({ maxBullets: 10 });

      // Store 15 entries
      for (let i = 1; i <= 15; i++) {
        smallRegistry.store(i, `content ${i}`);
      }

      // Should have pruned to stay at or below capacity
      expect(smallRegistry.size).toBeLessThanOrEqual(10);

      // Most recent entries should be preserved
      expect(smallRegistry.get(15)).toBe('content 15');
      expect(smallRegistry.get(14)).toBe('content 14');
    });

    it('should remove oldest entries when at capacity', () => {
      const smallRegistry = new BulletContentRegistry({ maxBullets: 5 });

      // Store 5 entries
      for (let i = 1; i <= 5; i++) {
        smallRegistry.store(i, `content ${i}`);
      }

      // Store one more, should trigger removal of oldest
      smallRegistry.store(6, 'content 6');

      // Oldest entry should be removed
      expect(smallRegistry.get(1)).toBeNull();

      // Newest should be preserved
      expect(smallRegistry.get(6)).toBe('content 6');
    });
  });

  describe('expiry', () => {
    it('should expire content after maxAgeMs', async () => {
      // Create registry with 100ms expiry
      const shortLivedRegistry = new BulletContentRegistry({ maxAgeMs: 100 });

      shortLivedRegistry.store(1, 'short-lived content');
      expect(shortLivedRegistry.get(1)).toBe('short-lived content');

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Should be expired
      expect(shortLivedRegistry.get(1)).toBeNull();
    });

    it('should not expire content before maxAgeMs', async () => {
      const registry = new BulletContentRegistry({ maxAgeMs: 1000 });

      registry.store(1, 'content');

      // Wait less than expiry time
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Should still be available
      expect(registry.get(1)).toBe('content');
    });
  });

  describe('prune', () => {
    it('should remove expired entries on prune', async () => {
      const shortLivedRegistry = new BulletContentRegistry({ maxAgeMs: 100 });

      shortLivedRegistry.store(1, 'content 1');

      // Wait for expiry
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Add new content (triggers prune)
      shortLivedRegistry.store(2, 'content 2');

      // Expired entry should be gone
      expect(shortLivedRegistry.has(1)).toBe(false);
      expect(shortLivedRegistry.has(2)).toBe(true);
    });

    it('should be callable manually', () => {
      const registry = new BulletContentRegistry();
      registry.store(1, 'content');

      // Manual prune should not throw
      expect(() => registry.prune()).not.toThrow();
    });
  });

  describe('default config', () => {
    it('should use default maxBullets of 5000', () => {
      // Store 100 entries (well under default limit)
      for (let i = 1; i <= 100; i++) {
        registry.store(i, `content ${i}`);
      }

      // All should be preserved
      expect(registry.size).toBe(100);
    });

    it('should use default maxAgeMs of 1 hour', () => {
      // Just verify content is stored without immediate expiry
      registry.store(1, 'content');
      expect(registry.get(1)).toBe('content');
    });
  });
});
