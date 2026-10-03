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
  /** Time to reach the socket: 5000 ms by default. */
  connectTimeoutMs?: number;
  /** Time from connecting to the `101` response: 5000 ms by default. */
  handshakeTimeoutMs?: number;
  maxPayloadBytes?: number;
  /** How long to wait for the peer's close frame before dropping the socket: 1000 ms by default. */
  closeTimeoutMs?: number;
  log?: (message: string) => void;
}

const MAX_HEADER_BYTES = 16 * 1024;
const NORMAL_CLOSURE = 1000;
const PROTOCOL_ERROR = 1002;
const INVALID_PAYLOAD = 1007;

/** The status line and headers of the upgrade response, if complete and acceptable; else an error. */
function checkUpgradeResponse(head: string, expectedAccept: string): string | null {
  const [statusLine = '', ...lines] = head.split('\r\n');
  if (!/^HTTP\/1\.1 101\b/.test(statusLine)) return `upgrade refused: ${statusLine.slice(0, 80)}`;
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
  const log = opts.log ?? (() => {});
  const maxPayload = opts.maxPayloadBytes ?? WS_MAX_PAYLOAD_BYTES;
  const key = randomBytes(16).toString('base64');
  const expectedAccept = computeAcceptKey(key);
  const decoder = new TextDecoder('utf-8', { fatal: true });

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
      () => failBeforeOpen(new Error('connect timed out')),
      opts.connectTimeoutMs ?? 5000,
    );

    const clearTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = undefined;
    };

    function failBeforeOpen(error: Error): void {
      if (phase === 'open' || phase === 'closing' || phase === 'closed') return;
      phase = 'closed';
      clearTimer();
      socket.destroy();
      reject(error);
    }

    function writeFrame(opcode: number, payload: Uint8Array): void {
      if (socket.writable) socket.write(encodeClientFrame(opcode, payload));
    }

    function closePayload(code: number, reason = ''): Uint8Array {
      const text = new TextEncoder().encode(reason);
      const out = new Uint8Array(2 + text.length);
      new DataView(out.buffer).setUint16(0, code);
      out.set(text, 2);
      return out.subarray(0, Math.min(out.length, 125));
    }

    /** Send our close frame once, then give the peer `closeTimeoutMs` to answer. */
    function startClose(code: number, reason: string): void {
      if (phase === 'closed') return;
      localClose ??= { code, reason };
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
      log(`closing the connection: ${reason}`);
      startClose(code, reason);
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
          const code =
            frame.payload.length >= 2
              ? new DataView(frame.payload.buffer, frame.payload.byteOffset).getUint16(0)
              : undefined;
          const reason = new TextDecoder().decode(frame.payload.subarray(2));
          received = { code, reason };
          // Answer a close we did not start (an echo of its code), then let the socket end.
          if (!sentClose) startClose(code ?? NORMAL_CLOSURE, reason);
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
        if (phase === 'open') startClose(code, '');
      },
      get isOpen() {
        return phase === 'open';
      },
    };

    socket.on('connect', () => {
      if (phase !== 'connecting') return;
      phase = 'handshake';
      clearTimer();
      timer = setTimeout(
        () => failBeforeOpen(new Error('upgrade timed out')),
        opts.handshakeTimeoutMs ?? 5000,
      );
      socket.write(
        [
          `GET ${opts.path ?? '/'} HTTP/1.1`,
          `Host: ${opts.host ?? 'localhost'}`,
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
        if (end < 0) {
          if (head.length > MAX_HEADER_BYTES)
            failBeforeOpen(new Error('upgrade response is too large'));
          return;
        }
        const problem = checkUpgradeResponse(
          head.subarray(0, end).toString('latin1'),
          expectedAccept,
        );
        if (problem) {
          failBeforeOpen(new Error(problem));
          return;
        }
        clearTimer();
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
