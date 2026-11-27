/** Start the same detached hub as `remi start` before a local session (#1823). */
import * as path from 'node:path';
import { remiHome } from '../config/remi-home.ts';
import { withInterprocessFileLockAsync } from '../storage/interprocess-file-lock.ts';
import {
  noHubWarning,
  readLiveHub,
  readPidFileLive,
  resolveRemiCommand,
} from './daemon-manager.ts';

// A startup bound, not a keep-awake tunable (ADR 0050 applies to [awake]).
const HUB_START_TIMEOUT_MS = 10_000;
const HUB_START_POLL_MS = 100;

function runningHub(): ReturnType<typeof readLiveHub> {
  try {
    return readLiveHub();
  } catch {
    return null;
  }
}

export async function ensureHubForSession(enabled: boolean): Promise<void> {
  if (runningHub()) return;
  if (!enabled || process.env['REMI_HUB_AUTOSTART'] === '0') {
    console.error(noHubWarning());
    return;
  }

  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  let attempted = false;
  while (Date.now() < deadline) {
    if (runningHub()) return;
    try {
      await withInterprocessFileLockAsync(path.join(remiHome(), 'hub-autostart'), () => {
        if (runningHub()) return;
        const { command, baseArgs } = resolveRemiCommand();
        const env = { ...process.env };
        // Like `remi start`, a wrapper's REMI_PORT is not the hub's port.
        // biome-ignore lint/performance/noDelete: the child must not inherit the port
        delete env['REMI_PORT'];
        // biome-ignore lint/performance/noDelete: the hub is not a session child
        delete env['REMI_SPAWNED_CHILD'];
        const result = Bun.spawnSync([command, ...baseArgs, 'start'], {
          env,
          stdout: 'ignore',
          stderr: 'ignore',
          timeout: Math.max(1, deadline - Date.now()),
        });
        attempted = result.exitCode === 0;
        // The launcher can return while its child is still initializing, and
        // another `remi start` may have claimed the PID before writing status.
        // Keep the lock until that hub is ready or the bound expires.
        while (Date.now() < deadline && !runningHub() && (attempted || readPidFileLive())) {
          Bun.sleepSync(HUB_START_POLL_MS);
        }
      });
      const hub = runningHub();
      if (hub) {
        if (attempted) console.error(`Started the remi hub on port ${hub.port}.`);
        return;
      }
      // A failed start does not prevent the session from starting.
      break;
    } catch {
      // Another launch may own the startup lock; wait only until the deadline.
      await Bun.sleep(HUB_START_POLL_MS);
    }
  }
  if (!runningHub()) console.error(noHubWarning());
}
