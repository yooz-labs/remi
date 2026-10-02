/**
 * The harness seam (epic #1161, phase 2 #1163): what the daemon asks of the
 * agent CLI it wraps, behind one descriptor so a second harness has a place to
 * plug in. Claude Code is the only implementation (`ClaudeHarness`), and
 * wiring it in changes nothing the daemon does or emits (ADR 0032).
 *
 * One daemon hosts one session, so the harness is a per-daemon singleton: it
 * is constructed once in `cli.ts` and handed to the handler factories as a
 * dependency, never looked up per session.
 *
 * This file is harness-neutral: it must not import a Claude-specific module
 * (`hooks/`, `auto-approve/`, `parser/`, `transcript/`). Every member below
 * has a production caller; members that nothing calls yet (a launch command,
 * a session factory, the harness id) are added by the phase that first needs
 * them, not before.
 */

export interface Harness {
  /**
   * What a graceful Stop types into the harness's PTY (followed by Enter), or
   * `null` when the harness has no such input. `null` routes a Stop straight
   * to the force-close path, the same one a Stop takes while a prompt is up.
   * Claude: `/exit`.
   */
  readonly gracefulExitInput: string | null;

  /**
   * The CLI arguments that resume the harness's own session, to prepend to
   * the launch arguments. Claude: `['--resume', id]`.
   */
  resumeArgs(harnessSessionId: string): string[];

  /**
   * Where the harness writes the transcript of one of its sessions, derived
   * from the project path and the harness's own session id. It is the path a
   * session WILL have (or has), not proof the file exists. Claude:
   * `<projectsDir>/<project path with every "/" replaced by "-">/<id>.jsonl`.
   */
  transcriptPath(projectPath: string, harnessSessionId: string): string;
}
