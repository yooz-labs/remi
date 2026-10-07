/**
 * Pairing end to end (#1275, ADR 0037), with no stand-ins: a real hub from source with
 * authentication on, the `remi pair` flow over the hub's own identity store, and a real WebSocket
 * client that reads the link, checks the machine's key, answers the challenge with the code, waits
 * while the person decides, and then lists sessions.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAuthResponse,
  createHello,
  createIdentity,
  createSessionListRequest,
  decodePairingLink,
  deserialize,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import type { AuthResultMessage, ProtocolMessage } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { pairFlow } from '../../src/cli/cmd-pair.ts';
import { reserveRange } from '../session/port-test-helpers.ts';

const CLI = path.resolve(import.meta.dir, '../../src/cli.ts');
const dirs: string[] = [];
const procs: ReturnType<typeof Bun.spawn>[] = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const proc of procs.splice(0)) {
    proc.kill('SIGTERM');
    await proc.exited;
  }
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function wait(check: () => boolean, what: string, ms = 15000) {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

test('scan, claim, approve at the terminal, then hello_ack and the session list', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-pair-hub-'));
  dirs.push(dir);
  const remiHome = path.join(dir, '.remi');
  const port = await reserveRange(1);
  const hub = Bun.spawn(
    [
      process.execPath,
      CLI,
      'serve',
      '--port',
      String(port),
      '--no-mdns',
      '--no-relay',
      '--no-telegram',
    ],
    {
      env: { HOME: dir, REMI_HOME: remiHome, PATH: '/usr/bin:/bin', NODE_ENV: 'test' },
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  procs.push(hub);
  await wait(
    () => fs.existsSync(path.join(remiHome, 'daemon-status.json')) || hub.exitCode !== null,
    'the hub',
  );
  expect(hub.exitCode).toBeNull();

  // The terminal side: `remi pair` over the hub's own store.
  const store = new IdentityStore(remiHome);
  const machine = store.load();
  if (!machine) throw new Error('the hub made no identity');
  const out: string[] = [];
  let decided = false;
  const flow = pairFlow({
    store,
    machineKey: machine.publicKey,
    machineFingerprint: machine.fingerprint,
    name: 'integration-mac',
    host: '127.0.0.1',
    port,
    write: (text) => out.push(text),
    ask: async () => {
      decided = true;
      return 'y';
    },
    pollMs: 50,
  });
  await wait(() => out.join('').includes('remi://pair#'), 'the link');
  const line =
    out
      .join('')
      .split('\n')
      .find((l) => l.includes('remi://pair#')) ?? '';
  const decoded = decodePairingLink(line.slice(line.indexOf('remi://pair#')).trim());
  if (!decoded.ok) throw new Error(`the link was refused: ${decoded.error}`);

  // The phone.
  const phone = await unlockIdentity(await createIdentity());
  const ws = new WebSocket(`ws://${decoded.code.host}:${decoded.code.port}/ws`);
  sockets.push(ws);
  const messages: ProtocolMessage[] = [];
  let keyMatched: boolean | null = null;
  ws.addEventListener('message', async (event) => {
    const message = deserialize(String(event.data));
    if (!message) return;
    messages.push(message);
    if (message.type === 'auth_challenge') {
      keyMatched = message.serverPublicKey === decoded.code.key;
      if (!keyMatched) return;
      ws.send(
        serialize(
          createAuthResponse(
            phone.publicKeyRaw,
            await sign(phone.privateKey, fromBase64(message.challenge)),
            phone.fingerprint,
            undefined,
            { nonce: decoded.code.nonce, label: 'Integration phone' },
          ),
        ),
      );
    }
    if (message.type === 'auth_result' && message.success) {
      ws.send(serialize(createHello('pair-test', '1.0.0')));
    }
    if (message.type === 'hello_ack') ws.send(serialize(createSessionListRequest(false)));
  });

  await wait(
    () => messages.some((m) => m.type === 'session_list_response'),
    'the session list',
    30000,
  );
  expect(keyMatched as boolean | null).toBe(true);
  expect(decided).toBe(true);
  expect(await flow).toBe(0);
  const result = messages.find((m): m is AuthResultMessage => m.type === 'auth_result');
  expect(result?.success).toBe(true);
  expect(messages.some((m) => m.type === 'hello_ack')).toBe(true);
  expect(new IdentityStore(remiHome).listAuthorizedKeys().map((k) => k.label)).toContain(
    'Integration phone',
  );
}, 60000);
