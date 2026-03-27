/**
 * React hook for iOS keyboard events.
 *
 * Wraps @capacitor/keyboard to track keyboard visibility and height.
 * Adds/removes a `.keyboard-open` class on document.body for CSS targeting.
 * Returns a no-op on non-native platforms (early-returns from the effect).
 */

import { Keyboard } from '@capacitor/keyboard';
import { useEffect, useState } from 'react';
import { isNative } from '@/lib/platform';

interface KeyboardState {
  readonly isVisible: boolean;
  readonly height: number;
}

export function useKeyboard(): KeyboardState {
  const [state, setState] = useState<KeyboardState>({ isVisible: false, height: 0 });

  useEffect(() => {
    if (!isNative()) return;

    const showListener = Keyboard.addListener('keyboardWillShow', (info) => {
      setState({ isVisible: true, height: info.keyboardHeight });
      document.body.classList.add('keyboard-open');
    });

    const hideListener = Keyboard.addListener('keyboardWillHide', () => {
      setState({ isVisible: false, height: 0 });
      document.body.classList.remove('keyboard-open');
    });

    showListener.catch((err) => console.warn('[useKeyboard] show listener failed:', err));
    hideListener.catch((err) => console.warn('[useKeyboard] hide listener failed:', err));

    return () => {
      showListener.then((h) => h.remove()).catch((err) => console.warn('[useKeyboard] cleanup show:', err));
      hideListener.then((h) => h.remove()).catch((err) => console.warn('[useKeyboard] cleanup hide:', err));
    };
  }, []);

  return state;
}
