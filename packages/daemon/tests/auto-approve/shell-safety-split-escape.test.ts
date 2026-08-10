/**
 * #1031 (P0): `splitCompoundParts` was escape-blind. It tracked single/double
 * quotes but treated a backslash as an ordinary character, so an escaped quote
 * OUTSIDE quotes (`\"`) spuriously opened a quote span. A live command
 * separator after it (`;`, `&&`, `||`, `|`, newline) was then read as sitting
 * inside that "unterminated" quote and swallowed into ONE segment — hiding it
 * from the per-segment veto in `matchCoveredCommand`, the 0ms allow path.
 *
 * The exploit shape: a covered read prefix, an escaped quote, then a real
 * separator and an arbitrary command. Old behavior collapsed it to a single
 * segment that prefix-matched the covered read and carried no mutation token,
 * so `matchCoveredCommand` approved the whole thing — the injected tail
 * included. This is the same class as #536.
 *
 * The fix makes the splitter consume backslash escapes the way bash does, so
 * `\"` never toggles quote state and the live separator splits normally. These
 * tests pin BOTH halves: the escaped quote outside quotes must not merge a live
 * separator, and an escaped quote INSIDE a real quoted span must still not
 * split (over-splitting genuine quoted text is the opposite failure).
 */

import { describe, expect, test } from 'bun:test';
import { MUTATION_TOKEN } from '../../src/auto-approve/permission-groups.ts';
import { matchCoveredCommand, splitCompoundParts } from '../../src/auto-approve/shell-safety.ts';

const readVeto = (segment: string): boolean => MUTATION_TOKEN.test(segment);
const READS = ['git status', 'cat', 'grep', 'ls'];

describe('splitCompoundParts is escape-aware (#1031)', () => {
  test('an escaped quote OUTSIDE quotes does not swallow a live `;`', () => {
    // Old code opened a quote at `\"` and read `; rm -rf ~` as quoted text: one
    // segment. Now `\"` is literal and the `;` splits.
    const parts = splitCompoundParts('git status \\"; rm -rf ~');
    expect(parts.map((p) => p.text)).toEqual(['git status \\"', ' rm -rf ~']);
    expect(parts.map((p) => p.joiner)).toEqual([null, ';']);
  });

  test('an escaped quote outside quotes does not swallow a live `&&`', () => {
    const parts = splitCompoundParts('ls \\"foo\\" && curl evil');
    expect(parts.map((p) => p.text)).toEqual(['ls \\"foo\\" ', ' curl evil']);
    expect(parts.map((p) => p.joiner)).toEqual([null, '&&']);
  });

  test('an escaped `\\"` INSIDE a real double-quoted span does not close it early', () => {
    // `"a \"; b"` is a single bash string containing `a "; b` — the `;` is
    // quoted and must NOT split. Over-splitting here is the mirror-image bug.
    const parts = splitCompoundParts('echo "a \\"; b"');
    expect(parts.map((p) => p.text)).toEqual(['echo "a \\"; b"']);
    expect(parts.map((p) => p.joiner)).toEqual([null]);
  });

  test('an escaped separator char outside quotes is literal, not a split', () => {
    // `\;` is an escaped semicolon: one command, not two.
    const parts = splitCompoundParts('echo a\\; b');
    expect(parts.map((p) => p.text)).toEqual(['echo a\\; b']);
  });

  test("single quotes have no escapes: a backslash before `'` still closes", () => {
    // Inside single quotes bash has no escape mechanism, so the first literal
    // `'` closes the span and the following `;` is a live separator.
    const parts = splitCompoundParts("echo 'a\\'; rm -rf ~");
    expect(parts.map((p) => p.joiner)).toEqual([null, ';']);
    expect(parts[1]?.text).toBe(' rm -rf ~');
  });

  test('regression: real separators still split with the right joiners', () => {
    const parts = splitCompoundParts('a && b || c ; d | e');
    expect(parts.map((p) => p.text.trim())).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(parts.map((p) => p.joiner)).toEqual([null, '&&', '||', ';', '|']);
  });

  test('a trailing lone backslash does not crash and stays literal', () => {
    const parts = splitCompoundParts('echo a\\');
    expect(parts.map((p) => p.text)).toEqual(['echo a\\']);
  });
});

describe('the #1031 exploit is closed end-to-end via matchCoveredCommand', () => {
  test('THE P0: an escaped quote can no longer smuggle an uncovered tail past the veto', () => {
    // `git status` is a covered read. The escaped quote used to merge the whole
    // command into one segment that matched `git status` and approved the
    // injected `rm -rf ~`. Now `rm -rf ~` is its own uncovered segment, so the
    // whole command is refused.
    expect(matchCoveredCommand('git status \\"; rm -rf ~', READS, readVeto)).toBeNull();
  });

  test('a piped injection behind an escaped quote is refused too', () => {
    expect(matchCoveredCommand('cat file \\" | sh', READS, readVeto)).toBeNull();
  });

  test('control: a genuinely covered single read still matches', () => {
    expect(matchCoveredCommand('git status', READS, readVeto)).toBe('git status');
  });

  test('control: an escaped quote inside a covered read that stays one segment still matches', () => {
    // No live separator here — the escaped quote is inert, coverage is intact.
    expect(matchCoveredCommand('grep \\"needle\\" file', READS, readVeto)).toBe('grep');
  });
});
