/** Start the same detached hub as `remi start` before a local session (#1823). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { remiHome } from '../config/remi-home.ts';
import type { LegacyPushPolicy } from '../notifications/legacy-push-policy.ts';
import {
  InterprocessFileLockError,
  withInterprocessFileLockAsync,
} from '../storage/interprocess-file-lock.ts';
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

/** Retry only a busy lock, never an exception from its critical section. */
async function withStartupLock(deadline: number, operation: () => void): Promise<void> {
  while (Date.now() < deadline) {
    let entered = false;
    try {
      await withInterprocessFileLockAsync(
        path.join(remiHome(), 'hub-autostart'),
        () => {
          entered = true;
          operation();
        },
        Math.max(1, deadline - Date.now()),
      );
      return;
    } catch (error) {
      if (entered || !(error instanceof InterprocessFileLockError) || !error.retryable) throw error;
      await Bun.sleep(Math.min(HUB_START_POLL_MS, Math.max(0, deadline - Date.now())));
    }
  }
  throw new Error('hub startup lock timed out');
}

function logStartupFailure(error: unknown, launcherStderr: string): void {
  // Error codes and names are diagnostic without logging inherited secrets or arguments.
  const code = (error as NodeJS.ErrnoException)?.code;
  const detail = typeof code === 'string' && /^[A-Z0-9_]+$/.test(code) ? code : 'startup failed';
  const secrets = ['REMI_PASSPHRASE', 'REMI_PUSH_SECRET', 'TELEGRAM_BOT_TOKEN']
    .map((name) => process.env[name])
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => b.length - a.length);
  const pattern = secrets.map((secret) => secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const safeStderr = pattern
    ? launcherStderr.replace(new RegExp(pattern, 'g'), '[REDACTED]')
    : launcherStderr;
  const lastLine = safeStderr
    .trimEnd()
    .split(/\r?\n/)
    .pop()
    ?.replace(/[\x00-\x1f\x7f]/g, ' ')
    .slice(0, 300);
  try {
    fs.mkdirSync(remiHome(), { recursive: true });
    fs.appendFileSync(
      path.join(remiHome(), 'daemon.log'),
      `[hub autostart] ${detail}${lastLine ? `: ${lastLine}` : ''}\n`,
    );
  } catch {
    // Starting the session must remain possible even if logging fails.
  }
}

export async function ensureHubForSession(
  enabled: boolean,
  policy: LegacyPushPolicy,
): Promise<void> {
  if (runningHub()) return;
  if (!enabled || process.env['REMI_HUB_AUTOSTART'] === '0') {
    console.error(noHubWarning(policy));
    return;
  }

  const deadline = Date.now() + HUB_START_TIMEOUT_MS;
  let attempted = false;
  let launcherStderr = '';
  try {
    await withStartupLock(deadline, () => {
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
        stderr: 'pipe',
        timeout: Math.max(1, deadline - Date.now()),
      });
      launcherStderr = result.stderr.toString();
      attempted = result.exitCode === 0;
      // Hold the lock until the hub is ready or the startup bound expires.
      while (Date.now() < deadline && !runningHub() && (attempted || readPidFileLive())) {
        Bun.sleepSync(HUB_START_POLL_MS);
      }
      if (!runningHub()) throw new Error('hub launcher did not start a hub');
    });
    const hub = runningHub();
    if (hub) {
      if (attempted) console.error(`Started the remi hub on port ${hub.port}.`);
      return;
    }
  } catch (error) {
    logStartupFailure(error, launcherStderr);
  }
  if (!runningHub()) console.error(noHubWarning(policy));
}
