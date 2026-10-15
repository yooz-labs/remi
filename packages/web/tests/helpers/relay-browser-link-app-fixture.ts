import { execFileSync, spawnSync } from 'node:child_process';
/** Actual App, enrolled identity, source Worker/Hub/child and isolated Chromium. */
import * as fs from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { type Page, chromium } from '@playwright/test';
import { createIdentity, serializeIdentity, unlockIdentity } from '@remi/shared';
import { createServer } from 'vite';
import type { PTYSession } from '../../../daemon/src/pty/pty-session.ts';
import { relayBrowserFixture } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';

export interface OwnedRelayAppResources {
  readonly directory: string;
  readonly launcher: string;
  readonly consumer: PTYSession;
  readonly browserPid: number;
  readonly endpoints: readonly string[];
  readonly close: () => Promise<void>;
}

export async function relayBrowserLinkAppFixture(
  artifact: string,
  options: {
    closePageAfterNavigation?: boolean;
    observe?: (resources: OwnedRelayAppResources) => void;
  } = {},
) {
  const replacementIdentity = await unlockIdentity(await createIdentity());
  const relay = await relayBrowserFixture([replacementIdentity]);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let browserOwner: { pid: number; parent: number; group: number; command: string } | undefined;
  let page: Page | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  const requests: { url: string; referer: string | null }[] = [];
  const wire: { direction: string; binary: boolean; payload: Buffer }[] = [];
  const errors: string[] = [];
  const mark = (stage: string) => {
    if (!options.closePageAfterNavigation) return;
    try {
      fs.appendFileSync(
        join(artifact, 'startup-stages.jsonl'),
        JSON.stringify({ stage, at: performance.now() }) + '\n',
      );
    } catch {}
  };
  let destination: ReturnType<typeof Bun.serve> | undefined;
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    return (closing ??= cleanup());
  }
  async function settle(operation: Promise<unknown>, milliseconds: number) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation.then(
          () => 'settled' as const,
          () => 'rejected' as const,
        ),
        new Promise<'deadline'>((done) => {
          timer = setTimeout(() => done('deadline'), milliseconds);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function closeBrowser() {
    if (!browser) return;
    const graceful = await settle(browser.close(), 2000);
    if (!browserOwner) {
      if (graceful !== 'settled') throw Error('Unidentified browser did not close gracefully');
      return;
    }
    const owner = browserOwner;
    const psStatuses: number[] = [];
    const current = () => {
      const result = spawnSync('/bin/ps', ['-p', String(owner.pid), '-o', 'ppid=,pgid=,command='], {
        encoding: 'utf8',
      });
      if (result.error) throw result.error;
      const text = result.stdout.trim();
      psStatuses.push(result.status ?? -1);
      if (result.status === 1 && !text) return '';
      if (result.status !== 0 || !text) throw Error('Owned Chromium process check failed');
      return text;
    };
    const expected = `${owner.parent} ${owner.group} ${owner.command}`;
    let fallback = 'not-needed';
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      const row = current();
      if (!row) break;
      if (
        row.replace(/\s+/g, ' ') !== expected.replace(/\s+/g, ' ') ||
        owner.parent !== process.pid ||
        owner.group !== owner.pid
      )
        throw Error('Owned Chromium process identity changed; refusing to signal');
      process.kill(-owner.pid, signal);
      fallback = signal;
      const deadline = performance.now() + 1000;
      while (current() && performance.now() < deadline) await Bun.sleep(50);
    }
    const exited = !current();
    fs.writeFileSync(
      join(artifact, 'browser-shutdown.json'),
      JSON.stringify(
        {
          pid: owner.pid,
          graceful,
          fallback,
          exited,
          psStatuses,
          scope:
            'Chromium PID from this browser CDP session; exact parent/group/command rechecked before any fallback signal',
        },
        null,
        2,
      ),
    );
    if (!exited) throw Error('Owned Chromium exit was not proved');
  }
  async function cleanup() {
    const failures: unknown[] = [];
    const attempt = async (operation: () => unknown) => {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
      }
    };
    await Promise.all([
      attempt(async () => {
        mark('close:browser:before');
        await closeBrowser();
        mark('close:browser:after');
      }),
      attempt(async () => {
        if (vite?.httpServer && 'closeAllConnections' in vite.httpServer)
          vite.httpServer.closeAllConnections();
        await vite?.close();
        mark('close:vite:after');
      }),
      attempt(() => destination?.stop(true)),
      attempt(async () => {
        await relay.close();
        mark('close:relay:after');
      }),
    ]);
    if (failures.length) throw new AggregateError(failures, 'Owned relay App cleanup failed');
  }
  try {
    fs.mkdirSync(artifact, { recursive: true });
    destination = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        requests.push({ url: request.url, referer: request.headers.get('referer') });
        return new Response('Owned explicit browser destination', {
          headers: { 'Content-Type': 'text/plain' },
        });
      },
    });
    const destinationOrigin = `http://127.0.0.1:${destination.port}`;
    vite = await createServer({
      root: resolve(import.meta.dir, '../..'),
      configFile: resolve(import.meta.dir, '../../vite.config.ts'),
      cacheDir: join(relay.files.directory, 'vite-cache'),
      server: {
        host: '127.0.0.1',
        port: 0,
        fs: {
          allow: [
            resolve(import.meta.dir, '../../../..'),
            fs.realpathSync(resolve(import.meta.dir, '../../node_modules')),
            fs.realpathSync(resolve(import.meta.dir, '../../../../node_modules')),
            ...['../../../../node_modules/.bun', '../../node_modules/.bun']
              .map((name) => resolve(import.meta.dir, name))
              .filter(fs.existsSync)
              .map((name) => fs.realpathSync(name)),
          ],
        },
      },
    });
    await vite.listen();
    const address = vite.httpServer?.address();
    if (!address || typeof address === 'string') throw Error('No owned Vite address');
    const resolved = await vite.pluginContainer.resolveId(
      '@remi/shared',
      resolve(import.meta.dir, '../../src/App.tsx'),
    );
    if (resolved?.id !== resolve(import.meta.dir, '../../../shared/src/index.ts'))
      throw Error('Candidate shared graph mismatch');
    const executable =
      process.env['REMI_BROWSER_EXECUTABLE'] ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    browser = await chromium.launch({
      executablePath: executable,
      env: { HOME: relay.files.userHome, TMPDIR: relay.files.directory, PATH: '/usr/bin:/bin' },
    });
    const cdp = await browser.newBrowserCDPSession();
    try {
      const info = await cdp.send('SystemInfo.getProcessInfo');
      const pid = info.processInfo.find((item) => item.type === 'browser')?.id;
      if (!pid || !Number.isSafeInteger(pid)) throw Error('Owned Chromium PID unavailable');
      const row = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'ppid=,pgid=,command='], {
        encoding: 'utf8',
      })
        .trim()
        .match(/^(\d+)\s+(\d+)\s+(.+)$/);
      if (
        !row ||
        Number(row[1]) !== process.pid ||
        Number(row[2]) !== pid ||
        !row[3]?.startsWith(executable)
      )
        throw Error('Owned Chromium process identity unproved');
      browserOwner = { pid, parent: Number(row[1]), group: Number(row[2]), command: row[3] };
    } finally {
      await cdp.detach();
    }
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const pin = {
      relayUrl: relay.worker.wsUrl,
      machinePublicKey: Buffer.from(relay.machinePublicKey).toString('base64url'),
    };
    await context.addInitScript(
      ({ identity, pin }) => {
        localStorage.setItem('remi-identity', identity);
        localStorage.setItem('remi-relay-machines-v2', JSON.stringify([pin]));
        localStorage.setItem('remi-connections', '[]');
      },
      { identity: serializeIdentity(relay.deviceIdentity), pin },
    );
    page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('websocket', (socket) => {
      if (!socket.url().startsWith(relay.worker.wsUrl)) return;
      const observe = (direction: string, payload: string | Buffer) =>
        wire.push({
          direction,
          binary: Buffer.isBuffer(payload),
          payload: Buffer.from(payload),
        });
      socket.on('framesent', ({ payload }) => observe('framesent', payload));
      socket.on('framereceived', ({ payload }) => observe('framereceived', payload));
    });
    await page.goto(`http://127.0.0.1:${address.port}`);
    const browserPid = browserOwner?.pid;
    if (!browserPid) throw Error('Owned Chromium PID unavailable');
    options.observe?.({
      directory: relay.files.directory,
      launcher: relay.producer.browserPath,
      consumer: relay.pty,
      browserPid,
      close,
      endpoints: [
        `http://127.0.0.1:${address.port}`,
        destinationOrigin,
        relay.worker.wsUrl.replace(/^ws:/, 'http:'),
      ],
    });
    if (options.closePageAfterNavigation) {
      mark('page-close:before');
      await page.close();
      mark('page-close:after');
    }
    const session = relay.registry
      .listSessions()
      .find((item) => item.sessionId === relay.sessionId);
    if (!session?.name) throw Error('Owned actual session missing');
    await page
      .getByText(basename(session.projectPath), { exact: true })
      .first()
      .click({ timeout: 20000 });
    const panel = page.getByRole('region', { name: 'Browser links', exact: true });
    await panel
      .getByRole('button', { name: 'Receive browser links here', exact: true })
      .waitFor({ timeout: 20000 });
    fs.writeFileSync(
      join(artifact, 'fixture-profile.json'),
      JSON.stringify(
        {
          sharedResolution: resolved.id,
          scope:
            'Owned source relay and isolated actual App; no native, deployed or owner hardware acceptance',
        },
        null,
        2,
      ),
    );
    return {
      relay,
      replacementIdentity,
      browser,
      context,
      page,
      panel,
      requests,
      wire,
      errors,
      destinationURL: (marker: string) => `${destinationOrigin}/${marker}`,
      async offer(url: string) {
        const child = Bun.spawn([relay.producer.browserPath, url], {
          env: relay.files.env,
          stdout: 'pipe',
          stderr: 'pipe',
        });
        const [exit, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        if (exit !== 0 || stdout || stderr) throw Error('Actual owned producer did not accept URL');
      },
      close,
    };
  } catch (error) {
    mark('catch:entered');
    const failures: unknown[] = [error];
    try {
      if (page) {
        mark('diagnostic:before');
        fs.writeFileSync(join(artifact, 'startup-dom.txt'), await page.locator('body').innerText());
        await page.screenshot({ path: join(artifact, 'startup.png') });
      }
    } catch (diagnostic) {
      failures.push(diagnostic);
      mark('diagnostic:rejected');
    } finally {
      try {
        await close();
      } catch (cleanup) {
        failures.push(cleanup);
      }
    }
    throw new AggregateError(failures, 'Owned relay App startup cleanup failed');
  }
}
