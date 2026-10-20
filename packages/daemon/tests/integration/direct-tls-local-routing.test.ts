/** Real CLI/daemon/private routing with owned TLS and stand-in agent executables, no model calls. */
import { afterEach, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { join, sep } from 'node:path';
import {
  type ProtocolMessage,
  createAuthResponse,
  createHello,
  createIdentity,
  createSessionListRequest,
  createSessionListResponse,
  deserialize,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import { resumed } from '../../../../tests/integration/relay-r3-fixture.ts';
import { startWorker } from '../../../signaling/tests/e2e/harness.ts';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { resolveDaemonWsTarget } from '../../src/cli/daemon-target.ts';
import { ChildProxy } from '../../src/remote/child-proxy.ts';
import { SessionRegistryFile } from '../../src/session/session-registry-file.ts';
import {
  publishLocalDaemonEndpoint,
  readLocalDaemonEndpoint,
  releaseLocalDaemonEndpoint,
} from '../../src/storage/local-daemon-endpoints.ts';
import { directTlsFixture } from '../helpers/direct-tls-fixture.ts';
import { FAKE_CLAUDE, WAIT_FOR_RELEASE, installFakeAgents } from '../helpers/fake-agent-clis.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const CLI = new URL('../../src/cli.ts', import.meta.url).pathname;
type Fixture = ReturnType<typeof directTlsFixture>;
type Process = { proc: Bun.Subprocess; log: { text: string } };
const fixtures: Fixture[] = [];
const processes: Process[] = [];
const rawServers: ReturnType<typeof Bun.serve>[] = [];
const workers: Awaited<ReturnType<typeof startWorker>>[] = [];
const sockets: WebSocket[] = [];
const detachedPids: number[] = [];

async function poll(check: () => boolean, label: string, timeout = 15000) {
  const until = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= until) throw new Error(`Timeout: ${label}`);
    await Bun.sleep(10);
  }
}
async function capture(stream: ReadableStream<Uint8Array>, log: { text: string }) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) return;
    log.text += decoder.decode(chunk.value);
  }
}
function spawn(f: Fixture, args: string[], tty = false, env: Record<string, string> = {}) {
  const log = { text: '' };
  const agents = installOnce(f);
  const options = { cwd: f.work, env: { ...f.env, ...agents.env, ...env } };
  const proc = tty
    ? Bun.spawn([process.execPath, CLI, ...args], {
        ...options,
        terminal: {
          cols: 160,
          rows: 50,
          data(_term, chunk) {
            log.text += new TextDecoder().decode(chunk);
          },
        },
      })
    : Bun.spawn([process.execPath, CLI, ...args], {
        ...options,
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
      });
  if (!tty) {
    if (proc.stdout && typeof proc.stdout !== 'number') void capture(proc.stdout, log);
    if (proc.stderr && typeof proc.stderr !== 'number') void capture(proc.stderr, log);
  }
  const result = { proc, log };
  processes.push(result);
  return result;
}
const agentsByHome = new Map<string, ReturnType<typeof installFakeAgents>>();
function installOnce(f: Fixture) {
  let agents = agentsByHome.get(f.home);
  if (!agents) {
    agents = installFakeAgents(f.userHome, { claude: true });
    agentsByHome.set(f.home, agents);
  }
  return agents;
}
function fixture() {
  const f = directTlsFixture();
  fixtures.push(f);
  return f;
}
async function exited(p: Process, timeout = 15000) {
  await poll(
    () => p.proc.exitCode !== null || p.proc.signalCode !== null,
    'owned CLI exit',
    timeout,
  );
  return p.proc.exited;
}
function live(f: Fixture) {
  return new SessionRegistryFile(join(f.home, 'live-sessions')).listLive();
}
function status(f: Fixture, port: number) {
  try {
    return JSON.parse(fs.readFileSync(join(f.home, `status-${port}.json`), 'utf8'));
  } catch {
    return null;
  }
}
function output(f: Fixture, p: Process) {
  const file = join(f.home, 'remi.log');
  return p.log.text + (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
}
function endpoint(f: Fixture, port: number) {
  const r = readLocalDaemonEndpoint(port, { home: f.home });
  if (r.kind !== 'found') throw new Error(`owned endpoint ${r.kind}`);
  return r.endpoint;
}
async function hub(f: Fixture, relay = false) {
  const base = await reserveRange(20, 50, '127.0.0.1');
  let config = f.config.replace('[daemon]\n', `[daemon]\nbase_port=${base}\n`);
  if (relay) {
    const worker = await startWorker();
    workers.push(worker);
    config = config.replace('relay=false', `relay=true\nsignaling_url="${worker.wsUrl}"`);
  }
  fs.writeFileSync(f.configPath, config);
  const p = spawn(f, ['serve', '--no-telegram']);
  await poll(
    () => p.log.text.includes('Remi hub ready!') || p.proc.exitCode !== null,
    'TLS hub readiness',
  );
  expect(p.proc.exitCode).toBeNull();
  expect(p.log.text.includes(`wss://127.0.0.1:${base}/ws`)).toBe(true);
  expect(p.log.text.includes('TLS is configured; secure discovery support is pending')).toBe(true);
  if (relay)
    await poll(() => p.log.text.includes('Relay control admitted'), 'local Worker admission');
  endpoint(f, base);
  await poll(() => {
    try {
      const value = JSON.parse(fs.readFileSync(join(f.home, 'daemon-status.json'), 'utf8'));
      return value.mode === 'hub' && value.pid === p.proc.pid && value.bind !== undefined;
    } catch {
      return false;
    }
  }, 'verified hub status snapshot');
  return { p, port: base };
}
async function publicPeer(f: Fixture, port: number) {
  const identity = await unlockIdentity(await createIdentity());
  const store = new IdentityStore(f.home);
  await store.addAuthorizedKey(identity.publicKeyRaw, 'owned B2 public client');
  const ws = new WebSocket(`wss://127.0.0.1:${port}/ws`, { tls: { ca: f.ca } } as never);
  sockets.push(ws);
  const received: ProtocolMessage[] = [];
  let failed = false;
  ws.onerror = () => {
    failed = true;
  };
  ws.onmessage = async (event) => {
    const message = deserialize(String(event.data));
    if (!message) return;
    received.push(message);
    if (message.type === 'auth_challenge') {
      if (message.serverPublicKey !== store.load()?.publicKey) {
        failed = true;
        return;
      }
      ws.send(
        serialize(
          createAuthResponse(
            identity.publicKeyRaw,
            await sign(identity.privateKey, fromBase64(message.challenge)),
            identity.fingerprint,
          ),
        ),
      );
    } else if (message.type === 'auth_result' && message.success)
      ws.send(serialize(createHello('owned B2 public', '1', { mode: 'query' })));
  };
  await poll(
    () => failed || received.some((message) => message.type === 'hello_ack'),
    'public signed WSS',
  );
  expect(failed).toBe(false);
  ws.send(serialize(createSessionListRequest()));
  await poll(
    () => received.some((message) => message.type === 'session_list_response'),
    'public requested list',
  );
  return { ws, received };
}
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  const retiring: { home: string; port: number }[] = [];
  const cleanupFailures: string[] = [];
  for (const f of fixtures)
    for (const entry of live(f)) {
      if (
        (entry.projectPath === f.work || entry.projectPath.startsWith(f.work + sep)) &&
        entry.pid !== process.pid
      ) {
        retiring.push({ home: f.home, port: entry.wsPort });
        if (entry.claudeChildPid) {
          try {
            process.kill(entry.claudeChildPid, 'SIGTERM');
          } catch {}
        }
        try {
          process.kill(entry.pid, 'SIGTERM');
        } catch {}
      }
    }
  for (const { home, port } of retiring) {
    try {
      await poll(
        () => readLocalDaemonEndpoint(port, { home }).kind === 'absent',
        'owned child record retirement before fixture removal',
        3000,
      );
    } catch {
      cleanupFailures.push('Owned child record retirement did not complete');
    }
  }
  for (const p of processes.splice(0)) {
    if (p.proc.exitCode === null && p.proc.signalCode === null) {
      p.proc.kill('SIGTERM');
      await Promise.race([p.proc.exited, Bun.sleep(2000)]);
      if (p.proc.exitCode === null && p.proc.signalCode === null) p.proc.kill('SIGKILL');
    }
    await p.proc.exited;
  }
  for (const pid of detachedPids.splice(0)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {}
  }
  for (const worker of workers.splice(0)) await worker.stop();
  for (const server of rawServers.splice(0)) server.stop(true);
  for (const f of fixtures.splice(0)) {
    for (const entry of live(f)) {
      if (
        (entry.projectPath === f.work || entry.projectPath.startsWith(f.work + sep)) &&
        entry.pid !== process.pid
      ) {
        try {
          process.kill(entry.pid, 'SIGKILL');
        } catch {}
      }
    }
    f.cleanup();
    agentsByHome.delete(f.home);
  }
  if (cleanupFailures.length) throw new Error(cleanupFailures.join('; '));
});

