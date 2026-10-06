/**
 * Real wrapper CLI privacy pin (#1200). A synthetic executable replaces only
 * Claude, while the source CLI, HookServer, permission gate, tracker and log
 * writer are real. Wrapper subagent permissions pass through and park for a
 * terminal render; their diagnostic must not include the private question.
 */
import { afterEach, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DEFAULT_CONFIG } from '../../src/config/config.ts';
import { reserveRange } from '../session/port-test-helpers.ts';
import { CLI_TS, isolatedEnv, makeIsolatedDirs, pollUntil } from './hub-test-utils.ts';

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const dispose of cleanup.splice(0)) await dispose();
});

test('a wrapper subagent permission parks without recording its private question in diagnostics', async () => {
  const { home, work } = makeIsolatedDirs();
  const remiHome = path.join(home, '.remi');
  const fakeDir = path.join(home, 'synthetic-claude');
  const fakeBin = path.join(home, 'bin');
  fs.mkdirSync(remiHome, { recursive: true });
  fs.mkdirSync(fakeDir);
  fs.mkdirSync(fakeBin);
  fs.writeFileSync(
    path.join(fakeBin, 'claude'),
    `#!/bin/sh
printf '%s' "$*" > "$FAKE_CLAUDE_DIR/argv"
i=0
while [ ! -e "$FAKE_CLAUDE_DIR/release" ] && [ $i -lt 600 ]; do
  sleep 0.1
  i=$((i + 1))
done
`,
    { mode: 0o755 },
  );
  const shell = path.join(fakeBin, 'shell-path');
  fs.writeFileSync(shell, '#!/bin/sh\necho "$PATH"\n', { mode: 0o755 });
  const port = await reserveRange(1, 50, DEFAULT_CONFIG.daemon.bind);
  const proc = Bun.spawn(
    [
      process.execPath,
      CLI_TS,
      '--port',
      String(port),
      '--no-relay',
      '--no-telegram',
      '--no-mdns',
      '--no-auth',
    ],
    {
      cwd: work,
      env: isolatedEnv(home, {
        REMI_HOME: remiHome,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        SHELL: shell,
        FAKE_CLAUDE_DIR: fakeDir,
        CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: '',
      }),
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  );
  // Drain the real PTY pass-through. Diagnostic assertions read the wrapper's
  // owned log, rather than confusing terminal output with diagnostic output.
  const stdout = new Response(proc.stdout).text();
  const stderr = new Response(proc.stderr).text();
  cleanup.push(async () => {
    fs.writeFileSync(path.join(fakeDir, 'release'), '');
    try {
      await pollUntil(() => proc.exitCode !== null, 5000, 'the owned wrapper to exit');
    } finally {
      if (proc.exitCode === null) {
        proc.kill('SIGKILL');
        await proc.exited;
      }
      await Promise.all([stdout, stderr]);
      fs.rmSync(home, { recursive: true, force: true });
      fs.rmSync(work, { recursive: true, force: true });
    }
  });

  let hookPort = 0;
  await pollUntil(
    () => {
      if (proc.exitCode !== null) throw new Error(`Wrapper exited (${proc.exitCode})`);
      if (!fs.existsSync(path.join(fakeDir, 'argv'))) return false;
      const liveDir = path.join(remiHome, 'live-sessions');
      if (!fs.existsSync(liveDir)) return false;
      const files = fs.readdirSync(liveDir).filter((name) => name.endsWith('.json'));
      if (files.length !== 1) return false;
      const entry = JSON.parse(fs.readFileSync(path.join(liveDir, files[0] as string), 'utf8')) as {
        hookPort?: number;
      };
      hookPort = entry.hookPort ?? 0;
      return hookPort > 0;
    },
    20000,
    'the source wrapper and synthetic executable to start',
  );
  const argv = fs.readFileSync(path.join(fakeDir, 'argv'), 'utf8');
  const claudeSessionId = /^--session-id (\S+)/.exec(argv)?.[1];
  expect(claudeSessionId).toBeDefined();
  const sentinel = 'PRIVATE-PARKED-QUESTION-SENTINEL';
  const response = await fetch(`http://127.0.0.1:${hookPort}/hooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      hook_event_name: 'PermissionRequest',
      session_id: claudeSessionId,
      cwd: fs.realpathSync(work),
      transcript_path: '/synthetic.jsonl',
      permission_mode: 'default',
      agent_id: 'synthetic-subagent',
      agent_type: 'Explore',
      tool_name: 'Bash',
      tool_input: { command: sentinel },
    }),
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({});
  const logFile = path.join(remiHome, 'remi.log');
  await pollUntil(
    () =>
      fs.existsSync(logFile) &&
      fs.readFileSync(logFile, 'utf8').includes('Parked question awaiting PTY render'),
    5000,
    'the actual question tracker to park the permission',
  );
  expect(fs.readFileSync(logFile, 'utf8')).not.toContain(sentinel);
}, 30000);
