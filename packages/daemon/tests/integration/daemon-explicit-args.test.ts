/**
 * A session daemon's harness arguments are what follows `--` on its command line
 * (#1179): a hub appends them there, last, after `--harness <id>`. Black-box, on
 * the REAL `cli.ts --daemon` in an isolated `$HOME`, with fake `claude` and
 * `codex` executables first on a PATH of fakes plus `/usr/bin:/bin` only and a
 * `FakeAppServer` for Codex. What each fake agent recorded is what the daemon
 * started it with.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  type FakeAgents,
  collect,
  installFakeAgents,
  waitForRecordedArgv,
} from '../helpers/fake-agent-clis.ts';
import { FakeAppServer } from '../helpers/fake-app-server.ts';
import { cleanupHub, makeIsolatedDirs, spawnDaemon } from './hub-test-utils.ts';

interface Running {
  proc: Bun.Subprocess<'ignore', 'pipe', 'pipe'>;
  home: string;
  work: string;
  port: number;
  agents: FakeAgents;
  server: FakeAppServer;
  output: { text: string };
}
const running: Running[] = [];

afterEach(async () => {
  for (const r of running.splice(0)) {
    for (const dir of [r.agents.codexDir, r.agents.claudeDir]) {
      fs.writeFileSync(path.join(dir, 'release'), '');
    }
    await cleanupHub({ proc: r.proc, home: r.home, work: r.work, port: r.port });
    await r.server.stop();
  }
});

async function startDaemon(extraArgs: readonly string[]): Promise<Running> {
  const { home, work } = makeIsolatedDirs();
  const agents = installFakeAgents(home);
  const server = FakeAppServer.start();
  const spawned = await spawnDaemon(
    home,
    work,
    { ...agents.env, CODEX_HOME: server.codexHome },
    extraArgs,
  );
  const output = { text: '' };
  collect(spawned.proc.stdout, output);
  collect(spawned.proc.stderr, output);
  const r: Running = { ...spawned, home, work, agents, server, output };
  running.push(r);
  return r;
}

/** The fake records whole or not at all, so the file existing is the whole list (P11). */
function argvOf(dir: string, r: Running): Promise<string[]> {
  return waitForRecordedArgv(dir, { stillRunning: () => r.proc.exitCode === null });
}

describe('a daemon starts its harness with the arguments after -- (#1179)', () => {
  test('Claude gets them, beside its own launch flags', async () => {
    const r = await startDaemon(['--', '--model', 'opus', '--fork-session']);
    const argv = await argvOf(r.agents.claudeDir, r);
    expect(argv.slice(0, 3)).toEqual(['--model', 'opus', '--fork-session']);
    expect(argv).toContain('--session-id');
    expect(argv).toContain('-n');
  }, 60000);

  test('a stray word that is not after -- is still ignored, so an existing plist starts as before', async () => {
    const r = await startDaemon(['stray', 'words']);
    const argv = await argvOf(r.agents.claudeDir, r);
    expect(argv).toHaveLength(4);
    expect(argv[0]).toBe('--session-id');
    expect(argv).not.toContain('stray');
    expect(argv).not.toContain('words');
  }, 60000);

  test('Codex gets them, validated, after --no-alt-screen', async () => {
    const r = await startDaemon([
      '--harness',
      'codex',
      '--',
      '-m',
      'some-model',
      '-a',
      'untrusted',
    ]);
    expect(await argvOf(r.agents.codexDir, r)).toEqual([
      '--no-alt-screen',
      '-m',
      'some-model',
      '-a',
      'untrusted',
    ]);
  }, 60000);

  test('a Codex flag the validator refuses ends the daemon with exit 2, before anything is written or started', async () => {
    const r = await startDaemon(['--harness', 'codex', '--', '-c', 'features.x=true']);
    expect(await r.proc.exited).toBe(2);
    expect(r.output.text).toContain('-c');
    expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
    expect(fs.existsSync(path.join(r.home, '.remi', 'sessions.json'))).toBe(false);
  }, 60000);

  test.each([
    ['a loose Codex flag', ['--harness', 'codex', '-m', 'x']],
    ['a loose word', ['--harness', 'codex', 'stray']],
    ['a loose word before the arguments', ['--harness', 'codex', 'stray', '--', '-m', 'x']],
  ])(
    'a Codex daemon with %s ends with exit 2 and starts nothing (G3)',
    async (_name, extraArgs) => {
      // Until Phase 5 `remi codex --daemon` refused any argument; one that is not after `--` is
      // still an error and not silently ignored, which would start Codex without what was asked.
      const r = await startDaemon(extraArgs);
      expect(await r.proc.exited).toBe(2);
      expect(r.output.text).toContain('after `--`');
      expect(fs.existsSync(path.join(r.agents.codexDir, 'argv'))).toBe(false);
      expect(fs.existsSync(path.join(r.home, '.remi', 'sessions.json'))).toBe(false);
    },
    60000,
  );

  test('a Codex daemon with no arguments after -- starts exactly as it did before', async () => {
    const r = await startDaemon(['--harness', 'codex']);
    expect(await argvOf(r.agents.codexDir, r)).toEqual(['--no-alt-screen']);
  }, 60000);
});
