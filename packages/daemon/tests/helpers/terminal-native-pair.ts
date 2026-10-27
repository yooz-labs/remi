/** Real independent TCP peer; its receive memory is outside the daemon model budget. */
import { FFIType, dlopen, ptr } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TerminalSendSlot } from '../../src/terminal/send-slot.ts';
import { constrainOwnedTerminalSender, runRawTerminalNetworkPeer } from './terminal-raw-peer.ts';

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

export async function runTerminalNetworkPeer(portText: string, prefix: string, stable = false) {
  if (stable) return runRawTerminalNetworkPeer(portText, prefix);
  const port = Number(portText);
  assert(Number.isSafeInteger(port) && port > 0 && port <= 65535);
  const peer = createConnection({ host: '127.0.0.1', port });
  await new Promise<void>((resolve, reject) => {
    peer.once('connect', resolve);
    peer.once('error', reject);
  });
  const fd = (Reflect.get(peer, '_handle') as { fd?: number } | undefined)?.fd;
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
  assert(receiveBytes <= 8192, 'real stopped receiver capacity is bounded');
  let upgraded = false;
  let sequence = 0;
  let buffer = Buffer.alloc(0);
  const frames: string[] = [];
  peer.on('error', () => {});
  peer.on('data', (data) => {
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
      receipt(`${prefix}.ready`, { pid: process.pid, receiveBytes });
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
    } else if (command.action === 'exit') close();
  }, 2);
  process.on('SIGTERM', close);
  return new Promise<never>(() => {});
}

export async function createNativeTerminalPair(stable = false) {
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'terminal-native-peer-')));
  const prefix = join(home, 'peer');
  let ws: Bun.ServerWebSocket<undefined> | undefined;
  let slot: TerminalSendSlot | undefined;
  let action: (() => void) | undefined;
  let insideMessage = false;
  let sequence = 0;
  let nativePeerPort: number | undefined;
  let senderCapacity: number | undefined;
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
    hostname: '127.0.0.1',
    port: 0,
    fetch(request, server) {
      if (stable) nativePeerPort = server.requestIP(request)?.port;
      if (server.upgrade(request)) return;
      return new Response('owned', { status: 400 });
    },
    websocket: {
      open(value) {
        ws = value;
        slot = new TerminalSendSlot(value, 'plain-ws');
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
  const command = Bun.main.startsWith('/$bunfs/')
    ? [process.execPath]
    : [process.execPath, '--no-env-file', Bun.main];
  const peer = Bun.spawn(
    [
      ...command,
      '--terminal-peer',
      String(server.port),
      prefix,
      ...(stable ? ['--stable-peer'] : []),
    ],
    {
      cwd: home,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin', LANG: 'en_US.UTF-8', TMPDIR: tmpdir() },
    },
  );
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
    stopPeer();
    if (stable) {
      assert(
        ready.preconnect === true && ready.receiveBytes > 0 && ready.receiveBytes <= 8192,
        'actual receiver was bounded before connect',
      );
      const localPort = server.port;
      const remotePort = nativePeerPort;
      assert(localPort !== undefined && remotePort !== undefined);
      senderCapacity = constrainOwnedTerminalSender(localPort, remotePort);
    }
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
        if (stable) {
          while (native.getBufferedAmount() < 16384) original.call(native, 'x'.repeat(1024));
          assert(native.getBufferedAmount() <= 16384 + 1034, 'bounded stable fixture pressure');
        }
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
    },
  };
}
