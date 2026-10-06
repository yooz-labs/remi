import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { createServer as createNetServer } from 'node:net';
/**
 * Actual source-CLI route acceptance (#1200). Run with Bun and root|prefix|query|fragment.
 * Own temporary HOME/state, generated identities/CA, real HTTPS ingress, real SQLite
 * Worker and an owned APNs HTTP receiver. No user keys, Apple endpoint or deployment.
 * Root delivers a decryptable question; unsupported route forms visibly refuse and
 * produce zero push POSTs through hook dispatch, empty unstick and natural exit.
 * Neither setup failures nor timeouts count as the route regression's causal red.
 */
import * as os from 'node:os';
import * as path from 'node:path';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'remi-r5-cli-route-')));
fs.chmodSync(root, 0o700);
const mode = process.argv[2] ?? 'root';
if (!['root', 'prefix', 'query', 'fragment'].includes(mode)) throw new Error('invalid-mode');
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
const { relayV2, createIdentity, unlockIdentity } = await import(
  '../../packages/shared/src/index.ts'
);
const { IdentityStore } = await import('../../packages/daemon/src/auth/identity-store.ts');
const { RelayDeviceStore } = await import('../../packages/daemon/src/remote/relay-device-store.ts');
const { SecurePushStore } = await import(
  '../../packages/daemon/src/notifications/secure-push-store.ts'
);
const { startWorker } = await import('../../packages/signaling/tests/e2e/harness.ts');
const { FakeHost } = await import('../../packages/signaling/tests/e2e/endpoints.ts');
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
let host: Awaited<ReturnType<typeof FakeHost.start>> | undefined;
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
          headers: { 'content-type': 'application/json' },
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
    },
    false,
    { path: path.join(own, 'worker-sqlite') },
  );
  host = await FakeHost.start(worker, {
    signer,
    publicKey: signer.publicKey,
    rid,
    ridHex: Buffer.from(rid).toString('hex'),
  });
  assert(
    (await host.enroll(new Uint8Array(Buffer.from(snapshot.publicKey, 'base64'))))['ok'] === true,
    'actual-worker-enrollment',
  );
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
  };
  cli = Bun.spawn(
    [
      process.execPath,
      `${repo}/packages/daemon/src/cli.ts`,
      '--daemon',
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
  assert(entry && entry['pid'] === cli.pid, 'actual-source-child-owned');
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
    () => apnsBodies.length > 0 || out.includes('[QuestionPush] no recipient'),
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
  } else {
    assert(
      out.includes('[QuestionPush] no recipient'),
      'actual-hook-reached-no-recipient-decision',
    );
  }
  requireOwnedCli();
  process.kill(cli.pid, 'SIGUSR2');
  assert(
    JSON.stringify(JSON.parse(await bounded(hook, 'held-release'))) === '{}',
    'unstick-empty-no-approval',
  );
  fs.writeFileSync(path.join(fake, 'release'), '');
  assert((await bounded(cli.exited, 'actual-cli-exit', 12000)) === 0, 'source-cli-natural-exit');
  await Promise.all([stdout, stderr]);
  assert(
    !out.includes('OWNED_CLI_COMMAND_SENTINEL') && !cliErr.includes('OWNED_CLI_COMMAND_SENTINEL'),
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
  host?.control.close();
  if (host) await bounded(host.control.closed, 'host-close').catch(() => {});
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