test('real TLS hub/child, actual ChildProxy, seven CLI paths, pairing refusal and public output', async () => {
  const f = fixture();
  installOnce(f);
  // This stand-in handles the real graceful stop command; the general helper ignores stdin.
  fs.writeFileSync(
    join(f.userHome, 'fake-bin', 'claude'),
    FAKE_CLAUDE.replace(
      WAIT_FOR_RELEASE,
      'while IFS= read -r line; do case "$line" in /exit*) exit 0;; esac; done\n',
    ),
    { mode: 0o755 },
  );
  const h = await hub(f, true);
  const childWork = join(f.work, 'child-project');
  fs.mkdirSync(childWork);
  const newSession = spawn(
    f,
    ['new', '--host', '127.0.0.1', '--port', String(h.port), '--dir', childWork],
    true,
  );
  await poll(
    () => live(f).some((entry) => status(f, entry.wsPort)?.attached === true),
    'remote-new child attach',
  );
  const child = live(f)[0];
  if (!child) throw new Error('owned child missing');
  expect(child.projectPath).toBe(childWork);
  const childEndpoint = endpoint(f, child.wsPort);
  expect(childEndpoint.pid).toBe(child.pid);
  const detach = spawn(f, ['detach', `127.0.0.1:${child.wsPort}/${child.sessionId}`]);
  expect(await exited(detach)).toBe(0);
  await poll(() => status(f, child.wsPort)?.attached === false, 'third-party detach state');
  // Third-party detach untracks the connection; its transport intentionally stays open.
  newSession.proc.terminal?.write('\x02d');
  expect(await exited(newSession)).toBe(0);
  const publicClient = await publicPeer(f, child.wsPort);
  const received: ProtocolMessage[] = [];
  const proxy = new ChildProxy(
    new SessionRegistryFile(join(f.home, 'live-sessions')),
    'owned-proxy',
    (message) => received.push(message),
    () => {},
    () => true,
    undefined,
    undefined,
    f.home,
  );
  try {
    const response = await proxy.list(child.sessionId, false);
    expect(response.type).toBe('session_list_response');
    received.push(response);
  } finally {
    proxy.close();
  }
  await poll(() => status(f, child.wsPort)?.attached === false, 'proxy detach state');
  const childRecordPath = join(f.home, 'local-endpoints', `${child.wsPort}.json`);
  const originalChildRecord = fs.readFileSync(childRecordPath);
  fs.writeFileSync(childRecordPath, JSON.stringify({ ...childEndpoint, pid: process.pid }));
  const mismatched = new ChildProxy(
    new SessionRegistryFile(join(f.home, 'live-sessions')),
    'owned-negative-proxy',
    () => {},
    () => {},
    () => true,
    undefined,
    undefined,
    f.home,
  );
  try {
    await expect(mismatched.list(child.sessionId, false)).rejects.toThrow(
      'Local daemon endpoint unavailable',
    );
  } finally {
    mismatched.close();
    fs.writeFileSync(childRecordPath, originalChildRecord);
  }
  const list = spawn(f, ['ls', '--host', '127.0.0.1', '--port', String(child.wsPort)]);
  expect(await exited(list)).toBe(0);
  // The shipping formatter displays the session name and its public port.
  expect(list.log.text.includes(child.name)).toBe(true);
  expect(list.log.text.includes(`Daemon port: ${child.wsPort}`)).toBe(true);
  const recent = spawn(f, ['recent', '--host', '127.0.0.1', '--port', String(child.wsPort)]);
  expect(await exited(recent)).toBe(0);
  const attach = spawn(f, ['attach', `127.0.0.1:${child.wsPort}/${child.sessionId}`], true);
  await poll(() => status(f, child.wsPort)?.attached === true, 'explicit attach');
  const detachAgain = spawn(f, ['detach', `127.0.0.1:${child.wsPort}/${child.sessionId}`]);
  expect(await exited(detachAgain)).toBe(0);
  attach.proc.terminal?.write('\x02d');
  expect(await exited(attach)).toBe(0);
  const siblingSession = spawn(
    f,
    ['new', '--host', '127.0.0.1', '--port', String(h.port), '--dir', f.work],
    true,
  );
  await poll(
    () =>
      live(f).some(
        (entry) =>
          entry.sessionId !== child.sessionId && status(f, entry.wsPort)?.attached === true,
      ),
    'sibling child attach',
  );
  const sibling = live(f).find((entry) => entry.sessionId !== child.sessionId);
  if (!sibling) throw new Error('owned sibling missing');
  await poll(
    () =>
      publicClient.received.filter((message) => message.type === 'session_list_response').length >
        1 && publicClient.received.some((message) => message.type === 'remi_status'),
    'public unsolicited list/status',
  );
  const siblingDetach = spawn(f, ['detach', `127.0.0.1:${sibling.wsPort}/${sibling.sessionId}`]);
  expect(await exited(siblingDetach)).toBe(0);
  siblingSession.proc.terminal?.write('\x02d');
  expect(await exited(siblingSession)).toBe(0);
  const devices = spawn(f, ['devices']);
  expect(await exited(devices)).toBe(0);
  const capabilityFile = join(f.home, 'capability.key');
  const originalCapability = fs.readFileSync(capabilityFile);
  fs.writeFileSync(capabilityFile, 'owned-incorrect-capability');
  try {
    expect(await exited(spawn(f, ['devices']))).toBe(1);
  } finally {
    fs.writeFileSync(capabilityFile, originalCapability);
  }
  const multi = spawn(f, ['ls']);
  expect(await exited(multi)).toBe(0);
  expect(multi.log.text.includes(child.name)).toBe(true);
  expect(multi.log.text.includes(String(child.wsPort))).toBe(true);
  expect(multi.log.text.includes(String(sibling.wsPort))).toBe(true);
  const pair = spawn(f, ['pair'], true);
  expect(await exited(pair)).toBe(1);
  expect(pair.log.text.includes('Direct QR pairing is unavailable')).toBe(true);
  expect(pair.log.text.includes('remi://pair#')).toBe(false);
  expect(fs.existsSync(join(f.home, 'pairings.json'))).toBe(false);
  const relayPair = spawn(f, ['pair', '--relay'], true);
  await poll(() => relayPair.log.text.includes('remi-pair2:'), 'actual relay pairing offer');
  relayPair.proc.kill('SIGTERM');
  await relayPair.proc.exited;
  const target = resolveDaemonWsTarget('127.0.0.1', child.wsPort, { home: f.home });
  expect(target.url).toBe(`ws://127.0.0.1:${childEndpoint.privatePort}/ws`);
  const caResponse = await fetch(`https://127.0.0.1:${child.wsPort}/health`, { tls: { ca: f.ca } });
  expect(caResponse.status).toBe(200);
  const publicStatus = JSON.parse(fs.readFileSync(join(f.home, 'daemon-status.json'), 'utf8'));
  for (const value of [
    publicStatus,
    status(f, child.wsPort),
    ...received,
    ...publicClient.received,
  ]) {
    const json = JSON.stringify(value);
    expect(/"(?:privatePort|localControlPort|instanceId|directTls)"/.test(json)).toBe(false);
    expect(json.includes(`ws://127.0.0.1:${childEndpoint.privatePort}`)).toBe(false);
  }
  expect(h.p.log.text.includes(`:${childEndpoint.privatePort}/ws`)).toBe(false);
  const kill = spawn(f, ['kill', `127.0.0.1:${child.wsPort}/${child.sessionId}`]);
  const killExit = await exited(kill);
  if (killExit !== 0)
    throw new Error(
      JSON.stringify({
        killExit,
        timedOut: kill.log.text.includes('Timed out connecting'),
        closed: kill.log.text.includes('Connection closed before kill completed'),
        noSession: kill.log.text.includes('No session found'),
      }),
    );
  expect(killExit).toBe(0);
  await poll(
    () => readLocalDaemonEndpoint(child.wsPort, { home: f.home }).kind === 'absent',
    'killed child record retirement',
  );
}, 60000);

