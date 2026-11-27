import type { HarnessId } from '@remi/shared';
import type { SessionStore } from '../session/session-store.ts';
import type { TranscriptDiscovery } from '../transcript/transcript-discovery.ts';

export function makeResumeProfileOf({
  sessionStore,
  discovery,
}: {
  sessionStore: SessionStore;
  discovery: TranscriptDiscovery;
}): (id: HarnessId, resumeId: string) => string | undefined {
  return (id, resumeId) => {
    // A Codex transcript has no profile root yet.
    if (id !== 'claude') return undefined;
    const record = sessionStore.findResumableByClaudeSessionId(resumeId);
    if (record) return undefined;
    return discovery.profileOfTranscript(resumeId);
  };
}
