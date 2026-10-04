/**
 * Harness-aware reads of a store that holds a non-Claude record (epic #1175,
 * phase 2 #1176; the second half of #1165 D).
 *
 * `--resume`, `--sessions` and `getMostRecent` used to read only
 * `claudeSessionId`, so the first record written with `harness: 'codex'` was
 * reachable through paths that mean Claude. This file began as the
 * characterization of that behavior (written and passed against the
 * unmodified source: `getMostRecent()` returned the Codex record, `--resume`
 * of it said "no Claude session ID", `--sessions` printed no harness label)
 * and its assertions moved on purpose when the reads became harness-aware.
 * `getMostRecent()` without a filter still returns the newest record of any
 * harness, which the first test keeps pinned.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import {
  SessionHarnessMismatchError,
  SessionStore,
  type StoredSession,
  resolveStoredSession,
} from '../../src/session/session-store.ts';
import { CLI_TS, isolatedEnv } from '../integration/hub-test-utils.ts';

const CODEX_REMI_ID = 'cccccccc-1111-4111-8111-cccccccccccc' as UUID;
const CLAUDE_REMI_ID = 'dddddddd-2222-4222-8222-dddddddddddd' as UUID;
const FUTURE_REMI_ID = 'eeeeeeee-3333-4333-8333-eeeeeeeeeeee' as UUID;
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
/** A record naming a harness this build does not know, newer than both. */
const futureRecord = record({
  remiSessionId: FUTURE_REMI_ID,
  harness: 'from-a-newer-daemon',
  harnessSessionId: 'x-1',
  startedAt: ago(1),
  exitedAt: ago(0.9),
});

