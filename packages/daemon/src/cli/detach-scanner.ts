/**
 * Byte-level scanner for Ctrl+B d detach sequence.
 *
 * Processes raw input buffers and detects the two-key sequence Ctrl+B
 * followed by 'd'. Handles edge cases like Ctrl+B at chunk boundaries
 * and lone Ctrl+B timeout.
 */

const CTRL_B = 0x02;
const DEFAULT_TIMEOUT_MS = 1000;

export interface DetachScannerOptions {
  /** Called when Ctrl+B d is detected. */
  readonly onDetach: () => void;
  /** Called with data that should be forwarded (non-detach bytes). */
  readonly onData: (data: Buffer) => void;
  /** Timeout in ms after a lone Ctrl+B before forwarding it. Default: 1000 */
  readonly timeoutMs?: number | undefined;
}

export class DetachScanner {
  private ctrlBPending = false;
  private ctrlBTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly onDetach: () => void;
  private readonly onData: (data: Buffer) => void;
  private readonly timeoutMs: number;

  constructor(opts: DetachScannerOptions) {
    this.onDetach = opts.onDetach;
    this.onData = opts.onData;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /**
   * Process an incoming data buffer.
   * Scans for Ctrl+B d sequences and forwards all other data.
   */
  write(chunk: Buffer): void {
    for (let i = 0; i < chunk.length; i++) {
      // biome-ignore lint/style/noNonNullAssertion: bounds checked by loop condition
      const byte = chunk[i]!;

      if (this.ctrlBPending) {
        this.ctrlBPending = false;
        if (this.ctrlBTimer) {
          clearTimeout(this.ctrlBTimer);
          this.ctrlBTimer = null;
        }

        if (byte === 0x64) {
          // 'd' after Ctrl+B: detach
          this.onDetach();
          return;
        }

        // Not a detach sequence: forward buffered Ctrl+B and this byte
        this.onData(Buffer.from([CTRL_B]));
        this.onData(Buffer.from([byte]));
        continue;
      }

      if (byte === CTRL_B) {
        this.ctrlBPending = true;
        this.ctrlBTimer = setTimeout(() => {
          this.ctrlBPending = false;
          this.ctrlBTimer = null;
          this.onData(Buffer.from([CTRL_B]));
        }, this.timeoutMs);
        continue;
      }

      // Scan ahead for the next Ctrl+B in this chunk
      let end = i + 1;
      while (end < chunk.length && chunk[end] !== CTRL_B) {
        end++;
      }
      // Forward the normal bytes as a batch
      this.onData(chunk.subarray(i, end));
      i = end - 1; // loop increment will advance to `end`
    }
  }

  /** Clean up any pending timer. */
  destroy(): void {
    if (this.ctrlBTimer) {
      clearTimeout(this.ctrlBTimer);
      this.ctrlBTimer = null;
    }
    this.ctrlBPending = false;
  }
}
