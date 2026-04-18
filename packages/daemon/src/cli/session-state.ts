/**
 * Daemon-lifetime state container for mutable singletons read by extracted
 * handler modules.
 *
 * Today this holds only the primary session ID: the (single) live session a
 * daemon instance owns. The value is `null` until `createNewSession` creates
 * it, and gets reassigned when wrapper and daemon-mode paths each finalize
 * their session. Direct `let` exports would bind importers to the initial
 * value, so callers read through `getPrimarySessionId()` instead.
 */

import type { UUID } from '@remi/shared';

let primarySessionId: UUID | null = null;

export function getPrimarySessionId(): UUID | null {
  return primarySessionId;
}

export function setPrimarySessionId(id: UUID | null): void {
  primarySessionId = id;
}

/** Test-only: reset module state between test cases. */
export function __resetSessionStateForTests(): void {
  primarySessionId = null;
}
