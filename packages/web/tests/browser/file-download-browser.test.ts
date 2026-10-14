/** Opt-in actual App + shipping CLI + isolated Chromium; generated inert files only. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { until } from '../../../daemon/tests/helpers/browser-link-service-fixture.ts';
import { fileDownloadAppFixture } from '../helpers/file-download-app-fixture.ts';

const enabled = process.env['REMI_FILE_DOWNLOAD_BROWSER_TESTS'] === '1';
const profile = process.env['REMI_FILE_DOWNLOAD_BROWSER_PROFILE'] ?? 'direct';
(enabled ? test : test.skip)(
  `actual App file download ${profile}: explicit request, verified Save and bounded lifecycle`,
  async () => {
    const artifact = process.env['REMI_FILE_DOWNLOAD_ARTIFACTS'];
    if (!artifact) throw Error('An owned S1 artifact directory is required');
    const cleanupFault = profile === 'cleanup-fault';
    const f = await fileDownloadAppFixture({
      artifact,
      harness: profile === 'codex' ? 'codex' : 'claude',
      holdFirstChunk: true,
      cleanupFault,
    });
    const downloads: string[] = [];
    const popups: string[] = [];
    f.page.on('download', (download) => downloads.push(download.suggestedFilename()));
    f.page.on('popup', (page) => popups.push(page.url()));
    const name = `report-${'result-'.repeat(27)}final.bin`;
    const bytes = Uint8Array.from({ length: 32768 }, (_, i) => (i * 17) % 251);
    f.cli.write(name, bytes);
    try {
      const initialUrl = f.page.url();
      const settleViewport = async () => {
        // AppLayout switches its real DOM branch after the resize event; do not photograph
        // the intermediate tree. Keep the complete chat controls in the visible viewport.
        await f.page.waitForFunction(
          () => {
            const desktop = window.innerWidth >= 768;
            const input = document.querySelector<HTMLInputElement>(
              'textarea[placeholder="Type a message..."],input[placeholder="Type a message..."]',
            );
            const bounds = input?.getBoundingClientRect();
            return (
              (document.querySelector('main') !== null) === desktop &&
              document.querySelectorAll('button[aria-label="Go back"]').length === 1 &&
              !!bounds &&
              bounds.top >= 0 &&
              bounds.bottom <= window.innerHeight
            );
          },
          undefined,
          { timeout: 3000 },
        );
        await f.page.evaluate(async () => {
          // Wait for real finite layout transitions and a painted frame before capture.
          await Promise.all(
            document
              .getAnimations()
              .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
              .map((animation) => animation.finished.catch(() => undefined)),
          );
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
        expect(await f.page.getByRole('button', { name: 'Go back', exact: true }).count()).toBe(1);
      };
      expect((await f.observation()).created).toEqual([]);
      expect(downloads).toEqual([]);
      await f.panel.getByLabel('File path in project').fill(name);
      await f.panel.getByRole('button', { name: 'Download', exact: true }).click();
      await until(() => f.hasHeldChunk, 'actual held first file chunk', 20000);
      await f.panel.getByText('Receiving file…', { exact: true }).waitFor();
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ]) {
        await f.page.setViewportSize({ width: width!, height: height! });
        await settleViewport();
        await f.page.screenshot({
          animations: 'disabled',
          path: join(artifact, `${width}-receiving.png`),
        });
        expect(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      expect(downloads).toEqual([]);
      expect((await f.observation()).created).toEqual([]);
      f.releaseChunk();
      const save = f.panel.getByRole('button', { name: 'Save', exact: true });
      await save.waitFor({ timeout: 25000 });
      expect(await save.isEnabled()).toBe(true);
      expect(await f.panel.getByText(name, { exact: true }).innerText()).toBe(name);
      if (cleanupFault) {
        await f.panel
          .getByText('Host cleanup was not confirmed.', { exact: false })
          .waitFor({ timeout: 25000 });
        f.restoreLedger();
        expect(
          f.hostFrames.some(
            (frame) => frame['type'] === 'file_fetch_refused' && frame['code'] === 'cleanup_failed',
          ),
        ).toBe(true);
      }
      for (const [width, height] of [
        [390, 844],
        [768, 1024],
        [1440, 900],
      ]) {
        await f.page.setViewportSize({ width: width!, height: height! });
        await settleViewport();
        await f.page.screenshot({
          animations: 'disabled',
          path: join(artifact, `${width}-verified.png`),
        });
        expect(
          await f.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        ).toBe(true);
      }
      expect(downloads).toEqual([]);
      expect(f.page.url()).toBe(initialUrl);
      expect(popups).toEqual([]);
      const pending = f.page.waitForEvent('download');
      await save.click();
      const download = await pending;
      expect(download.suggestedFilename()).toBe(name);
      const saved = join(artifact, 'saved-fixture.bin');
      await download.saveAs(saved);
      expect(fs.readFileSync(saved)).toEqual(Buffer.from(bytes));
      expect(createHash('sha256').update(fs.readFileSync(saved)).digest('hex')).toBe(
        createHash('sha256').update(bytes).digest('hex'),
      );
      expect(downloads).toEqual([name]);
      expect(f.page.url()).toBe(initialUrl);
      expect(popups).toEqual([]);
      await f.panel
        .getByText('Download requested. Check your browser’s downloads.', { exact: true })
        .waitFor();
      const created = await f.observation();
      expect(created.created).toHaveLength(1);
      expect(created.created[0]?.size).toBe(bytes.length);
      await f.panel.getByRole('button', { name: 'Discard', exact: true }).click();
      await f.panel
        .getByText(
          /^Download (cancelled and discarded\.|discarded\. Host cleanup was not confirmed\.)$/,
        )
        .waitFor();
      expect((await f.observation()).revoked).toHaveLength(1);
      if (!cleanupFault) {
        await f.panel.getByLabel('File path in project').fill('.private');
        await f.panel.getByRole('button', { name: 'Download', exact: true }).click();
        await f.panel.getByText('This file download is unavailable.', { exact: true }).waitFor();
        await f.page.screenshot({
          animations: 'disabled',
          path: join(artifact, '1440-refused.png'),
        });
        expect(await f.panel.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
        f.cli.write('cancel.bin', new Uint8Array(10485760).fill(29));
        await f.panel.getByLabel('File path in project').fill('cancel.bin');
        await f.panel.getByRole('button', { name: 'Download', exact: true }).click();
        await f.panel.getByText('Preparing file…', { exact: true }).waitFor();
        await f.panel.getByRole('button', { name: 'Cancel', exact: true }).click();
        await f.panel
          .getByText('Download cancelled and discarded.', { exact: true })
          .waitFor({ timeout: 20000 });
        const cancel = f.clientFrames
          .slice()
          .reverse()
          .find((frame) => frame['type'] === 'file_fetch_cancel');
        expect(cancel).toBeDefined();
        expect(
          f.hostFrames.some(
            (frame) =>
              frame['type'] === 'file_fetch_cancel_result' && frame['requestId'] === cancel?.['id'],
          ),
        ).toBe(true);
        expect(await f.panel.getByRole('button', { name: 'Save', exact: true }).count()).toBe(0);
        await f.page.screenshot({
          animations: 'disabled',
          path: join(artifact, '1440-cancelled.png'),
        });
      }
      expect(f.clientFrames.filter((frame) => frame['type'] === 'user_input')).toEqual([]);
      expect(f.errors).toEqual([]);
      fs.writeFileSync(
        join(artifact, 'actual-result.json'),
        JSON.stringify(
          {
            profile,
            downloads,
            popups,
            requestTypes: f.clientFrames.map((frame) => frame['type']),
            hostTypes: f.hostFrames.map((frame) => frame['type']),
            blob: await f.observation(),
            savedBytes: bytes.length,
            errors: f.errors,
          },
          null,
          2,
        ),
      );
    } catch (error) {
      fs.writeFileSync(join(artifact, 'failed-dom.txt'), await f.page.locator('body').innerText());
      await f.page.screenshot({ animations: 'disabled', path: join(artifact, 'failed.png') });
      throw error;
    } finally {
      f.restoreLedger();
      await f.close();
    }
  },
  120000,
);
