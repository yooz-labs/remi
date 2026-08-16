/**
 * Shell-segment primitives shared by the permission-group matcher and the
 * user allow-list matcher (#494, #536).
 *
 * Both need the same question answered: "is EVERY part of this compound
 * command covered by something the user opted into?" Answering it by
 * substring search cannot work, because a substring says nothing about the
 * parts of the command it did not match — `git status; rm -rf ~` contains
 * "git status" and is not a `git status`.
 *
 * These functions were factored out of permission-groups.ts unchanged; the
 * group matcher layers its own curated-read vetoes on top via the
 * `extraVeto` hook of `matchCoveredCommand`.
 */

/**
 * Benign segments that may appear in a compound command without needing
 * coverage.
 *
 * `read` (#1057 phase 3, commit 2) is a bash BUILTIN that assigns stdin to
 * shell variables and executes nothing of its own -- its flags (`-r`, `-p`,
 * `-a`, `-e`, ...) only change how it parses stdin, none of them run a
 * command. It is the loop-header half of the `while read l; do ...; done`
 * idiom (#999 already peels `while`/`do`/`done`), and before this addition
 * the `read l` segment itself matched no prefix and had no path to being
 * judged benign, so a body the rest of this module would otherwise cover
 * (`grep`, `cat`, ...) still escalated on the header segment alone. Neutral,
 * not a matched prefix: a command of ONLY neutral segments still matches
 * nothing (`matchCoveredCommand` requires at least one real hit), so bare
 * `read` alone stays uncovered by design -- see the paired test.
 *
 * `printf` (#1057 phase 3, commit 3) is the same inert class as `echo`: it
 * writes only to stdout, takes no destination flag, and executes nothing of
 * its own. Added after the #996 corpus showed a `for`-loop header using it
 * purely for formatted progress text (`printf "obs #%s: " $p`) sinking an
 * otherwise-covered read segment in the same loop body.
 */
export const NEUTRAL_PREFIXES: readonly string[] = [
  'cd',
  'pwd',
  'true',
  'echo',
  ':',
  'read',
  'printf',
];

/*
 * ATTEMPT 5, REVERTED BEFORE MERGE: "a segment whose every word is an
 * assignment runs no command, so it needs no coverage."
 *
 * It rejected `PATH=/evil ls` (the glued form) and AUTO-APPROVED the
 * semicolon form, which is strictly worse because a bare assignment persists
 * for every later segment:
 *
 *     PATH=/tmp/evil ls     -> escalate            (guarded)
 *     PATH=/tmp/evil; ls    -> APPROVE read-only:ls  at 0ms
 *
 * `splitCompound` splits on `;`/`&&`/`||`/newline, so identical shell
 * semantics arrive as two segments — an "inert" assignment plus a covered
 * read. Verified against real bash: both spellings run the attacker's binary
 * (`PATH`/`HOME` are already exported, so a bare assignment keeps the export
 * attribute). `export PATH=…; git status` was a second route, since `export`
 * is peeled by `stripShellGrammar` first. This lands on `read-only`, which is
 * in EVERY preset including the default, and via #1024 is answered at hook
 * time for a subagent with no render and no card.
 *
 * This is attempt (1) of the post-mortem below, and that post-mortem's
 * conclusion stands: no property of an assignment inspected IN ISOLATION
 * separates benign from dangerous, because the danger is what the assignment
 * does to LATER segments. A correct fix must carry inertness FORWARD — a
 * pure-assignment segment poisoning every subsequent non-neutral segment, the
 * way `artifactCleanPoisonWalk` poisons on `cd` — not judge the segment alone.
 * Name-denylisting (`PATH`/`LD_*`/`BASH_ENV`/…) is item (2) and is rejected
 * there.
 *
 * Do not re-add without the forward-poison walk AND test cases in the `;`,
 * `&&` and newline spellings. The reverted version's own test block was named
 * "an assignment PREFIX to a command is NOT inert" and pinned five cases,
 * every one the glued spelling that already worked — so it passed green while
 * the hole was open.
 */

/**
 * Shell keywords that PREFIX a real command (#999).
 *
 * Every one of these is followed by a command that actually runs, so the ONLY
 * correct handling is to remove the keyword and judge what is left exactly as
 * if the keyword had never been there. `do echo x` is an `echo`; `while rm -rf
 * /` is an `rm -rf /` and must be refused as one.
 *
 * They are deliberately NOT in `NEUTRAL_PREFIXES`. Adding them there would make
 * `do <anything>` benign, which is a 0ms auto-approval of `do rm -rf /` — the
 * #536 bug class exactly (a prefix match that says nothing about the rest of
 * the command), reintroduced one level up in the grammar.
 *
 * `while`/`until`/`if`/`elif` matter most here, because their CONDITION is a
 * command: stripping and re-judging is what keeps `until rm -rf /` honest.
 *
 * Loop and block TERMINATORS (`done`, `fi`, `esac`) are in this list rather
 * than a separate "these are benign on their own" list on purpose. Nothing may
 * legally follow them on the same segment, but if anything ever does, stripping
 * and re-judging refuses it, whereas treating the keyword as benign would wave
 * `done rm -rf /` straight through. Same reasoning for `!` (negation) and
 * `time`: both run the command that follows.
 */
const GRAMMAR_PREFIX_KEYWORDS: readonly string[] = [
  'do',
  'then',
  'else',
  'elif',
  'while',
  'until',
  'if',
  'done',
  'fi',
  'esac',
  '!',
  'time',
  // `export FOO=bar` runs nothing. `export FOO=bar rm` exports a variable
  // NAMED rm rather than running it, so stripping and re-judging over-refuses
  // there, which is the right direction to be wrong in.
  'export',
];

