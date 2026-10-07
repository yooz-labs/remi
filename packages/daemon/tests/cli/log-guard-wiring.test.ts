/**
 * Source pins (#729): every long-lived remi process keeps the log files it
 * writes to bounded, and the opt-in debug sinks are bounded too. The repo
 * pins `cli.ts` wiring by its source (as `claude-session.test.ts` does).
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = (rel: string) => readFileSync(join(import.meta.dir, '../../src', rel), 'utf8');
const cli = src('cli.ts');

function cliFrom(marker: string, length = 1500): string {
  const at = cli.indexOf(marker);
  expect(at).toBeGreaterThanOrEqual(0);
  return cli.slice(at, at + length);
}

describe('long-lived processes keep their logs bounded (#729)', () => {
  test('a daemon or hub guards the files behind its stdout and stderr', () => {
    const daemon = cliFrom('if (cliDaemonMode) {\n  console.log(serveMode');
    expect(daemon).toMatch(/guardLogFiles\(\s*logFilesBehind\(\s*\[1, 2\],\s*\[/);
    for (const name of ["'daemon.log'", "'remi-stdout.log'", "'remi-stderr.log'"]) {
      expect(daemon).toContain(name);
    }
  });

  test('a wrapper guards remi.log when it opened it', () => {
    const wrapper = cliFrom('startLogFileSession(LOG_FILE');
    expect(wrapper).toMatch(/if \(logSession\.path === LOG_FILE\) guardLogFiles\(\[LOG_FILE\]\);/);
  });
});

describe('the opt-in debug sinks are bounded (#729)', () => {
  test('hook-diag.jsonl', () => {
    expect(src('hooks/hook-server.ts').includes('appendBounded(logPath, `${logLine}\\n`)')).toBe(
      true,
    );
  });

  test('the PTY capture', () => {
    expect(/appendBounded\(\s*path,/.test(src('pty/pty-capture.ts'))).toBe(true);
  });
});
