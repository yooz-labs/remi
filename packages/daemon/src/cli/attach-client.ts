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
import type { ProtocolMessage, Question, UUID } from '@remi/shared';
import { performAuthHandshake } from './auth-helper.ts';
import { DetachScanner } from './detach-scanner.ts';

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

  // #753: question ids already shown as a banner, so a repeat delivery (the
  // daemon re-sends the authoritative pending set after the replay batch; a
  // reconnect could deliver it again) never double-prints, and a later
  // question_resolved can acknowledge exactly the banners the user saw.
  const banneredQuestionIds = new Set<string>();

  /**
   * #753: print a pending HELD question into the attached terminal. A held
   * permission (Model B) blocks Claude inside the hook call, so no raw PTY
   * bytes for the prompt exist and the resize-nudge redraw has nothing to
   * repaint — without this banner an attach shows only "waiting". ONLY held
   * questions banner (#760 review finding 1): every other question class
   * renders natively in the raw PTY stream, and the daemon emits multiple
   * `question` messages per visible prompt cycle (hook bridge + PTY parser,
   * different ids), so bannering those would double- or triple-print around
   * the native prompt — the exact noise the old blanket suppression avoided.
   * Held questions also guarantee an idle PTY, so the banner can never
   * interleave mid-ANSI-sequence with streaming output. Plain text through
   * writeOutput (raw mode: \r\n), cyan so it stands apart from Claude's own
   * output.
   */
  function renderQuestionBanner(question: Question): void {
    if (question.held !== true) return;
    if (banneredQuestionIds.has(question.id)) return;
    banneredQuestionIds.add(question.id);
    const options = question.options.map((o, i) => `${i + 1}) ${o.label}`).join('  ');
    const lines = [`\r\n\x1b[36m[remi] pending question: ${question.text}\x1b[0m\r\n`];
    if (options) lines.push(`\x1b[36m[remi] options: ${options}\x1b[0m\r\n`);
    lines.push(
      `\x1b[2m[remi] answer on your phone, or run 'remi unstick' to answer here\x1b[0m\r\n`,
    );
    writeOutput(lines.join(''));
  }

  function renderMessage(msg: ProtocolMessage, inReplay = false): void {
    switch (msg.type) {
      case 'raw_pty_output':
        receivedRawPty = true;
        writeRawBytes(msg.data);
        break;
      case 'question':
        // #753: LIVE questions only. Replayed history is not trustworthy for
        // pendingness — question_resolved is broadcast-only (never recorded),
        // so an already-answered question replays indistinguishably from a
        // pending one. The daemon re-sends the authoritative pending set as
        // live messages right after the replay batch, which is what lands here.
        if (!inReplay) renderQuestionBanner(msg.question);
        break;
      case 'question_resolved':
        // Only acknowledge questions this client actually bannered; resolved
        // broadcasts for questions answered before attach are noise.
        if (banneredQuestionIds.delete(msg.questionId)) {
          writeOutput('\r\n\x1b[2m[remi] question answered\x1b[0m\r\n');
        }
        break;
      case 'agent_output':
      case 'structured_agent_output':
      case 'session_update':
      case 'transcript_content':
        // Suppressed; raw PTY output already provides the full terminal view
        break;
      case 'replay_batch':
        for (const m of msg.messages) {
          renderMessage(m, true);
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

        // Forward terminal resize
        resizeListener = () => {
          const cols = process.stdout.columns || 120;
          const rows = process.stdout.rows || 40;
          sendMessage(createTerminalResize(cols, rows));
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
            sendMessage(createTerminalResize(cols, rows));
          }, 50);
        }

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
