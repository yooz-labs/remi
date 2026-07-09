import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';
import {
  createDetachSession,
  createHello,
  createPong,
  createTerminalResize,
  createUserInput,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import type { ProtocolMessage, RemiStatus, UUID } from '@remi/shared';
import { performAuthHandshake } from './auth-helper.ts';
import { DetachScanner } from './detach-scanner.ts';
import { StatusBar, childRows } from './status-bar.ts';

export interface AttachClientOptions {
  host: string;
  port: number;
  sessionId: string;
  timeout?: number;
  /** File descriptor for output. Defaults to 1 (stdout). Override in tests. */
  outputFd?: number;
}

export interface AttachClientResult {
  exitCode: number;
  reason: 'detached' | 'session_ended' | 'error' | 'timeout' | 'connection_closed';
}

export async function runAttachClient(opts: AttachClientOptions): Promise<AttachClientResult> {
  const { host, port, sessionId, timeout = 5000, outputFd = 1 } = opts;
  const url = `ws://${host}:${port}/ws`;

  let ws: WebSocket;
  let attachedSessionId: UUID | null = null;
  let rawModeSet = false;
  let detachScannerInstance: DetachScanner | null = null;
  let stdinListener: ((data: Buffer) => void) | null = null;
  let resizeListener: (() => void) | null = null;
  let resizeNudgeTimer: ReturnType<typeof setTimeout> | null = null;
  let resolved = false;
  let outputBroken = false;
  let authInProgress = false;
  let receivedRawPty = false;
  let rawPtyTimer: ReturnType<typeof setTimeout> | null = null;
  let detachPending = false;
  let detachAckTimer: ReturnType<typeof setTimeout> | null = null;
  // #754: latest daemon status snapshot (remi_status broadcast) + the
  // reserved-row bar rendering it — the same StatusBar the wrapper draws.
  // Only on a real TTY: piped/test output must never receive bar escapes.
  const statusBarEligible = process.stdout.isTTY === true;
  let latestStatus: RemiStatus | null = null;
  let statusBar: StatusBar | null = null;

  function writeOutput(text: string): void {
    if (outputBroken) return;
    try {
      fs.writeSync(outputFd, text);
    } catch (err) {
      outputBroken = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBADF' && code !== 'EPIPE') {
        process.stderr.write(`[remi] output write failed: ${code ?? err}\n`);
      }
    }
  }

  function restoreTerminal(): void {
    // #754: halt the bar loop and clear its reserved row before anything else
    // writes to the terminal, so the returned shell starts clean.
    if (statusBar) {
      statusBar.stop();
      statusBar = null;
    }
    if (detachAckTimer) {
      clearTimeout(detachAckTimer);
      detachAckTimer = null;
    }
    if (rawPtyTimer) {
      clearTimeout(rawPtyTimer);
      rawPtyTimer = null;
    }
    if (resizeNudgeTimer) {
      clearTimeout(resizeNudgeTimer);
      resizeNudgeTimer = null;
    }
    // Print a newline after detach so the user's shell prompt starts clean
    if (attachedSessionId) {
      try {
        fs.writeSync(outputFd, '\n');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EBADF' && code !== 'EPIPE') {
          process.stderr.write(`[remi] warning: cleanup write failed: ${code ?? err}\n`);
        }
      }
    }
    if (rawModeSet && process.stdin.isTTY) {
      try {
        process.stdin.setRawMode(false);
      } catch (err) {
        process.stderr.write(
          `[remi] warning: failed to restore terminal mode (run 'reset' to fix): ${err}\n`,
        );
      }
      rawModeSet = false;
    }
    if (detachScannerInstance) {
      detachScannerInstance.destroy();
      detachScannerInstance = null;
    }
    process.stdin.pause();
    if (stdinListener) {
      process.stdin.removeListener('data', stdinListener);
      stdinListener = null;
    }
    if (resizeListener) {
      process.stdout.removeListener('resize', resizeListener);
      resizeListener = null;
    }
  }

  function sendMessage(msg: ProtocolMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serialize(msg));
    }
  }

  function sendInput(content: string): void {
    if (attachedSessionId) {
      sendMessage(createUserInput(attachedSessionId, content, true));
    }
  }

  function writeRawBytes(base64Data: string): void {
    if (outputBroken) return;
    try {
      const buf = Buffer.from(base64Data, 'base64');
      fs.writeSync(outputFd, buf);
    } catch (err) {
      outputBroken = true;
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EBADF' && code !== 'EPIPE') {
        process.stderr.write(`[remi] output write failed: ${code ?? err}\n`);
      }
    }
  }

  /**
   * #754: start the reserved-row status bar once the first `remi_status`
   * snapshot arrives (an older daemon never sends one, so no row is wasted).
   * Reserving the row = reporting `rows - 1` to the daemon's PTY, exactly like
   * wrapper mode; the StatusBar itself is the same class, drawing on this
   * terminal's bottom row from the broadcast snapshots.
   */
  function startStatusBar(): void {
    if (!statusBarEligible || statusBar !== null || resolved) return;
    statusBar = new StatusBar({
      getStdoutFd: () => (outputBroken ? null : outputFd),
      getStatus: () => latestStatus as RemiStatus,
      getSize: () => ({
        cols: process.stdout.columns || 120,
        rows: process.stdout.rows || 40,
      }),
      isEnabled: () => latestStatus !== null,
      log: (msg) => process.stderr.write(`${msg}\n`),
    });
    statusBar.start();
    const cols = process.stdout.columns || 120;
    const rows = process.stdout.rows || 40;
    sendMessage(createTerminalResize(cols, childRows(rows, true)));
  }

  function renderMessage(msg: ProtocolMessage): void {
    switch (msg.type) {
      case 'raw_pty_output':
        receivedRawPty = true;
        writeRawBytes(msg.data);
        break;
      case 'remi_status':
        // #754: display state only — never printed as text. The bar's own
        // 250ms repaint loop reads the latest snapshot.
        latestStatus = msg.status;
        if (attachedSessionId) startStatusBar();
        break;
      case 'agent_output':
      case 'structured_agent_output':
      case 'question':
      case 'session_update':
      case 'transcript_content':
        // Suppressed; raw PTY output already provides the full terminal view
        break;
      case 'replay_batch':
        for (const m of msg.messages) {
          renderMessage(m);
        }
        break;
      case 'error':
        writeOutput(`\n[error: ${msg.code} - ${msg.message}]\n`);
        break;
      default:
        break;
    }
  }

  function sendHello(): void {
    const clientId = generateId();
    ws.send(serialize(createHello(clientId, '1.0.0', { resumeSessionId: sessionId as UUID })));
  }

  return new Promise<AttachClientResult>((resolve) => {
    function finish(result: AttachClientResult): void {
      if (resolved) return;
      resolved = true;
      restoreTerminal();
      try {
        ws.close();
      } catch {
        // ws may already be closed or in CLOSING state; safe to ignore
      }
      resolve(result);
    }

    ws = new WebSocket(url);

    const connectionTimer = setTimeout(() => {
      writeOutput(`\n[timed out connecting to daemon at ${host}:${port}]\n`);
      finish({ exitCode: 1, reason: 'timeout' });
    }, timeout);

    function handleProtocolMessage(msg: ProtocolMessage): void {
      if (msg.type === 'hello_ack') {
        // In daemon mode, server sends a preliminary hello_ack with empty sessionId
        // before session creation. Wait for the real one with a valid session ID.
        if (!msg.sessionId) return;
        clearTimeout(connectionTimer);
        attachedSessionId = msg.sessionId;
        const shortId = msg.sessionId.slice(0, 8);

        // Clear screen and home cursor; we stay in the primary screen buffer
        // so the user's terminal emulator provides native scrollback
        writeOutput('\x1b[2J\x1b[H');
        writeOutput(`[attached to session ${shortId}] (Ctrl+B d to detach)\n`);

        // Enter raw terminal mode
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          rawModeSet = true;
        }
        process.stdin.resume();

        // Use DetachScanner for Ctrl+B d detection (supports both standard
        // raw byte 0x02 and kitty keyboard protocol ESC[98;5u)
        detachScannerInstance = new DetachScanner({
          onDetach: () => {
            // Notify daemon of explicit detach so it skips orphan timeout.
            // Wait briefly for the ack to ensure the daemon processes the
            // detach before we close the WebSocket connection.
            if (attachedSessionId) {
              sendMessage(createDetachSession(attachedSessionId));
              detachPending = true;
              detachAckTimer = setTimeout(() => {
                process.stderr.write('[detached]\n');
                finish({ exitCode: 0, reason: 'detached' });
              }, 500);
            } else {
              process.stderr.write('[detached]\n');
              finish({ exitCode: 0, reason: 'detached' });
            }
          },
          onData: (data) => {
            sendInput(data.toString());
          },
        });
        stdinListener = (chunk: Buffer) => {
          detachScannerInstance?.write(chunk);
        };
        process.stdin.on('data', stdinListener);

        // Forward terminal resize. #754: while the status bar is up, its row
        // stays reserved (report rows-1, mirroring wrapper mode's childRows).
        resizeListener = () => {
          const cols = process.stdout.columns || 120;
          const rows = process.stdout.rows || 40;
          sendMessage(createTerminalResize(cols, childRows(rows, statusBar !== null)));
        };
        process.stdout.on('resize', resizeListener);

        // Send initial size -- nudge with cols-1 first, then real size,
        // to force Claude Code to re-render its TUI from the top.
        // Claude Code's TUI only redraws on actual size changes; sending
        // the same size has no effect, so we nudge first.
        if (process.stdout.columns && process.stdout.rows) {
          const cols = process.stdout.columns;
          const rows = process.stdout.rows;
          sendMessage(createTerminalResize(cols - 1, rows));
          resizeNudgeTimer = setTimeout(() => {
            resizeNudgeTimer = null;
            sendMessage(createTerminalResize(cols, childRows(rows, statusBar !== null)));
          }, 50);
        }

        // #754: a remi_status broadcast may have raced ahead of the (real)
        // hello_ack; start the bar from the stored snapshot now.
        if (latestStatus !== null) startStatusBar();

        // Warn if no raw PTY data arrives within a few seconds
        rawPtyTimer = setTimeout(() => {
          rawPtyTimer = null;
          if (!receivedRawPty && !resolved) {
            process.stderr.write(
              '[remi] warning: no raw PTY output received; session may not be producing terminal data\n',
            );
          }
        }, 3000);

        return;
      }

      if (msg.type === 'ping') {
        sendMessage(createPong(msg.id));
        return;
      }

      if (msg.type === 'detach_session_ack' && detachPending) {
        // Daemon confirmed the explicit detach; finish immediately
        if (detachAckTimer) {
          clearTimeout(detachAckTimer);
          detachAckTimer = null;
        }
        process.stderr.write('[detached]\n');
        finish({ exitCode: 0, reason: 'detached' });
        return;
      }

      if (msg.type === 'error' && msg.code === 'SESSION_ENDED') {
        writeOutput('\n[session ended]\n');
        finish({ exitCode: 0, reason: 'session_ended' });
        return;
      }

      if (msg.type === 'error' && msg.code === 'SESSION_BUSY') {
        writeOutput(`\n${msg.message}\n`);
        finish({ exitCode: 1, reason: 'error' });
        return;
      }

      renderMessage(msg);
    }

    ws.onopen = () => {
      // Send hello immediately. If auth is needed, the daemon will send
      // auth_challenge and reject this hello with AUTH_REQUIRED (benign).
      // After auth succeeds, we re-send hello.
      sendHello();
    };

    ws.onmessage = (event: MessageEvent) => {
      const data = typeof event.data === 'string' ? event.data : String(event.data);
      const msg = deserialize(data);
      if (!msg) return;

      // If daemon sends auth_challenge, perform handshake then re-send hello
      if (msg.type === 'auth_challenge') {
        if (authInProgress) return; // duplicate challenge; ignore
        authInProgress = true;
        performAuthHandshake(ws, msg)
          .then(() => {
            authInProgress = false;
            sendHello();
          })
          .catch((err) => {
            clearTimeout(connectionTimer);
            writeOutput(`\n[auth failed: ${errorToString(err)}]\n`);
            finish({ exitCode: 1, reason: 'error' });
          });
        return;
      }

      // During auth, the auth-helper's addEventListener handles messages;
      // only process in the caller after auth is done
      if (authInProgress) return;

      handleProtocolMessage(msg);
    };

    ws.onclose = () => {
      clearTimeout(connectionTimer);
      if (!resolved) {
        if (attachedSessionId) {
          writeOutput('\n[connection lost]\n');
        }
        finish({ exitCode: 1, reason: 'connection_closed' });
      }
    };

    ws.onerror = () => {
      clearTimeout(connectionTimer);
      writeOutput(`\n[cannot connect to daemon at ${host}:${port}]\n`);
      finish({ exitCode: 1, reason: 'error' });
    };
  });
}
