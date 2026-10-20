/** Opt-in actual App over a source encrypted relay; no installed account or device. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { until } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';
import {
  type OwnedRelayAppResources,
  relayBrowserLinkAppFixture,
} from '../helpers/relay-browser-link-app-fixture.ts';

const enabled = process.env['REMI_RELAY_BROWSER_LINK_TESTS'] === '1';
(enabled ? test : test.skip)(
  'actual relay App selects, opens explicitly, stops, replaces and retires its receiver',
  async () => {
    const artifact = process.env['REMI_RELAY_BROWSER_LINK_ARTIFACTS'];
    if (!artifact) throw Error('An owned artifact directory is required');
    const f = await relayBrowserLinkAppFixture(artifact);
    try {
      const receive = f.panel.getByRole('button', {
        name: 'Receive browser links here',
        exact: true,
      });
      expect(f.errors).toEqual([]);
      expect(await receive.isEnabled()).toBe(true);
      expect(f.requests).toEqual([]);
      await receive.click();
      await f.panel.getByText('Receiving browser links here.', { exact: false }).waitFor();
      const marker = `owned-relay-${'review-'.repeat(20)}explicit-open`;
      const url = f.destinationURL(marker);
      await f.offer(url);
      await f.panel.getByText(url, { exact: true }).waitFor();
      expect(f.requests).toEqual([]);
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ]) {
        await f.page.setViewportSize({ width: width!, height: height! });
        await f.page.waitForFunction(
          () => (document.querySelector('main') !== null) === window.innerWidth >= 768,
        );
        await f.page.evaluate(async () => {
          await document.fonts.ready;
          await Promise.all(
            document
              .getAnimations()
              .filter(
                (animation) =>
                  animation.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY,
              )
              .map((animation) => animation.finished.catch(() => undefined)),
          );
          await new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          );
        });
        expect(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
        await f.page.screenshot({
          animations: 'disabled',
          path: join(artifact, `${width}-candidate.png`),
        });
      }
      const popup = f.context.waitForEvent('page');
      await f.panel.getByRole('button', { name: 'Open', exact: true }).click();
      const opened = await popup;
      await opened.waitForURL(url);
      await until(
        () => f.requests.some((request) => request.url === url),
        'actual destination request',
      );
      expect(f.requests.filter((request) => request.url === url)).toEqual([{ url, referer: null }]);
      expect(await opened.evaluate(() => window.opener === null)).toBe(true);
      await opened.close();
      await f.panel.getByRole('button', { name: 'Stop receiving', exact: true }).click();
      await f.panel
        .getByText('Choose where this session sends browser links.', { exact: false })
        .waitFor();
      expect(await f.panel.getByRole('button', { name: 'Open', exact: true }).count()).toBe(0);
      await receive.click();
      await f.panel.getByText('Receiving browser links here.', { exact: false }).waitFor();
      const peer = await f.relay.connect(f.replacementIdentity);
      const { createHello, generateId, now } = await import('@remi/shared');
      await peer.send(
        createHello('owned replacement', 'T4', { resumeSessionId: f.relay.sessionId }),
      );
      await peer.next();
      await peer.send({
        type: 'browser_link_receiver_request',
        id: generateId(),
        timestamp: now(),
        sessionId: f.relay.sessionId,
        binding: f.relay.context().binding,
        seq: 1,
        action: 'select',
      });
      await f.panel.getByText('Another receiver was selected.', { exact: true }).waitFor();
      expect(await f.panel.getByRole('button', { name: 'Open', exact: true }).count()).toBe(0);
      await receive.click();
      await f.panel.getByText('Receiving browser links here.', { exact: false }).waitFor();
      const neverOpened = f.destinationURL('owned-never-opened');
      await f.offer(neverOpened);
      await f.panel.getByText(neverOpened, { exact: true }).waitFor();
      await f.relay.relay.stop();
      await f.panel
        .getByText('Browser links are unavailable for this session.', { exact: false })
        .waitFor();
      expect(await f.panel.getByRole('button', { name: 'Open', exact: true }).count()).toBe(0);
      expect(f.requests.some((request) => request.url === neverOpened)).toBe(false);
      const binary = f.wire.filter((frame) => frame.binary);
      expect(binary.length).toBeGreaterThan(4);
      expect(f.wire.some((frame) => frame.payload.includes(Buffer.from(marker)))).toBe(false);
      expect(f.errors).toEqual([]);
      fs.writeFileSync(
        join(artifact, 'actual-result.json'),
        JSON.stringify(
          {
            requests: f.requests,
            wire: f.wire.map(({ direction, binary, payload }) => ({
              direction,
              binary,
              bytes: payload.length,
              sha256: createHash('sha256').update(payload).digest('hex'),
            })),
            explicitOpen: true,
            replacement: true,
            stopped: true,
            channelLoss: true,
            markerAbsentFromObservedClientWorkerFrames: true,
            errors: f.errors,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      fs.writeFileSync(join(artifact, 'failed-dom.txt'), await f.page.locator('body').innerText());
      await f.page.screenshot({ path: join(artifact, 'failed.png') });
      throw error;
    } finally {
      await f.close();
    }
  },
  90000,
);

(enabled ? test : test.skip)(
  'a closed startup page cannot prevent real relay App resource cleanup',
  async () => {
    const artifact = process.env['REMI_RELAY_BROWSER_LINK_ARTIFACTS'];
    if (!artifact) throw Error('An owned artifact directory is required');
    let owned: OwnedRelayAppResources | undefined;
    try {
      await expect(
        relayBrowserLinkAppFixture(join(artifact, 'closed-page'), {
          closePageAfterNavigation: true,
          observe: (resources) => {
            owned = resources;
            fs.writeFileSync(
              join(artifact, 'closed-page-owned.json'),
              JSON.stringify(
                {
                  directory: resources.directory,
                  launcher: resources.launcher,
                  consumerPid: resources.consumer.childPid,
                  browserPid: resources.browserPid,
                  endpoints: resources.endpoints,
                },
                null,
                2,
              ),
            );
          },
        }),
      ).rejects.toThrow('Owned relay App startup cleanup failed');
      if (!owned) throw Error('Owned resources were not observed');
      expect(fs.existsSync(owned.directory)).toBe(false);
      expect(fs.existsSync(owned.launcher)).toBe(false);
      expect(owned.consumer.sessionState).toBe('exited');
      const browserPid = owned.browserPid;
      let browserExited = false;
      try {
        process.kill(browserPid, 0);
      } catch (error) {
        browserExited = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
      expect(browserExited).toBe(true);
      for (const endpoint of owned.endpoints)
        await expect(fetch(endpoint, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
      fs.writeFileSync(
        join(artifact, 'closed-page-cleanup.json'),
        JSON.stringify(
          {
            actualClosedPage: true,
            diagnosticsRejected: true,
            cleanupCompleted: true,
            privateHomeRemoved: true,
            launcherRemovedAfterConsumerExit: true,
            allThreeOwnedEndpointsClosed: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await owned?.close();
    }
  },
  30000,
);

(enabled ? test : test.skip)(
  'natural two-minute relay destination expiry removes Open without opening a browser',
  async () => {
    const artifact = process.env['REMI_RELAY_BROWSER_LINK_ARTIFACTS'];
    if (!artifact) throw Error('An owned artifact directory is required');
    const f = await relayBrowserLinkAppFixture(join(artifact, 'natural-expiry'));
    try {
      await f.panel
        .getByRole('button', { name: 'Receive browser links here', exact: true })
        .click();
      await f.panel.getByText('Receiving browser links here.', { exact: false }).waitFor();
      const url = f.destinationURL('owned-natural-expiry');
      const started = performance.now();
      await f.offer(url);
      await f.panel.getByText(url, { exact: true }).waitFor();
      await f.panel
        .getByText('The previous destinations expired. Still receiving here.', { exact: true })
        .waitFor({ timeout: 125000 });
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(119000);
      expect(elapsed).toBeLessThan(125000);
      expect(await f.panel.getByRole('button', { name: 'Open', exact: true }).count()).toBe(0);
      expect(f.requests).toEqual([]);
      expect(f.errors).toEqual([]);
      fs.writeFileSync(
        join(artifact, 'natural-expiry-result.json'),
        JSON.stringify(
          {
            elapsedMs: elapsed,
            actualSourceRelay: true,
            clockChanged: false,
            autoOpen: false,
            openRemoved: true,
          },
          null,
          2,
        ),
      );
    } finally {
      await f.close();
    }
  },
  150000,
);
