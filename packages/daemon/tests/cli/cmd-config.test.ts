import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runConfigCommand } from '../../src/cli/cmd-config.ts';
import { DEFAULT_CONFIG } from '../../src/config/index.ts';

function makeIO() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (msg: string) => out.push(msg),
      err: (msg: string) => err.push(msg),
    },
    out,
    err,
  };
}

describe('runConfigCommand', () => {
  let sandbox: string;
  let sandboxConfigPath: string;

  beforeEach(() => {
    sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cmd-config-'));
    sandboxConfigPath = path.join(sandbox, 'config.toml');
  });

  afterEach(() => {
    fs.rmSync(sandbox, { recursive: true, force: true });
  });

  test("'path' prints the overridden config path and exits 0", () => {
    const { io, out, err } = makeIO();
    const code = runConfigCommand('path', DEFAULT_CONFIG, io, {
      configPath: sandboxConfigPath,
    });
    expect(code).toBe(0);
    expect(out).toEqual([sandboxConfigPath]);
    expect(err).toHaveLength(0);
  });

  test("undefined arg ('show') prints formatted config and exits 0", () => {
    const { io, out, err } = makeIO();
    const code = runConfigCommand(undefined, DEFAULT_CONFIG, io, {
      configPath: sandboxConfigPath,
    });
    expect(code).toBe(0);
    expect(out).toHaveLength(1);
    expect(out[0]).toContain('auto_approve');
    expect(err).toHaveLength(0);
  });

  test("'init' creates the config file at the overridden path and exits 0", () => {
    const { io, out, err } = makeIO();
    const code = runConfigCommand('init', DEFAULT_CONFIG, io, {
      configPath: sandboxConfigPath,
    });
    expect(code).toBe(0);
    expect(out.some((m) => m.includes('Config file created'))).toBe(true);
    expect(err).toHaveLength(0);
    expect(fs.existsSync(sandboxConfigPath)).toBe(true);
  });

  test("'init' reports error and exits 1 when initConfigFile throws", () => {
    // Point at an unwritable location (a path whose parent is a regular file).
    const blocker = path.join(sandbox, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');
    const bad = path.join(blocker, 'nope', 'config.toml');

    const { io, out, err } = makeIO();
    const code = runConfigCommand('init', DEFAULT_CONFIG, io, { configPath: bad });
    expect(code).toBe(1);
    expect(err.length).toBeGreaterThan(0);
    expect(out).toHaveLength(0);
  });
});
