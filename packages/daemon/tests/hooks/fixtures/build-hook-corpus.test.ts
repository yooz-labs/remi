/**
 * Tests for the corpus builder's contamination filter (#934).
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
 */
import { describe, expect, test } from 'bun:test';
import { isSyntheticRecord, looksLikeTestFixture } from './build-hook-corpus.ts';

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
