/**
 * Pure theme-resolution helper, extracted so the system-theme-follow logic
 * (#778) is unit-testable without a DOM or MediaQueryList. The DOM/Capacitor
 * side (reading matchMedia, stamping data-theme, syncing the native status
 * bar) lives in App.tsx / main.tsx and calls this for the actual decision.
 */

import type { AppSettings } from '../types';

export type EffectiveTheme = 'light' | 'dark';

/** Resolve the concrete light/dark theme for a setting + current OS preference.
 *  'system' samples prefersDark; explicit 'light'/'dark' ignore it. */
export function resolveEffectiveTheme(
  theme: AppSettings['theme'],
  prefersDark: boolean,
): EffectiveTheme {
  return theme === 'system' ? (prefersDark ? 'dark' : 'light') : theme;
}