/**
 * A leading `NAME=value` assignment.
 *
 * NEVER peeled, and the reasoning is worth keeping because three separate
 * attempts to make it safe all failed, each from a direction the previous fix
 * did not anticipate:
 *
 *   1. peel any assignment       -> `PATH=/evil/bin git status` approved `git`
 *                                   while `/evil/bin/git` ran
 *   2. refuse dangerous NAMES    -> `HOME=/tmp/evil git commit` ran an
 *                                   attacker's `pre-commit` via `core.hooksPath`
 *   3. refuse path-shaped VALUES -> `HTTPS_PROXY=host:port gh pr view` handed a
 *                                   network position the request
 *   4. require OPAQUE values     -> `PYTEST_PLUGINS=evil_plugin pytest` imports
 *                                   arbitrary Python, at the SHIPPED DEFAULT
 *                                   level, and `evil_plugin` is exactly as
 *                                   opaque as the benign `ACC=da8d7a2a868`
 *
 * (4) is the one that settles it. No property of the assignment can separate
 * those two strings, because the danger is not in the assignment at all — it is
 * in what the TOOL does with the variable, and any tool may give any name any
 * meaning. A rule that inspects only the assignment is answering a question the
 * assignment does not contain.
 *
 * So an assignment prefix simply is not covered, and the command escalates.
 * That costs the ~150 real commands this was measured to cover
 * (`ACC=da8d7a2a868 git status` and friends), which is the correct trade
 * against arbitrary code execution with no opt-in. Restoring coverage safely
 * would mean knowing a specific (variable, command) pair is inert — a
 * per-command allowlist, not a value heuristic. That is a separate design, not
 * a widening of this one.
 */
const ASSIGNMENT_HEAD_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** True if the segment's first word is a `NAME=value` assignment. */
export function hasAssignmentPrefix(segment: string): boolean {
  return ASSIGNMENT_HEAD_RE.test(segment.trim());
}

/**
 * A `for`/`select` header binds a variable over a word list and runs NOTHING;
 * the body is a separate segment. Command substitution in the word list would
 * run something, and `hasShellControl` already refuses the whole segment for
 * that before this is consulted, so the header cannot smuggle a command past.
 * A command cannot follow the word list on the same segment either — `do` must
 * be introduced by `;` or a newline, both of which `splitCompound` splits on.
 */
const FOR_HEADER_RE = /^(?:for|select)\b/;

/**
 * A `case` header dispatches and runs nothing, but unlike `for` it is followed
 * on the SAME segment by `<pattern>) <command>` (the `;;` that would separate
 * them only appears after the first body). So this is anchored to end at `in`:
 * `case $x in a) rm -rf /` must NOT be read as a bare header, or the `rm` rides
 * in unexamined.
 */
const CASE_HEADER_RE = /^case\s+\S+\s+in$/;

/** `break`/`continue` take an optional LEVEL COUNT, never a command. */
const LOOP_CONTROL_RE = /^(?:break|continue)(?:\s+\d+)?$/;

/**
 * Characters a bare input-redirect PATH may contain once proven free of
 * expansion: letters, digits, `_ . / ~ -`. No `$`, no quotes -- either would
 * mean the shell rewrites the token before this text is what actually gets
 * opened, and `isPlainInputRedirectResidue` runs on RAW residue text (no
 * quote-masking has happened by this point), so a quote character has to be
 * refused rather than trusted to bound a literal.
 */
const INPUT_REDIRECT_PATH_RE = /^[A-Za-z0-9_./~-]+$/;

/**
 * One input-redirect clause inside a peeled residue: `< PATH` or `<<< WORD`
 * (a here-string). `<<<` is tried before the single-`<` alternative so a
 * here-string is never misread as a file redirect whose target happens to
 * start with `<`.
 */
const RESIDUE_REDIRECT_CLAUSE_RE = /(<<<|<)\s*(\S+)/g;

/**
 * True if `rest` -- a `stripShellGrammar` peel residue -- consists SOLELY of
 * one or more plain input-redirect clauses, each provably free of expansion:
 * `< f`, `< ./data.txt`, `<<< abc`, or several of these in a row.
 *
 * Why this is safe to treat as structural exactly like an empty residue: the
 * terminator or header this residue trails (`done`, `fi`, ...) already runs
 * no command of its own -- that is the entire premise `stripShellGrammar`
 * rests on -- and a bare input redirect on that same segment does not add
 * one either. It only rebinds the compound's stdin to a file the shell opens
 * for reading; nothing here runs, writes, or executes anything.
 *
 * Deliberately conservative, matching this module's established idiom of
 * removing only what is PROVEN inert and leaving everything else visible so
 * it still fails closed:
 *
 *   - a target containing `$` is refused -- expansion means this text is not
 *     what the shell will actually open;
 *   - a quoted target (`< "f"`) is refused -- this function runs on RAW text,
 *     so a quote character is not provably a literal delimiter here, only a
 *     character this recognizer does not understand;
 *   - `<(...)` process substitution is refused by construction: its target
 *     starts with `(`, outside both character classes below, and it is
 *     independently vetoed by `hasShellControl` on the UNPEELED segment
 *     regardless (that check runs before `stripShellGrammar` is ever called
 *     -- see `matchCoveredCommand`), so this function does not need to, and
 *     must not, weaken that.
 *
 * Any gap between clauses that is not pure whitespace, or any trailing text
 * after the last clause, fails the whole residue: a redirect clause is not
 * ALL the residue contains, so nothing here is safe to wave through
 * unexamined.
 */
