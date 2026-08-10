/**
 * #1034 (P0): bash ANSI-C `$'...'` quoting desynced `splitCompoundParts` and
 * `maskQuotedSpans`. Both treated `$'...'` as a plain single-quoted span, but
 * bash applies C-style escapes INSIDE `$'...'`, so `\'` does NOT close it —
 * only an unescaped `'` does. `$'\''` is the standard idiom for a literal
 * single quote; after it bash is OUTSIDE quotes.
 *
 * The old parsers toggled quote state on the escaped `'`, ending up INSIDE a
 * wrongly-opened span. A live separator after the real closing quote
 * (`git status $'\'' ; <cmd>`) was then swallowed into one segment, and the 0ms
 * allow fast-path (`matchCoveredCommand`) approved the covered read with the
 * injected tail riding along — the same class as #536 / #1031.
 *
 * Follow-up to #1033, which closed the `\"` variant but explicitly did not
 * handle `$'...'`. These tests pin the splitter, the mask, and the end-to-end
 * closure.
 */

import { describe, expect, test } from 'bun:test';
import { MUTATION_TOKEN } from '../../src/auto-approve/permission-groups.ts';
import {
  hasShellControl,
  maskQuotedSpans,
  matchCoveredCommand,
  splitCompoundParts,
} from '../../src/auto-approve/shell-safety.ts';

const readVeto = (segment: string): boolean => MUTATION_TOKEN.test(segment);
const READS = ['git status', 'cat', 'grep', 'ls'];

describe("splitCompoundParts handles ANSI-C $'...' quoting (#1034)", () => {
  test("an escaped `'` inside $'...' no longer swallows a live `;`", () => {
    // `$'\''` is a literal single quote; after it we are OUTSIDE quotes, so the
    // `;` is a real separator. Old code closed the span early on the escaped
    // `'` and read `; touch ...` as still quoted: one segment.
    const parts = splitCompoundParts("git status $'\\'' ; touch /tmp/x");
    expect(parts.length).toBe(2);
    expect(parts.map((p) => p.joiner)).toEqual([null, ';']);
    expect(parts[1]?.text.trim()).toBe('touch /tmp/x');
  });

  test("an escaped `'` inside $'...' no longer swallows a live `|`", () => {
    const parts = splitCompoundParts("cat file $'\\'' | sh");
    expect(parts.length).toBe(2);
    expect(parts.map((p) => p.joiner)).toEqual([null, '|']);
    expect(parts[1]?.text.trim()).toBe('sh');
  });

  test("a benign $'...' with no escaped quote still splits normally after it", () => {
    const parts = splitCompoundParts("echo $'foo' ; bar");
    expect(parts.length).toBe(2);
    expect(parts.map((p) => p.joiner)).toEqual([null, ';']);
    expect(parts[0]?.text).toContain("$'foo'");
  });

  test("an escaped backslash inside $'...' is consumed; balanced span is one segment", () => {
    // `$'a\\b'` — the `\\` is an escaped backslash, the closing `'` still
    // closes, and there is no separator, so it stays a single segment.
    const parts = splitCompoundParts("echo $'a\\\\b'");
    expect(parts.length).toBe(1);
  });
});

describe("maskQuotedSpans + hasShellControl handle $'...' (#1034)", () => {
  test("$'...' prose with >, & inside does not veto (contents are literal)", () => {
    expect(maskQuotedSpans("echo $'a > b & c'")).toBe('echo ____________');
    expect(hasShellControl("echo $'a > b & c'")).toBe(false);
  });

  test("MUST STILL VETO: real command substitution after a $'...' span", () => {
    // The `$'x'` is inert, but the trailing `$(...)` is real control and must
    // still veto the whole segment.
    expect(hasShellControl("echo $'x' $(touch y)")).toBe(true);
  });
});

describe('the #1034 exploit is closed end-to-end via matchCoveredCommand', () => {
  test("THE P0: $'\\'' can no longer smuggle an uncovered tail past the veto", () => {
    expect(matchCoveredCommand("git status $'\\'' ; touch /tmp/x", READS, readVeto)).toBeNull();
  });

  test('a piped injection behind the ANSI-C escape is refused too', () => {
    expect(matchCoveredCommand("cat file $'\\'' | sh", READS, readVeto)).toBeNull();
  });

  test("control: a covered read with a benign $'...' arg still matches", () => {
    expect(matchCoveredCommand("grep $'foo' file", READS, readVeto)).toBe('grep');
  });
});
