/** Owned real direct authentication, Worker/HubRelay and subscription files; TLS only proxies bytes. */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';

const root = resolve(process.argv[2] ?? '');
const { resumedHub } = await import(`${root}/packages/daemon/tests/remote/hub-relay-fixture.ts`);
const { WebSocketServer } = await import(`${root}/packages/daemon/src/server/websocket-server.ts`);
const { Authenticator } = await import(`${root}/packages/daemon/src/auth/authenticator.ts`);
const { NotificationHostService } = await import(
  `${root}/packages/daemon/src/notifications/notification-host-service.ts`
);
const { SecurePushStore } = await import(
  `${root}/packages/daemon/src/notifications/secure-push-store.ts`
);
const { createHelloAck, createNotificationHostResponse } = await import(
  `${root}/packages/shared/src/index.ts`
);
const own = mkdtempSync(join(tmpdir(), 'remi-native-notifications-'));
chmodSync(own, 0o700);
const out = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
const hub = await resumedHub({ pushLeaseMs: 1000 });
const subscriptions = new SecurePushStore(hub.dir, hub.trust, 64, { leaseMs: 1000 });
const machine = await hub.trust.unlock();
writeFileSync(
  join(own, 'tls.cnf'),
  '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=owned-remi-notifications\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n',
  { mode: 0o600 },
);
const ca = join(own, 'ca.pem');
execFileSync(
  '/usr/bin/openssl',
  [
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '1',
    '-keyout',
    join(own, 'key.pem'),
    '-out',
    ca,
    '-config',
    join(own, 'tls.cnf'),
  ],
  { stdio: 'ignore' },
);
chmodSync(join(own, 'key.pem'), 0o600);
const tunnels = new Set<Duplex>();
const gateway = createServer(
  { key: readFileSync(join(own, 'key.pem')), cert: readFileSync(ca) },
  (_req, res) => {
    res.writeHead(404);
    res.end();
  },
);
gateway.on('upgrade', (req, socket, head) => {
  const upstream = new URL(hub.pin.relayUrl);
  const target = connect(Number(upstream.port), upstream.hostname);
  tunnels.add(socket);
  tunnels.add(target);
  socket.on('error', () => target.destroy());
  target.on('error', () => socket.destroy());
  socket.on('end', () => {
    target.destroy();
    socket.destroy();
  });
  target.on('end', () => {
    socket.destroy();
    target.destroy();
  });
  socket.on('close', () => {
    tunnels.delete(socket);
    target.destroy();
  });
  target.on('close', () => {
    tunnels.delete(target);
    socket.destroy();
  });
  target.on('connect', () => {
    target.write(
      `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${req.rawHeaders.reduce((lines, value, i) => lines + value + (i % 2 === 0 ? ': ' : '\r\n'), '')}\r\n`,
    );
    if (head.length) target.write(head);
    socket.pipe(target);
    target.pipe(socket);
  });
});
await new Promise<void>((yes) => gateway.listen(0, '127.0.0.1', yes));
const address = gateway.address();
if (!address || typeof address === 'string') throw new Error('OWNED_TLS_ADDRESS');
const relayUrl = `wss://127.0.0.1:${address.port}`;
let releaseEnable: (() => void) | undefined;
let enablePause: Promise<void> | undefined;
const direct = new WebSocketServer(
  {
    host: '127.0.0.1',
    port: 0,
    connection: {
      skipHelloAck: true,
      authenticator: new Authenticator({ identity: machine, identityStore: hub.trust }),
    },
  },
  {
    onClientConnect: (connection) => {
      direct.sendTo(connection.id, {
        ...createHelloAck('owned', null),
        capabilities: ['notifications'],
      });
    },
    onNotificationHostRequest: (id, request) => {
      void (async () => {
        if (request.action === 'enable' && enablePause) {
          out({ kind: 'host-waiting' });
          await enablePause;
        }
        const response = await service.handle(id, request);
        direct.sendTo(id, createNotificationHostResponse(request.id, response));
      })();
    },
  },
);
const service = new NotificationHostService({
  directory: hub.dir,
  trust: hub.trust,
  subscriptions,
  relay: () => hub.relay,
  senderReady: () => true,
  relayUrl,
  client: (id) => {
    const connection = direct.getConnection(id);
    const key = connection?.connectionClientPublicKey;
    return connection && key && connection.connectionState === 'connected'
      ? {
          publicKey: key,
          isCurrent: () =>
            direct.getConnection(id) === connection && connection.connectionState === 'connected',
        }
      : null;
  },
});
await direct.start();
out({ kind: 'ready', directPort: direct.port, machineKey: machine.publicKeyRaw, relayUrl, ca });
const lines = createInterface({ input: process.stdin });
const deadline = setTimeout(() => {
  lines.close();
}, 60_000);
try {
  for await (const line of lines) {
    const message = JSON.parse(line);
    if (message.kind === 'authorize') {
      await hub.trust.addAuthorizedKey(message.publicKey, 'owned Swift device');
      out({ kind: 'authorized' });
    } else if (message.kind === 'expire') {
      const file = join(hub.dir, 'secure_push_subscriptions.json');
      const data = JSON.parse(readFileSync(file, 'utf8'));
      for (const row of data.subscriptions) row.lastSeenAt = Date.now() - 2000;
      writeFileSync(file, JSON.stringify(data));
      out({ kind: 'expired' });
    } else if (message.kind === 'state') {
      const current = subscriptions.listCurrent();
      out({
        kind: 'state',
        count: current.length,
        tokenMatches: current.length === 1 && current[0]?.token === message.expectedToken,
      });
    } else if (message.kind === 'pause_enable') {
      enablePause = new Promise<void>((yes) => {
        releaseEnable = yes;
      });
      out({ kind: 'paused' });
    } else if (message.kind === 'release_enable') {
      releaseEnable?.();
      enablePause = undefined;
      out({ kind: 'released' });
    } else if (message.kind === 'stop') break;
  }
} finally {
  clearTimeout(deadline);
  lines.close();
  releaseEnable?.();
  await direct.stop();
  for (const socket of tunnels) socket.destroy();
  await new Promise<void>((yes) => gateway.close(() => yes()));
  await hub.cleanup();
  rmSync(own, { recursive: true, force: true });
}
