/** Actual legacy sender, private authority files and owned HTTP receiver only. */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createIdentity } from '@remi/shared';
import { IdentityStore } from '../../src/auth/identity-store.ts';
import { type PushTriggerOptions, sendPushTrigger } from '../../src/notifications/push-client.ts';
import { RelayDeviceStore } from '../../src/remote/relay-device-store.ts';

let directory: string;
let server: ReturnType<typeof Bun.serve>;
let requests: string[];
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'remi-legacy-boundary-'));
  chmodSync(directory, 0o700);
  requests = [];
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      requests.push(await req.text());
      return Response.json({ success: true });
    },
  });
});
afterEach(async () => {
  await server.stop(true);
  rmSync(directory, { recursive: true, force: true });
});
const options = () =>
  ({
    title: 'owned title',
    body: 'owned body',
    pushSecret: 'owned-secret',
    authorityDirectory: directory,
    legacyEnabled: true,
  }) as PushTriggerOptions;
test('legacy sender defaults OFF before any authority read or owned network effect', async () => {
  const opts: PushTriggerOptions = {
    title: 'owned title',
    body: 'owned body',
    pushSecret: 'owned-secret',
    authorityDirectory: join(directory, 'untouched'),
  };
  await expect(sendPushTrigger(server.url.origin, 'owned-token', opts)).rejects.toThrow(
    'LEGACY_PUSH_DISABLED',
  );
  expect(requests).toHaveLength(0);
  expect(Bun.file(join(directory, 'untouched', 'authorized_keys.json.lock')).size).toBe(0);
});
test('legacy sender requires nonempty secret before owned network effect', async () => {
  await expect(
    sendPushTrigger(server.url.origin, 'owned-token', { ...options(), pushSecret: '  ' }),
  ).rejects.toThrow('LEGACY_PUSH_SECRET_REQUIRED');
  expect(requests).toHaveLength(0);
});
test('legacy sender refuses secure activation after actual enrollment and raw-row removal', async () => {
  const trust = new IdentityStore(directory);
  const devices = new RelayDeviceStore(directory, trust);
  const identity = await createIdentity();
  await trust.addAuthorizedKey(identity.publicKey, 'owned');
  await devices.add(identity.publicKey, 'owned');
  devices.remove(identity.fingerprint);
  expect(JSON.parse(readFileSync(join(directory, 'relay_devices.json'), 'utf8'))).toEqual([]);
  await expect(sendPushTrigger(server.url.origin, 'owned-token', options())).rejects.toThrow(
    'LEGACY_PUSH_NOT_ELIGIBLE',
  );
  expect(requests).toHaveLength(0);
});
test('legacy sender refuses corrupt activation without leaking parser text', async () => {
  writeFileSync(join(directory, 'secure_push_activation.json'), 'PRIVATE_PARSER_SENTINEL', {
    mode: 0o600,
  });
  await expect(sendPushTrigger(server.url.origin, 'owned-token', options())).rejects.toThrow(
    'LEGACY_PUSH_NOT_ELIGIBLE',
  );
  expect(requests).toHaveLength(0);
});
test('explicit legacy sender preserves actual owned request payload', async () => {
  await expect(
    sendPushTrigger(server.url.origin, 'owned-token', options()),
  ).resolves.toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(JSON.parse(requests[0] ?? '')).toEqual({
    token: 'owned-token',
    title: 'owned title',
    body: 'owned body',
  });
});

test('legacy sender never treats revoked legacy raw enrollment as eligible', async () => {
  const identity = await createIdentity();
  // Pre-R5 on-disk legacy row: no activation latch or enrollment epoch yet.
  writeFileSync(
    join(directory, 'relay_devices.json'),
    JSON.stringify([
      {
        publicKey: identity.publicKey,
        fingerprint: identity.fingerprint,
        label: 'owned legacy',
        createdAt: new Date().toISOString(),
        lastUsedAt: null,
      },
    ]),
    { mode: 0o600 },
  );
  await expect(sendPushTrigger(server.url.origin, 'owned-token', options())).rejects.toThrow(
    'LEGACY_PUSH_NOT_ELIGIBLE',
  );
  expect(requests).toHaveLength(0);
  expect(JSON.parse(readFileSync(join(directory, 'secure_push_activation.json'), 'utf8'))).toEqual({
    version: 1,
    activated: true,
  });
});
test('legacy sender refuses corrupt raw enrollment instead of assuming an empty store', async () => {
  writeFileSync(join(directory, 'relay_devices.json'), 'PRIVATE_LEGACY_PARSE_SENTINEL', {
    mode: 0o600,
  });
  await expect(sendPushTrigger(server.url.origin, 'owned-token', options())).rejects.toThrow(
    'LEGACY_PUSH_NOT_ELIGIBLE',
  );
  expect(requests).toHaveLength(0);
});
test('legacy sender serializes payload before final locked activation check', async () => {
  const { activateSecurePushLocked } = await import('../../src/storage/secure-push-activation.ts');
  const { withInterprocessFileLock } = await import('../../src/storage/interprocess-file-lock.ts');
  const values = ['owned-option'];
  // Controlled serialization delivery boundary; actual file lock/latch remain intact.
  Object.defineProperty(values, 'toJSON', {
    value() {
      withInterprocessFileLock(join(directory, 'authorized_keys.json'), () =>
        activateSecurePushLocked(directory),
      );
      return ['owned-option'];
    },
  });
  await expect(
    sendPushTrigger(server.url.origin, 'owned-token', { ...options(), options: values }),
  ).rejects.toThrow('LEGACY_PUSH_NOT_ELIGIBLE');
  expect(requests).toHaveLength(0);
});
test('legacy sender actual child diagnostics omit token, content and arbitrary receiver body', async () => {
  await server.stop(true);
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch() {
      return new Response('PRIVATE_RESPONSE_SENTINEL', { status: 400 });
    },
  });
  const module = new URL('../../src/notifications/push-client.ts', import.meta.url).href;
  const script = `import {sendPushTrigger} from ${JSON.stringify(module)};try { await sendPushTrigger(${JSON.stringify(server.url.origin)}, 'PRIVATE_TOKEN_SENTINEL', ${JSON.stringify({ ...options(), title: 'PRIVATE_TITLE_SENTINEL', body: 'PRIVATE_BODY_SENTINEL' })}); } catch(e) { console.log(e instanceof Error ? e.message : 'UNKNOWN'); }`;
  const child = Bun.spawn([process.execPath, '-e', script], {
    env: { HOME: directory, REMI_HOME: directory, PATH: process.env['PATH'] ?? '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(code).toBe(0);
  expect(stdout).toBe('LEGACY_PUSH_REJECTED\n');
  expect(`${stdout}${stderr}`).not.toContain('PRIVATE_');
  expect(child.exitCode).toBe(0);
});
