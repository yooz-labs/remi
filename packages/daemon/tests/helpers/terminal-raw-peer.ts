import { FFIType, dlopen, ptr, toArrayBuffer } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
/** Owned TCP receiver: its window is set before connect, before any native pressure. */
export async function runRawTerminalNetworkPeer(portText: string, prefix: string): Promise<never> {
  const port = Number(portText);
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const darwin = process.platform === 'darwin';
  const native = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    socket: { args: [FFIType.i32, FFIType.i32, FFIType.i32], returns: FFIType.i32 },
    setsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    connect: { args: [FFIType.i32, FFIType.ptr, FFIType.u32], returns: FFIType.i32 },
    recv: { args: [FFIType.i32, FFIType.ptr, FFIType.u64, FFIType.i32], returns: FFIType.i64 },
    write: { args: [FFIType.i32, FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    close: { args: [FFIType.i32], returns: FFIType.i32 },
  });
  const errors = darwin
    ? dlopen('/usr/lib/libSystem.B.dylib', { __error: { args: [], returns: FFIType.ptr } })
    : dlopen('libc.so.6', { __errno_location: { args: [], returns: FFIType.ptr } });
  const errorPointer = () =>
    '__error' in errors.symbols ? errors.symbols.__error() : errors.symbols.__errno_location();
  const fd = native.symbols.socket(2, 1, 0);
  assert(fd >= 0, 'actual owned raw TCP descriptor');
  const capacity = (bytes: number) => {
    const wanted = new Int32Array([bytes]);
    const actual = new Int32Array(1);
    const len = new Uint32Array([4]);
    assert.equal(
      native.symbols.setsockopt(fd, darwin ? 0xffff : 1, darwin ? 0x1002 : 8, ptr(wanted), 4),
      0,
    );
    assert.equal(
      native.symbols.getsockopt(
        fd,
        darwin ? 0xffff : 1,
        darwin ? 0x1002 : 8,
        ptr(actual),
        ptr(len),
      ),
      0,
    );
    const effective = actual[0];
    assert(effective !== undefined && effective > 0, 'actual receiver capacity');
    return effective;
  };
  assert(capacity(4096) <= 8192);
  const address = new Uint8Array(16);
  address[0] = darwin ? 16 : 2;
  address[1] = darwin ? 2 : 0;
  address[2] = port >> 8;
  address[3] = port & 255;
  address[4] = 127;
  address[7] = 1;
  assert.equal(native.symbols.connect(fd, ptr(address), 16), 0, 'actual owned TCP connect');
  const receiveBytes = capacity(4096);
  assert(receiveBytes > 0 && receiveBytes <= 8192);
  // recv's fixed signature avoids Darwin ARM64's variadic fcntl ABI.
  const receipt = (suffix: string, value: unknown) => {
    fs.writeFileSync(`${prefix + suffix}.next`, JSON.stringify(value));
    fs.renameSync(`${prefix + suffix}.next`, prefix + suffix);
  };
  const write = (value: Uint8Array) => {
    let offset = 0;
    while (offset < value.length) {
      const part = value.subarray(offset);
      const n = Number(native.symbols.write(fd, ptr(part), BigInt(part.byteLength)));
      assert(n > 0, 'actual native peer write');
      offset += n;
    }
  };
  let paused = false;
  let upgraded = false;
  let sequence = 0;
  let ended = false;
  let buffer = Buffer.alloc(0);
  const hashes: string[] = [];
  write(
    Buffer.from(
      `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
    ),
  );
  const input = new Uint8Array(65536);
  const consume = () => {
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        assert(buffer.length < 4096);
        return;
      }
      assert(buffer.subarray(0, end).toString().startsWith('HTTP/1.1 101'));
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      paused = true;
      receipt('.ready', { pid: process.pid, receiveBytes, preconnect: true });
    }
    while (buffer.length >= 2) {
      const first = buffer.readUInt8(0);
      const second = buffer.readUInt8(1);
      assert((second & 0x80) === 0 && (first & 0x70) === 0);
      let size = second & 0x7f;
      let header = 2;
      if (size === 126) {
        if (buffer.length < 4) break;
        size = buffer.readUInt16BE(2);
        header = 4;
      } else if (size === 127) {
        if (buffer.length < 10) break;
        const wide = buffer.readBigUInt64BE(2);
        assert(wide <= 65536n);
        size = Number(wide);
        header = 10;
      }
      if (buffer.length < header + size) break;
      const body = buffer.subarray(header, header + size);
      if ((first & 15) === 1 && body[0] === 123) {
        hashes.push(createHash('sha256').update(body).digest('hex'));
        if (hashes.length > 16) hashes.shift();
        receipt('.frames', hashes);
      }
      buffer = buffer.subarray(header + size);
    }
    assert(buffer.length <= 65546);
  };
  const close = () => {
    clearInterval(timer);
    native.symbols.close(fd);
    native.close();
    errors.close();
    receipt('.closed', { pid: process.pid });
    process.exit(0);
  };
  const timer = setInterval(() => {
    if (fs.existsSync(`${prefix}.command`)) {
      const c = JSON.parse(fs.readFileSync(`${prefix}.command`, 'utf8')) as {
        sequence: number;
        action: string;
      };
      if (c.sequence > sequence) {
        sequence = c.sequence;
        if (c.action === 'exit') close();
        else if (c.action === 'resume') {
          assert(capacity(1024 * 1024) >= 65536);
          paused = false;
        } else if (c.action === 'trigger') {
          paused = true;
          write(Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0x78]));
        }
      }
    }
    if (paused || ended) return;
    const n = Number(
      native.symbols.recv(fd, ptr(input), BigInt(input.byteLength), darwin ? 0x80 : 0x40),
    );
    if (n < 0) {
      const p = errorPointer();
      assert(p);
      const errno = new DataView(toArrayBuffer(p, 0, 4)).getInt32(0, true);
      assert([darwin ? 35 : 11, 4].includes(errno), `actual native peer read ${errno}`);
      return;
    }
    if (!n) {
      ended = true;
      return;
    }
    buffer = Buffer.concat([buffer, Buffer.from(input.subarray(0, n))]);
    consume();
  }, 2);
  process.on('SIGTERM', close);
  return new Promise<never>(() => {});
}

/** Select only the one owned loopback tuple; never mutate an unrelated descriptor. */
export function constrainOwnedTerminalSender(localPort: number, peerPort: number): number {
  const darwin = process.platform === 'darwin';
  const native = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    getpeername: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    setsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  const matches: number[] = [];
  const addressMatches = (address: Uint8Array, port: number) =>
    (darwin ? address[1] === 2 : address[0] === 2 && address[1] === 0) &&
    address[2] === port >> 8 &&
    address[3] === (port & 255) &&
    address[4] === 127 &&
    address[5] === 0 &&
    address[6] === 0 &&
    address[7] === 1;
  try {
    for (let fd = 3; fd < 1024; fd++) {
      const local = new Uint8Array(128);
      const remote = new Uint8Array(128);
      const ll = new Uint32Array([128]);
      const rl = new Uint32Array([128]);
      if (
        native.symbols.getsockname(fd, ptr(local), ptr(ll)) === 0 &&
        addressMatches(local, localPort) &&
        native.symbols.getpeername(fd, ptr(remote), ptr(rl)) === 0 &&
        addressMatches(remote, peerPort)
      )
        matches.push(fd);
    }
    assert.equal(matches.length, 1, 'exact owned native socket descriptor');
    const fd = matches[0];
    assert(fd !== undefined);
    const wanted = new Int32Array([4096]);
    const actual = new Int32Array(1);
    const len = new Uint32Array([4]);
    assert.equal(
      native.symbols.setsockopt(fd, darwin ? 0xffff : 1, darwin ? 0x1001 : 7, ptr(wanted), 4),
      0,
    );
    assert.equal(
      native.symbols.getsockopt(
        fd,
        darwin ? 0xffff : 1,
        darwin ? 0x1001 : 7,
        ptr(actual),
        ptr(len),
      ),
      0,
    );
    const capacity = actual[0];
    assert(
      capacity !== undefined && capacity > 0 && capacity <= 8192,
      'owned sender capacity is bounded',
    );
    return capacity;
  } finally {
    native.close();
  }
}
