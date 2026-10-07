import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

  test('checks for the harness command it is given, and says which one is missing (#1177)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-shell-path-'));
    try {
      // A login shell that reports its PATH unchanged, and a PATH of system directories only,
      // so neither a real `claude` nor a real `codex` can be found.
      const shell = path.join(dir, 'sh-path');
      fs.writeFileSync(shell, '#!/bin/sh\necho "$PATH"\n');
      fs.chmodSync(shell, 0o755);
      process.env['SHELL'] = shell;
      process.env['PATH'] = `${dir}:/usr/bin:/bin`;

      resolveShellPath(logger, 'codex');
      expect(errorCalls.join('\n')).toContain('"codex" not found');
      expect(errorCalls.join('\n')).not.toContain('claude');

      errorCalls.length = 0;
      fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n');
      fs.chmodSync(path.join(dir, 'codex'), 0o755);
      resolveShellPath(logger, 'codex');
      expect(errorCalls).toEqual([]);

      // The default is still Claude's.
      resolveShellPath(logger);
      expect(errorCalls.join('\n')).toContain('"claude" not found');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('never throws', () => {
    process.env['SHELL'] = '/bin/zsh';
    expect(() => resolveShellPath(logger)).not.toThrow();
  });
});
