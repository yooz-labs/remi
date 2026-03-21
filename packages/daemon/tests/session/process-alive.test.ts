import { describe, expect, test } from 'bun:test';
import { isProcessAlive } from '../../src/session/process-alive.ts';

describe('isProcessAlive', () => {
  test('returns true for current process', () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test('returns false for PID 0', () => {
    expect(isProcessAlive(0)).toBe(false);
  });

  test('returns false for negative PID', () => {
    expect(isProcessAlive(-1)).toBe(false);
  });

  test('returns false for non-integer PID', () => {
    expect(isProcessAlive(1.5)).toBe(false);
  });

  test('returns false for NaN', () => {
    expect(isProcessAlive(Number.NaN)).toBe(false);
  });

  test('returns false for Infinity', () => {
    expect(isProcessAlive(Number.POSITIVE_INFINITY)).toBe(false);
  });

  test('returns false for dead PID', () => {
    expect(isProcessAlive(999999)).toBe(false);
  });

  test('returns true for PID 1 (EPERM on macOS/Linux)', () => {
    // PID 1 (init/launchd) exists but is owned by root; kill(1, 0) throws EPERM
    expect(isProcessAlive(1)).toBe(true);
  });
});
