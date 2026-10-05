/** Real isolated CLI/hub processes and interprocess stores, with no model or external service. */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAuthResponse,
  createHello,
  createIdentity,
  deserialize,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import type { ProtocolMessage, UnlockedIdentity } from '@remi/shared';
import { CAPABILITY_HEADER, readCapabilityToken } from '../src/auth/capability-token.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';
import { reserveRange } from './session/port-test-helpers.ts';

const CLI = path.resolve(import.meta.dir, '../src/cli.ts');
const dirs: string[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const proc of procs.splice(0)) {
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await proc.exited;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-approval-process-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, 'bin'));
  // Any accidental harness launch is stopped before invoking a real CLI.
  for (const cli of ['claude', 'codex'])
    fs.writeFileSync(path.join(dir, 'bin', cli), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
  return dir;
}
function env(dir: string) {
  return {
    HOME: dir,
    REMI_HOME: path.join(dir, '.remi'),
    PATH: `${path.join(dir, 'bin')}:/usr/bin:/bin`,
    NODE_ENV: 'test',
  };
}
function spawn(dir: string, args: string[], script = CLI) {
  const proc = Bun.spawn([process.execPath, script, ...args], {
    env: env(dir),
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  procs.push(proc);
  return proc;
}
async function cli(dir: string, args: string[]) {
  const proc = spawn(dir, args);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}
async function wait(check: () => boolean, what: string, milliseconds = 10000) {
  const deadline = Date.now() + milliseconds;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}
async function connection(port: number, identity?: UnlockedIdentity, token?: string) {
  const ws = new WebSocket(
    `ws://127.0.0.1:${port}/ws`,
    (token ? { headers: { [CAPABILITY_HEADER]: token } } : undefined) as never,
  );
  sockets.push(ws);
  const messages: ProtocolMessage[] = [];
  ws.addEventListener('message', async (event) => {
    const message = deserialize(String(event.data));
    if (!message) return;
    messages.push(message);
    if (message.type === 'auth_challenge' && identity)
      ws.send(
        serialize(
          createAuthResponse(
            identity.publicKeyRaw,
            await sign(identity.privateKey, fromBase64(message.challenge)),
            identity.fingerprint,
          ),
        ),
      );
    if (message.type === 'auth_result' && message.success)
      ws.send(serialize(createHello('approval-test', '1.0.0')));
  });
  await wait(() => ws.readyState === WebSocket.OPEN || messages.length > 0, 'socket');
  return { ws, messages };
}

test('stock hub challenges bare loopback; CLI approves exact pending key; fresh retry and signed answer agree', async () => {
  const dir = directory();
  const port = await reserveRange(1);
  const hub = spawn(dir, [
    'serve',
    '--port',
    String(port),
    '--no-mdns',
    '--no-relay',
    '--no-telegram',
    '--no-tofu',
  ]);
  const statusPath = path.join(dir, '.remi', 'daemon-status.json');
  await wait(() => fs.existsSync(statusPath) || hub.exitCode !== null, 'stock hub');
  expect(hub.exitCode).toBeNull();
  const probe = await fetch(`http://127.0.0.1:${port}/auth-info`);
  expect((await probe.json()).authRequired).toBe(true);
  const bare = await connection(port);
  await wait(() => bare.messages.length > 0, 'bare challenge');
  expect(bare.messages[0]?.type).toBe('auth_challenge');
  const body = { sessionId: 'no-session', questionId: 'no-question', answer: 'yes' };
  const answer = (payload: object, token?: string) =>
    fetch(`http://127.0.0.1:${port}/answer`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { [CAPABILITY_HEADER]: token } : {}),
      },
      body: JSON.stringify(payload),
    });
  expect((await answer(body)).status).toBe(401);
  const client = await createIdentity();
  const identity = await unlockIdentity(client);
  const signedBody = {
    ...body,
    auth: {
      signature: await sign(
        identity.privateKey,
        new TextEncoder().encode(`${body.sessionId}|${body.questionId}|${body.answer}`).buffer,
      ),
      clientPublicKey: client.publicKey,
      clientFingerprint: client.fingerprint,
    },
  };
  expect((await answer(signedBody)).status).toBe(401);
  const store = new IdentityStore(path.join(dir, '.remi'));
  expect(store.listPendingKeys()).toHaveLength(0);
  const pending = await connection(port, identity);
  await wait(() => pending.messages.some((m) => m.type === 'auth_result'), 'unknown refusal');
  expect(pending.messages.find((m) => m.type === 'auth_result')).toMatchObject({
    success: false,
    error: 'UNKNOWN_KEY',
  });
  await wait(() => pending.ws.readyState === WebSocket.CLOSED, 'rejected connection closes');
  const listed = await cli(dir, ['keys']);
  expect(listed.code).toBe(0);
  expect(listed.stdout).toContain(client.fingerprint);
  expect(listed.stdout).toContain(client.publicKey);
  const authorized = await cli(dir, ['authorize', client.fingerprint, '--label', 'test-phone']);
  expect(authorized.code).toBe(0);
  const retry = await connection(port, identity);
  await wait(() => retry.messages.some((m) => m.type === 'hello_ack'), 'approved retry');
  expect(retry.messages.find((m) => m.type === 'auth_result')).toMatchObject({ success: true });
  expect((await answer(signedBody)).status).toBe(404); // Auth passes; session-less hub has no target.
  const token = readCapabilityToken(path.join(dir, '.remi', 'capability.key'));
  expect(token).not.toBeNull();
  const tokenProbe = await fetch(`http://127.0.0.1:${port}/auth-info`, {
    headers: { [CAPABILITY_HEADER]: token ?? '' },
  });
  expect((await tokenProbe.json()).authRequired).toBe(false);
  expect((await answer(body, token ?? '')).status).toBe(404);
  const capable = await connection(port, undefined, token ?? '');
  capable.ws.send(serialize(createHello('capability-test', '1.0.0')));
  await wait(() => capable.messages.some((m) => m.type === 'hello_ack'), 'capability hello');
  expect(capable.messages.some((m) => m.type === 'auth_challenge')).toBe(false);
}, 20000);

