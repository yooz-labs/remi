/** Owned source hub; IPC controls only terminal approval and transport retirement (#1574). */
import * as fs from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path';

const own = fs.realpathSync(process.cwd());
if (!basename(own).startsWith('remi-swift-pairing-') || fs.readdirSync(own).length !== 0)
  throw new Error('owned empty launch directory required');
if (Bun.version !== '1.3.11') throw new Error('pinned Bun required');
const state = join(own, 'state');
process.env['REMI_HOME'] = state;
const { IdentityStore } = await import('../../../../daemon/src/auth/identity-store.ts');
const { reserveRange } = await import('../../../../daemon/tests/session/port-test-helpers.ts');
const { createIdentity } = await import('../../../../shared/src/index.ts');
const { encodePairingLink } = await import('../../../../shared/src/pairing.ts');
const bin = join(own, 'bin');
fs.mkdirSync(bin, { mode: 0o700 });
for (const agent of ['claude', 'codex'])
  fs.writeFileSync(join(bin, agent), '#!/bin/sh\nexit 88\n', { mode: 0o700 });
const inheritedPath = (process.env['PATH'] ?? '/usr/bin:/bin').split(delimiter).filter(isAbsolute);
const env = {
  HOME: own,
  REMI_HOME: state,
  NODE_ENV: 'test',
  PATH: [...new Set([bin, dirname(process.execPath), ...inheritedPath])].join(delimiter),
};
const store = new IdentityStore(state);
await store.generate();
const mode = process.argv[2] ?? 'approve';
const local = process.env['REMI_NATIVE_PAIRING_LOCAL'];
const tail = process.env['REMI_NATIVE_PAIRING_TAIL'];
const bind = mode === 'v2' ? tail : '127.0.0.1';
if (!bind || (mode === 'v2' && !local))
  throw new Error('explicit owned interface addresses required');
const v2Hosts: string[] = [];
if (mode === 'v2') {
  if (!local || !tail) throw new Error('explicit owned interface addresses required');
  v2Hosts.push(local, tail);
}
const port = await reserveRange(1, 50, bind);
const hub = Bun.spawn(
  [
    process.execPath,
    resolve(import.meta.dir, '../../../../daemon/src/cli.ts'),
    'serve',
    '--port',
    String(port),
    '--bind',
    bind,
    '--no-mdns',
    '--no-relay',
    '--no-telegram',
    ...(mode === 'noauth' ? ['--no-auth'] : []),
  ],
  {
    env,
    cwd: own,
    stdout: 'ignore',
    stderr: 'ignore',
  },
);
const emit = (value: object) => process.stdout.write(`${JSON.stringify(value)}\n`);
let approval = false;
let timer: ReturnType<typeof setInterval> | undefined;
try {
  const until = Date.now() + 15000;
  while (!fs.existsSync(join(state, 'daemon-status.json'))) {
    if (Date.now() > until || hub.exitCode !== null) throw new Error('source hub did not start');
    await Bun.sleep(20);
  }
  const machine = store.load();
  if (!machine) throw new Error('source hub identity absent');
  const pairing = store.createPairing();
  const common = {
    name: 'Owned source',
    port,
    key: machine.publicKey,
    nonce: pairing.nonce,
    exp: Math.floor(Date.parse(pairing.record.expiresAt) / 1000),
    proto: 1,
  };
  const link =
    mode === 'v2'
      ? encodePairingLink({ v: 2, ...common, hosts: v2Hosts })
      : encodePairingLink({ v: 1, ...common, host: '127.0.0.1' });
  if (mode === 'cancelled') store.cancelPairing(pairing.nonce);
  if (mode === 'expired') {
    const recordFile = join(state, 'pairings.json');
    const data = JSON.parse(fs.readFileSync(recordFile, 'utf8'));
    const expired = Date.now() - 1000;
    data.pairings[0].expiresAt = new Date(expired).toISOString();
    data.pairings[0].createdAt = new Date(expired - 300000).toISOString();
    fs.writeFileSync(recordFile, JSON.stringify(data), { mode: 0o600 });
  }
  const closedPort = await reserveRange(1, 50, '127.0.0.1');
  if (mode === 'queue') {
    for (let i = 0; i < 32; i++)
      await store.registerPendingKey((await createIdentity()).publicKey, { forPairing: true });
  }
  if (mode === 'store')
    fs.writeFileSync(join(state, 'pending_keys.json'), '{invalid', { mode: 0o600 });
  emit({ link, port, closedPort, key: machine.publicKey });
  let automatic = mode === 'approve' || mode === 'v2';
  timer = setInterval(async () => {
    const record = store.peekPairing(pairing.nonce);
    if (!approval && record?.state === 'claimed' && record.claim && automatic) {
      approval = true;
      await store.approvePairing(pairing.nonce, record.claim.fingerprint);
    }
  }, 20);
  for await (const chunk of Bun.stdin.stream()) {
    for (const line of new TextDecoder().decode(chunk).trim().split('\n')) {
      if (line === 'receipts') {
        const record = store.peekPairing(pairing.nonce);
        emit({
          state: record?.state,
          claim: record?.claim?.fingerprint,
          label: record?.claim?.label,
          authorized: store.listAuthorizedKeys().length,
        });
      } else if (line === 'approve') {
        const claim = store.peekPairing(pairing.nonce)?.claim;
        if (claim) await store.approvePairing(pairing.nonce, claim.fingerprint);
      } else if (line === 'recover') {
        fs.rmSync(join(state, 'pending_keys.json'), { force: true });
        automatic = true;
      } else if (line === 'cancel') store.cancelPairing(pairing.nonce);
      else if (line === 'stop') process.stdin.destroy();
    }
  }
} finally {
  if (timer) clearInterval(timer);
  hub.kill('SIGTERM');
  await hub.exited;
}
if (fs.existsSync(join(own, '.remi'))) throw new Error('default home touched');
