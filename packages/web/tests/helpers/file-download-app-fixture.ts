/** Owned actual App/CLI/Chromium resources. The optional courier only holds real frames. */
import * as fs from 'node:fs';
import { createHash, X509Certificate } from 'node:crypto';
import { join, resolve } from 'node:path';
import { chromium, type Page } from '@playwright/test';
import { createServer } from 'vite';
import { serializeIdentity } from '@remi/shared';
import { fileDownloadCliFixture } from '../../../daemon/tests/helpers/file-download-cli-fixture.ts';

export async function fileDownloadAppFixture(options: {
  harness?: 'claude' | 'codex';
  artifact: string;
  holdFirstChunk?: boolean;
  cleanupFault?: boolean;
}) {
  const cli = await fileDownloadCliFixture({ harness: options.harness ?? 'claude' });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let evidencePage: Page | undefined;
  let vite: Awaited<ReturnType<typeof createServer>> | undefined;
  let courier: ReturnType<typeof Bun.serve> | undefined;
  const backends = new Set<WebSocket>();
  const clientFrames: Record<string, unknown>[] = [];
  const hostFrames: Record<string, unknown>[] = [];
  const errors: string[] = [];
  let heldChunk: { send: () => void } | null = null;
  let didHold = false;
  let faulted = false;
  const ledger = join(cli.files.home, 'image-staging', 'ledger');
  async function close() {
    const errors: unknown[] = [];
    const attempt = async (effect: () => unknown) => {
      try {
        await effect();
      } catch (error) {
        errors.push(error);
      }
    };
    if (faulted) await attempt(() => fs.chmodSync(ledger, 0o700));
    await attempt(() => browser?.close());
    await attempt(() => vite?.close());
    for (const socket of backends) await attempt(() => socket.close());
    await attempt(() => courier?.stop(true));
    await attempt(() => cli.close());
    if (errors.length) throw new AggregateError(errors, 'Owned download App cleanup failed');
  }
  try {
    fs.mkdirSync(options.artifact, { recursive: true });
    courier = Bun.serve<{ back: WebSocket | null; pending: string[] }>({
      hostname: '127.0.0.1',
      port: 0,
      tls: cli.files.tls,
      fetch(req, server) {
        if (server.upgrade(req, { data: { back: null, pending: [] } })) return;
        return new Response('owned frame courier');
      },
      websocket: {
        open(front) {
          const back = new WebSocket(cli.url, { tls: { ca: cli.files.ca } } as never);
          front.data.back = back;
          backends.add(back);
          back.onopen = () => {
            for (const raw of front.data.pending) back.send(raw);
            front.data.pending = [];
          };
          back.onmessage = (event) => {
            const raw = String(event.data);
            const message = JSON.parse(raw) as Record<string, unknown>;
            hostFrames.push(message);
            if (options.holdFirstChunk && !didHold && message['type'] === 'file_fetch_chunk') {
              didHold = true;
              heldChunk = { send: () => front.send(raw) };
              return;
            }
            front.send(raw);
          };
          back.onclose = () => front.close();
          back.onerror = () => front.close();
        },
        message(front, value) {
          const raw = typeof value === 'string' ? value : value.toString();
          const message = JSON.parse(raw) as Record<string, unknown>;
          clientFrames.push(message);
          if (options.cleanupFault && !faulted && message['type'] === 'file_fetch_complete') {
            // Actual owned filesystem denial; the host still produces its own response.
            fs.chmodSync(ledger, 0);
            faulted = true;
          }
          const back = front.data.back;
          if (back?.readyState === WebSocket.OPEN) back.send(raw);
          else if (front.data.pending.length < 64) front.data.pending.push(raw);
          else front.close();
        },
        close(front) {
          front.data.back?.close();
        },
      },
    });
    const url = `wss://127.0.0.1:${courier.port}/ws`;
    vite = await createServer({
      root: resolve(import.meta.dir, '../..'),
      configFile: resolve(import.meta.dir, '../../vite.config.ts'),
      cacheDir: join(cli.files.directory, 'vite-cache'),
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
              .filter((name) => fs.existsSync(name))
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
    const spki = createHash('sha256')
      .update(
        new X509Certificate(cli.files.tls.cert).publicKey.export({ type: 'spki', format: 'der' }),
      )
      .digest('base64');
    const executable =
      process.env['REMI_BROWSER_EXECUTABLE'] ??
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    fs.writeFileSync(
      join(options.artifact, 'fixture-profile.json'),
      JSON.stringify(
        {
          executable,
          spki,
          sharedResolution: resolved.id,
          scope: 'owned fixture SPKI only; not operator PKI/native/device acceptance',
        },
        null,
        2,
      ),
    );
    browser = await chromium.launch({
      executablePath: executable,
      downloadsPath: join(cli.files.directory, 'browser-downloads'),
      args: [`--ignore-certificate-errors-spki-list=${spki}`],
      env: { HOME: cli.files.userHome, TMPDIR: cli.files.directory, PATH: '/usr/bin:/bin' },
    });
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      acceptDownloads: true,
    });
    await context.addInitScript(
      ({ identity, url }) => {
        localStorage.setItem('remi-identity', identity);
        localStorage.setItem('remi-connections', JSON.stringify([url]));
        const observation = {
          created: [] as { url: string; at: number; size: number }[],
          revoked: [] as { url: string; at: number }[],
        };
        Object.defineProperty(window, '__remiDownloadObservation', { value: observation });
        const create = URL.createObjectURL.bind(URL),
          revoke = URL.revokeObjectURL.bind(URL);
        URL.createObjectURL = (value: Blob | MediaSource) => {
          const url = create(value);
          if (value instanceof Blob && value.type === 'application/octet-stream')
            observation.created.push({ url, at: performance.now(), size: value.size });
          return url;
        };
        URL.revokeObjectURL = (url: string) => {
          if (observation.created.some((item) => item.url === url))
            observation.revoked.push({ url, at: performance.now() });
          revoke(url);
        };
      },
      { identity: serializeIdentity(cli.identity), url },
    );
    const page = await context.newPage();
    evidencePage = page;
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}`);
    await page.getByText('work', { exact: true }).first().click({ timeout: 20000 });
    await page.evaluate(async () => {
      await document.fonts.ready;
    });
    const panel = page.getByRole('region', { name: 'File download' });
    await panel.getByRole('button', { name: 'Download', exact: true }).waitFor({ timeout: 20000 });
    return {
      cli,
      page,
      panel,
      context,
      clientFrames,
      hostFrames,
      errors,
      ledger,
      get hasHeldChunk() {
        return heldChunk !== null;
      },
      releaseChunk() {
        const value = heldChunk;
        heldChunk = null;
        value?.send();
      },
      restoreLedger() {
        if (faulted) {
          fs.chmodSync(ledger, 0o700);
          faulted = false;
        }
      },
      observation: () =>
        page.evaluate(
          () =>
            Reflect.get(window, '__remiDownloadObservation') as {
              created: { url: string; at: number; size: number }[];
              revoked: { url: string; at: number }[];
            },
        ),
      close,
    };
  } catch (error) {
    if (evidencePage) {
      try {
        fs.writeFileSync(
          join(options.artifact, 'startup-failed-dom.txt'),
          await evidencePage.locator('body').innerText(),
        );
        await evidencePage.screenshot({ path: join(options.artifact, 'startup-failed.png') });
      } catch {
        /* The original setup failure remains authoritative if the page has closed. */
      }
    }
    fs.writeFileSync(join(options.artifact, 'startup-failed-cli.txt'), cli.output.text);
    try {
      await close();
    } catch (cleanup) {
      throw new AggregateError([error, cleanup], 'Owned download App startup failed');
    }
    throw error;
  }
}
