/**
 * X2's actual source CLI hub/child, workerd SQLite and owned TLS/APNs boundary (#1242).
 * Reuses cli-native-answer-supervisor.ts; Swift owns pairing, registration, opening and signing.
 * JSON lines are fixture IPC, never protocol messages or an alternate answer authority.
 * Run this TLS proxy on Bun 1.4.2; REVIEW_CLI_BUN may select the source CLI/child executable.
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';

// The Swift launcher must choose this empty private cwd BEFORE Bun can load any .env file.
const launchDirectory = fs.realpathSync(process.cwd());
const launchStat = fs.statSync(launchDirectory);
if (
  !/^remi-swift-secure-launch-[A-Za-z0-9-]+$/.test(basename(launchDirectory)) ||
  launchStat.uid !== process.getuid?.() ||
  (launchStat.mode & 0o077) !== 0 ||
  fs.readdirSync(launchDirectory).length !== 0
)
  throw new Error('owned-empty-launch-directory-required');
const reference = fs.realpathSync(resolve(process.argv[2] ?? ''));
const expectedHead = '1e96c688f89409043e17177c1914d8eec247de7e';
const sourceHead = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: reference,
  encoding: 'utf8',
}).trim();
if (sourceHead !== expectedHead) throw new Error('source-head-mismatch');
if (execFileSync('git', ['status', '--porcelain'], { cwd: reference, encoding: 'utf8' }).trim())
  throw new Error('source-checkout-not-clean');
if (Bun.version !== '1.4.2') throw new Error('owned-tls-proxy-requires-bun-1.4.2');
const cliRuntime = fs.realpathSync(process.env['REVIEW_CLI_BUN'] ?? process.execPath);
const cliVersion = execFileSync(cliRuntime, ['--version'], {
  cwd: launchDirectory,
  env: { PATH: process.env['PATH'], TMPDIR: process.env['TMPDIR'] },
  encoding: 'utf8',
}).trim();
if (cliVersion !== '1.3.11' && cliVersion !== '1.4.2')
  throw new Error('owned-source-cli-requires-bun-1.3.11-or-1.4.2');
const own = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'remi-swift-secure-push-')));
fs.chmodSync(own, 0o700);
const directory = join(own, 'work');
const state = join(own, 'state');
const driver = join(own, 'driver');
const bin = join(own, 'bin');
for (const folder of [directory, state, driver, bin]) fs.mkdirSync(folder, { mode: 0o700 });
process.env['REMI_HOME'] = state;
const { startWorker } = await import(`${reference}/packages/signaling/tests/e2e/harness.ts`);
const { reserveRange } = await import(
  `${reference}/packages/daemon/tests/session/port-test-helpers.ts`
);
const { CAPABILITY_HEADER } = await import(
  `${reference}/packages/daemon/src/auth/capability-token.ts`
);
const { MAX_APNS_PAYLOAD_BYTES, MAX_PUSH_SUBMIT_BYTES } = await import(
  `${reference}/packages/shared/src/relay/constants.ts`
);
const caCertificatePath = join(own, 'tls-ca.pem');
const faultPath = join(own, 'transport-control.json');
const receiptPath = join(own, 'transport-receipts.json');
// Lifecycle probes inspect the real transport before the first native answer.
fs.writeFileSync(receiptPath, JSON.stringify({ nativeForwards: 0, lostResults: 0 }), {
  mode: 0o600,
  flag: 'wx',
});
const out = (message: object) => process.stdout.write(`${JSON.stringify(message)}\n`);
const tunnels = new Set<Duplex>();
// Owned transport fault only: discard upstream bytes after the real client
// reaches READY. No protocol/business result is decoded, minted or substituted.
const clients = new Set<{ discard: boolean }>();
let clientConnections = 0;
let clientConnectionsAtStall = 0;
let discardedClientBytes = 0;
type ProcessProof = { pid: number; description: string; marker: string; parent: number };
type LiveEntry = {
  pid: number;
  wsPort: number;
  hookPort: number;
  sessionId: string;
  claudeChildPid: number;
  projectPath: string;
};
const proofs = new Map<number, ProcessProof>();
let hub: ReturnType<typeof Bun.spawn> | undefined;
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
let control: WebSocket | undefined;
let offer: Record<string, unknown> | undefined;
let comparison: Record<string, unknown> | undefined;
let confirmedFingerprint: string | undefined;
let confirmedDevicePublicKey: string | undefined;
let hookAbort: AbortController | undefined;
let hookPending = false;
let ending = false;
let failed = false;
let apnsCount = 0;
let gatewayFailures = 0;
let admitted = false;
let admissionWindow = '';
let cleanupPromise: Promise<void> | undefined;
let revokeResolve: ((message: Record<string, unknown>) => void) | undefined;

async function bounded<T>(promise: Promise<T>, label: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`deadline:${label}`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(check: () => boolean, label: string, milliseconds = 20000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`deadline:${label}`);
    await Bun.sleep(20);
  }
}
function description(pid: number) {
  return execFileSync('/bin/ps', ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,command='], {
    encoding: 'utf8',
  }).trim();
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}
function capture(pid: number, marker: string, parent: number): ProcessProof {
  const record = description(pid);
  const parts = record.split(/\s+/);
  const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
  });
  if (
    Number(parts[0]) !== pid ||
    Number(parts[1]) !== parent ||
    !record.includes(marker) ||
    !cwd.split('\n').includes(`n${directory}`)
  )
    throw new Error('owned-process-proof-refused');
  const previous = proofs.get(pid);
  if (previous && previous.description !== record) throw new Error('owned-process-birth-changed');
  const proof = { pid, description: record, marker, parent };
  proofs.set(pid, proof);
  return proof;
}
function captureIfAlive(pid: number, marker: string, parent: number): ProcessProof | undefined {
  try {
    if (!alive(pid)) return undefined;
    return capture(pid, marker, parent);
  } catch (error) {
    // ps/lsof can race natural exit. A still-live or reused PID must pass the complete proof.
    if (!alive(pid)) return undefined;
    throw error;
  }
}
function sameProcess(proof: ProcessProof) {
  return captureIfAlive(proof.pid, proof.marker, proof.parent)?.description === proof.description;
}
async function stopProcess(proof: ProcessProof) {
  if (!sameProcess(proof)) return;
  try {
    process.kill(proof.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH' && !alive(proof.pid)) return;
    throw error;
  }
  try {
    await until(() => !alive(proof.pid), 'owned-process-term', 5000);
  } catch {
    if (!sameProcess(proof)) return;
    try {
      process.kill(proof.pid, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH' && !alive(proof.pid)) return;
      throw error;
    }
    await until(() => !alive(proof.pid), 'owned-process-kill', 3000);
  }
}
function entries(): LiveEntry[] {
  const folder = join(state, 'live-sessions');
  if (!fs.existsSync(folder)) return [];
  return fs
    .readdirSync(folder)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const entry = JSON.parse(fs.readFileSync(join(folder, name), 'utf8')) as LiveEntry;
      if (
        entry.projectPath !== directory ||
        !Number.isSafeInteger(entry.pid) ||
        !Number.isSafeInteger(entry.wsPort) ||
        !Number.isSafeInteger(entry.hookPort)
      )
        throw new Error('owned-registry-refused');
      return entry;
    });
}
async function childEntry() {
  let entry: LiveEntry | undefined;
  await until(() => {
    const rows = entries();
    if (rows.length > 1) throw new Error('owned-single-child-required');
    entry = rows[0];
    return (
      !!entry && Number.isSafeInteger(entry.claudeChildPid) && fs.existsSync(join(driver, 'pid'))
    );
  }, 'actual-created-child');
  if (!entry || !hub) throw new Error('owned-child-missing');
  capture(entry.pid, `${reference}/packages/daemon/src/cli.ts`, hub.pid);
  capture(entry.claudeChildPid, join(bin, 'claude'), entry.pid);
  return entry;
}
async function cleanup() {
  cleanupPromise ??= (async () => {
    ending = true;
    const cleanupFailures: string[] = [];
    const attempt = async (label: string, operation: () => void | Promise<void>) => {
      try {
        await operation();
      } catch {
        failed = true;
        cleanupFailures.push(label);
      }
    };
    await attempt('hook-abort', () => hookAbort?.abort());
    await attempt('control-close', () => control?.close());
    let children: LiveEntry[] = [];
    await attempt('registry-read', () => {
      children = entries();
    });
    for (const entry of children) {
      await attempt('child-proof', () => {
        if (!hub) throw new Error('owned-child-without-hub');
        captureIfAlive(entry.pid, `${reference}/packages/daemon/src/cli.ts`, hub.pid);
      });
      await attempt('driver-proof', () => {
        if (Number.isSafeInteger(entry.claudeChildPid))
          captureIfAlive(entry.claudeChildPid, join(bin, 'claude'), entry.pid);
      });
    }
    await attempt('driver-release', () => {
      fs.writeFileSync(join(driver, 'release'), '', { mode: 0o600 });
    });
    // Driver exits first so its verified parent is still alive if a forced stop is necessary.
    for (const entry of children) {
      const driverProof = proofs.get(entry.claudeChildPid);
      if (driverProof)
        await attempt('driver-stop', async () => {
          try {
            await until(() => !alive(driverProof.pid), 'owned-driver-natural-exit', 2000);
          } catch {
            await stopProcess(driverProof);
          }
        });
      const childProof = proofs.get(entry.pid);
      if (childProof) await attempt('child-stop', () => stopProcess(childProof));
    }
    for (const proof of [...proofs.values()].reverse())
      await attempt('process-stop', () => stopProcess(proof));
    for (const tunnel of tunnels)
      await attempt('tunnel-close', () => {
        tunnel.destroy();
      });
    await attempt('tls-connections-close', () => gateway.closeAllConnections());
    await attempt('apns-connections-close', () => apns.closeAllConnections());
    if (gateway.listening)
      await attempt('tls-close', () =>
        bounded(
          new Promise<void>((done, reject) =>
            gateway.close((error) => (error ? reject(error) : done())),
          ),
          'tls-close',
        ),
      );
    if (apns.listening)
      await attempt('apns-close', () =>
        bounded(
          new Promise<void>((done, reject) =>
            apns.close((error) => (error ? reject(error) : done())),
          ),
          'apns-close',
        ),
      );
    const ownedWorker = worker;
    if (ownedWorker)
      await attempt('workerd-stop', () => bounded(ownedWorker.stop(), 'workerd-stop', 15000));
    // Retain private scratch receipts on success and failure; never print fixture private keys.
    await attempt('cleanup-receipt', () =>
      fs.writeFileSync(
        join(own, 'result.json'),
        JSON.stringify({ sourceHead, failed, apnsCount, gatewayFailures, cleanupFailures }),
        { mode: 0o600 },
      ),
    );
  })();
  return cleanupPromise;
}

// Only a real owned child WebSocket result delivery changes. The source core and outcome stay real.
const preloadPath = join(own, 'owned-result-boundary.ts');
fs.writeFileSync(
  preloadPath,
  `import * as fs from 'node:fs';
const controlPath = ${JSON.stringify(faultPath)}, receiptsPath = ${JSON.stringify(receiptPath)};
const Original = globalThis.WebSocket;
let nativeForwards = 0, lostResults = 0;
function save() { fs.writeFileSync(receiptsPath, JSON.stringify({ nativeForwards, lostResults }), { mode: 0o600 }); }
function target(url) { if (!fs.existsSync(controlPath)) return null; const c = JSON.parse(fs.readFileSync(controlPath, 'utf8')); return url === 'ws://127.0.0.1:' + c.childPort + '/ws' ? c : null; }
class OwnedResultBoundary extends Original {
  constructor(...args) { super(...args); const send = this.send; this.send = (...values) => { const c = target(this.url); if (c && typeof values[0] === 'string' && JSON.parse(values[0]).type === 'native_answer') { nativeForwards++; save(); } return Reflect.apply(send, this, values); }; }
  get onmessage() { return super.onmessage; }
  set onmessage(callback) { super.onmessage = callback === null ? null : function(event) { const c = target(this.url); if (c && c.armed && typeof event.data === 'string') { const m = JSON.parse(event.data); if (m.type === 'answer_result' && m.requestId === c.requestId) { fs.writeFileSync(controlPath, JSON.stringify({ ...c, armed: false }), { mode: 0o600 }); lostResults++; save(); this.close(1000, 'owned-result-loss'); return; } } callback.call(this, event); }; }
}
globalThis.WebSocket = OwnedResultBoundary;
save();
`,
  { mode: 0o600 },
);
fs.writeFileSync(
  join(bin, 'claude'),
  `#!/bin/sh
if [ "$1" = "--version" ]; then printf 'owned-claude-fixture\\n'; exit 0; fi
d="$FAKE_CLAUDE_DIR"
echo $$ > "$d/pid"
project="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"
mkdir -p "$project"
: > "$project/$2.jsonl"
i=0
while [ ! -e "$d/release" ] && [ $i -lt 1800 ]; do sleep 0.1; i=$((i + 1)); done
`,
  { mode: 0o700 },
);
fs.writeFileSync(
  join(own, 'openssl.cnf'),
  '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=owned-remi-x2\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n',
  { mode: 0o600 },
);
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
    join(own, 'tls-key.pem'),
    '-out',
    caCertificatePath,
    '-config',
    join(own, 'openssl.cnf'),
  ],
  { stdio: 'ignore' },
);
fs.chmodSync(join(own, 'tls-key.pem'), 0o600);

const apns = createHttpServer(async (request, response) => {
  try {
    if (request.method !== 'POST' || !/^\/3\/device\/[0-9a-f]{64}$/.test(request.url ?? ''))
      throw new Error('owned-apns-request-refused');
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_APNS_PAYLOAD_BYTES) throw new Error('apns-byte-bound');
      chunks.push(Buffer.from(chunk));
    }
    const original = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { remiPush?: unknown };
    if (!original.remiPush || apnsCount >= 64) throw new Error('apns-carrier-refused');
    apnsCount++;
    out({ kind: 'push', carrier: original.remiPush });
    response.writeHead(200);
    response.end();
  } catch {
    failed = true;
    response.writeHead(400);
    response.end();
  }
});
const gateway = createHttpsServer(
  { key: fs.readFileSync(join(own, 'tls-key.pem')), cert: fs.readFileSync(caCertificatePath) },
  async (request, response) => {
    try {
      if (request.url === '/health') {
        response.writeHead(200);
        response.end('owned');
        return;
      }
      if (
        !worker ||
        request.method !== 'POST' ||
        !/^\/v2\/push\/[0-9a-f]{32}$/.test(request.url ?? '')
      )
        throw new Error('gateway-route-refused');
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > MAX_PUSH_SUBMIT_BYTES) throw new Error('gateway-byte-bound');
        chunks.push(Buffer.from(chunk));
      }
      const reply = await fetch(worker.url + request.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(request.headers.authorization
            ? { authorization: request.headers.authorization }
            : {}),
        },
        body: Buffer.concat(chunks),
        redirect: 'error',
      });
      response.writeHead(reply.status, { 'content-type': 'application/json' });
      response.end(await reply.text());
    } catch {
      failed = true;
      gatewayFailures++;
      response.writeHead(503);
      response.end('{}');
    }
  },
);
gateway.on('upgrade', (request, socket, head) => {
  if (!worker) {
    socket.destroy();
    return;
  }
  const upstream = new URL(worker.url);
  const target = connectTcp(Number(upstream.port), upstream.hostname);
  const client = /^\/v2\/client\/[0-9a-f]{32}$/.test(request.url ?? '')
    ? { discard: false }
    : undefined;
  if (client) {
    clients.add(client);
    clientConnections++;
  }
  tunnels.add(socket);
  tunnels.add(target);
  socket.on('error', () => target.destroy());
  target.on('error', () => socket.destroy());
  // Propagate half-close on upgraded TLS streams. Without this, the owned
  // proxy retains ended client tunnels and cannot prove one-shot retirement.
  socket.on('end', () => {
    if (client) clients.delete(client);
    target.destroy();
    socket.destroy();
  });
  target.on('end', () => {
    if (client) clients.delete(client);
    socket.destroy();
    target.destroy();
  });
  socket.on('close', () => {
    if (client) clients.delete(client);
    tunnels.delete(socket);
    target.destroy();
  });
  target.on('close', () => {
    tunnels.delete(target);
    socket.destroy();
  });
  target.on('connect', () => {
    target.write(
      `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce((lines, value, index) => lines + value + (index % 2 === 0 ? ': ' : '\r\n'), '')}\r\n`,
    );
    if (head.length) target.write(head);
    socket.on('data', (bytes) => {
      if (!target.write(bytes)) socket.pause();
    });
    target.on('drain', () => socket.resume());
    target.on('data', (bytes) => {
      if (client?.discard) {
        discardedClientBytes += bytes.length;
        return;
      }
      if (!socket.write(bytes)) target.pause();
    });
    socket.on('drain', () => target.resume());
    socket.resume();
    target.resume();
  });
});

const deadline = setTimeout(() => {
  failed = true;
  void cleanup().finally(() => process.exit(1));
}, 180000);
process.on('SIGTERM', () => {
  failed = true;
  void cleanup().finally(() => process.exit(1));
});
try {
  await new Promise<void>((done) => apns.listen(0, '127.0.0.1', done));
  await new Promise<void>((done) => gateway.listen(0, '127.0.0.1', done));
  const aa = apns.address();
  const ga = gateway.address();
  if (!aa || typeof aa === 'string' || !ga || typeof ga === 'string')
    throw new Error('owned-listeners-refused');
  const audience = `https://127.0.0.1:${ga.port}`;
  // Pairing tokens require a WebSocket URL; the source derives this same HTTPS push audience.
  const relayOrigin = `wss://127.0.0.1:${ga.port}`;
  const pushSecret = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const apnsKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', apnsKey.privateKey));
  const pemLines = der.toString('base64').match(/.{1,64}/g);
  if (!pemLines) throw new Error('owned-apns-key-generation-refused');
  worker = await startWorker(
    {
      PUSH_AUDIENCE: audience,
      APNS_KEY_ID: 'OWNEDTEST1',
      APNS_TEAM_ID: 'OWNEDTEAM1',
      APNS_PRIVATE_KEY: `-----BEGIN PRIVATE KEY-----\n${pemLines.join('\n')}\n-----END PRIVATE KEY-----`,
      APNS_BUNDLE_ID: 'owned.synthetic.topic',
      TEST_APNS_ENDPOINT: `http://127.0.0.1:${aa.port}`,
      PUSH_SECRET: pushSecret,
    },
    false,
    { path: join(own, 'worker-sqlite') },
  );
  const env = {
    HOME: own,
    REMI_HOME: state,
    TMPDIR: own,
    PATH: `${bin}:/usr/bin:/bin:/usr/sbin:/sbin`,
    NODE_ENV: 'test',
    TERM: 'xterm-256color',
    FAKE_CLAUDE_DIR: driver,
    NODE_EXTRA_CA_CERTS: caCertificatePath,
    REMI_PUSH_SECRET: pushSecret,
  };
  const healthPath = join(own, 'tls-health.ts');
  fs.writeFileSync(
    healthPath,
    `await Bun.stdin.text();const r=await fetch(${JSON.stringify(`${audience}/health`)});if(r.status!==200||await r.text()!=='owned')process.exit(1);`,
    { mode: 0o600 },
  );
  const health = Bun.spawn([cliRuntime, healthPath], {
    env,
    cwd: directory,
    stdin: 'pipe',
    stdout: 'ignore',
    stderr: 'pipe',
  });
  capture(health.pid, healthPath, process.pid);
  health.stdin.end();
  const healthErrors = new Response(health.stderr).text();
  if (
    (await bounded(health.exited, 'verified-source-tls-health')) !== 0 ||
    (await healthErrors).length !== 0
  )
    throw new Error('verified-source-tls-health-refused');
  const port = await reserveRange(1, 50, '127.0.0.1');
  fs.writeFileSync(
    join(state, 'config.toml'),
    `[daemon]\nbase_port = ${port}\nport_range = 20\n[network]\nrelay = true\nsignaling_url = "${relayOrigin}"\nmdns = false\ntelegram = false\n[auth]\nenabled = true\n`,
    { mode: 0o600 },
  );
  hub = Bun.spawn(
    [
      cliRuntime,
      '--preload',
      preloadPath,
      `${reference}/packages/daemon/src/cli.ts`,
      'serve',
      '--relay',
      '--auth',
      '--signaling-url',
      relayOrigin,
      '--port',
      String(port),
      '--no-mdns',
      '--no-telegram',
    ],
    { cwd: directory, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  capture(hub.pid, `${reference}/packages/daemon/src/cli.ts`, process.pid);
  const consume = async (stream: ReadableStream<Uint8Array>, path: string) => {
    for await (const chunk of stream) {
      fs.appendFileSync(path, chunk, { mode: 0o600 });
      admissionWindow = (admissionWindow + new TextDecoder().decode(chunk)).slice(-512);
      if (admissionWindow.includes('Relay control admitted')) admitted = true;
    }
  };
  void consume(hub.stdout as ReadableStream<Uint8Array>, join(own, 'hub-stdout.log'));
  void consume(hub.stderr as ReadableStream<Uint8Array>, join(own, 'hub-stderr.log'));
  await until(() => {
    if (hub?.exitCode !== null) throw new Error('source-hub-exited');
    return admitted;
  }, 'source-hub-admission');
  if (Number(fs.readFileSync(join(state, 'daemon.pid'), 'utf8').trim()) !== hub.pid)
    throw new Error('source-hub-pid-mismatch');
  const capability = fs.readFileSync(join(state, 'capability.key'), 'utf8').trim();
  control = new WebSocket(`ws://127.0.0.1:${port}/relay-control`, {
    headers: { [CAPABILITY_HEADER]: capability },
  } as never);
  control.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as Record<string, unknown>;
    if (message['t'] === 'offer') {
      offer = message;
      out({ kind: 'offer', token: message['token'], directory, caCertificatePath, sourceHead });
    } else if (message['t'] === 'compare') {
      comparison = message;
      out({ kind: 'compare', fingerprint: message['fingerprint'] });
    } else if (message['t'] === 'revoked' && message['id'] === 'swift-revoke') {
      revokeResolve?.(message);
      revokeResolve = undefined;
    } else if (message['t'] === 'error') {
      failed = true;
      out({ kind: 'failed', reason: 'source-control-refused', scratchRoot: own });
    }
  };
  await bounded(
    new Promise<void>((done, reject) => {
      if (!control) return reject(new Error('control-missing'));
      control.onopen = () => done();
      control.onerror = () => reject(new Error('control-refused'));
    }),
    'source-local-control',
  );
  control.send(JSON.stringify({ t: 'pair', id: 'swift-pair' }));
  let pending = '';
  for await (const chunk of Bun.stdin.stream()) {
    pending += new TextDecoder().decode(chunk);
    if (Buffer.byteLength(pending) > 16384) throw new Error('ipc-byte-bound');
    let newline = pending.indexOf('\n');
    while (newline >= 0) {
      const command = JSON.parse(pending.slice(0, newline)) as Record<string, unknown>;
      pending = pending.slice(newline + 1);
      if (command['kind'] === 'confirm') {
        if (
          !offer ||
          !comparison ||
          command['fingerprint'] !== comparison['fingerprint'] ||
          typeof comparison['fingerprint'] !== 'string' ||
          typeof command['devicePublicKey'] !== 'string' ||
          Buffer.from(command['devicePublicKey'], 'base64').length !== 32 ||
          Buffer.from(command['devicePublicKey'], 'base64').toString('base64') !==
            command['devicePublicKey']
        )
          throw new Error('pair-comparison-refused');
        confirmedFingerprint = comparison['fingerprint'];
        confirmedDevicePublicKey = command['devicePublicKey'];
        control.send(
          JSON.stringify({
            t: 'confirm',
            id: 'swift-pair',
            offerId: offer['offerId'],
            connectionId: comparison['connectionId'],
            fingerprint: confirmedFingerprint,
            accept: true,
          }),
        );
      } else if (command['kind'] === 'question') {
        if (hookPending) throw new Error('previous-hook-pending');
        const entry = await childEntry();
        let binding: { remiSessionId: string; claudeSessionId: string } | undefined;
        await until(() => {
          const store = JSON.parse(fs.readFileSync(join(state, 'sessions.json'), 'utf8')) as {
            sessions: { remiSessionId: string; claudeSessionId: string }[];
          };
          binding = store.sessions.find(
            (record) =>
              record.remiSessionId === entry.sessionId &&
              typeof record.claudeSessionId === 'string' &&
              record.claudeSessionId.length > 0,
          );
          return !!binding;
        }, 'source-session-binding');
        if (!binding) throw new Error('source-binding-missing');
        hookAbort = new AbortController();
        hookPending = true;
        void fetch(`http://127.0.0.1:${entry.hookPort}/hooks`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: hookAbort.signal,
          body: JSON.stringify({
            hook_event_name: 'PermissionRequest',
            session_id: binding.claudeSessionId,
            cwd: directory,
            permission_mode: 'default',
            tool_name: 'Bash',
            tool_input: { command: 'printf OWNED_SWIFT_SECURE_PUSH' },
            permission_suggestions: [],
          }),
        })
          .then((response) => response.json())
          .then((body) => {
            hookPending = false;
            if (!ending) out({ kind: 'effect', body });
          })
          .catch(() => {
            hookPending = false;
            if (!ending) out({ kind: 'hook-aborted' });
          });
      } else if (command['kind'] === 'question_cancel') {
        if (!hookPending || !hookAbort) throw new Error('no-pending-hook');
        hookAbort.abort();
      } else if (command['kind'] === 'revoke') {
        if (command['fingerprint'] !== confirmedFingerprint || !confirmedFingerprint)
          throw new Error('revoke-owned-device-refused');
        const authorized = JSON.parse(
          fs.readFileSync(join(state, 'authorized_keys.json'), 'utf8'),
        ) as {
          keys: { publicKey: string; fingerprint: string }[];
        };
        if (
          !confirmedDevicePublicKey ||
          authorized.keys.length !== 1 ||
          authorized.keys[0]?.publicKey !== confirmedDevicePublicKey ||
          !/^[0-9a-f]{16}$/.test(authorized.keys[0]?.fingerprint ?? '')
        )
          throw new Error('revoke-owned-grant-mismatch');
        const deviceFingerprint = authorized.keys[0].fingerprint;
        const result = new Promise<Record<string, unknown>>((done) => {
          revokeResolve = done;
        });
        control.send(
          JSON.stringify({ t: 'revoke', id: 'swift-revoke', fingerprint: deviceFingerprint }),
        );
        const revoked = await bounded(result, 'source-revoke');
        out({
          kind: 'revoked',
          success: revoked['success'],
          edgeAcknowledged: revoked['edgeAcknowledged'],
          ...(revoked['error'] ? { error: revoked['error'] } : {}),
        });
      } else if (command['kind'] === 'lose_result') {
        if (
          typeof command['requestId'] !== 'string' ||
          command['requestId'].length < 1 ||
          command['requestId'].length > 128
        )
          throw new Error('loss-request-id-refused');
        const entry = await childEntry();
        fs.writeFileSync(
          faultPath,
          JSON.stringify({ childPort: entry.wsPort, requestId: command['requestId'], armed: true }),
          { mode: 0o600 },
        );
        out({ kind: 'lost-result-armed' });
      } else if (command['kind'] === 'stall_client_result') {
        await until(() => clients.size === 1, 'owned-prior-client-retired', 2000);
        if (clients.size !== 1 || clientConnectionsAtStall !== 0)
          throw new Error('owned-single-ready-client-required');
        for (const client of clients) client.discard = true;
        clientConnectionsAtStall = clientConnections;
        out({ kind: 'client-result-stall-armed' });
      } else if (command['kind'] === 'receipts') {
        const transport = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as {
          nativeForwards: number;
          lostResults: number;
        };
        out({
          kind: 'receipts',
          ...transport,
          apnsCount,
          gatewayFailures,
          clientConnections,
          clientConnectionsAtStall,
          activeClients: clients.size,
          discardedClientBytes,
        });
      } else if (command['kind'] === 'stop') {
        await cleanup();
        process.exit(failed ? 1 : 0);
      } else throw new Error('ipc-command-refused');
      newline = pending.indexOf('\n');
    }
  }
  throw new Error('ipc-ended-before-stop');
} catch {
  failed = true;
  out({ kind: 'failed', reason: 'owned-fixture-failed', scratchRoot: own });
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await cleanup();
  if (failed) process.exitCode = 1;
}
