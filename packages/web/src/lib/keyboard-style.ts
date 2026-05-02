/**
 * Helpers for keyboard-aware layout.
 *
 * iOS keyboards on Capacitor cover the lower portion of the WebView and do
 * not push absolutely-positioned content automatically. Components that
 * need to lift their content above the keyboard read the keyboard state
 * from `useKeyboard()` and feed it through these helpers.
 *
 * Kept as a pure function so it can be unit-tested without rendering
 * React components — the web package does not currently ship a DOM-test
 * runner. Issue #226 part 1.
 */

import type { CSSProperties } from 'react';

interface KeyboardStateLike {
  readonly isVisible: boolean;
  readonly height: number;
}

/**
 * Compute the inline style for a full-viewport modal backdrop. When the
 * keyboard is visible the backdrop gets `paddingBottom` equal to the
 * keyboard height so the centered modal child reflows above the keyboard
 * instead of disappearing behind it. When hidden, returns `undefined` so
 * the component falls back to its CSS-only baseline (no inline style).
 */
export function keyboardBackdropStyle(state: KeyboardStateLike): CSSProperties | undefined {
  if (!state.isVisible) return undefined;
  return { paddingBottom: `${state.height}px` };
}
