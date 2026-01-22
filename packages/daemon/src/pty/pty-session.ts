/**
 * PTY Session - Manages a single Claude Code terminal session.
 *
 * Uses Bun's native Terminal API (Bun.spawn with terminal option)
 * to create and manage a pseudo-terminal for Claude Code.
 */

import { generateId, now } from '@remi/shared';
import type { AgentStatus, Timestamp, UUID } from '@remi/shared';

/** Terminal dimensions */
export interface TerminalSize {
  readonly cols: number;
  readonly rows: number;
}

/** Events emitted by PTY session */
export interface PTYSessionEvents {
  /** Raw output data from terminal */
  onData: (data: string) => void;

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
   * Write data to the terminal.
   * Throws if session is not running.
   */
  write(data: string | Uint8Array): void {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot write to session in state: ${this.state}`);
    }

    if (typeof data === 'string') {
      this.process.terminal.write(data);
    } else {
      this.process.terminal.write(data);
    }
  }

  /**
   * Write text and submit with Enter key.
   * IMPORTANT: Writes text first, then CR separately after a small delay.
   * This matches how real keyboard input works and is required for Claude Code.
   */
  async submitInput(text: string): Promise<void> {
    if (this.state !== 'running' || !this.process?.terminal) {
      throw new Error(`Cannot write to session in state: ${this.state}`);
    }

    // Write the text first
    this.process.terminal.write(text);

    // Small delay to let Claude Code process the text
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Send CR (Enter key) separately
    this.process.terminal.write('\r');
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

    this.process.terminal.write(combined);
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

    this.process.terminal.write(combined);
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

    this.process.terminal.write(combined);
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

  /** Handle data from terminal */
  private handleData(data: Uint8Array): void {
    // Convert to string
    const text = new TextDecoder().decode(data);
    this.events.onData?.(text);
  }

  /** Handle process exit */
  private handleExit(exitCode: number, signal: string | null): void {
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
