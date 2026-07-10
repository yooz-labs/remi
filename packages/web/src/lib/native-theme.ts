/**
 * Native (Capacitor) status-bar theme syncing (#778). Reads the CURRENT
 * effective theme from the `data-theme` attribute App.tsx's theme effect
 * stamps on <html> -- that attribute is the source of truth for "what
 * theme is showing right now" once applyTheme() has run. Falls back to its
 * own matchMedia sample only for the narrow startup window before React's
 * first effect flush has landed (initNative() runs synchronously right
 * after createRoot().render(), ahead of passive effects).
 *
 * No-op on web (guarded by isNative()); never throws (matches the rest of
 * initNative()'s try/warn/continue pattern).
 */

import { StatusBar, Style } from '@capacitor/status-bar';
import { isNative } from './platform';
import { type EffectiveTheme, parseEffectiveTheme } from './theme';

function readCurrentEffectiveTheme(): EffectiveTheme {
  const stamped = parseEffectiveTheme(document.documentElement.getAttribute('data-theme'));
  if (stamped) return stamped;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

/** Sync the native status bar style to the root element's current effective theme. */
export async function syncNativeStatusBarTheme(): Promise<void> {
  if (!isNative()) return;
  try {
    const style = readCurrentEffectiveTheme() === 'dark' ? Style.Dark : Style.Light;
    await StatusBar.setStyle({ style });
  } catch (err) {
    console.warn('[syncNativeStatusBarTheme] StatusBar setStyle failed:', err);
  }
}
