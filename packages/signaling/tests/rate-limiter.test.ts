import { describe, expect, test } from 'bun:test';
import { RateLimiter } from '../src/rate-limiter.ts';

describe('RateLimiter', () => {
  test('allows requests under the limit', () => {
    const limiter = new RateLimiter(5, 60_000);
    for (let i = 0; i < 5; i++) {
      expect(limiter.check('192.168.1.1')).toBe(true);
    }
  });

  test('blocks requests over the limit', () => {
    const limiter = new RateLimiter(3, 60_000);
    expect(limiter.check('10.0.0.1')).toBe(true);
    expect(limiter.check('10.0.0.1')).toBe(true);
    expect(limiter.check('10.0.0.1')).toBe(true);
    expect(limiter.check('10.0.0.1')).toBe(false);
    expect(limiter.check('10.0.0.1')).toBe(false);
  });

  test('tracks different keys independently', () => {
    const limiter = new RateLimiter(2, 60_000);
    expect(limiter.check('ip-a')).toBe(true);
    expect(limiter.check('ip-a')).toBe(true);
    expect(limiter.check('ip-a')).toBe(false);
    // Different key should still be allowed
    expect(limiter.check('ip-b')).toBe(true);
    expect(limiter.check('ip-b')).toBe(true);
    expect(limiter.check('ip-b')).toBe(false);
  });

  test('resets after window expires', async () => {
    const limiter = new RateLimiter(2, 50); // 50ms window
    expect(limiter.check('key')).toBe(true);
    expect(limiter.check('key')).toBe(true);
    expect(limiter.check('key')).toBe(false);

    // Wait for window to expire
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(limiter.check('key')).toBe(true);
  });

  test('allows exactly max requests', () => {
    const limiter = new RateLimiter(10, 60_000);
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('client')).toBe(true);
    }
    expect(limiter.check('client')).toBe(false);
  });

  test('handles single-request limit', () => {
    const limiter = new RateLimiter(1, 60_000);
    expect(limiter.check('once')).toBe(true);
    expect(limiter.check('once')).toBe(false);
  });
});
