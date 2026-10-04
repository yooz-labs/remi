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

import type { ProtocolMessage, QuestionOption, UUID } from '@remi/shared';

import type { MessageAPI } from '../api/message-api.ts';
import type { PTYSession } from '../pty/index.ts';
import type { HeldAnswer, HeldAnswerOutcome } from './decision.ts';

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
}

/**
 * What the daemon reads off a harness's rendered screen to guard an answer it
 * is about to type (Claude: the `QuestionPresenceTracker`). The
 * `ScreenObserver` and `PromptUpScreen` reads in `cli/handlers/` are the
 * consumers; this declares the same three methods from the harness side.
 */
export interface DecisionScreen {
  isPromptCurrent(questionId: string, ptyText?: string): boolean;
  isPromptObservedOnPTY(): boolean;
  observedPromptOptions(): readonly QuestionOption[] | null;
}

/**
 * How a session's pending decisions (permission prompts, questions, plan
 * approvals) are answered and watched. The member names are those of the
 * Claude permission gate's handle (`SessionGateHandle`), so the answer, chat
 * and Stop handlers that read them (`gateAnswerDeps`, `promptUpDeps`,
 * `trackerScreenDeps`) take it unchanged. A harness with nothing held reads
 * as: nothing held, nothing to retire, `unknown` for any answer.
 */
export interface DecisionChannel {
  /** Apply a phone answer to a held prompt; `unknown` when none is held for it. */
  answerHeld(questionId: UUID, answer: HeldAnswer): HeldAnswerOutcome;
  /** Another path already removed and dismissed `questionId`; stop tracking it. */
  retireQuestion(questionId: UUID): void;
  /** Is `questionId`'s prompt held for the phone? */
  isHeld(questionId: UUID): boolean;
  /** Is a main-agent prompt held, with its dialog on screen? */
  hasMainHold(): boolean;
  /** Is a hook-backed dialog on screen, or possibly so (held or waiting in the terminal)? */
  hasOpenHookPrompt(): boolean;
  /** A bare Escape reached the terminal through remi: resolve the main agent's waiting prompts. */
  noteTerminalEscape(): void;
  /** The `remi unstick` escape: resolve and dismiss every open escalation. */
  forceRelease(reason: string): { resolved: number };
  /** The rendered-screen reads, when the harness has a screen to read. */
  readonly screen?: DecisionScreen | undefined;
}

/**
 * One launched session: the PTY (built, not yet started), how its pending
 * decisions are answered, and how to start and end it. `cli.ts` registers the
 * PTY with the session registry between construction and `start()`, which is
 * why they are separate.
 */
export interface HarnessSession {
  readonly pty: PTYSession;
  readonly decisions: DecisionChannel;
  /**
   * Does this session take chat text typed from a client (web, Telegram, the
   * relay)? Absent means yes. `false` makes the chat handler refuse the text
   * (`PROMPT_WAITING`, naming the message) and type nothing; raw input, a
   * person's keystrokes from an attach client, the Escape button or
   * `/interrupt`, is never affected. Codex sets it (#1177): it has no screen
   * reads, so nothing can tell remi that its TUI is showing an approval or a
   * modal that a typed Enter would confirm.
   */
  readonly acceptsTypedChat?: boolean;
  /** Spawn the PTY. Rejects when the spawn fails; the caller marks the stored session exited. */
  start(): Promise<void>;
  /**
   * Release what the session holds beyond the PTY itself (Claude: the
   * transcript binder's watcher, fallback timer and rotation poll, and its
   * turn-filter registration). Safe to call twice.
   */
  dispose(): void;
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
   * session WILL have (or has), not proof the file exists. `null` when the
   * harness has no transcript file remi can name (#1176: Codex's history comes
   * from its app-server, not a file), which every caller reads as "no file".
   * Claude: `<projectsDir>/<project path with every "/" replaced by "-">/<id>.jsonl`.
   */
  transcriptPath(projectPath: string, harnessSessionId: string): string | null;

  /**
   * Build the session's detection, binding and PTY, in the order the harness
   * needs them, and return it unstarted. May throw (the caller lets it
   * propagate, as the inline code did).
   */
  createSession(ctx: HarnessLaunchContext): HarnessSession;
}
