/**
 * Characterization of how a store that holds a non-Claude record behaves
 * BEFORE the Codex foundations (epic #1175, phase 2 #1176) make the reads
 * harness-aware. Written and passed against the unmodified source.
 *
 * ADR 0032 (consequences) and #1165 section D name the hazard: `--resume`,
 * `--sessions` and `getMostRecent` read only `claudeSessionId`, so the first
 * record written with `harness: 'codex'` is reachable through paths that mean
 * Claude. These pins state today's behavior so the change that closes the
 * hazard has to move them on purpose, not by accident.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import { SessionStore, type StoredSession } from '../../src/session/session-store.ts';
import { CLI_TS, isolatedEnv } from '../integration/hub-test-utils.ts';

const CODEX_REMI_ID = 'cccccccc-1111-4111-8111-cccccccccccc' as UUID;
const CLAUDE_REMI_ID = 'dddddddd-2222-4222-8222-dddddddddddd' as UUID;
const THREAD_ID = '00000000-0000-7000-8000-000000000001';
const CLAUDE_ID = '11111111-2222-4333-8444-555555555555';

/**
 * `hoursAgo` hours before now, as an ISO timestamp. Relative on purpose: the
 * store purges exited records older than seven days when it lists them, so a
 * fixed date would make these tests fail a week after they were written.
 */
function ago(hoursAgo: number): string {
  return new Date(Date.now() - hoursAgo * 3_600_000).toISOString();
}

function record(overrides: Partial<StoredSession>): StoredSession {
  return {
    remiSessionId: CLAUDE_REMI_ID,
    claudeSessionId: null,
    projectPath: '/tmp',
    port: 19999,
    pid: null,
    startedAt: ago(3),
    exitedAt: ago(2.9),
    exitCode: 0,
    ...overrides,
  };
}

const codexRecord = record({
  remiSessionId: CODEX_REMI_ID,
  harness: 'codex',
  harnessSessionId: THREAD_ID,
  startedAt: ago(2),
  exitedAt: ago(1.9),
});
const claudeRecord = record({ claudeSessionId: CLAUDE_ID });

describe('a store holding a codex record, before harness-aware reads (#1176 pin)', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-mixed-store-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('getMostRecent() returns the codex record, whose claudeSessionId is null', () => {
    const store = new SessionStore(path.join(dir, 'sessions.json'));
    store.save(claudeRecord);
    store.save(codexRecord);

    const recent = store.getMostRecent();

    expect(recent?.remiSessionId).toBe(CODEX_REMI_ID);
    expect(recent?.harness).toBe('codex');
    expect(recent?.claudeSessionId).toBeNull();
  });

  /** Run the real `cli.ts` in an isolated HOME whose store holds `sessions`. */
  async function runCli(
    sessions: StoredSession[],
    args: string[],
  ): Promise<{ code: number; stderr: string; stdout: string }> {
    const home = path.join(dir, 'home');
    const work = path.join(dir, 'work');
    fs.mkdirSync(path.join(home, '.remi'), { recursive: true });
    fs.mkdirSync(work, { recursive: true });
    // If a change ever lets --resume go on to launch, it must find only this
    // fake `claude` (exits at once), never the developer's real one.
    const fakeBin = path.join(dir, 'fake-bin');
    fs.mkdirSync(fakeBin, { recursive: true });
    fs.writeFileSync(path.join(fakeBin, 'claude'), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(fakeBin, 'claude'), 0o755);
    fs.writeFileSync(
      path.join(home, '.remi', 'sessions.json'),
      JSON.stringify({ version: 1, sessions }),
    );
    const proc = Bun.spawn([process.execPath, CLI_TS, ...args], {
      cwd: work,
      env: isolatedEnv(home, { PATH: `${fakeBin}:/usr/bin:/bin` }),
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 20000,
    });
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code, stderr, stdout };
  }

  test('--resume of the codex record by remi id errors "no Claude session ID"', async () => {
    const result = await runCli([codexRecord], ['--resume', CODEX_REMI_ID.slice(0, 8)]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('has no Claude session ID');
  }, 30000);

  test('bare --resume picks the newest record even when it is the codex one', async () => {
    const result = await runCli([claudeRecord, codexRecord], ['--resume']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(
      `Session ${CODEX_REMI_ID.slice(0, 8)} has no Claude session ID`,
    );
  }, 30000);

  test('--sessions prints the codex record with no harness label at all', async () => {
    const result = await runCli([codexRecord], ['--sessions', 'all']);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain(CODEX_REMI_ID.slice(0, 8));
    expect(result.stdout).not.toContain('codex');
    expect(result.stdout).not.toContain(THREAD_ID.slice(0, 8));
  }, 30000);
});
