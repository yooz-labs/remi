/**
 * Parses GitHub's issue-closing keywords ("Fixes #123", "Closes owner/repo#45",
 * ...) out of commit messages.
 *
 * Why this exists: GitHub's own `Fixes #N` / `Closes #N` automation only fires
 * on a merge into the repository's DEFAULT branch. This repo merges feature
 * PRs into `develop`, not `main` (see AGENTS.md branch strategy), so that
 * automation has never once fired here -- fixed issues stay open until someone
 * closes them by hand. `.github/workflows/close-on-develop.yml` is the
 * workaround: on every push to `develop` it scans the pushed commits with the
 * functions below and closes what it finds. This module is the pure,
 * unit-testable half of that workflow; the workflow script (not covered by
 * this package's tests) does the GitHub API calls.
 */

export interface ClosingReference {
  /** Owner from an explicit `owner/repo#N` reference, or null for a bare `#N`. */
  owner: string | null;
  /** Repo from an explicit `owner/repo#N` reference, or null for a bare `#N`. */
  repo: string | null;
  issue: number;
  /** The literal keyword matched, lowercased (e.g. "fixes", "closed"). */
  keyword: string;
}

// GitHub's standard closing keywords -- close/closes/closed, fix/fixes/fixed,
// resolve/resolves/resolved -- case-insensitive, immediately followed by an
// optional "owner/repo" and "#<number>". `[ \t:]` (not `\s`) restricts the gap
// between the keyword and the reference to the same line, so a keyword in one
// paragraph of a PR body can't sweep in an unrelated "#12" mentioned later.
//
// The gap is ONE bounded quantified class, not two adjacent unbounded ones
// (i.e. not `[ \t]*:?[ \t]*`). Two adjacent `*`-quantifiers over overlapping
// character classes, separated by something zero-width-capable, is the
// classic ambiguous-quantifier ReDoS shape: for a run of m non-matching
// separator characters the backtracker explores O(m) ways to split it
// between the two groups, and across the states introduced by the optional
// `:?` this measured as quadratic in practice (a PR body's merge-commit
// message is attacker-controlled -- anyone can open a PR against a public
// repo). `{0,20}` on a single merged class caps the search to a constant
// per attempt regardless of input size, which is enough for any realistic
// "keyword<punctuation/whitespace>#N" spacing.
const CLOSING_KEYWORD_PATTERN =
  /\b(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b[ \t:]{0,20}(?:([\w.-]+)\/([\w.-]+))?#(\d+)/gi;

// Known, deliberate limitation: this regex has no notion of markdown
// structure, so `fixes #10` inside a fenced or inline code block (common in
// this repo's PR bodies, which document commands and config) parses as a
// real closing reference -- a plausible false-close path, not fixed here.
// The inverse, a markdown link like `Fixes [#42](https://...)`, does NOT
// match (the `[` breaks the pattern before `#42`), which fails safe. Both
// are exercised in issue-closing.test.ts under "known limitations".

/**
 * Extract closing references from a single commit message, deduped within
 * that message (e.g. "Fixes #10 ... fixes #10 again" yields one entry).
 */
export function extractClosingReferences(message: string): ClosingReference[] {
  const seen = new Set<string>();
  const results: ClosingReference[] = [];
  for (const match of message.matchAll(CLOSING_KEYWORD_PATTERN)) {
    const [, keyword, owner, repo, issueText] = match;
    if (keyword === undefined || issueText === undefined) continue;
    const issue = Number(issueText);
    if (!Number.isSafeInteger(issue) || issue <= 0) continue;
    const key = `${owner ?? ''}/${repo ?? ''}#${issue}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      owner: owner ?? null,
      repo: repo ?? null,
      issue,
      keyword: keyword.toLowerCase(),
    });
  }
  return results;
}

/**
 * Extract closing references across multiple commit messages -- a push's
 * merge commit plus its individual commits, since in this repo's merge-commit
 * workflow the closing keyword usually lives in the PR body (part of the
 * merge commit message) but sometimes lives on an individual commit instead.
 * Deduped across all messages so one issue referenced twice (or referenced
 * from two different commits in the same push) is only reported once.
 */
export function extractClosingReferencesFromMessages(
  messages: readonly string[],
): ClosingReference[] {
  const seen = new Set<string>();
  const results: ClosingReference[] = [];
  for (const message of messages) {
    for (const ref of extractClosingReferences(message)) {
      const key = `${ref.owner ?? ''}/${ref.repo ?? ''}#${ref.issue}`;
      if (seen.has(key)) continue;
      seen.add(key);
      results.push(ref);
    }
  }
  return results;
}

/**
 * Keep only references this workflow is willing to act on: a bare `#N`
 * (implicitly the current repo) or an explicit `owner/repo#N` that matches
 * the current repo. `GITHUB_TOKEN` cannot act on another repo regardless of
 * what the text says, and per the "err toward doing nothing" brief for an
 * auto-closer, an explicit cross-repo reference (e.g. someone else's
 * `other-org/other-repo#42`) is left alone rather than guessed at -- it is
 * dropped, not translated into a same-repo close.
 */
export function filterSameRepoReferences(
  refs: readonly ClosingReference[],
  currentOwner: string,
  currentRepo: string,
): ClosingReference[] {
  return refs.filter((ref) => {
    if (ref.owner === null || ref.repo === null) return true;
    return (
      ref.owner.toLowerCase() === currentOwner.toLowerCase() &&
      ref.repo.toLowerCase() === currentRepo.toLowerCase()
    );
  });
}
