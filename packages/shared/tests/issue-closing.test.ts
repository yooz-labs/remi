import { describe, expect, test } from 'bun:test';
import {
  extractClosingReferences,
  extractClosingReferencesFromMessages,
  filterSameRepoReferences,
} from '../src/issue-closing.ts';

describe('extractClosingReferences - keyword forms and casing', () => {
  test('close / closes / closed', () => {
    expect(extractClosingReferences('close #1').map((r) => r.issue)).toEqual([1]);
    expect(extractClosingReferences('closes #2').map((r) => r.issue)).toEqual([2]);
    expect(extractClosingReferences('closed #3').map((r) => r.issue)).toEqual([3]);
  });

  test('fix / fixes / fixed', () => {
    expect(extractClosingReferences('fix #4').map((r) => r.issue)).toEqual([4]);
    expect(extractClosingReferences('fixes #5').map((r) => r.issue)).toEqual([5]);
    expect(extractClosingReferences('fixed #6').map((r) => r.issue)).toEqual([6]);
  });

  test('resolve / resolves / resolved', () => {
    expect(extractClosingReferences('resolve #7').map((r) => r.issue)).toEqual([7]);
    expect(extractClosingReferences('resolves #8').map((r) => r.issue)).toEqual([8]);
    expect(extractClosingReferences('resolved #9').map((r) => r.issue)).toEqual([9]);
  });

  test('is case-insensitive on the keyword', () => {
    expect(extractClosingReferences('Closes #10').map((r) => r.issue)).toEqual([10]);
    expect(extractClosingReferences('CLOSES #10').map((r) => r.issue)).toEqual([10]);
    expect(extractClosingReferences('FiXeD #10').map((r) => r.issue)).toEqual([10]);
    expect(extractClosingReferences('Resolves #10').map((r) => r.issue)).toEqual([10]);
  });

  test('lowercases the reported keyword', () => {
    expect(extractClosingReferences('Fixes #10')[0]?.keyword).toBe('fixes');
    expect(extractClosingReferences('CLOSED #10')[0]?.keyword).toBe('closed');
  });

  test('does not match a keyword embedded in a larger word', () => {
    // "enclosed" contains "closed" but is not the keyword "closed".
    expect(extractClosingReferences('the box was enclosed #10')).toEqual([]);
    expect(extractClosingReferences('prefixes #10')).toEqual([]);
  });
});

describe('extractClosingReferences - multiple issues and dedupe', () => {
  test('multiple issues in one message, different keywords', () => {
    const refs = extractClosingReferences('Fixes #10 and closes #12');
    expect(refs.map((r) => r.issue)).toEqual([10, 12]);
  });

  test('a comma-separated list after one keyword only closes the first number', () => {
    // Matches GitHub's real behavior: the keyword must precede EACH
    // reference. "close #168, #169, #170" only auto-closes #168; #169/#170
    // have no keyword of their own directly before them.
    const refs = extractClosingReferences('close #168, #169, #170');
    expect(refs.map((r) => r.issue)).toEqual([168]);
  });

  test('the same issue referenced twice in one message is deduped', () => {
    const refs = extractClosingReferences('Fixes #10. Also fixes #10 again.');
    expect(refs.map((r) => r.issue)).toEqual([10]);
  });

  test('the same issue referenced with different keywords is still deduped once', () => {
    const refs = extractClosingReferences('Closes #10, and this also fixes #10');
    expect(refs.map((r) => r.issue)).toEqual([10]);
  });
});

