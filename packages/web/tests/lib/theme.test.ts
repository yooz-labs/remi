/**
 * Tests for the theme-resolution helper (#778). Pure function; no mocks --
 * the DOM/matchMedia/Capacitor side of the fix (App.tsx's system-theme
 * listener, native-theme.ts's status bar sync) isn't testable in this
 * package's DOM-less bun:test setup, so the extracted decision logic is
 * what's covered here.
 */

import { describe, expect, test } from 'bun:test';
import { resolveEffectiveTheme } from '../../src/lib/theme';

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
