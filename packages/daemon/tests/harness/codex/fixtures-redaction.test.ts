/**
 * The Codex fixture redaction contract (epic #1175, phase 1 #1181).
 *
 * Three things are proven here, each able to fail on its own claim:
 * 1. the committed fixtures pass the allowlist scan and are internally
 *    consistent with `index.json`;
 * 2. the scan itself catches a seeded leak for every rule it has, and does not
 *    flag what the fixtures legitimately contain;
 * 3. the extractor (`scripts/extract-codex-fixtures.ts`) redacts a synthetic
 *    raw log it was never tuned on, is deterministic, and refuses to write
 *    anything when a leak survives its rules.
 */
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { hostname, tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FIXTURE_DIR,
  LEAK_RULES,
  loadFixtureFrames,
  placeholderUuid,
  readFixtureIndex,
  readFixtureText,
  scanForLeaks,
} from '../../helpers/codex-fixtures.ts';

const EXTRACTOR = resolve(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  '..',
  'scripts',
  'extract-codex-fixtures.ts',
);
const fixtureFiles = (): string[] => readdirSync(FIXTURE_DIR).sort();

describe('the committed fixtures', () => {
  test('pass the redaction scan: no leak in any file', () => {
    const files = fixtureFiles();
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) {
      expect(scanForLeaks(readFixtureText(file)), file).toEqual([]);
    }
  });

  test('index.json lists exactly the fixture files, with real counts and provenance', () => {
    const index = readFixtureIndex();
    expect(index.cliVersion).toBe('0.160.0');
    expect(index.extractorVersion).toBeGreaterThanOrEqual(1);
    expect(index.files.map((f) => f.file).sort()).toEqual(
      fixtureFiles().filter((f) => f !== 'index.json'),
    );
    for (const entry of index.files) {
      expect(loadFixtureFrames(entry.file), entry.file).toHaveLength(entry.frames);
      expect(entry.frames, entry.file).toBeGreaterThan(0);
      if (entry.label === 'real') {
        expect(entry.sourceSha256, entry.file).toMatch(/^[0-9a-f]{64}$/);
        expect(entry.source, entry.file).toBe(entry.file);
      } else {
        expect(['report-derived', 'synthetic-from-schema']).toContain(entry.label);
        expect(entry.sourceSha256, entry.file).toBeUndefined();
      }
    }
  });

  test('every frame is {client, dir, frame}, real frames carry their source line', () => {
    for (const entry of readFixtureIndex().files) {
      for (const f of loadFixtureFrames(entry.file)) {
        expect(typeof f.client).toBe('string');
        expect(['in', 'out']).toContain(f.dir);
        expect(typeof f.frame).toBe('object');
        if (entry.label === 'real') expect(Number.isInteger(f.line), entry.file).toBe(true);
      }
    }
  });

  test('keep the frames the plan names: approval requests, the title helper, a replay, a question', () => {
    const methods = new Set<string>();
    for (const entry of readFixtureIndex().files) {
      for (const f of loadFixtureFrames(entry.file)) {
        if (typeof f.frame['method'] === 'string') methods.add(f.frame['method']);
      }
    }
    for (const method of [
      'item/commandExecution/requestApproval',
      'item/tool/requestUserInput',
      'serverRequest/resolved',
      'thread/started',
      'thread/status/changed',
      'thread/closed',
      'turn/completed',
      'item/fileChange/requestApproval',
      'item/permissions/requestApproval',
      'mcpServer/elicitation/request',
    ]) {
      expect(methods, method).toContain(method);
    }
    // And none of what the plan drops.
    for (const dropped of ['configWarning', 'account/updated', 'thread/tokenUsage/updated']) {
      expect(methods, dropped).not.toContain(dropped);
    }
    for (const m of methods) expect(m.startsWith('mcpServer/startupStatus'), m).toBe(false);
  });
});