test('local CLI refuses missing/expired/malformed input and accepts canonical public-only JSON', async () => {
  const dir = directory();
  const store = new IdentityStore(path.join(dir, '.remi'));
  const client = await createIdentity();
  await store.registerPendingKey(client.publicKey);
  const pendingPath = path.join(dir, '.remi', 'pending_keys.json');
  const data = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
  data.keys[0].firstSeenAt = new Date(Date.now() - 700000).toISOString();
  data.keys[0].expiresAt = new Date(Date.parse(data.keys[0].firstSeenAt) + 600000).toISOString();
  fs.writeFileSync(pendingPath, JSON.stringify(data));
  expect((await cli(dir, ['authorize', client.fingerprint])).code).toBe(1);
  expect(store.listPendingKeys()).toHaveLength(0);
  expect((await cli(dir, ['authorize', '0000000000000000'])).code).toBe(1);
  expect((await cli(dir, ['authorize', '{"publicKey":"AAAA"}'])).code).toBe(1);
  const importResult = await cli(dir, [
    'authorize',
    JSON.stringify({ publicKey: client.publicKey }),
    '--label',
    'import',
  ]);
  expect(importResult.code).toBe(0);
  expect(store.isAuthorized(client.publicKey, client.fingerprint)).toBe(true);
});

