/** Opt-in actual App + source CLI + owned signed TLS + existing Chromium. No user browser profile. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { chromium } from '@playwright/test';
import { createServer } from 'vite';
import { createIdentity, serializeIdentity } from '@remi/shared';
import { IdentityStore } from '../../../daemon/src/auth/identity-store.ts';
import { directTlsFixture } from '../../../daemon/tests/helpers/direct-tls-fixture.ts';
import { until } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';
const enabled = process.env['REMI_BROWSER_TESTS'] === '1';
const loss = process.env['REMI_BROWSER_LOSS_TEST'] === '1';
const expiry = process.env['REMI_BROWSER_EXPIRY_TEST'] === '1';
(enabled ? test : test.skip)(
  'actual App renders full destinations at three sizes; explicit Open has no opener/referrer; replacement and identity loss clear',
  async () => {
    const f = directTlsFixture();
    let proc: Bun.Subprocess | undefined;
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    let vite: Awaited<ReturnType<typeof createServer>> | undefined;
    const navigation: { url: string; referer: string | null }[] = [];
    let proxy: ReturnType<typeof Bun.serve> | undefined;
    const proxies = new Set<WebSocket>();
    let withheld: string | null = null;
    let receiverRequests = 0;
    let offeredToSelected = 0;
    let firstCandidate: string | null = null;
    let resendOldCandidate: (() => void) | undefined;
    let sendWithheld: (() => void) | undefined;
    const target = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname === '/destination')
          navigation.push({ url: req.url, referer: req.headers.get('referer') });
        return new Response(
          '<!doctype html><title>Owned destination</title><p>Owned destination</p>',
          { headers: { 'content-type': 'text/html' } },
        );
      },
    });
    const artifact = process.env['REMI_BROWSER_ARTIFACTS'] ?? join(f.directory, 'screenshots');
    fs.mkdirSync(artifact, { recursive: true });
    try {
      const identity = await createIdentity();
      const store = new IdentityStore(f.home);
      await store.generate();
      await store.addAuthorizedKey(identity.publicKey, 'owned App');
      const bin = join(f.directory, 'bin');
      fs.mkdirSync(bin);
      fs.writeFileSync(
        join(bin, 'claude'),
        `#!/bin/sh\nprintf '%s' "$BROWSER" > '${join(f.directory, 'browser-path')}'\nwhile [ ! -e '${join(f.directory, 'invoke')}' ]; do sleep 0.02; done\n"$BROWSER" '${`http://127.0.0.1:${target.port}/destination?q=${'full-destination-'.repeat(100)}`}'\nwhile [ ! -e '${join(f.directory, 'release')}' ]; do sleep 0.02; done\n`,
        { mode: 0o700 },
      );
      const held = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('held') });
      const port = held.port!;
      held.stop(true);
      proc = Bun.spawn(
        [
          process.execPath,
          '--no-env-file',
          resolve(import.meta.dir, '../../../daemon/src/entry.ts'),
          '--daemon',
          '--port',
          String(port),
          '--dir',
          f.work,
          '--no-mdns',
          '--no-telegram',
        ],
        {
          cwd: f.work,
          env: { ...f.env, PATH: `${bin}:/opt/homebrew/bin:/usr/bin:/bin` },
          stdout: 'ignore',
          stderr: 'ignore',
        },
      );
      await until(
        () => fs.existsSync(join(f.directory, 'browser-path')) || proc!.exitCode !== null,
        'App consumer',
        15000,
      );
      expect(proc.exitCode).toBeNull();
      let publicUrl = `wss://127.0.0.1:${port}/ws`;
      if (loss) {
        proxy = Bun.serve<{ backend: WebSocket; pending: (string | Uint8Array)[] }>({
          hostname: '127.0.0.1',
          port: 0,
          tls: f.tls,
          fetch(req, server) {
            if (
              server.upgrade(req, { data: { backend: null as unknown as WebSocket, pending: [] } })
            )
              return;
            return new Response('owned loss courier');
          },
          websocket: {
            open(front) {
              const back = new WebSocket(`wss://127.0.0.1:${port}/ws`, {
                tls: { ca: f.ca },
              } as never);
              front.data.backend = back;
              proxies.add(back);
              back.onopen = () => {
                for (const frame of front.data.pending) back.send(frame);
                front.data.pending = [];
              };
              back.onmessage = (event) => {
                const raw = String(event.data);
                const frame = JSON.parse(raw);
                if (frame.type === 'browser_link_receiver_result' && !withheld) {
                  withheld = raw;
                  sendWithheld = () => front.send(raw);
                  return;
                }
                if (frame.type === 'browser_link_candidate') {
                  offeredToSelected++;
                  if (!firstCandidate) {
                    firstCandidate = raw;
                    resendOldCandidate = () => front.send(raw);
                  }
                }
                front.send(raw);
              };
              back.onclose = () => front.close();
              back.onerror = () => front.close();
            },
            message(front, raw) {
              const text = typeof raw === 'string' ? raw : raw.toString();
              const frame = JSON.parse(text);
              if (frame.type === 'browser_link_receiver_request') receiverRequests++;
              const back = front.data.backend;
              if (back.readyState === WebSocket.OPEN) back.send(text);
              else {
                if (front.data.pending.length >= 64) {
                  front.close();
                  return;
                }
                front.data.pending.push(text);
              }
            },
            close(front) {
              front.data.backend.close();
            },
          },
        });
        publicUrl = `wss://127.0.0.1:${proxy.port}/ws`;
      }
      vite = await createServer({
        root: resolve(import.meta.dir, '../..'),
        configFile: resolve(import.meta.dir, '../../vite.config.ts'),
        server: {
          host: '127.0.0.1',
          port: 0,
          fs: {
            allow: [
              resolve(import.meta.dir, '../../../..'),
              fs.realpathSync(resolve(import.meta.dir, '../../node_modules')),
              fs.realpathSync(resolve(import.meta.dir, '../../../../node_modules')),
            ],
          },
        },
      });
      await vite.listen();
      const address = vite.httpServer!.address();
      if (!address || typeof address === 'string') throw Error('No owned Vite address');
      const origin = `http://127.0.0.1:${address.port}`;
      const resolved = await vite.pluginContainer.resolveId(
        '@remi/shared',
        resolve(import.meta.dir, '../../src/App.tsx'),
      );
      expect(resolved?.id).toBe(resolve(import.meta.dir, '../../../shared/src/index.ts'));
      const spki = createHash('sha256')
        .update(new X509Certificate(f.tls.cert).publicKey.export({ type: 'spki', format: 'der' }))
        .digest('base64');
      const executable =
        process.env['REMI_BROWSER_EXECUTABLE'] ??
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
      fs.writeFileSync(
        join(artifact, 'fixture-profile.json'),
        JSON.stringify({
          executable,
          spki,
          scope: 'owned temporary fixture public key only; not operator normal PKI acceptance',
          sharedResolution: resolved?.id,
        }),
      );
      browser = await chromium.launch({
        executablePath: executable,
        args: [`--ignore-certificate-errors-spki-list=${spki}`],
        env: { HOME: f.userHome, TMPDIR: f.directory, PATH: '/usr/bin:/bin' },
      });
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      await context.addInitScript(
        ({ identity, url }) => {
          localStorage.setItem('remi-identity', identity);
          localStorage.setItem('remi-connections', JSON.stringify([url]));
        },
        { identity: serializeIdentity(identity), url: publicUrl },
      );
      const page = await context.newPage();
      let receivedCandidates = 0;
      page.on('websocket', (socket) =>
        socket.on('framereceived', (event) => {
          try {
            if (JSON.parse(String(event.payload)).type === 'browser_link_candidate')
              receivedCandidates++;
          } catch { /* Observer ignores non-JSON transport frames. */ }
        }),
      );
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      await page.goto(origin);
      await page.waitForTimeout(1500);
      fs.writeFileSync(join(artifact, 'initial-dom.txt'), await page.locator('body').innerText());
      fs.writeFileSync(join(artifact, 'initial-errors.json'), JSON.stringify(errors));
      await page.screenshot({ path: join(artifact, 'initial.png'), fullPage: true });
      const receive = page.getByRole('button', { name: 'Receive browser links here', exact: true });
      await page.getByText('work', { exact: true }).first().click({ timeout: 15000 });
      await receive.waitFor({ timeout: 15000 });
      await receive.waitFor({ state: 'visible' });
      expect(await receive.isEnabled()).toBe(true);
      await page.screenshot({ path: join(artifact, '390-ready.png'), fullPage: true });
      expect(navigation).toEqual([]);
      await receive.click();
      if (loss) {
        await page.getByText('Receiver request pending…', { exact: true }).waitFor();
        await until(() => withheld !== null, 'withheld actual C2 result');
        expect(JSON.parse(withheld as unknown as string).outcome).toBe('selected');
        for (const [width, height] of [
          [390, 844],
          [768, 1024],
          [1440, 900],
        ]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(artifact, `${width}-pending.png`) });
        }
        fs.writeFileSync(join(f.directory, 'invoke'), 'owned');
        await until(() => offeredToSelected === 1, 'independent actual C2 selected offer');
        expect(await page.locator('[data-browser-destination]').count()).toBe(0);
        expect(navigation).toEqual([]);
        await page
          .getByText('Receiver outcome unknown.', { exact: false })
          .waitFor({ timeout: 17000 });
        expect(receiverRequests).toBe(1);
        for (const [width, height] of [
          [390, 844],
          [768, 1024],
          [1440, 900],
        ]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(artifact, `${width}-uncertain.png`) });
        }
        await receive.click();
        await page.getByText('Receiving browser links here.', { exact: false }).waitFor();
        expect(receiverRequests).toBe(2);
        sendWithheld?.();
        const launcher = fs.readFileSync(join(f.directory, 'browser-path'), 'utf8');
        const resend = Bun.spawn(
          [
            launcher,
            `http://127.0.0.1:${target.port}/destination?q=${'full-destination-'.repeat(100)}`,
          ],
          { env: f.env, stdout: 'ignore', stderr: 'ignore' },
        );
        expect(await resend.exited).toBe(0);
      }
      await page.getByText('Receiving browser links here.', { exact: false }).waitFor();
      fs.writeFileSync(join(f.directory, 'invoke'), 'owned');
      const destination = page.locator('[data-browser-destination]');
      await destination.waitFor();
      const exact = await destination.textContent();
      if (!exact) throw Error('No destination');
      expect(exact).toContain('full-destination-'.repeat(100));
      expect(navigation).toEqual([]);
      if (loss) {
        const before = receivedCandidates;
        resendOldCandidate?.();
        await until(() => receivedCandidates > before, 'actual late old lease frame observed');
        expect(await destination.count()).toBe(1);
      }
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ]) {
        await page.setViewportSize({ width, height });
        await page.waitForTimeout(400);
        expect(await destination.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
        expect(await destination.textContent()).toBe(exact);
        await page.screenshot({
          path: join(artifact, `${width}-selected-long.png`),
          fullPage: false,
        });
        fs.writeFileSync(
          join(artifact, `${width}-layout.json`),
          JSON.stringify(
            await page.evaluate(() => ({
              width: innerWidth,
              height: innerHeight,
              rootChildren: document.querySelector('#root')?.children.length,
              panels: document.querySelectorAll('[aria-label="Browser links"]').length,
              asides: document.querySelectorAll('aside').length,
              scrollHeight: document.documentElement.scrollHeight,
            })),
          ),
        );
      }
      const popupPromise = context.waitForEvent('page');
      await page.getByRole('button', { name: 'Open', exact: true }).click();
      const popup = await popupPromise;
      await popup.waitForLoadState();
      expect(navigation).toEqual([{ url: exact, referer: null }]);
      expect(await popup.evaluate(() => window.opener === null)).toBe(true);
      expect(await page.getByText('Unable to open the destination.').count()).toBe(0);
      await popup.close();
      expect(
        await page.evaluate(
          (url) => Object.values(localStorage).some((value) => value.includes(url!)),
          exact,
        ),
      ).toBe(false);
      if (expiry) {
        const background = await context.newPage();
        await background.goto('about:blank');
        const started = performance.now();
        await Bun.sleep(120050);
        expect(performance.now() - started).toBeGreaterThanOrEqual(120000);
        await page.bringToFront();
        await page.getByText('The previous destinations expired.', { exact: false }).waitFor();
        expect(await destination.count()).toBe(0);
        expect(await page.getByRole('button', { name: 'Open', exact: true }).count()).toBe(0);
        expect(navigation).toHaveLength(1);
        for (const [width, height] of [
          [390, 844],
          [768, 1024],
          [1440, 900],
        ]) {
          await page.setViewportSize({ width, height });
          await page.waitForTimeout(400);
          await page.screenshot({ path: join(artifact, `${width}-expired.png`) });
        }
        await background.close();
      }
      const other = await browser.newContext();
      await other.addInitScript(
        ({ identity, url }) => {
          localStorage.setItem('remi-identity', identity);
          localStorage.setItem('remi-connections', JSON.stringify([url]));
        },
        { identity: serializeIdentity(identity), url: publicUrl },
      );
      const second = await other.newPage();
      await second.goto(origin);
      const receive2 = second.getByRole('button', {
        name: 'Receive browser links here',
        exact: true,
      });
      await second.getByText('work', { exact: true }).first().click({ timeout: 15000 });
      await receive2.waitFor();
      expect(await receive2.isEnabled()).toBe(true);
      await receive2.click();
      await page.getByText('Another receiver was selected.').waitFor();
      expect(await destination.count()).toBe(0);
      await page.screenshot({ path: join(artifact, '1440-replaced.png'), fullPage: true });
      expect(navigation).toHaveLength(1);
      await page.evaluate(async () => {
        const path = '/src/lib/identity-client.ts';
        const module = await import(path);
        const own = module.loadIdentity();
        module.removeIdentity();
        module.saveIdentity(own);
      });
      await page
        .getByText('Browser links require a verified direct TLS connection', { exact: false })
        .waitFor();
      expect(await page.getByRole('button', { name: 'Open', exact: true }).count()).toBe(0);
      await page.screenshot({
        path: join(artifact, '1440-identity-disconnected.png'),
        fullPage: true,
      });
      expect(navigation).toHaveLength(1);
      expect(errors).toEqual([]);
      await other.close();
      await context.close();
    } finally {
      await browser?.close();
      await vite?.close();
      proxy?.stop(true);
      for (const socket of proxies) socket.close();
      target.stop(true);
      if (proc && proc.exitCode === null) {
        proc.kill('SIGTERM');
        await proc.exited;
      }
      f.cleanup();
    }
  },
  180000,
);
