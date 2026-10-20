/** Opt-in real Chromium + Vite + daemon-adapter tests. No user profile/state. */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { type Browser, chromium } from '@playwright/test';
import {
  createAuthResponse,
  createCreateSessionRequest,
  createHello,
  createIdentity,
  createPong,
  deserialize,
  fingerprint,
  fromBase64,
  importPublicKey,
  isSmallOrderPublicKey,
  serialize,
  sign,
  unlockIdentity,
  verify,
} from '@remi/shared';
import { type ViteDevServer, createServer } from 'vite';
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter';
import { Authenticator } from '../../../daemon/src/auth/authenticator';
import { IdentityStore } from '../../../daemon/src/auth/identity-store';
import { installFakeAgents } from '../../../daemon/tests/helpers/fake-agent-clis';
import { makeIsolatedDirs, pollUntil } from '../../../daemon/tests/integration/hub-test-utils';
import { occupyEphemeral, reserveRange } from '../../../daemon/tests/session/port-test-helpers';

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
    ...(process.env['REMI_BROWSER_MANAGER_OVERRIDE'] && {
      resolve: {
        alias: [
          {
            find: '../../src/hooks/useConnectionManager',
            replacement: resolve(process.env['REMI_BROWSER_MANAGER_OVERRIDE']),
          },
        ],
      },
    }),
    server: {
      host: '127.0.0.1',
      port: 0,
      ...(process.env['REMI_BROWSER_MANAGER_OVERRIDE'] && {
        fs: {
          allow: [
            resolve(import.meta.dir, '../..'),
            dirname(resolve(process.env['REMI_BROWSER_MANAGER_OVERRIDE'])),
          ],
        },
      }),
    },
  });
  await vite.listen();
  const address = vite.httpServer?.address();
  if (!address || typeof address === 'string') throw new Error('No Vite address');
  origin = `http://127.0.0.1:${address.port}`;
  browser = await chromium.launch({
    executablePath: process.env['REMI_BROWSER_EXECUTABLE'],
    env: {
      HOME: privateDir,
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      TMPDIR: privateDir,
    },
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

/** Actual source hub + signed Claude child for the useConnectionManager regression. */
async function realStagingChild() {
  const dirs = makeIsolatedDirs();
  const state = join(dirs.home, '.remi');
  fs.mkdirSync(state, { mode: 0o700 });
  const store = new IdentityStore(state);
  const machine = await store.generate();
  const bootstrapIdentity = await createIdentity();
  const bootstrap = await unlockIdentity(bootstrapIdentity);
  await store.addAuthorizedKey(bootstrapIdentity.publicKey, 'browser test bootstrap');
  const agents = installFakeAgents(dirs.home, { claude: true });
  const fixtureCli = join(dirs.home, 'fake-bin', 'claude');
  fs.writeFileSync(
    fixtureCli,
    fs.readFileSync(fixtureCli, 'utf8').replace('$i -lt 600', '$i -lt 18000'),
  );
  const port = await reserveRange(20, 50, '127.0.0.1');
  const entry = resolve(import.meta.dir, '../../../daemon/src/entry.ts');
  const proc = Bun.spawn(
    [
      process.execPath,
      '--no-env-file',
      entry,
      'serve',
      '--port',
      String(port),
      '--auth',
      '--no-relay',
      '--no-mdns',
      '--no-telegram',
    ],
    {
      cwd: dirs.work,
      env: {
        ...agents.env,
        HOME: dirs.home,
        REMI_HOME: state,
        ...(process.env['TMPDIR'] ? { TMPDIR: process.env['TMPDIR'] } : {}),
        LANG: 'en_US.UTF-8',
      },
      stdin: 'ignore',
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );
  let socket: WebSocket | undefined;
  let childPid: number | undefined;
  let stopped = false;
  let childSessionId: string | undefined;
  let childPort: number | undefined;
  const diagnostics = () => {
    const liveDir = join(state, 'live-sessions');
    const liveSessions = fs.existsSync(liveDir)
      ? fs
          .readdirSync(liveDir)
          .map((name) => JSON.parse(fs.readFileSync(join(liveDir, name), 'utf8')))
          .map((item) => ({
            sessionId: item.sessionId,
            pid: item.pid,
            harness: item.harness,
            port: item.port,
          }))
      : [];
    const agentPidPath = join(agents.claudeDir, 'pid');
    const agentPid = fs.existsSync(agentPidPath)
      ? Number(fs.readFileSync(agentPidPath, 'utf8').trim())
      : null;
    const daemonLogPath = join(state, 'daemon.log');
    const daemonLog = fs.existsSync(daemonLogPath) ? fs.readFileSync(daemonLogPath, 'utf8') : '';
    const isAlive = (pid: number | null | undefined) => {
      if (!pid) return false;
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    };
    return {
      childPort,
      childSessionId,
      childPid,
      childPidAlive: isAlive(childPid),
      agentPid,
      agentPidAlive: isAlive(agentPid),
      liveSessions,
      daemonLogBytes: Buffer.byteLength(daemonLog),
      daemonEvents: {
        clientConnected: /Client connected/.test(daemonLog),
        sessionAttached: /Attached connection/.test(daemonLog),
        ptyExit: /PTY.*(?:exit|close)|(?:exit|close).*PTY/i.test(daemonLog),
        sessionExit: /session.*(?:exit|closed)|(?:exit|closed).*session/i.test(daemonLog),
      },
    };
  };
  async function stop() {
    if (stopped) return;
    stopped = true;
    socket?.close();
    fs.writeFileSync(join(agents.claudeDir, 'release'), '');
    if (childPid) {
      try {
        process.kill(childPid, 'SIGTERM');
      } catch {
        // Already exited.
      }
      await pollUntil(
        () => {
          try {
            process.kill(childPid as number, 0);
            return false;
          } catch {
            return true;
          }
        },
        10000,
        'browser test child exit',
      );
    }
    if (proc.exitCode === null) proc.kill('SIGTERM');
    await proc.exited;
    fs.rmSync(dirs.work, { recursive: true, force: true });
    fs.rmSync(dirs.home, { recursive: true, force: true });
  }
  try {
    await pollUntil(
      () => fs.existsSync(join(state, 'daemon-status.json')) || proc.exitCode !== null,
      10000,
      'browser test hub ready',
    );
    if (proc.exitCode !== null) throw new Error('Browser test hub failed to start');

    const received: ReturnType<typeof deserialize>[] = [];
    let challenge: string | undefined;
    let failure: Error | undefined;
    socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    socket.onmessage = (event) => {
      void (async () => {
        const message = deserialize(String(event.data));
        if (!message) return;
        received.push(message);
        if (message.type === 'ping') {
          socket?.send(serialize(createPong(message.id)));
        } else if (message.type === 'auth_challenge') {
          if (message.serverPublicKey !== machine.publicKey)
            throw new Error('Unexpected browser test host identity');
          challenge = message.challenge;
          socket?.send(
            serialize(
              createAuthResponse(
                bootstrapIdentity.publicKey,
                await sign(bootstrap.privateKey, fromBase64(message.challenge)),
                bootstrapIdentity.fingerprint,
              ),
            ),
          );
        } else if (message.type === 'auth_result') {
          if (!message.success || !challenge || !message.serverSignature)
            throw new Error('Browser test bootstrap authentication failed');
          const key = await importPublicKey(fromBase64(machine.publicKey));
          if (!(await verify(key, fromBase64(challenge), message.serverSignature)))
            throw new Error('Browser test host proof failed');
          socket?.send(serialize(createHello(crypto.randomUUID(), 'browser image auth test')));
        }
      })().catch((error) => {
        failure = error instanceof Error ? error : new Error('Browser test bootstrap failed');
      });
    };
    await pollUntil(
      () => failure !== undefined || received.some((message) => message?.type === 'hello_ack'),
      10000,
      'browser test hub hello',
    );
    if (failure) throw failure;
    const create = createCreateSessionRequest(dirs.work, { harness: 'claude' });
    socket.send(serialize(create));
    await pollUntil(
      () =>
        failure !== undefined ||
        received.some(
          (message) =>
            message?.type === 'create_session_response' && message.requestId === create.id,
        ),
      20000,
      'browser test child start',
    );
    if (failure) throw failure;
    const response = received.find(
      (message) => message?.type === 'create_session_response' && message.requestId === create.id,
    );
    if (
      response?.type !== 'create_session_response' ||
      !response.success ||
      !response.port ||
      !response.sessionId
    )
      throw new Error('Browser test source child failed to start');
    childSessionId = response.sessionId;
    childPort = response.port;
    const record = fs
      .readdirSync(join(state, 'live-sessions'))
      .map((name) => JSON.parse(fs.readFileSync(join(state, 'live-sessions', name), 'utf8')))
      .find((item) => item.sessionId === response.sessionId);
    if (!record || !Number.isInteger(record.pid) || record.pid <= 1 || record.pid === proc.pid)
      throw new Error('Browser test child metadata was invalid');
    childPid = record.pid as number;
    return {
      store,
      url: `ws://127.0.0.1:${response.port}/ws`,
      addAuthorizedKey: (publicKey: string) =>
        store.addAuthorizedKey(publicKey, 'browser test client'),
      diagnostics,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
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
  'manager keeps actual staging eligibility after a matching identity prop effect and clears it on replacement',
  async () => {
    const daemon = await realStagingChild();
    const context = await browser.newContext();
    const page = await context.newPage();
    if (process.env['REMI_BROWSER_MANAGER_OVERRIDE']) page.setDefaultTimeout(3000);
    try {
      await page.goto(`${origin}/tests/browser/approval-harness.html`);
      const client = await page.evaluate(async () => {
        const path = '/tests/browser/approval-harness.tsx';
        return (await import(path)).start({ memoryOnly: true, deferIdentityProp: true });
      });
      const managerModuleLoaded = await page.evaluate(() =>
        performance
          .getEntriesByType('resource')
          .some((entry) => entry.name.includes('/src/hooks/useConnectionManager.ts')),
      );
      expect(managerModuleLoaded).toBe(true);
      await daemon.addAuthorizedKey(client.publicKey);
      await page.getByTestId('manager-state').waitFor();
      await page.evaluate(async (url) => {
        const path = '/tests/browser/approval-harness.tsx';
        const harness = await import(path);
        harness.release();
        harness.provideCurrentIdentity();
        harness.connectTo(url);
      }, daemon.url);
      await page.waitForFunction(() => {
        const output = document.querySelector('[data-testid="manager-state"]');
        const connections = JSON.parse(output?.textContent ?? '[]');
        return connections.some(
          (connection: {
            status: string;
            attachState: string | null;
            imageUploadEnabled: boolean;
          }) =>
            connection.status === 'connected' &&
            connection.attachState === 'attached' &&
            connection.imageUploadEnabled,
        );
      });

      const matchingRevision = await page.evaluate(async () => {
        const path = '/tests/browser/approval-harness.tsx';
        return (await import(path)).applyMatchingIdentityProp();
      });
      expect(matchingRevision.publicKeyRaw).toBe(client.publicKey);
      const effectiveIdentityProp = await page
        .getByTestId('manager-state')
        .getAttribute('data-identity-prop');
      expect(effectiveIdentityProp).toBe(client.publicKey);
      await page.waitForFunction((revision) => {
        const output = document.querySelector('[data-testid="manager-state"]');
        return (
          output !== null && Number(output.getAttribute('data-prop-effect-revision')) >= revision
        );
      }, matchingRevision.revision);
      const matchingEffectConnection = await page.evaluate(() => {
        const output = document.querySelector('[data-testid="manager-state"]');
        const connections = JSON.parse(output?.textContent ?? '[]');
        return { connection: connections.at(-1) };
      });
      expect(matchingEffectConnection.connection?.status).toBe('connected');
      expect(matchingEffectConnection.connection?.imageUploadEnabled).toBe(true);

      const replacementRevision = await page.evaluate(async () => {
        const path = '/tests/browser/approval-harness.tsx';
        return await (await import(path)).replacePropIdentity();
      });
      expect(replacementRevision.publicKeyRaw).not.toBe(client.publicKey);
      await page.waitForFunction((revision) => {
        const output = document.querySelector('[data-testid="manager-state"]');
        return (
          output !== null && Number(output.getAttribute('data-prop-effect-revision')) >= revision
        );
      }, replacementRevision.revision);
      const finalConnection = await page.evaluate(() => {
        const output = document.querySelector('[data-testid="manager-state"]');
        const connections = JSON.parse(output?.textContent ?? '[]');
        return connections.at(-1);
      });
      expect(finalConnection?.imageUploadEnabled).toBe(false);
      expect(finalConnection?.attachState).toBe('attached');
    } catch (error) {
      const browserTrace = await page
        .evaluate(async () => {
          const path = '/tests/browser/approval-harness.tsx';
          return (await import(path)).trace();
        })
        .catch(() => null);
      console.error(
        'Isolated image staging browser trace',
        JSON.stringify({ browserTrace, daemon: daemon.diagnostics() }),
      );
      throw error;
    } finally {
      await context.close();
      await daemon.stop();
    }
  },
  60000,
);

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
