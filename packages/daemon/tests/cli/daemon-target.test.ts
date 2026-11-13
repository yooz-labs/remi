import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { createHello, serialize } from '@remi/shared';
import { CAPABILITY_HEADER, loadOrCreateCapabilityToken } from '../../src/auth/capability-token.ts';
import { resolveDaemonWsTarget } from '../../src/cli/daemon-target.ts';
import { WebSocketServer } from '../../src/server/websocket-server.ts';
import { readLocalDaemonEndpoint } from '../../src/storage/local-daemon-endpoints.ts';
import { directTlsFixture } from '../helpers/direct-tls-fixture.ts';

let fixture: ReturnType<typeof directTlsFixture>;
const servers: WebSocketServer[] = [];
const sockets: WebSocket[] = [];
beforeAll(() => {
  fixture = directTlsFixture();
});
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const server of servers.splice(0)) await server.stop();
});
afterAll(() => fixture.cleanup());

async function owned(home = fixture.home) {
  const token = loadOrCreateCapabilityToken(join(home, 'capability.key'));
  const server = new WebSocketServer({
    port: 0,
    host: '127.0.0.1',
    tls: fixture.tls,
    localControl: { home },
    capabilityToken: token,
  });
  servers.push(server);
  await server.start();
  return { server, token, home };
}

test('paired local target uses its owned sidecar and fresh matching-home token for actual WS', async () => {
  const first = await owned();
  for (const host of ['localhost', '127.0.0.1', '127.0.0.2', '::1', '[::1]']) {
    const target = resolveDaemonWsTarget(host, first.server.port, {
      home: first.home,
      expectedPid: process.pid,
    });
    expect(target.url).toBe(`ws://127.0.0.1:${first.server.localControlPort}/ws`);
    expect(target.options?.headers[CAPABILITY_HEADER]).toBe(first.token);
  }
  const target = resolveDaemonWsTarget('localhost', first.server.port, { home: first.home });
  const ws = new WebSocket(target.url, target.options as never);
  sockets.push(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('target WS timeout')), 3000);
    ws.onopen = () => ws.send(serialize(createHello('owned target', '1')));
    ws.onmessage = (event) => {
      if (JSON.parse(String(event.data)).type === 'hello_ack') {
        clearTimeout(timer);
        resolve();
      }
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error('target WS refused'));
    };
  });
  const second = await owned(join(fixture.directory, 'second-home'));
  const next = resolveDaemonWsTarget('localhost', second.server.port, { home: second.home });
  expect(next.options?.headers[CAPABILITY_HEADER] === first.token).toBe(false);
  fs.writeFileSync(join(second.home, 'capability.key'), 'owned-rotated-token');
  const rotated = resolveDaemonWsTarget('localhost', second.server.port, { home: second.home });
  expect(rotated.options?.headers[CAPABILITY_HEADER]).toBe('owned-rotated-token');
  expect(rotated.options === next.options).toBe(false);
});

test('noncanonical and remote targets return no capability without reading invalid local state', async () => {
  const { server, home } = await owned();
  const file = join(home, 'local-endpoints', `${server.port}.json`);
  const saved = fs.readFileSync(file);
  fs.writeFileSync(file, '{ invalid owned state');
  try {
    for (const host of [
      'remote.example',
      '192.0.2.1',
      '100.64.0.1',
      'localhost.',
      'LOCALHOST',
      '127.1',
      '0177.0.0.1',
      '[0:0:0:0:0:0:0:1]',
    ]) {
      const target = resolveDaemonWsTarget(host, server.port, { home });
      expect(target.options).toBeUndefined();
      expect(target.url).toBe(`ws://${host}:${server.port}/ws`);
    }
    expect(() => resolveDaemonWsTarget('localhost', server.port, { home })).toThrow(
      'Local daemon endpoint unavailable',
    );
  } finally {
    fs.writeFileSync(file, saved);
  }
  for (const host of [
    'wss://remote.example',
    'localhost/path',
    'localhost@remote.example',
    ' localhost',
  ])
    expect(() => resolveDaemonWsTarget(host, server.port, { home })).toThrow(
      'Invalid daemon target',
    );
});

test('expected PID, stale record and missing capability refuse without guessing a target', async () => {
  const { server, home } = await owned();
  expect(() =>
    resolveDaemonWsTarget('localhost', server.port, { home, expectedPid: process.pid + 1 }),
  ).toThrow('Local daemon endpoint unavailable');
  const result = readLocalDaemonEndpoint(server.port, { home });
  if (result.kind !== 'found') throw new Error('owned endpoint missing');
  const file = join(home, 'local-endpoints', `${server.port}.json`);
  const child = Bun.spawn([process.execPath, '-e', 'process.exit(0)'], {
    cwd: fixture.work,
    env: fixture.env,
  });
  await child.exited;
  fs.writeFileSync(file, JSON.stringify({ ...result.endpoint, pid: child.pid }));
  try {
    expect(() => resolveDaemonWsTarget('localhost', server.port, { home })).toThrow(
      'Local daemon endpoint unavailable',
    );
  } finally {
    fs.writeFileSync(file, JSON.stringify(result.endpoint));
  }
  fs.rmSync(join(home, 'capability.key'));
  expect(() => resolveDaemonWsTarget('localhost', server.port, { home })).toThrow(
    'Local daemon capability unavailable',
  );
});

test('absence selects exactly the legacy public WS URL and an actual off-machine upgrade carries no local token', async () => {
  const home = join(fixture.directory, 'legacy-home');
  const token = loadOrCreateCapabilityToken(join(home, 'capability.key'));
  let received: string | null | undefined;
  const server = Bun.serve({
    port: 0,
    hostname: '0.0.0.0',
    fetch(req, held) {
      received = req.headers.get(CAPABILITY_HEADER);
      if (held.upgrade(req)) return;
      return new Response('no');
    },
    websocket: { message() {} },
  });
  try {
    const port = server.port as number;
    expect(resolveDaemonWsTarget('localhost', port, { home }).url).toBe(
      `ws://localhost:${port}/ws`,
    );
    expect(
      resolveDaemonWsTarget('localhost', port, { home }).options?.headers[CAPABILITY_HEADER],
    ).toBe(token);
    const host = Object.values(networkInterfaces())
      .flat()
      .find((address) => address?.family === 'IPv4' && !address.internal)?.address;
    if (!host) throw new Error('No owned non-loopback interface for header capture');
    const target = resolveDaemonWsTarget(host, port, { home });
    const ws = new WebSocket(target.url, target.options as never);
    sockets.push(ws);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('upgrade timeout')), 3000);
      ws.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(timer);
        reject(new Error('upgrade refused'));
      };
    });
    expect(received).toBeNull();
  } finally {
    server.stop(true);
  }
});
