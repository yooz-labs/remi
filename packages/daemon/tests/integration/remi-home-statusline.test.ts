/**
 * #1126 review (P2): under a `REMI_HOME` override a session daemon writes its
 * statusline script into the relocated state directory but must not register
 * it in Claude Code's user settings (`$HOME/.claude/settings.json`): that file
 * is the owner's, not remi state, and a scratch run must leave it alone.
 *
 * The REAL cli.ts runs as a subprocess (`remi --daemon`) with a sandbox
 * `$HOME` and `REMI_HOME`. A stand-in `claude` on `PATH` only sleeps, so no
 * real Claude starts. The control case (no `REMI_HOME`) proves the run
 * reaches the installer at all: there the registration does happen, into the
 * sandbox `$HOME`.
 */

import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CLI_TS, findTestPort, isolatedEnv, pollUntil } from './hub-test-utils.ts';

const procs: Array<ReturnType<typeof Bun.spawn>> = [];
const dirs: string[] = [];

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/** A `claude` that never talks to anything: the daemon only needs a child. */
function fakeClaudeBin(): string {
  const bin = tmp('remi-fake-claude-');
  fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\nexec sleep 60\n', { mode: 0o755 });
  return bin;
}

async function runDaemonUntil(
  home: string,
  extraEnv: Record<string, string>,
  ready: () => boolean,
): Promise<void> {
  const work = tmp('remi-statusline-work-');
  const port = await findTestPort();
  const proc = Bun.spawn(
    ['bun', CLI_TS, '--daemon', '--port', String(port), '--no-relay', '--no-mdns', '--no-telegram'],
    {
      cwd: work,
      env: isolatedEnv(home, {
        ...extraEnv,
        PATH: `${fakeClaudeBin()}:${process.env['PATH'] ?? ''}`,
      }),
      stdout: 'ignore',
      stderr: 'ignore',
    },
  );
  procs.push(proc);
  await pollUntil(ready, 20_000, 'the daemon to install its statusline');
  // Give any later write a chance to land before the assertions.
  await new Promise((r) => setTimeout(r, 300));
  proc.kill('SIGTERM');
  await proc.exited;
}

afterEach(async () => {
  for (const p of procs.splice(0)) {
    try {
      p.kill('SIGKILL');
    } catch {}
    await p.exited;
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('statusline under REMI_HOME (#1126)', () => {
  test('control: without REMI_HOME the daemon registers the statusline in $HOME/.claude/settings.json', async () => {
    const home = tmp('remi-statusline-home-');
    const settings = path.join(home, '.claude', 'settings.json');
    await runDaemonUntil(home, {}, () => fs.existsSync(settings));
    const parsed = JSON.parse(fs.readFileSync(settings, 'utf8')) as {
      statusLine?: { command?: string };
    };
    expect(parsed.statusLine?.command).toBe(path.join(home, '.remi', 'statusline.sh'));
  }, 30_000);

  test('with REMI_HOME the script lands there and $HOME/.claude/settings.json is never created', async () => {
    const home = tmp('remi-statusline-home-');
    const remiHome = tmp('remi-statusline-state-');
    const script = path.join(remiHome, 'statusline.sh');
    await runDaemonUntil(home, { REMI_HOME: remiHome }, () => fs.existsSync(script));
    expect(fs.existsSync(path.join(home, '.claude', 'settings.json'))).toBe(false);
    expect(fs.existsSync(path.join(home, '.remi'))).toBe(false);
  }, 30_000);

  test('with REMI_HOME an existing $HOME/.claude/settings.json is left byte for byte', async () => {
    const home = tmp('remi-statusline-home-');
    const remiHome = tmp('remi-statusline-state-');
    const settings = path.join(home, '.claude', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    const original = '{\n  "theme": "dark"\n}\n';
    fs.writeFileSync(settings, original);
    const script = path.join(remiHome, 'statusline.sh');
    await runDaemonUntil(home, { REMI_HOME: remiHome }, () => fs.existsSync(script));
    expect(fs.readFileSync(settings, 'utf8')).toBe(original);
  }, 30_000);
});
