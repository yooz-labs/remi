/** Opt-in actual App/Chromium pairing UI pins; isolated profile, real source hub/Worker. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import { type ViteDevServer, createServer } from 'vite';
import { ownedRelayOffer } from '../helpers/relay-hub';
const enabled = process.env['REMI_BROWSER_TESTS'] === '1';
const browserTest = enabled ? test : test.skip;
let browser: Browser;
let vite: ViteDevServer;
let origin: string;
let privateDir: string;

beforeAll(async () => {
  if (!enabled) return;
  privateDir = await mkdtemp(join(tmpdir(), 'remi1199-browser-'));
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

browserTest(
  'App presents a memory-only pairing token form without replacing direct approval flow',
  async () => {
    const local = await ownedRelayOffer();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      expect(await page.getByRole('button', { name: 'Pair machine', exact: true }).count()).toBe(1);
      await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
      await page.getByLabel('Pairing token').fill(String(local.offer['token']));
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('remi-pair2:');
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
      expect(await page.getByLabel('Pairing token').inputValue()).toBe('');
    } finally {
      await context.close();
    }
  },
  20000,
);

browserTest(
  'actual App pairs only after local comparison and lists enrolled devices over encrypted machine channel',
  async () => {
    const local = await ownedRelayOffer();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
      await page.getByLabel('Pairing token').fill(String(local.offer['token']));
      await page.getByRole('button', { name: 'Start pairing', exact: true }).click();
      const compare = await local.inbox.next();
      expect(compare['t']).toBe('compare');
      await page.getByText('Compare on the daemon machine', { exact: true }).waitFor();
      expect(await page.getByText(String(compare['fingerprint']), { exact: true }).count()).toBe(1);
      expect(await page.evaluate(() => localStorage.getItem('remi-relay-machines-v2'))).toBeNull();
      local.ws.send(
        JSON.stringify({
          t: 'confirm',
          id: 'owned-r4',
          offerId: local.offer['offerId'],
          connectionId: compare['connectionId'],
          fingerprint: compare['fingerprint'],
          accept: true,
        }),
      );
      await page.getByText('Relay machine connected', { exact: true }).waitFor();
      const stored = await page.evaluate(() => localStorage.getItem('remi-relay-machines-v2'));
      const pins = JSON.parse(stored ?? '[]');
      expect(pins).toHaveLength(1);
      expect(Object.keys(pins[0]).sort()).toEqual(['machinePublicKey', 'relayUrl']);
      expect(stored).not.toContain('secret');
      expect(stored).not.toContain('remi-pair2:');
      await page.getByRole('button', { name: 'Machine devices', exact: true }).click();
      await page.getByRole('button', { name: /^Revoke device / }).waitFor();
      expect(await page.getByRole('button', { name: /^Revoke device / }).count()).toBe(1);
      // Reopening does not inherit the completed attempt or token.
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.reload();
      await page.getByText('Relay machine connected', { exact: true }).waitFor();
      expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('remi-pair2:');
    } finally {
      await context.close();
    }
  },
  20000,
);

browserTest(
  'Cancel pairing closes the actual pending handshake without persisting a machine pin',
  async () => {
    const local = await ownedRelayOffer();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
      await page.getByLabel('Pairing token').fill(String(local.offer['token']));
      await page.getByRole('button', { name: 'Start pairing', exact: true }).click();
      const compare = await local.inbox.next();
      expect(compare['t']).toBe('compare');
      await page.getByText('Compare on the daemon machine', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Cancel pairing', exact: true }).click();
      // Confirming the no-longer-live comparison must refuse, rather than grant a closed client.
      local.ws.send(
        JSON.stringify({
          t: 'confirm',
          id: 'owned-r4',
          offerId: local.offer['offerId'],
          connectionId: compare['connectionId'],
          fingerprint: compare['fingerprint'],
          accept: true,
        }),
      );
      const outcome = await local.inbox.next();
      expect(outcome['t']).toBe('error');
      expect(outcome['error']).toBe('RELAY_CONTROL_REFUSED');
      expect(await page.evaluate(() => localStorage.getItem('remi-relay-machines-v2'))).toBeNull();
    } finally {
      await context.close();
    }
  },
  20000,
);
