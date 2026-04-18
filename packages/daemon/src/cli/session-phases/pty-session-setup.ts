/**
 * Sub-phase D of createNewSession: construct the PTYSession and wire its
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

import type { OutputProcessor } from '../../parser/output-processor.ts';
import { PTYSession } from '../../pty/index.ts';
import type { SessionRegistry, SessionStore } from '../../session/index.ts';
import { log, logError } from '../logger.ts';
import {
  getPtyStdoutFd,
  isWrapperDetached,
  setPtyStdoutFd,
  setWrapperDetached,
} from '../wrapper-state.ts';

export interface PtySessionSetupDeps {
  sessionRegistry: SessionRegistry;
  sessionStore: SessionStore;
  outputProcessor: OutputProcessor;
  /** Value passed to PTYSession.env as REMI_PORT so hooks can report back. */
  wsPort: number;
  /** Forward outgoing messages to the connection layer (raw PTY bytes). */
  sendMessage: (sessionId: UUID, message: ProtocolMessage) => void;
  /**
   * Process-level cleanup invoked on PTY exit when passThrough is set.
   * `createNewSession` in cli.ts passes the main-flow cleanup function; this
   * is the only way an in-terminal session exits the wrapper process.
   */
  cleanup: () => Promise<void>;
}

export interface PtySessionSetupArgs {
  sessionId: UUID;
  workingDirectory: string;
  extraArgs: readonly string[];
  /** True when the PTY is attached to a local terminal (wrapper mode). */
  passThrough: boolean;
}

/**
 * Compute the PTY terminal size. Headless daemon PTYs are a deterministic
 * 120x40 so output parsing is reproducible; wrapper-mode PTYs prefer the
 * host terminal's `stdout.columns`/`rows` and fall back to 120x40 if those
 * are unavailable (e.g., stdout not a TTY).
 */
export function computeTermSize(passThrough: boolean): { cols: number; rows: number } {
  if (!passThrough) return { cols: 120, rows: 40 };
  return {
    cols: process.stdout.columns || 120,
    rows: process.stdout.rows || 40,
  };
}

export function createPtySessionForSession(
  deps: Readonly<PtySessionSetupDeps>,
  args: Readonly<PtySessionSetupArgs>,
): PTYSession {
  const { sessionRegistry, sessionStore, outputProcessor, wsPort, sendMessage, cleanup } = deps;
  const { sessionId, workingDirectory, extraArgs, passThrough } = args;

  if (!Number.isInteger(wsPort) || wsPort <= 0) {
    throw new Error(`Invalid wsPort: ${wsPort}. Must be a positive integer.`);
  }

  const termSize = computeTermSize(passThrough);

  const ptySession: PTYSession = new PTYSession(
    {
      command: 'claude',
      args: [...extraArgs],
      cwd: workingDirectory,
      size: termSize,
      env: { REMI_PORT: String(wsPort) },
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
        try {
          outputProcessor.process(output);
        } catch (err) {
          logError(`[OutputProcessor] process() failed for session ${sessionId}:`, err);
        }
      },
      onExit: (code: number | null) => {
        try {
          outputProcessor.flush();
        } catch (err) {
          logError(`[OutputProcessor] flush() failed for session ${sessionId}:`, err);
        }
        log(`PTY ${ptySession.id} exited with code ${code}`);
        sessionRegistry.handlePTYExit(sessionId);
        sessionStore.markExited(sessionId, code);

        if (passThrough) {
          cleanup()
            .then(() => process.exit(code ?? 0))
            .catch((err) => {
              logError(`[PTY] Cleanup failed: ${errorToString(err)}`);
              process.exit(1);
            });
        }
      },
      onError: (error: Error) => {
        logError(`PTY ${ptySession.id} error:`, error);
      },
    },
  );

  return ptySession;
}
