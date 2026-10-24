/** Real CA-verified TLS/WebSocket peer with controllable, actual native pong bytes. */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { connect } from 'node:tls';

export function terminalPacketPeer(port: number, ca: string) {
  let onmessage: ((event: { data: string }) => unknown) | null = null;
  let onerror: ((error: unknown) => unknown) | null = null;
  let state: number = WebSocket.CONNECTING;
  let upgraded = false;
  let buffer = Buffer.alloc(0);
  let pendingPong: Buffer | null = null;
  const key = randomBytes(16).toString('base64');
  const accept = createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  const socket = connect({ host: '127.0.0.1', port, ca, rejectUnauthorized: true });
  const write = (opcode: number, body: Uint8Array) => {
    assert(upgraded && state === WebSocket.OPEN, 'actual packet peer is open');
    assert(body.byteLength <= 65536, 'bounded actual client frame');
    const prefix = body.byteLength < 126 ? 2 : body.byteLength <= 65535 ? 4 : 10;
    const frame = Buffer.alloc(prefix + 4 + body.byteLength);
    frame[0] = 0x80 | opcode;
    frame[1] = 0x80 | (prefix === 2 ? body.byteLength : prefix === 4 ? 126 : 127);
    if (prefix === 4) frame.writeUInt16BE(body.byteLength, 2);
    if (prefix === 10) frame.writeBigUInt64BE(BigInt(body.byteLength), 2);
    const mask = randomBytes(4);
    mask.copy(frame, prefix);
    for (let i = 0; i < body.byteLength; i++)
      frame[prefix + 4 + i] = (body[i] ?? 0) ^ (mask[i & 3] ?? 0);
    socket.write(frame);
    assert(socket.writableLength <= 65550, 'bounded actual client native queue');
  };
  const fail = (error: unknown) => {
    state = WebSocket.CLOSED;
    socket.destroy();
    onerror?.(error);
  };
  socket.once('secureConnect', () => {
    try {
      assert(socket.authorized, 'actual TLS CA and host verification');
      socket.write(
        `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
      );
    } catch (error) {
      fail(error);
    }
  });
  socket.on('error', fail);
  socket.on('close', () => {
    state = WebSocket.CLOSED;
  });
  socket.on('data', (chunk: Buffer) => {
    try {
      assert(buffer.length + chunk.length <= 2 * 65546 + 8192, 'bounded packet receive');
      buffer = Buffer.concat([buffer, chunk]);
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) {
          assert(buffer.length <= 8192, 'bounded actual upgrade headers');
          return;
        }
        const header = buffer.subarray(0, end).toString();
        assert(header.startsWith('HTTP/1.1 101'), 'actual WebSocket upgrade status');
        assert.equal(
          /^sec-websocket-accept:\s*(\S+)\s*$/im.exec(header)?.[1],
          accept,
          'actual WebSocket handshake proof',
        );
        buffer = buffer.subarray(end + 4);
        upgraded = true;
        state = WebSocket.OPEN;
      }
      while (buffer.length >= 2) {
        const first = buffer[0] ?? 0;
        const second = buffer[1] ?? 0;
        assert((first & 0xf0) === 0x80 && !(second & 0x80), 'complete unmasked server frame');
        let size = second & 0x7f;
        let header = 2;
        if (size === 126) {
          if (buffer.length < 4) break;
          size = buffer.readUInt16BE(2);
          header = 4;
        } else if (size === 127) {
          if (buffer.length < 10) break;
          const wide = buffer.readBigUInt64BE(2);
          assert(wide <= 65536n, 'bounded actual server frame');
          size = Number(wide);
          header = 10;
        }
        assert(size <= 65536, 'bounded server payload');
        if (buffer.length < header + size) break;
        const body = buffer.subarray(header, header + size);
        buffer = buffer.subarray(header + size);
        const opcode = first & 15;
        if (opcode === 1)
          onmessage?.({ data: new TextDecoder('utf-8', { fatal: true }).decode(body) });
        else if (opcode === 9) {
          assert(size <= 125, 'native ping control limit');
          if (size === 16) {
            assert(pendingPong === null, 'only one actual terminal receipt pending');
            pendingPong = Buffer.from(body);
          } else write(10, body);
        } else if (opcode === 8) {
          if (state === WebSocket.OPEN) write(8, body);
          state = WebSocket.CLOSING;
          socket.end();
        } else assert.fail('unexpected actual server opcode');
      }
      assert(buffer.length <= 65546, 'bounded incomplete server frame');
    } catch (error) {
      fail(error);
    }
  });
  return {
    get readyState() {
      return state;
    },
    get onmessage() {
      return onmessage;
    },
    set onmessage(handler: typeof onmessage) {
      onmessage = handler;
    },
    set onerror(handler: typeof onerror) {
      onerror = handler;
    },
    send(value: string | Uint8Array) {
      write(typeof value === 'string' ? 1 : 2, Buffer.from(value));
    },
    hasPendingPong: () => pendingPong !== null,
    confirmPong() {
      assert(pendingPong, 'actual ordered native ping arrived');
      const payload = pendingPong;
      pendingPong = null;
      write(10, payload);
    },
    close() {
      if (state === WebSocket.OPEN) {
        write(8, Buffer.from([3, 232]));
        state = WebSocket.CLOSING;
        socket.end();
      } else if (state !== WebSocket.CLOSED) socket.destroy();
    },
  };
}
