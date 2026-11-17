import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  READING_EXECUTABLES,
  readingSpawnCount,
  runReading,
  spawnBounded,
} from '../../../src/power/readings/run-reading.ts';

let directory = '';

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'remi-readings-'));
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function script(name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function pidExists(pid: number): boolean {
  return spawnSync('ps', ['-p', String(pid)], { stdio: 'ignore' }).status === 0;
}

test('the guard allows exactly the three reading tools', () => {
  expect([...READING_EXECUTABLES]).toEqual([
    '/usr/bin/pmset',
    '/usr/sbin/ioreg',
    '/usr/bin/notifyutil',
  ]);
});

test('runReading refuses every power-changing or unlisted command, and spawns nothing', async () => {
  const refused: ReadonlyArray<readonly [string, readonly string[]]> = [
    ['/usr/bin/pmset', ['-a', 'disablesleep', '0']],
    ['/usr/bin/pmset', ['sleepnow']],
    ['/usr/bin/pmset', ['displaysleepnow']],
    ['/usr/bin/pmset', ['-g', 'sleepnow']],
    ['/usr/bin/pmset', ['-g', 'assertions', '-a', 'disablesleep', '0']],
    ['/usr/bin/pmset', []],
    ['/usr/bin/sudo', ['-n', 'true']],
    ['/usr/bin/caffeinate', ['-t', '1']],
    ['/bin/ls', []],
    ['pmset', ['-g', 'assertions']],
  ];
  const before = readingSpawnCount();
  for (const [executable, args] of refused) {
    expect(await runReading(executable, args)).toEqual({ ok: false, reason: 'refused' });
  }
  expect(readingSpawnCount()).toBe(before);
});

test('the spawn counter moves when a process is spawned, so the refusal check can fail', async () => {
  const before = readingSpawnCount();
  const result = await spawnBounded(script('count.sh', 'exit 0'), []);
  expect(result.ok).toBe(true);
  expect(readingSpawnCount()).toBe(before + 1);
  await spawnBounded(join(directory, 'absent'), []);
  expect(readingSpawnCount()).toBe(before + 2);
});

test('a slow child is killed at the deadline and its pid is gone', async () => {
  const pidFile = join(directory, 'slow.pid');
  const slow = script('slow.sh', `echo $$ > ${pidFile}\nexec sleep 5`);
  const started = Date.now();
  const result = await spawnBounded(slow, [], { timeoutMs: 300 });
  expect(result).toEqual({ ok: false, reason: 'timeout' });
  expect(Date.now() - started).toBeLessThan(2000);
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  expect(pid).toBeGreaterThan(1);
  expect(pidExists(pid)).toBe(false);
});

test('a child that prints 1 MiB is oversize and killed', async () => {
  const pidFile = join(directory, 'big.pid');
  const big = script('big.sh', `echo $$ > ${pidFile}\nexec head -c 1048576 /dev/zero`);
  expect(await spawnBounded(big, [])).toEqual({ ok: false, reason: 'oversize' });
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  expect(pidExists(pid)).toBe(false);
});

test('output under the cap is returned whole', async () => {
  const small = script('small.sh', 'printf "one\\ntwo\\n"');
  expect(await spawnBounded(small, [])).toEqual({ ok: true, stdout: 'one\ntwo\n', stderr: '' });
});

test('a missing path is missing, a non-executable file is not executable', async () => {
  expect(await spawnBounded(join(directory, 'nowhere'), [])).toEqual({
    ok: false,
    reason: 'missing',
  });
  const plain = join(directory, 'plain.txt');
  writeFileSync(plain, 'not a program\n');
  chmodSync(plain, 0o644);
  expect(await spawnBounded(plain, [])).toEqual({ ok: false, reason: 'not executable' });
});

test('a nonzero exit and a death by signal carry their code and name', async () => {
  expect(await spawnBounded(script('exit3.sh', 'exit 3'), [])).toEqual({
    ok: false,
    reason: 'exit 3',
  });
  expect(await spawnBounded(script('term.sh', 'kill -TERM $$'), [])).toEqual({
    ok: false,
    reason: 'signal SIGTERM',
  });
});

test('stderr is discarded unless asked for, and capped when kept', async () => {
  const noisy = script('noisy.sh', 'echo out\necho err >&2');
  expect(await spawnBounded(noisy, [])).toEqual({ ok: true, stdout: 'out\n', stderr: '' });
  expect(await spawnBounded(noisy, [], { captureStderr: true })).toEqual({
    ok: true,
    stdout: 'out\n',
    stderr: 'err\n',
  });
  const flood = script('flood.sh', 'head -c 300000 /dev/zero | tr "\\0" e >&2\necho done');
  const result = await spawnBounded(flood, [], { captureStderr: true });
  if (!result.ok) throw new Error(`flood failed: ${result.reason}`);
  expect(result.stdout).toBe('done\n');
  expect(result.stderr.length).toBe(65536);
});

test('the child gets exactly LC_ALL and PATH, and no stdin', async () => {
  const result = await spawnBounded('/usr/bin/env', []);
  if (!result.ok) throw new Error(`env failed: ${result.reason}`);
  expect(result.stdout.trim().split('\n').sort()).toEqual([
    'LC_ALL=C',
    'PATH=/usr/bin:/bin:/usr/sbin:/sbin',
  ]);
  const stdin = script('stdin.sh', 'if read line; then echo got; else echo eof; fi');
  expect(await spawnBounded(stdin, [])).toEqual({ ok: true, stdout: 'eof\n', stderr: '' });
});

test('a failed run leaves no stray file and never throws on a bad executable path', async () => {
  expect(existsSync(join(directory, 'nowhere'))).toBe(false);
  const result = await spawnBounded('', []);
  expect(result.ok).toBe(false);
});
