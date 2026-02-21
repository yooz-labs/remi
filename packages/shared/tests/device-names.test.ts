import { describe, expect, test } from 'bun:test';
import {
  DEVICE_ADJECTIVES,
  DEVICE_NOUNS,
  generateDeviceName,
  isValidDeviceName,
} from '../src/device-names.ts';

describe('generateDeviceName', () => {
  test('returns adjective-adjective-noun format', () => {
    const name = generateDeviceName();
    const parts = name.split('-');
    expect(parts).toHaveLength(3);
    expect(parts.every((p) => /^[a-z]+$/.test(p))).toBe(true);
  });

  test('uses words from the word lists', () => {
    const adjectives = new Set<string>(DEVICE_ADJECTIVES);
    const nouns = new Set<string>(DEVICE_NOUNS);

    // Generate several names to check they use valid words
    for (let i = 0; i < 20; i++) {
      const name = generateDeviceName();
      const parts = name.split('-');
      expect(adjectives.has(parts[0] ?? '')).toBe(true);
      expect(adjectives.has(parts[1] ?? '')).toBe(true);
      expect(nouns.has(parts[2] ?? '')).toBe(true);
    }
  });

  test('generates different names across calls', () => {
    const names = new Set<string>();
    for (let i = 0; i < 50; i++) {
      names.add(generateDeviceName());
    }
    // With ~85 adj * 85 adj * 72 nouns = ~520k combos, 50 samples should be unique
    expect(names.size).toBeGreaterThan(40);
  });
});

describe('isValidDeviceName', () => {
  test('accepts valid three-word names', () => {
    expect(isValidDeviceName('brave-purple-fox')).toBe(true);
    expect(isValidDeviceName('calm-golden-hawk')).toBe(true);
    expect(isValidDeviceName('swift-amber-deer')).toBe(true);
  });

  test('rejects names with wrong number of parts', () => {
    expect(isValidDeviceName('brave-fox')).toBe(false);
    expect(isValidDeviceName('brave-purple-fox-extra')).toBe(false);
    expect(isValidDeviceName('singleword')).toBe(false);
    expect(isValidDeviceName('')).toBe(false);
  });

  test('rejects names with non-lowercase letters', () => {
    expect(isValidDeviceName('Brave-purple-fox')).toBe(false);
    expect(isValidDeviceName('brave-PURPLE-fox')).toBe(false);
    expect(isValidDeviceName('brave-purple-123')).toBe(false);
    expect(isValidDeviceName('brave-purple-fox1')).toBe(false);
  });

  test('rejects names with empty parts', () => {
    expect(isValidDeviceName('--fox')).toBe(false);
    expect(isValidDeviceName('brave--fox')).toBe(false);
    expect(isValidDeviceName('brave-purple-')).toBe(false);
  });
});

describe('word lists', () => {
  test('adjectives are all lowercase alphabetic', () => {
    for (const adj of DEVICE_ADJECTIVES) {
      expect(adj).toMatch(/^[a-z]+$/);
    }
  });

  test('nouns are all lowercase alphabetic', () => {
    for (const noun of DEVICE_NOUNS) {
      expect(noun).toMatch(/^[a-z]+$/);
    }
  });

  test('word lists have reasonable sizes', () => {
    expect(DEVICE_ADJECTIVES.length).toBeGreaterThan(50);
    expect(DEVICE_NOUNS.length).toBeGreaterThan(40);
  });
});
