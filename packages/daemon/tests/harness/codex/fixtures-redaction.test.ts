/**
 * The Codex fixture redaction contract (epic #1175, phase 1 #1181).
 *
 * The repository is public and the fixtures come from a real session, so three things are proven
 * here, each able to fail on its own claim:
 * 1. the committed fixtures pass the structural scan and are consistent with `index.json`;
 * 2. the scan catches a seeded leak of every kind it names, and does not flag what the fixtures
 *    legitimately hold;
 * 3. the extractor redacts a synthetic raw log it was never tuned on (every value in it invented
 *    here, none taken from a real session), is deterministic, and refuses to write anything when a
 *    leak survives its rules or when free text is not in the reviewed approved set.
 */
import { describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  FIXTURE_DIR,
  loadFixtureFrames,
  placeholderUuid,
  readApprovedFreeText,
  readFixtureIndex,
  readFixtureText,
} from '../../helpers/codex-fixtures.ts';
import {
  FREE_TEXT_KEYS,
  LEAK_RULES,
  type ScanIdentity,
  freeTextOf,
  normalizeFreeText,
  scanForLeaks,
} from '../../helpers/fixture-scan.ts';

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
const SCAN_CHILD = resolve(
  import.meta.dir,
  '..',
  '..',
  'helpers',
  'scan-committed-fixtures-child.ts',
);
const fixtureFiles = (): string[] => readdirSync(FIXTURE_DIR).sort();
const scannedFiles = (): string[] =>
  fixtureFiles().filter((f) => f.endsWith('.jsonl') || f === 'index.json');
const approved = readApprovedFreeText();