describe('extractClosingReferences - non-matches', () => {
  test('a bare #N with no keyword does not close', () => {
    expect(extractClosingReferences('See #42 for details')).toEqual([]);
    expect(extractClosingReferences('Related to #42, no fix yet')).toEqual([]);
  });

  test('a message with no reference at all', () => {
    expect(extractClosingReferences('chore: bump version to 0.7.4-dev.62')).toEqual([]);
  });

  test('a keyword and a #N in unrelated paragraphs do not match across the gap', () => {
    const message = 'Fixes the flaky test suite.\n\nSee also unrelated ticket #99 for context.';
    expect(extractClosingReferences(message)).toEqual([]);
  });

  test('a keyword followed by the reference on the next line does not match', () => {
    // Design decision: the gap between keyword and "#N" is restricted to the
    // same line ([ \t] in the pattern, not \s), so "Fixes\n#99" (keyword and
    // reference on separate lines, nothing else between them) is treated as
    // two unrelated fragments rather than a closing reference.
    expect(extractClosingReferences('Fixes\n#99')).toEqual([]);
  });

  test('conventional "(#N)" issue-linking suffix without a keyword does not close', () => {
    // This repo's PR titles commonly end in "(#N)" referencing the issue,
    // e.g. "fix: match engine models by HuggingFace id too (#971)" -- that is
    // NOT a GitHub closing keyword and must not trigger a close.
    const message = 'fix: match engine models by HuggingFace id too (#971)';
    expect(extractClosingReferences(message)).toEqual([]);
  });
});

describe('extractClosingReferences - cross-repo references', () => {
  test('parses an explicit owner/repo#N reference', () => {
    const refs = extractClosingReferences('Fixes yooz-labs/remi#977');
    expect(refs).toEqual([{ owner: 'yooz-labs', repo: 'remi', issue: 977, keyword: 'fixes' }]);
  });

  test('a bare #N has null owner/repo', () => {
    const refs = extractClosingReferences('Fixes #977');
    expect(refs).toEqual([{ owner: null, repo: null, issue: 977, keyword: 'fixes' }]);
  });

  test('a same-repo and cross-repo reference to the same number are distinct entries', () => {
    const refs = extractClosingReferences('Fixes #5 and closes other-org/other-repo#5');
    expect(refs).toEqual([
      { owner: null, repo: null, issue: 5, keyword: 'fixes' },
      { owner: 'other-org', repo: 'other-repo', issue: 5, keyword: 'closes' },
    ]);
  });
});

describe('filterSameRepoReferences', () => {
  test('keeps bare #N references', () => {
    const refs = extractClosingReferences('Fixes #10');
    expect(filterSameRepoReferences(refs, 'yooz-labs', 'remi')).toEqual(refs);
  });

  test('keeps an explicit owner/repo#N reference that matches the current repo', () => {
    const refs = extractClosingReferences('Closes yooz-labs/remi#977');
    expect(filterSameRepoReferences(refs, 'yooz-labs', 'remi')).toEqual(refs);
  });

  test('matches the current repo case-insensitively', () => {
    const refs = extractClosingReferences('Closes Yooz-Labs/REMI#977');
    expect(filterSameRepoReferences(refs, 'yooz-labs', 'remi')).toEqual(refs);
  });

  test('drops an explicit cross-repo reference to a different repo', () => {
    const refs = extractClosingReferences('Fixes other-org/other-repo#42');
    expect(filterSameRepoReferences(refs, 'yooz-labs', 'remi')).toEqual([]);
  });

  test('a mixed message keeps only the same-repo entry', () => {
    const refs = extractClosingReferences('Fixes #5 and closes other-org/other-repo#6');
    const kept = filterSameRepoReferences(refs, 'yooz-labs', 'remi');
    expect(kept.map((r) => r.issue)).toEqual([5]);
  });
});

describe('extractClosingReferencesFromMessages - deduping across a push', () => {
  test('dedupes an issue referenced from two different commit messages', () => {
    const refs = extractClosingReferencesFromMessages(['Fixes #10', 'fixes #10 (follow-up)']);
    expect(refs.map((r) => r.issue)).toEqual([10]);
  });

  test('collects distinct issues across multiple commits, in first-seen order', () => {
    const refs = extractClosingReferencesFromMessages([
      'chore: unrelated bump',
      'Closes #20',
      'Fixes #21',
      'Closes #20 again',
    ]);
    expect(refs.map((r) => r.issue)).toEqual([20, 21]);
  });

  test('a list of messages with none of them containing a reference', () => {
    const refs = extractClosingReferencesFromMessages([
      'chore: bump version to 0.7.4-dev.62',
      'docs: fix typo in README',
    ]);
    expect(refs).toEqual([]);
  });
});

