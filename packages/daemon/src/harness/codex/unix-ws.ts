/**
 * A WebSocket client over a unix socket (epic #1175, phase 1 #1181): the
 * transport to Codex's app-server, hand-rolled over `node:net` because Bun
 * 1.3.11 has no `ws+unix` client (ADR 0033). It does the HTTP upgrade, answers
 * pings, reassembles fragmented messages, and runs the close handshake.
 *
 * Policy (the plan's DECIDED POLICY, #1181): no extensions and no `Origin` are
 * offered, `Host: localhost`, path `/`; text frames only (a binary message is
 * dropped with a log); a payload over 32 MiB, or any other framing violation,
 * closes the connection with 1002; the read loop never throws.
 *
 * Frames that arrive in the same chunk as the `101` response reach
 * `onMessage` before the returned promise's continuation runs, so a handler
 * must not assume it already holds the connection.
 */
import { randomBytes } from 'node:crypto';
import { Socket } from 'node:net';
import {
  WS_MAX_PAYLOAD_BYTES,
  WS_OPCODE,
  WsFrameParser,
  WsProtocolError,
  computeAcceptKey,
  encodeClientFrame,
} from './ws-frames.ts';

export interface WsConnection {
  /** Send one text message. Throws when the connection is not open. */
  send(text: string): void;
  /** Send a ping (at most 125 bytes). Throws when the connection is not open. */
  ping(data?: string): void;
  /** Start the close handshake with `code` (1000 by default); `onClose` fires when it ends. */
  close(code?: number): void;
  readonly isOpen: boolean;
}

export interface WsCloseInfo {
  /** The status code of the close frame that ended the connection; undefined if none was exchanged. */
  code: number | undefined;
  reason: string;
  /** True when both sides sent a close frame. */
  clean: boolean;
}

export interface WsHandlers {
  onMessage(text: string): void;
  /** A pong arrived (the answer to a ping, or unsolicited). */
  onPong?(): void;
  onClose(info: WsCloseInfo): void;
}

export interface UnixWsOptions {
  /** The `Host` header; the default is `localhost`. */
  host?: string;
  /** The request path; the default is `/`. */
  path?: string;
  /** Time from the start of the attempt (connecting included) to the `101` response: 5000 ms by default. */
  handshakeTimeoutMs?: number;
  /** Aborts an attempt that has not reached the `101` yet. It does nothing to an open connection. */
  signal?: AbortSignal;
  maxPayloadBytes?: number;
  /** How long to wait for the peer's close frame before dropping the socket: 1000 ms by default. */
  closeTimeoutMs?: number;
  log?: (message: string) => void;
}

const MAX_HEADER_BYTES = 16 * 1024;
const NORMAL_CLOSURE = 1000;
const PROTOCOL_ERROR = 1002;
const INVALID_PAYLOAD = 1007;
/** A close reason is at most 123 bytes: a control frame carries 125, less the 2-byte code. */
const MAX_REASON_BYTES = 123;

/**
 * Whether `code` may appear in a close frame (RFC 6455 section 7.4.1, with the IANA registrations
 * 1012 to 1014): 1000 to 1003, 1007 to 1014 and 3000 to 4999. 1004 is reserved, 1005, 1006 and
 * 1015 must never be sent, and 0 to 999 and 1016 to 2999 are unassigned.
 */
export function isValidCloseCode(code: number): boolean {
  return (
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1003) ||
      (code >= 1007 && code <= 1014) ||
      (code >= 3000 && code <= 4999))
  );
}

/**
 * Text from the peer (or built from it) in a log line: control characters would let it forge lines
 * or move the cursor, so it is cut to `max` characters and quoted with JSON escapes.
 */
export function quoteForLog(text: string, max = 120): string {
  return JSON.stringify(text.length > max ? `${text.slice(0, max)}...` : text);
}

