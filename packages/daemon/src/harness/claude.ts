/**
 * Claude Code as a {@link Harness}: the values that used to be spelled out at
 * each call site (the `/exit` a Stop types, the `--resume` arguments, and the
 * `<dir>/<claudeSessionId>.jsonl` transcript path). Epic #1161, phase 2. Phase
 * 3 (#1164) adds the launch itself (`createSession`, in `claude-session.ts`) and
 * the per-session turn filter `admitsAnySession`.
 */

import type { UUID } from '@remi/shared';

import type { HookInput } from '../hooks/index.ts';
import type { TranscriptDiscovery } from '../transcript/index.ts';
import { type ClaudeLaunchDeps, createClaudeSession } from './claude-session.ts';
import { claudeTranscriptPath } from './claude-transcript-path.ts';
import type { Harness, HarnessLaunchContext, HarnessSession } from './types.ts';

export class ClaudeHarness implements Harness {
  readonly gracefulExitInput = '/exit';

  /** Each live session's "does this binder claim the event?" filter (#914). */
  private readonly admitsBySession = new Map<UUID, (input: HookInput) => boolean>();

  /**
   * @param transcriptDiscovery Owns the encoding of a project path into
   *   Claude's projects directory (only `/` is replaced; see
   *   `TranscriptDiscovery.getProjectTranscriptDir`).
   * @param launchDeps The daemon-wide services `createSession` reads. Only the
   *   daemon (`cli.ts`) launches sessions, so a harness built just to resolve
   *   paths or arguments omits them and `createSession` refuses.
   *   `launchDeps.transcriptDiscovery` must be the same instance as
   *   `transcriptDiscovery`.
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
    return createClaudeSession(this.launchDeps, ctx, this.admitsBySession);
  }

  /**
   * Does any live session's binder claim this hook event? Fail closed: no
   * session admitting means the event is not ours.
   *
   * `onTurnStop` (cli.ts) is registered outside `setupHookBridge`, so it needs
   * the filter every in-bridge listener already applies: two daemons in the
   * SAME project directory each append their own matcher to the shared
   * `.claude/settings.local.json` hooks array, and Claude Code POSTs every
   * event to both. Unfiltered, this daemon would push "turn complete" for a
   * sibling's turn (#914). It is a Claude hook filter, so it lives here and
   * not on `Harness`.
   */
  admitsAnySession(input: HookInput): boolean {
    for (const admits of this.admitsBySession.values()) {
      try {
        if (admits(input)) return true;
      } catch {
        // A binder that throws must not break the hook path; treat as not ours.
      }
    }
    return false;
  }
}
