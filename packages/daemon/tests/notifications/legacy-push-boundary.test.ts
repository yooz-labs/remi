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