// Fixtures below are verbatim commit messages pulled from this repo's real
// history (`git log develop --merges --format=%B` / `git log --all --grep`),
// not fabricated strings -- they exercise the parser against the actual text
// it will run on in production.
describe('extractClosingReferences - real commit messages from this repo', () => {
  test('8623f8f: merge commit body with "(closes #N)"', () => {
    const message =
      'Merge pull request #434 from yooz-labs/feature/issue-427-epic-transcript-binding\n\n' +
      'Epic: deterministic PTY->transcript binding (closes #427)';
    expect(extractClosingReferences(message)).toEqual([
      { owner: null, repo: null, issue: 427, keyword: 'closes' },
    ]);
  });

  test('992029f: merge commit body with "close #N, #N, #N" only closes the first', () => {
    const message =
      'Merge pull request #363 from yooz-labs/refactor/daemon-tech-debt-168-169-170\n\n' +
      'refactor(daemon): close #168, #169, #170 — typed metadata + options-object createHello + onConnect tests';
    expect(extractClosingReferences(message).map((r) => r.issue)).toEqual([168]);
  });

  test('48aabd2: squashed commit body with "Closes #N" mid-paragraph', () => {
    const message =
      'fix: purge stale hooks, limit session list to connected daemon (#173)\n\n' +
      '* fix: purge stale hooks on install, limit session list to connected daemon\n\n' +
      'HookConfigManager.install() now probes all localhost HTTP hook URLs\n' +
      'with a 500ms TCP connect and removes entries pointing to dead ports.\n' +
      'Prevents ECONNREFUSED errors from accumulating after daemon crashes.\n\n' +
      'Web app session list uses includeExternal=false so only sessions from\n' +
      'the connected daemon are shown, preventing cross-daemon message routing.\n\n' +
      'Closes #172\n\n' +
      '* refactor: address PR review findings';
    expect(extractClosingReferences(message)).toEqual([
      { owner: null, repo: null, issue: 172, keyword: 'closes' },
    ]);
  });

  // Named by shape rather than by commit SHA. A short hex SHA tokenizes into
  // false-positive "words" that `typos` rejects — the same failure that made
  // `_typos.toml` exclude the 24-hex object ids in `.pbxproj` (#719). The
  // fixture below is still the verbatim commit message; only the test NAME
  // avoids the hex.
  test('squashed commit body with "Fixes #N" mid-paragraph', () => {
    const message =
      'fix: auto-promote waiting client when active disconnects (#181)\n\n' +
      '* fix: auto-promote waiting client when active disconnects\n\n' +
      'Now the session registry maintains a FIFO queue of waiting\n' +
      'connections. When the active client disconnects, the next waiting\n' +
      'client is automatically promoted and receives a hello_ack with\n' +
      'replay messages. Waiting clients that disconnect before promotion\n' +
      'are cleaned up from the queue.\n\n' +
      'Fixes #180\n\n' +
      '* refactor: address PR review findings';
    expect(extractClosingReferences(message)).toEqual([
      { owner: null, repo: null, issue: 180, keyword: 'fixes' },
    ]);
  });

  test('3a53047: squashed commit body with "Fixes #N" mid-paragraph', () => {
    const message =
      'feat: register and handle all 25 Claude Code hook events (#186)\n\n' +
      'Add type definitions, server dispatch, and event bridge handlers\n' +
      'for all hook events. High-priority events (PermissionRequest,\n' +
      'SubagentStart/Stop, StopFailure, SessionEnd) get dedicated handlers.\n' +
      'Medium/low priority events are accepted but only logged.\n\n' +
      'The hook server now accepts unknown events with 200 instead of\n' +
      'rejecting with 400, future-proofing against new Claude Code events.\n\n' +
      'Fixes #185';
    expect(extractClosingReferences(message)).toEqual([
      { owner: null, repo: null, issue: 185, keyword: 'fixes' },
    ]);
  });

  test('23b76e5: a typical PR-linking merge commit with no closing keyword', () => {
    // Real merge commit for PR #974. The "(#971)" suffix is this repo's
    // conventional-commit style of naming the source issue -- it is NOT a
    // GitHub closing keyword and must not be treated as one.
    const message =
      'Merge pull request #974 from yooz-labs/feature/issue-971-hf-id-model-match\n\n' +
      'fix: match engine models by HuggingFace id too (#971)';
    expect(extractClosingReferences(message)).toEqual([]);
  });

  test('a20efd3: a version-bump commit has no closing reference', () => {
    expect(extractClosingReferences('chore: bump version to 0.7.4-dev.52')).toEqual([]);
  });
});

