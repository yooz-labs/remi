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

const CTRL_B = 0x02;
const DETACH_TIMEOUT_MS = 1000;

export async function runAttachClient(opts: AttachClientOptions): Promise<AttachClientResult> {
  const { host, port, sessionId, timeout = 5000, outputFd = 1 } = opts;
  const url = `ws://${host}:${port}/ws`;

  let ws: WebSocket;
  let attachedSessionId: UUID | null = null;
  let ctrlBPending = false;
  let ctrlBTimer: ReturnType<typeof setTimeout> | null = null;
  let rawModeSet = false;
  let stdinListener: ((data: Buffer) => void) | null = null;
  let resizeListener: (() => void) | null = null;
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
      sendMessage(createUserInput(attachedSessionId, content));
    }
  }

  function renderMessage(msg: ProtocolMessage): void {
    switch (msg.type) {
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
        writeOutput(`\x1b[2m[${msg.session.status}]\x1b[0m `);
        break;
      case 'replay_batch':
        for (const m of msg.messages) {
          renderMessage(m);
        }
        break;
      case 'transcript_content':
        writeOutput(`\n[${msg.role}] ${msg.content}\n`);
        break;
      case 'error':
        // Ignore AUTH_REQUIRED (benign; happens when hello sent before auth)
        if (msg.code === 'AUTH_REQUIRED') return;
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
        writeOutput(`[attached to session ${shortId}]\n`);

        // Enter raw terminal mode
        if (process.stdin.isTTY) {
          process.stdin.setRawMode(true);
          rawModeSet = true;
        }
        process.stdin.resume();

        // Pipe stdin to daemon, processing byte-by-byte for Ctrl+B detection
        stdinListener = (chunk: Buffer) => {
          for (let i = 0; i < chunk.length; i++) {
            // biome-ignore lint/style/noNonNullAssertion: bounds checked by loop condition
            const byte = chunk[i]!;

            if (ctrlBPending) {
              ctrlBPending = false;
              if (ctrlBTimer) {
                clearTimeout(ctrlBTimer);
                ctrlBTimer = null;
              }

              if (byte === 0x64) {
                // 'd' after Ctrl+B: detach
                writeOutput('\n[detached]\n');
                finish({ exitCode: 0, reason: 'detached' });
                return;
              }

              // Not a detach sequence: forward buffered Ctrl+B and this byte
              sendInput(String.fromCharCode(CTRL_B));
              sendInput(String.fromCharCode(byte));
              continue;
            }

            if (byte === CTRL_B) {
              ctrlBPending = true;
              ctrlBTimer = setTimeout(() => {
                ctrlBPending = false;
                ctrlBTimer = null;
                sendInput(String.fromCharCode(CTRL_B));
              }, DETACH_TIMEOUT_MS);
              continue;
            }

            // Scan ahead for the next Ctrl+B in this chunk
            let end = i + 1;
            while (end < chunk.length && chunk[end] !== CTRL_B) {
              end++;
            }
            // Forward the normal bytes as a batch
            sendInput(chunk.slice(i, end).toString());
            i = end - 1; // loop increment will advance to `end`
          }
        };
        process.stdin.on('data', stdinListener);

        // Forward terminal resize
        resizeListener = () => {
          const cols = process.stdout.columns || 120;
          const rows = process.stdout.rows || 40;
          sendMessage(createTerminalResize(cols, rows));
        };
        process.stdout.on('resize', resizeListener);

        // Send initial size
        if (process.stdout.columns && process.stdout.rows) {
          sendMessage(createTerminalResize(process.stdout.columns, process.stdout.rows));
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
      if (msg.type === 'auth_challenge' && !authInProgress) {
        authInProgress = true;
        performAuthHandshake(ws, msg, handleProtocolMessage)
          .then(() => {
            sendHello();
          })
          .catch((err) => {
            clearTimeout(connectionTimer);
            writeOutput(`\n[auth failed: ${err instanceof Error ? err.message : String(err)}]\n`);
            finish({ exitCode: 1, reason: 'error' });
          });
        return;
      }

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
