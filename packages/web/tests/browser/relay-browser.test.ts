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

browserTest('App presents a memory-only pairing token form without replacing direct approval flow', async () => {
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
  } finally { await context.close(); }
}, 20000);
