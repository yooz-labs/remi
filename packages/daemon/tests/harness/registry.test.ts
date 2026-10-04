/**
 * `HarnessRegistry` (#1179): which harnesses a daemon offers. Availability is
 * that the command resolves on the PATH the process has NOW, and the command is
 * never run to find out.
 *
 * Real executables in a temp directory, and the real `process.env.PATH`, which
 * each test points at that directory and restores. Nothing is replaced.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { HarnessRegistry } from '../../src/harness/registry.ts';
import type { HarnessSpec } from '../../src/harness/registry.ts';

const spec = (command: string): HarnessSpec => ({
  command,
  validateRemoteArgs: () => ({ ok: true, args: [] }),
});

describe('HarnessRegistry.available (#1179)', () => {
  let dir: string;
  let savedPath: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-registry-'));
    savedPath = process.env['PATH'];
  });

  afterEach(() => {
    process.env['PATH'] = savedPath ?? '';
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function install(name: string, body = '#!/bin/sh\n', mode = 0o755): void {
    fs.writeFileSync(path.join(dir, name), body);
    fs.chmodSync(path.join(dir, name), mode);
  }

  const registry = () => new HarnessRegistry({ claude: spec('claude'), codex: spec('codex') });

  test('offers each harness whose command is on PATH, in the order HARNESS_IDS names them', () => {
    install('codex');
    install('claude');
    process.env['PATH'] = dir;
    expect(registry().available()).toEqual(['claude', 'codex']);
  });

  test('offers only what is installed', () => {
    install('codex');
    process.env['PATH'] = dir;
    expect(registry().available()).toEqual(['codex']);
    fs.rmSync(path.join(dir, 'codex'));
    install('claude');
    expect(registry().available()).toEqual(['claude']);
    fs.rmSync(path.join(dir, 'claude'));
    expect(registry().available()).toEqual([]);
  });

  test('reads the PATH as it is now, not as the process started with it', () => {
    // `Bun.which` alone ignores a change to process.env.PATH made after startup, and every
    // daemon makes one at boot (`resolveShellPath`).
    process.env['PATH'] = '/usr/bin:/bin';
    const before = registry().available();
    expect(before).not.toContain('codex');
    install('codex');
    process.env['PATH'] = `${dir}:/usr/bin:/bin`;
    expect(registry().available()).toContain('codex');
  });

  test('a file that is not executable, and a directory of that name, are not offered', () => {
    install('codex', '#!/bin/sh\n', 0o644);
    fs.mkdirSync(path.join(dir, 'claude'));
    process.env['PATH'] = dir;
    expect(registry().available()).toEqual([]);
  });

  test('never runs the command to find out', () => {
    const marker = path.join(dir, 'ran');
    install('codex', `#!/bin/sh\necho ran > '${marker}'\n`);
    process.env['PATH'] = dir;
    expect(registry().available()).toEqual(['codex']);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test('a harness with no spec is not offered even when its command exists, and has none to get', () => {
    install('codex');
    install('claude');
    install('opencode');
    process.env['PATH'] = dir;
    const claudeOnly = new HarnessRegistry({ claude: spec('claude') });
    expect(claudeOnly.available()).toEqual(['claude']);
    expect(claudeOnly.get('codex')).toBeUndefined();
    expect(claudeOnly.get('opencode')).toBeUndefined();
    expect(claudeOnly.get('claude')?.command).toBe('claude');
  });
});
