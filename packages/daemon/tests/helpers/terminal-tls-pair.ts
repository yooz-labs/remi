/** Real TLS peers for native receipt qualification; the slow receiver is isolated. */
import { FFIType, dlopen, ptr } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect as connectTLS } from 'node:tls';
import { TerminalSendSlot } from '../../src/terminal/send-slot.ts';
import { directTlsFixture } from './direct-tls-fixture.ts';

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, name: string) {
  const end = performance.now() + 10000;
  while (!check()) {
    assert(performance.now() < end, name);
    await wait(2);
  }
}
const receipt = (path: string, value: unknown) => {
  fs.writeFileSync(`${path}.next`, JSON.stringify(value));
  fs.renameSync(`${path}.next`, path);
};

export async function runNativeTlsNetworkPeer(portText: string, prefix: string) {
  const port = Number(portText);
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const tcp = createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    tcp.once('connect', resolve);
    tcp.once('error', reject);
  });
  const fd = (Reflect.get(tcp, '_handle') as { fd?: number } | undefined)?.fd;
  assert(typeof fd === 'number' && fd >= 0, 'owned real TCP descriptor');
  const darwin = process.platform === 'darwin';
  const setReceiveCapacity = (bytes: number) => {
    const native = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
      setsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
        returns: FFIType.i32,
      },
      getsockopt: {
        args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
        returns: FFIType.i32,
      },
    });
    const desired = new Int32Array([bytes]);
    const actual = new Int32Array(1);
    const length = new Uint32Array([4]);
    try {
      assert.equal(
        native.symbols.setsockopt(fd, darwin ? 0xffff : 1, darwin ? 0x1002 : 8, ptr(desired), 4),
        0,
        'set real receiver capacity',
      );
      assert.equal(
        native.symbols.getsockopt(
          fd,
          darwin ? 0xffff : 1,
          darwin ? 0x1002 : 8,
          ptr(actual),
          ptr(length),
        ),
        0,
      );
      const capacity = actual[0];
      assert(typeof capacity === 'number' && capacity > 0, 'real receive capacity');
      return capacity;
    } finally {
      native.close();
    }
  };
  const receiveBytes = setReceiveCapacity(4096);
  const peer = connectTLS({
    socket: tcp,
    host: '127.0.0.1',
    ca: fs.readFileSync(join(prefix, '..', 'ca.pem')),
  });
  await new Promise<void>((resolve, reject) => {
    peer.once('secureConnect', resolve);
    peer.once('error', reject);
  });
  assert(peer.authorized, 'actual TLS CA and hostname validation');
  setReceiveCapacity(4096);
  assert(receiveBytes <= 8192, 'real stopped receiver capacity is bounded');
  let upgraded = false;
  let sequence = 0;
  let pendingPong: Buffer | null = null;
  let previousPong: Buffer | null = null;
  let latestPing: Buffer | null = null;
  let pingSequence = 0;
  let buffer = Buffer.alloc(0);
  const frames: string[] = [];
  peer.on('error', () => {});
  const sendPong = (payload: Buffer) => {
    assert(payload.length <= 125);
    const mask = randomBytes(4);
    const body = Buffer.from(payload);
    for (let i = 0; i < body.length; i++) body[i] = (body[i] ?? 0) ^ (mask[i % 4] ?? 0);
    peer.write(Buffer.concat([Buffer.from([0x8a, 0x80 | body.length]), mask, body]));
  };
  peer.on('data', (data: Buffer) => {
    buffer = Buffer.concat([buffer, data]);
    if (!upgraded) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        assert(buffer.length < 4096);
        return;
      }
      assert(buffer.subarray(0, end).toString().startsWith('HTTP/1.1 101'));
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      peer.pause();
      receipt(`${prefix}.ready`, { pid: process.pid, receiveBytes, localPort: tcp.localPort });
    }
    while (buffer.length >= 2) {
      const first = buffer.readUInt8(0);
      const second = buffer.readUInt8(1);
      assert((second & 0x80) === 0 && (first & 0x70) === 0, 'owned uncompressed server frame');
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
      if ((first & 0xf) === 1 && body[0] === 0x7b) {
        frames.push(createHash('sha256').update(body).digest('hex'));
        if (frames.length > 16) frames.shift();
        receipt(`${prefix}.frames`, frames);
      }
      if ((first & 0xf) === 9) {
        assert.equal(body.length, 16, 'actual native receipt nonce');
        previousPong = latestPing;
        latestPing = Buffer.from(body);
        pendingPong = Buffer.from(body);
        receipt(`${prefix}.ping`, {
          priorFrameDigestRecorded: frames.length > 0,
          sequence: ++pingSequence,
        });
        if (!fs.existsSync(`${prefix}.hold-pong`)) {
          sendPong(pendingPong);
          pendingPong = null;
        }
      }
      buffer = buffer.subarray(header + size);
    }
    assert(buffer.length <= 65546, 'owned peer partial frame bounded');
  });
  peer.write(
    `GET / HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
  );
  const close = () => {
    clearInterval(timer);
    peer.destroy();
    receipt(`${prefix}.closed`, { pid: process.pid });
    process.exit(0);
  };
  const timer = setInterval(() => {
    if (!fs.existsSync(`${prefix}.command`)) return;
    const command = JSON.parse(fs.readFileSync(`${prefix}.command`, 'utf8')) as {
      sequence: number;
      action: string;
    };
    if (command.sequence <= sequence) return;
    sequence = command.sequence;
    if (command.action === 'resume') {
      // Widen only after pending/retirement/resource assertions: the stopped Linux
      // receiver otherwise drains ~227KB/10s of the fixture's 2.6MB backlog.
      assert(
        setReceiveCapacity(1024 * 1024) >= 65536,
        'resumed real receiver drains fixture backlog',
      );
      peer.resume();
    } else if (command.action === 'trigger') {
      peer.pause();
      peer.write(Buffer.from([0x81, 0x81, 0, 0, 0, 0, 0x78]));
    } else if (
      command.action === 'wrong-pong' ||
      command.action === 'confirm-pong' ||
      command.action === 'short-pong' ||
      command.action === 'old-pong'
    ) {
      assert(pendingPong, 'actual earlier native ping was received after the complete frame');
      let payload = Buffer.from(
        command.action === 'old-pong' ? (previousPong ?? pendingPong) : pendingPong,
      );
      if (command.action === 'short-pong') payload = payload.subarray(0, 15);
      if (command.action === 'wrong-pong') payload[0] = (payload[0] ?? 0) ^ 1;
      sendPong(payload);
      if (command.action === 'confirm-pong') pendingPong = null;
    } else if (command.action === 'exit') close();
  }, 2);
  process.on('SIGTERM', close);
  return new Promise<never>(() => {});
}

/** Seven fast held-proof clients share a process; the slow receiver stays independent. */
export async function createInProcessNativeTlsTerminalPair() {
  const at = process.argv.indexOf('--terminal-tls-root');
  const tlsRoot = at >= 0 ? process.argv[at + 1] : undefined;
  if (at >= 0) assert(tlsRoot, 'owned certificate root argument');
  const ownedTls = tlsRoot ? undefined : directTlsFixture();
  const tls = ownedTls?.tls ?? {
    cert: fs.readFileSync(join(tlsRoot as string, 'server.pem'), 'utf8'),
    key: fs.readFileSync(join(tlsRoot as string, 'server.key'), 'utf8'),
  };
  const ca = ownedTls?.ca ?? fs.readFileSync(join(tlsRoot as string, 'ca.pem'), 'utf8');
  let ws: Bun.ServerWebSocket<undefined> | undefined;
  let slot: TerminalSendSlot | undefined;
  let peer: WebSocket | undefined;
  let peerError = false;
  let server: Bun.Server<undefined> | undefined;
  try {
    server = Bun.serve<undefined>({
      tls,
      hostname: '127.0.0.1',
      port: 0,
      fetch(request, server) {
        if (server.upgrade(request, { data: undefined })) return;
        return new Response('owned', { status: 400 });
      },
      websocket: {
        open(value) {
          ws = value;
          slot = new TerminalSendSlot(value, 'tls-receipt');
        },
        message() {},
        pong(_socket, data) {
          slot?.nativePong(data);
        },
        drain() {
          slot?.nativeDrained();
        },
        close() {
          slot?.nativeClosed();
        },
        backpressureLimit: 128 * 1024,
        closeOnBackpressureLimit: false,
      },
    });
    // The native client verifies the private CA and sends real automatic pongs.
    peer = new WebSocket(`wss://127.0.0.1:${server.port}`, { tls: { ca } } as never);
    peer.addEventListener('error', () => {
      peerError = true;
    });
    await until(
      () => peerError || (!!ws && !!slot && peer?.readyState === WebSocket.OPEN),
      'actual in-process TLS WebSocket upgrade',
    );
    assert(!peerError && ws && slot, 'normal CA-verified fast TLS peer is open');
    const native = ws;
    const sender = slot;
    const client = peer;
    const listener = server;
    return {
      ws: native,
      slot: sender,
      async close() {
        try {
          client.close();
          await until(() => client.readyState === WebSocket.CLOSED, 'fast TLS peer closed');
          assert(!peerError, 'fast TLS peer had no native error');
        } finally {
          listener.stop(true);
          ownedTls?.cleanup();
        }
      },
    };
  } catch (error) {
    peer?.close();
    server?.stop(true);
    ownedTls?.cleanup();
    throw error;
  }
}