/** `reason` as UTF-8, cut at a code point boundary so it fits a close frame. */
export function encodeCloseReason(reason: string): Uint8Array {
  const bytes = new TextEncoder().encode(reason);
  if (bytes.length <= MAX_REASON_BYTES) return bytes;
  let end = MAX_REASON_BYTES;
  // A continuation byte is 10xxxxxx; step back to the start of the character that was cut.
  while (end > 0 && ((bytes[end] as number) & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

/** The status line and headers of the upgrade response, if complete and acceptable; else an error. */
function checkUpgradeResponse(head: string, expectedAccept: string): string | null {
  const [statusLine = '', ...lines] = head.split('\r\n');
  if (!/^HTTP\/1\.1 101(?: |$)/.test(statusLine))
    return `upgrade refused: ${quoteForLog(statusLine, 80)}`;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  if (headers.get('upgrade')?.toLowerCase() !== 'websocket')
    return 'response lacks Upgrade: websocket';
  const connection = headers.get('connection')?.toLowerCase().split(',') ?? [];
  if (!connection.some((token) => token.trim() === 'upgrade'))
    return 'response lacks Connection: Upgrade';
  if (headers.get('sec-websocket-accept') !== expectedAccept)
    return 'Sec-WebSocket-Accept does not match the key';
  // Nothing was offered, so the server may select nothing.
  if (headers.has('sec-websocket-extensions'))
    return 'server selected an extension that was never offered';
  if (headers.has('sec-websocket-protocol'))
    return 'server selected a subprotocol that was never offered';
  return null;
}

export function connectUnixWebSocket(
  socketPath: string,
  handlers: WsHandlers,
  opts: UnixWsOptions = {},
): Promise<WsConnection> {
  if (typeof socketPath !== 'string' || socketPath === '' || !socketPath.startsWith('/')) {
    return Promise.reject(new TypeError('socketPath must be an absolute path'));
  }
  if (socketPath.includes('\0')) return Promise.reject(new TypeError('socketPath has a NUL byte'));
  const requestPath = opts.path ?? '/';
  const requestHost = opts.host ?? 'localhost';
  // These go into the request line and the Host header: anything outside these sets could end the
  // line early and inject headers.
  if (!/^\/[\x21-\x7e]*$/.test(requestPath)) {
    return Promise.reject(
      new TypeError('path must be an absolute request path of printable ASCII'),
    );
  }
  if (!/^[A-Za-z0-9.:-]+$/.test(requestHost)) {
    return Promise.reject(new TypeError('host must be a host name or address'));
  }
  if (opts.signal?.aborted) return Promise.reject(new Error('connect aborted'));
  // A throwing log callback must not break the read loop or the connect loop that owns it.
  const log = (message: string): void => {
    try {
      opts.log?.(message);
    } catch {
      // Dropped on purpose.
    }
  };
  const maxPayload = opts.maxPayloadBytes ?? WS_MAX_PAYLOAD_BYTES;
  const key = randomBytes(16).toString('base64');
  const expectedAccept = computeAcceptKey(key);
  // `ignoreBOM: true` keeps a leading U+FEFF: it is part of the message, not a byte order mark.
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

  return new Promise<WsConnection>((resolve, reject) => {
    // Every listener is attached before `connect`. Under `bun test` on Bun 1.3.11 a connect failure
    // (a missing socket file) can emit 'error' synchronously inside the connect call, before a
    // listener attached afterwards exists, and the error is then lost as an uncaught exception.
    // Not reproduced in a plain `bun script` process, so this is hardening, not a known crash.
    const socket = new Socket();
    let parser = new WsFrameParser({ maxPayloadBytes: maxPayload });
    let phase: 'connecting' | 'handshake' | 'open' | 'closing' | 'closed' = 'connecting';
    let head = Buffer.alloc(0);
    let sentClose = false;
    // Set by the first framing violation: from then on nothing the peer sends is read or logged.
    let violated = false;
    let received: { code: number | undefined; reason: string } | null = null;
    let localClose: { code: number; reason: string } | null = null;
    // A message in progress: the first frame's opcode and the payload pieces so far.
    let fragments: { opcode: number; pieces: Uint8Array[]; size: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(
      () => failBeforeOpen(new Error('timed out before the upgrade finished')),
      opts.handshakeTimeoutMs ?? 5000,
    );
    const onAbort = (): void => failBeforeOpen(new Error('connect aborted'));
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    function failBeforeOpen(error: Error): void {
      if (phase === 'open' || phase === 'closing' || phase === 'closed') return;
      phase = 'closed';
      clearTimer();
      opts.signal?.removeEventListener('abort', onAbort);
      socket.destroy();
      reject(error);
    }

    function writeFrame(opcode: number, payload: Uint8Array): void {
      if (socket.writable) socket.write(encodeClientFrame(opcode, payload));
    }

    function closePayload(code: number, reason: Uint8Array): Uint8Array {
      const out = new Uint8Array(2 + reason.length);
      new DataView(out.buffer).setUint16(0, code);
      out.set(reason, 2);
      return out;
    }

    /** Send our close frame once, then give the peer `closeTimeoutMs` to answer. */
    function startClose(code: number, reason: Uint8Array, reasonText: string): void {
      if (phase === 'closed') return;
      localClose ??= { code, reason: reasonText };
      if (!sentClose) {
        sentClose = true;
        writeFrame(WS_OPCODE.close, closePayload(code, reason));
      }
      if (phase !== 'closing') {
        phase = 'closing';
        timer = setTimeout(() => socket.destroy(), opts.closeTimeoutMs ?? 1000);
      }
    }

    /**
     * A violation: close with `code` and stop reading. Whatever the peer sends next (a hostile one
     * can keep writing into the half-open socket until the close timeout) is dropped unread, so it
     * neither grows a buffer nor floods the log.
     */
    function violate(code: number, reason: string): void {
      if (violated) return;
      violated = true;
      fragments = null;
      parser = new WsFrameParser({ maxPayloadBytes: maxPayload });
      log(`closing the connection: ${quoteForLog(reason)}`);
      startClose(code, encodeCloseReason(reason), reason);
      socket.end();
    }

    function deliver(opcode: number, payload: Uint8Array): void {
      if (opcode !== WS_OPCODE.text) {
        log(`dropped a binary message of ${payload.length} bytes`);
        return;
      }
      let text: string;
      try {
        text = decoder.decode(payload);
      } catch {
        violate(INVALID_PAYLOAD, 'text message is not valid UTF-8');
        return;
      }
      try {
        handlers.onMessage(text);
      } catch (error) {
        log(`message handler threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    function onFrame(frame: { fin: boolean; opcode: number; payload: Uint8Array }): void {
      switch (frame.opcode) {
        case WS_OPCODE.ping:
          writeFrame(WS_OPCODE.pong, frame.payload);
          return;
        case WS_OPCODE.pong:
          try {
            handlers.onPong?.();
          } catch (error) {
            log(`pong handler threw: ${error instanceof Error ? error.message : String(error)}`);
          }
          return;
        case WS_OPCODE.close: {
          // RFC 6455 5.5.1: no payload, or a 2-byte code and an optional UTF-8 reason.
          if (frame.payload.length === 1) {
            throw new WsProtocolError('close frame with a 1-byte payload');
          }
          const view = new DataView(frame.payload.buffer, frame.payload.byteOffset);
          const code = frame.payload.length >= 2 ? view.getUint16(0) : undefined;
          if (code !== undefined && !isValidCloseCode(code)) {
            throw new WsProtocolError(`close frame with the invalid status code ${code}`);
          }
          const reasonBytes = frame.payload.subarray(2);
          let reason: string;
          try {
            reason = decoder.decode(reasonBytes);
          } catch {
            violate(INVALID_PAYLOAD, 'close reason is not valid UTF-8');
            return;
          }
          received = { code, reason };
          // Answer a close we did not start: the same code and the original reason bytes.
          if (!sentClose) startClose(code ?? NORMAL_CLOSURE, reasonBytes, reason);
          socket.end();
          return;
        }
        default: {
          // After our own close frame, data still in flight is not delivered.
          if (phase === 'closing') return;
          if (frame.opcode === WS_OPCODE.continuation) {
            if (!fragments)
              throw new WsProtocolError('continuation frame with no message in progress');
          } else {
            if (fragments) throw new WsProtocolError('new data frame inside a fragmented message');
            fragments = { opcode: frame.opcode, pieces: [], size: 0 };
          }
          const message = fragments;
          message.size += frame.payload.length;
          if (message.size > maxPayload)
            throw new WsProtocolError('message is over the size limit');
          message.pieces.push(frame.payload);
          if (!frame.fin) return;
          fragments = null;
          const whole =
            message.pieces.length === 1
              ? (message.pieces[0] as Uint8Array)
              : Buffer.concat(message.pieces);
          deliver(message.opcode, whole);
        }
      }
    }

    function feed(chunk: Uint8Array): void {
      try {
        for (const frame of parser.push(chunk)) {
          if (phase === 'closed' || violated) return;
          onFrame(frame);
        }
      } catch (error) {
        if (error instanceof WsProtocolError) violate(PROTOCOL_ERROR, error.message);
        else violate(PROTOCOL_ERROR, `unexpected read error: ${String(error)}`);
      }
    }

    const connection: WsConnection = {
      send(text) {
        if (phase !== 'open') throw new Error('websocket is not open');
        socket.write(encodeClientFrame(WS_OPCODE.text, new TextEncoder().encode(text)));
      },
      ping(data = '') {
        if (phase !== 'open') throw new Error('websocket is not open');
        socket.write(encodeClientFrame(WS_OPCODE.ping, new TextEncoder().encode(data)));
      },
      close(code = NORMAL_CLOSURE) {
        // 1005, 1006 and 1015 are for reporting only and must never go on the wire.
        if (!isValidCloseCode(code)) throw new RangeError(`${code} is not a status code to send`);
        if (phase === 'open') startClose(code, new Uint8Array(0), '');
      },
      get isOpen() {
        return phase === 'open';
      },
    };

    socket.on('connect', () => {
      if (phase !== 'connecting') return;
      phase = 'handshake';
      socket.write(
        [
          `GET ${requestPath} HTTP/1.1`,
          `Host: ${requestHost}`,
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Key: ${key}`,
          'Sec-WebSocket-Version: 13',
          '',
          '',
        ].join('\r\n'),
      );
    });

    socket.on('data', (chunk: Buffer) => {
      if (phase === 'handshake') {
        head = Buffer.concat([head, chunk]);
        const end = head.indexOf('\r\n\r\n');
        // The cap holds for a header block that arrives whole as well as one that dribbles in.
        if (end > MAX_HEADER_BYTES || (end < 0 && head.length > MAX_HEADER_BYTES)) {
          failBeforeOpen(new Error('upgrade response is too large'));
          return;
        }
        if (end < 0) return;
        const problem = checkUpgradeResponse(
          head.subarray(0, end).toString('latin1'),
          expectedAccept,
        );
        if (problem) {
          failBeforeOpen(new Error(problem));
          return;
        }
        clearTimer();
        opts.signal?.removeEventListener('abort', onAbort);
        phase = 'open';
        const leftover = head.subarray(end + 4);
        head = Buffer.alloc(0);
        resolve(connection);
        if (leftover.length > 0) feed(leftover);
        return;
      }
      if ((phase === 'open' || phase === 'closing') && !violated) feed(chunk);
    });

    // A socket error is followed by 'close'; before the upgrade it is the connect failure.
    socket.on('error', (error: Error) => {
      if (phase === 'connecting' || phase === 'handshake') failBeforeOpen(error);
      else log(`socket error: ${error.message}`);
    });

    /** The connection is over: report it once, whichever of 'end' or 'close' arrives first. */
    function finalize(): void {
      if (phase === 'closed') return;
      phase = 'closed';
      clearTimer();
      const peer = received as { code: number | undefined; reason: string } | null;
      const ours = localClose as { code: number; reason: string } | null;
      const clean = peer !== null && sentClose;
      try {
        handlers.onClose({
          code: peer ? peer.code : ours?.code,
          reason: peer ? peer.reason : (ours?.reason ?? 'socket closed without a close frame'),
          clean,
        });
      } catch (error) {
        log(`close handler threw: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // The peer's end of the stream. On Bun 1.3.11 a write that races the peer closing or destroying
    // its end can lose the 'close' event altogether (bare node:net saw only 'connect' and 'end', with
    // `destroyed` still false), which left the connection looking open forever. So EOF is the end of
    // the connection: report it, then drop the socket ourselves.
    socket.on('end', () => {
      if (phase === 'connecting' || phase === 'handshake') {
        failBeforeOpen(new Error('socket closed before the upgrade finished'));
        return;
      }
      finalize();
      socket.destroy();
    });

    socket.on('close', () => {
      if (phase === 'connecting' || phase === 'handshake') {
        failBeforeOpen(new Error('socket closed before the upgrade finished'));
        return;
      }
      finalize();
    });

    try {
      socket.connect({ path: socketPath });
    } catch (error) {
      failBeforeOpen(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