test('SIGTERM of a real TLS hub retires its record and closes both exact listeners', async () => {
  const f = fixture();
  const h = await hub(f);
  const record = endpoint(f, h.port);
  h.p.proc.kill('SIGTERM');
  expect(await exited(h.p)).toBe(0);
  expect(readLocalDaemonEndpoint(h.port, { home: f.home })).toEqual({ kind: 'absent' });
  await expect(
    fetch(`https://127.0.0.1:${h.port}/health`, {
      tls: { ca: f.ca },
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow();
  await expect(
    fetch(`http://127.0.0.1:${record.privatePort}/health`, { signal: AbortSignal.timeout(1000) }),
  ).rejects.toThrow();
}, 20000);

test('detached TLS start reports readiness only with its matching published endpoint', async () => {
  const f = fixture();
  const port = await reserveRange(1, 50, '127.0.0.1');
  const start = spawn(f, ['start', '--port', String(port), '--no-telegram']);
  await poll(() => fs.existsSync(join(f.home, 'daemon.pid')), 'detached owned PID');
  const pid = Number(fs.readFileSync(join(f.home, 'daemon.pid'), 'utf8').trim());
  detachedPids.push(pid);
  expect(await exited(start)).toBe(0);
  expect(start.log.text.includes(`Hub started (PID ${pid}, port ${port}).`)).toBe(true);
  expect(endpoint(f, port).pid).toBe(pid);
  expect((await fetch(`https://127.0.0.1:${port}/health`, { tls: { ca: f.ca } })).status).toBe(200);
  const stop = spawn(f, ['stop']);
  expect(await exited(stop)).toBe(0);
  await poll(
    () => readLocalDaemonEndpoint(port, { home: f.home }).kind === 'absent',
    'detached TLS record retirement',
  );
}, 20000);

test('actual encrypted HubRelay reaches a real TLS child using cfg.dir rather than ambient home', async () => {
  const base = fixture();
  const running = await resumed({
    onSessionListRequest: (cid, id) =>
      running.relay.sendRaw(cid, createSessionListResponse([], id)),
  });
  const f = {
    ...base,
    home: running.dir,
    configPath: join(running.dir, 'config.toml'),
    env: { ...base.env, REMI_HOME: running.dir },
  };
  fs.cpSync(base.certs, join(running.dir, 'certs'), { recursive: true });
  fs.writeFileSync(f.configPath, f.config);
  // The existing relay fixture names its owned registry "live"; the real CLI writes "live-sessions".
  fs.mkdirSync(join(running.dir, 'live'), { recursive: true });
  fs.symlinkSync('live', join(running.dir, 'live-sessions'));
  const port = await reserveRange(1, 50, '127.0.0.1');
  const child = spawn(f, ['--daemon', '--port', String(port), '--dir', f.work]);
  try {
    await poll(() => live(f).length === 1, 'real TLS child registration');
    const entry = live(f)[0];
    if (!entry) throw new Error('owned relay child missing');
    expect(endpoint(f, port).pid).toBe(child.proc.pid);
    const request = createSessionListRequest(false);
    await running.channel.send(new TextEncoder().encode(serialize(request)));
    let response: ProtocolMessage | null = null;
    for (let i = 0; i < 8; i++) {
      const opened = await running.channel.receive(await running.socket.binary(3000));
      const message = opened ? deserialize(new TextDecoder().decode(opened)) : null;
      if (message?.type === 'session_list_response' && message.requestId === request.id) {
        response = message;
        break;
      }
    }
    expect(response?.type).toBe('session_list_response');
    expect(
      response?.type === 'session_list_response' &&
        response.sessions.some((session) => session.sessionId === entry.sessionId),
    ).toBe(true);
    expect(JSON.stringify(response).includes('privatePort')).toBe(false);
  } finally {
    child.proc.kill('SIGTERM');
    await child.proc.exited;
    await running.cleanup();
    agentsByHome.delete(f.home);
  }
}, 30000);

test('TLS wrapper record publication failure closes its public listener before agent launch', async () => {
  const f = fixture();
  const port = await reserveRange(1, 50, '127.0.0.1');
  fs.writeFileSync(join(f.home, 'local-endpoints'), 'owned publication fault');
  const wrapper = spawn(f, ['--port', String(port)], true);
  expect(await exited(wrapper)).toBe(1);
  expect(output(f, wrapper).includes('TLS_START_FAILED')).toBe(true);
  expect(output(f, wrapper).includes('-----BEGIN')).toBe(false);
  expect(fs.existsSync(join(installOnce(f).claudeDir, 'argv'))).toBe(false);
  await expect(
    fetch(`https://127.0.0.1:${port}/health`, {
      tls: { ca: f.ca },
      signal: AbortSignal.timeout(1000),
    }),
  ).rejects.toThrow();
}, 20000);

for (const value of [
  'missing',
  'empty',
  'invalid',
  'unreadable',
  'mismatched',
  'nul',
  'control',
  'pastedpath',
] as const)
  test(`TLS ${value} startup fails safely before an agent or plaintext fallback`, async () => {
    const f = fixture();
    const port = await reserveRange(1, 50, '127.0.0.1');
    if (value === 'missing') fs.rmSync(join(f.certs, 'server.key'));
    if (value === 'empty') fs.writeFileSync(join(f.certs, 'server.key'), '');
    if (value === 'invalid')
      fs.writeFileSync(join(f.certs, 'server.key'), 'pasted-private-material');
    if (value === 'unreadable') fs.chmodSync(join(f.certs, 'server.key'), 0o000);
    if (value === 'mismatched')
      execFileSync('openssl', ['genrsa', '-out', join(f.certs, 'server.key'), '2048'], {
        stdio: 'pipe',
      });
    if (value === 'nul' || value === 'control')
      fs.writeFileSync(
        f.configPath,
        f.config.replace(
          'certs/server.key',
          value === 'nul' ? 'pasted-private-material\\u0000' : 'pasted-private-material\\n',
        ),
      );
    if (value === 'pastedpath')
      fs.writeFileSync(
        f.configPath,
        f.config.replace('certs/server.key', '-----BEGIN PRIVATE KEY----- pasted-private-material'),
      );
    const early = spawn(f, ['config']);
    if (value !== 'nul' && value !== 'control') expect(await exited(early)).toBe(0);
    else await exited(early);
    const wrapper = spawn(f, ['--port', String(port)], true);
    expect(await exited(wrapper)).toBe(1);
    const diagnostic = output(f, wrapper);
    expect(diagnostic.includes('pasted-private-material')).toBe(false);
    expect(diagnostic.includes('-----BEGIN')).toBe(false);
    expect(diagnostic.includes(f.tls.key)).toBe(false);
    expect(diagnostic.includes('ready!')).toBe(false);
    expect(fs.existsSync(join(installOnce(f).claudeDir, 'argv'))).toBe(false);
    await expect(
      fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(1000) }),
    ).rejects.toThrow();
  }, 20000);

async function barrier(f: Fixture, wrapper: boolean, exhaust = false, tls = true) {
  const base = await reserveRange(20, 50, '127.0.0.1');
  fs.writeFileSync(
    f.configPath,
    (tls ? f.config : f.config.replace(f.tlsTable, '')).replace(
      '[daemon]\n',
      `[daemon]\nbase_port=${base}\n`,
    ),
  );
  const fifo = join(f.home, 'capability.key');
  execFileSync('mkfifo', [fifo]);
  fs.chmodSync(fifo, 0o600);
  const ready = join(f.directory, 'reader-ready');
  const release = join(f.directory, 'release-reader');
  const writerPath = join(f.directory, 'fifo-writer.ts');
  fs.writeFileSync(
    writerPath,
    `import * as fs from 'node:fs'; const fd=fs.openSync(${JSON.stringify(fifo)},'w'); fs.writeFileSync(${JSON.stringify(ready)},'ready'); const deadline=Date.now()+15000; while(!fs.existsSync(${JSON.stringify(release)})){if(Date.now()>deadline)process.exit(2);await Bun.sleep(5);} fs.writeSync(fd,'owned-barrier-capability'); fs.closeSync(fd);`,
  );
  const writer = Bun.spawn([process.execPath, writerPath], {
    cwd: f.work,
    env: f.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  processes.push({ proc: writer, log: { text: '' } });
  const selectedDirectory = join(f.work, 'selected-directory');
  fs.mkdirSync(selectedDirectory);
  const p = spawn(
    f,
    wrapper ? ['--dir', selectedDirectory] : ['serve', '--dir', selectedDirectory],
    wrapper,
  );
  await poll(() => fs.existsSync(ready), 'actual startup capability read');
  for (let i = 0; i < (exhaust ? 20 : 1); i++)
    rawServers.push(
      Bun.serve({
        port: base + i,
        hostname: '127.0.0.1',
        fetch: () => new Response('owned port holder'),
      }),
    );
  // The PEM was read before this barrier. Reselection must reuse it without reading again.
  if (tls && !exhaust) fs.writeFileSync(join(f.certs, 'server.key'), 'rotated-after-load');
  fs.writeFileSync(release, 'release');
  await writer.exited;
  fs.rmSync(fifo);
  fs.writeFileSync(fifo, 'owned-barrier-capability', { mode: 0o600 });
  return { p, base };
}
for (const wrapper of [false, true])
  test(`${wrapper ? 'wrapper' : 'daemon'} real port reselection reuses loaded TLS and config-relative paths`, async () => {
    const f = fixture();
    const { p, base } = await barrier(f, wrapper);
    await poll(
      () =>
        readLocalDaemonEndpoint(base + 1, { home: f.home }).kind === 'found' ||
        p.proc.exitCode !== null,
      'TLS reselection',
    );
    expect(p.proc.exitCode).toBeNull();
    expect(
      (await fetch(`https://127.0.0.1:${base + 1}/health`, { tls: { ca: f.ca } })).status,
    ).toBe(200);
    expect(endpoint(f, base + 1).publicPort).toBe(base + 1);
  }, 30000);

test('exhausted wrapper probe is fatal with TLS and retains legacy local-agent degradation without TLS', async () => {
  const secure = fixture();
  const failed = await barrier(secure, true, true);
  expect(await exited(failed.p)).toBe(1);
  expect(fs.existsSync(join(installOnce(secure).claudeDir, 'argv'))).toBe(false);
  for (const held of rawServers.splice(0)) held.stop(true);
  const legacy = fixture();
  const degraded = await barrier(legacy, true, true, false);
  await poll(
    () => fs.existsSync(join(installOnce(legacy).claudeDir, 'argv')),
    'legacy agent launch',
  );
  expect(degraded.p.proc.exitCode).toBeNull();
}, 40000);

test('invalid same-PID sidecar refuses CLI and direct pairing without a TLS claim', async () => {
  const f = fixture();
  const h = await hub(f);
  const file = join(f.home, 'local-endpoints', `${h.port}.json`);
  const original = fs.readFileSync(file);
  fs.writeFileSync(file, '{ invalid owned endpoint');
  try {
    const cli = spawn(f, ['ls', '--host', '127.0.0.1', '--port', String(h.port)]);
    expect(await exited(cli)).not.toBe(0);
    const pair = spawn(f, ['pair'], true);
    expect(await exited(pair)).toBe(1);
    expect(
      pair.log.text.includes('Local daemon endpoint unavailable'),
      JSON.stringify({
        noHub: pair.log.text.includes('No hub is running'),
        notTty: pair.log.text.includes('needs an interactive terminal'),
        tlsRefusal: pair.log.text.includes('Direct QR pairing is unavailable'),
        hubFile: fs.existsSync(join(f.home, 'daemon-status.json')),
      }),
    ).toBe(true);
    expect(pair.log.text.includes('Direct QR pairing is unavailable')).toBe(false);
  } finally {
    fs.writeFileSync(file, original);
  }
}, 25000);

test('a missing TLS record makes one legacy attempt; a failed mapped target never falls back publicly', async () => {
  const f = fixture();
  const h = await hub(f);
  const file = join(f.home, 'local-endpoints', `${h.port}.json`);
  const saved = fs.readFileSync(file);
  fs.rmSync(file);
  try {
    const absent = spawn(f, ['ls', '--host', '127.0.0.1', '--port', String(h.port)]);
    expect(await exited(absent)).not.toBe(0);
  } finally {
    fs.writeFileSync(file, saved, { mode: 0o600 });
  }
  let publicUpgrades = 0;
  const publicObserver = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(req, server) {
      publicUpgrades++;
      if (server.upgrade(req)) return;
      return new Response('owned observer');
    },
    websocket: {
      message(ws) {
        ws.close();
      },
    },
  });
  rawServers.push(publicObserver);
  const closed = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('held') });
  const privatePort = closed.port as number;
  closed.stop(true);
  const record = {
    version: 1 as const,
    publicPort: publicObserver.port as number,
    privatePort,
    pid: process.pid,
    instanceId: randomUUID(),
  };
  publishLocalDaemonEndpoint(record, f.home);
  try {
    const mapped = spawn(f, ['ls', '--host', '127.0.0.1', '--port', String(record.publicPort)]);
    expect(await exited(mapped)).not.toBe(0);
    expect(publicUpgrades).toBe(0);
  } finally {
    releaseLocalDaemonEndpoint(record, f.home);
  }
}, 25000);