describe('the scan catches what it names', () => {
  /** A seeded leak per static rule, as text a real fixture could plausibly be made to contain. */
  const SEEDS: Record<string, string> = {
    'absolute-path': '/etc/hosts',
    uuid: '01a0fe44-47ef-78f0-9607-16ac4ed9198e',
    'users-path': '/Users/someone/.codex',
    'private-path': '/private/tmp/scratch',
    'var-folders': '/var/folders/zz/T/x',
    'home-path': '/home/someone/project',
    'terminal-emulator': 'ghostty/1.3.1',
    'install-id': 'installationId',
    'plan-type': 'planType',
    jwt: 'eyJhbGciOiJIUzI1NiJ9',
    bearer: 'Bearer abc123',
    'api-key': 'sk-proj-abc',
    auth: 'authMode',
    token: 'tokenUsage',
    'email-or-handle': 'someone@example.test',
    'opaque-id': 'msg_0123456789abcdef',
  };
  /** The text of one real fixture with `seed` appended to a free-text field. */
  const withSeed = (seed: string): string =>
    readFixtureText('expA-accept.jsonl').replace(
      '"command":"/bin/zsh -c ',
      `"command":"${seed} /bin/zsh -c `,
    );

  test('the seed table covers every static rule, so a new rule cannot ship without one', () => {
    expect(Object.keys(SEEDS).sort()).toEqual([...LEAK_RULES].sort());
  });

  for (const [rule, seed] of Object.entries(SEEDS)) {
    test(`flags ${rule}`, () => {
      expect(scanForLeaks(withSeed(seed)).map((f) => f.rule)).toContain(rule);
    });
  }

  test('flags the current user name and host name when they are long enough to be a signal', () => {
    const user = userInfo().username;
    const host = hostname().split('.')[0] ?? '';
    if (user.length >= 3) {
      expect(scanForLeaks(withSeed(`owner ${user} here`)).map((f) => f.rule)).toContain('username');
    }
    if (host.length >= 3) {
      expect(scanForLeaks(withSeed(`on ${host} here`)).map((f) => f.rule)).toContain('hostname');
    }
  });

  test('a real fixture with a raw path swapped in for its placeholder is flagged', () => {
    const leaked = readFixtureText('expA-accept.jsonl').replace(
      '/work/project',
      '/Users/someone/project',
    );
    expect(scanForLeaks(leaked).map((f) => f.rule)).toContain('users-path');
  });

  test('an unredacted thread id is flagged, a placeholder is not', () => {
    expect(scanForLeaks(`"id":"${placeholderUuid(7)}"`)).toEqual([]);
    expect(scanForLeaks('"id":"01a0fe44-47ef-78f0-9607-16ac4ed9198e"').map((f) => f.rule)).toEqual([
      'uuid',
    ]);
  });

  test('does not flag what a fixture legitimately contains', () => {
    const clean = [
      '"cwd":"/work/project"',
      '"path":"/work/codex-home/sessions/rollout-T1.jsonl"',
      '"command":"/bin/zsh -lc \'touch marker\'"',
      '"method":"item/commandExecution/requestApproval"',
      '"status":"waitingOnApproval","a/b":"1/2"',
      '"threadId":"00000000-0000-7000-8000-000000000001"',
    ].join(',');
    expect(scanForLeaks(clean)).toEqual([]);
  });
});

