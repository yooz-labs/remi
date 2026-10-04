/**
 * Construct the PTYSession and wire its
 * four callbacks (onRawData, onData, onExit, onError).
 *
 * The harness's CLI (Claude Code unless `launch` says otherwise, #1176) is
 * spawned in a PTY so output fidelity matches a real terminal. Callbacks fan
 * out to:
 *   - onRawData: wrapper-mode local terminal (if pass-through is active AND
 *     the terminal hasn't detached) plus the actively attached CLI client
 *   - onData:    the output sink (Claude: the OutputProcessor, which parses
 *     tool-output errors and, when hooks are unavailable, status and question
 *     detection; Codex's is a startup-output capture, `codex-session.ts`)
 *   - onExit:    flush the sink, unregister the session, persist the
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

import { PTYSession } from '../../pty/index.ts';
import type { SessionRegistry, SessionRegistryFile, SessionStore } from '../../session/index.ts';
import { log, logError } from '../logger.ts';
import { childRows } from '../status-bar.ts';
import {
  getPtyStdoutFd,
  isWrapperDetached,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../wrapper-state.ts';

/**
 * What the PTY's data callbacks feed. Claude passes its `OutputProcessor`,
 * which satisfies this structurally; the spawn code knows nothing else about
 * the parser, so it imports none of Claude's.
 */
export interface PtyOutputSink {
  process(text: string): void;
  flush(): void;
}

/**
 * A sink that does nothing, for a caller that wants none. Codex parses no PTY
 * output (its state comes from the app-server, never from the screen) but
 * passes its own sink, which keeps the first 2 KB for a startup failure.
 */
export const NOOP_OUTPUT_SINK: PtyOutputSink = { process: () => {}, flush: () => {} };

export interface PtySessionSetupDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  /**
   * Live-sessions registry. On PTY exit the daemon may keep running (daemon
   * mode), so we mark this session's Claude child exited in its registry
   * entry; co-located daemons then stop treating us as a live sibling (#451).
   */
  liveSessionsRegistry: SessionRegistryFile;
  /** Receives every PTY data chunk and the final flush on exit. */
  outputSink: PtyOutputSink;
  /**
   * The port validated at entry; also the REMI_PORT value of the default
   * Claude child environment so hooks can report back (not used when
   * `launch` is given).
   */
  wsPort: number;
  /** Forward outgoing messages to the connection layer (raw PTY bytes). */
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void;
  /**
   * Process-level cleanup invoked on PTY exit. `createClaudeSession` passes
   * the daemon's main-flow cleanup function (`deps.cleanup`, from cli.ts:
   * uninstall hooks, stop mDNS, etc.).
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
   * #932 durable fix: observe every PTY chunk actually forwarded to the
   * wrapper's own local terminal fd -- the exact same fd the reserved-row
   * status bar draws into -- so a `PtyQuiescenceGate` can track whether a
   * bar write right now would land inside one of Claude's own escape
   * sequences. Fed with the raw bytes right AFTER they are successfully
   * written to that fd (never before -- #932 review finding 2: this
   * callback can synchronously trigger an immediate bar repaint when the
   * chunk completes a bare ESC[r, and observing before the write would put
   * that corrective paint on the wire before the very reset that
   * triggered it, undoing the correction instead of the other way around),
   * only when the wrapper is actually still attached (`passThrough &&
   * stdoutFd !== null && !isWrapperDetached()`, the same condition guarding
   * the write itself), and never with the bar's own paint bytes -- those
   * are self-terminating (see `buildBarSequence`) and do not need
   * tracking. Absent => no gate wired (tests, older callers); `StatusBar`'s
   * own `isBoundaryClean` / `isQuiescent` defaults then keep
   * pre-durable-fix behavior (always paintable).
   */
  observeLocalPtyOutput?: (data: Uint8Array) => void;
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
  /**
   * A launch of something other than Claude (#1176). Absent, the spawn is the
   * Claude launch, byte for byte: `claude` with `buildClaudeChildEnv`. Given,
   * both of its members are required, so a non-Claude command can never
   * inherit Claude's environment (`REMI_PORT`, `REMI_STATUS_BAR`,
   * `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN`) by leaving `childEnv` out.
   */
  launch?: PtyLaunch;
}

