/** Opt-in actual App + source encrypted relay + strict file service child. Generated inert bytes. */
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { until } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';
import { relayFileDownloadAppFixture } from '../helpers/relay-file-download-app-fixture.ts';

const enabled = process.env['REMI_RELAY_FILE_DOWNLOAD_BROWSER_TESTS'] === '1';
const harness = process.env['REMI_RELAY_FILE_DOWNLOAD_HARNESS'] === 'codex' ? 'codex' : 'claude';
(enabled ? test : test.skip)(
  `actual ${harness} relay App explicitly downloads, saves, cancels and loses context`,
  async () => {
    const artifact = process.env['REMI_RELAY_FILE_DOWNLOAD_ARTIFACTS'];
    if (!artifact) throw Error('An owned S1 artifact directory is required');
    const f = await relayFileDownloadAppFixture(artifact, harness);
    const downloads: string[] = [],
      popups: string[] = [];
    f.page.on('download', (d) => downloads.push(d.suggestedFilename()));
    f.page.on('popup', (p) => popups.push(p.url()));
    const marker = Buffer.from(`owned-relay-file-${'private-payload-'.repeat(15)}`);
    const bytes = Buffer.alloc(10485760);
    for (let offset = 0; offset < bytes.length; offset += marker.length) marker.copy(bytes, offset);
    f.actual.write(bytes);
    try {
      const initialUrl = f.page.url();
      const downloadButton = f.panel.getByRole('button', { name: 'Download', exact: true });
      const path = f.panel.getByLabel('File path in project');
      expect(f.actual.ledger().inspect()).toEqual([]);
      expect(downloads).toEqual([]);
      await path.fill('sample.bin');
      await downloadButton.click();
      await f.panel.getByText('Receiving file…', { exact: true }).waitFor({ timeout: 20000 });
      const render = async (state: string) => {
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
                .filter((a) => a.effect?.getTiming().iterations !== Number.POSITIVE_INFINITY)
                .map((a) => a.finished.catch(() => undefined)),
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
            path: join(artifact, `${width}-${state}.png`),
          });
        }
      };
      await render('receiving');
      expect(downloads).toEqual([]);
      expect(popups).toEqual([]);
      const save = f.panel.getByRole('button', { name: 'Save', exact: true });
      await save.waitFor({ timeout: 45000 });
      expect(await save.isEnabled()).toBe(true);
      await f.panel.getByText('File verified. Ready to save.', { exact: false }).waitFor();
      await f.page.getByText('download-secondary', { exact: true }).click();
      await f.panel
        .getByText('A download is active in another session. Finish or discard it there.', {
          exact: true,
        })
        .waitFor();
      expect(await f.panel.getByRole('button', { name: 'Download', exact: true }).isEnabled()).toBe(
        false,
      );
      expect(await f.panel.getByLabel('File path in project').isEnabled()).toBe(false);
      await f.page.screenshot({
        animations: 'disabled',
        path: join(artifact, '1440-other-session-busy.png'),
      });
      await f.page.getByText('download-primary', { exact: true }).first().click();
      await save.waitFor({ timeout: 10000 });
      expect(await save.isEnabled()).toBe(true);
      await render('verified');
      expect(downloads).toEqual([]);
      expect(f.page.url()).toBe(initialUrl);
      expect(popups).toEqual([]);
      const pending = f.page.waitForEvent('download');
      await save.click();
      const result = await pending,
        saved = join(artifact, 'saved-file.bin');
      await result.saveAs(saved);
      expect(result.suggestedFilename()).toBe('sample.bin');
      expect(createHash('sha256').update(fs.readFileSync(saved)).digest('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(fs.statSync(saved).size).toBe(10485760);
      expect(downloads).toEqual(['sample.bin']);
      expect(f.page.url()).toBe(initialUrl);
      expect(popups).toEqual([]);
      await f.panel.getByRole('button', { name: 'Discard', exact: true }).click();
      await f.panel.getByText('Download cancelled and discarded.', { exact: true }).waitFor();

      await path.fill('.private');
      await downloadButton.click();
      await f.panel.getByText('This file download is unavailable.', { exact: true }).waitFor();
      expect(await save.count()).toBe(0);
      await f.page.screenshot({ animations: 'disabled', path: join(artifact, '1440-refused.png') });
      await path.fill('sample.bin');
      await downloadButton.click();
      await f.panel.getByText('Receiving file…', { exact: true }).waitFor({ timeout: 20000 });
      await f.panel.getByRole('button', { name: 'Cancel', exact: true }).click();
      await f.panel
        .getByText('Download cancelled and discarded.', { exact: true })
        .waitFor({ timeout: 20000 });
      expect(await save.count()).toBe(0);
      await f.page.screenshot({
        animations: 'disabled',
        path: join(artifact, '1440-cancelled.png'),
      });

      f.actual.write(Buffer.from([7]));
      await path.fill('sample.bin');
      await downloadButton.click();
      await save.waitFor({ timeout: 20000 });
      const records = () =>
        f.actual
          .ledger()
          .inspect()
          .map((record) => record.id)
          .sort();
      const before = records();
      f.closeChannel();
      await f.panel
        .getByText('The connection or session changed. Start a new Download to retry.', {
          exact: true,
        })
        .waitFor();
      expect(await save.count()).toBe(0);
      await Bun.sleep(100);
      expect(records()).toEqual(before);
      expect(downloads).toEqual(['sample.bin']);
      expect(popups).toEqual([]);
      expect(f.errors).toEqual([]);
      await until(
        () =>
          f.actual
            .ledger()
            .inspect()
            .every((r) => r.state === 'settled'),
        'actual relay file reservations settled',
        10000,
      );
      expect(f.wire.filter((frame) => frame.binary).length).toBeGreaterThan(320);
      expect(
        f.wire.every(
          (frame) =>
            !frame.payload.includes(marker) &&
            !frame.payload.includes(Buffer.from(marker.toString('base64url'))),
        ),
      ).toBe(true);
      fs.writeFileSync(
        join(artifact, 'actual-result.json'),
        JSON.stringify(
          {
            harness,
            savedBytes: bytes.length,
            digest: createHash('sha256').update(bytes).digest('hex'),
            downloads,
            popups,
            observedFrames: f.wire.length,
            binaryFrames: f.wire.filter((frame) => frame.binary).length,
            carrierBinaryFrames: f.receivedBinary(),
            settledRecordIds: before,
            errors: f.errors,
            scope:
              'Actual two source CLI children and relay App; opaque30ms incoming-frame delay. No deployed/native/provider acceptance.',
          },
          null,
          2,
        ),
      );
    } catch (error) {
      try {
        fs.writeFileSync(
          join(artifact, 'failed-dom.txt'),
          await f.page.locator('body').innerText(),
        );
        await f.page.screenshot({ animations: 'disabled', path: join(artifact, 'failed.png') });
      } catch {}
      throw error;
    } finally {
      await f.close();
      const reaped = f.childCleanup();
      expect(reaped).toBeDefined();
      if (!reaped) throw Error('Owned source child receipt absent');
      for (const receipt of [reaped.primary, reaped.secondary]) {
        expect(receipt.consumerReaped).toBe(true);
        expect(receipt.daemonReaped).toBe(true);
        expect(receipt.stdinMeasured).toBe(true);
        expect(receipt.stdin).toEqual(Buffer.alloc(0));
      }
    }
  },
  120000,
);
