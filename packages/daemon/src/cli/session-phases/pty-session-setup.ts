/**
 * Construct the PTYSession and wire its
 * four callbacks (onRawData, onData, onExit, onError).
 *
 * The Claude Code CLI is spawned in a PTY so output fidelity matches a real
 * terminal. Callbacks fan out to:
 *   - onRawData: wrapper-mode local terminal (if pass-through is active AND
 *     the terminal hasn't detached) plus the actively attached CLI client
 *   - onData:    the OutputProcessor which parses tool-output errors and,
 *     when hooks are unavailable, status and question detection
 *   - onExit:    flush the processor, unregister the session, persist the
 *     exit code, and (pass-through only) trigger process-level cleanup
 *   - onError:   log only; PTYs rarely fail in ways the caller can recover
 *     from without a full restart
 *
 * Wrapper-mode stdout writes go through `cli/wrapper-state.ts` so the
 * callback can observe and mutate the shared `ptyStdoutFd` /
 * `wrapperDetached` flags without closing over cli.ts-local `let` bindings.
 */

import * as fs from 'node:fs';
import { createRawPtyOutput, errorToString } from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';

import { isAuqClosed } from '../../hooks/auq-answer.ts';
import type { OutputProcessor } from '../../parser/output-processor.ts';
import { PTYSession } from '../../pty/index.ts';
import { appendPtyOutput, clearPtyOutput, readPtyOutput } from '../../pty/output-buffer.ts';
import type { SessionRegistry, SessionRegistryFile, SessionStore } from '../../session/index.ts';
import { log, logError } from '../logger.ts';
import { childRows } from '../status-bar.ts';
import {
  getPtyStdoutFd,
  isWrapperDetached,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../wrapper-state.ts';

export interface PtySessionSetupDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  /**
   * Live-sessions registry. On PTY exit the daemon may keep running (daemon
   * mode), so we mark this session's Claude child exited in its registry
   * entry; co-located daemons then stop treating us as a live sibling (#451).
   */
  liveSessionsRegistry: SessionRegistryFile;
  outputProcessor: OutputProcessor;
  /** Value passed to PTYSession.env as REMI_PORT so hooks can report back. */
  wsPort: number;
  /** Forward outgoing messages to the connection layer (raw PTY bytes). */
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void;
  /**
   * Process-level cleanup invoked on PTY exit. `createNewSession` in cli.ts
   * passes the main-flow cleanup function (uninstall hooks, stop mDNS, etc.).
   */
  cleanup: () => Promise<void>;
  /**
   * Terminate the daemon process after cleanup once the session's Claude has
   * exited (#641). One daemon = one session, so a daemon with no session has
   * nothing to host and would otherwise linger as a phantom host. Injected so
   * tests can drive a real PTY exit without killing the test runner; defaults
   * to `process.exit`.
   */
  exitProcess?: (code: number) => void;
  /**
   * Cross-client question dismissal (#585, #661). Fired when `onData` detects
   * that a pending structured AskUserQuestion closed IN THE TERMINAL (see
   * `detectAuqTerminalAnswers` below) — the same broadcast the phone-answered
   * path fires via `input-events.ts`'s `onQuestionResolved`. Absent => no
   * dismissal broadcast (tests/old callers).
   */
  onQuestionResolved?: (sessionId: UUID, questionId: UUID) => void;
  /**
   * Cancel the auto-approve eval for a specific question (#617), mirroring
   * `input-events.ts`'s `cancelAutoApproveForQuestion`. Fired alongside the
   * terminal-answer cleanup so a GPU eval in flight for a question the user
   * just answered by typing is freed the same way a phone answer would free
   * it. Absent => no-op (tests/old callers, or auto-approve disabled).
   */
  cancelAutoApproveForQuestion?: (sessionId: UUID, questionId: UUID, reason: string) => void;
}

