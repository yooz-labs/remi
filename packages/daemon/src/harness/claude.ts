/**
 * Claude Code as a {@link Harness}: the values that used to be spelled out at
 * each call site (the `/exit` a Stop types, the `--resume` arguments, and the
 * `<dir>/<claudeSessionId>.jsonl` transcript path). Epic #1161, phase 2.
 */

import type { TranscriptDiscovery } from '../transcript/index.ts';
import { type ClaudeLaunchDeps, createClaudeSession } from './claude-session.ts';
import { claudeTranscriptPath } from './claude-transcript-path.ts';
import type { Harness, HarnessLaunchContext, HarnessSession } from './types.ts';

export class ClaudeHarness implements Harness {
  readonly gracefulExitInput = '/exit';

  /**
   * @param transcriptDiscovery Owns the encoding of a project path into
   *   Claude's projects directory (only `/` is replaced; see
   *   `TranscriptDiscovery.getProjectTranscriptDir`).
   * @param launchDeps The daemon-wide services `createSession` reads. Only the
   *   daemon (`cli.ts`) launches sessions, so a harness built just to resolve
   *   paths or arguments omits them and `createSession` refuses.
   */
  constructor(
    private readonly transcriptDiscovery: Pick<TranscriptDiscovery, 'getProjectTranscriptDir'>,
    private readonly launchDeps?: ClaudeLaunchDeps,
  ) {}

  /**
   * `cli.ts` spells the same `--resume` flag for `remi --resume <id>` (that
   * block runs at module top level, before the harness is constructed), so
   * change Claude's resume flag in both places.
   */
  resumeArgs(harnessSessionId: string): string[] {
    return ['--resume', harnessSessionId];
  }

  transcriptPath(projectPath: string, harnessSessionId: string): string {
    return claudeTranscriptPath(this.transcriptDiscovery, projectPath, harnessSessionId);
  }

  createSession(ctx: HarnessLaunchContext): HarnessSession {
    if (!this.launchDeps) {
      throw new Error(
        'ClaudeHarness was built without launch dependencies; it cannot create a session',
      );
    }
    return createClaudeSession(this.launchDeps, ctx);
  }
}
