/**
 * Pure theme value-resolution/narrowing helpers (#778), extracted so this
 * logic is unit-testable without a DOM or MediaQueryList. Consumed by
 * App.tsx's applyTheme()/loadSettings() (resolveEffectiveTheme,
 * parseThemeSetting) and by native-theme.ts's status-bar sync
 * (parseEffectiveTheme); the matchMedia sampling and data-theme
 * reading/writing themselves stay in those callers, not here.
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
