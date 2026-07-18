/**
 * PTY Session - Manages a single Claude Code terminal session.
 *
 * Uses Bun's native Terminal API (Bun.spawn with terminal option)
 * to create and manage a pseudo-terminal for Claude Code.
 */

import { generateId, now } from '@remi/shared';
import type { AgentStatus, Timestamp, UUID } from '@remi/shared';
import { ptyCapture } from './pty-capture.ts';

/** Terminal dimensions */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** Events emitted by PTY session */
export interface PTYSessionEvents {
  /** Raw output data from terminal (decoded to string) */
  onData: (data: string) => void;

  /** Raw bytes from terminal, before text decoding. Use for direct pass-through. */
  onRawData?: (data: Uint8Array) => void;

  /** Session status changed */
  onStatusChange: (status: AgentStatus) => void;

  /** Session exited */
  onExit: (exitCode: number | null, signal: string | null) => void;

  /** Error occurred */
  onError: (error: Error) => void;
}

/** Session configuration */
export interface PTYSessionConfig {
  /** Command to run (default: 'claude') */
  readonly command?: string;

  /** Command arguments */
  readonly args?: readonly string[];

  /** Working directory */
  readonly cwd?: string;

  /** Environment variables */
  readonly env?: Record<string, string>;

  /** Initial terminal size */
  readonly size?: TerminalSize;
}

/** Default terminal size */
const DEFAULT_SIZE: TerminalSize = {
  cols: 120,
  rows: 40,
};

/** Default command */
const DEFAULT_COMMAND = 'claude';

/** Session state */
type SessionState = 'created' | 'running' | 'exited';

/**
 * Manages a PTY session for Claude Code.
 *
 * Lifecycle:
 * 1. Create with new PTYSession(config, events)
 * 2. Start with start()
 * 3. Send input with write()
 * 4. Listen for events (onData, onExit, etc.)
 * 5. Cleanup with close()
 */
export class PTYSession {
  readonly id: UUID;
  readonly createdAt: Timestamp;

  private state: SessionState = 'created';
  private readonly config: Required<PTYSessionConfig>;
  private readonly events: Partial<PTYSessionEvents>;

  private process: ReturnType<typeof Bun.spawn> | null = null;
  private exitCode: number | null = null;
  private exitSignal: string | null = null;

  constructor(config: PTYSessionConfig = {}, events: Partial<PTYSessionEvents> = {}) {
    this.id = generateId();
    this.createdAt = now();
    this.events = events;

    this.config = {
      command: config.command ?? DEFAULT_COMMAND,
      args: config.args ?? [],
      cwd: config.cwd ?? process.cwd(),
      env: config.env ?? {},
      size: config.size ?? DEFAULT_SIZE,
    };
  }

  /** Get current session state */
  get sessionState(): SessionState {
    return this.state;
  }

  /** Check if session is running */
  get isRunning(): boolean {
    return this.state === 'running';
  }

  /** Get child process PID (null if not started) */
  get childPid(): number | null {
    return this.process?.pid ?? null;
  }

  /** Get exit code (null if not exited or killed by signal) */
  get processExitCode(): number | null {
    return this.exitCode;
  }

  /** Get exit signal (null if not killed by signal) */
  get processExitSignal(): string | null {
    return this.exitSignal;
  }

  /**
   * Start the PTY session.
   * Throws if already started or closed.
   */
  async start(): Promise<void> {
    if (this.state !== 'created') {
      throw new Error(`Cannot start session in state: ${this.state}`);
    }

    try {
      const cmd = [this.config.command, ...this.config.args];

      this.process = Bun.spawn(cmd, {
        cwd: this.config.cwd,
        env: {
          ...process.env,
          ...this.config.env,
          // Force color output
          FORCE_COLOR: '1',
          // Set TERM for proper terminal behavior
          TERM: process.env['TERM'] ?? 'xterm-256color',
        },
        terminal: {
          cols: this.config.size.cols,
          rows: this.config.size.rows,
          data: (_terminal, data) => {
            this.handleData(data);
          },
        },
      });

      this.state = 'running';

      // Handle process exit
      this.process.exited
        .then((exitCode) => {
          this.handleExit(exitCode, null);
        })
        .catch((error) => {
          this.handleError(error);
        });
    } catch (error) {
      this.handleError(error instanceof Error ? error : new Error(String(error)));
      throw error;
    }
  }

