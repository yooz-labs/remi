import { describe, expect, test } from 'bun:test';
import { errorToString } from '../src/error-utils.ts';

describe('errorToString', () => {
  test('extracts message from Error instance', () => {
    expect(errorToString(new Error('boom'))).toBe('boom');
  });

  test('extracts message from Error subclass', () => {
    class MyError extends Error {}
    expect(errorToString(new MyError('custom'))).toBe('custom');
  });

  test('passes strings through unchanged', () => {
    expect(errorToString('plain string')).toBe('plain string');
  });

  test('JSON-stringifies plain objects', () => {
    expect(errorToString({ code: 42, reason: 'x' })).toBe('{"code":42,"reason":"x"}');
  });

  test('JSON-stringifies arrays', () => {
    expect(errorToString([1, 2, 3])).toBe('[1,2,3]');
  });

  test('falls back to String() for non-serializable input', () => {
    const circular: Record<string, unknown> = {};
    circular['self'] = circular;
    expect(errorToString(circular)).toBe('[object Object]');
  });

  test('handles null and undefined', () => {
    expect(errorToString(null)).toBe('null');
    expect(errorToString(undefined)).toBe('undefined');
  });

  test('handles numbers and booleans', () => {
    expect(errorToString(42)).toBe('42');
    expect(errorToString(true)).toBe('true');
  });
});
