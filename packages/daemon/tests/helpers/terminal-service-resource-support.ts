/** Owned, actual TLS peers and files for staged service measurements; never installed state. */
import { FFIType, dlopen, ptr } from 'bun:ffi';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type RemiIdentity,
  type TerminalViewBinding,
  type TerminalViewRequest,
  createAuthResponse,
  createHello,
  createPong,
  decodeTerminalViewFrame,
  encodeTerminalViewFrame,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import type { directTlsFixture } from './direct-tls-fixture.ts';
import { terminalPacketPeer } from './terminal-packet-peer.ts';

export function ownedTerminalResourceFiles(
  certificateRoot: string,
  sharedHome?: string,
): ReturnType<typeof directTlsFixture> {
  const directory = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-svc-resource-')));
  const home = sharedHome ?? join(directory, 'state');
  const userHome = join(directory, 'user');
  const work = join(directory, 'work');
  const certs = join(directory, 'certs');
  for (const path of [home, userHome, work, certs])
    fs.mkdirSync(path, { recursive: true, mode: 0o700 });
  for (const name of ['ca.pem', 'server.pem', 'server.key'])
    fs.writeFileSync(join(certs, name), fs.readFileSync(join(certificateRoot, name)), {
      mode: 0o600,
    });
  const configPath = join(directory, 'config.toml');
  const tlsTable =
    '[daemon.tls]\ncertificate_file="certs/server.pem"\nprivate_key_file="certs/server.key"\n';
  const config = `[daemon]\nbind="127.0.0.1"\n${tlsTable}[network]\nmdns=false\nrelay=false\n`;
  fs.writeFileSync(configPath, config, { mode: 0o600 });
  return {
    directory,
    home,
    userHome,
    work,
    certs,
    configPath,
    tlsTable,
    config,
    ca: fs.readFileSync(join(certs, 'ca.pem'), 'utf8'),
    tls: {
      cert: fs.readFileSync(join(certs, 'server.pem'), 'utf8'),
      key: fs.readFileSync(join(certs, 'server.key'), 'utf8'),
    },
    env: {
      HOME: userHome,
      REMI_HOME: home,
      TMPDIR: tmpdir(),
      PATH: '/usr/bin:/bin',
      NODE_ENV: 'test',
    },
    cleanup: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
}

export function publishResourceReceipt(path: string, value: unknown): void {
  fs.writeFileSync(`${path}.next`, JSON.stringify(value), { mode: 0o600 });
  fs.renameSync(`${path}.next`, path);
}

export function resourceSocketTuples(port: number, side: 'server' | 'client') {
  const darwin = process.platform === 'darwin';
  const library = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    getsockname: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
    getpeername: { args: [FFIType.i32, FFIType.ptr, FFIType.ptr], returns: FFIType.i32 },
  });
  const decode = (address: Uint8Array) => {
    const ipv4 = darwin ? address[1] === 2 : address[0] === 2 && address[1] === 0;
    if (!ipv4 || address[4] !== 127 || address[5] || address[6] || address[7] !== 1) return null;
    return ((address[2] ?? 0) << 8) | (address[3] ?? 0);
  };
  const rows: { fd: number; local: number; remote: number }[] = [];
  try {
    for (let fd = 3; fd < 1024; fd++) {
      const local = new Uint8Array(128);
      const remote = new Uint8Array(128);
      const ll = new Uint32Array([128]);
      const rl = new Uint32Array([128]);
      if (
        library.symbols.getsockname(fd, ptr(local), ptr(ll)) !== 0 ||
        library.symbols.getpeername(fd, ptr(remote), ptr(rl)) !== 0
      )
        continue;
      const a = decode(local);
      const b = decode(remote);
      if (a && b && (side === 'server' ? a === port : b === port))
        rows.push({ fd, local: a, remote: b });
    }
    return rows;
  } finally {
    library.close();
  }
}

export function boundResourceSocket(fd: number, direction: 'send' | 'receive'): number {
  const darwin = process.platform === 'darwin';
  const library = dlopen(darwin ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6', {
    setsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    getsockopt: {
      args: [FFIType.i32, FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.ptr],
      returns: FFIType.i32,
    },
  });
  const option = darwin ? (direction === 'send' ? 0x1001 : 0x1002) : direction === 'send' ? 7 : 8;
  try {
    const wanted = new Int32Array([4096]);
    const actual = new Int32Array(1);
    const length = new Uint32Array([4]);
    assert.equal(library.symbols.setsockopt(fd, darwin ? 0xffff : 1, option, ptr(wanted), 4), 0);
    assert.equal(
      library.symbols.getsockopt(fd, darwin ? 0xffff : 1, option, ptr(actual), ptr(length)),
      0,
    );
    const capacity = actual[0];
    assert(capacity !== undefined && capacity > 0 && capacity <= 8192);
    return capacity;
  } finally {
    library.close();
  }
}

export interface TerminalResourcePeerSpec {
  readonly port: number;
  readonly ca: string;
  readonly serverPublicKey: string;
  readonly sessionId: string;
  readonly binding: TerminalViewBinding;
  readonly identities: readonly RemiIdentity[];
}
interface PeerState {
  ready: boolean;
  localPort: number;
  receiverCapacity: number;
  viewId: string;
  requests: string[];
  frames: { type: string; requestId: string; bytes: number; digest: string }[];
}

