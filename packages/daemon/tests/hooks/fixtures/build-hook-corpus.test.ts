/**
 * Tests for the corpus builder's contamination filter (#934) and its
 * `--mode structure-preserving` redaction primitives (#992).
 *
 * `isSyntheticRecord` is what decides which raw `hook-diag.jsonl` lines
 * survive into the checked-in, redacted corpus. Filters PRIMARILY on the
 * `_provenance` field (#934); `looksLikeTestFixture`'s `/tmp`-rooted path
 * heuristic is a FALLBACK for records that predate the field, not the
 * mechanism -- these tests prove the precedence, not just that either
 * function independently returns a boolean.
 *
 * `build-hook-corpus.ts` self-invokes `main()` (real-filesystem side
 * effects: reads `~/.remi/hook-diag.jsonl`, overwrites the checked-in
 * `hook-corpus.jsonl`) when run directly, guarded by `import.meta.main` so
 * importing it here for its pure functions does not trigger that.
 *
 * The `detectCredential`/`pseudonymizeIdentities` tests below are this
 * repo's ONLY CI-visible coverage of the structure-preserving redaction
 * logic: they use hand-written synthetic strings, never the owner's real
 * `~/.remi/hook-diag.jsonl` (which this file never touches -- see the doc
 * above). `guard-chain-replay.test.ts`'s header states plainly that running
 * this logic against real captured data was verified manually, once,
 * locally, outside of any test this repo runs.
 */
import { describe, expect, test } from 'bun:test';
import {
  collectCommandLikeValues,
  detectCredential,
  hasHighEntropySecret,
  isSyntheticRecord,
  looksLikeTestFixture,
  pseudonymizeIdentities,
} from './build-hook-corpus.ts';

describe('isSyntheticRecord (#934)', () => {
  test('_provenance: "test" is synthetic, regardless of path shape', () => {
    expect(
      isSyntheticRecord({
        hook_event_name: 'Stop',
        _provenance: 'test',
        cwd: '/Users/real-dev/actual-project',
        transcript_path: '/Users/real-dev/.claude/transcript.jsonl',
      }),
    ).toBe(true);
  });

  test('_provenance: "live" is real, even with a /tmp-shaped path (field wins over heuristic)', () => {
    expect(
      isSyntheticRecord({
        hook_event_name: 'Stop',
        _provenance: 'live',
        cwd: '/tmp/some-real-thing',
      }),
    ).toBe(false);
  });

  test('falls back to looksLikeTestFixture when _provenance is absent (historical records)', () => {
    expect(
      isSyntheticRecord({
        hook_event_name: 'Stop',
        session_id: 'test-session',
        cwd: '/tmp/project',
        transcript_path: '/tmp/test.jsonl',
      }),
    ).toBe(true);
    expect(
      isSyntheticRecord({
        hook_event_name: 'Stop',
        session_id: 'real-session-abc',
        cwd: '/Users/real-dev/actual-project',
        transcript_path: '/Users/real-dev/.claude/transcript.jsonl',
      }),
    ).toBe(false);
  });

  test('MUTATION CHECK: a record with no provenance AND no path signature is (wrongly) kept as real', () => {
    // This is the residual gap the fallback cannot close by itself -- it is
    // why #934 asked for a field, not a better heuristic. Documented here so
    // a future reader does not mistake isSyntheticRecord for airtight on
    // historical (pre-#934) data; it is airtight only once every record
    // carries `_provenance`.
    expect(
      isSyntheticRecord({
        hook_event_name: 'Stop',
        session_id: 'test-session',
        cwd: '/Users/dev/some-other-project',
      }),
    ).toBe(false);
  });
});

describe('looksLikeTestFixture (fallback heuristic, #934)', () => {
  test('flags /tmp-rooted cwd', () => {
    expect(looksLikeTestFixture({ cwd: '/tmp/project' })).toBe(true);
  });

  test('flags the /Users/dev/my-project sentinel', () => {
    expect(looksLikeTestFixture({ cwd: '/Users/dev/my-project' })).toBe(true);
  });

  test('flags /tmp-rooted transcript_path', () => {
    expect(looksLikeTestFixture({ transcript_path: '/tmp/test.jsonl' })).toBe(true);
  });

  test('does not flag a real-looking cwd/transcript_path', () => {
    expect(
      looksLikeTestFixture({
        cwd: '/Users/real-dev/actual-project',
        transcript_path: '/Users/real-dev/.claude/transcript.jsonl',
      }),
    ).toBe(false);
  });
});

