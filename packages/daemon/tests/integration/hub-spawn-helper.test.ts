/**
 * `spawnHub` as the hub tests of this PR use it (#1204 round 2, P11).
 *
 * A full run on Bun 1.3.11 and one of twenty runs of `hub-create-session.test.ts` failed with "Hub
 * exited early with code 1": the hub could not bind its port. `findTestPort` hands the LOWEST free
 * port from 19200 to every caller, so two test processes on one machine (a second worktree's run,
 * another agent's) can be given the same one, and the helper threw without saying why. Two changes:
 * a caller may choose the port (the new tests take one from `reserveRange`, random in 45000 to
 * 49999 and probed free, as `spawnDaemon` already does), and the error carries what the hub said.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import type * as net from 'node:net';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { isProcessAlive } from '../../src/session/process-alive.ts';
import { occupyPort, reserveRange } from '../session/port-test-helpers.ts';
import {
  CLI_TS,
  type HubHandle,
  cleanupHub,
  makeIsolatedDirs,
  spawnHub,
} from './hub-test-utils.ts';

const BIND = DEFAULT_CONFIG.daemon.bind;

describe('spawnHub', () => {
  let hub: HubHandle | undefined;
  let holder: net.Server | undefined;
  let dirs: { home: string; work: string } | undefined;

  afterEach(async () => {
    if (hub) await cleanupHub(hub);
    holder?.close();
    if (dirs) {
      fs.rmSync(dirs.home, { recursive: true, force: true });
      fs.rmSync(dirs.work, { recursive: true, force: true });
    }
    hub = undefined;
    holder = undefined;
    dirs = undefined;
  });

  test('starts the hub on the port it is given', async () => {
    const port = await reserveRange(1, 50, BIND);
    hub = await spawnHub(undefined, {}, CLI_TS, port);
    expect(hub.port).toBe(port);
  });

  test('a hub that stays up and never says it is ready is killed, not left running, when the wait ends (Q2)', async () => {
    dirs = makeIsolatedDirs();
    // A stand-in that never starts a hub: it records its pid in its working directory and idles.
    const script = path.join(dirs.work, 'idle.ts');
    fs.writeFileSync(
      script,
      "import * as fs from 'node:fs';\nfs.writeFileSync('pid', String(process.pid));\nsetInterval(() => {}, 1000);\n",
    );
    const port = await reserveRange(1, 50, BIND);
    const message = await spawnHub(dirs, {}, script, port, 1500).then(
      () => 'started',
      (error: Error) => error.message,
    );
    expect(message).toContain('Timed out waiting for hub status file');
    const pid = Number(fs.readFileSync(path.join(dirs.work, 'pid'), 'utf8'));
    expect(pid).toBeGreaterThan(0);
    // The kill is waited for before the throw, so the process is already gone when it arrives.
    expect(isProcessAlive(pid)).toBe(false);
  }, 30000);

  test("a hub that cannot bind its port fails with the hub's own words, not just an exit code", async () => {
    const port = await reserveRange(1, 50, BIND);
    holder = await occupyPort(port, BIND);
    dirs = makeIsolatedDirs();
    const message = await spawnHub(dirs, {}, CLI_TS, port).then(
      () => 'started',
      (error: Error) => error.message,
    );
    expect(message).toContain('Hub exited early with code 1');
    expect(message).toContain(`Failed to start WebSocket on port ${port}`);
  });
});