/** What to spawn instead of `claude`, and the environment it gets. */
export interface PtyLaunch {
  readonly command: string;
  /**
   * Environment overrides added on top of `process.env` for the child.
   * `{}` adds nothing of this launch's own: no `REMI_PORT` and none of Claude's
   * variables. The PTY layer still sets `FORCE_COLOR=1` and `TERM` (the
   * daemon's own, or `xterm-256color`) for every launch, Claude's included
   * (`pty/pty-session.ts`).
   */
  readonly childEnv: Readonly<Record<string, string>>;
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

/**
 * Env var that makes Claude Code use its classic inline renderer instead of
 * the fullscreen alternate-screen one. Claude Code's docs
 * (code.claude.com/docs/en/fullscreen) say fullscreen is the default for users
 * who first used it on or after 2026-05-06; 2.1.287 gates it on first-start
 * version and server flags unless `tui` is `default`. remi's status bar and PTY
 * prompt parsing were built against the inline renderer, so remi sets this for
 * the Claude child (#1124).
 */
export const CLAUDE_INLINE_RENDERER_ENV = 'CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN';

/**
 * Environment overrides remi adds on top of the incoming environment for the
 * Claude child. `PTYSession.start()` spreads `process.env` first and these
 * after, so anything returned here wins over the user's environment; that is
 * why the inline-renderer variable is only emitted when the user has not set
 * it to something non-empty.
 *
 * - `REMI_PORT`: lets Claude's hooks report back to this daemon.
 * - `REMI_STATUS_BAR` (only when `reservedRows > 0`, #565): tells Claude's
 *   statusLine script to drop the remi prefix and show only model/context,
 *   because the reserved-row bar already renders the remi fields.
 * - `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (#1124): remi FORCES the inline
 *   renderer. Claude checks this variable before `CLAUDE_CODE_NO_FLICKER=1`
 *   and before the `tui` setting (read from the 2.1.287 binary), so setting it
 *   overrides both, including a user's own fullscreen opt-in. It is skipped
 *   only when `incoming` already has the variable with a non-empty value
 *   (nothing is emitted, so the spread keeps the user's value): that makes
 *   `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0` the opt-out. An empty,
 *   whitespace-only, or undefined value counts as unset and is forced to `1`.
 *   Claude's in-session `/tui` switch relaunches with `dropEnv` removing this
 *   variable, so a session can still end up on the alternate screen (#1135).
 *   `createPtySessionForSession` uses this only for the default Claude launch;
 *   a non-Claude `launch` supplies its own `childEnv` and never receives it.
 */
export function buildClaudeChildEnv(
  wsPort: number,
  reservedRows = 0,
  incoming: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string> {
  const env: Record<string, string> = { REMI_PORT: String(wsPort) };
  if (reservedRows > 0) env['REMI_STATUS_BAR'] = '1';
  const userValue = incoming[CLAUDE_INLINE_RENDERER_ENV];
  if (userValue === undefined || userValue.trim() === '') {
    env[CLAUDE_INLINE_RENDERER_ENV] = '1';
  }
  return env;
}

export function createPtySessionForSession(
  deps: Readonly<PtySessionSetupDeps>,
  args: Readonly<PtySessionSetupArgs>,
): PTYSession {
  const {
    sessionRegistry,
    sessionStore,
    liveSessionsRegistry,
    outputSink,
    wsPort,
    sendMessage,
    cleanup,
    exitProcess = (code: number) => process.exit(code),
    observeLocalPtyOutput,
  } = deps;
  const { sessionId, workingDirectory, extraArgs, passThrough, reservedRows = 0, launch } = args;

  // The type already requires both; a caller without types (or a cast) that
  // leaves `childEnv` out must not get Claude's environment for its command.
  if (
    launch !== undefined &&
    (typeof launch.command !== 'string' ||
      launch.command === '' ||
      typeof launch.childEnv !== 'object' ||
      launch.childEnv === null)
  ) {
    throw new Error('launch needs both a command and a childEnv');
  }

  if (!Number.isInteger(wsPort) || wsPort <= 0) {
    throw new Error(`Invalid wsPort: ${wsPort}. Must be a positive integer.`);
  }

  const termSize = computeTermSize(passThrough, reservedRows);

  const command = launch?.command ?? 'claude';
  const env = launch?.childEnv ?? buildClaudeChildEnv(wsPort, reservedRows);

  const ptySession: PTYSession = new PTYSession(
    {
      command,
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
          let wroteToLocalTerminal = false;
          try {
            fs.writeSync(stdoutFd, data);
            wroteToLocalTerminal = true;
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
          // #932 durable fix (review finding 2): feed the quiescence +
          // clean-boundary gate AFTER the real chunk has landed on the
          // wire, never before -- and outside the write's own try/catch,
          // so a throw from this callback (e.g. a caller's isBoundaryClean/
          // isQuiescent/hasLiveQuestions predicate) is never misclassified
          // as a terminal write failure and does not trigger a spurious
          // detach. `observeLocalPtyOutput` can synchronously trigger an
          // immediate bar repaint (StatusBar.notifyScrollRegionReset, when
          // this chunk completes a bare ESC[r) -- observing before the
          // write would put that corrective DECSTBM-reasserting write on
          // the wire BEFORE the very reset that triggered it, so the reset
          // would immediately undo the correction instead of the other way
          // around. Only fed on a successful write: a failed write means
          // these bytes never reached the terminal, so the gate must not
          // treat them as having done so (and `isWrapperDetached()` is now
          // true anyway, so the bar cannot paint through this fd
          // regardless).
          if (wroteToLocalTerminal) observeLocalPtyOutput?.(data);
        }

        // Forward raw PTY bytes when at least one connection is attached
        // (#795: fanned out to ALL attached connections downstream, not just
        // a single exclusive one — see the sendMessage wiring in cli.ts).
        const session = sessionRegistry.getSession(sessionId);
        if (session && session.attachedConnections.size > 0) {
          const base64Data = Buffer.from(data).toString('base64');
          sendMessage(sessionId, createRawPtyOutput(base64Data, sessionId));
        }
      },
      onData: (output: string) => {
        try {
          outputSink.process(output);
        } catch (err) {
          logError(`[OutputProcessor] process() failed for session ${sessionId}:`, err);
        }
      },
      onExit: (code: number | null) => {
        try {
          outputSink.flush();
        } catch (err) {
          logError(`[OutputProcessor] flush() failed for session ${sessionId}:`, err);
        }
        log(`PTY ${ptySession.id} exited with code ${code}`);
        sessionRegistry.handlePTYExit(sessionId);
        try {
          sessionStore.markExited(sessionId, code);
        } catch (err) {
          // SessionStore is durable bookkeeping, but a lock timeout or disk
          // failure must not prevent PTY cleanup and daemon shutdown.
          logError(`[SessionStore] markExited failed for ${sessionId}: ${errorToString(err)}`);
        }
        // The daemon process can outlive its Claude child (daemon mode). Record
        // the child as dead so co-located daemons stop counting us as a live
        // sibling and their rotation handling is not wedged (#451). Best-effort.
        // The `claudeChild*` fields name the harness's child, whichever
        // command it is (`createNewSession` records the pid of any harness's
        // child), so this is neutral in effect (#1176).
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
