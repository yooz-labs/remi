import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { connect as connectTcp, createServer as createNetServer } from 'node:net';
/**
 * Actual source `serve` supervisor owns the room/PID and starts an actual source child from
 * an encrypted create request. Transparent owned TLS upgrade tunnels raw bytes to real
 * Worker SQLite. Original sealed APNs content and signed No reach the actual held hook.
 * Run on the validated TLS-proxy Bun with REVIEW_CLI_BUN set to the actual source CLI runtime.
 * The CLI-spawned child inherits that runtime. No installed model, owner keys or deployment.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import type { relayV2 as RelayTypes } from '../../packages/shared/src/index.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-r5-cli-route-')));
fs.chmodSync(root, 0o700);
const mode = 'root';
const scenario = 'supervisor';
const cliRuntime = fs.realpathSync(process.env['REVIEW_CLI_BUN'] ?? process.execPath);
const refusalNotice = '[SecurePush] unsupported signaling URL; secure push requires a root origin';
const repo = path.resolve(import.meta.dir, '../..');
const own = fs.mkdtempSync(`${root}/cli-https-${mode}-`);
fs.chmodSync(own, 0o700);
const home = path.join(own, 'home');
const work = path.join(own, 'work');
const state = path.join(own, 'state');
const fake = path.join(own, 'fake');
const bin = path.join(own, 'bin');
for (const dir of [home, work, state, fake, bin]) fs.mkdirSync(dir, { mode: 0o700 });
process.env['REMI_HOME'] = state;
const {
  relayV2,
  createIdentity,
  unlockIdentity,
  createHello,
  createCreateSessionRequest,
  generateId,
  serialize,
  deserialize,
} = await import('../../packages/shared/src/index.ts');
const { IdentityStore } = await import('../../packages/daemon/src/auth/identity-store.ts');
const { RelayDeviceStore } = await import('../../packages/daemon/src/remote/relay-device-store.ts');
const { SecurePushStore } = await import(
  '../../packages/daemon/src/notifications/secure-push-store.ts'
);
const { startWorker } = await import('../../packages/signaling/tests/e2e/harness.ts');
const { Socket, admit, clientUrl } = await import(
  '../../packages/signaling/tests/e2e/endpoints.ts'
);
function assert(value: unknown, label: string): asserts value {
  if (!value) throw new Error(label);
  checks.push(label);
}
const checks: string[] = [];
async function until(test: () => boolean, label: string, limit = 15000) {
  const deadline = Date.now() + limit;
  while (!test()) {
    if (Date.now() >= deadline) throw new Error(`timeout:${label}`);
    await Bun.sleep(25);
  }
}
async function bounded<T>(promise: Promise<T>, label: string, ms = 8000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timeout:${label}`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function closeServer(server: ReturnType<typeof createHttpServer>) {
  server.closeAllConnections();
  if (server.listening)
    await bounded(
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
      'server-close',
    );
}
let worker: Awaited<ReturnType<typeof startWorker>> | undefined;
let childPid: number | undefined;
let childBirth = '';
let tlsUpgrades = 0;
const tunnelReceipts: Array<{
  role: string;
  upstreamBytes: number;
  downstreamBytes: number;
  status: string;
}> = [];
const tunnels = new Set<import('node:stream').Duplex>();
const connections: Array<{
  socket: Awaited<ReturnType<typeof Socket.open>>;
  channel: RelayTypes.Channel;
  stopReader: () => void;
  drain: () => Promise<void>;
}> = [];
let cli: Bun.Subprocess<'ignore', 'pipe', 'pipe'> | undefined;
let hook: Promise<string> | undefined;
let hookAbort: AbortController | undefined;
let out = '';
let cliErr = '';
let completed = false;
let failure = '';
const apnsBodies: string[] = [];
const gatewayReplies: number[] = [];
const gatewayPostPaths: string[] = [];
let cliBirth = '';
function requireOwnedCli() {
  if (!cli || cli.exitCode !== null) throw new Error('owned-cli-not-live');
  const record = execFileSync(
    '/bin/ps',
    ['-p', String(cli.pid), '-o', 'pid=,ppid=,lstart=,command='],
    { encoding: 'utf8' },
  ).trim();
  if (!record.includes(`${repo}/packages/daemon/src/cli.ts`))
    throw new Error('owned-cli-command-changed');
  const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(cli.pid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
  });
  if (!cwd.split('\n').includes(`n${work}`)) throw new Error('owned-cli-cwd-changed');
  if (cliBirth && cliBirth !== record) throw new Error('owned-cli-birth-changed');
  cliBirth = record;
  return true;
}
function processAlive(pid: number | undefined) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function requireOwnedChild() {
  if (!childPid) throw new Error('owned-created-child-missing');
  const record = execFileSync(
    '/bin/ps',
    ['-p', String(childPid), '-o', 'pid=,ppid=,lstart=,command='],
    { encoding: 'utf8' },
  ).trim();
  const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(childPid), '-d', 'cwd', '-Fn'], {
    encoding: 'utf8',
  });
  if (
    !record.includes(`${repo}/packages/daemon/src/cli.ts`) ||
    !record.includes('--daemon') ||
    !record.includes('--relay') ||
    !record.includes('--auth') ||
    !record.includes(audienceForChild()) ||
    !cwd.split('\n').includes(`n${work}`) ||
    (childBirth && childBirth !== record)
  )
    throw new Error('owned-created-child-binding-changed');
  return record;
}
function audienceForChild() {
  const address = gateway?.address();
  if (!address || typeof address === 'string') throw new Error('gateway-not-live');
  return `https://127.0.0.1:${address.port}`;
}
const gatewayErrors: string[] = [];
const apns = createHttpServer(async (request, response) => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  apnsBodies.push(Buffer.concat(chunks).toString('utf8'));
  response.writeHead(200);
  response.end();
});
let gateway: ReturnType<typeof createHttpsServer> | undefined;
try {
  fs.writeFileSync(
    path.join(own, 'openssl.cnf'),
    '[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=owned-remi-review\n[ext]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyCertSign\nextendedKeyUsage=serverAuth\n',
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
      path.join(own, 'tls-key.pem'),
      '-out',
      path.join(own, 'tls-ca.pem'),
      '-config',
      path.join(own, 'openssl.cnf'),
    ],
    { stdio: 'ignore' },
  );
  fs.chmodSync(path.join(own, 'tls-key.pem'), 0o600);
  gateway = createHttpsServer(
    {
      key: fs.readFileSync(path.join(own, 'tls-key.pem')),
      cert: fs.readFileSync(path.join(own, 'tls-ca.pem')),
    },
    async (request, response) => {
      try {
        if (request.url === '/health') {
          response.writeHead(200);
          response.end('owned');
          return;
        }
        assert(worker, 'worker-before-gateway-request');
        if (request.method === 'POST') gatewayPostPaths.push(request.url ?? '<missing>');
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const body = Buffer.concat(chunks);
        if (body.length > 8192) throw new Error('gateway-byte-bound');
        if (!request.method) throw new Error('gateway-method-missing');
        const reply = await fetch(worker.url + request.url, {
          method: request.method,
          headers: {
            'content-type': 'application/json',
            ...(request.headers.authorization
              ? { authorization: request.headers.authorization }
              : {}),
          },
          body,
          redirect: 'error',
        });
        gatewayReplies.push(reply.status);
        response.writeHead(reply.status, { 'content-type': 'application/json' });
        response.end(await reply.text());
      } catch (e) {
        gatewayErrors.push(e instanceof Error ? e.message : 'gateway-failed');
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
    tlsUpgrades++;
    const tunnelReceipt = {
      role: request.url?.split('/')[2] ?? '',
      upstreamBytes: 0,
      downstreamBytes: 0,
      status: '',
    };
    tunnelReceipts.push(tunnelReceipt);
    socket.on('data', (bytes) => {
      tunnelReceipt.upstreamBytes += bytes.length;
    });
    const upstream = new URL(worker.url);
    const target = connectTcp(Number(upstream.port), upstream.hostname);
    tunnels.add(socket);
    tunnels.add(target);
    target.on('data', (bytes) => {
      tunnelReceipt.downstreamBytes += bytes.length;
      if (!tunnelReceipt.status)
        tunnelReceipt.status = bytes.toString('ascii').split('\r\n')[0] ?? '';
    });
    socket.on('error', () => target.destroy());
    target.on('error', () => socket.destroy());
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
        `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n${request.rawHeaders.reduce(
          (lines, value, index) => lines + value + (index % 2 === 0 ? ': ' : '\r\n'),
          '',
        )}\r\n`,
      );
      if (head.length) target.write(head);
      socket.on('data', (bytes) => {
        if (!target.write(bytes)) socket.pause();
      });
      target.on('drain', () => socket.resume());
      target.on('data', (bytes) => {
        if (!socket.write(bytes)) target.pause();
      });
      socket.on('drain', () => target.resume());
      socket.resume();
      target.resume();
    });
  });
  await new Promise<void>((resolve) => apns.listen(0, '127.0.0.1', resolve));
  const ownedGateway = gateway;
  await new Promise<void>((resolve) => ownedGateway.listen(0, '127.0.0.1', resolve));
  const aa = apns.address();
  const ga = gateway.address();
  assert(aa && typeof aa !== 'string' && ga && typeof ga !== 'string', 'owned-listeners');
  const audience = `https://127.0.0.1:${ga.port}`;
  const configured =
    audience +
    ({ root: '', prefix: '/remi-prefix', query: '?route=owned', fragment: '#owned' }[mode] ?? '');
  const trust = new IdentityStore(state);
  await trust.generate(undefined, false);
  const device = await unlockIdentity(await createIdentity());
  await trust.addAuthorizedKey(device.publicKeyRaw, 'owned CLI recipient');
  await new RelayDeviceStore(state, trust).add(device.publicKeyRaw, 'owned CLI recipient');
  const pair = await relayV2.generateEcPair();
  const store = new SecurePushStore(state, trust);
  const authority = store.captureAuthority(device.publicKeyRaw);
  assert(authority, 'actual-recipient-authority');
  const registration = await store.register(authority, {
    token: 'ab'.repeat(32),
    environment: 'sandbox',
    pushPublicKey: relayV2.b64u(pair.publicKey),
    keyVersion: 1,
  });
  assert(registration.success, 'actual-recipient-registration');
  const snapshot = store.listCurrent()[0];
  assert(snapshot, 'actual-subscription');
  const machine = await trust.unlock();
  const signer = await relayV2.signerFromKey(
    machine.privateKey,
    new Uint8Array(Buffer.from(machine.publicKeyRaw, 'base64')),
  );
  const rid = await relayV2.ridOf(signer.publicKey);
  const apnsKey = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', apnsKey.privateKey));
  const pemLines = der.toString('base64').match(/.{1,64}/g);
  assert(pemLines, 'actual-apns-private-key-export');
  const pem = `-----BEGIN PRIVATE KEY-----\n${pemLines.join('\n')}\n-----END PRIVATE KEY-----`;
  worker = await startWorker(
    {
      PUSH_AUDIENCE: audience,
      APNS_KEY_ID: 'OWNEDTEST1',
      APNS_TEAM_ID: 'OWNEDTEAM1',
      APNS_PRIVATE_KEY: pem,
      APNS_BUNDLE_ID: 'owned.synthetic.topic',
      TEST_APNS_ENDPOINT: `http://127.0.0.1:${aa.port}`,
      PUSH_SECRET: 'owned-cross-track-push-secret',
    },
    false,
    { path: path.join(own, 'worker-sqlite') },
  );
  const deviceSigner = await relayV2.signerFromKey(
    device.privateKey,
    new Uint8Array(Buffer.from(device.publicKeyRaw, 'base64')),
  );
  async function peer() {
    assert(worker, 'worker-before-native-peer');
    const socket = await Socket.open(clientUrl(worker, Buffer.from(rid).toString('hex')));
    await admit(socket, { signer: deviceSigner, publicKey: deviceSigner.publicKey }, 'client', rid);
    await socket.json();
    await socket.json();
    const start = await relayV2.clientStart(
      {
        machinePublicKey: signer.publicKey,
        device: deviceSigner,
        mode: 'resume',
        random: relayV2.systemRandom,
      },
      Date.now(),
    );
    socket.sendText(start.hello);
    const auth = await start.onHelloAck(await socket.text(), Date.now());
    socket.sendText(auth.auth);
    const channel = await auth.onReady(await socket.text(), Date.now(), {
      emit: (bytes) => socket.sendBinary(bytes),
      close: (code) => socket.close(code),
    });
    const received: ReturnType<typeof deserialize>[] = [];
    let receiveFailure: unknown;
    let receiving = true;
    let tail = Promise.resolve();
    socket.tap((frame) => {
      if (!receiving) return;
      tail = tail
        .then(async () => {
          if (typeof frame === 'string') throw new Error('plaintext-after-ready');
          const bytes = await channel.receive(frame);
          if (bytes)
            received.push(deserialize(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
        })
        .catch((error) => {
          receiveFailure = error;
        });
    });
    connections.push({
      socket,
      channel,
      stopReader: () => {
        receiving = false;
      },
      drain: () => tail,
    });
    const hello = createHello('owned-native-answer-device', '2.0.0');
    await channel.send(new TextEncoder().encode(serialize(hello)));
    await until(() => {
      if (receiveFailure) throw receiveFailure;
      return received.some(
        (message) => message?.type === 'ack' && message.ack.messageId === hello.id,
      );
    }, 'actual-machine-hello');
    return {
      socket,
      channel,
      received,
      drain: () => tail,
      async result(id: string, expected?: string) {
        await until(() => {
          if (receiveFailure) throw receiveFailure;
          return received.some(
            (message) =>
              message?.type === 'answer_result' &&
              message.requestId === id &&
              (expected === undefined || message.outcome === expected),
          );
        }, 'actual-correlated-native-result');
        return received.find(
          (message) =>
            message?.type === 'answer_result' &&
            message.requestId === id &&
            (expected === undefined || message.outcome === expected),
        );
      },
    };
  }

  const listener = createNetServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const la = listener.address();
  assert(la && typeof la !== 'string', 'owned-cli-port');
  const port = la.port;
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  const executable = path.join(bin, 'claude');
  fs.writeFileSync(
    executable,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then printf 'owned-claude-fixture\\n'; exit 0; fi\nd="$FAKE_CLAUDE_DIR"\nprintf '%s' "$*" > "$d/argv"\necho $$ > "$d/pid"\nproject="$HOME/.claude/projects/$(pwd -P | sed 's#/#-#g')"\nmkdir -p "$project"\n: > "$project/$2.jsonl"\ni=0\nwhile [ ! -e "$d/release" ] && [ $i -lt 600 ]; do sleep 0.1; i=$((i + 1)); done\n`,
    { mode: 0o700 },
  );
  const env = {
    HOME: home,
    REMI_HOME: state,
    PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: own,
    TERM: 'xterm-256color',
    FAKE_CLAUDE_DIR: fake,
    NODE_EXTRA_CA_CERTS: path.join(own, 'tls-ca.pem'),
    REMI_PUSH_SECRET: 'owned-cross-track-push-secret',
  };
  const tlsControl = Bun.spawn(
    [
      cliRuntime,
      '--eval',
      `const r=await fetch(${JSON.stringify(`${audience}/health`)});if(r.status!==200||await r.text()!=='owned')process.exit(1);`,
    ],
    { env, cwd: work, stdout: 'pipe', stderr: 'pipe' },
  );
  const tlsError = new Response(tlsControl.stderr).text();
  assert(
    (await bounded(tlsControl.exited, 'actual-pinned-cli-tls-health')) === 0 &&
      (await tlsError).length === 0,
    'actual-pinned-cli-verified-tls-health',
  );
  fs.writeFileSync(
    path.join(state, 'config.toml'),
    `[daemon]\nbase_port = ${port}\nport_range = 20\n[network]\nrelay = true\nsignaling_url = "${audience}"\nmdns = false\ntelegram = false\n[auth]\nenabled = true\n`,
  );
  cli = Bun.spawn(
    [
      cliRuntime,
      `${repo}/packages/daemon/src/cli.ts`,
      'serve',
      '--relay',
      '--auth',
      '--signaling-url',
      configured,
      '--no-mdns',
      '--no-telegram',
      '--port',
      String(port),
    ],
    { cwd: work, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
  );
  const collect = async (stream: ReadableStream<Uint8Array>, which: 'stdout' | 'stderr') => {
    for await (const chunk of stream) {
      const text = new TextDecoder().decode(chunk);
      if (which === 'stdout') out += text;
      else cliErr += text;
    }
  };
  const launchedCli = cli;
  const stdout = collect(cli.stdout, 'stdout');
  const stderr = collect(cli.stderr, 'stderr');
  await until(
    () => out.includes('Remi hub ready!') && cliErr.includes('Relay control admitted'),
    'actual-source-supervisor-ready',
    25000,
  );
  assert(
    Number(fs.readFileSync(path.join(state, 'daemon.pid'), 'utf8').trim()) === cli.pid,
    'actual-source-supervisor-owns-pid',
  );
  await until(
    () => fs.existsSync(path.join(state, 'daemon-status.json')),
    'actual-debounced-supervisor-status',
  );
  const hubStatus = JSON.parse(fs.readFileSync(path.join(state, 'daemon-status.json'), 'utf8'));
  assert(
    hubStatus.mode === 'hub' && hubStatus.sessionId === null && hubStatus.pid === cli.pid,
    'actual-source-supervisor-sessionless-status',
  );
  assert(!fs.existsSync(path.join(fake, 'pid')), 'supervisor-does-not-start-harness');
  const initialPeer = await peer();
  const create = createCreateSessionRequest(work, { harness: 'claude' });
  await initialPeer.channel.send(new TextEncoder().encode(serialize(create)));
  await until(
    () =>
      initialPeer.received.some(
        (m) => m?.type === 'create_session_response' && m.requestId === create.id,
      ),
    'actual-encrypted-create-response',
    20000,
  );
  const created = initialPeer.received.find(
    (m) => m?.type === 'create_session_response' && m.requestId === create.id,
  );
  assert(
    created?.type === 'create_session_response' && created.success && created.sessionId,
    'actual-encrypted-create-started-source-child',
  );
  let entry: Record<string, unknown> | undefined;
  await until(
    () => {
      if (launchedCli.exitCode !== null) throw new Error(`cli-early-exit:${launchedCli.exitCode}`);
      const dir = path.join(state, 'live-sessions');
      if (!fs.existsSync(dir)) return false;
      const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
      const first = files[0];
      if (files.length !== 1 || !first) return false;
      entry = JSON.parse(fs.readFileSync(path.join(dir, first), 'utf8'));
      return typeof entry?.['claudeChildPid'] === 'number' && fs.existsSync(path.join(fake, 'pid'));
    },
    'actual-cli-launch',
    25000,
  );
  assert(
    entry && entry['pid'] !== cli.pid && entry['sessionId'] === created.sessionId,
    'actual-supervisor-created-child',
  );
  childPid = Number(entry['pid']);
  childBirth = requireOwnedChild();
  assert(entry['wsPort'] === created.port, 'actual-create-response-matches-live-child');
  await until(
    () => fs.existsSync(path.join(state, `status-${entry?.['wsPort']}.json`)),
    'actual-child-status-file',
  );
  const childStatus = JSON.parse(
    fs.readFileSync(path.join(state, `status-${entry['wsPort']}.json`), 'utf8'),
  );
  const unchangedHub = JSON.parse(fs.readFileSync(path.join(state, 'daemon-status.json'), 'utf8'));
  assert(
    childStatus.pid === childPid &&
      childStatus.sessionId === created.sessionId &&
      unchangedHub.pid === cli.pid &&
      unchangedHub.mode === 'hub' &&
      unchangedHub.sessionId === null,
    'actual-child-preserves-sessionless-supervisor-status',
  );
  assert(requireOwnedCli(), 'actual-source-command-birth-cwd-owned');
  const records = JSON.parse(fs.readFileSync(path.join(state, 'sessions.json'), 'utf8')).sessions;
  const launchedEntry = entry;
  const record = records.find(
    (r: { remiSessionId: string }) => r.remiSessionId === launchedEntry['sessionId'],
  );
  assert(record && typeof record.claudeSessionId === 'string', 'actual-launch-binding');
  hookAbort = new AbortController();
  let settled = false;
  hook = fetch(`http://127.0.0.1:${entry['hookPort']}/hooks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: record.claudeSessionId,
      cwd: fs.realpathSync(work),
      permission_mode: 'default',
      tool_name: 'Bash',
      tool_input: { command: 'printf OWNED_CLI_COMMAND_SENTINEL' },
      permission_suggestions: [],
    }),
    signal: hookAbort.signal,
  })
    .then((r) => r.text())
    .then((text) => {
      settled = true;
      return text;
    });
  void hook.catch(() => {});
  await until(
    () =>
      (apnsBodies.length > 0 && gatewayReplies.length > 0) ||
      out.includes('[QuestionPush] no recipient'),
    'actual-hook-delivery-decision',
    20000,
  );
  assert(!settled, 'held-hook-not-settled-by-notification');
  if (apnsBodies.length > 0) {
    assert(apnsBodies.length === 1, 'single-actual-apns-effect');
    assert(
      gatewayReplies[0] === 200 && gatewayErrors.length === 0,
      'actual-https-worker-acceptance',
    );
    const firstBody = apnsBodies[0];
    assert(firstBody, 'actual-apns-body');
    const outer = JSON.parse(firstBody);
    const opened = await relayV2.openPushContent(
      pair,
      outer.remiPush,
      {
        machinePublicKey: relayV2.b64u(signer.publicKey),
        devicePublicKey: Buffer.from(snapshot.publicKey, 'base64').toString('base64url'),
        pushPublicKey: snapshot.pushPublicKey,
        keyVersion: snapshot.keyVersion,
      },
      Math.floor(Date.now() / 1000),
    );
    assert(
      opened.payload.type === 'question' && opened.payload.actionable === true,
      'real-verified-actionable-question',
    );
    assert(opened.payload.sessionId === entry['sessionId'], 'actual-child-signed-session-binding');
    assert(
      !firstBody.includes(String(entry['sessionId'])) &&
        !firstBody.includes(opened.payload.questionId),
      'no-plaintext-local-identifiers',
    );
    const now = Math.floor(Date.now() / 1000);
    const no = opened.payload.options.find((option) => option.isNo);
    assert(no, 'actual-signed-no-choice');
    const unsigned: RelayTypes.UnsignedNativeAnswer = {
      type: 'native_answer',
      v: 2,
      id: generateId(),
      timestamp: new Date(now * 1000).toISOString(),
      rid: opened.content.rid,
      machinePublicKey: opened.content.machinePublicKey,
      devicePublicKey: opened.content.devicePublicKey,
      sessionId: opened.payload.sessionId,
      runtimeInstance: opened.payload.runtimeInstance,
      questionId: opened.payload.questionId,
      collapseId: opened.content.collapseId,
      revision: opened.content.revision,
      contentDigest: relayV2.b64u(new Uint8Array(Buffer.from(opened.contentDigest, 'hex'))),
      nonce: relayV2.b64u(relayV2.systemRandom(32)),
      issuedAt: now,
      expiresAt: Math.min(now + 30, opened.content.expiresAt),
      answer: no.value,
    };
    const proof = {
      ...unsigned,
      signature: relayV2.b64u(
        await deviceSigner.sign(await relayV2.buildNativeAnswerSigningInput(unsigned)),
      ),
    };
    const encoded = relayV2.encodeNativeAnswer(proof);
    const first = initialPeer;
    await first.channel.send(new TextEncoder().encode(encoded));
    const outcome = await first.result(proof.id, undefined);
    assert(
      outcome?.type === 'answer_result' &&
        outcome.sessionId === proof.sessionId &&
        outcome.questionId === proof.questionId &&
        outcome.outcome === 'delivered',
      'actual-native-no-correlated-delivered',
    );
    const actualHook = JSON.parse(await bounded(hook, 'actual-native-no-hook-result'));
    assert(
      actualHook.hookSpecificOutput?.decision?.behavior === 'deny',
      'actual-native-no-settles-http-deny',
    );

    assert(
      first.received.every((message) => message?.type !== 'raw_pty_output'),
      'native-route-no-raw-pty',
    );
    await first.channel.bye();
    await bounded(first.socket.closed, 'first-peer-orderly-close');
    await first.drain();
    await first.channel.transportClosed();
    const resumed = await peer();
    await resumed.channel.send(new TextEncoder().encode(encoded));
    const repeated = await resumed.result(proof.id);
    assert(
      repeated?.type === 'answer_result' &&
        repeated.sessionId === proof.sessionId &&
        repeated.questionId === proof.questionId &&
        repeated.outcome === 'delivered',
      'fresh-encrypted-peer-exact-proof-retained-result',
    );
    assert(
      resumed.received.every((message) => message?.type !== 'raw_pty_output'),
      'fresh-peer-no-raw-pty',
    );
    assert(tlsUpgrades >= 3, 'actual-source-supervisor-wss-control-and-pipes');
  } else {
    assert(
      out.includes('[QuestionPush] no recipient'),
      'actual-hook-reached-no-recipient-decision',
    );
  }
  requireOwnedCli();
  assert(settled, 'actual-held-request-settled-by-native-no');
  fs.writeFileSync(path.join(fake, 'release'), '');
  await until(() => !processAlive(childPid), 'actual-created-child-natural-exit', 12000);
  assert(!processAlive(childPid), 'source-created-child-exited');
  requireOwnedCli();
  cli.kill('SIGTERM');
  assert(
    (await bounded(cli.exited, 'actual-cli-exit', 12000)) === 0,
    'source-supervisor-clean-exit',
  );
  await Promise.all([stdout, stderr]);
  assert(
    !out.includes('OWNED_CLI_COMMAND_SENTINEL') &&
      !cliErr.includes('OWNED_CLI_COMMAND_SENTINEL') &&
      !fs
        .readFileSync(path.join(state, 'daemon.log'), 'utf8')
        .includes('OWNED_CLI_COMMAND_SENTINEL'),
    'diagnostics-no-submitted-command',
  );
  if (mode === 'root') {
    assert(
      apnsBodies.length >= 1 &&
        gatewayPostPaths.length >= 1 &&
        gatewayPostPaths.every((p) => p.startsWith('/v2/push/')),
      'normal-root-control-delivers',
    );
    assert(!cliErr.includes(refusalNotice), 'normal-root-control-has-no-route-refusal');
  } else {
    assert(
      gatewayPostPaths.length === 0 && apnsBodies.length === 0,
      `unsupported-${mode}-must-not-post-to-root`,
    );
    assert(cliErr.includes(refusalNotice), `unsupported-${mode}-emits-fixed-refusal`);
  }
  completed = true;
} catch (e) {
  failure = e instanceof Error ? e.message : 'fixture-failed';
} finally {
  if (processAlive(childPid)) {
    fs.writeFileSync(path.join(fake, 'release'), '');
    try {
      requireOwnedChild();
      process.kill(Number(childPid), 'SIGTERM');
      await until(() => !processAlive(childPid), 'cleanup-source-child', 8000);
    } catch {
      if (processAlive(childPid)) {
        requireOwnedChild();
        process.kill(Number(childPid), 'SIGKILL');
      }
    }
  }
  if (cli && cli.exitCode === null) {
    fs.writeFileSync(path.join(fake, 'release'), '');
    try {
      requireOwnedCli();
      cli.kill('SIGTERM');
      await bounded(cli.exited, 'cleanup-cli', 8000);
    } catch {
      try {
        requireOwnedCli();
        cli.kill('SIGKILL');
        await bounded(cli.exited, 'cleanup-kill', 2000);
      } catch {}
    }
  }
  if (hook) {
    hookAbort?.abort();
    await hook.catch(() => {});
  }
  for (const connection of connections) {
    if (!connection.socket.isClosed) {
      await bounded(connection.channel.bye(), 'native-peer-bye').catch(() => {});
      await bounded(connection.socket.closed, 'native-peer-close').catch(() =>
        connection.socket.close(),
      );
    }
    await connection.drain();
    connection.stopReader();
    await connection.channel.transportClosed().catch(() => {});
  }
  for (const tunnel of tunnels) tunnel.destroy();
  if (worker)
    await bounded(worker.stop(), 'worker-stop').catch(() => {
      failure ||= 'worker-cleanup';
    });
  if (gateway)
    await closeServer(gateway).catch(() => {
      failure ||= 'gateway-cleanup';
    });
  await closeServer(apns).catch(() => {
    failure ||= 'apns-cleanup';
  });
  fs.writeFileSync(path.join(own, 'cli-stdout.txt'), out);
  fs.writeFileSync(path.join(own, 'cli-stderr.txt'), cliErr);
  fs.writeFileSync(
    path.join(own, 'receipt.json'),
    JSON.stringify(
      {
        source: execFileSync('/usr/bin/git', ['-C', repo, 'rev-parse', 'HEAD'], {
          encoding: 'utf8',
        }).trim(),
        mode,
        scenario,
        fixtureRuntime: process.execPath,
        cliRuntime,
        tlsUpgrades,
        tunnelReceipts,
        childPid,
        childBirth,
        cliBirth,
        gatewayPostPaths,
        refusalObserved: cliErr.includes(refusalNotice),
        completed,
        failure,
        checks,
        apnsEffects: apnsBodies.length,
        gatewayReplies,
        gatewayErrors,
        cliPid: cli?.pid,
        cliExit: cli?.exitCode,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      own,
      mode,
      scenario,
      tlsUpgrades,
      childPid,
      completed,
      failure,
      checks: checks.length,
      gatewayPostPaths,
      refusalObserved: cliErr.includes(refusalNotice),
      apnsEffects: apnsBodies.length,
      gatewayReplies,
      cliExit: cli?.exitCode,
    }),
  );
}
if (!completed || failure) process.exitCode = 1;