  /**
   * Per-session write serialization (#795). Every write-ish entry point
   * (`write`, `submitInput`) chains its terminal writes onto this promise so
   * only one write sequence is ever in flight — one submit's full multi-step
   * sequence (text, delay, CR) always completes before the next one starts.
   *
   * This is the safety property that removing the exclusive session lock
   * requires: with any attached connection now able to submit input,
   * concurrent submits are possible where previously only one connection
   * could ever write at all. `390898b` allowed exactly this (queued
   * connections could send input too) without adding this serialization, and
   * `588afde` reverted it because "queued resize/answer/input would race the
   * active client's session" — two concurrent `submitInput()` calls could
   * interleave their text/CR writes and corrupt each other's input. This
   * queue is what makes removing the lock safe this time.
   */
  private writeChain: Promise<void> = Promise.resolve();

  /**
   * Queue `fn` to run only after every previously-queued write has settled
   * (whether it succeeded or failed). Returns a promise for `fn`'s own
   * outcome so the caller can still await/catch it; a failure never poisons
   * the chain for writes queued after it.
   */
  private enqueueWrite<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.writeChain.then(fn);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /**
   * Write data to the terminal.
   * Throws synchronously if the session is not currently running. The actual
   * byte write is then queued (see `enqueueWrite`) so a single-shot write can
   * never land in the middle of another connection's in-flight `submitInput`
   * sequence (#795).
   */
  write(data: string | Uint8Array): Promise<void> {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot write to session in state: ${this.state}`);
    }
    return this.enqueueWrite(() => {
      this.termWrite(data);
    });
  }

  /**
   * The single sink for every byte sent to the child's terminal. Routes the
   * input through the optional capture (#627) so a keystroke recording sees the
   * exact bytes, then writes them. Callers must have already checked `running`
   * and must only call this from inside `enqueueWrite` (#795).
   */
  private termWrite(data: string | Uint8Array): void {
    ptyCapture.in(data);
    this.process?.terminal?.write(data);
  }

  /**
   * Write text and submit with Enter key.
   * IMPORTANT: Writes text first, then CR separately after a small delay.
   * This matches how real keyboard input works and is required for Claude Code.
   * Queued (#795) so the text-then-CR sequence always completes atomically
   * with respect to any other queued write (another submit, or a raw write)
   * for this session.
   */
  async submitInput(text: string): Promise<void> {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot write to session in state: ${this.state}`);
    }

    await this.enqueueWrite(async () => {
      // Re-check: the session may have exited while this submit was queued
      // behind another one.
      if (this.state !== 'running' || !this.process?.terminal) {
        throw new Error(`Cannot write to session in state: ${this.state}`);
      }

      // Write the text first
      this.termWrite(text);

      // Small delay to let Claude Code process the text
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Send CR (Enter key) separately
      this.termWrite('\r');
    });
  }

  /**
   * Write text with Enter key (CR) to submit input.
   * This sends the text followed by a carriage return as raw bytes.
   * @deprecated Use submitInput() instead - it works better with Claude Code
   */
  writeLineAsBytes(text: string): void {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot write to session in state: ${this.state}`);
    }

    // Convert text to bytes and append CR (0x0D)
    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);
    const crByte = new Uint8Array([0x0d]); // CR - Enter key

    // Concatenate text + CR
    const combined = new Uint8Array(textBytes.length + 1);
    combined.set(textBytes, 0);
    combined.set(crByte, textBytes.length);

    this.termWrite(combined);
  }

  /**
   * Write text with LF (newline) - matches Muxer's approach.
   */
  writeLineWithLF(text: string): void {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot write to session in state: ${this.state}`);
    }

    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);
    const lfByte = new Uint8Array([0x0a]); // LF - newline

    const combined = new Uint8Array(textBytes.length + 1);
    combined.set(textBytes, 0);
    combined.set(lfByte, textBytes.length);

    this.termWrite(combined);
  }

  /**
   * Write text with CRLF (Windows-style line ending).
   */
  writeLineWithCRLF(text: string): void {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot write to session in state: ${this.state}`);
    }

    const encoder = new TextEncoder();
    const textBytes = encoder.encode(text);
    const crlfBytes = new Uint8Array([0x0d, 0x0a]); // CR + LF

    const combined = new Uint8Array(textBytes.length + 2);
    combined.set(textBytes, 0);
    combined.set(crlfBytes, textBytes.length);

    this.termWrite(combined);
  }

  /**
   * Resize the terminal.
   * Throws if session is not running.
   */
  resize(size: TerminalSize): void {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot resize session in state: ${this.state}`);
    }

    this.process.terminal.resize(size.cols, size.rows);
  }

  /**
   * Send a signal to the process.
   * Common signals: 'SIGINT' (Ctrl+C), 'SIGTERM', 'SIGKILL'
   */
  signal(sig: 'SIGINT' | 'SIGTERM' | 'SIGKILL'): void {
    if (this.state !== 'running' || !this.process) {
      throw new Error(`Cannot signal session in state: ${this.state}`);
    }

    this.process.kill(sig);
  }

  /**
   * Close the session gracefully.
   * Sends SIGTERM, waits for exit, then SIGKILL if needed.
   */
  async close(timeoutMs = 5000): Promise<void> {
    if (this.state !== 'running' || !this.process) {
      return; // Already closed or never started
    }

    // Try graceful shutdown first
    this.process.kill('SIGTERM');

    // Wait for exit with timeout
    const exitPromise = this.process.exited;
    const timeoutPromise = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), timeoutMs),
    );

    const result = await Promise.race([exitPromise, timeoutPromise]);

    // If not exited, force kill
    if (result === null && this.state === 'running') {
      this.process.kill('SIGKILL');
      await this.process.exited;
    }

    // Cleanup terminal
    if (this.process.terminal) {
      this.process.terminal.close();
    }
  }

  /** Text decoder with streaming mode to handle multi-byte UTF-8 across chunks */
  private textDecoder = new TextDecoder('utf-8', { fatal: false });

  /** Handle data from terminal */
  private handleData(data: Uint8Array): void {
    // #627: record the rendered frame for the optional keystroke-capture diagnostic
    // (no-op unless REMI_PTY_CAPTURE is set), before any decode/processing.
    ptyCapture.out(data);
    // Emit raw bytes first for direct terminal pass-through (no decode/encode).
    // Isolate so a throw here does not prevent text processing from running.
    try {
      this.events.onRawData?.(data);
    } catch (err) {
      this.events.onError?.(err instanceof Error ? err : new Error(String(err)));
    }
    // Then decode for text processing (stream: true handles split UTF-8)
    const text = this.textDecoder.decode(data, { stream: true });
    if (text.length > 0) {
      this.events.onData?.(text);
    }
  }

  /** Handle process exit */
  private handleExit(exitCode: number, signal: string | null): void {
    // Flush any remaining bytes buffered by the streaming TextDecoder
    const remaining = this.textDecoder.decode();
    if (remaining.length > 0) {
      this.events.onData?.(remaining);
    }
    this.state = 'exited';
    this.exitCode = exitCode;
    this.exitSignal = signal;
    this.events.onExit?.(exitCode, signal);
  }

  /** Handle errors */
  private handleError(error: Error): void {
    this.events.onError?.(error);
  }
}