describe('detectCredential (#992) -- refusal, not redaction', () => {
  const dropped = [
    [
      'bearer token',
      'curl -H "Authorization: Bearer abcd1234efgh5678ijkl" https://api.example.com',
    ],
    ['sk- prefixed key', 'export OPENAI_API_KEY=sk-proj-abcdefghijklmnop1234'],
    [
      'ghp_/gho_ prefixed token',
      'git remote set-url origin https://ghp_abcdefghijklmnopqrstuvwx1234@github.com/x/y.git',
    ],
    ['AKIA prefixed AWS key', 'aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP'],
    [
      'PEM private key block',
      'echo "-----BEGIN RSA PRIVATE KEY-----\\nMIIEow==\\n-----END RSA PRIVATE KEY-----" > key.pem',
    ],
    [
      'password/token/api_key assignment',
      'curl --data "password=hunter2trustme" https://example.com/login',
    ],
    ['password/token/api_key assignment', 'export API_KEY=abcd1234'],
  ] as const;

  for (const [label, command] of dropped) {
    test(`flags a ${label}`, () => {
      expect(detectCredential(command)).toBe(label);
    });
  }

  test('high-entropy fallback catches a mixed-case+digit secret with no known prefix', () => {
    const command =
      'curl -H "X-Internal-Auth: Qx7mPz2Lw9RtYb4Nc6Vd8Ke1Sf3Ah5Ju0" https://internal.example.com';
    expect(detectCredential(command)).toBe('high-entropy string');
  });

  test('MUTATION CHECK: a git commit SHA (long, hex-only) is NOT flagged as a secret', () => {
    // A 40-char hex SHA is long and looks "random", but hex is only
    // lowercase+digit -- two of the three categories `hasHighEntropySecret`
    // requires. This pins the false-positive-avoidance reasoning documented
    // on `hasHighEntropySecret`, not just its happy path.
    const command =
      'git cherry-pick 8f14e45fceea167a5a36dedd4bea2543d6c1a2b8f14e45fceea167a5a36ded';
    expect(detectCredential(command)).toBeNull();
    expect(hasHighEntropySecret(command)).toBe(false);
  });

  test('MUTATION CHECK: a UUID is NOT flagged as a secret', () => {
    const command = 'curl https://api.example.com/records/550e8400-e29b-41d4-a716-446655440000';
    expect(detectCredential(command)).toBeNull();
  });

  const kept = [
    'git status',
    'npm install left-pad',
    'rm -rf ./build && echo done',
    'curl -X POST https://api.example.com/v1/records -d @payload.json',
    'ssh deploy@prod.example.com "systemctl restart api"',
    'echo "use ssh to connect, not telnet"',
  ];

  for (const command of kept) {
    test(`does not flag an ordinary command: ${command}`, () => {
      expect(detectCredential(command)).toBeNull();
    });
  }
});

