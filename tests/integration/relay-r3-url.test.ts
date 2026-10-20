import { expect, test } from 'bun:test';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { relayV2 } from '@remi/shared';
import { DEFAULT_CONFIG } from '../../packages/daemon/src/config/config.ts';
import { relaySecurePushAudience } from '../../packages/daemon/src/remote/relay-url.ts';
import { reserveRange } from '../../packages/daemon/tests/session/port-test-helpers.ts';
import { Socket } from '../../packages/signaling/tests/e2e/endpoints.ts';
import { startWorker } from '../../packages/signaling/tests/e2e/harness.ts';

test.each([
  ['wss://relay.example', 'https://relay.example'],
  ['wss://relay.example/', 'https://relay.example'],
  ['https://relay.example/', 'https://relay.example'],
  ['wss://relay.example:443/', 'https://relay.example'],
  ['wss://127.0.0.1:18443', 'https://127.0.0.1:18443'],
  ['wss://[::1]:18443/', 'https://[::1]:18443'],
])('secure push accepts root audience %s', (base, audience) => {
  expect(relaySecurePushAudience(base)).toBe(audience);
});

test.each([
  'wss://relay.example/remi-prefix',
  'wss://relay.example/remi-prefix/',
  'wss://relay.example/remi-prefix/..',
  'wss://relay.example/.',
  'wss://relay.example//',
  'wss://relay.example/?token=private',
  'wss://relay.example/?',
  'wss://relay.example/#private',
  'wss://relay.example/#',
  'wss://relay.example\\remi-prefix',
  'wss://user:private@relay.example',
  'ws://relay.example',
  'http://relay.example',
  ' wss://relay.example',
  'wss://relay.example ',
  'not a URL',
])('secure push refuses ambiguous or unsupported route %s', (base) => {
  expect(relaySecurePushAudience(base)).toBeNull();
});

test('actual default relay endpoint construction reaches the real R2 nonce route, preserving custom prefixes', async () => {
  expect(new URL(DEFAULT_CONFIG.network.signaling_url).pathname).toBe('/');
  const { relayWorkerUrl } = await import('../../packages/daemon/src/remote/relay-url.ts');
  const worker = await startWorker();
  let socket: Socket | undefined;
  try {
    const identity = await relayV2.generateIdentity();
    const rid = await relayV2.ridOf(identity.signer.publicKey);
    const url = new URL(relayWorkerUrl(DEFAULT_CONFIG.network.signaling_url, 'host', rid));
    expect(url.origin).toBe('wss://remi-signaling.yooz.workers.dev');
    expect(url.pathname).toBe(`/v2/host/${Buffer.from(rid).toString('hex')}`);
    socket = await Socket.open(worker.wsUrl + url.pathname);
    expect((await socket.json())['t']).toBe('nonce');
    expect(new URL(relayWorkerUrl('wss://proxy.example/custom/', 'host', rid)).pathname).toBe(
      `/custom/v2/host/${Buffer.from(rid).toString('hex')}`,
    );
  } finally {
    socket?.close();
    await worker.stop();
  }
}, 10000);

test.each(['/connect', '/connect/'])(
  'recognized official legacy %s refuses before listener, dialing or model work and preserves TOML',
  async (path) => {
    const dir = mkdtempSync(join(tmpdir(), 'remi-r3-legacy-url-'));
    chmodSync(dir, 0o700);
    mkdirSync(join(dir, 'bin'), { mode: 0o700 });
    mkdirSync(join(dir, 'state'), { mode: 0o700 });
    for (const name of ['claude', 'codex'])
      writeFileSync(join(dir, 'bin', name), '#!/bin/sh\ntouch "$HOME/model-called"\nexit 88\n', {
        mode: 0o700,
      });
    const original = `[network]\nrelay = true\nsignaling_url = "wss://remi-signaling.yooz.workers.dev${path}"\n[custom]\nvalue = "preserve-me"\n`;
    writeFileSync(join(dir, 'state/config.toml'), original, { mode: 0o600 });
    // Auth-off guarantees that a failing pre-fix pin never contacts the public Worker.
    const port = await reserveRange(1, 50, '127.0.0.1');
    const proc = Bun.spawn(
      [
        process.execPath,
        resolve(import.meta.dir, '../../packages/daemon/src/cli.ts'),
        'serve',
        '--relay',
        '--no-auth',
        '--port',
        String(port),
        '--no-mdns',
        '--no-telegram',
      ],
      {
        cwd: dir,
        env: {
          HOME: dir,
          REMI_HOME: join(dir, 'state'),
          PATH: `${join(dir, 'bin')}:/usr/bin:/bin`,
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const output = new Response(proc.stderr).text();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const exit = await Promise.race([
        proc.exited,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), 1000);
        }),
      ]);
      if (timer) clearTimeout(timer);
      expect(exit).toBe(1);
      expect(await output).toContain(
        'Set [network] signaling_url = "wss://remi-signaling.yooz.workers.dev"',
      );
      expect(readFileSync(join(dir, 'state/config.toml'), 'utf8')).toBe(original);
      expect(existsSync(join(dir, 'model-called'))).toBe(false);
      const health = await fetch(`http://127.0.0.1:${port}/health`).catch(() => null);
      expect(health).toBeNull();
    } finally {
      if (timer) clearTimeout(timer);
      if (proc.exitCode === null) proc.kill('SIGTERM');
      await proc.exited;
      rmSync(dir, { recursive: true, force: true });
    }
  },
  10000,
);
