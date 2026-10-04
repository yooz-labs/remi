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
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
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