describe('pseudonymizeIdentities (#992) -- structure-preserving redaction', () => {
  test('replaces a /Users/<name> home directory, keeps the rest of the path', () => {
    const out = pseudonymizeIdentities('cat /Users/realdev/.ssh/id_rsa.pub');
    expect(out).not.toContain('realdev');
    expect(out).toMatch(/^cat \/Users\/\S+\/\.ssh\/id_rsa\.pub$/);
  });

  test('replaces a /home/<name> home directory the same way', () => {
    const out = pseudonymizeIdentities('tail -f /home/realdev/logs/app.log');
    expect(out).not.toContain('realdev');
    expect(out).toMatch(/^tail -f \/home\/\S+\/logs\/app\.log$/);
  });

  test('replaces a slash-flattened Claude Code slug home dir (#992 real-data finding)', () => {
    // Found by running this tool against real captured data: Claude Code's
    // own scratch/session paths flatten `/` to `-`
    // (`/private/tmp/claude-501/-Users-realdev-Documents-git-...`), which
    // survived the slash-anchored HOME_DIR_RE entirely on the first pass of
    // this feature. Pinned here so it cannot regress silently.
    const out = pseudonymizeIdentities(
      'cat /private/tmp/claude-501/-Users-realdev-Documents-git-yooz-remi/AGENTS.md',
    );
    expect(out).not.toContain('realdev');
    expect(out).toMatch(
      /^cat \/private\/tmp\/claude-501\/-Users-\S+-Documents-git-yooz-remi\/AGENTS\.md$/,
    );
  });

  test('leaves a bare ~ and ~/ untouched (no separate identity to redact)', () => {
    expect(pseudonymizeIdentities('cd ~ && ls')).toBe('cd ~ && ls');
    expect(pseudonymizeIdentities('cat ~/.bashrc')).toBe('cat ~/.bashrc');
  });

  test('replaces a ~name tilde-prefixed username', () => {
    const out = pseudonymizeIdentities('ls ~realdev/bin');
    expect(out).not.toContain('realdev');
    expect(out).toMatch(/^ls ~\S+\/bin$/);
  });

  test('replaces user@host in an ssh command, preserves the rest verbatim', () => {
    const out = pseudonymizeIdentities('ssh realuser@prod.example.com "systemctl restart api"');
    expect(out).not.toContain('realuser');
    expect(out).not.toContain('prod.example.com');
    expect(out).toMatch(/^ssh \S+@\S+ "systemctl restart api"$/);
  });

  test('replaces an email address', () => {
    const out = pseudonymizeIdentities('git config user.email "realdev@example.com"');
    expect(out).not.toContain('realdev@example.com');
    expect(out).toMatch(/^git config user\.email "\S+@\S+"$/);
  });

  test('replaces a bare IPv4 address with an RFC 5737 TEST-NET-3 address', () => {
    const out = pseudonymizeIdentities('ssh -p 22 10.0.1.42 uptime');
    expect(out).not.toContain('10.0.1.42');
    expect(out).toMatch(/^ssh -p 22 203\.0\.113\.\d{1,3} uptime$/);
  });

  test('MUTATION CHECK: an npm-style package@version pin is NOT treated as user@host', () => {
    // `USER_AT_HOST_RE`'s host alternative requires a letter-ending dotted
    // label or a 4-part IPv4 shape specifically so a semver pin like
    // `left-pad@1.2.3` is not misread as an identity. This pins that
    // reasoning against regression.
    expect(pseudonymizeIdentities('npm install left-pad@1.2.3')).toBe('npm install left-pad@1.2.3');
  });

  test('preserves compound-command shell structure: operators, flags, redirection, substitution', () => {
    const command =
      'cd /Users/realdev/project && rm -rf ./dist || echo "$(date) failed" >> /tmp/build.log';
    const out = pseudonymizeIdentities(command);
    expect(out).not.toContain('realdev');
    expect(out).toContain('&&');
    expect(out).toContain('rm -rf ./dist');
    expect(out).toContain('||');
    expect(out).toContain('$(date)');
    expect(out).toContain('>> /tmp/build.log');
  });

  test('deterministic: the same real value maps to the same fake value every time', () => {
    const first = pseudonymizeIdentities('cat /Users/realdev/notes.txt');
    const second = pseudonymizeIdentities('rm /Users/realdev/notes.txt');
    const firstUser = /\/Users\/(\S+)\/notes\.txt/.exec(first)?.[1];
    const secondUser = /\/Users\/(\S+)\/notes\.txt/.exec(second)?.[1];
    expect(firstUser).toBeDefined();
    expect(firstUser).toBe(secondUser);
  });

  test('two different real usernames map to two different fake usernames', () => {
    const a = pseudonymizeIdentities('cat /Users/alice-distinct/x.txt');
    const b = pseudonymizeIdentities('cat /Users/bob-distinct/x.txt');
    const fakeA = /\/Users\/(\S+)\/x\.txt/.exec(a)?.[1];
    const fakeB = /\/Users\/(\S+)\/x\.txt/.exec(b)?.[1];
    expect(fakeA).toBeDefined();
    expect(fakeB).toBeDefined();
    expect(fakeA).not.toBe(fakeB);
  });
});

describe('collectCommandLikeValues (#992)', () => {
  test('collects command/file_path/path/url from tool_input, ignores everything else', () => {
    const values = collectCommandLikeValues({
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: {
        command: 'ls -la',
        file_path: '/tmp/x',
        path: '/tmp/y',
        url: 'https://example.com',
        description: 'not command-like',
      },
    });
    expect(values.sort()).toEqual(['/tmp/x', '/tmp/y', 'https://example.com', 'ls -la'].sort());
  });

  test('returns an empty array when tool_input is absent or not an object', () => {
    expect(collectCommandLikeValues({ hook_event_name: 'Stop' })).toEqual([]);
    expect(collectCommandLikeValues({ tool_input: 'not-an-object' })).toEqual([]);
  });
});