/**
 * #538/#661: an AskUserQuestion the auq-runner ESCALATED (gave up auto-driving,
 * e.g. every multi-select before this fix) can still be answered by the user
 * typing directly in the terminal — Claude accepts it and prints the same
 * closure marker `isAuqClosed` looks for. Nothing then watches for that
 * closure: the runner already returned, and the phone-side question card is
 * left registered forever (the card asks the user to "answer in the
 * terminal", they do, and the card never clears — compounding #538).
 *
 * Every PTY output chunk already flows through `onData` unconditionally (not
 * gated on a hook server being active), so it is the cheapest existing tap to
 * also watch for this marker against any still-pending `kind:
 * 'multi_question'` question for the session, and fire the same
 * removeQuestion + onQuestionResolved cleanup the phone-answered path uses
 * (`input-events.ts`'s `handleAuqAnswer`) so the card clears everywhere.
 *
 * This can race the auq-runner's OWN closure poll (both read the same rolling
 * buffer via `readPtyOutput`): whichever notices the marker first removes the
 * question; the other's removeQuestion/onQuestionResolved is then a harmless
 * no-op / idempotent repeat broadcast (removeQuestion on a missing id is a
 * no-op; onQuestionResolved's client-side handling is documented idempotent).
 * Cheap to call on every chunk: it only scans `currentQuestions` (bounded,
 * `MAX_PENDING_QUESTIONS`) and short-circuits before touching the buffer text
 * unless at least one AUQ question is actually pending.
 */
export function detectAuqTerminalAnswers(
  sessionId: UUID,
  sessionRegistry: SessionRegistry,
  onQuestionResolved?: (sessionId: UUID, questionId: UUID) => void,
  cancelAutoApproveForQuestion?: (sessionId: UUID, questionId: UUID, reason: string) => void,
): void {
  const session = sessionRegistry.getSession(sessionId);
  if (!session || session.currentQuestions.size === 0) return;
  const auqQuestions = [...session.currentQuestions.values()].filter(
    (q) => q.kind === 'multi_question',
  );
  if (auqQuestions.length === 0) return;
  if (!isAuqClosed(readPtyOutput(sessionId))) return;
  for (const q of auqQuestions) {
    cancelAutoApproveForQuestion?.(sessionId, q.id, 'user-answered-auq-terminal');
    sessionRegistry.removeQuestion(sessionId, q.id);
    try {
      onQuestionResolved?.(sessionId, q.id);
    } catch (err) {
      logError(`[AUQ] terminal-answer question_resolved broadcast failed: ${errorToString(err)}`);
    }
  }
}

export interface PtySessionSetupArgs {
  sessionId: UUID;
  workingDirectory: string;
  extraArgs: readonly string[];
  /** True when the PTY is attached to a local terminal (wrapper mode). */
  passThrough: boolean;
  /**
   * Rows the wrapper reserves for its own status bar (#565). When > 0 the child
   * PTY is reported `rows - reservedRows` so Claude never touches the reserved
   * row(s). 0 (default) gives Claude the full terminal height.
   */
  reservedRows?: number;
}

/**
 * Compute the PTY terminal size. Headless daemon PTYs are a deterministic
 * 120x40 so output parsing is reproducible; wrapper-mode PTYs prefer the
 * host terminal's `stdout.columns`/`rows` and fall back to 120x40 if those
 * are unavailable (e.g., stdout not a TTY).
 *
 * `reservedRows` (#565) shrinks the reported height so the wrapper can own the
 * bottom row(s); it only applies in pass-through mode and only when the
 * terminal is tall enough to spare the row (see `childRows`).
 *
 * Caller invariant: pass `reservedRows > 0` only when stdout is a real TTY.
 * The sole caller (the wrapper block in cli.ts) derives it from
 * `statusBarActive`, which already requires `process.stdout.isTTY`, so a
 * non-TTY stdout (no real row count) never reserves a row here.
 */
export function computeTermSize(
  passThrough: boolean,
  reservedRows = 0,
): { cols: number; rows: number } {
  if (!passThrough) return { cols: 120, rows: 40 };
  const realRows = process.stdout.rows || 40;
  return {
    cols: process.stdout.columns || 120,
    rows: childRows(realRows, reservedRows > 0),
  };
}

