/** Opt-in real Chromium + Vite + daemon-adapter tests. No user profile/state. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import {
  createIdentity,
  fingerprint,
  fromBase64,
  isSmallOrderPublicKey,
  unlockIdentity,
} from '@remi/shared';
import { type ViteDevServer, createServer } from 'vite';
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter';
import { Authenticator } from '../../../daemon/src/auth/authenticator';
import { IdentityStore } from '../../../daemon/src/auth/identity-store';
import { occupyEphemeral } from '../../../daemon/tests/session/port-test-helpers';

const enabled = process.env['REMI_BROWSER_TESTS'] === '1';
const browserTest = enabled ? test : test.skip;
let browser: Browser;
let vite: ViteDevServer;
let origin: string;
let privateDir: string;

beforeAll(async () => {
  if (!enabled) return;
  privateDir = await mkdtemp(join(tmpdir(), 'remi873-browser-'));
  vite = await createServer({
    root: resolve(import.meta.dir, '../..'),
    configFile: resolve(import.meta.dir, '../../vite.config.ts'),
    server: { host: '127.0.0.1', port: 0 },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('No Vite address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: process.env['REMI_BROWSER_EXECUTABLE'],
    env: { HOME: privateDir, PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
  });
}, 15000);

afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  await vite?.close();
  await rm(privateDir, { recursive: true, force: true });
});

async function realDaemon(claimedFingerprint?: string, publicKey?: string) {
  const generated = await unlockIdentity(await createIdentity());
  const identity = {
    ...generated,
    ...(claimedFingerprint && { fingerprint: claimedFingerprint as typeof generated.fingerprint }),
    ...(publicKey && { publicKeyRaw: publicKey as typeof generated.publicKeyRaw }),
  };
  const store = new IdentityStore(join(privateDir, crypto.randomUUID()));
  const held = await occupyEphemeral('127.0.0.1');
  await new Promise<void>((resolve) => held.server.close(() => resolve()));
  const adapter = new WebSocketAdapter({
    port: held.port,
    host: '127.0.0.1',
    authenticator: new Authenticator({ identity, identityStore: store }),
  });
  await adapter.start();
  return { adapter, store, identity, url: `ws://127.0.0.1:${held.port}/ws` };
}

browserTest(
  'App opens a fresh hostname form while another host retains pending approval',
  async () => {
    const daemon = await realDaemon();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await page
        .getByPlaceholder('localhost')
        .fill(daemon.url.replace('ws://', '').replace('/ws', ''));
      await page.getByRole('button', { name: 'Connect', exact: true }).last().click();
      await page.getByRole('heading', { name: 'Approval needed', exact: true }).last().waitFor();
      expect(daemon.store.listPendingKeys()).toHaveLength(1);
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      // Immediate DOM assertion: fails on the actual App caller's old global selection.
      expect(await page.getByPlaceholder('localhost').count()).toBe(1);
      expect(await page.getByRole('heading', { name: 'Approval needed' }).count()).toBe(1);
    } finally {
      await context.close();
      await daemon.adapter.stop();
    }
  },
  15000,
);

for (const action of ['deleteIdentity', 'replaceIdentity'] as const) {
  browserTest(
    `manager never signs with an identity ${action} replaced during real key import`,
    async () => {
      const daemon = await realDaemon();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(origin);
        await page.evaluate(async () => {
          const path = '/tests/browser/approval-harness.tsx';
          const harness = await import(path);
          await harness.start();
        });
        await page.getByTestId('manager-state').waitFor();
        await page.evaluate(async (url) => {
          const path = '/tests/browser/approval-harness.tsx';
          (await import(path)).connectTo(url);
        }, daemon.url);
        await page.waitForFunction(async () => {
          const path = '/tests/browser/approval-harness.tsx';
          return (await import(path)).reached();
        });
        await page.evaluate(async (action) => {
          const path = '/tests/browser/approval-harness.tsx';
          const harness = await import(path);
          await harness[action]();
          harness.release();
        }, action);
        // Let the real queued crypto/socket continuations run; assert daemon state, not a timeout.
        await page.waitForTimeout(200);
        expect(daemon.store.listPendingKeys()).toHaveLength(0);
        const raw = await page.getByTestId('manager-state').textContent();
        expect(raw).not.toContain('UNKNOWN_KEY');
      } finally {
        await context.close();
        await daemon.adapter.stop();
      }
    },
    15000,
  );
}

browserTest(
  'manager rejects a real daemon key claiming a different pinned key fingerprint',
  async () => {
    const pinned = await unlockIdentity(await createIdentity());
    const daemon = await realDaemon(pinned.fingerprint);
    expect(daemon.identity.publicKeyRaw).not.toBe(pinned.publicKeyRaw);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin);
      const client = await page.evaluate(
        async ({ url, fingerprint, publicKey }) => {
          const identityPath = '/src/lib/identity-client.ts';
          (await import(identityPath)).trustHost(url, fingerprint, publicKey);
          const path = '/tests/browser/approval-harness.tsx';
          return (await import(path)).start();
        },
        { url: daemon.url, fingerprint: pinned.fingerprint, publicKey: pinned.publicKeyRaw },
      );
      await daemon.store.addAuthorizedKey(client.publicKey, 'isolated-browser');
      await page.getByTestId('manager-state').waitFor();
      await page.evaluate(async (url) => {
        const path = '/tests/browser/approval-harness.tsx';
        const harness = await import(path);
        harness.release();
        harness.connectTo(url);
      }, daemon.url);
      await page.waitForTimeout(200);
      const known = await page.evaluate(
        (url) => JSON.parse(localStorage.getItem('remi-known-hosts') ?? '{}')[url],
        daemon.url,
      );
      expect(known.publicKey).toBe(pinned.publicKeyRaw);
      expect(await page.getByTestId('manager-state').textContent()).not.toContain(
        '"status":"connected"',
      );
    } finally {
      await context.close();
      await daemon.adapter.stop();
    }
  },
  15000,
);

for (const options of [
  { stored: 'none' },
  { memoryOnly: true },
  { stored: 'encrypted' },
] as const) {
  browserTest(
    `manager preserves genuine first-use/memory/passphrase flow ${JSON.stringify(options)}`,
    async () => {
      const daemon = await realDaemon();
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(origin);
        await page.evaluate(async (options) => {
          const path = '/tests/browser/approval-harness.tsx';
          const harness = await import(path);
          await harness.start(options);
          harness.release();
        }, options);
        await page.getByTestId('manager-state').waitFor();
        await page.evaluate(async (url) => {
          const path = '/tests/browser/approval-harness.tsx';
          (await import(path)).connectTo(url);
        }, daemon.url);
        if ('stored' in options && options.stored === 'encrypted') {
          await page.waitForFunction(async () => {
            const path = '/tests/browser/approval-harness.tsx';
            return (await import(path))
              .snapshot()
              .some((c: { needsPassphrase: boolean }) => c.needsPassphrase);
          });
          await page.evaluate(async () => {
            const path = '/tests/browser/approval-harness.tsx';
            await (await import(path)).providePassphrase();
          });
        }
        await page.waitForFunction(async () => {
          const path = '/tests/browser/approval-harness.tsx';
          return (await import(path)).snapshot().some((c: { approval?: unknown }) => c.approval);
        });
        expect(daemon.store.listPendingKeys()).toHaveLength(1);
      } finally {
        await context.close();
        await daemon.adapter.stop();
      }
    },
    15000,
  );
}

browserTest(
  'manager rejects all 14 reviewed small-order server key encodings before responding',
  async () => {
    // Read the actual single reviewed TS table, never maintain another TS list.
    const source = readFileSync(
      resolve(import.meta.dir, '../../../shared/src/relay/small-order.ts'),
      'utf8',
    );
    const encodings = [...source.matchAll(/'([0-9a-f]{64})'/g)].map((match) => match[1] ?? '');
    expect(encodings).toHaveLength(14);
    for (const hex of encodings) {
      const publicKey = Buffer.from(hex, 'hex').toString('base64');
      expect(isSmallOrderPublicKey(new Uint8Array(fromBase64(publicKey)))).toBe(true);
      const daemon = await realDaemon(await fingerprint(fromBase64(publicKey)), publicKey);
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await page.goto(origin);
        await page.evaluate(async () => {
          const path = '/tests/browser/approval-harness.tsx';
          const harness = await import(path);
          await harness.start();
          harness.release();
        });
        await page.getByTestId('manager-state').waitFor();
        await page.evaluate(async (url) => {
          const path = '/tests/browser/approval-harness.tsx';
          (await import(path)).connectTo(url);
        }, daemon.url);
        await page.waitForTimeout(150);
        expect(daemon.store.listPendingKeys()).toHaveLength(0);
        expect(await page.getByTestId('manager-state').textContent()).toContain(
          'Server public key is invalid',
        );
      } finally {
        await context.close();
        await daemon.adapter.stop();
      }
    }
  },
  15000,
);
