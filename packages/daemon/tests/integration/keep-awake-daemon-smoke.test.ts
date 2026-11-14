/**
 * macOS smoke for keep-awake level 1 (#1773): the REAL `cli.ts --daemon`,
 * started under `env -i` with its own HOME and REMI_HOME, a port from the
 * 45000 to 50000 test range (never the owner's 18765 to 18769) and a fake
 * `claude`, holds a real `caffeinate` assertion for its own pid during a turn,
 * releases it after the idle grace, holds again on the next turn, and leaves
 * none behind after SIGTERM. The turn is driven by posting the hook events
 * Claude Code would post to the daemon's own hook server. Skipped off macOS.
 */

import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { reserveRange } from '../session/port-test-helpers.ts';
import { CLI_TS, makeIsolatedDirs, pollUntil } from './hub-test-utils.ts';

/** A `claude` that stays up until the test releases it (60 s at most). */
const FAKE_CLAUDE = `#!/bin/sh
i=0
while [ ! -e "$FAKE_CLAUDE_DIR/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`;

/** The caffeinate pids whose assertion `pmset -g assertions` says was created for `target`. */
function caffeinateHoldersFor(target: number): number[] {
  const result = Bun.spawnSync(['/usr/bin/pmset', '-g', 'assertions'], { stdout: 'pipe' });
  if (result.exitCode !== 0) throw new Error(`pmset -g assertions failed (${result.exitCode})`);
  const holders: number[] = [];
  let caffeinatePid: number | null = null;
  for (const line of result.stdout.toString().split('\n')) {
    const owner = /^\s*pid (\d+)\(([^)]*)\):/.exec(line);
    if (owner) {
      caffeinatePid = owner[2] === 'caffeinate' ? Number(owner[1]) : null;
      continue;
    }
    const created = /Created for PID: (\d+)\b/.exec(line);
    if (created && caffeinatePid !== null && Number(created[1]) === target) {
      holders.push(caffeinatePid);
    }
  }
  return holders;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

const smoke = process.platform === 'darwin' ? test : test.skip;

smoke(
  'a real session daemon holds an assertion for its pid during a turn and none after SIGTERM',
  async () => {
    const { home, work } = makeIsolatedDirs();
    const remiHome = path.join(home, '.remi');
    fs.mkdirSync(remiHome, { recursive: true });
    // A one-second grace so the release between turns is seen in a few seconds.
    fs.writeFileSync(path.join(remiHome, 'config.toml'), '[awake]\nidle_grace_seconds = 1\n');
    const fakeDir = path.join(home, 'fake-claude');
    const fakeBin = path.join(home, 'fake-bin');
    fs.mkdirSync(fakeDir, { recursive: true });
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'claude'), FAKE_CLAUDE);
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
    const fakeShell = path.join(fakeBin, 'sh-path');
    fs.writeFileSync(fakeShell, '#!/bin/sh\necho "$PATH"\n');
    fs.chmodSync(fakeShell, 0o755);

    const port = await reserveRange(1);
    expect(port).toBeGreaterThan(18790);
    const env = {
      HOME: home,
      REMI_HOME: remiHome,
      // Only the fake and the system directories, and a login shell that
      // reports exactly that PATH: a test never starts a real `claude`.
      PATH: `${fakeBin}:/usr/bin:/bin`,
      SHELL: fakeShell,
      FAKE_CLAUDE_DIR: fakeDir,
      TMPDIR: '/private/tmp',
      CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '',
    };
    const proc = Bun.spawn(
      [
        '/usr/bin/env',
        '-i',
        ...Object.entries(env).map(([key, value]) => `${key}=${value}`),
        process.execPath,
        CLI_TS,
        '--daemon',
        '--port',
        String(port),
        '--no-relay',
        '--no-telegram',
        '--no-mdns',
        '--no-auth',
      ],
      { cwd: work, stdout: 'pipe', stderr: 'pipe' },
    );
    const daemonPid = proc.pid;
    const seenHolders = new Set<number>();
    cleanup.push(async () => {
      fs.writeFileSync(path.join(fakeDir, 'release'), '');
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        await proc.exited;
      }
      // A caffeinate is bound to the daemon by -w; wait for each one this test saw to go.
      const deadline = Date.now() + 5_000;
      while ([...seenHolders].some(isAlive) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
    });
    const output = { text: '' };
    for (const stream of [proc.stdout, proc.stderr]) {
      const decoder = new TextDecoder();
      void (async () => {
        for await (const chunk of stream) output.text += decoder.decode(chunk, { stream: true });
      })().catch(() => {});
    }

    const liveDir = path.join(remiHome, 'live-sessions');
    const liveEntry = (): { hookPort: number; claudeChildPid?: number } | null => {
      if (!fs.existsSync(liveDir)) return null;
      const files = fs.readdirSync(liveDir).filter((f) => f.endsWith('.json'));
      if (files.length !== 1) return null;
      try {
        return JSON.parse(fs.readFileSync(path.join(liveDir, files[0] as string), 'utf-8'));
      } catch {
        return null;
      }
    };
    await pollUntil(
      () => {
        if (proc.exitCode !== null) {
          throw new Error(`daemon exited early (${proc.exitCode}): ${output.text.slice(-2000)}`);
        }
        return liveEntry()?.claudeChildPid !== undefined;
      },
      20_000,
      'the daemon to launch its session',
    );
    const hookPort = (liveEntry() as { hookPort: number }).hookPort;
    const stored = JSON.parse(fs.readFileSync(path.join(remiHome, 'sessions.json'), 'utf-8')) as {
      sessions: Array<{ claudeSessionId: string }>;
    };
    const claudeSessionId = (stored.sessions[0] as { claudeSessionId: string }).claudeSessionId;
    const hook = async (event: Record<string, unknown>): Promise<void> => {
      const response = await fetch(`http://127.0.0.1:${hookPort}/hooks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: claudeSessionId, cwd: fs.realpathSync(work), ...event }),
      });
      expect(response.status).toBe(200);
    };
    const holders = (): number[] => {
      const found = caffeinateHoldersFor(daemonPid);
      for (const pid of found) seenHolders.add(pid);
      return found;
    };

    expect(holders()).toEqual([]);
    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'smoke turn' });
    await pollUntil(() => holders().length === 1, 8_000, 'a hold for the daemon pid');
    const first = holders()[0] as number;

    await hook({ hook_event_name: 'Stop', stop_hook_active: false });
    await pollUntil(() => holders().length === 0, 8_000, 'the release after the idle grace');
    await pollUntil(() => !isAlive(first), 5_000, 'the first caffeinate to exit');

    await hook({ hook_event_name: 'UserPromptSubmit', prompt: 'second smoke turn' });
    await pollUntil(() => holders().length === 1, 8_000, 'a hold on the next turn');
    const second = holders()[0] as number;
    expect(second).not.toBe(first);

    proc.kill('SIGTERM');
    await proc.exited;
    await pollUntil(() => holders().length === 0, 8_000, 'no assertion after SIGTERM');
    await pollUntil(() => !isAlive(second), 5_000, 'the second caffeinate to exit');
    console.info(
      `[AWAKE SMOKE] daemon=${daemonPid} port=${port} caffeinate=${first},${second} exit=${proc.exitCode} awake log: ${output.text
        .split('\n')
        .filter((line) => line.includes('[Awake]'))
        .join(' | ')}`,
    );
  },
  60_000,
);
