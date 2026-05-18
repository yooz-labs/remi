/**
 * Cross-connection session dedup keyed by (connectionId, claudeSessionId)
 * composite (#430). Same Claude sessionId reported by two different daemons
 * IS a collision — keep both as separate rows so the user can pick which
 * daemon to talk to. Only collapse when both connectionId AND claudeSessionId
 * match (or both lack claudeSessionId, in which case fall back to id-keyed
 * dedup so pre-#429 daemons still degrade gracefully).
 *
 * When two entries collide on the same composite key, the daemon-sourced one
 * wins so transcript-sourced read-only views don't shadow live sessions.
 */

import type { UISession } from '@/types';

export function compositeKey(s: UISession): string {
  return s.claudeSessionId
    ? `${s.connectionId}|${s.claudeSessionId}`
    : `${s.connectionId}|${s.id}`;
}

export function dedupSessions(sessions: readonly UISession[]): UISession[] {
  return sessions.reduce<UISession[]>((acc, s) => {
    const key = compositeKey(s);
    const dupIdx = acc.findIndex((other) => compositeKey(other) === key);
    if (dupIdx === -1) {
      acc.push(s);
      return acc;
    }
    const existing = acc[dupIdx];
    if (existing && s.source === 'daemon' && existing.source !== 'daemon') {
      acc[dupIdx] = s;
    }
    return acc;
  }, []);
}
