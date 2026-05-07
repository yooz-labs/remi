import { describe, expect, test } from 'bun:test';
import { sleep } from '../src/async-utils.ts';

describe('sleep', () => {
  test('resolves after the requested delay', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(45);
    expect(elapsed).toBeLessThan(200);
  });

  test('resolves immediately for 0 ms', async () => {
    const start = Date.now();
    await sleep(0);
    expect(Date.now() - start).toBeLessThan(50);
  });

  test('returns a thenable Promise', () => {
    const p = sleep(1);
    expect(p).toBeInstanceOf(Promise);
  });
});
