import * as fs from 'node:fs';
import {
  createHello,
  createPong,
  createTerminalResize,
  createUserInput,
  deserialize,
  generateId,
  serialize,
} from '@remi/shared';
import type { ProtocolMessage, UUID } from '@remi/shared';
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
    if (resizeNudgeTimer) {
      clearTimeout(resizeNudgeTimer);
      resizeNudgeTimer = null;
    }
    // Exit alternate screen buffer (restores original terminal content)
    if (attachedSessionId) {
      try {
        fs.writeSync(outputFd, '\x1b[?1049l');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code !== 'EBADF' && code !== 'EPIPE') {
          process.stderr.write(`[remi] warning: failed to exit alternate screen: ${code ?? err}\n`);
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

  function renderMessage(msg: ProtocolMessage): void {
    switch (msg.type) {
      case 'raw_pty_output':
        writeRawBytes(msg.data);
        break;
      case 'agent_output':
      case 'structured_agent_output':
        writeOutput(msg.message.content);
        break;
      case 'question':
        writeOutput(`\n? ${msg.question.text}\n`);
        if (msg.question.options) {
          for (const opt of msg.question.options) {
            writeOutput(`  ${opt.label}\n`);
          }
        }
        break;
      case 'session_update':
        // Suppress status badges (raw PTY output provides the full terminal view)
        break;
      case 'replay_batch':
        for (const m of msg.messages) {
          renderMessage(m);
        }
        break;
      case 'transcript_content':
        // Suppress transcript content (raw PTY output provides the full terminal view)
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
    ws.send(serialize(createHello(clientId, '1.0.0', undefined, sessionId as UUID)));
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
        clearTimeout(connectionTimer);
        attachedSessionId = msg.sessionId;
        const shortId = msg.sessionId.slice(0, 8);

        // Enter alternate screen buffer (like tmux) first, then show banner
        // inside the alternate buffer so it doesn't persist in scrollback
        writeOutput('\x1b[?1049h\x1b[2J\x1b[H');
        writeOutput(`[attached to session ${shortId}] (Ctrl+B d to detach)\n`);

        // Enter raw terminal mode
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          rawModeSet = true;
        }
        process.stdin.resume();

        // Use DetachScanner for Ctrl+B d detection (supports both legacy
        // raw byte 0x02 and kitty keyboard protocol ESC[98;5u)
        detachScannerInstance = new DetachScanner({
          onDetach: () => {
            process.stderr.write('[detached]\n');
            finish({ exitCode: 0, reason: 'detached' });
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

        return;
      }

      if (msg.type === 'ping') {
        sendMessage(createPong(msg.id));
        return;
      }

      if (msg.type === 'error' && msg.code === 'SESSION_ENDED') {
        writeOutput('\n[session ended]\n');
        finish({ exitCode: 0, reason: 'session_ended' });
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
            writeOutput(`\n[auth failed: ${err instanceof Error ? err.message : String(err)}]\n`);
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