export async function createNativeTlsTerminalPair() {
  const at = process.argv.indexOf('--terminal-tls-root');
  const tlsRoot = at >= 0 ? process.argv[at + 1] : undefined;
  if (at >= 0) assert(tlsRoot, 'owned certificate root argument');
  const ownedTls = tlsRoot ? undefined : directTlsFixture();
  const tls = ownedTls?.tls ?? {
    cert: fs.readFileSync(join(tlsRoot as string, 'server.pem'), 'utf8'),
    key: fs.readFileSync(join(tlsRoot as string, 'server.key'), 'utf8'),
  };
  const ca = ownedTls?.ca ?? fs.readFileSync(join(tlsRoot as string, 'ca.pem'), 'utf8');
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'terminal-native-peer-')));
  fs.writeFileSync(join(home, 'ca.pem'), ca, { mode: 0o600 });
  const prefix = join(home, 'peer');
  let ws: Bun.ServerWebSocket<undefined> | undefined;
  let slot: TerminalSendSlot | undefined;
  let action: (() => void) | undefined;
  let insideMessage = false;
  let nativePongs = 0;
  let nativeDrains = 0;
  let sequence = 0;
  let nativePeerPort: number | undefined;
  let receiverCapacity: number | undefined;
  const stopPeer = () => {
    assert(peer?.exitCode === null, 'owned network peer is live');
    process.kill(peer.pid, 'SIGSTOP');
    const end = performance.now() + 1000;
    for (;;) {
      const stopped =
        process.platform === 'linux'
          ? /^State:\s+[Tt]/m.test(fs.readFileSync(`/proc/${peer.pid}/status`, 'utf8'))
          : Bun.spawnSync(['/bin/ps', '-p', String(peer.pid), '-o', 'state='])
              .stdout.toString()
              .trim()
              .startsWith('T');
      if (stopped) return;
      assert(performance.now() < end, 'owned peer really stopped');
      Bun.sleepSync(1);
    }
  };
  const server = Bun.serve({
    tls: tls,
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      nativePeerPort = server.requestIP(request)?.port;
      if (server.upgrade(request)) return;
      return new Response('owned', { status: 400 });
    },
    websocket: {
      open(value) {
        ws = value;
        slot = new TerminalSendSlot(value, 'tls-receipt');
      },
      message() {
        stopPeer();
        insideMessage = true;
        try {
          action?.();
        } finally {
          insideMessage = false;
        }
      },
      pong(_socket, data) {
        nativePongs++;
        slot?.nativePong(data);
      },
      drain() {
        nativeDrains++;
        slot?.nativeDrained();
      },
      close() {
        slot?.nativeClosed();
      },
      backpressureLimit: 128 * 1024,
      closeOnBackpressureLimit: false,
    },
  });
  const command = Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];
  const peer = (() => {
    try {
      return Bun.spawn([...command, '--terminal-tls-peer', String(server.port), prefix], {
        cwd: home,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        env: {
          PATH: process.env['PATH'] ?? '/usr/bin:/bin',
          LANG: 'en_US.UTF-8',
          TMPDIR: tmpdir(),
        },
      });
    } catch (error) {
      server.stop(true);
      fs.rmSync(home, { recursive: true, force: true });
      ownedTls?.cleanup();
      throw error;
    }
  })();
  const stdout = new Response(peer.stdout).text();
  const stderr = new Response(peer.stderr).text();
  try {
    await until(
      () => fs.existsSync(`${prefix}.ready`) || peer.exitCode !== null,
      'actual independent TCP peer ready',
    );
    assert.equal(
      peer.exitCode,
      null,
      await (peer.exitCode !== null ? stderr : Promise.resolve('')),
    );
    const ready = JSON.parse(fs.readFileSync(`${prefix}.ready`, 'utf8'));
    assert.equal(ready.pid, peer.pid);
    receiverCapacity = ready.receiveBytes;
    assert.equal(
      nativePeerPort,
      ready.localPort,
      'actual TLS peer uses the bounded TCP descriptor',
    );
    stopPeer();
  } catch (error) {
    const watchdog = setTimeout(() => {
      if (peer.exitCode === null) peer.kill('SIGKILL');
    }, 3000);
    try {
      if (peer.exitCode === null) {
        process.kill(peer.pid, 'SIGCONT');
        process.kill(peer.pid, 'SIGTERM');
      }
      await peer.exited;
    } finally {
      clearTimeout(watchdog);
      server.stop(true);
      fs.writeFileSync(join(home, 'startup.stderr'), await stderr);
      fs.writeFileSync(join(home, 'startup.stdout'), await stdout);
    }
    throw error;
  }
  assert(ws && slot);
  assert(server.port && nativePeerPort);
  const info = inspectOwnedTerminalSender(server.port, nativePeerPort);
  const senderCapacity = info.capacity;
  const senderFd = info.fd;
  const native = ws;
  const original = ws.send;
  const initial = slot;
  let capacityBytes = 0;
  const fill = () => {
    while (native.getBufferedAmount() === 0) {
      assert(capacityBytes < 16 * 1024 * 1024, 'finite owned native pressure');
      original.call(native, 'x'.repeat(1024));
      capacityBytes += 1024;
    }
    assert(
      native.getBufferedAmount() <= 1034,
      'fixture pressure retains at most one KiB plus header',
    );
  };
  const control = (value: string) => {
    assert(peer?.exitCode === null);
    receipt(`${prefix}.command`, { sequence: ++sequence, action: value });
    process.kill(peer.pid, 'SIGCONT');
  };
  return {
    ws: native,
    senderCapacity,
    receiverCapacity,
    receiverStopped: () =>
      peer.exitCode === null &&
      (process.platform === 'linux'
        ? /^State:\s+[Tt]/m.test(fs.readFileSync(`/proc/${peer.pid}/status`, 'utf8'))
        : Bun.spawnSync(['/bin/ps', '-p', String(peer.pid), '-o', 'state='])
            .stdout.toString()
            .trim()
            .startsWith('T')),
    receivedAnyFrame: () => fs.existsSync(`${prefix}.frames`),
    kernelQueuedBytes: () => kernelQueuedBytes(senderFd),
    get slot() {
      return slot ?? initial;
    },
    replaceSlot(value: TerminalSendSlot) {
      initial.retire();
      slot = value;
    },
    fill,
    insideMessage: () => insideMessage,
    capacity: () => capacityBytes,
    receivedFrame(text: string) {
      return (
        fs.existsSync(`${prefix}.frames`) &&
        (JSON.parse(fs.readFileSync(`${prefix}.frames`, 'utf8')) as string[]).includes(
          createHash('sha256').update(text).digest('hex'),
        )
      );
    },
    resumePeer() {
      control('resume');
    },
    holdPongs() {
      fs.writeFileSync(`${prefix}.hold-pong`, 'hold');
    },
    pingReceived: () => fs.existsSync(`${prefix}.ping`),
    nativePongs: () => nativePongs,
    nativeDrains: () => nativeDrains,
    wrongPong() {
      control('wrong-pong');
    },
    shortPong() {
      control('short-pong');
    },
    oldPong() {
      control('old-pong');
    },
    receivedPings: () =>
      fs.existsSync(`${prefix}.ping`)
        ? Number(JSON.parse(fs.readFileSync(`${prefix}.ping`, 'utf8')).sequence)
        : 0,
    confirmPong() {
      control('confirm-pong');
    },
    fromMessage(call: () => void) {
      action = call;
      control('trigger');
    },
    pressureAtSend(
      throwAfter = false,
      beforeFill?: () => void,
      closeAfter = false,
      excess = false,
    ) {
      native.send = (text, compress) => {
        native.send = original;
        beforeFill?.();
        fill();
        while (native.getBufferedAmount() < 16384) original.call(native, 'x'.repeat(1024));
        assert(native.getBufferedAmount() <= 16384 + 1034, 'bounded TLS fixture pressure');
        if (excess)
          while (native.getBufferedAmount() < 80 * 1024) original.call(native, 'x'.repeat(1024));
        const result = original.call(native, text, compress);
        if (closeAfter) native.close();
        if (throwAfter) throw new Error('owned post-native-call failure');
        return result;
      };
    },
    async close() {
      if (peer.exitCode === null) control('exit');
      const watchdog = setTimeout(() => {
        if (peer.exitCode === null) {
          process.kill(peer.pid, 'SIGCONT');
          process.kill(peer.pid, 'SIGTERM');
        }
      }, 3000);
      const lastResort = setTimeout(() => {
        if (peer.exitCode === null) peer.kill('SIGKILL');
      }, 6000);
      try {
        await peer.exited;
      } finally {
        clearTimeout(watchdog);
        clearTimeout(lastResort);
        server.stop(true);
      }
      assert.equal(peer.exitCode, 0, await stderr);
      assert.equal(await stdout, '');
      assert.throws(
        () => process.kill(peer.pid, 0),
        (error) => (error as NodeJS.ErrnoException).code === 'ESRCH',
        'independent native peer reaped',
      );
      fs.rmSync(home, { recursive: true, force: true });
      ownedTls?.cleanup();
    },
  };
}

function inspectOwnedTerminalSender(
  localPort: number,
  peerPort: number,
): { fd: number; capacity: number } {
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
    return { fd, capacity };
  } finally {
    native.close();
  }
}

function kernelQueuedBytes(fd: number): number {
  const darwin = process.platform === 'darwin';
  const native = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
    ioctl: { args: [FFIType.i32, FFIType.u64, FFIType.ptr], returns: FFIType.i32 },
  });
  const queued = new Int32Array(1);
  const length = new Uint32Array([4]);
  try {
    const status = darwin
      ? native.symbols.getsockopt(fd, 0xffff, 0x1024, ptr(queued), ptr(length))
      : native.symbols.ioctl(fd, 0x5411, ptr(queued));
    assert.equal(status, 0, 'actual owned kernel output queue');
    assert((queued[0] ?? -1) >= 0);
    return queued[0] as number;
  } finally {
    native.close();
  }
}