describe('the committed fixtures', () => {
  test('pass the redaction scan: no leak in any file, free text only from the approved set', () => {
    expect(scannedFiles().length).toBeGreaterThan(5);
    for (const file of scannedFiles()) {
      expect(scanForLeaks(readFixtureText(file), { approvedFreeText: approved }), file).toEqual([]);
    }
  });

  test('pass the scan under a stripped environment, where the user name is the word "unknown"', async () => {
    // `env -i` leaves no HOME and no USER; os.userInfo().username is then "unknown", which is also a
    // value the fixtures hold (commandActions[].type), so the scan must not treat it as a name.
    const proc = Bun.spawn(['/usr/bin/env', '-i', process.execPath, SCAN_CHILD], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const [out, err, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    expect(code, err).toBe(0);
    expect(JSON.parse(out)).toEqual([]);
  });

  test('every approved free-text string is used by a fixture, and every fixture string is approved', () => {
    const frames = fixtureFiles()
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => loadFixtureFrames(f).map((x) => x.frame));
    const used = new Set(freeTextOf(frames));
    expect([...used].filter((s) => !approved.has(s))).toEqual([]);
    expect([...approved].filter((s) => !used.has(s))).toEqual([]);
  });

  test('index.json lists exactly the fixture files, with real counts and provenance', () => {
    const index = readFixtureIndex();
    expect(index.cliVersion).toBe('0.160.0');
    expect(index.extractorVersion).toBeGreaterThanOrEqual(1);
    expect(index.files.map((f) => f.file).sort()).toEqual(
      fixtureFiles().filter((f) => f !== 'index.json' && f !== 'approved-free-text.json'),
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
  type Frame = Record<string, unknown>;
  /** A frame that is clean: every field a legitimate value, free text only from the approved set. */
  const base = (): Frame => ({
    client: 'A',
    dir: 'in',
    frame: {
      method: 'thread/started',
      params: {
        thread: {
          id: placeholderUuid(1),
          cwd: '/work/project',
          path: '/work/codex-home/sessions/rollout-T1.jsonl',
          model: 'test-model',
          preview: 'done',
          name: null,
          serviceTier: null,
          gitInfo: null,
          instructionSources: [],
          originator: 'remi-spike',
          source: 'vscode',
          cliVersion: '0.160.0',
          createdAt: 1_700_000_000,
          userAgent: 'remi/0.160.0 (test)',
          serverName: 'test-server',
          developer_instructions: null,
          processId: '4242',
          command: 'touch spike-marker-A1',
          text: 'done',
        },
      },
      emittedAtMs: 1_700_000_000_123,
    },
  });

  /** The text of `base()` with one field of `params.thread` set (or added) to `value`. */
  function seeded(
    field: string,
    value: unknown,
    where: 'thread' | 'params' | 'frame' = 'thread',
  ): string {
    const f = base() as { frame: Record<string, unknown> };
    const params = f.frame['params'] as { thread: Record<string, unknown> } & Record<
      string,
      unknown
    >;
    if (where === 'thread') params.thread[field] = value;
    else if (where === 'params') params[field] = value;
    else f.frame[field] = value;
    return `${JSON.stringify(f)}\n`;
  }

  const IDENTITY: ScanIdentity = {
    username: 'jdoe-test',
    homeName: 'jdoe-home',
    host: 'jdoe-host',
  };
  const scan = (text: string) =>
    scanForLeaks(text, { approvedFreeText: approved, identity: IDENTITY });
  const rules = (text: string): string[] => scan(text).map((f) => f.rule);

  /** Each row is one thing that must not get through, as the field it would arrive in. Several rules may fire. */
  const CASES: Array<[name: string, text: () => string, expected: string]> = [
    // Paths in every spelling.
    ['a tilde path', () => seeded('cwd', '~/project'), 'tilde'],
    ['a ~user path', () => seeded('cwd', '~alice/project'), 'tilde'],
    ['a relative path in a path field', () => seeded('cwd', 'project/src'), 'path-field'],
    [
      'a relative path in a command',
      () => seeded('command', 'cat src/lib/x.ts'),
      'unapproved-free-text',
    ],
    ['a file URL', () => seeded('path', 'file:///etc/hosts'), 'url-scheme'],
    ['a colon-glued path', () => seeded('source', 'cwd:/opt/secret'), 'absolute-path'],
    ['a percent-encoded path', () => seeded('source', '%2FUsers%2Fsomeone'), 'percent-encoding'],
    ['a Windows path', () => seeded('cwd', 'C:\\Users\\someone'), 'backslash'],
    ['a UNC path', () => seeded('cwd', '\\\\host\\share\\x'), 'backslash'],
    ['a fullwidth-slash path', () => seeded('cwd', '\uff0fopt\uff0fsecret'), 'bad-char'],
    ['a traversal out of /work', () => seeded('cwd', '/work/../opt/secret'), 'path-field'],
    ['an absolute path outside /work', () => seeded('source', '/etc/hosts'), 'absolute-path'],
    ['a home path', () => seeded('source', '/Users/someone/.codex'), 'users-path'],
    ['a /private path', () => seeded('source', '/private/tmp/scratch'), 'private-path'],
    ['a /var/folders path', () => seeded('source', '/var/folders/zz/T/x'), 'var-folders'],
    ['a /home path', () => seeded('source', '/home/someone/project'), 'home-path'],
    // Identifiers.
    ['a real-shaped UUID', () => seeded('id', randomUUID()), 'uuid'],
    [
      'a 32-hex id with no hyphens',
      () => seeded('itemId', 'exec-0123456789abcdef0123456789abcdef'),
      'long-hex',
    ],
    [
      'an odd-grouped UUID',
      () => seeded('id', '0123456789abcdef-0123-4567-89ab-0123456789ab'),
      'hyphenated-hex-id',
    ],
    ['an id that is not a placeholder', () => seeded('threadId', 'thread-123'), 'id-shape'],
    ['an opaque message id', () => seeded('source', 'msg_0123456789abcdef'), 'opaque-id'],
    [
      'a git SHA',
      () => seeded('source', `${'a'.repeat(7)}0123456789abcdef0123456789abcdef0`),
      'long-hex',
    ],
    [
      'a base64 blob',
      () => seeded('source', Buffer.from('seed '.repeat(12)).toString('base64')),
      'base64-blob',
    ],
    // Credentials and addresses.
    ['a JWT', () => seeded('source', 'eyJhbGciOiJIUzI1NiJ9'), 'jwt'],
    ['a bearer token', () => seeded('source', 'Bearer abc123'), 'bearer'],
    ['an sk- key', () => seeded('source', 'sk-proj-abc'), 'api-key'],
    ['a GitHub token', () => seeded('source', `ghp_${'a'.repeat(36)}`), 'cloud-token'],
    ['an AWS key id', () => seeded('source', 'AKIAABCDEFGHIJKLMNOP'), 'cloud-token'],
    ['a Slack token', () => seeded('source', 'xoxb-123456-abcdef'), 'cloud-token'],
    ['a live payment key', () => seeded('source', 'sk_live_abcdef'), 'cloud-token'],
    ['an auth field name', () => seeded('authMode', 'chatgpt'), 'auth'],
    ['a token field name', () => seeded('tokenUsage', 1), 'token'],
    ['an email address', () => seeded('source', 'someone@example.test'), 'email-or-handle'],
    ['an internal host URL', () => seeded('source', 'http://build.internal/x'), 'internal-host'],
    ['an IPv4 address', () => seeded('source', '10.1.2.3'), 'ipv4'],
    ['a tailnet address', () => seeded('source', '100.101.102.103'), 'ipv4'],
    ['a MAC address', () => seeded('source', 'aa:bb:cc:dd:ee:ff'), 'mac-address'],
    ['a git remote', () => seeded('source', 'git@example.test:owner/repo.git'), 'remote-url'],
    ['a phone number', () => seeded('source', '+1 (555) 010-9999'), 'phone-number'],
    // Free text.
    [
      'a person in free text',
      () => seeded('command', 'echo Alice Johnson'),
      'unapproved-free-text',
    ],
    [
      'prose in a message',
      () => seeded('text', 'Meet me at the usual place at noon'),
      'unapproved-free-text',
    ],
    [
      'prose in a field that should be a token',
      () => seeded('source', 'Alice Johnson lives here'),
      'token-shape',
    ],
    // Fields the plan says must be rewritten.
    ['a server name', () => seeded('serverName', 'my-mcp-server'), 'enum-value'],
    ['an MCP server name', () => seeded('serverName', 'puppeteer'), 'enum-value'],
    ['a model name', () => seeded('model', 'gpt-9-fake'), 'model-name'],
    ['a model that is not the placeholder', () => seeded('model', 'some-model'), 'enum-value'],
    ['a rate-limit object', () => seeded('rateLimits', {}, 'params'), 'rate-limit'],
    ['a rate-limit field', () => seeded('usedPercent', 12, 'params'), 'rate-limit'],
    [
      'an OS version in a user agent',
      () => seeded('userAgent', 'x/1 (Mac OS 14.1)'),
      'os-fingerprint',
    ],
    ['a CPU architecture', () => seeded('source', 'arm64'), 'cpu-arch'],
    [
      'a user agent that is not the placeholder',
      () => seeded('userAgent', 'x/1 (y)'),
      'enum-value',
    ],
    ['a gitInfo object', () => seeded('gitInfo', { branch: 'main' }), 'enum-value'],
    [
      'developer instructions text',
      () => seeded('developer_instructions', 'You are a helpful assistant'),
      'enum-value',
    ],
    [
      'a path-like instruction source',
      () => seeded('instructionSources', ['/etc/agents.md']),
      'enum-value',
    ],
    ['a service tier', () => seeded('serviceTier', 'priority'), 'enum-value'],
    ['a process id', () => seeded('processId', '31337'), 'enum-value'],
    [
      'an originator that is not the spike client',
      () => seeded('originator', 'someone-laptop'),
      'enum-value',
    ],
    ['a plan type', () => seeded('planType', 'plus'), 'plan-type'],
    ['an installation id', () => seeded('installationId', 'x'), 'install-id'],
    ['a real timestamp (seconds)', () => seeded('createdAt', 1_790_000_000), 'timestamp'],
    [
      'a real timestamp (milliseconds)',
      () => seeded('startedAtMs', 1_790_000_000_123),
      'timestamp',
    ],
    [
      'a cursor that is not a placeholder cursor',
      () => seeded('turnsBackwardsCursor', '{"requestedThreadId":"x"}'),
      'cursor-shape',
    ],
    ['a control character', () => seeded('source', 'a\u0007b'), 'bad-char'],
    // The machine's own names (supplied here, never read from this file).
    ['the user name', () => seeded('source', 'jdoe-test'), 'username'],
    ['the home directory name', () => seeded('source', 'jdoe-home'), 'home-name'],
    ['the host name', () => seeded('source', 'jdoe-host'), 'hostname'],
  ];

  test('the base frame is clean, so every case below fails because of its own seed', () => {
    expect(scan(`${JSON.stringify(base())}\n`)).toEqual([]);
    expect(scan(seeded('cwd', '/work/project/sub'))).toEqual([]);
    expect(scan(seeded('command', "/bin/zsh -c 'touch spike-marker-A1'"))).toEqual([]);
  });

  for (const [name, text, expected] of CASES) {
    test(`flags ${name} as ${expected}`, () => {
      expect(rules(text())).toContain(expected);
    });
  }

  test('the cases cover every static rule, so a new rule cannot ship without a seed', () => {
    const hit = new Set(CASES.flatMap(([, text]) => rules(text())));
    const dynamic = ['username', 'home-name', 'hostname'];
    expect([...LEAK_RULES].filter((r) => !hit.has(r))).toEqual([]);
    expect(dynamic.filter((r) => !hit.has(r))).toEqual([]);
  });

  test('a plain string that is not a fixture is checked as one string', () => {
    expect(scanForLeaks('see /Users/someone/x', {}).map((f) => f.rule)).toContain('users-path');
    expect(scanForLeaks('nothing to see', {})).toEqual([]);
  });

  test('without an approved set free text is not checked, with one it fails closed', () => {
    const text = seeded('command', 'echo Alice Johnson');
    expect(scanForLeaks(text, { identity: IDENTITY })).toEqual([]);
    expect(rules(text)).toContain('unapproved-free-text');
  });

  test('a generic machine name is skipped, a distinctive one is not', () => {
    const generic: ScanIdentity = { username: 'unknown', homeName: 'root', host: 'localhost' };
    expect(
      scanForLeaks(seeded('source', 'unknown'), { approvedFreeText: approved, identity: generic }),
    ).toEqual([]);
    const distinctive = scanForLeaks(seeded('source', 'zorblax'), {
      approvedFreeText: approved,
      identity: { username: undefined, homeName: 'zorblax', host: undefined },
    });
    expect(distinctive.map((f) => f.rule)).toContain('home-name');
  });

  test('placeholder UUIDs are exempt from the digit and hex rules, a normalized string compares equal', () => {
    expect(scan(seeded('itemId', `exec-${placeholderUuid(12)}`))).toEqual([]);
    expect(
      normalizeFreeText(`no rollout for ${placeholderUuid(7)} and ${placeholderUuid(9)}`),
    ).toBe('no rollout for <uuid> and <uuid>');
    expect(FREE_TEXT_KEYS.has('command')).toBe(true);
  });
});

describe('the extractor', () => {
  // Every value below is invented here. None is taken from a real session, a real machine or a
  // real person: the thread ids are random, the paths and names are fictional, the timestamps sit
  // at a fictional epoch, and the user agent names a client and an OS that do not exist.
  const HOME = '/Users/jdoe/.codex';
  const PROJECT = '/private/tmp/jdoe-scratch/work';
  const FICTIONAL_SECONDS = 1_000_000_000;
  const FICTIONAL_MS = 1_000_000_000_000;
  const USER_AGENT = 'fake-client/9.9.9 (Test OS 1.0; testcpu) fakeshell/1.0 (fake-client; 0.0.0)';
  const SYNTHETIC_TEXT = ['done'];

  const threads = Array.from({ length: 10 }, () => randomUUID());
  const commandItem = `exec-${randomUUID()}`;

  /** A raw capture of invented frames in the spike's log format, full of the things that must not survive. */
  function rawLog(thread: string, extra: Record<string, unknown>[] = []): string {
    const rec = (client: string, dir: string, frame: Record<string, unknown>): string =>
      JSON.stringify({ t: 0, client, dir, frame });
    const rollout = `${HOME}/sessions/2000/01/02/rollout-2000-01-02T03-04-05-${thread}.jsonl`;
    return `${[
      rec('A', 'out', {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'fake-client' } },
      }),
      rec('A', 'in', {
        id: 1,
        result: {
          userAgent: USER_AGENT,
          codexHome: HOME,
          platformFamily: 'unix',
          platformOs: 'testos',
        },
      }),
      rec('A', 'in', {
        method: 'remoteControl/status/changed',
        params: {
          status: 'ok',
          serverName: 'jdoe-laptop',
          installationId: randomUUID(),
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
            serviceTier: 'priority-tier',
            gitInfo: { branch: 'private-branch', originUrl: 'git@example.test:jdoe/private.git' },
            instructionSources: [`${HOME}/AGENTS.md`],
            processId: '12345',
            createdAt: FICTIONAL_SECONDS,
            account: {
              planType: 'plus',
              serverName: 'jdoe-laptop',
              installationId: randomUUID(),
              rateLimits: { usedPercent: 3 },
            },
            collaborationMode: { settings: { developer_instructions: 'a long system prompt' } },
          },
        },
        emittedAtMs: FICTIONAL_MS + 935,
      }),
      rec('A', 'in', {
        method: 'item/commandExecution/requestApproval',
        id: 7,
        params: {
          threadId: thread,
          itemId: commandItem,
          command: `/bin/zsh -c 'cd ${PROJECT} && touch marker'`,
          cwd: PROJECT,
          startedAtMs: FICTIONAL_MS + 935 + 4666,
        },
      }),
      rec('A', 'in', {
        method: 'item/completed',
        params: {
          item: { type: 'reasoning', id: 'rs_0123456789abcdef', summary: ['thinking about jdoe'] },
          threadId: thread,
          completedAtMs: FICTIONAL_MS + 6000,
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
          completedAtMs: FICTIONAL_MS + 6100,
        },
      }),
      rec('A', 'out', { jsonrpc: '2.0', id: 7, result: { decision: 'accept' } }),
      // An error response to a request the extractor keeps.
      rec('A', 'out', {
        jsonrpc: '2.0',
        id: 2,
        method: 'thread/resume',
        params: { threadId: thread },
      }),
      rec('A', 'in', {
        id: 2,
        error: { code: -32600, message: `no rollout found for thread id ${thread}` },
      }),
      ...extra.map((frame) => rec('A', 'in', frame)),
    ].join('\n')}\n`;
  }

  const rawThread = (i: number): string => threads[i] as string;

  /** The six raw files the extractor reads; `expFlags` keeps only its line 11, so line 11 is a `thread/started`. */
  function writeRawDir(dir: string, extra: Record<string, unknown>[] = []): void {
    mkdirSync(dir, { recursive: true });
    const names = ['expA-accept', 'expA-decline', 'expB', 'expB3', 'expC'];
    names.forEach((name, i) => {
      writeFileSync(join(dir, `${name}.jsonl`), rawLog(rawThread(i), i === 0 ? extra : []));
    });
    const line = (frame: Record<string, unknown>): string =>
      JSON.stringify({ t: 0, client: 'O', dir: 'in', frame });
    const filler = line({ method: 'warning', params: {} });
    const started = (thread: string): string =>
      line({
        method: 'thread/started',
        params: { thread: { id: thread, cwd: PROJECT, environments: [{ cwd: PROJECT }] } },
        emittedAtMs: FICTIONAL_MS,
      });
    // Line 11 is the one that is kept; line 12 is a second thread/started the extractor must not keep.
    writeFileSync(
      join(dir, 'expFlags.jsonl'),
      `${[...Array(10).fill(filler), started(rawThread(8)), started(rawThread(9))].join('\n')}\n`,
    );
  }

  /** The approved free text for the synthetic logs: only what they say, plus the error text. */
  function writeApproved(dir: string, extra: string[] = []): string {
    const file = join(dir, 'approved.json');
    writeFileSync(
      file,
      JSON.stringify([
        ...SYNTHETIC_TEXT,
        // The extractor's own report-derived and schema-derived frames carry these.
        'synthetic file change',
        'synthetic permissions',
        'synthetic elicitation',
        "/bin/zsh -c 'cd /work/project && touch marker'",
        'no rollout found for thread id <uuid>',
        ...extra,
      ]),
    );
    return file;
  }

  /**
   * Run the extractor in a child process of the same Bun that runs the tests. Asynchronous with a hard
   * kill, so a child that never finishes fails this test instead of blocking the whole runner.
   */
  async function spawnExtractor(args: string[], env?: Record<string, string | undefined>) {
    const proc = Bun.spawn([process.execPath, EXTRACTOR, ...args], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      ...(env ? { env } : {}),
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill();
    }, 30_000);
    try {
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      if (timedOut) throw new Error('the extractor did not finish within 30 s');
      return { code, out, err };
    } finally {
      clearTimeout(timer);
    }
  }

  const run = (rawDir: string, outDir: string, approvedFile: string, more: string[] = []) =>
    spawnExtractor([rawDir, '--out', outDir, '--approved', approvedFile, ...more]);

  function scratch(): string {
    return mkdtempSync(join(tmpdir(), 'remi-extractor-'));
  }

  const frames = (text: string): Array<{ line?: number; frame: Record<string, unknown> }> =>
    text
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  test('redacts a raw log it was never tuned on, and the result passes the scan', async () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      const result = await run(join(base, 'raw'), join(base, 'out'), writeApproved(base));
      expect(result.code, result.err).toBe(0);
      const files = readdirSync(join(base, 'out'));
      expect(files).toContain('index.json');
      const accept = readFileSync(join(base, 'out', 'expA-accept.jsonl'), 'utf8');
      for (const file of files) {
        const text = readFileSync(join(base, 'out', file), 'utf8');
        expect(
          scanForLeaks(text, {
            approvedFreeText: readApprovedFreeText(join(base, 'approved.json')),
          }),
          file,
        ).toEqual([]);
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
        'fake-client',
        'testcpu',
      ]) {
        expect(accept, gone).not.toContain(gone);
      }
      expect(
        frames(accept).map((f) => (f.frame['method'] as string | undefined) ?? 'result'),
      ).toEqual([
        'result', // the initialize result
        'thread/started',
        'item/commandExecution/requestApproval',
        'item/completed',
        'result', // our answer to the approval
        'thread/resume', // our request ...
        'result', // ... and the error response it got
      ]);
      // Time moved to a fixed base but kept its spacing.
      expect(accept).toContain('"createdAt":1700000000');
      expect(accept).toContain('"startedAtMs":1700000004666');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('rewrites processId, developer_instructions, instructionSources, serviceTier and gitInfo; drops installationId and rateLimits', async () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      expect((await run(join(base, 'raw'), join(base, 'out'), writeApproved(base))).code).toBe(0);
      const started = frames(readFileSync(join(base, 'out', 'expA-accept.jsonl'), 'utf8')).find(
        (f) => f.frame['method'] === 'thread/started',
      ) as { frame: { params: { thread: Record<string, unknown> } } };
      const thread = started.frame.params.thread;
      expect(thread['processId']).toBe('4242');
      expect(thread['instructionSources']).toEqual([]);
      expect(thread['serviceTier']).toBeNull();
      expect(thread['gitInfo']).toBeNull();
      expect(thread['model']).toBe('test-model');
      expect(
        (thread['collaborationMode'] as { settings: Record<string, unknown> }).settings[
          'developer_instructions'
        ],
      ).toBe('developer instructions omitted');
      // The dropped keys are gone from a frame that is kept, not just from a dropped method.
      const account = thread['account'] as Record<string, unknown>;
      expect(Object.keys(account)).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('keeps an error response to a kept request, and the line selection keeps only line 11 of expFlags', async () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      expect((await run(join(base, 'raw'), join(base, 'out'), writeApproved(base))).code).toBe(0);
      const accept = frames(readFileSync(join(base, 'out', 'expA-accept.jsonl'), 'utf8'));
      const error = accept.find((f) => 'error' in f.frame);
      expect(error?.frame['error']).toMatchObject({ code: -32600 });
      expect((error?.frame['error'] as { message: string }).message).toMatch(
        /^no rollout found for thread id 0{8}-/,
      );
      const flags = frames(readFileSync(join(base, 'out', 'expFlags.jsonl'), 'utf8'));
      expect(flags.map((f) => f.line)).toEqual([11]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('replaces stale fixture files and leaves unrelated files alone', async () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      mkdirSync(join(base, 'out'));
      writeFileSync(join(base, 'out', 'stale.jsonl'), '{"old":true}\n');
      writeFileSync(join(base, 'out', 'index.json'), '{"old":true}');
      writeFileSync(join(base, 'out', 'notes.txt'), 'keep me');
      writeFileSync(join(base, 'out', 'approved-free-text.json'), '["keep me"]');
      expect((await run(join(base, 'raw'), join(base, 'out'), writeApproved(base))).code).toBe(0);
      const files = readdirSync(join(base, 'out'));
      expect(files).not.toContain('stale.jsonl');
      expect(JSON.parse(readFileSync(join(base, 'out', 'index.json'), 'utf8'))).toHaveProperty(
        'files',
      );
      expect(readFileSync(join(base, 'out', 'notes.txt'), 'utf8')).toBe('keep me');
      expect(readFileSync(join(base, 'out', 'approved-free-text.json'), 'utf8')).toBe(
        '["keep me"]',
      );
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('records the sha256 of each source it read', async () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      expect((await run(join(base, 'raw'), join(base, 'out'), writeApproved(base))).code).toBe(0);
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

  test('the same inputs give byte-identical output', async () => {
    const base = scratch();
    try {
      writeRawDir(join(base, 'raw'));
      const approvedFile = writeApproved(base);
      expect((await run(join(base, 'raw'), join(base, 'one'), approvedFile)).code).toBe(0);
      expect((await run(join(base, 'raw'), join(base, 'two'), approvedFile)).code).toBe(0);
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

  test('refuses to write when a leak survives its rules (free text naming a home path)', async () => {
    const base = scratch();
    try {
      const secret = 'saved to /Users/jdoe/Documents/notes.txt';
      writeRawDir(join(base, 'raw'), [
        {
          method: 'item/completed',
          params: {
            item: { type: 'agentMessage', id: 'msg_aaaaaaaaaaaa', text: secret },
            threadId: rawThread(5),
            completedAtMs: FICTIONAL_MS + 6200,
          },
        },
      ]);
      // Even approved text must still pass the universal rules: a path outside /work is a leak.
      const result = await run(join(base, 'raw'), join(base, 'out'), writeApproved(base, [secret]));
      expect(result.code).toBe(1);
      expect(result.err).toContain('LEAK');
      expect(result.err).toContain('nothing written');
      expect(result.err).not.toContain('jdoe');
      expect(existsSync(join(base, 'out'))).toBe(false);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('free text fails closed: a string outside the approved set is refused, and is not echoed', async () => {
    const base = scratch();
    try {
      const prose = 'Dinner with Alice on Friday';
      writeRawDir(join(base, 'raw'), [
        {
          method: 'item/completed',
          params: {
            item: { type: 'agentMessage', id: 'msg_bbbbbbbbbbbb', text: prose },
            threadId: rawThread(6),
            completedAtMs: FICTIONAL_MS + 6300,
          },
        },
      ]);
      const approvedFile = writeApproved(base);
      const refused = await run(join(base, 'raw'), join(base, 'out'), approvedFile);
      expect(refused.code).toBe(1);
      expect(refused.err).toContain('unapproved-free-text');
      expect(refused.err).not.toContain('Alice');
      expect(existsSync(join(base, 'out'))).toBe(false);
      // A person reviewing can ask to see what was refused.
      const shown = await run(join(base, 'raw'), join(base, 'out'), approvedFile, [
        '--show-unapproved',
      ]);
      expect(shown.code).toBe(1);
      expect(shown.err).toContain(prose);
      // Once reviewed and approved, it goes through.
      const accepted = await run(
        join(base, 'raw'),
        join(base, 'out'),
        writeApproved(base, [prose]),
      );
      expect(accepted.code, accepted.err).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('exits 2 with a usage line when given no input directory, and on a missing source file', async () => {
    const base = scratch();
    try {
      const none = await spawnExtractor([], { ...process.env, CODEX_SPIKE_DIR: '' });
      expect(none.code).toBe(2);
      expect(none.err).toContain('usage');
      mkdirSync(join(base, 'empty'));
      const missing = await run(join(base, 'empty'), join(base, 'out'), writeApproved(base));
      expect(missing.code).toBe(2);
      expect(missing.err).toContain('extraction failed');
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
