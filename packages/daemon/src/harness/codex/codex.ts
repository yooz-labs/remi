/**
 * Codex as a {@link Harness} (epic #1175, phase 3 #1177): the values the daemon
 * asks of a harness, and the launch in `codex-session.ts`. Observe-only for
 * now (no cards, no answers, no chat); see that file.
 *
 * `gracefulExitInput` is null, so a Stop force-closes the session and never
 * types `/quit` into the Codex TUI: remi types into a Codex PTY only on a
 * person's raw input (the TUI once ran an installer on a typed digit).
 *
 * `cli.ts` is the one importer of this directory (`harness-boundary.test.ts`),
 * which is why `harness/index.ts` does not re-export it.
 */

import type { Harness, HarnessLaunchContext, HarnessSession } from '../types.ts';
import {
  type CodexLaunchDeps,
  type CodexPreflight,
  checkCodexLaunch,
  createCodexSession,
} from './codex-session.ts';

export class CodexHarness implements Harness {
  readonly gracefulExitInput = null;

  /**
   * @param launchDeps The daemon-wide services `createSession` reads. A harness
   *   built to resolve arguments or paths only omits them, and `createSession`
   *   and `preflight` refuse.
   */
  constructor(private readonly launchDeps?: CodexLaunchDeps) {}

  /** `resume <thread id>` is a subcommand, so it goes last, after the flags. */
  resumeArgs(harnessSessionId: string): string[] {
    return ['resume', harnessSessionId];
  }

  /** Codex's history comes from its app-server, not a file remi can name. */
  transcriptPath(): null {
    return null;
  }

  /**
   * The argument validation and the older-daemon gate of a launch, with nothing
   * written, so `cli.ts` can refuse (exit 2 or 1) before it boots a daemon or
   * takes over the terminal. `createSession` repeats both before `preAssign`.
   */
  preflight(userArgs: readonly string[], workingDirectory: string): CodexPreflight {
    if (!this.launchDeps) {
      throw new Error('CodexHarness was built without launch dependencies; it cannot preflight');
    }
    return checkCodexLaunch(this.launchDeps, userArgs, workingDirectory);
  }

  createSession(ctx: HarnessLaunchContext): HarnessSession {
    if (!this.launchDeps) {
      throw new Error(
        'CodexHarness was built without launch dependencies; it cannot create a session',
      );
    }
    return createCodexSession(this.launchDeps, ctx);
  }
}
