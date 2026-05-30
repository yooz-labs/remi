/**
 * Session display helpers.
 *
 * The single source of truth for (a) how a session's connection + agent state
 * maps to a visual "pill" state, and (b) how a session name splits into
 * host / project / branch for the redesigned rows and chat header.
 */

import type { UISession } from '@/types';

/** Visual state for a session, derived from connection + agent status. */
export type PillState = 'asking' | 'working' | 'idle' | 'connecting' | 'offline';

/** Derive the pill state. Connection status wins over agent status; a pending
 *  question always surfaces as "Needs you". */
export function sessionPillState(
  session: Pick<UISession, 'connectionStatus' | 'status' | 'questionPending'>,
): PillState {
  switch (session.connectionStatus) {
    case 'error':
    case 'unreachable':
      return 'offline';
    case 'connecting':
    case 'reconnecting':
    case 'authenticating':
      return 'connecting';
    case 'disconnected':
      return 'idle';
    default:
      break;
  }
  if (session.questionPending) return 'asking';
  if (session.status === 'thinking' || session.status === 'executing') return 'working';
  return 'idle';
}

/**
 * Split a session's display name into host / project / branch parts.
 * Session names are shaped "<host>:<project>/<branch...>" (host optional);
 * when no explicit host prefix is present we fall back to the connection's
 * hostname (the port stripped off).
 */
export function splitSessionName(
  session: Pick<UISession, 'name' | 'connectionId'>,
): { host: string; project: string; branch: string } {
  const raw = session.name || '';
  let host = session.connectionId.replace(/:\d+$/, '');
  let rest = raw;
  const colon = raw.indexOf(':');
  // Only treat a leading "host:" as a host when it isn't part of a path.
  if (colon > 0 && !raw.slice(0, colon).includes('/')) {
    host = raw.slice(0, colon);
    rest = raw.slice(colon + 1);
  }
  const slash = rest.indexOf('/');
  const project = (slash >= 0 ? rest.slice(0, slash) : rest) || 'session';
  const branch = slash >= 0 ? rest.slice(slash + 1) : '';
  return { host, project, branch };
}