export function createPtySessionForSession(
  deps: Readonly<PtySessionSetupDeps>,
  args: Readonly<PtySessionSetupArgs>,
): PTYSession {
  const {
    sessionRegistry,
    sessionStore,
    liveSessionsRegistry,
    outputProcessor,
    wsPort,
    sendMessage,
    cleanup,
    exitProcess = (code: number) => process.exit(code),
    onQuestionResolved,
    cancelAutoApproveForQuestion,
  } = deps;
  const { sessionId, workingDirectory, extraArgs, passThrough, reservedRows = 0 } = args;

  if (!Number.isInteger(wsPort) || wsPort <= 0) {
    throw new Error(`Invalid wsPort: ${wsPort}. Must be a positive integer.`);
  }

  const termSize = computeTermSize(passThrough, reservedRows);

  // When the reserved-row status bar is active (#565), tell Claude's statusLine
  // script via REMI_STATUS_BAR so it drops the remi prefix and shows only
  // model/context — the bar already renders the remi fields, avoiding a
  // duplicate line just above the bar.
  const env: Record<string, string> = { REMI_PORT: String(wsPort) };
  if (reservedRows > 0) env['REMI_STATUS_BAR'] = '1';

  const ptySession: PTYSession = new PTYSession(
    {
      command: 'claude',
      args: [...extraArgs],
      cwd: workingDirectory,
      size: termSize,
      env,
    },
    {
      onRawData: (data: Uint8Array) => {
        // Write to the local terminal when wrapper is still attached.
        const stdoutFd = getPtyStdoutFd();
        if (passThrough && stdoutFd !== null && !isWrapperDetached()) {
          try {
            fs.writeSync(stdoutFd, data);
          } catch (err) {
            const code = (err as NodeJS.ErrnoException).code;
            setPtyStdoutFd(null);
            setWrapperDetached(true);
            if (code === 'EPIPE' || code === 'EIO') {
              logError(`Terminal write failed (${code}), detaching local terminal`);
            } else {
              logError(`Unexpected terminal write error (${code}):`, errorToString(err));
            }
            // Leaving stdin in raw mode would keep stealing bytes even though
            // we can no longer render the PTY. Restore it and drop listeners.
            if (process.stdin.isTTY) {
              try {
                process.stdin.setRawMode(false);
              } catch {
                // stdin may already be unusable
              }
            }
            process.stdin.pause();
            process.stdin.removeAllListeners('data');
            process.stdin.unref();
          }
        }

        // Forward raw PTY bytes to the actively attached CLI client (if any).
        const session = sessionRegistry.getSession(sessionId);
        if (session?.activeConnectionId) {
          const base64Data = Buffer.from(data).toString('base64');
          sendMessage(sessionId, createRawPtyOutput(base64Data, sessionId));
        }
      },
      onData: (output: string) => {
        // #627: feed the rolling buffer the AskUserQuestion runner reads to detect
        // the review screen + closure marker while driving the interactive TUI.
        appendPtyOutput(sessionId, output);
        try {
          outputProcessor.process(output);
        } catch (err) {
          logError(`[OutputProcessor] process() failed for session ${sessionId}:`, err);
        }
        // #538/#661: also catch an AUQ closing IN THE TERMINAL after the runner
        // gave up (escalated) — see `detectAuqTerminalAnswers` for why this is
        // the right tap.
        detectAuqTerminalAnswers(
          sessionId,
          sessionRegistry,
          onQuestionResolved,
          cancelAutoApproveForQuestion,
        );
      },
      onExit: (code: number | null) => {
        try {
          outputProcessor.flush();
        } catch (err) {
          logError(`[OutputProcessor] flush() failed for session ${sessionId}:`, err);
        }
        log(`PTY ${ptySession.id} exited with code ${code}`);
        clearPtyOutput(sessionId); // #627: drop the rolling output buffer
        sessionRegistry.handlePTYExit(sessionId);
        sessionStore.markExited(sessionId, code);
        // The daemon process can outlive its Claude child (daemon mode). Record
        // the child as dead so co-located daemons stop counting us as a live
        // sibling and their rotation handling is not wedged (#451). Best-effort.
        try {
          liveSessionsRegistry.markClaudeChildExited(sessionId);
        } catch (err) {
          logError(`[live-sessions] markClaudeChildExited failed: ${errorToString(err)}`);
        }

        // One daemon = one session. When the session's Claude exits — via /exit,
        // a Stop request, or on its own — the daemon has nothing left to host, so
        // it shuts down and frees its port instead of lingering as a phantom host
        // (#641). The session stays resumable from its transcript + stored Claude
        // session hash (markExited above keeps the entry). Wrapper mode
        // (passThrough) exits with Claude's code; a standalone daemon exits 0.
        cleanup()
          .then(() => exitProcess(passThrough ? (code ?? 0) : 0))
          .catch((err) => {
            logError(`[PTY] Cleanup failed: ${errorToString(err)}`);
            exitProcess(1);
          });
      },
      onError: (error: Error) => {
        logError(`PTY ${ptySession.id} error:`, error);
      },
    },
  );

  return ptySession;
}
