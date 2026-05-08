/**
 * Edge-swipe-back gesture detector (#411).
 *
 * Returns pointer-event handlers to spread onto a chat-view container
 * so users can swipe right from the left edge to pop back to the
 * session list, matching iOS's native back-swipe gesture.
 *
 * Trigger conditions: pointer down within `edgePx` of the left edge
 * AND horizontal move > `triggerPx` AND vertical drift < `verticalLimitPx`
 * during the same gesture. Any out-of-bounds movement cancels the
 * gesture cleanly so vertical scrolling, taps inside content, and
 * pinches do not fire `onBack`.
 *
 * Disabled on fine-pointer devices (mouse) by default since native
 * browser back / the existing chevron cover those, and a stray
 * trackpad swipe near a window edge should not pop the chat.
 */

import { useCallback, useEffect, useRef } from 'react';
import type { PointerEvent } from 'react';

export interface UseEdgeSwipeBackOptions {
  /** Distance in px from the left edge that counts as "edge zone." Default 24. */
  readonly edgePx?: number;
  /** Horizontal movement (px) needed to fire onBack. Default 80. */
  readonly triggerPx?: number;
  /** Maximum vertical drift (px) tolerated before the gesture cancels. Default 30. */
  readonly verticalLimitPx?: number;
  /** Whether to enable the gesture for mouse pointers. Default false (touch only). */
  readonly enableForMouse?: boolean;
  /** Optional side-effect (e.g. haptic) fired when onBack triggers. */
  readonly onTrigger?: () => void;
}

export interface EdgeSwipeBackHandlers {
  readonly onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: PointerEvent<HTMLElement>) => void;
  readonly onPointerUp: () => void;
  readonly onPointerCancel: () => void;
  readonly onPointerLeave: () => void;
}

interface PressState {
  startX: number;
  startY: number;
  fired: boolean;
}

export function useEdgeSwipeBack(
  onBack: () => void,
  options: UseEdgeSwipeBackOptions = {},
): EdgeSwipeBackHandlers {
  const {
    edgePx = 24,
    triggerPx = 80,
    verticalLimitPx = 30,
    enableForMouse = false,
    onTrigger,
  } = options;

  const press = useRef<PressState | null>(null);

  const cancel = useCallback(() => {
    press.current = null;
  }, []);

  // Cancel if the component unmounts mid-gesture.
  useEffect(() => cancel, [cancel]);

  const onPointerDown = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      if (!enableForMouse && event.pointerType === 'mouse') return;
      const target = event.currentTarget;
      const rect = target.getBoundingClientRect();
      // Only start tracking when the pointer is in the left edge zone.
      // Out-of-zone presses leave press.current null so onPointerMove
      // becomes a no-op and the gesture never fires.
      if (event.clientX - rect.left > edgePx) return;
      press.current = { startX: event.clientX, startY: event.clientY, fired: false };
    },
    [edgePx, enableForMouse],
  );

  const onPointerMove = useCallback(
    (event: PointerEvent<HTMLElement>) => {
      const state = press.current;
      if (!state || state.fired) return;
      const dx = event.clientX - state.startX;
      const dy = Math.abs(event.clientY - state.startY);
      // Vertical drift > verticalLimitPx means the user is scrolling
      // or dragging diagonally; abandon the gesture.
      if (dy > verticalLimitPx) {
        cancel();
        return;
      }
      // Negative dx means the user moved leftward; not a back-swipe.
      if (dx < 0) return;
      if (dx >= triggerPx) {
        state.fired = true;
        onTrigger?.();
        onBack();
      }
    },
    [cancel, onBack, onTrigger, triggerPx, verticalLimitPx],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
  };
}
