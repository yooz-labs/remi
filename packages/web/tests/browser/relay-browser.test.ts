/** Opt-in actual App/Chromium pairing UI pins; isolated profile, real source hub/Worker. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import { type ViteDevServer, createServer } from 'vite';
import {
  ownedRelayChild,
  ownedRelayOffer,
  registerOwnedRelayFixtureCleanup,
} from '../helpers/relay-hub';
registerOwnedRelayFixtureCleanup();
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

browserTest(
  'actual App identity removal publishes disconnected state and same-key restoration constructs fresh transport',
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
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page.evaluate(async () => {
        const moduleURL = '/src/lib/identity-client.ts';
        const identity = await import(moduleURL);
        (window as unknown as Record<string, unknown>)['ownedIdentity'] = identity.loadIdentity();
        identity.removeIdentity();
      });
      await page.waitForTimeout(200);
      expect(await page.getByText('Relay machine connected', { exact: true }).count()).toBe(0);
      await page.evaluate(async () => {
        const moduleURL = '/src/lib/identity-client.ts';
        const identity = await import(moduleURL);
        identity.saveIdentity((window as unknown as Record<string, unknown>)['ownedIdentity']);
        Reflect.deleteProperty(window, 'ownedIdentity');
      });
      await page.getByText('Relay machine connected', { exact: true }).waitFor();
      await page.getByRole('button', { name: 'Machine devices', exact: true }).click();
      await page.getByRole('button', { name: /^Revoke device / }).waitFor();
      expect(await page.getByRole('button', { name: /^Revoke device / }).count()).toBe(1);
    } finally {
      await context.close();
    }
  },
  20000,
);

browserTest(
  'actual browser refuses a 65th distinct pin while preserving all 64 existing public pins',
  async () => {
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(origin);
      const counts = await page.evaluate(async () => {
        const moduleURL = '/src/lib/relay-pins.ts';
        const { rememberRelayPin, loadRelayPins } = await import(moduleURL);
        const pins = [];
        for (let i = 0; i < 65; i++) {
          const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
            'sign',
            'verify',
          ]);
          const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey));
          const machinePublicKey = btoa(String.fromCharCode(...raw))
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
          pins.push({ relayUrl: 'wss://owned.example', machinePublicKey });
        }
        for (const pin of pins.slice(0, 64)) rememberRelayPin(pin);
        const before = localStorage.getItem('remi-relay-machines-v2');
        let refused = false;
        try {
          rememberRelayPin(pins[64]);
        } catch {
          refused = true;
        }
        const preserved = localStorage.getItem('remi-relay-machines-v2') === before;
        const loaded = loadRelayPins().length;
        rememberRelayPin(pins[0]);
        return { refused, preserved, loaded, afterNextWrite: loadRelayPins().length };
      });
      expect(counts).toEqual({ refused: true, preserved: true, loaded: 64, afterNextWrite: 64 });
    } finally {
      await context.close();
    }
  },
  10000,
);

browserTest(
  'actual App keeps relay deny and cancel receipts through resolution, then retains uncertain receipt after identity close',
  async () => {
    const local = await ownedRelayOffer();
    const child = await ownedRelayChild(local.running);
    const context = await browser.newContext();
    const page = await context.newPage();
    let abort: AbortController | undefined;
    try {
      await page.addInitScript(() => {
        const observed = window as unknown as {
          ownedBinding: {
            sessionId: string;
            claudeSessionId: string;
            transcriptPath: string;
          } | null;
          ownedResultReached: boolean;
          ownedResultRelease: (() => void) | null;
        };
        observed.ownedBinding = null;
        observed.ownedResultReached = false;
        observed.ownedResultRelease = null;
        const original = crypto.subtle.decrypt.bind(crypto.subtle);
        crypto.subtle.decrypt = async (...args: Parameters<SubtleCrypto['decrypt']>) => {
          const plaintext = await original(...args);
          let message: Record<string, unknown> | null = null;
          try {
            message = JSON.parse(new TextDecoder().decode(plaintext));
          } catch {
            /* encrypted handshake control is not application JSON */
          }
          if (message?.['type'] === 'hello_ack' && typeof message['sessionId'] === 'string')
            observed.ownedBinding = {
              sessionId: message['sessionId'],
              claudeSessionId: String(message['claudeSessionId']),
              transcriptPath: String(message['transcriptPath']),
            };
          if (message?.['type'] === 'answer_result') {
            observed.ownedResultReached = true;
            await new Promise<void>((resolve) => {
              observed.ownedResultRelease = resolve;
            });
          }
          return plaintext;
        };
      });
      await page.goto(origin);
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
      await page.getByLabel('Pairing token').fill(String(local.offer['token']));
      await page.getByRole('button', { name: 'Start pairing', exact: true }).click();
      const compare = await local.inbox.next();
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
      const project = local.running.dir.split('/').pop() ?? 'missing-owned-project';
      await page.getByRole('button').filter({ hasText: project }).first().click();
      await page.waitForFunction(
        (sid) =>
          (window as unknown as { ownedBinding?: { sessionId: string } }).ownedBinding
            ?.sessionId === sid,
        child.entry.sessionId,
      );
      const binding = await page.evaluate(
        () =>
          (
            window as unknown as {
              ownedBinding: { claudeSessionId: string; transcriptPath: string };
            }
          ).ownedBinding,
      );
      for (const action of ['deny', 'cancel', 'close'] as const) {
        await page.evaluate(() => {
          (window as unknown as { ownedResultReached: boolean }).ownedResultReached = false;
        });
        abort = new AbortController();
        const hook = fetch(`http://127.0.0.1:${child.entry.hookPort}/hooks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          signal: abort.signal,
          body: JSON.stringify({
            hook_event_name: 'PermissionRequest',
            session_id: binding.claudeSessionId,
            transcript_path: binding.transcriptPath,
            cwd: local.running.dir,
            permission_mode: 'default',
            tool_name: 'Bash',
            tool_input: { command: `R4_UI_PRIVATE_NEVER_RUN_${action}` },
          }),
        });
        void hook.catch(() => undefined);
        if (action === 'cancel')
          await page.getByRole('button', { name: 'Cancel (Esc)', exact: true }).click();
        else await page.getByRole('button', { name: /No.*Cancel/ }).click();
        await page.waitForFunction(
          () => (window as unknown as { ownedResultReached: boolean }).ownedResultReached,
        );
        expect(
          await page.getByText('Waiting for delivery confirmation…', { exact: true }).count(),
        ).toBe(1);
        expect((await (await hook).json()).hookSpecificOutput.decision.behavior).toBe('deny');
        if (action === 'close') {
          await page.evaluate(async () => {
            const moduleURL = '/src/lib/identity-client.ts';
            (await import(moduleURL)).removeIdentity();
          });
          await page
            .getByText(
              'Delivery unverified. Check the daemon or terminal before answering again.',
              { exact: true },
            )
            .waitFor();
        }
        await page.evaluate(() =>
          (window as unknown as { ownedResultRelease: () => void }).ownedResultRelease(),
        );
        if (action === 'close') {
          await page.waitForTimeout(200);
          expect(
            await page
              .getByText(
                'Delivery unverified. Check the daemon or terminal before answering again.',
                { exact: true },
              )
              .count(),
          ).toBe(1);
        } else {
          await page.getByText(action === 'cancel' ? 'Cancelled' : 'No', { exact: true }).waitFor();
          expect(await page.getByText('Answered:', { exact: false }).count()).toBe(1);
          await page.waitForTimeout(1700);
        }
      }
    } finally {
      abort?.abort();
      await page
        .evaluate(() =>
          (window as unknown as { ownedResultRelease?: () => void }).ownedResultRelease?.(),
        )
        .catch(() => undefined);
      await context.close();
    }
  },
  25000,
);

browserTest(
  'actual App pin capacity failure is terminal and preserves existing public pins',
  async () => {
    const local = await ownedRelayOffer();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        const RealWebSocket = window.WebSocket;
        (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections = 0;
        window.WebSocket = class extends RealWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            if (String(url).includes('/v2/client/'))
              (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections++;
          }
        };
      });
      await page.goto(origin);
      await page.evaluate(async () => {
        const url = '/src/lib/identity-client.ts';
        await (await import(url)).ensureIdentity();
      });
      // Let the actual App restore the existing identity with an empty pin store.
      await page.waitForTimeout(600);
      const before = await page.evaluate(async () => {
        const url = '/src/lib/relay-pins.ts';
        const { rememberRelayPin } = await import(url);
        for (let i = 0; i < 64; i++) {
          const key = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
            'sign',
            'verify',
          ]);
          const raw = new Uint8Array(await crypto.subtle.exportKey('raw', key.publicKey));
          const machinePublicKey = btoa(String.fromCharCode(...raw))
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
          rememberRelayPin({ relayUrl: 'ws://127.0.0.1:1', machinePublicKey });
        }
        return localStorage.getItem('remi-relay-machines-v2');
      });
      expect(
        await page.evaluate(
          () => (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections,
        ),
      ).toBe(0);
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
      await page.getByLabel('Pairing token').fill(String(local.offer['token']));
      await page.getByRole('button', { name: 'Start pairing', exact: true }).click();
      const compare = await local.inbox.next();
      expect(compare['t']).toBe('compare');
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
      expect((await local.inbox.next())['t']).toBe('paired');
      await page.waitForTimeout(3500);
      const observation = await page.evaluate(() => ({
        connections: (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections,
        pins: localStorage.getItem('remi-relay-machines-v2'),
        body: document.body.innerText,
      }));
      expect(observation.pins).toBe(before);
      expect(JSON.parse(observation.pins ?? '[]')).toHaveLength(64);
      expect(observation.pins).not.toContain('remi-pair2:');
      expect(observation.connections).toBe(1);
      expect(observation.body).toContain('Saved machine limit reached');
    } finally {
      await context.close();
    }
  },
  20000,
);

browserTest(
  'actual App real storage quota failure is terminal without a partial machine pin',
  async () => {
    const local = await ownedRelayOffer();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.addInitScript(() => {
        const RealWebSocket = window.WebSocket;
        (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections = 0;
        window.WebSocket = class extends RealWebSocket {
          constructor(url: string | URL, protocols?: string | string[]) {
            super(url, protocols);
            if (String(url).includes('/v2/client/'))
              (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections++;
          }
        };
      });
      await page.goto(origin);
      await page.evaluate(async () => {
        const url = '/src/lib/identity-client.ts';
        await (await import(url)).ensureIdentity();
      });
      // Let the actual App restore the existing identity with an empty pin store.
      await page.waitForTimeout(600);
      const before = await page.evaluate(() => {
        let low = 0;
        let high = 6 * 1024 * 1024;
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          try {
            localStorage.setItem('owned-quota-fill', 'x'.repeat(middle));
            low = middle;
          } catch {
            high = middle;
          }
        }
        return localStorage.getItem('remi-relay-machines-v2');
      });
      expect(
        await page.evaluate(
          () => (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections,
        ),
      ).toBe(0);
      await page.getByRole('button', { name: 'Connect', exact: true }).first().click();
      await page.getByRole('button', { name: 'Pair machine', exact: true }).click();
      await page.getByLabel('Pairing token').fill(String(local.offer['token']));
      await page.getByRole('button', { name: 'Start pairing', exact: true }).click();
      const compare = await local.inbox.next();
      expect(compare['t']).toBe('compare');
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
      expect((await local.inbox.next())['t']).toBe('paired');
      await page.waitForTimeout(3500);
      const observation = await page.evaluate(() => ({
        connections: (window as unknown as { ownedRelayConnections: number }).ownedRelayConnections,
        pins: localStorage.getItem('remi-relay-machines-v2'),
        body: document.body.innerText,
      }));
      expect(observation.pins).toBe(before);
      expect(observation.pins).toBeNull();
      expect(observation.pins ?? '').not.toContain('remi-pair2:');
      expect(observation.connections).toBe(1);
      expect(observation.body.toLowerCase()).toContain('quota');
    } finally {
      await context.close();
    }
  },
  20000,
);
