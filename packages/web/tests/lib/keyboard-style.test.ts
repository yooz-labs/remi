import { describe, expect, test } from 'bun:test';
import { keyboardBackdropStyle } from '../../src/lib/keyboard-style';

describe('keyboardBackdropStyle', () => {
  test('regression #226 part 1: applies bottom padding equal to keyboard height when visible', () => {
    // Hidden-then-visible flip is the key transition: the Connect modal
    // backdrop must reflow above the keyboard the moment Capacitor reports
    // keyboardWillShow, otherwise the input briefly disappears behind the
    // animated-in keyboard.
    expect(keyboardBackdropStyle({ isVisible: true, height: 320 })).toEqual({
      paddingBottom: '320px',
    });
  });

  test('returns undefined when the keyboard is hidden so the modal stays vertically centered', () => {
    expect(keyboardBackdropStyle({ isVisible: false, height: 0 })).toBeUndefined();
  });

  test('returns undefined when the keyboard is hidden even if a stale height lingers', () => {
    // useKeyboard zeros height on hide today, but a future refactor could
    // leak a stale height. The visibility flag is authoritative.
    expect(keyboardBackdropStyle({ isVisible: false, height: 999 })).toBeUndefined();
  });

  test('handles zero height when visible (e.g. external keyboard accessory)', () => {
    // External keyboards can fire keyboardWillShow with height 0 (only the
    // accessory bar). We still emit a 0px padding rather than undefined so
    // the inline style is consistent across the visible/hidden boundary.
    expect(keyboardBackdropStyle({ isVisible: true, height: 0 })).toEqual({ paddingBottom: '0px' });
  });
});
