/**
 * Long-press detector hook (#401).
 *
 * Returns pointer-event handlers to spread onto an element. Fires
 * `onLongPress` when the pointer stays down for `delayMs` without
 * moving past `moveTolerancePx`. Any pointer up / cancel / leave
 * before the timer fires aborts cleanly.
 *
 * Pointer events (not touch events) unify mouse + touch + Apple
 * Pencil and avoid the iOS double-fire of touchstart + mousedown.
 *
 * Move tolerance instead of cancel-on-any-move keeps tiny finger
 * jitter from breaking the gesture on touch devices, which is the
 * most common false-cancel in iMessage-style implementations.
 *
 * Selectable-content skip (#402 review): the hook ignores presses
 * whose target sits inside a `<code>`, `<pre>`, or `[contenteditable]`
 * ancestor so iOS text-selection long-press inside a code block does
 * not accidentally trigger reply mode.
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

/** Skip the press when the target sits inside selectable / editable content. */
function isInSelectableContent(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return target.closest('code, pre, [contenteditable], [contenteditable="true"]') !== null;
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
      // Mouse: only primary button. Right-click / barrel-button must not
      // trigger reply mode (would surprise desktop users).
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      // Selectable content: defer to the browser's text-selection gesture.
      if (isInSelectableContent(event.target)) return;
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