export async function runTerminalResourcePeers(specPath: string, prefix: string): Promise<never> {
  const spec = JSON.parse(fs.readFileSync(specPath, 'utf8')) as TerminalResourcePeerSpec;
  assert(spec.identities.length > 0 && spec.identities.length <= 4);
  const peers: ReturnType<typeof terminalPacketPeer>[] = [];
  const states: PeerState[] = [];
  let failure: unknown;
  let sequence = 0;
  let exiting = false;
  const report = () => publishResourceReceipt(`${prefix}.state`, { pid: process.pid, states });
  const until = async (check: () => boolean) => {
    const end = performance.now() + 10000;
    while (!check()) {
      if (failure) throw failure;
      assert(performance.now() < end, 'owned signed peer startup deadline');
      await Bun.sleep(1);
    }
  };
  for (const stored of spec.identities) {
    const identity = await unlockIdentity(stored);
    const previous = new Set(resourceSocketTuples(spec.port, 'client').map((row) => row.local));
    const peer = terminalPacketPeer(spec.port, spec.ca);
    const state: PeerState = {
      ready: false,
      localPort: 0,
      receiverCapacity: 0,
      viewId: '',
      requests: [],
      frames: [],
    };
    peers.push(peer);
    states.push(state);
    let helloId = '';
    peer.onerror = (error) => {
      failure = error;
    };
    peer.onmessage = async ({ data }) => {
      try {
        // Fixture-only real native pressure frames carry no application JSON.
        if (!data.startsWith('{')) return;
        const message = JSON.parse(data);
        if (message.type === 'auth_challenge') {
          assert.equal(message.serverPublicKey, spec.serverPublicKey);
          peer.send(
            serialize(
              createAuthResponse(
                identity.publicKeyRaw,
                await sign(identity.privateKey, fromBase64(message.challenge)),
                identity.fingerprint,
              ),
            ),
          );
        } else if (message.type === 'auth_result') {
          assert.equal(message.success, true, 'actual signed resource peer admitted');
          const hello = createHello(randomUUID(), 'owned resource peer');
          helloId = hello.id;
          peer.send(serialize(hello));
        } else if (message.type === 'ack' && message.ack?.messageId === helloId) {
          state.ready = true;
        } else if (message.type === 'ping') peer.send(serialize(createPong(message.id)));
        const terminal = decodeTerminalViewFrame(data);
        if (terminal && 'requestId' in terminal) {
          if (terminal.type === 'session_terminal_opened') state.viewId = terminal.viewId;
          state.frames.push({
            type: terminal.type,
            requestId: terminal.requestId,
            bytes: Buffer.byteLength(data),
            digest: createHash('sha256').update(data).digest('hex'),
          });
          if (state.frames.length > 16) state.frames.shift();
          report();
        }
      } catch (error) {
        failure = error;
      }
    };
    await until(() => state.ready);
    const fresh = resourceSocketTuples(spec.port, 'client').filter(
      (row) => !previous.has(row.local),
    );
    assert.equal(fresh.length, 1, 'one actual newly authenticated TLS descriptor');
    const tuple = fresh[0];
    assert(tuple);
    state.localPort = tuple.local;
    state.receiverCapacity = boundResourceSocket(tuple.fd, 'receive');
    report();
  }
  report();
  publishResourceReceipt(`${prefix}.ready`, { pid: process.pid, peers: states.length });
  const timer = setInterval(() => {
    try {
      if (failure) throw failure;
      for (const peer of peers) if (peer.hasPendingPong()) peer.confirmPong();
      const path = `${prefix}.command`;
      if (fs.existsSync(path)) {
        const command = JSON.parse(fs.readFileSync(path, 'utf8')) as {
          sequence: number;
          action: 'open' | 'read' | 'read-all' | 'close' | 'exit';
          index?: number;
          twice?: boolean;
          afterRevision?: number | null;
        };
        if (command.sequence > sequence) {
          sequence = command.sequence;
          if (command.action === 'exit') {
            exiting = true;
            for (const peer of peers) peer.close();
          } else {
            const indices =
              command.action === 'read-all'
                ? states.map((_, index) => index)
                : [command.index ?? 0];
            for (const index of indices) {
              const peer = peers[index];
              const state = states[index];
              assert(peer && state);
              const request = (): TerminalViewRequest => {
                const header = {
                  id: randomUUID(),
                  timestamp: new Date().toISOString(),
                  sessionId: spec.sessionId,
                };
                if (command.action === 'open')
                  return { ...header, type: 'session_terminal_open', binding: spec.binding };
                assert(state.viewId, 'resource peer owns an actual opaque view');
                return command.action === 'close'
                  ? { ...header, type: 'session_terminal_close', viewId: state.viewId }
                  : {
                      ...header,
                      type: 'session_terminal_read',
                      viewId: state.viewId,
                      afterRevision: command.afterRevision ?? null,
                    };
              };
              const values = Array.from({ length: command.twice ? 2 : 1 }, request);
              state.requests = values.map((value) => value.id);
              if (values.length === 2) peer.sendBatch(values.map(encodeTerminalViewFrame));
              else {
                const value = values[0];
                assert(value);
                peer.send(encodeTerminalViewFrame(value));
              }
            }
            publishResourceReceipt(`${prefix}.sent`, { sequence });
            report();
          }
        }
      }
      if (exiting && peers.every((peer) => peer.readyState === WebSocket.CLOSED)) {
        clearInterval(timer);
        process.exit(0);
      }
    } catch (error) {
      clearInterval(timer);
      fs.writeFileSync(
        `${prefix}.error`,
        error instanceof Error ? (error.stack ?? error.message) : String(error),
        { mode: 0o600 },
      );
      process.exit(1);
    }
  }, 2);
  return new Promise<never>(() => {});
}
