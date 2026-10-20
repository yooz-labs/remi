/**
 * What the client does with a `resume_session_response` (#1129).
 *
 * A session daemon resumes in its own process, so the session is on the connection that asked and
 * the client opens it at once. A HUB starts a child daemon on another port instead: the session is
 * not in the client's list yet, it appears through the session list's `daemonPorts` and a direct
 * connection, and the client opens it when that connection's `hello_ack` arrives. Selecting the
 * response's session id at once would point the chat at a session no connection owns.
 *
 * Opening it on arrival is a background event, and #688's rule holds for it: it must never replace
 * a choice the person made in the meantime. So a follow lands only while the person is where they
 * were when they asked, and only for a short window, after which a session that never appeared
 * cannot capture a later, unrelated one.
 */

import type { ResumeSessionResponseMessage } from '@remi/shared';

/** How long a follow waits for the child's connection to say hello. */
export const FOLLOW_WINDOW_MS = 30_000;

export type ResumeOutcome =
  /** The session is on the connection that answered: open it now. */
  | { readonly kind: 'open'; readonly sessionId: string }
  /** A hub started a child daemon on `port`: refresh the list, open the session when it appears. */
  | { readonly kind: 'follow'; readonly sessionId: string; readonly port: number }
  | { readonly kind: 'failed'; readonly error: string };

/** A usable TCP port, as a hub would send one. Anything else is treated as no port. */
function isPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
}

export function resumeOutcome(message: ResumeSessionResponseMessage): ResumeOutcome {
  if (!message.success || !message.sessionId) {
    return { kind: 'failed', error: message.error ?? 'Unknown error' };
  }
  if (isPort(message.port)) {
    return { kind: 'follow', sessionId: message.sessionId, port: message.port };
  }
  return { kind: 'open', sessionId: message.sessionId };
}

export interface PendingFollow {
  readonly sessionId: string;
  /** The session the person had open when they asked: leaving it cancels the follow. */
  readonly activeAtStart: string | null;
  readonly expiresAt: number;
}

export function startFollow(
  sessionId: string,
  activeNow: string | null,
  now: number,
): PendingFollow {
  return { sessionId, activeAtStart: activeNow, expiresAt: now + FOLLOW_WINDOW_MS };
}

/**
 * The session to open now that `appearedId` has said hello, or null. Only the followed session
 * lands, inside the window, and only if the person has not moved since they asked.
 */
export function followLanding(
  pending: PendingFollow | null,
  appearedId: string,
  activeNow: string | null,
  now: number,
): string | null {
  if (pending === null) return null;
  if (appearedId !== pending.sessionId) return null;
  if (now >= pending.expiresAt) return null;
  if (activeNow !== pending.activeAtStart) return null;
  return appearedId;
}
