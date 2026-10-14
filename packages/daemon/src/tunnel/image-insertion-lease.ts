import type { PTYSession } from '../pty/pty-session';

/** Host-only preparation. Correlated outcome retention belongs to the later coordinator. */
export interface ImageInsertionLease {
  readonly pty: PTYSession;
  readonly expiresAt: string;
  /** Whether this lease crossed the possible-write boundary, even if the sink subsequently failed. */
  readonly possibleWrite: boolean;
  referencePath(): string;
  /** Call only at the actual serialized effect, before its first possible terminal write. */
  retire(expectedReference: string, promptUp: () => boolean): void;
}

export class ImageInsertionError extends Error {
  constructor(
    readonly code:
      | 'unavailable'
      | 'busy'
      | 'conflict'
      | 'expired'
      | 'binding_changed'
      | 'prompt_up',
  ) {
    super('Image insertion refused');
  }
}
