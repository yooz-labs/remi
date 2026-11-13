/** Explicit Save consumption and natural scheduled expiry in the actual App/Chromium. */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { fileDownloadAppFixture } from '../helpers/file-download-app-fixture.ts';

const enabled = process.env['REMI_FILE_DOWNLOAD_SAVE_TESTS'] === '1';
(enabled ? test : test.skip)(
  'actual browser Save consumes bytes before scheduled expiry and clears on unmount',
  async () => {
    const artifact = process.env['REMI_FILE_DOWNLOAD_ARTIFACTS'];
    if (!artifact) throw Error('An owned S1 artifact directory is required');
    const f = await fileDownloadAppFixture({ artifact });
    f.cli.write('one-byte.bin', new Uint8Array([73]));
    let downloadCount = 0;
    f.page.on('download', () => downloadCount++);
    try {
      await f.panel.getByLabel('File path in project').fill('one-byte.bin');
      await f.panel.getByRole('button', { name: 'Download', exact: true }).click();
      const save = f.panel.getByRole('button', { name: 'Save', exact: true });
      await save.waitFor({ timeout: 20000 });
      expect(downloadCount).toBe(0);
      expect((await f.observation()).created).toEqual([]);
      const pending = f.page.waitForEvent('download');
      await save.click();
      const download = await pending;
      const saved = join(artifact, 'actual-one-byte.bin');
      await download.saveAs(saved);
      expect(fs.readFileSync(saved)).toEqual(Buffer.from([73]));
      const before = await f.observation();
      expect(before.created).toHaveLength(1);
      expect(before.revoked).toEqual([]);
      await f.page.waitForFunction(
        () => Reflect.get(window, '__remiDownloadObservation').revoked.length === 1,
        undefined,
        { timeout: 33000 },
      );
      const expired = await f.observation();
      expect(expired.revoked[0]?.url).toBe(expired.created[0]?.url);
      const elapsed = expired.revoked[0]!.at - expired.created[0]!.at;
      expect(elapsed).toBeGreaterThanOrEqual(30000);
      expect(elapsed).toBeLessThan(33000);
      const second = f.page.waitForEvent('download');
      await save.click();
      await (await second).saveAs(join(artifact, 'second-one-byte.bin'));
      expect(downloadCount).toBe(2);
      expect((await f.observation()).created).toHaveLength(2);
      await f.page.getByRole('button', { name: 'Go back', exact: true }).click();
      await f.page.waitForFunction(
        () => Reflect.get(window, '__remiDownloadObservation').revoked.length === 2,
      );
      const unmounted = await f.observation();
      expect(unmounted.revoked[1]?.url).toBe(unmounted.created[1]?.url);
      expect(unmounted.revoked[1]!.at - unmounted.created[1]!.at).toBeLessThan(5000);
      expect(f.errors).toEqual([]);
      fs.writeFileSync(
        join(artifact, 'save-result.json'),
        JSON.stringify(
          {
            downloadCount,
            naturalElapsed: elapsed,
            observation: unmounted,
            scope:
              'Actual running-page timer and browser consumption; no durable OS-save or suspended-browser wall-clock claim',
          },
          null,
          2,
        ),
      );
    } catch (error) {
      fs.writeFileSync(
        join(artifact, 'save-failed-dom.txt'),
        await f.page.locator('body').innerText(),
      );
      await f.page.screenshot({ path: join(artifact, 'save-failed.png') });
      throw error;
    } finally {
      await f.close();
    }
  },
  90000,
);
