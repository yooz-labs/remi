/**
 * Pure theme-resolution helper, extracted so the system-theme-follow logic
 * (#778) is unit-testable without a DOM or MediaQueryList. The DOM/Capacitor
 * side (reading matchMedia, stamping data-theme, syncing the native status
 * bar) lives in App.tsx / main.tsx and calls this for the actual decision.
 */

import type { AppSettings } from '../types';

export type EffectiveTheme = 'light' | 'dark';

const THEME_SETTINGS: ReadonlySet<AppSettings['theme']> = new Set(['light', 'dark', 'system']);

/** Narrow an arbitrary value to a valid `AppSettings['theme']`, or `null` if it
 *  isn't one. Used at the localStorage JSON.parse boundary in loadSettings()
 *  so a corrupted/hand-edited stored value can't smuggle garbage through
 *  resolveEffectiveTheme (#778 review). */
export function parseThemeSetting(value: unknown): AppSettings['theme'] | null {
  return typeof value === 'string' && THEME_SETTINGS.has(value as AppSettings['theme'])
    ? (value as AppSettings['theme'])
    : null;
}

/** Narrow an arbitrary value (e.g. a DOM `data-theme` attribute read, which is
 *  typed `string | null`) to an `EffectiveTheme`, or `null` if it isn't one. */
export function parseEffectiveTheme(value: string | null): EffectiveTheme | null {
  return value === 'light' || value === 'dark' ? value : null;
}

/** Resolve the concrete light/dark theme for a setting + current OS preference.
 *  'system' samples prefersDark; explicit 'light'/'dark' ignore it. */
export function resolveEffectiveTheme(
  theme: AppSettings['theme'],
  prefersDark: boolean,
): EffectiveTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}
