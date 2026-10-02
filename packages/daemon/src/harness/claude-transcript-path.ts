/**
 * The one place a Claude session's transcript path `<dir>/<id>.jsonl` is
 * composed (#1163), used by `ClaudeHarness.transcriptPath` and by
 * `expectedTranscriptPath` in `cli/transcript-fallback.ts`.
 *
 * It is its own module, with no runtime import, because the fallback poll is
 * reached from the transcript binder, which `hook-bridge-setup.ts` imports,
 * and `hook-bridge-setup.ts` is in turn imported by `harness/claude-session.ts`.
 * Calling `ClaudeHarness` from the fallback poll closed that loop (#1164); this
 * module is the leaf both sides can reach without it.
 *
 * The directory encoding stays in `TranscriptDiscovery.getProjectTranscriptDir`
 * (only `/` is replaced).
 */

import type { TranscriptDiscovery } from '../transcript/index.ts';

export function claudeTranscriptPath(
  transcriptDiscovery: Pick<TranscriptDiscovery, 'getProjectTranscriptDir'>,
  projectPath: string,
  claudeSessionId: string,
): string {
  return `${transcriptDiscovery.getProjectTranscriptDir(projectPath)}/${claudeSessionId}.jsonl`;
}
