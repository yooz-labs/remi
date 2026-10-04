/**
 * The fake `claude` and `codex` record what they were started with, and tests wait for that record
 * (#1204 round 2, P11). The first version wrote `argv` with a shell redirect, which creates the file
 * empty and fills it as the loop runs, so a test that waited for the file to EXIST could read half an
 * argument list (a flake that showed on Bun 1.3.11). The record is now renamed into place whole.
 *
 * `FAKE_AGENT_RECORD_DELAY` makes the fake pause after each argument it writes, which turns the old
 * race from rare into certain: against a recorder that writes in place, both tests below fail.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { installFakeAgents, waitForRecordedArgv } from './fake-agent-clis.ts';

const ARGS = ['--no-alt-screen', '-m', 'fixture-model', '-a', 'untrusted'];

describe('a fake agent that is slow to record', () => {
  let home: string;
  let proc: Bun.Subprocess | undefined;
  let codexDir: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-fake-agents-'));
    const agents = installFakeAgents(home, { codex: true });
    codexDir = agents.codexDir;
    proc = Bun.spawn([path.join(home, 'fake-bin', 'codex'), ...ARGS], {
      // The fake is a shell script: a system PATH is all it needs, and the delay is two tenths of a second per argument.
      env: { PATH: '/usr/bin:/bin', FAKE_CODEX_DIR: codexDir, FAKE_AGENT_RECORD_DELAY: '0.2' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
  });

  afterEach(async () => {
    // End the fake by its release file (it waits for one), and by its own PID if that is not enough.
    fs.writeFileSync(path.join(codexDir, 'release'), '');
    const pid = proc?.pid;
    await Promise.race([
      proc?.exited ?? Promise.resolve(0),
      new Promise<number>((resolve) => setTimeout(() => resolve(-1), 3000)),
    ]);
    if (pid !== undefined && proc?.exitCode === null) proc.kill('SIGKILL');
    fs.rmSync(home, { recursive: true, force: true });
  });

  test('waitForRecordedArgv returns every argument, and cwd and pid are whole when it does', async () => {
    expect(await waitForRecordedArgv(codexDir)).toEqual(ARGS);
    expect(fs.readFileSync(path.join(codexDir, 'cwd'), 'utf8').trim()).not.toBe('');
    expect(Number(fs.readFileSync(path.join(codexDir, 'pid'), 'utf8'))).toBe(proc?.pid as number);
  });

  test('a reader that waits for argv to exist, as the old helper did, never sees it half written', async () => {
    const argv = path.join(codexDir, 'argv');
    const start = Date.now();
    while (!fs.existsSync(argv)) {
      if (Date.now() - start > 10_000) throw new Error('the fake never recorded');
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fs.readFileSync(argv, 'utf8')).toBe(`${ARGS.join('\n')}\n`);
  });
});
