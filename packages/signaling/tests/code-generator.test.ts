/**
 * Tests for connection code generator.
 */

import { describe, expect, test } from 'bun:test';
import { codeEntropy, generateCode, isValidCode, normalizeCode } from '../src/code-generator.ts';

describe('generateCode()', () => {
  test('generates code with correct format', () => {
    const code = generateCode();
    expect(code).toMatch(/^[A-Z]{4}-[0-9]{4}$/);
  });

  test('generates unique codes', () => {
    const codes = new Set<string>();
    for (let i = 0; i < 100; i++) {
      codes.add(generateCode());
    }
    expect(codes.size).toBe(100);
  });

  test('uses only unambiguous characters', () => {
    // Generate many codes and check for ambiguous characters
    const ambiguousChars = ['0', 'O', '1', 'I', 'L'];
    for (let i = 0; i < 100; i++) {
      const code = generateCode();
      for (const char of ambiguousChars) {
        expect(code.includes(char)).toBe(false);
      }
    }
  });

  test('accepts custom lengths', () => {
    const code = generateCode(6, 2);
    expect(code).toMatch(/^[A-Z]{6}-[0-9]{2}$/);
  });

  test('handles minimum length', () => {
    const code = generateCode(1, 1);
    expect(code).toMatch(/^[A-Z]{1}-[0-9]{1}$/);
  });
});

describe('isValidCode()', () => {
  test('accepts valid codes', () => {
    expect(isValidCode('ABCD-1234')).toBe(true);
    expect(isValidCode('WXYZ-5678')).toBe(true);
  });

  test('rejects lowercase', () => {
    expect(isValidCode('abcd-1234')).toBe(false);
  });

  test('rejects missing dash', () => {
    expect(isValidCode('ABCD1234')).toBe(false);
  });

  test('rejects wrong lengths', () => {
    expect(isValidCode('ABC-1234')).toBe(false);
    expect(isValidCode('ABCDE-1234')).toBe(false);
    expect(isValidCode('ABCD-123')).toBe(false);
    expect(isValidCode('ABCD-12345')).toBe(false);
  });

  test('rejects letters in number part', () => {
    expect(isValidCode('ABCD-123A')).toBe(false);
  });

  test('rejects numbers in letter part', () => {
    expect(isValidCode('ABC1-1234')).toBe(false);
  });

  test('rejects empty string', () => {
    expect(isValidCode('')).toBe(false);
  });

  test('rejects special characters', () => {
    expect(isValidCode('AB@D-1234')).toBe(false);
    expect(isValidCode('ABCD-12#4')).toBe(false);
  });
});

describe('normalizeCode()', () => {
  test('normalizes lowercase to uppercase', () => {
    expect(normalizeCode('abcd-1234')).toBe('ABCD-1234');
  });

  test('trims whitespace', () => {
    expect(normalizeCode('  ABCD-1234  ')).toBe('ABCD-1234');
  });

  test('adds missing dash', () => {
    expect(normalizeCode('ABCD1234')).toBe('ABCD-1234');
    expect(normalizeCode('abcd1234')).toBe('ABCD-1234');
  });

  test('returns null for invalid format', () => {
    expect(normalizeCode('ABC-123')).toBeNull();
    expect(normalizeCode('ABCDE-12345')).toBeNull();
    expect(normalizeCode('invalid')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(normalizeCode('')).toBeNull();
  });

  test('preserves valid codes', () => {
    expect(normalizeCode('ABCD-1234')).toBe('ABCD-1234');
  });
});

describe('codeEntropy()', () => {
  test('calculates entropy for default code', () => {
    const entropy = codeEntropy();
    // 23 letters for alpha (no 0, O, I, L) = ~4.52 bits each
    // 8 digits for numeric (no 0, 1) = 3 bits each
    // 4 * 4.52 + 4 * 3 = ~30 bits
    expect(entropy).toBeGreaterThan(25);
    expect(entropy).toBeLessThan(35);
  });

  test('entropy increases with length', () => {
    const short = codeEntropy(2, 2);
    const long = codeEntropy(6, 6);
    expect(long).toBeGreaterThan(short);
  });

  test('returns 0 for zero lengths', () => {
    expect(codeEntropy(0, 0)).toBe(0);
  });
});
