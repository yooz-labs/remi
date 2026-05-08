/**
 * Long-press detector hook (#401).
 *
 * Returns pointer-event handlers to spread onto an element. Fires
 * `onLongPress` when the pointer stays down for `delayMs` without
 * moving past `moveTolerancePx`. Any pointer up / cancel / leave
 * before the timer fires aborts cleanly.
 *
 * Pointermove guard uses a tolerance instead of cancel-on-any-move
 * so a tiny finger jitter does not break the gesture on touch
 * devices, which was the most common false-cancel in iMessage-style
 * implementations.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';

export interface UseLongPressOptions {
  /** Hold time in milliseconds before firing. Default 500 ms. */
  readonly delayMs?: number;
  /** Pointer movement (in px) tolerated before the press is cancelled. Default 8 px. */
  readonly moveTolerancePx?: number;
  /** Optional side-effect (e.g. haptic) fired when the press triggers. */
  readonly onTrigger?: () => void;
}

export interface LongPressHandlers {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onPointerLeave: () => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
}

export function useLongPress(
  onLongPress: () => void,
  options: UseLongPressOptions = {},
): LongPressHandlers {
  const { delayMs = 500, moveTolerancePx = 8, onTrigger } = options;
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startCoords = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    startCoords.current = null;
  }, []);

  // Cancel if the component unmounts while a press is pending.
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      cancel();
      startCoords.current = { x: event.clientX, y: event.clientY };
      timer.current = setTimeout(() => {
        timer.current = null;
        onTrigger?.();
        onLongPress();
      }, delayMs);
    },
    [cancel, delayMs, onLongPress, onTrigger],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const start = startCoords.current;
      if (!start) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      if (Math.hypot(dx, dy) > moveTolerancePx) cancel();
    },
    [cancel, moveTolerancePx],
  );

  return {
    onPointerDown,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onPointerMove,
  };
}