describe('the extractor', () => {
  const HOME = '/Users/jdoe/.codex';
  const PROJECT = '/private/tmp/jdoe-scratch/work';

  const threadId = (n: number): string =>
    `01a0fe44-47ef-78f0-9607-16ac4ed9${String(n).padStart(4, '0')}`;

  /** A raw capture of invented frames in the spike's log format, full of the things that must not survive. */
  function rawLog(thread: string, extra: Record<string, unknown>[] = []): string {
    const rec = (client: string, dir: string, frame: Record<string, unknown>): string =>
      JSON.stringify({ t: 0, client, dir, frame });
    const rollout = `${HOME}/sessions/2026/10/02/rollout-2026-10-02T13-18-02-${thread}.jsonl`;
    return `${[
      rec('A', 'out', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'remi-spike' } },
      }),
      rec('A', 'in', {
        id: 1,
        result: {
          userAgent: 'remi-spike/0.160.0 (Mac OS 27.0.0; arm64) ghostty/1.3.1 (remi-spike; 0.0.0)',
          codexHome: HOME,
          platformFamily: 'unix',
          platformOs: 'macos',
        },
      }),
      rec('A', 'in', {
        method: 'remoteControl/status/changed',
        params: {
          status: 'ok',
          serverName: 'jdoe-laptop',
          installationId: '11111111-2222-4333-8444-555555555555',
        },
      }),
      rec('A', 'in', {
        method: 'thread/started',
        params: {
          thread: {
            id: thread,
            sessionId: thread,
            path: rollout,
            cwd: PROJECT,
            model: 'secret-model-1',
            gitInfo: { branch: 'private-branch', originUrl: 'git@example.test:jdoe/private.git' },
            createdAt: 1790972282,
            account: { planType: 'plus', serverName: 'jdoe-laptop' },
          },
        },
        emittedAtMs: 1790972282935,
      }),
      rec('A', 'in', {
        method: 'item/commandExecution/requestApproval',
        id: 7,
        params: {
          threadId: thread,
          itemId: 'exec-3a797c8c-57d9-4c4c-86de-5f341ea70cc3',
          command: `/bin/zsh -c 'cd ${PROJECT} && touch marker'`,
          cwd: PROJECT,
          startedAtMs: 1790972287601,
        },
      }),
      rec('A', 'in', {
        method: 'item/completed',
        params: {
          item: { type: 'reasoning', id: 'rs_0123456789abcdef', summary: ['thinking about jdoe'] },
          threadId: thread,
          completedAtMs: 1790972287700,
        },
      }),
      rec('A', 'in', {
        method: 'item/completed',
        params: {
          item: {
            type: 'agentMessage',
            id: 'msg_0123456789abcdef',
            text: 'done',
            phase: 'final_answer',
          },
          threadId: thread,
          completedAtMs: 1790972287800,
        },
      }),
      rec('A', 'out', { jsonrpc: '2.0', id: 7, result: { decision: 'accept' } }),
      ...extra.map((frame) => rec('A', 'in', frame)),
    ].join('\n')}\n`;
  }

  /** The six raw files the extractor reads; `expFlags` keeps only its line 11, so line 11 is a `thread/started`. */
  function writeRawDir(dir: string, extra: Record<string, unknown>[] = []): void {
    mkdirSync(dir, { recursive: true });
    const names = ['expA-accept', 'expA-decline', 'expB', 'expB3', 'expC'];
    names.forEach((name, i) => {
      writeFileSync(join(dir, `${name}.jsonl`), rawLog(threadId(i), i === 0 ? extra : []));
    });
    const warning = JSON.stringify({
      t: 0,
      client: 'O',
      dir: 'in',
      frame: { method: 'warning', params: {} },
    });
    const started = JSON.stringify({
      t: 0,
      client: 'O',
      dir: 'in',
      frame: {
        method: 'thread/started',
        params: { thread: { id: threadId(9), cwd: PROJECT, environments: [{ cwd: PROJECT }] } },
        emittedAtMs: 1790972282000,
      },
    });
    writeFileSync(
      join(dir, 'expFlags.jsonl'),
      `${[...Array(10).fill(warning), started].join('\n')}\n`,
    );
  }

  function run(rawDir: string, outDir: string) {
    const proc = Bun.spawnSync([process.execPath, EXTRACTOR, rawDir, '--out', outDir], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString() };
  }

  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'remi-extractor-'));
  }

  test('redacts a raw log it was never tuned on, and the result passes the scan', () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      const result = run(join(base, 'raw'), join(base, 'out'));
      expect(result.code, result.err).toBe(0);
      const files = readdirSync(join(base, 'out'));
      expect(files).toContain('index.json');
      const accept = readFileSync(join(base, 'out', 'expA-accept.jsonl'), 'utf8');
      for (const file of files) {
        expect(scanForLeaks(readFileSync(join(base, 'out', file), 'utf8')), file).toEqual([]);
      }
      // What it must have rewritten.
      expect(accept).toContain('"cwd":"/work/project"');
      expect(accept).toContain('"codexHome":"/work/codex-home"');
      expect(accept).toContain('/work/codex-home/sessions/rollout-T1.jsonl');
      // A different thread gets a different rollout placeholder.
      expect(readFileSync(join(base, 'out', 'expA-decline.jsonl'), 'utf8')).toContain(
        'rollout-T2.jsonl',
      );
      expect(accept).toContain('"model":"test-model"');
      expect(accept).toContain('"userAgent":"remi/0.160.0 (test)"');
      expect(accept).toContain('"gitInfo":null');
      expect(accept).toContain(placeholderUuid(1));
      expect(accept).toContain('msg-id-');
      // What it must have dropped, and what it must not have invented.
      for (const gone of [
        'jdoe',
        'remoteControl',
        'reasoning',
        'rs_',
        'secret-model',
        'private-branch',
        'installationId',
        'planType',
        'serverName',
      ]) {
        expect(accept, gone).not.toContain(gone);
      }
      const frames = accept
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l) as { frame: { method?: string } });
      expect(frames.map((f) => f.frame.method ?? 'result')).toEqual([
        'result',
        'thread/started',
        'item/commandExecution/requestApproval',
        'item/completed',
        'result',
      ]);
      // Time moved to a fixed base but kept its spacing.
      expect(accept).toContain('"createdAt":1700000000');
      expect(accept).toContain('"startedAtMs":1700000004666');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('records the sha256 of each source it read', () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      expect(run(join(base, 'raw'), join(base, 'out')).code).toBe(0);
      const index = JSON.parse(readFileSync(join(base, 'out', 'index.json'), 'utf8')) as {
        files: Array<{ file: string; sourceSha256?: string }>;
      };
      const entry = index.files.find((f) => f.file === 'expB.jsonl');
      const expected = createHash('sha256')
        .update(readFileSync(join(base, 'raw', 'expB.jsonl')))
        .digest('hex');
      expect(entry?.sourceSha256).toBe(expected);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('the same inputs give byte-identical output', () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      expect(run(join(base, 'raw'), join(base, 'one')).code).toBe(0);
      expect(run(join(base, 'raw'), join(base, 'two')).code).toBe(0);
      expect(readdirSync(join(base, 'one')).sort()).toEqual(readdirSync(join(base, 'two')).sort());
      for (const file of readdirSync(join(base, 'one'))) {
        expect(readFileSync(join(base, 'two', file), 'utf8'), file).toBe(
          readFileSync(join(base, 'one', file), 'utf8'),
        );
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('refuses to write when a leak survives its rules (free text naming a home path)', () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'), [
        {
          method: 'item/completed',
          params: {
            item: {
              type: 'agentMessage',
              id: 'msg_aaaaaaaaaaaa',
              text: 'saved to /Users/jdoe/Documents/notes.txt',
            },
            threadId: threadId(50),
            completedAtMs: 1790972287900,
          },
        },
      ]);
      const result = run(join(base, 'raw'), join(base, 'out'));
      expect(result.code).toBe(1);
      expect(result.err).toContain('LEAK');
      expect(result.err).toContain('nothing written');
      expect(existsSync(join(base, 'out'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('exits 2 with a usage line when given no input directory, and on a missing source file', () => {
    const base = scratch();
    try {
      const none = Bun.spawnSync([process.execPath, EXTRACTOR], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { ...process.env, CODEX_SPIKE_DIR: '' },
      });
      expect(none.exitCode).toBe(2);
      expect(none.stderr.toString()).toContain('usage');
      mkdirSync(join(base, 'empty'));
      const missing = run(join(base, 'empty'), join(base, 'out'));
      expect(missing.code).toBe(2);
      expect(missing.err).toContain('extraction failed');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
