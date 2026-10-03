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
 * (`hooks/`, `auto-approve/`, `parser/`, `transcript/`);
 * `tests/harness/harness-boundary.test.ts` enforces it. Every member below
 * has a production caller; members that nothing calls yet (a launch command,
 * the harness id) are added by the phase that first needs them, not before.
 */

import type { ProtocolMessage, UUID } from '@remi/shared';

import type { MessageAPI } from '../api/message-api.ts';
import type { NotificationDispatcher } from '../notifications/notification-dispatcher.ts';
import type { PTYSession } from '../pty/index.ts';

/**
 * Everything one session launch needs from the neutral shell in `cli.ts`
 * (`createNewSession`), which builds the message API first because it is not
 * the harness's: the harness wires its own detection into it. Phase 3, #1164.
 */
export interface HarnessLaunchContext {
  /** The remi session id this launch is for (not the harness's own id). */
  readonly sessionId: UUID;
  readonly workingDirectory: string;
  /** CLI arguments for the harness's command, before any binding injection. */
  readonly extraArgs: string[];
  /** True when the PTY is attached to a local terminal (wrapper mode). */
  readonly passThrough: boolean;
  /** Rows the wrapper reserves for its status bar; 0 gives the child all of them. */
  readonly reservedRows: number;
  readonly messageApi: MessageAPI;
  /** Send a message to clients and record it for replay under the primary session id. */
  readonly sendAndRecord: (message: ProtocolMessage) => void;
  /** Forward an outgoing message to the connection layer. */
  readonly sendMessage: (sessionId: UUID, message: ProtocolMessage) => void;
  /** This session's APNS dispatcher, registered by the harness in `sessionNotifiers`. */
  readonly notifications: NotificationDispatcher;
}

/**
 * One launched session: the PTY (built, not yet started) and how to start
 * it. `cli.ts` registers the PTY with the session registry between the two,
 * which is why construction and `start()` are separate.
 */
export interface HarnessSession {
  readonly pty: PTYSession;
  /** Spawn the PTY. Rejects when the spawn fails; the caller marks the stored session exited. */
  start(): Promise<void>;
}

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

  /**
   * Build the session's detection, binding and PTY, in the order the harness
   * needs them, and return it unstarted. May throw (the caller lets it
   * propagate, as the inline code did).
   */
  createSession(ctx: HarnessLaunchContext): HarnessSession;
}
