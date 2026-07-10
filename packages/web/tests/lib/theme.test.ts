/**
 * Tests for the theme-resolution helpers (#778). Pure functions; no mocks --
 * the DOM/matchMedia/Capacitor side of the fix (App.tsx's system-theme
 * listener, native-theme.ts's status bar sync) isn't testable in this
 * package's DOM-less bun:test setup, so the extracted decision logic is
 * what's covered here.
 */

import { describe, expect, test } from 'bun:test';
import { parseEffectiveTheme, parseThemeSetting, resolveEffectiveTheme } from '../../src/lib/theme';

describe('resolveEffectiveTheme', () => {
  test('system theme resolves to dark when the OS prefers dark', () => {
    expect(resolveEffectiveTheme('system', true)).toBe('dark');
  });

  test('system theme resolves to light when the OS prefers light', () => {
    expect(resolveEffectiveTheme('system', false)).toBe('light');
  });

  test('explicit dark ignores the OS preference', () => {
    expect(resolveEffectiveTheme('dark', false)).toBe('dark');
  });

  test('explicit light ignores the OS preference', () => {
    expect(resolveEffectiveTheme('light', true)).toBe('light');
  });
});

describe('parseThemeSetting', () => {
  test('accepts light, dark, and system', () => {
    expect(parseThemeSetting('light')).toBe('light');
    expect(parseThemeSetting('dark')).toBe('dark');
    expect(parseThemeSetting('system')).toBe('system');
  });

  test('rejects a corrupted string value', () => {
    expect(parseThemeSetting('solarized')).toBeNull();
  });

  test('rejects non-string values from a malformed JSON.parse result', () => {
    expect(parseThemeSetting(null)).toBeNull();
    expect(parseThemeSetting(undefined)).toBeNull();
    expect(parseThemeSetting(42)).toBeNull();
    expect(parseThemeSetting({ theme: 'dark' })).toBeNull();
  });
});

describe('parseEffectiveTheme', () => {
  test('accepts light and dark', () => {
    expect(parseEffectiveTheme('light')).toBe('light');
    expect(parseEffectiveTheme('dark')).toBe('dark');
  });

  test('rejects system, null, and arbitrary strings', () => {
    expect(parseEffectiveTheme('system')).toBeNull();
    expect(parseEffectiveTheme(null)).toBeNull();
    expect(parseEffectiveTheme('')).toBeNull();
  });
});
