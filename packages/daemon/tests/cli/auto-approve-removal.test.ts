/**
 * What a user with an old habit, script or config sees after the
 * auto-approve removal (#1125, ADR 0030). Spawns the REAL cli.ts in an
 * isolated $HOME so the exit code and stderr are the ones a shell sees.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { MODEL_COMMAND_REMOVED_MESSAGE } from '../../src/cli/auto-approve-removal.ts';
import { CLI_TS, isolatedEnv } from '../integration/hub-test-utils.ts';

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-aa-removal-'));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

async function runCli(args: readonly string[]): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn(['bun', CLI_TS, ...args], {
    cwd: home,
    env: isolatedEnv(home),
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

describe('remi model (removed)', () => {
  test('explains the removal on one line and exits 2, whatever the verb', async () => {
    for (const args of [['model'], ['model', 'pull', 'YoozLabs/x'], ['model', 'ls', '--all']]) {
      const { code, stderr } = await runCli(args);
      expect(code).toBe(2);
      expect(stderr.trim()).toBe(MODEL_COMMAND_REMOVED_MESSAGE);
    }
  });

  test('the message is a single line', () => {
    expect(MODEL_COMMAND_REMOVED_MESSAGE.includes('\n')).toBe(false);
  });
});
