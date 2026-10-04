/**
 * The data channel (ADR 0034 section 7).
 *
 * Counters are the nonces, the receiver accepts exactly `last + 1`, and every
 * failure closes the channel for good. Sends go through one promise chain, so
 * a slow encryption of frame `n` can never let frame `n + 1` leave first, and
 * a frame whose encryption or emission fails is never skipped: the channel
 * closes instead.
 *
 * `bye()` sends an authenticated end of stream: a counter-checked frame only the
 * key holder can make. A transport close with no BYE before it is reported as
 * `unclean` by `transportClosed()`, so a relay that drops the tail and closes
 * cannot make the truncation look like a clean ending, and a relay that forges a
 * close cannot forge the BYE.
 */

import { zero } from './bytes.ts';
import {
  CLOSE_NORMAL,
  DIR_C2H,
  DIR_H2C,
  type Direction,
  MAX_COUNTER,
  MAX_PENDING_SENDS,
  MAX_PLAINTEXT,
  TYPE_BYE,
  TYPE_DATA,
} from './constants.ts';
import { decodeDataFrame, encodeDataFrame } from './envelope.ts';
import { FAILURE_CLOSE, RelayError, asRelayError } from './errors.ts';
import { type SealFn, aeadKey, aeadOpen, aeadSeal } from './primitives.ts';

/** The transport a channel writes to. `close` is the WebSocket close. */
export interface ChannelIO {
  emit(frame: Uint8Array): void | Promise<void>;
  close(code: number, reason: string): void;
}

export interface ChannelInit {
  /** Raw 32-byte keys; they are imported and then overwritten. */
  readonly sendKey: Uint8Array;
  readonly recvKey: Uint8Array;
  /** The direction of what THIS side sends. */
  readonly direction: Direction;
  readonly io: ChannelIO;
  /** Overridable so a test can slow one real encryption down; production uses the default. */
  readonly seal?: SealFn;
  /** First counters to use and expect (1 after the handshake); tests start near the limit. */
  readonly nextSend?: number;
  readonly nextRecv?: number;
}

/**
 * How the inbound stream ended, given by `transportClosed()`:
 * `clean` (the peer's BYE arrived first), `unclean` (the transport closed with no
 * BYE: the tail may be truncated) or `failed` (a check failed earlier).
 */
export type StreamEnd = 'clean' | 'unclean' | 'failed';

export class Channel {
  private sendKey: CryptoKey | null;
  private recvKey: CryptoKey | null;
  private sendTail: Promise<void> = Promise.resolve();
  private recvTail: Promise<void> = Promise.resolve();
  private pending = 0;
  private dead = false;
  private failed = false;
  private sendEnded = false;
  private ended = false;

  private readonly direction: Direction;
  private readonly io: ChannelIO;
  private readonly seal: SealFn;
  private nextSend: number;
  private nextRecv: number;

  // No parameter properties: the web build compiles this file with `erasableSyntaxOnly`.
  private constructor(
    sendKey: CryptoKey,
    recvKey: CryptoKey,
    direction: Direction,
    io: ChannelIO,
    seal: SealFn,
    nextSend: number,
    nextRecv: number,
  ) {
    this.sendKey = sendKey;
    this.recvKey = recvKey;
    this.direction = direction;
    this.io = io;
    this.seal = seal;
    this.nextSend = nextSend;
    this.nextRecv = nextRecv;
  }

  static async create(init: ChannelInit): Promise<Channel> {
    try {
      return new Channel(
        await aeadKey(init.sendKey),
        await aeadKey(init.recvKey),
        init.direction,
        init.io,
        init.seal ?? aeadSeal,
        init.nextSend ?? 1,
        init.nextRecv ?? 1,
      );
    } finally {
      zero(init.sendKey, init.recvKey);
    }
  }

  get closed(): boolean {
    return this.dead;
  }

  /** True once the peer's authenticated BYE has been received. */
  get peerEnded(): boolean {
    return this.ended;
  }

