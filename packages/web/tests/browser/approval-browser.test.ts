/** Opt-in real Chromium + Vite + daemon-adapter tests. No user profile/state. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium, type Browser } from '@playwright/test';
import { createIdentity, unlockIdentity } from '@remi/shared';
import { createServer, type ViteDevServer } from 'vite';
import { Authenticator } from '../../../daemon/src/auth/authenticator';
import { IdentityStore } from '../../../daemon/src/auth/identity-store';
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter';
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
  vite = await createServer({ root: resolve(import.meta.dir, '../..'), configFile: resolve(import.meta.dir, '../../vite.config.ts'), server: { host: '127.0.0.1', port: 0 } });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('No Vite address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({ executablePath: process.env['REMI_BROWSER_EXECUTABLE'], env: { HOME: privateDir, PATH: process.env['PATH'] ?? '/usr/bin:/bin' } });
}, 15000);

afterAll(async () => {
  if (!enabled) return;
  await browser?.close();
  await vite?.close();
  await rm(privateDir, { recursive: true, force: true });
});

async function realDaemon() {
  const identity = await unlockIdentity(await createIdentity());
  const store = new IdentityStore(join(privateDir, crypto.randomUUID()));
  const held = await occupyEphemeral('127.0.0.1');
  await new Promise<void>((resolve) => held.server.close(() => resolve()));
  const adapter = new WebSocketAdapter({ port: held.port, host: '127.0.0.1', authenticator: new Authenticator({ identity, identityStore: store }) });
  await adapter.start();
  return { adapter, store, url: `ws://127.0.0.1:${held.port}/ws` };
}

browserTest('App opens a fresh hostname form while another host retains pending approval', async () => {
  const daemon = await realDaemon();
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(origin);
    await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
    await page.getByPlaceholder('localhost').fill(daemon.url.replace('ws://', '').replace('/ws', ''));
    await page.getByRole('button', { name: 'Connect', exact: true }).last().click();
    await page.getByRole('heading', { name: 'Approval needed', exact: true }).last().waitFor();
    expect(daemon.store.listPendingKeys()).toHaveLength(1);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
    // Immediate DOM assertion: fails on the actual App caller's old global selection.
    expect(await page.getByPlaceholder('localhost').count()).toBe(1);
    expect(await page.getByRole('heading', { name: 'Approval needed' }).count()).toBe(1);
  } finally { await context.close(); await daemon.adapter.stop(); }
}, 15000);

for (const action of ['deleteIdentity', 'replaceIdentity'] as const) {
  browserTest(`manager never signs with an identity ${action} replaced during real key import`, async () => {
    const daemon = await realDaemon();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.evaluate(async () => { const path = '/tests/browser/approval-harness.tsx'; const harness = await import(path); await harness.start(); });
      await page.getByTestId('manager-state').waitFor();
      await page.evaluate(async (url) => { const path = '/tests/browser/approval-harness.tsx'; (await import(path)).connectTo(url); }, daemon.url);
      await page.waitForFunction(async () => { const path = '/tests/browser/approval-harness.tsx'; return (await import(path)).reached(); });
      await page.evaluate(async (action) => { const path = '/tests/browser/approval-harness.tsx'; const harness = await import(path); await harness[action](); harness.release(); }, action);
      // Let the real queued crypto/socket continuations run; assert daemon state, not a timeout.
      await page.waitForTimeout(200);
      expect(daemon.store.listPendingKeys()).toHaveLength(0);
      const raw = await page.getByTestId('manager-state').textContent();
      expect(raw).not.toContain('UNKNOWN_KEY');
    } finally { await context.close(); await daemon.adapter.stop(); }
  }, 15000);
}
