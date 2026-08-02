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

describe('detectCredential -- multi-line-split credentials (PR #995 review finding 1)', () => {
  // A 37-char Google-API-key-shaped secret, split across a real shell line
  // continuation (`\` + newline, an everyday idiom for a long curl/git/aws
  // invocation). Reproduced from the review: neither half alone reaches
  // hasHighEntropySecret's 20-char floor (19 + 18 chars), and no rule's
  // character class includes `\` or `\n`, so before the fix this survived
  // as `null` -- the secret verbatim in the corpus.
  const HEAD = 'AIzaSyD9tSrykjUwHmk'; // 19 chars
  const TAIL = '3POiF5EpBLDXKrmnIA'; // 18 chars
  const command = (glue: string) =>
    `curl -H "X-Api-Value: ${HEAD}${glue}${TAIL}" https://maps.googleapis.com/x`;

  test('backslash + LF continuation is joined and the secret is caught', () => {
    expect(detectCredential(command('\\\n'))).toBe('high-entropy string');
  });

  test('backslash + CRLF continuation is joined and the secret is caught', () => {
    expect(detectCredential(command('\\\r\n'))).toBe('high-entropy string');
  });

  test('a BARE literal newline (no backslash -- a quoted string or heredoc body spanning lines) is also joined and caught', () => {
    // Not a shell line-continuation at all -- the shell does NOT strip a
    // raw newline preserved inside a double-quoted string or a heredoc
    // body; it becomes part of the argument. It splits the token through
    // the identical missing-`\n`-in-any-character-class mechanism, so this
    // pins that the fix does not narrowly handle only the backslash case.
    expect(detectCredential(command('\n'))).toBe('high-entropy string');
  });

  test('sanity: the unsplit secret was already caught before this fix', () => {
    expect(detectCredential(command(''))).toBe('high-entropy string');
  });

  test('sanity: each half alone, with no glue at all, is not enough on its own', () => {
    expect(hasHighEntropySecret(HEAD)).toBe(false);
    expect(hasHighEntropySecret(TAIL)).toBe(false);
  });

  test('a named-prefix credential split by the same continuation is also caught (not only the entropy backstop)', () => {
    // ghp_ prefix requires 20+ CONTIGUOUS alnum chars. Split as 10 + 15
    // (25 total once joined) so the unjoined first segment (10 chars) does
    // NOT already satisfy the rule on its own -- a test that used a first
    // segment >= 20 chars would pass even without the fix and prove
    // nothing. Confirms joinForCredentialScan runs before EVERY rule in
    // detectCredential, not only hasHighEntropySecret.
    const ghpHead = 'ghp_abcdefghij'; // 'ghp_' + 10 alnum
    const ghpTail = 'klmnopqrstuvwxy'; // 15 alnum
    const unsplitRaw = `git remote set-url origin https://${ghpHead}${ghpTail}@github.com/x/y.git`;
    const split = `git remote set-url origin https://${ghpHead}\\\n${ghpTail}@github.com/x/y.git`;
    // Sanity: the unjoined first segment alone must NOT already satisfy the
    // rule, or this test would pass without exercising the fix at all.
    expect(/\bgh[po]_[A-Za-z0-9]{20,}/.test(ghpHead)).toBe(false);
    expect(detectCredential(unsplitRaw)).toBe('ghp_/gho_ prefixed token');
    expect(detectCredential(split)).toBe('ghp_/gho_ prefixed token');
  });

  test('hasHighEntropySecret itself normalizes when called directly, not only via detectCredential', () => {
    expect(hasHighEntropySecret(`${HEAD}\\\n${TAIL}`)).toBe(true);
  });
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

  test('KNOWN LIMITATION (PR #995 review finding 4, not fixed): a percent-encoded home dir still leaks the username', () => {
    // `%2FUsers%2Fjdoe%2Fsecret.txt` -- the shape a pasted callback/redirect
    // URL query parameter carries -- is not decoded before scanning; see
    // HOME_DIR_RE's own doc for why blanket-decoding was judged riskier
    // than leaving this documented. Pinned here (rather than left
    // untested) so a future accidental fix -- or a future accidental
    // WORSENING -- is visible in a diff either way, matching this file's
    // "state the limit, don't silently absorb it" posture elsewhere.
    const command = 'curl "https://example.com/callback?redirect=%2FUsers%2Fjdoe%2Fsecret.txt"';
    expect(pseudonymizeIdentities(command)).toBe(command);
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

  test('replaces user@IPv6-host, and the username too (PR #995 review finding 2)', () => {
    // Before the fix: USER_AT_HOST_RE's host alternation had no IPv6
    // branch, so `local@host` failed to match AT ALL for an IPv6 host --
    // not only did the host survive, the USERNAME leaked too, because
    // nothing else in this file recognizes a bare `user@` prefix on its
    // own. Reproduced exactly from the review.
    const out = pseudonymizeIdentities('ssh jdoe@2001:db8::1 uptime');
    expect(out).not.toContain('jdoe');
    expect(out).not.toContain('2001:db8::1');
    expect(out).toMatch(/^ssh \S+@2001:db8::[0-9a-f]+ uptime$/);
  });

  test('MUTATION CHECK: the fake IPv6 host is a well-formed address, not a leaked-plaintext concatenation', () => {
    // The bug this guards: USER_AT_HOST_RE's IPv6 alternative could stop
    // ONE character short (`2001:db8::` instead of `2001:db8::1`) because a
    // bare alternative ending in `::` already satisfies a trailing `\b`
    // (`:` is non-word, the next real char `1` is word -- that IS a
    // boundary). The leftover `1` then survived as unmatched plaintext,
    // concatenated directly onto the fake value
    // (`dmw8@2001:db8::66a792981` -- a 9-hex-digit final group, which is
    // not even valid IPv6). A real IPv6 group is at most 4 hex digits;
    // this pins that every group in the fake output stays within that
    // bound, which a leaked-suffix concatenation would violate.
    const out = pseudonymizeIdentities('ssh jdoe@2001:db8::1 uptime');
    const m = /2001:db8::([0-9a-f]+)/.exec(out);
    expect(m).not.toBeNull();
    expect((m as RegExpExecArray)[1]?.length).toBeLessThanOrEqual(4);
  });

  test('pseudonymizes a bracketed IPv6 URL host, preserving the port', () => {
    const out = pseudonymizeIdentities('curl http://[2001:db8:85a3::8a2e:370:7334]:8080/status');
    expect(out).not.toContain('2001:db8:85a3::8a2e:370:7334');
    expect(out).toMatch(/^curl http:\/\/\[2001:db8::[0-9a-f]+\]:8080\/status$/);
  });

  test('pseudonymizes a bare (unbracketed, no @) IPv6 address', () => {
    const out = pseudonymizeIdentities('ping6 2001:db8::1');
    expect(out).not.toContain('2001:db8::1');
    expect(out).toMatch(/^ping6 2001:db8::[0-9a-f]+$/);
  });

  test('pseudonymizes the all-compressed IPv6 loopback (::1) inside brackets', () => {
    const out = pseudonymizeIdentities('curl http://[::1]:8080/status');
    expect(out).not.toContain('[::1]');
    expect(out).toMatch(/^curl http:\/\/\[2001:db8::[0-9a-f]+\]:8080\/status$/);
  });

  test('pseudonymizes a full 8-group (uncompressed) IPv6 address', () => {
    const out = pseudonymizeIdentities('ssh jdoe@2001:0db8:0000:0000:0000:ff00:0042:8329 uptime');
    expect(out).not.toContain('jdoe');
    expect(out).not.toContain('2001:0db8:0000:0000:0000:ff00:0042:8329');
  });

  test('MUTATION CHECK: an HH:MM:SS timestamp is NOT treated as IPv6', () => {
    expect(pseudonymizeIdentities('echo "started at 12:30:45"')).toBe('echo "started at 12:30:45"');
  });

  test('MUTATION CHECK: a MAC address is NOT treated as IPv6', () => {
    expect(pseudonymizeIdentities('ip link set eth0 address 00:1b:44:11:3a:b7')).toBe(
      'ip link set eth0 address 00:1b:44:11:3a:b7',
    );
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
