/**
 * Tests for bindingRotated (#439). Pure function; no mocks.
 */

import { describe, expect, test } from 'bun:test';
import { bindingRotated } from '../../src/lib/session-binding';

describe('bindingRotated', () => {
  test('true when a prior binding existed and the ack differs (rotated while away)', () => {
    expect(bindingRotated('claude-old', 'claude-new')).toBe(true);
  });

  test('false on first-connect (no prior binding)', () => {
    expect(bindingRotated(undefined, 'claude-new')).toBe(false);
  });

  test('false on a steady reconnect (same id)', () => {
    expect(bindingRotated('claude-same', 'claude-same')).toBe(false);
  });

  test('false when the ack omits the binding (older daemon)', () => {
    expect(bindingRotated('claude-old', undefined)).toBe(false);
  });

  test('false when neither side has a binding', () => {
    expect(bindingRotated(undefined, undefined)).toBe(false);
  });
});
