/**
 * Byte-level scanner for Ctrl+B d detach sequence.
 *
 * Processes raw input buffers and detects the two-key sequence Ctrl+B
 * followed by 'd'. Handles edge cases like Ctrl+B at chunk boundaries
 * and lone Ctrl+B timeout.
 *
 * Supports both legacy raw byte (0x02) and kitty keyboard protocol
 * encoding (ESC[98;5u) for Ctrl+B, since Claude Code enables the kitty
 * protocol on the terminal.
 */

const CTRL_B = 0x02;
const DEFAULT_TIMEOUT_MS = 1000;

// Kitty keyboard protocol: Ctrl+B = ESC[98;5u = bytes 1b 5b 39 38 3b 35 75
const KITTY_CTRL_B = Buffer.from([0x1b, 0x5b, 0x39, 0x38, 0x3b, 0x35, 0x75]);

export interface DetachScannerOptions {
  /** Called when Ctrl+B d is detected. */
  readonly onDetach: () => void;
  /** Called with data that should be forwarded (non-detach bytes). */
  readonly onData: (data: Buffer) => void;
  /** Timeout in ms after a lone Ctrl+B or ESC before forwarding it. Default: 1000 */
  readonly timeoutMs?: number | undefined;
}

export class DetachScanner {
  private ctrlBPending = false;
  private ctrlBTimer: ReturnType<typeof setTimeout> | null = null;
  // Buffer for accumulating a partial kitty escape sequence across chunks
  private escBuffer: number[] = [];
  private escTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onDetach: () => void;
  private readonly onData: (data: Buffer) => void;
  private readonly timeoutMs: number;
  // Store the original bytes (legacy 0x02 or kitty sequence) that triggered
  // ctrlBPending so we can forward them if 'd' does not follow within the timeout
  private ctrlBBytes: Buffer = Buffer.from([CTRL_B]);
  private detached = false;

  constructor(opts: DetachScannerOptions) {
    this.onDetach = opts.onDetach;
    this.onData = opts.onData;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Clear any pending Ctrl+B timer, flushing buffered bytes if needed. */
  private clearCtrlBPending(flush: boolean): void {
    if (this.ctrlBTimer) {
      clearTimeout(this.ctrlBTimer);
      this.ctrlBTimer = null;
    }
    if (flush && this.ctrlBPending) {
      this.onData(Buffer.from(this.ctrlBBytes));
    }
    this.ctrlBPending = false;
  }

  /** Clear any pending ESC buffer timer, flushing accumulated bytes if needed. */
  private clearEscBuffer(flush: boolean): void {
    if (this.escTimer) {
      clearTimeout(this.escTimer);
      this.escTimer = null;
    }
    if (flush && this.escBuffer.length > 0) {
      this.onData(Buffer.from(this.escBuffer));
    }
    this.escBuffer = [];
  }

  /**
   * Process an incoming data buffer.
   * Scans for Ctrl+B d sequences and forwards all other data.
   */
  write(chunk: Buffer): void {
    if (this.detached) return;

    for (let i = 0; i < chunk.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounds checked by loop condition
      const byte = chunk[i]!;

      // If we're accumulating a potential kitty escape sequence
      if (this.escBuffer.length > 0) {
        this.escBuffer.push(byte);

        // Check if we've matched the full kitty Ctrl+B sequence
        if (this.escBuffer.length === KITTY_CTRL_B.length) {
          const match = this.escBuffer.every((b, idx) => b === KITTY_CTRL_B[idx]);
          if (match) {
            // Matched kitty Ctrl+B; clear ESC timer and enter Ctrl+B pending state
            this.clearEscBuffer(false);
            this.clearCtrlBPending(true);
            this.ctrlBBytes = KITTY_CTRL_B;
            this.ctrlBPending = true;
            this.ctrlBTimer = setTimeout(() => {
              this.ctrlBPending = false;
              this.ctrlBTimer = null;
              this.onData(Buffer.from(this.ctrlBBytes));
            }, this.timeoutMs);
          } else {
            // Not a kitty Ctrl+B; forward accumulated bytes
            this.clearEscBuffer(true);
          }
          continue;
        }

        // Check if the partial sequence still could match kitty Ctrl+B
        const stillMatches = this.escBuffer.every(
          (b, idx) => idx < KITTY_CTRL_B.length && b === KITTY_CTRL_B[idx],
        );
        if (!stillMatches) {
          // Mismatch; forward accumulated bytes
          this.clearEscBuffer(true);
        }
        continue;
      }

      if (this.ctrlBPending) {
        this.clearCtrlBPending(false);

        if (byte === 0x64) {
          // 'd' after Ctrl+B: detach
          this.detached = true;
          this.onDetach();
          return;
        }

        // Not a detach sequence: forward buffered Ctrl+B and this byte
        this.onData(Buffer.from(this.ctrlBBytes));
        this.onData(Buffer.from([byte]));
        continue;
      }

      if (byte === CTRL_B) {
        this.ctrlBBytes = Buffer.from([CTRL_B]);
        this.ctrlBPending = true;
        this.ctrlBTimer = setTimeout(() => {
          this.ctrlBPending = false;
          this.ctrlBTimer = null;
          this.onData(Buffer.from(this.ctrlBBytes));
        }, this.timeoutMs);
        continue;
      }

      // Start of ESC sequence: could be kitty Ctrl+B.
      // Flush any pending Ctrl+B first since this is a new sequence.
      if (byte === 0x1b) {
        this.clearCtrlBPending(true);
        this.escBuffer = [byte];
        this.escTimer = setTimeout(() => {
          this.escTimer = null;
          if (this.escBuffer.length > 0) {
            this.onData(Buffer.from(this.escBuffer));
            this.escBuffer = [];
          }
        }, this.timeoutMs);
        continue;
      }

      // Scan ahead for the next special byte in this chunk
      let end = i + 1;
      while (end < chunk.length && chunk[end] !== CTRL_B && chunk[end] !== 0x1b) {
        end++;
      }
      // Forward the normal bytes as a batch
      this.onData(chunk.subarray(i, end));
      i = end - 1; // loop increment will advance to `end`
    }
  }

  /** Clean up any pending timers and flush buffered bytes. */
  destroy(): void {
    this.clearCtrlBPending(false);
    this.clearEscBuffer(true);
  }
}