  /** Queue one message. Resolves once its frame has been emitted. */
  send(plaintext: Uint8Array): Promise<void> {
    if (this.sendEnded) return Promise.reject(new RelayError('ENDED'));
    if (plaintext.length === 0) return Promise.reject(new RelayError('MALFORMED'));
    if (plaintext.length > MAX_PLAINTEXT) return Promise.reject(new RelayError('OVERSIZE'));
    return this.enqueue(TYPE_DATA, plaintext);
  }

  /**
   * Queue the authenticated end of this direction behind everything already queued.
   * Nothing is sent after it. The caller closes the transport once the peer's BYE has
   * arrived (or it gives up waiting): the receiving side stays open until then.
   */
  bye(): Promise<void> {
    if (this.sendEnded) return Promise.reject(new RelayError('ENDED'));
    return this.enqueue(TYPE_BYE, new Uint8Array(0));
  }

  private enqueue(type: number, plaintext: Uint8Array): Promise<void> {
    if (this.pending >= MAX_PENDING_SENDS) return Promise.reject(new RelayError('QUEUE_FULL'));
    if (this.nextSend > MAX_COUNTER) {
      this.fail();
      return Promise.reject(new RelayError('COUNTER_LIMIT'));
    }
    const counter = this.nextSend++;
    if (type === TYPE_BYE) this.sendEnded = true;
    // The caller may reuse its buffer before the queued encryption runs.
    const data = plaintext.slice();
    this.pending++;
    const job = this.sendTail.then(async () => {
      try {
        if (this.sendKey === null) throw new RelayError('CLOSED');
        const ciphertext = await this.seal(this.sendKey, type, this.direction, counter, data);
        await this.io.emit(encodeDataFrame(counter, ciphertext, type));
      } catch (e) {
        this.fail();
        throw asRelayError(e);
      } finally {
        this.pending--;
      }
    });
    this.sendTail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  /**
   * Verify and open one incoming frame. Frames are processed in arrival order.
   * Resolves to the data, or to `null` for the peer's authenticated BYE.
   */
  receive(frame: Uint8Array | string): Promise<Uint8Array | null> {
    const copy = typeof frame === 'string' ? frame : frame.slice();
    const job = this.recvTail.then(() => this.openOne(copy));
    this.recvTail = job.then(
      () => undefined,
      () => undefined,
    );
    return job;
  }

  /** A deliberate local close: not a failure, so it does not use the failure reason. */
  close(): void {
    if (this.dead) return;
    this.drop();
    this.io.close(CLOSE_NORMAL, FAILURE_CLOSE.reason);
  }

  /**
   * The transport has closed (the caller saw the socket close, whatever the code).
   * Says whether the inbound stream ended cleanly, and ends the channel. Idempotent.
   */
  transportClosed(): StreamEnd {
    const verdict: StreamEnd = this.failed ? 'failed' : this.ended ? 'clean' : 'unclean';
    this.drop();
    return verdict;
  }

  private async openOne(frame: Uint8Array | string): Promise<Uint8Array | null> {
    try {
      if (this.recvKey === null) throw new RelayError('CLOSED');
      const { type, counter, ciphertext } = decodeDataFrame(frame);
      if (this.ended) throw new RelayError('ENDED');
      if (counter !== this.nextRecv) throw new RelayError('COUNTER');
      const peer = this.direction === DIR_C2H ? DIR_H2C : DIR_C2H;
      const plaintext = await aeadOpen(this.recvKey, type, peer, counter, ciphertext);
      this.nextRecv = counter + 1;
      if (type === TYPE_BYE) {
        this.ended = true;
        return null;
      }
      return plaintext;
    } catch (e) {
      this.fail();
      throw asRelayError(e);
    }
  }

  private drop(): void {
    this.dead = true;
    this.sendKey = null;
    this.recvKey = null;
  }

  /** Every failure closes the same way, once. */
  private fail(): void {
    if (this.dead) return;
    this.failed = true;
    this.drop();
    this.io.close(FAILURE_CLOSE.code, FAILURE_CLOSE.reason);
  }
}
