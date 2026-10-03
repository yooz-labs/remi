/**
 * RFC 6455 client-side framing (epic #1175, phase 1 #1181).
 *
 * Codex's app-server speaks WebSocket over a unix socket. Bun 1.3.11 (the
 * version CI and the release build pin) has no `ws+unix` client and the `ws`
 * package opens TCP under Bun, so the client is a small hand-rolled one over
 * `node:net` (ADR 0033). This file is the pure part: it encodes the frames a
 * client sends (always final, always masked) and parses the frames a server
 * sends (never masked). It does no I/O and no message reassembly.
 *
 * No extension is ever negotiated, so a set RSV bit is a protocol violation.
 */
import { createHash } from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_OPCODE = {
  continuation: 0x0,
  text: 0x1,
  binary: 0x2,
  close: 0x8,
  ping: 0x9,
  pong: 0xa,
} as const;

/** Default cap on one frame's payload, and on a reassembled message: 32 MiB. */
export const WS_MAX_PAYLOAD_BYTES = 32 * 1024 * 1024;

/** The peer broke the framing rules; the connection must be closed with 1002. */
export class WsProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WsProtocolError';
  }
}

export interface WsFrame {
  fin: boolean;
  opcode: number;
  payload: Uint8Array;
}

/** `Sec-WebSocket-Accept` for a client key: base64(sha1(key + GUID)). */
export function computeAcceptKey(secWebSocketKey: string): string {
  return createHash('sha1')
    .update(secWebSocketKey + WS_GUID)
    .digest('base64');
}

/**
 * One final, masked client frame. The mask is random unless given (tests pass
 * one to pin the RFC's byte vectors).
 */
export function encodeClientFrame(
  opcode: number,
  payload: Uint8Array,
  mask?: Uint8Array,
): Uint8Array {
  const key = mask ?? crypto.getRandomValues(new Uint8Array(4));
  if (key.length !== 4) throw new RangeError('a WebSocket mask is 4 bytes');
  const length = payload.length;
  if (opcode >= 0x8 && length > 125)
    throw new RangeError('a control frame carries at most 125 bytes');
  const extra = length < 126 ? 0 : length <= 0xffff ? 2 : 8;
  const out = new Uint8Array(2 + extra + 4 + length);
  const view = new DataView(out.buffer);
  out[0] = 0x80 | (opcode & 0x0f);
  if (extra === 0) {
    out[1] = 0x80 | length;
  } else if (extra === 2) {
    out[1] = 0x80 | 126;
    view.setUint16(2, length);
  } else {
    out[1] = 0x80 | 127;
    view.setBigUint64(2, BigInt(length));
  }
  const body = 2 + extra + 4;
  out.set(key, 2 + extra);
  for (let i = 0; i < length; i++) out[body + i] = (payload[i] as number) ^ (key[i & 3] as number);
  return out;
}

interface FrameHeader {
  fin: boolean;
  opcode: number;
  headerBytes: number;
  payloadBytes: number;
}

const KNOWN_OPCODES = new Set<number>(Object.values(WS_OPCODE));

/**
 * Incremental parser for server-to-client frames. Feed it socket chunks of any
 * size; it returns the frames completed so far. It throws {@link
 * WsProtocolError} on an RSV bit, a masked frame, an unknown opcode, a control
 * frame over 125 bytes or fragmented, or a payload over the limit (checked from
 * the header, before the payload is buffered).
 *
 * A violation discards the frames the same chunk had already completed: `push`
 * throws instead of returning them. That is deliberate and tested: the caller
 * closes the connection with 1002 on the throw, a frame that came before a
 * violation on a connection that is being failed has no consumer worth
 * serving, and the alternative (return the frames and throw on the next call)
 * would leave a violation undetected until the peer sent something more.
 */
export class WsFrameParser {
  private readonly maxPayloadBytes: number;
  private chunks: Uint8Array[] = [];
  private buffered = 0;
  private header: FrameHeader | null = null;

  constructor(opts: { maxPayloadBytes?: number } = {}) {
    this.maxPayloadBytes = opts.maxPayloadBytes ?? WS_MAX_PAYLOAD_BYTES;
  }

  push(chunk: Uint8Array): WsFrame[] {
    if (chunk.length > 0) {
      this.chunks.push(chunk);
      this.buffered += chunk.length;
    }
    const frames: WsFrame[] = [];
    for (;;) {
      this.header ??= this.readHeader();
      const header = this.header;
      if (!header || this.buffered < header.headerBytes + header.payloadBytes) return frames;
      const bytes = this.take(header.headerBytes + header.payloadBytes);
      this.header = null;
      frames.push({
        fin: header.fin,
        opcode: header.opcode,
        payload: bytes.subarray(header.headerBytes),
      });
    }
  }

  /** The header of the frame at the front of the buffer, or null while it is incomplete. */
  private readHeader(): FrameHeader | null {
    if (this.buffered < 2) return null;
    const head = this.peek(Math.min(this.buffered, 10));
    const b0 = head[0] as number;
    const b1 = head[1] as number;
    const opcode = b0 & 0x0f;
    if (b0 & 0x70) throw new WsProtocolError('RSV bit set with no extension negotiated');
    if (!KNOWN_OPCODES.has(opcode)) throw new WsProtocolError(`unknown opcode ${opcode}`);
    if (b1 & 0x80) throw new WsProtocolError('server frame is masked');
    const fin = (b0 & 0x80) !== 0;
    const short = b1 & 0x7f;
    const isControl = opcode >= 0x8;
    if (isControl && (short > 125 || !fin)) {
      throw new WsProtocolError('control frame is fragmented or longer than 125 bytes');
    }
    const extra = short < 126 ? 0 : short === 126 ? 2 : 8;
    if (head.length < 2 + extra) return null;
    const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
    const declared = extra === 0 ? short : extra === 2 ? view.getUint16(2) : view.getBigUint64(2);
    if (declared > this.maxPayloadBytes) {
      throw new WsProtocolError(`frame payload of ${declared} bytes is over the limit`);
    }
    return { fin, opcode, headerBytes: 2 + extra, payloadBytes: Number(declared) };
  }

  /** The first `n` buffered bytes, without consuming them. */
  private peek(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    for (const chunk of this.chunks) {
      if (filled === n) break;
      const part = chunk.subarray(0, n - filled);
      out.set(part, filled);
      filled += part.length;
    }
    return out;
  }

  /** Remove and return the first `n` buffered bytes as one array. */
  private take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let filled = 0;
    while (filled < n) {
      const chunk = this.chunks[0] as Uint8Array;
      const want = n - filled;
      if (chunk.length <= want) {
        out.set(chunk, filled);
        filled += chunk.length;
        this.chunks.shift();
      } else {
        out.set(chunk.subarray(0, want), filled);
        filled += want;
        this.chunks[0] = chunk.subarray(want);
      }
    }
    this.buffered -= n;
    return out;
  }
}