describe('getMostRecent(harness)', () => {
  let dir: string;
  let store: SessionStore;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-most-recent-'));
    store = new SessionStore(path.join(dir, 'sessions.json'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('without a filter it is still the newest record of any harness', () => {
    store.save(claudeRecord);
    store.save(codexRecord);

    expect(store.getMostRecent()?.remiSessionId).toBe(CODEX_REMI_ID);
  });

  test('claude skips a newer codex record, and a record of a harness this build does not know', () => {
    store.save(claudeRecord);
    store.save(codexRecord);
    store.save(futureRecord);

    expect(store.getMostRecent('claude')?.remiSessionId).toBe(CLAUDE_REMI_ID);
  });

  test('codex returns the newest codex record', () => {
    store.save(claudeRecord);
    store.save(codexRecord);

    expect(store.getMostRecent('codex')?.remiSessionId).toBe(CODEX_REMI_ID);
  });

  test('a harness with no record is null', () => {
    store.save(codexRecord);

    expect(store.getMostRecent('claude')).toBeNull();
    expect(store.getMostRecent('opencode')).toBeNull();
  });

  test('a record that names claude explicitly counts as Claude', () => {
    store.save(record({ claudeSessionId: CLAUDE_ID, harness: 'claude' }));

    expect(store.getMostRecent('claude')?.claudeSessionId).toBe(CLAUDE_ID);
  });
});

describe('resolveStoredSession(sessions, query, { harness })', () => {
  test('a codex record found by exact remi id is a mismatch for claude, and the message names the command that resumes it', () => {
    let error: unknown;
    try {
      resolveStoredSession([codexRecord], CODEX_REMI_ID, { harness: 'claude' });
    } catch (err) {
      error = err;
    }

    expect(error).toBeInstanceOf(SessionHarnessMismatchError);
    // The whole thread id, which `remi codex resume` needs and `--sessions` shortens to its last eight characters.
    expect((error as SessionHarnessMismatchError).message).toBe(
      `this session ran under codex; resume it with \`remi codex resume ${THREAD_ID}\``,
    );
  });

  test('a thread id that is not one word is quoted in the pointer, never printed raw (R3)', () => {
    const odd = record({ ...codexRecord, harnessSessionId: 'x; touch /tmp/pwned' });
    expect(() => resolveStoredSession([odd], CODEX_REMI_ID, { harness: 'claude' })).toThrow(
      "this session ran under codex; resume it with `remi codex resume 'x; touch /tmp/pwned'`",
    );
  });

  test('a codex record that never learned its thread id points at nothing: there is nothing to resume', () => {
    const unnamed = record({ ...codexRecord, harnessSessionId: null });
    expect(() => resolveStoredSession([unnamed], CODEX_REMI_ID, { harness: 'claude' })).toThrow(
      'this session ran under codex; this build cannot resume it',
    );
  });

  test('the same by a unique remi id prefix', () => {
    expect(() =>
      resolveStoredSession([claudeRecord, codexRecord], CODEX_REMI_ID.slice(0, 8), {
        harness: 'claude',
      }),
    ).toThrow(SessionHarnessMismatchError);
  });

  test('a record of a harness this build does not know gets the same message, naming that harness', () => {
    expect(() =>
      resolveStoredSession([futureRecord], FUTURE_REMI_ID, { harness: 'claude' }),
    ).toThrow('this session ran under from-a-newer-daemon; this build cannot resume it');
  });

  test('a claude record by remi id or by claude id still resolves for claude', () => {
    const sessions = [claudeRecord, codexRecord];
    expect(
      resolveStoredSession(sessions, CLAUDE_REMI_ID, { harness: 'claude' })?.remiSessionId,
    ).toBe(CLAUDE_REMI_ID);
    expect(resolveStoredSession(sessions, CLAUDE_ID, { harness: 'claude' })?.remiSessionId).toBe(
      CLAUDE_REMI_ID,
    );
  });

  test('a claude id never matches a non-Claude record, even one that carries a claudeSessionId', () => {
    const odd = record({ ...codexRecord, claudeSessionId: CLAUDE_ID });
    expect(resolveStoredSession([odd], CLAUDE_ID, { harness: 'claude' })).toBeNull();
    expect(resolveStoredSession([odd], CLAUDE_ID)).toBeNull();
  });

  test('the harness option is Claude-only: another harness does not compile, and a cast around it is refused', () => {
    // @ts-expect-error resolveStoredSession resumes Claude records only (#1179 removed the other branch)
    const lookup = () => resolveStoredSession([claudeRecord], CLAUDE_ID, { harness: 'codex' });
    expect(lookup).toThrow('resolves claude sessions only');
  });

  test('without a harness a remi id resolves whatever its record ran under', () => {
    expect(resolveStoredSession([codexRecord], CODEX_REMI_ID)?.remiSessionId).toBe(CODEX_REMI_ID);
  });
});

describe('the real CLI over a store that holds a codex record', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-cli-reads-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
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

  /** A stderr with its colors removed, as the exact text a user reads. */
  const plain = (stderr: string) => stderr.replace(/\x1b\[[0-9;]*m/g, '').trim();

  test('--resume of the codex record by remi id exits 1 with exactly the mismatch message', async () => {
    const result = await runCli([codexRecord], ['--resume', CODEX_REMI_ID.slice(0, 8)]);
    expect(result.code).toBe(1);
    // The message itself, whole and last, and not the "Could not read stored
    // sessions: ..." a CLI that dropped the mismatch arm would print. (Not the
    // whole of stderr: a developer's own REMI_* variables add warning lines
    // above it.)
    const lines = plain(result.stderr).split('\n');
    expect(lines.at(-1)).toBe(
      `this session ran under codex; resume it with \`remi codex resume ${THREAD_ID}\``,
    );
    expect(plain(result.stderr)).not.toContain('Could not read stored sessions');
  }, 30000);

  test('bare --resume does not pick a codex record: with only one in the store there is nothing to resume', async () => {
    const result = await runCli([codexRecord], ['--resume']);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('No sessions to resume');
    expect(result.stderr).not.toContain('has no Claude session ID');
  }, 30000);

  test('--sessions labels each record with its harness and a short form of its id: the first 8 characters for Claude, the last 8 for Codex', async () => {
    const unnamed = record({
      remiSessionId: crypto.randomUUID() as UUID,
      harness: 'codex',
      harnessSessionId: null,
    });
    const result = await runCli(
      [claudeRecord, codexRecord, futureRecord, unnamed],
      ['--sessions', 'all'],
    );
    expect(result.code).toBe(0);
    const line = (remiId: string) =>
      result.stdout.split('\n').find((l) => l.includes(remiId.slice(0, 8))) ?? '';
    expect(line(CLAUDE_REMI_ID)).toContain(` claude:${CLAUDE_ID.slice(0, 8)} `);
    expect(line(CODEX_REMI_ID)).toContain(` codex:${THREAD_ID.slice(-8)} `);
    expect(line(CODEX_REMI_ID)).not.toContain('claude:');
    expect(line(FUTURE_REMI_ID)).toContain(' from-a-newer-daemon:x-1 ');
    // A codex record with no thread id yet says so, and never reads as an
    // id-less Claude record, which has no label at all.
    expect(line(unnamed.remiSessionId)).toContain(' codex:- ');
  }, 30000);

  test('--sessions tells two Codex threads apart whose UUIDv7 ids share their first eight characters (Q2)', async () => {
    // A UUIDv7 begins with a millisecond timestamp, so threads created within about 65 s share
    // their first eight characters; the random part is at the end.
    const first = '01a106f2-2f1c-7a35-9d4e-8b6f1c2d3e4a';
    const second = '01a106f2-40b8-7c91-a2f7-5d9e0b7a6c13';
    expect(first.slice(0, 8)).toBe(second.slice(0, 8));
    const a = record({
      remiSessionId: crypto.randomUUID() as UUID,
      harness: 'codex',
      harnessSessionId: first,
      startedAt: ago(2),
      exitedAt: ago(1.9),
    });
    const b = record({
      remiSessionId: crypto.randomUUID() as UUID,
      harness: 'codex',
      harnessSessionId: second,
      startedAt: ago(1),
      exitedAt: ago(0.9),
    });
    const result = await runCli([a, b], ['--sessions', 'all']);
    expect(result.code).toBe(0);
    const line = (remiId: string) =>
      result.stdout.split('\n').find((l) => l.includes(remiId.slice(0, 8))) ?? '';
    expect(line(a.remiSessionId)).toContain(' codex:1c2d3e4a ');
    expect(line(b.remiSessionId)).toContain(' codex:0b7a6c13 ');
    expect(line(a.remiSessionId)).not.toContain(first.slice(0, 8));
  }, 30000);

  test('--sessions shows the whole thread id of an exited codex session as the command that resumes it', async () => {
    const running = record({
      remiSessionId: crypto.randomUUID() as UUID,
      harness: 'codex',
      harnessSessionId: '00000000-0000-7000-8000-0000000000ee',
      pid: process.pid,
      exitedAt: null,
      exitCode: null,
    });
    const unnamed = record({
      remiSessionId: crypto.randomUUID() as UUID,
      harness: 'codex',
      harnessSessionId: null,
    });
    const result = await runCli(
      [claudeRecord, codexRecord, running, unnamed],
      ['--sessions', 'all'],
    );
    const lines = result.stdout.split('\n');
    const resume = lines.filter((l) => l.includes('remi codex resume'));
    // `remi codex resume` runs Codex in the current directory and the new record takes that
    // directory as its project path, so the line changes into the session's own first (W20).
    expect(resume).toEqual([`      resume: cd /tmp && remi codex resume ${THREAD_ID}`]);
    // It follows its own record's line, and neither a Claude record, a running codex one,
    // nor one with no thread id gets one.
    const at = lines.findIndex((l) => l.includes(CODEX_REMI_ID.slice(0, 8)));
    expect(lines[at + 1]).toBe(resume[0]);
  }, 30000);

  test('the directory in that line is shell-quoted, so pasting it cannot run anything else (W20)', async () => {
    const odd = record({
      ...codexRecord,
      remiSessionId: crypto.randomUUID() as UUID,
      projectPath: "/tmp/my project's $(touch pwned)",
    });
    const result = await runCli([odd], ['--sessions', 'all']);
    const line = result.stdout.split('\n').find((l) => l.includes('remi codex resume'));
    expect(line).toBe(
      `      resume: cd '/tmp/my project'\\''s $(touch pwned)' && remi codex resume ${THREAD_ID}`,
    );
  }, 30000);

  test('a Claude record with no Claude id yet prints no label, as before', async () => {
    const noId = record({ remiSessionId: crypto.randomUUID() as UUID });
    const result = await runCli([noId], ['--sessions', 'all']);
    const line = result.stdout.split('\n').find((l) => l.includes(noId.remiSessionId.slice(0, 8)));
    expect(line).not.toMatch(/ (claude|codex):/);
  }, 30000);
});