function isPlainInputRedirectResidue(rest: string): boolean {
  if (rest === '') return false;
  const matches = [...rest.matchAll(RESIDUE_REDIRECT_CLAUSE_RE)];
  if (matches.length === 0) return false;
  let consumed = 0;
  for (const match of matches) {
    if (rest.slice(consumed, match.index).trim() !== '') return false;
    const [whole, op, target] = match;
    if (target === undefined) return false;
    const targetOk = op === '<<<' ? !/[$`(\s]/.test(target) : INPUT_REDIRECT_PATH_RE.test(target);
    if (!targetOk) return false;
    consumed = match.index + whole.length;
  }
  return rest.slice(consumed).trim() === '';
}

/** A segment reduced to the command it actually runs, if any. */
export interface StrippedSegment {
  /** What remains once leading grammar keywords are removed. */
  readonly command: string;
  /** True when the segment is pure grammar and runs no command at all. */
  readonly structural: boolean;
}

/**
 * Peel shell grammar off a segment so the command inside it can be judged.
 *
 * Before this existed, one unrecognized structural keyword vetoed an entire
 * line: per-segment matching requires EVERY segment to be covered, and `for` /
 * `do` / `done` matched nothing, so every loop and conditional escalated no
 * matter how safe its body was. Measured at 190 of 733 real main-agent
 * commands, 25.9%, with 190 of 190 uncovered (#999).
 *
 * The safety property is that this function only ever REMOVES grammar and
 * hands back a command for the normal matcher to judge. It never decides that
 * something is allowed. A segment it cannot reduce to pure grammar comes back
 * as a command, and an unrecognized command is still refused.
 */
export function stripShellGrammar(segment: string): StrippedSegment {
  let rest = segment.trim();
  if (FOR_HEADER_RE.test(rest) || CASE_HEADER_RE.test(rest) || LOOP_CONTROL_RE.test(rest)) {
    return { command: '', structural: true };
  }
  // Loop: a segment may stack keywords, e.g. `do if [ -f x ]`. Assignments are
  // NOT peeled (see `ASSIGNMENT_HEAD_RE`), so `do FOO=bar git status` peels the
  // `do` and stops, leaving `FOO=bar git status` to be judged and refused.
  for (;;) {
    const keyword = matchPrefix(rest, GRAMMAR_PREFIX_KEYWORDS);
    if (keyword === null) break;
    rest = rest.slice(keyword.length).trim();
    // A `for`/`case` header can follow a keyword too: `do for f in a b`.
    if (FOR_HEADER_RE.test(rest) || CASE_HEADER_RE.test(rest) || LOOP_CONTROL_RE.test(rest)) {
      return { command: '', structural: true };
    }
  }
  // #1057 phase 3, commit 2: a residue that is SOLELY a plain input-redirect
  // clause (`done < f`, `fi <<< abc`) trails a terminator/header that already
  // runs no command -- see `isPlainInputRedirectResidue` for why rebinding
  // stdin does not change that. Checked once, here, after every keyword has
  // been peeled (including stacked ones), rather than inside the loop: a
  // redirect clause never itself matches `GRAMMAR_PREFIX_KEYWORDS`, so it can
  // only ever be reached as the loop's final residue.
  if (isPlainInputRedirectResidue(rest)) {
    return { command: '', structural: true };
  }
  return { command: rest, structural: rest === '' };
}

/**
 * The operator that JOINS one compound segment to the previous one (`null` for
 * the first segment, which nothing precedes).
 *
 * Most callers do not care — a segment must be covered no matter how it was
 * reached, which is why `splitCompound` drops this. It matters only to a
 * caller carrying STATE across segments, because `|` and `||` are the two
 * operators under which a segment's effect on the outer shell is not what
 * reading left-to-right suggests: a `||` right-hand side may never run at all,
 * and a `|` stage runs in a subshell whose side effects are discarded.
 */
export type CompoundJoiner = ';' | '&&' | '||' | '|' | 'newline' | null;

export interface CompoundPart {
  /** Segment text, exactly as it appeared (untrimmed). */
  readonly text: string;
  /** Operator preceding this segment; `null` for the first. */
  readonly joiner: CompoundJoiner;
}

/**
 * Split a command into compound segments on `&&`, `||`, `;`, `|`, and newlines
 * (`\n`/`\r` — the shell treats an unquoted newline as a command separator,
 * exactly like `;`), respecting single/double quotes and double-quote /
 * unquoted backslash escapes, retaining which operator joined each segment
 * to the previous one.
 * Backgrounding `&` is left in the segment for the shell-control veto to catch.
 *
 * Escape handling (#1031): a backslash-escaped quote outside quotes (`\"`)
 * does not open a quote, and a backslash-escaped `"` inside a double-quoted
 * span does not close it — in real bash neither toggles quote state, so
 * treating them as literal is what keeps a LIVE separator after them (a real
 * `;`/`&&`/`||`/`|`) from being misread as still inside an "unterminated"
 * quote and swallowed into one segment. Single quotes are unaffected: bash has
 * no escapes inside them, so only a literal `'` closes one.
 *
 * ANSI-C handling (#1034): bash `$'...'` applies C-style escapes inside, so
 * `\'` does NOT close the span — only an unescaped `'` does. This parser (and
 * `maskQuotedSpans`) recognizes `$'...'` and consumes those escapes, so an
 * escaped `'` cannot close early and desync quote state, which would otherwise
 * leave a live separator after the real closing quote swallowed into one
 * segment (the bypass #1033 left open, same class as #1031).
 */
export function splitCompoundParts(command: string): CompoundPart[] {
  const parts: CompoundPart[] = [];
  let current = '';
  let joiner: CompoundJoiner = null;
  let quote: '"' | "'" | "$'" | null = null;
  const push = (nextJoiner: CompoundJoiner) => {
    parts.push({ text: current, joiner });
    current = '';
    joiner = nextJoiner;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];

    if (quote === '"') {
      // Every backslash inside double quotes is consumed with the character
      // after it, so an escaped `"` cannot close the quote. This is broader
      // than bash's real rule (only `$ \` " \\` newline are special inside
      // double quotes), but that is safe here: over-consuming an escape can
      // only keep already-quoted text together, never merge a live operator —
      // a live operator requires being OUTSIDE quotes in the first place.
      if (c === '\\' && next !== undefined) {
        current += c + next;
        i++;
        continue;
      }
      current += c;
      if (c === '"') quote = null;
      continue;
    }

    if (quote === "'") {
      // No escapes exist inside bash single quotes; only a literal `'` closes.
      current += c;
      if (c === "'") quote = null;
      continue;
    }

    if (quote === "$'") {
      // ANSI-C quoting (`$'...'`): bash applies C-style escapes inside, so a
      // backslash-escaped `'` does NOT close the span — only an UNescaped `'`
      // does (#1034). Consuming the backslash with its next char is what keeps
      // an escaped `'` from ending the span early and leaving a LIVE separator
      // after the real closing quote misread as still inside it.
      if (c === '\\' && next !== undefined) {
        current += c + next;
        i++;
        continue;
      }
      current += c;
      if (c === "'") quote = null;
      continue;
    }

    // quote === null from here.
    if (c === '\\') {
      // Outside quotes, the next character is escaped: it cannot toggle quote
      // state, and cannot act as a separator/operator either way.
      if (next !== undefined) {
        current += c + next;
        i++;
        continue;
      }
      current += c; // trailing lone backslash: literal, string ends
      continue;
    }
    if (c === '$' && next === "'") {
      // ANSI-C `$'...'` opens here, recognized explicitly: unlike a plain
      // single quote it honours backslash escapes inside, so parsing it as a
      // plain `'...'` span desyncs from bash and can swallow a live separator
      // that actually sits OUTSIDE the quotes (#1034). `$"..."` needs no such
      // case — its `"` opens a real double-quote span either way.
      quote = "$'";
      current += c + next;
      i++;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    // Unquoted newline / carriage return == a command separator. Without this,
    // `git log \ngit push` is one segment that prefix-matches `git log` and the
    // injected `git push` is never examined (shell-injection bypass).
    if (c === ';' || c === '\n' || c === '\r') {
      push(c === ';' ? ';' : 'newline');
      continue;
    }
    if (c === '&' && next === '&') {
      push('&&');
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      push('||');
      i++;
      continue;
    }
    if (c === '|') {
      push('|');
      continue;
    }
    current += c;
  }
  parts.push({ text: current, joiner });
  return parts;
}

/**
 * Compound segments without their joining operators — what every matcher that
 * judges each segment independently wants. Defined in terms of
 * `splitCompoundParts` so the two can never drift apart.
 */
export function splitCompound(command: string): string[] {
  return splitCompoundParts(command).map((p) => p.text);
}

/**
 * What a redirect clause points at, as far as this module is willing to claim.
 *
 * `opaque` is the load-bearing case. `REDIRECT_CLAUSE_RE`'s target is `\S+`,
 * and shell operators need no surrounding whitespace, so ONE match can span a
 * second operator and a second command:
 *
 *     >/tmp/a>/etc/passwd    open `/tmp/a`, then reassign the fd to `/etc/passwd`
 *     >/tmp/a&rm -rf ~       redirect, background it, then `rm -rf ~`
 *
 * A consumer that only asks "is this `/dev/null`?" is safe with that blob,
 * because anything it cannot recognize it rejects. A consumer that asks "may I
 * DELETE this clause?" is not: the deleted text takes the second operator with
 * it, and whatever would have vetoed that operator never sees it. Classifying
 * once, here, is what keeps the two from drifting — the greedy match is not a
 * bug to be fixed at each call site but a fact to be reported honestly at one.
 */
export type RedirectTarget =
  | { readonly kind: 'discard' }
  | { readonly kind: 'fd-dup' }
  | { readonly kind: 'path'; readonly path: string }
  | { readonly kind: 'opaque' };

/** A redirect clause and what it was found to point at. */
export interface RedirectClause {
  /** The whole clause, exactly as it appeared in the segment. */
  readonly text: string;
  readonly target: RedirectTarget;
}

const REDIRECT_CLAUSE_RE = /\d*>>?\s*&?\S+/g;
const REDIRECT_OPERATOR_RE = /^\d*>>?\s*/;

/**
 * Characters a redirect target may contain for it to count as ONE ordinary
 * path. Deliberately an allowlist: a blocklist would have to enumerate every
 * metacharacter that could smuggle a second command past a veto, whereas an
 * allowlist only has to describe a path, and anything it fails to anticipate
 * lands in `opaque` — the conservative side.
 */
const PLAIN_PATH_TARGET_RE = /^[A-Za-z0-9_./~${}=+,:@%^-]+$/;

function classifyRedirectTarget(raw: string): RedirectTarget {
  if (raw === '/dev/null') return { kind: 'discard' };
  if (/^&\d+$/.test(raw)) return { kind: 'fd-dup' };
  if (PLAIN_PATH_TARGET_RE.test(raw)) return { kind: 'path', path: raw };
  return { kind: 'opaque' };
}

/** Every redirect clause in a segment, each with its classified target. */
export function findRedirectClauses(segment: string): RedirectClause[] {
  return [...segment.matchAll(REDIRECT_CLAUSE_RE)].map((m) => ({
    text: m[0],
    target: classifyRedirectTarget(m[0].replace(REDIRECT_OPERATOR_RE, '')),
  }));
}

/**
 * Rewrite each redirect clause via `replace`, which receives the clause's
 * classified target and returns the text to put in its place (return the
 * clause unchanged to leave it alone).
 *
 * Exists so that a caller wanting to REMOVE a clause shares this module's
 * single parse of what a clause is, rather than re-deriving it from a copy of
 * `REDIRECT_CLAUSE_RE`. A copy is how the same defect reached three call sites
 * at once (#1000 review): the pattern is easy to duplicate and its greediness
 * is only safe for one of the two questions callers ask of it.
 */
export function rewriteRedirectClauses(
  segment: string,
  replace: (target: RedirectTarget, text: string) => string,
): string {
  return segment.replace(REDIRECT_CLAUSE_RE, (whole) =>
    replace(classifyRedirectTarget(whole.replace(REDIRECT_OPERATOR_RE, '')), whole),
  );
}

/**
 * Render a same-length view of a segment in which every character that is
 * PROVABLY literal text — inside a quoted span, or the second half of a
 * backslash escape — is replaced by `_`. Everything the function cannot
 * prove is literal is left VISIBLE, unchanged, at its original position.
 *
 * Exists because `hasShellControl` used to run its checks against raw
 * segment text, so `--body "prose with \`code\` and a > sign"` vetoed a `gh
 * issue create` the user had explicitly allowed: the backtick and `>` inside
 * the quoted, escaped prose are not shell metacharacters at all, but a
 * substring search cannot tell the difference (#1023). Masking only ever
 * REMOVES characters that are provably inert; anything it cannot classify
 * stays visible, so it can only shrink the set of segments that veto, never
 * grow it — same philosophy as `shellWords`, applied to the veto instead of
 * the flag/positional checks.
 *
 * Quote handling, matched to real shell semantics:
 *
 *   - single-quoted spans are fully literal: every character inside, and the
 *     quotes themselves, is masked. No escapes exist inside single quotes,
 *     not even for the quote character itself.
 *   - double-quoted spans mask everything EXCEPT an unescaped `$` or
 *     backtick, because those two still substitute inside double quotes
 *     (`"$(rm -rf ~)"` and `` "`x`" `` must keep vetoing). `\$`, `` \` ``,
 *     `\\` and `\"` are escape pairs and are masked whole; a `$` left
 *     visible directly before `(` keeps the `(` visible too, because the
 *     substitution check below matches the two-character substring `$(`,
 *     not a lone `$`.
 *   - outside quotes, a backslash-escaped character is literal and the pair
 *     is masked; everything else stays visible, since that is exactly the
 *     text a real shell would treat as live.
 *
 * A quote that never closes is reported honestly: masking a partial span
 * would be a guess about where it ends, so the function fails closed and
 * returns the segment UNCHANGED — exactly today's quote-blind behavior for
 * that input.
 *
 * The placeholder is `_` on purpose: it is already a member of
 * `PLAIN_PATH_TARGET_RE`, so a masked redirect target (`> "file"` becomes
 * `> ______`) still classifies as a `path` and still vetoes, rather than
 * silently reclassifying to something this module has never seen before.
 */
export function maskQuotedSpans(segment: string): string {
  const n = segment.length;
  const out: string[] = new Array(n);
  let i = 0;

  while (i < n) {
    const c = segment[i];
    if (c === undefined) break;

    if (c === '\\') {
      const next = segment[i + 1];
      if (next === undefined) {
        out[i] = '_';
        i++;
        continue;
      }
      out[i] = '_';
      out[i + 1] = '_';
      i += 2;
      continue;
    }

    if (c === '$' && segment[i + 1] === "'") {
      // ANSI-C `$'...'`: bash honours C-style escapes inside, so `\'` does NOT
      // close — only an UNescaped `'` does (#1034). A plain-single-quote scan
      // ends at the escaped `'` and desyncs, corrupting the mask here and (in
      // `splitCompoundParts`) hiding a live separator. The whole span is a
      // string literal, so mask it all — masking only removes proven-literal
      // text, never a live operator.
      const start = i;
      let j = i + 2;
      while (j < n && segment[j] !== "'") {
        if (segment[j] === '\\' && segment[j + 1] !== undefined) {
          j += 2;
          continue;
        }
        j++;
      }
      if (j >= n) return segment; // unterminated: fail closed
      for (let k = start; k <= j; k++) out[k] = '_';
      i = j + 1;
      continue;
    }

    if (c === "'") {
      const start = i;
      let j = i + 1;
      while (j < n && segment[j] !== "'") j++;
      if (j >= n) return segment; // unterminated: fail closed
      for (let k = start; k <= j; k++) out[k] = '_';
      i = j + 1;
      continue;
    }

    if (c === '"') {
      const start = i;
      let j = i + 1;
      const visible = new Set<number>();
      while (j < n && segment[j] !== '"') {
        const cur = segment[j];
        if (cur === '\\') {
          const next = segment[j + 1];
          if (next !== undefined && ['"', '\\', '$', '`', '\n'].includes(next)) {
            j += 2;
            continue;
          }
          j += 1; // lone backslash: literal, masked; next char judged on its own
          continue;
        }
        if (cur === '$' || cur === '`') visible.add(j);
        j++;
      }
      if (j >= n) return segment; // unterminated: fail closed
      for (let k = start; k <= j; k++) out[k] = visible.has(k) ? (segment[k] ?? '_') : '_';
      i = j + 1;
      continue;
    }

    out[i] = c;
    i++;
  }

  // A `$` left visible directly before `(` keeps the `(` visible too: the
  // substitution check matches the substring `$(`, and a lone `$` with its
  // paren masked would silently defeat it.
  for (let k = 0; k < n - 1; k++) {
    if (out[k] === '$' && segment[k + 1] === '(') out[k + 1] = '(';
  }

  return out.join('');
}

/**
 * True if the segment carries shell control that could escape the matched
 * prefix.
 *
 * Runs against a `maskQuotedSpans` view rather than the raw segment (#1023):
 * quoted, escaped prose (a `--body` that mentions a backtick, a `>`
 * comparison, an `&` ampersand) is not shell control, and checking the raw
 * text could not tell the difference from the real thing. Masking only
 * removes characters proven literal, so an actual `$(...)`, backtick,
 * `<(...)`, backgrounding `&`, or non-`/dev/null` redirect is exactly as
 * visible after masking as before, and still vetoes.
 */
export function hasShellControl(segment: string): boolean {
  const masked = maskQuotedSpans(segment);
  // Command / process substitution.
  if (masked.includes('$(') || masked.includes('`') || masked.includes('<(')) {
    return true;
  }
  // Backgrounding / control operator: a lone `&` anywhere that is not part of
  // `&&` (already split out), an fd-dup (`2>&1`, `>&2`), nor an `&>` redirect
  // (caught as redirection below). Catches `cmd &`, `cmd & other`, `a&b`.
  if (/(^|[^&>])&(?![&>0-9])/.test(masked)) {
    return true;
  }
  // Output redirection to anything other than /dev/null or an fd dup (2>&1).
  // `path` and `opaque` both veto, so this is unchanged by the classifier: it
  // recognizes exactly the two safe shapes and refuses everything else.
  for (const clause of findRedirectClauses(masked)) {
    if (clause.target.kind !== 'discard' && clause.target.kind !== 'fd-dup') {
      return true;
    }
  }
  return false;
}

/** Word-boundary prefix match: `seg === p` or `seg` starts with `p + ' '`. */
export function matchPrefix(segment: string, prefixes: readonly string[]): string | null {
  let best: string | null = null;
  for (const p of prefixes) {
    if (segment === p || segment.startsWith(`${p} `)) {
      // Prefer the longest (most specific) match for clearer logging.
      if (best === null || p.length > best.length) best = p;
    }
  }
  return best;
}

/**
 * Flags that turn a command into a DIFFERENT command.
 *
 * These are not mutation flags, and the distinction is the whole point. A user
 * who allows `biome check --fix` means the write; a user who allows `find` does
 * not mean `find . -exec rm -rf {} +`. `-exec` does not make `find` write, it
 * makes `find` run something else, so approving it approves an argument the
 * user never saw. That is the #536 bug one level down, at the argument list
 * instead of the tool name, and it is why this veto applies to the user allow
 * path even though the mutation-flag veto deliberately does not.
 *
 * Long options only, or short ones that no read form of any command uses.
 * Overloaded short flags (`-e`, `-c`, `-i`) live in the family-scoped list
 * below, because vetoing them globally would break `grep -e` and friends.
 */
const EXEC_PRIMITIVE_TOKEN =
  /(^|\s)(-exec|-execdir|-ok|-okdir|-delete|-fprintf|-fprint|-fprint0|-fls|--to-command|--use-compress-program|--rmt-command|--rsh-command|--checkpoint-action|--preload|--require|--eval|--exec)(\s|=|$)/;

/**
 * Walk `words` from `fromIndex`, skipping recognised flags (and, for a flag
 * in `valueFlags`, its separate value token too), and return the index of
 * the first non-flag token found — the actual subcommand once global flags
 * are skipped past. Returns -1 if every remaining token is a flag.
 *
 * Moved here from `risk-bands.ts` (#1057 phase 3, commit 4) so
 * `hasExecPrimitive`'s git `-c` veto (below) can share the SAME subcommand
 * walk `risk-bands.ts` already uses for its own git/gh checks, rather than a
 * second one that could disagree with it (#1000's law: two walks of the same
 * question must never be able to drift). This module cannot import FROM
 * `risk-bands.ts` — that module already imports `hasExecPrimitive` and
 * friends from here, and the reverse would be a cycle — so the shared
 * primitive lives on this side and `risk-bands.ts` imports it back.
 */
export function skipFlags(
  words: readonly string[],
  fromIndex: number,
  valueFlags: ReadonlySet<string>,
): number {
  let i = fromIndex;
  while (i < words.length) {
    const token = words[i] ?? '';
    if (!token.startsWith('-')) return i;
    i++;
    if (valueFlags.has(token)) i++;
  }
  return -1;
}

/** Global git flags that take a separate value token (not exhaustive — see `skipFlags`'s doc). */
export const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
]);

/** Index of `git`'s subcommand (`push`, `status`, ...), skipping global flags, or -1. */
export function gitSubcommandIndex(words: readonly string[]): number {
  if (words[0] !== 'git') return -1;
  return skipFlags(words, 1, GIT_GLOBAL_VALUE_FLAGS);
}

/** Global gh flags that take a separate value token. */
const GH_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(['--repo', '-R', '--hostname']);

/** Index of `gh`'s top-level subcommand (`pr`, `issue`, `api`, ...), skipping global flags, or -1. */
export function ghTopIndex(words: readonly string[]): number {
  if (words[0] !== 'gh') return -1;
  return skipFlags(words, 1, GH_GLOBAL_VALUE_FLAGS);
}

/**
 * `git -c <key>=<value> <subcommand>` runs arbitrary code (`core.hooksPath`,
 * `core.fsmonitor`, ...) before the subcommand ever starts. `git switch -c
 * <name>` and `git commit -c <commit>` reuse the SAME letter for an entirely
 * unrelated, harmless, SUBCOMMAND-level flag (#962). A raw-text regex cannot
 * tell those apart from presence alone — `EXEC_SCOPED_VETOES`'s uniform
 * `(family, flag-regex)` shape below is exactly that, presence-only — so git
 * is the one family that needs a token walk instead of an entry in that list,
 * scoped by `gitSubcommandIndex` (shared with `risk-bands.ts`, never a second
 * independent derivation of "where is the subcommand").
 *
 * git's own parser draws the identical line: a global option like `-c` is
 * only recognised BEFORE the first non-option argument (the subcommand);
 * everything from there on belongs to the subcommand's own parser, which may
 * give the same letter a completely different meaning, or none at all. So a
 * `-c` strictly before `gitSubcommandIndex` — or anywhere at all when no
 * subcommand token exists (an all-flags command, including a bare trailing
 * `git -c`, where `gitSubcommandIndex` returns -1) — is the exec primitive;
 * a `-c` at or after it is not, REGARDLESS of whether that particular
 * subcommand happens to define `-c` for itself. (`git worktree add`, for
 * instance, has no `-c` of its own — verified via `git worktree add -h` — so
 * `-c` there is simply an invalid option git will reject at parse time; that
 * is a usability non-event, not a bypass, because git never reaches the
 * global config-injection code path for a flag positioned after the
 * subcommand it already committed to.)
 *
 * A token "carries" `-c` when it is: the standalone token `-c`; a
 * `=`-attached `-c=value` (real git takes the value as a SEPARATE token, but
 * matching the glued spelling too costs nothing and errs the safe direction,
 * ADR 0010); or `c` bundled into a short-option cluster with other
 * single-dash letters (`-uc`). Over-matching a shape git would itself reject
 * is fine — this function only ever REFUSES on a match, so a false positive
 * costs an extra escalation, never a wrongly-approved command.
 */
function hasPreSubcommandGitDashC(segment: string): boolean {
  if (!/^git\b/.test(segment)) return false;
  const words = shellWords(segment);
  const subIdx = gitSubcommandIndex(words);
  const end = subIdx === -1 ? words.length : subIdx;
  for (let i = 1; i < end; i++) {
    const token = words[i] ?? '';
    if (token === '-c' || token.startsWith('-c=')) return true;
    if (/^-[A-Za-z]+$/.test(token) && token.includes('c')) return true;
  }
  return false;
}

/**
 * Command families whose read form is flipped to code execution by a flag that
 * is harmless elsewhere, so the veto has to know which command it is looking at.
 *
 * git is deliberately NOT an entry here (#962) — see `hasPreSubcommandGitDashC`
 * above for why it alone needs token position rather than a raw-text regex.
 * Every other family keeps the original presence-only shape.
 */
const EXEC_SCOPED_VETOES: ReadonlyArray<{ family: RegExp; flag: RegExp }> = [
  // awk's program text can call system() or pipe into a shell.
  { family: /^(g|m|n)?awk\b/, flag: /(system\s*\(|\|\s*&?\s*"?\s*(sh|bash|zsh)\b|print\s*\|)/ },
  // `rsync -e 'sh -c ...'` / `--rsh` runs the "remote shell" locally.
  { family: /^rsync\b/, flag: /(^|\s)(-e|--rsh)(\s|=)/ },
  // ssh/scp run a command on the far side, and ProxyCommand/LocalCommand run
  // one on THIS side.
  { family: /^(ssh|scp|sftp)\b/, flag: /(^|\s)-o\s*(Proxy|Local)Command/i },
];

/** True if a segment carries a code-execution primitive. */
export function hasExecPrimitive(segment: string): boolean {
  if (EXEC_PRIMITIVE_TOKEN.test(segment)) return true;
  if (hasPreSubcommandGitDashC(segment)) return true;
  for (const { family, flag } of EXEC_SCOPED_VETOES) {
    if (family.test(segment) && flag.test(segment)) return true;
  }
  return false;
}

/**
 * Decide whether a Bash command is fully covered by the given prefixes.
 * Returns the (most specific) matched prefix, or null to fall through.
 *
 * A command is covered only when EVERY compound segment is either neutral
 * (cd/pwd/echo/...) or matches a prefix, none carries shell control or a
 * code-execution primitive, and at least one segment actually matched a prefix
 * (a command of only neutral segments has not matched anything).
 *
 * @param extraVeto Optional per-segment veto layered on top of the shell-control
 *   and exec-primitive checks. The group matcher passes its curated-read
 *   mutation vetoes here; the user allow list passes nothing, because a user
 *   may legitimately allow a write.
 * @param vetoForMatched Optional veto for a segment that MATCHED a prefix,
 *   receiving the prefix it matched (#957). `extraVeto` cannot express this:
 *   it runs before `matchPrefix`, so it has no way to know which curated entry
 *   covered the segment, and therefore has to apply one blanket rule to every
 *   segment in the command. That is correct while every curated entry is
 *   read-only — "none of those tokens legitimately appears in a curated read
 *   command" (`permission-groups.ts`) — and wrong the moment a group is
 *   SUPPOSED to mutate, because the blanket rule vetoes it by construction.
 *   When supplied, this replaces `extraVeto` for matched segments only;
 *   NEUTRAL segments keep `extraVeto` regardless, since `cd`/`echo` carrying
 *   `--write` is suspicious no matter which group covered the rest of the
 *   command. Callers that omit it get the same RETURN VALUE as before for
 *   every input. Note the scope of that claim: `extraVeto` is no longer
 *   *called* for a segment that is neither neutral nor matches any prefix,
 *   because the no-match branch now returns first. Both shipped predicates are
 *   pure, so this is invisible today — but it is a claim about return values,
 *   not about invocation, and a side-effecting veto would notice.
 */
export function matchCoveredCommand(
  command: string,
  prefixes: readonly string[],
  extraVeto?: (segment: string, index: number) => boolean,
  vetoForMatched?: (segment: string, matchedPrefix: string, index: number) => boolean,
): string | null {
  const segments = splitCompound(command);
  let matched: string | null = null;
  // Both vetoes receive the segment's INDEX in this split alongside its text.
  // A veto whose judgement depends on where in the command the segment sits
  // (`scratch`, which must know the directory the shell had reached by then)
  // would otherwise have to re-derive that by walking the command a second
  // time, and a second walk that disagrees with this one is a bypass.
  for (const [index, raw] of segments.entries()) {
    const seg = raw.trim();
    if (seg === '') continue;
    // On the ORIGINAL segment, before any grammar is removed: whatever a
    // keyword introduces, it cannot make a redirect or a `&` safe. `seg` is
    // NOT the raw segment by the time `hasShellControl` sees it — it masks
    // quoted/escaped spans first (#1023) — but no grammar keyword has been
    // peeled off, which is the property this comment is guarding.
    if (hasShellControl(seg)) return null;
    // Shell grammar is peeled off so the command inside is judged on its own
    // merits (#999). `body` is what actually runs; a segment that is pure
    // grammar runs nothing and needs no coverage.
    const stripped = stripShellGrammar(seg);
    if (stripped.structural) continue;
    const body = stripped.command;
    if (matchPrefix(body, NEUTRAL_PREFIXES) !== null) {
      // Neutral segments are vetoed before they can be waved through. Ordering
      // note: `extraVeto` used to run ahead of this neutral check for EVERY
      // segment, so moving it inside is behavior-preserving only because a
      // vetoed non-neutral segment still returns null below — via its own veto
      // if it matches, or via the no-match branch if it does not.
      if (extraVeto?.(body, index)) return null;
      continue;
    }
    const hit = matchPrefix(body, prefixes);
    if (hit === null) return null;
    const vetoed = vetoForMatched
      ? vetoForMatched(body, hit, index)
      : (extraVeto?.(body, index) ?? false);
    if (vetoed) return null;
    // Veto a code-execution primitive UNLESS the matched entry already carries
    // it. A prefix match requires the segment to start with the entry, so an
    // entry containing `-exec` only matches a command the user spelled out that
    // far: they saw it and approved it. An entry of just `find` did not.
    if (hasExecPrimitive(seg) && !hasExecPrimitive(hit)) return null;
    if (matched === null) matched = hit;
  }
  return matched;
}

/**
 * Split a single command segment into shell WORDS, performing real quote and
 * escape removal (#960 second review).
 *
 * This exists because three separate vetoes were each written to reason about
 * raw command TEXT, each hand-rolled its own quote handling, and each got it
 * wrong in a different way. Every one of these auto-approved at 0ms:
 *
 *     curl -"o" out.txt url        -> real argv [-o] [out.txt] [url]
 *     curl -sS"o" out.txt url      -> real argv [-sSo] ...
 *     curl --o\utput out.txt url   -> real argv [--output] ...
 *     cp evil /et"c"/cron.d/task   -> real argv [...] [/etc/cron.d/task]
 *     tee ~/."remi"/config.toml    -> real argv [/Users/x/.remi/config.toml]
 *     git checkout "."             -> real argv [git] [checkout] [.]
 *
 * The shell does not see quotes as part of the word; it removes them and
 * CONCATENATES adjacent quoted, unquoted and escaped spans into one argument.
 * Any check that matches against the raw text is therefore matching a string
 * the program being run will never receive, and one embedded quote or
 * backslash defeats it. That is not a family of bugs to patch individually —
 * it is one missing primitive, so it is implemented once here and every
 * consumer runs against the result.
 *
 * Deliberately does NOT expand variables, globs, command substitution, or
 * brace expansion. Those are unknowable statically, and `hasShellControl`
 * already refuses a segment containing substitution outright — so a word
 * reaching this function cannot contain one.
 */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;

  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];

    if (c === undefined) break;

    if (c === '\\') {
      // Backslash escapes the next character, and the backslash itself is
      // removed. `--o\utput` is the word `--output`.
      const next = segment[i + 1];
      if (next !== undefined) {
        current += next;
        started = true;
        i++;
      }
      continue;
    }

    if (c === "'") {
      // Single quotes are fully literal: no escapes, ends at the next quote.
      started = true;
      i++;
      while (i < segment.length && segment[i] !== "'") {
        current += segment[i];
        i++;
      }
      continue;
    }

    if (c === '"') {
      // Double quotes honour backslash escapes for a small set of characters;
      // every other backslash is literal.
      started = true;
      i++;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === '\\') {
          const next = segment[i + 1];
          if (next !== undefined && ['"', '\\', '$', '`', '\n'].includes(next)) {
            current += next;
            i += 2;
            continue;
          }
        }
        current += segment[i];
        i++;
      }
      continue;
    }

    if (c === '$' && segment[i + 1] === '"') {
      // Locale/gettext quoting (`$"..."`). bash strips BOTH the `$` and the
      // quotes, so `$"--force"` is the word `--force`. Missing this case left
      // the `$` glued to the front of the token, which broke every check that
      // asks whether a word STARTS WITH `-` or EQUALS `.` — i.e. the entire
      // flag allowlist and the positional veto. `git checkout $"--force"` and
      // `mkdir $"-m" 777` were auto-approved (#960 round 3).
      //
      // Handled as double-quoted content, since that is what it is: the `$`
      // only marks it for translation.
      started = true;
      i += 2;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === '\\') {
          const next = segment[i + 1];
          if (next !== undefined && ['"', '\\', '$', '`', '\n'].includes(next)) {
            current += next;
            i += 2;
            continue;
          }
        }
        current += segment[i];
        i++;
      }
      continue;
    }

    if (c === '$' && segment[i + 1] === "'") {
      // ANSI-C quoting (`$'...'`). Treated as literal contents rather than
      // decoding every escape: the point here is that the QUOTES vanish, so a
      // flag hidden inside one is seen. Under-decoding an escape can only
      // produce a longer, stranger word, never a shorter safe-looking one.
      started = true;
      i += 2;
      while (i < segment.length && segment[i] !== "'") {
        if (segment[i] === '\\' && segment[i + 1] !== undefined) {
          current += segment[i + 1];
          i += 2;
          continue;
        }
        current += segment[i];
        i++;
      }
      continue;
    }

    if (/\s/.test(c)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += c;
    started = true;
  }

  if (started) words.push(current);
  return words;
}