describe('extractClosingReferences - ReDoS resistance', () => {
  // Regression guard for a quadratic-blowup bug: the gap between the keyword
  // and "#N" used to be two adjacent unbounded quantifiers over the same
  // character class ([ \t]*:?[ \t]*), the classic ambiguous-quantifier ReDoS
  // shape. A commit message is attacker-controlled (a PR body lands in the
  // merge commit message, and anyone can open a PR against a public repo),
  // so a keyword followed by a long non-matching run of spaces/tabs must
  // stay fast. The fix bounds the gap to a single {0,20} class; this test
  // locks that bound in by asserting a large adversarial input still
  // completes in well under a second, not the 6+ seconds (80k chars) to
  // 15+ minutes (1MB) the unbounded pattern measured at.
  test('a keyword followed by a very long non-matching run resolves quickly', () => {
    const input = `fixes ${' '.repeat(200_000)}x`;
    const start = performance.now();
    const refs = extractClosingReferences(input);
    const elapsedMs = performance.now() - start;
    expect(refs).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);
  });

  test('a keyword followed by a long run of the gap characters themselves resolves quickly', () => {
    // Exercises the bounded class directly: 100k characters that are ALL
    // members of [ \t:], still never resolving into "#<digits>".
    const input = `closes ${' \t:'.repeat(50_000)}`;
    const start = performance.now();
    const refs = extractClosingReferences(input);
    const elapsedMs = performance.now() - start;
    expect(refs).toEqual([]);
    expect(elapsedMs).toBeLessThan(1000);
  });

  test('a real reference still matches immediately after a long gap-only prefix elsewhere in the message', () => {
    // The bound should not cause false negatives on realistic input -- a
    // long unrelated run earlier in the message must not prevent a later,
    // normally-formed reference from matching.
    const input = `Unrelated: ${' '.repeat(10_000)}padding.\n\nFixes #42`;
    expect(extractClosingReferences(input).map((r) => r.issue)).toEqual([42]);
  });
});

describe('extractClosingReferences - known limitations (documented, not fixed)', () => {
  test('a keyword+reference inside a markdown code span still matches (false-close risk)', () => {
    // The parser has no notion of markdown structure. This repo's PR bodies
    // routinely include inline code or fenced blocks documenting commands,
    // and "fixes #10" inside one of those still reads as a real reference.
    // Recorded here deliberately, not as a target to fix in this change.
    const inline = 'See `git log --grep fixes #10` for context.';
    expect(extractClosingReferences(inline).map((r) => r.issue)).toEqual([10]);

    const fenced = ['```', 'fixes #11', '```'].join('\n');
    expect(extractClosingReferences(fenced).map((r) => r.issue)).toEqual([11]);
  });

  test('a markdown link reference does not match (fails safe)', () => {
    // "Fixes [#42](https://github.com/...)" -- the "[" immediately after the
    // keyword's gap breaks the pattern before it reaches "#42", so this
    // form is silently NOT treated as a closing reference. That is the safe
    // direction to fail in for an auto-closer.
    const message = 'Fixes [#42](https://github.com/yooz-labs/remi/issues/42) for details';
    expect(extractClosingReferences(message)).toEqual([]);
  });
});
