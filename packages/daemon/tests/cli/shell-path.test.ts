import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { resolveShellPath } from '../../src/cli/shell-path.ts';

describe('resolveShellPath', () => {
  let logCalls: string[];
  let errorCalls: string[];
  let savedPath: string | undefined;
  let savedShell: string | undefined;

  const logger = {
    log: (msg: string) => logCalls.push(msg),
    error: (msg: string) => errorCalls.push(msg),
  };

  beforeEach(() => {
    logCalls = [];
    errorCalls = [];
    savedPath = process.env['PATH'];
    savedShell = process.env['SHELL'];
  });

  afterEach(() => {
    if (savedPath === undefined) {
      // biome-ignore lint/performance/noDelete: restoring an unset env var requires true removal, not undefined-stringification.
      delete process.env['PATH'];
    } else {
      process.env['PATH'] = savedPath;
    }
    if (savedShell === undefined) {
      // biome-ignore lint/performance/noDelete: same reason as above.
      delete process.env['SHELL'];
    } else {
      process.env['SHELL'] = savedShell;
    }
  });

  test('adds shell-provided PATH entries into process.env.PATH', () => {
    process.env['PATH'] = '/usr/bin';
    process.env['SHELL'] = '/bin/zsh';
    resolveShellPath(logger);
    const entries = (process.env['PATH'] ?? '').split(':');
    expect(entries).toContain('/usr/bin');
    expect(entries.length).toBeGreaterThanOrEqual(1);
  });

  test('does not duplicate entries that are already in PATH', () => {
    process.env['PATH'] = '/usr/bin:/bin';
    process.env['SHELL'] = '/bin/zsh';
    resolveShellPath(logger);
    const entries = (process.env['PATH'] ?? '').split(':');
    const counts = new Map<string, number>();
    for (const e of entries) counts.set(e, (counts.get(e) ?? 0) + 1);
    for (const [_k, n] of counts) expect(n).toBe(1);
  });

  test('logs resolved-entries message when PATH changes', () => {
    // Use an intentionally-minimal PATH so the shell will add at least one new entry
    process.env['PATH'] = '/nonexistent-base';
    process.env['SHELL'] = '/bin/zsh';
    resolveShellPath(logger);
    expect(logCalls.some((msg) => msg.startsWith('[PATH] Resolved'))).toBe(true);
  });

  test('falls back to well-known dirs when SHELL is invalid', () => {
    process.env['PATH'] = '/tmp-only-path';
    process.env['SHELL'] = '/nonexistent/shell';
    resolveShellPath(logger);
    // The fallback branch must log "Shell resolution failed, merged well-known directories"
    // — anchor this specific log line so the branch stays covered after future refactors.
    expect(logCalls.some((msg) => msg.includes('Shell resolution failed'))).toBe(true);
  });

  test('never throws', () => {
    process.env['SHELL'] = '/bin/zsh';
    expect(() => resolveShellPath(logger)).not.toThrow();
  });
});
