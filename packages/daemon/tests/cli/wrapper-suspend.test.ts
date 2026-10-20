/**
 * #375: execute the shipping wrapper's actual stdin listener under shell job
 * control. The child records OS PTY input; no SIGSTOP or stdin mocks run in
 * this test process. A passing current-source check does not close the older
 * compiled-build / real-Claude / Terminal or iTerm report.
 */
import { expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const runner = path.resolve(import.meta.dir, './fixtures/wrapper-suspend-pty.py');
const cli = path.resolve(import.meta.dir, '../../src/cli.ts');

test('wrapper Ctrl-Z/fg preserves stdin and keeps the PTY child running', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-suspend-pty-'));
  try {
    const proc = Bun.spawn(
      ['/usr/bin/python3', runner, '--root', dir, '--bun', process.execPath, '--cli', cli],
      { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } },
    );
    const [output, errors, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(errors).toBe('');
    expect(exitCode, output).toBe(0);
    const result = JSON.parse(output) as {
      cycles: string[];
      signalLogs: string[];
      remainingPids: number[];
      detached: boolean;
      seconds: number;
      shellPid: number;
      cleanupSignals: Array<{ pid: number; signal: string }>;
      cleanupAttempts: Array<{ pid: number; signal: string }>;
      knownExitedPids: number[];
      cleanupErrors: unknown[];
      unknownPids: number[];
      shellReaped: boolean;
      reapedShellAbsent: boolean;
    };
    expect(result.cycles).toEqual(['ctrl-z-0', 'ctrl-z-1', 'ctrl-z-2', 'external', 'surrounded']);
    expect(result.signalLogs).toHaveLength(10);
    expect(result.detached).toBe(true);
    expect(result.remainingPids).toEqual([]);
    expect(result.cleanupSignals.filter(({ pid }) => pid !== result.shellPid)).toEqual([]);
    expect(result.cleanupAttempts.filter(({ pid }) => pid !== result.shellPid)).toEqual([]);
    expect(result.knownExitedPids.length).toBeGreaterThanOrEqual(2);
    expect(result.cleanupErrors).toEqual([]);
    expect(result.unknownPids).toEqual([]);
    expect(result.shellReaped).toBe(true);
    expect(result.reapedShellAbsent).toBe(true);
    expect(result.seconds).toBeLessThan(30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test('startup timeout cleans up live owned processes with verified identities', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-suspend-startup-'));
  try {
    const proc = Bun.spawn(
      [
        '/usr/bin/python3',
        runner,
        '--root',
        dir,
        '--bun',
        process.execPath,
        '--cli',
        cli,
        '--hold-before-ready',
        '--deadline-seconds',
        '2',
      ],
      { stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } },
    );
    const [output, errors, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(errors).toBe('');
    expect(exitCode, output).toBe(1);
    const result = JSON.parse(output) as {
      error: string;
      remainingPids: number[];
      shellPid: number;
      cleanupSignals: Array<{ pid: number; signal: string }>;
      seconds: number;
      cleanupErrors: unknown[];
      unknownPids: number[];
      shellReaped: boolean;
      reapedShellAbsent: boolean;
    };
    expect(result.error).toBe('Timed out: inert child ready');
    expect(
      result.cleanupSignals.filter(({ pid }) => pid !== result.shellPid).length,
    ).toBeGreaterThan(0);
    expect(result.remainingPids).toEqual([]);
    expect(result.cleanupErrors).toEqual([]);
    expect(result.unknownPids).toEqual([]);
    expect(result.shellReaped).toBe(true);
    expect(result.reapedShellAbsent).toBe(true);
    expect(result.seconds).toBeLessThan(30);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