test('real processes approve, touch and revoke without lost grants or resurrected revocations', async () => {
  const dir = directory();
  const store = new IdentityStore(dir);
  const fingerprints: string[] = [];
  for (let i = 0; i < 30; i++) {
    const client = await createIdentity();
    fingerprints.push(client.fingerprint);
    if (i < 10) await store.addAuthorizedKey(client.publicKey, 'revoke');
    else await store.registerPendingKey(client.publicKey);
  }
  fs.writeFileSync(path.join(dir, 'worker-public.json'), JSON.stringify(fingerprints));
  const worker = path.join(import.meta.dir, 'approval-store-worker.ts');
  const observer = spawn(dir, [dir, 'observe'], worker);
  const children = ['approve', 'touch', 'revoke'].map((mode) => spawn(dir, [dir, mode], worker));
  await wait(
    () =>
      ['approve', 'touch', 'revoke', 'observe'].every((mode) =>
        fs.existsSync(path.join(dir, `ready-${mode}`)),
      ),
    'all workers ready',
  );
  fs.writeFileSync(path.join(dir, 'go'), 'go');
  for (const child of children) {
    const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
  }
  fs.writeFileSync(path.join(dir, 'writers-done'), 'done');
  const [observerCode, observerErrors] = await Promise.all([
    observer.exited,
    new Response(observer.stderr).text(),
  ]);
  expect(observerErrors).toBe('');
  expect(observerCode).toBe(0);
  expect(
    store
      .listAuthorizedKeys()
      .map((key) => key.fingerprint)
      .sort(),
  ).toEqual(fingerprints.slice(10).sort());
  expect(store.listPendingKeys()).toHaveLength(0);
  expect(
    JSON.parse(fs.readFileSync(path.join(dir, 'authorized_keys.json'), 'utf8')).keys,
  ).toHaveLength(20);
}, 30000);

test('retired local setting is visibly ignored without changing unrelated TOML values', async () => {
  const dir = directory();
  fs.mkdirSync(path.join(dir, '.remi'));
  const configPath = path.join(dir, '.remi', 'config.toml');
  const source =
    '[daemon]\nrequire_local_auth = false\nbind = "127.0.0.1"\n[display]\nmax_bullet_length = 321\n';
  fs.writeFileSync(configPath, source);
  const result = await cli(dir, ['config', 'show']);
  expect(result.code).toBe(0);
  expect(result.stderr).toContain('require_local_auth is retired and ignored');
  expect(result.stdout).toContain('321');
  expect(result.stdout).not.toContain('require_local_auth');
  expect(fs.readFileSync(configPath, 'utf8')).toBe(source);
});

for (const optOut of ['flag', 'config'] as const) {
  test(`explicit auth opt-out by ${optOut} warns even on loopback`, async () => {
    const dir = directory();
    if (optOut === 'config') {
      fs.mkdirSync(path.join(dir, '.remi'));
      fs.writeFileSync(path.join(dir, '.remi', 'config.toml'), '[auth]\nenabled = false\n');
    }
    const port = await reserveRange(1);
    const hub = spawn(dir, [
      'serve',
      '--port',
      String(port),
      '--no-mdns',
      '--no-relay',
      '--no-telegram',
      ...(optOut === 'flag' ? ['--no-auth'] : []),
    ]);
    const stderr = new Response(hub.stderr).text();
    await wait(
      () => fs.existsSync(path.join(dir, '.remi', 'daemon-status.json')) || hub.exitCode !== null,
      'opt-out hub',
    );
    expect(hub.exitCode).toBeNull();
    const client = await connection(port);
    client.ws.send(serialize(createHello('auth-off-test', '1.0.0')));
    await wait(
      () => client.messages.some((m) => m.type === 'hello_ack'),
      'explicit auth-off connection',
    );
    expect(client.messages.some((m) => m.type === 'auth_challenge')).toBe(false);
    expect((await (await fetch(`http://127.0.0.1:${port}/auth-info`)).json()).authRequired).toBe(
      false,
    );
    hub.kill('SIGTERM');
    await hub.exited;
    expect(await stderr).toContain('WARNING: authentication disabled');
  }, 20000);
}
