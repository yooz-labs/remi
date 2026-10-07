/**
 * Source pins (#729): every long-lived remi process keeps the log files it
 * writes to bounded. The repo pins `cli.ts` wiring by its source (as
 * `claude-session.test.ts` does); the debug sinks are tested by behavior in
 * their own test files.
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
    expect(daemon).toMatch(/planStdioLogGuard\(\s*\[1, 2\],\s*\[/);
    expect(daemon).toContain('guardLogFiles(stdioLogs.guarded);');
    // Says what it guards, and why it guards nothing when it cannot.
    expect(daemon).toContain('for (const notice of stdioLogs.notices)');
    for (const name of ["'daemon.log'", "'remi-stdout.log'", "'remi-stderr.log'"]) {
      expect(daemon).toContain(name);
    }
  });

  test('a wrapper guards remi.log when it opened it', () => {
    const wrapper = cliFrom('startLogFileSession(LOG_FILE');
    expect(wrapper).toMatch(/if \(logSession\.path === LOG_FILE\) guardLogFiles\(\[LOG_FILE\]\);/);
  });
});
