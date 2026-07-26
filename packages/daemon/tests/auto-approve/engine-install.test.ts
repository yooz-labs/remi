/**
 * Helper acquisition (#834).
 *
 * The gap this closes: #818 could START a helper and #297 BUILT one, but
 * nothing put it on a user's machine, so `engine_path` was empty by default
 * and auto-approve escalated everything on a fresh install.
 *
 * Real files and a real `ditto` throughout — the failure modes here (a partial
 * unpack left behind, an archive that does not contain what was expected, a
 * signature stripped by the wrong archiver) only exist against a real
 * filesystem.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  ENGINE_RELEASE,
  canInstallHelper,
  ensureHelperInstalled,
  installedHelperPath,
  resolveHelperPath,
} from '../../src/auto-approve/engine-install.ts';

const TEST_ROOT = path.join(os.tmpdir(), `remi-engine-install-${process.pid}`);

beforeEach(() => {
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

/** Build a `.app`-shaped directory and archive it exactly as the engine's
 *  release pipeline does (`ditto -c -k`), so the extract path under test is
 *  exercised against a real archive rather than a hand-rolled zip. */
function makeReleaseArchive(dest: string): void {
  const staging = path.join(TEST_ROOT, 'staging');
  const macos = path.join(staging, ENGINE_RELEASE.appDir, 'Contents', 'MacOS');
  fs.mkdirSync(macos, { recursive: true });
  fs.writeFileSync(path.join(macos, ENGINE_RELEASE.binary), '#!/bin/sh\nexit 0\n', {
    mode: 0o755,
  });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const r = spawnSync(
    '/usr/bin/ditto',
    ['-c', '-k', '--keepParent', path.join(staging, ENGINE_RELEASE.appDir), dest],
    { stdio: 'ignore' },
  );
  if (r.status !== 0) throw new Error('ditto -c -k failed building the fixture');
  fs.rmSync(staging, { recursive: true, force: true });
}

describe('resolveHelperPath', () => {
  test('an explicit engine_path always wins', () => {
    // Someone pointing at their own build is making a deliberate choice; a
    // download must never second-guess it.
    expect(resolveHelperPath('/custom/helper', TEST_ROOT)).toBe('/custom/helper');
  });

  test('falls back to an installed helper, and to nothing when absent', () => {
    expect(resolveHelperPath('', TEST_ROOT)).toBeUndefined();

    const installed = installedHelperPath(TEST_ROOT);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '');
    expect(resolveHelperPath('', TEST_ROOT)).toBe(installed);
  });
});

describe('canInstallHelper', () => {
  test('Apple Silicon only — the helper is MLX', () => {
    // Fetching 30 MB that cannot execute is worse than doing nothing.
    expect(canInstallHelper('darwin', 'arm64')).toBe(true);
    expect(canInstallHelper('darwin', 'x64')).toBe(false);
    expect(canInstallHelper('linux', 'x64')).toBe(false);
  });
});

// The install path is macOS-only by construction: `canInstallHelper` gates on
// Apple Silicon, and the archive is expanded with `ditto`, which does not exist
// elsewhere. These assert real filesystem behaviour, so they are skipped rather
// than faked off-platform — a fake `ditto` would test the fake. The pure
// resolution/gating logic above runs everywhere, including Linux CI.
const describeMacOS = process.platform === 'darwin' ? describe : describe.skip;

describeMacOS('ensureHelperInstalled', () => {
  test('unpacks the release archive and returns the executable', async () => {
    const logs: string[] = [];
    const target = await ensureHelperInstalled({
      log: (m) => logs.push(m),
      root: TEST_ROOT,
      download: async (_url, dest) => makeReleaseArchive(dest),
    });

    expect(target).toBe(installedHelperPath(TEST_ROOT));
    expect(fs.existsSync(target as string)).toBe(true);
    // The archive itself is disposable once expanded; keeping it would double
    // the footprint of something the user did not ask to store.
    expect(fs.existsSync(path.join(TEST_ROOT, ENGINE_RELEASE.tag, ENGINE_RELEASE.asset))).toBe(
      false,
    );
  });

  test('is a no-op when the helper is already installed', async () => {
    // The common path on every boot after the first: one stat, no network.
    const installed = installedHelperPath(TEST_ROOT);
    fs.mkdirSync(path.dirname(installed), { recursive: true });
    fs.writeFileSync(installed, '');

    let downloaded = false;
    const target = await ensureHelperInstalled({
      log: () => undefined,
      root: TEST_ROOT,
      download: async () => {
        downloaded = true;
      },
    });

    expect(target).toBe(installed);
    expect(downloaded).toBe(false);
  });

  test('a failed download leaves NOTHING behind', async () => {
    // A half-unpacked bundle would be found by `resolveHelperPath` on the next
    // boot and launched as though it were whole.
    const logs: string[] = [];
    const target = await ensureHelperInstalled({
      log: (m) => logs.push(m),
      root: TEST_ROOT,
      download: async () => {
        throw new Error('network unreachable');
      },
    });

    expect(target).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_ROOT, ENGINE_RELEASE.tag))).toBe(false);
    expect(logs.join('\n')).toContain('Could not install');
  });

  test('an archive without the expected bundle is rejected, not half-installed', async () => {
    const logs: string[] = [];
    const target = await ensureHelperInstalled({
      log: (m) => logs.push(m),
      root: TEST_ROOT,
      download: async (_url, dest) => {
        // A real, valid archive — of the wrong thing.
        const staging = path.join(TEST_ROOT, 'wrong');
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(path.join(staging, 'README'), 'not an app');
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        spawnSync('/usr/bin/ditto', ['-c', '-k', '--keepParent', staging, dest], {
          stdio: 'ignore',
        });
      },
    });

    expect(target).toBeUndefined();
    expect(fs.existsSync(path.join(TEST_ROOT, ENGINE_RELEASE.tag))).toBe(false);
  });

  test('the install is versioned by release tag', async () => {
    // An upgrade must never overwrite the helper a running engine was launched
    // from -- the engine outlives the daemon that started it by design.
    expect(installedHelperPath(TEST_ROOT)).toContain(ENGINE_RELEASE.tag);
  });
});
