/** Standalone bounded native lifetime (#1625); no authority, route or automatic retry. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  TERMINAL_VIEW_LIMITS,
  type TerminalViewMessage,
  type TerminalViewRequest,
  encodeTerminalViewFrame,
} from '@remi/shared';

export interface NativeTerminalTransport {
  readonly readyState: number;
  getBufferedAmount(): number;
  send(text: string): unknown;
  ping?(nonce: Uint8Array): unknown;
}
export interface OwnedTerminalSend {
  readonly message: Exclude<TerminalViewMessage, TerminalViewRequest>;
  release(): void;
  quarantine(): void;
}
export type TerminalSendOutcome = 'sent' | 'pending' | 'unavailable';
type Deliver = (frame: OwnedTerminalSend) => TerminalSendOutcome;

export class TerminalSendSlot {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private operationPending = false;
  private frame: OwnedTerminalSend | null = null;
  private retired = false;
  private sending = false;
  private receipt: Buffer | null = null;
  private receiptConfirmed = false;

  /** Trusted listener provenance, never a client claim. TLS plaintext zero is not disposal (#1646). */
  constructor(
    private readonly transport: NativeTerminalTransport,
    private readonly completion: 'plain-ws' | 'tls-receipt',
  ) {}

  get busy(): boolean {
    return this.operationPending || this.frame !== null;
  }

  /** Content-free job only. The caller's synchronous original-grant guard must enclose deliver. */
  schedule(operation: (deliver: Deliver) => undefined): boolean {
    if (
      (this.completion !== 'plain-ws' && this.completion !== 'tls-receipt') ||
      (this.completion === 'tls-receipt' && typeof this.transport.ping !== 'function')
    )
      return false;
    if (this.retired || this.busy) return false;
    this.operationPending = true;
    // Native message callbacks are automatically corked. Construct/send in a later turn.
    this.timer = setTimeout(() => {
      this.timer = undefined;
      let active = true;
      let used = false;
      try {
        if (!this.retired)
          operation((frame) => {
            if (!active || used || this.retired) {
              // The supplied owner may alias an entered frame. Never free it as unsent.
              const pending = this.frame;
              this.nativeClosed();
              if (frame !== pending) frame.quarantine();
              return 'unavailable';
            }
            used = true;
            return this.deliver(frame);
          });
      } catch {
        this.nativeClosed(); // Unknown completion never frees pending accounting.
      } finally {
        active = false;
        this.operationPending = false;
      }
    }, 0);
    this.timer.unref();
    return true;
  }

  private deliver(frame: OwnedTerminalSend): TerminalSendOutcome {
    let text: string;
    let receipt: Buffer | null = null;
    try {
      if (
        this.transport.readyState !== WebSocket.OPEN ||
        this.transport.getBufferedAmount() !== 0
      ) {
        frame.release();
        return 'unavailable';
      }
      text = encodeTerminalViewFrame(frame.message);
      if (this.completion === 'tls-receipt') {
        // A 16-byte server ping adds two framing bytes. Keep both frames inside
        // the existing native capacity rather than adding a second content slot.
        if (Buffer.byteLength(text) > TERMINAL_VIEW_LIMITS.frameBytes - 18) {
          frame.release();
          return 'unavailable';
        }
        receipt = randomBytes(16);
      }
    } catch {
      frame.release(); // Encoding/preflight failure has made no native call.
      return 'unavailable';
    }
    this.frame = frame;
    this.receipt = receipt;
    this.receiptConfirmed = false;
    let status: unknown;
    this.sending = true;
    try {
      status = this.transport.send(text);
      if (
        receipt &&
        this.frame === frame &&
        typeof status === 'number' &&
        (status > 0 || status === -1)
      ) {
        const ping = this.transport.ping;
        if (!ping) throw new Error('Terminal native receipt unavailable');
        // The original grant effect encloses both ordered native writes.
        const pingStatus = ping.call(this.transport, receipt);
        if (typeof pingStatus !== 'number' || (pingStatus <= 0 && pingStatus !== -1)) {
          this.nativeClosed();
          return 'unavailable';
        }
      }
    } catch {
      this.nativeClosed();
      return 'unavailable';
    } finally {
      this.sending = false;
    }
    if (this.frame !== frame) return 'unavailable'; // Synchronous native close already quarantined.
    try {
      if (this.transport.readyState !== WebSocket.OPEN) {
        this.nativeClosed();
        return 'unavailable';
      }
      const buffered = this.transport.getBufferedAmount();
      if (typeof status === 'number' && (status > 0 || status === -1)) {
        if (buffered === 0) {
          if (receipt) return 'pending'; // TLS may still own ciphertext despite plaintext zero.
          this.releaseFrame();
          return 'sent'; // Native acceptance only, never application receipt.
        }
        // Server frames add at most a ten-byte unmasked WebSocket header.
        if (buffered > 0 && buffered <= TERMINAL_VIEW_LIMITS.frameBytes + 10) return 'pending';
      } else if (status === 0 && buffered === 0) {
        this.releaseFrame();
        return 'unavailable';
      }
    } catch {
      // The native call entered; even a failed buffered-amount read has unknown completion.
    }
    this.nativeClosed();
    return 'unavailable';
  }

  /** Called from the real native drain callback, never from logical disconnect. */
  nativeDrained(): void {
    if (this.sending || !this.frame) return;
    try {
      if (this.transport.readyState !== WebSocket.OPEN) {
        this.nativeClosed();
        return;
      }
      if (this.transport.getBufferedAmount() !== 0) return;
    } catch {
      this.nativeClosed();
      return;
    }
    if (this.receipt && !this.receiptConfirmed) return;
    this.releaseFrame();
  }

  /** Only the actual native pong callback: no domain ACK, timer or logical disconnect. */
  nativePong(data: Uint8Array): void {
    if (
      this.sending ||
      !this.frame ||
      !this.receipt ||
      !(data instanceof Uint8Array) ||
      data.byteLength !== 16 ||
      !timingSafeEqual(data, this.receipt)
    )
      return;
    this.receiptConfirmed = true;
    this.nativeDrained();
  }

  private releaseFrame(): void {
    const frame = this.frame;
    this.frame = null;
    this.receipt = null;
    this.receiptConfirmed = false;
    frame?.release();
  }

  /** Closed wrappers can still flush bytes. Drop JS content and keep the fixed charge. */
  nativeClosed(): void {
    this.retire();
    const frame = this.frame;
    this.frame = null;
    this.receipt = null;
    this.receiptConfirmed = false;
    frame?.quarantine();
  }

  /** Cancels unsent work. Pending native data keeps its slot until drain or quarantine. */
  retire(): void {
    this.retired = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.operationPending = false;
  }
}
