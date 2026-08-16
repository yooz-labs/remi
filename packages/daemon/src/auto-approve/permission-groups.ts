/**
 * Built-in permission groups for auto-approve (epic #494).
 *
 * A group is a named, curated set of read-by-definition operations that can be
 * approved WITHOUT calling the LLM. Users opt in/out by group via
 * `[auto_approve] approve_groups` / `deny_groups` in config.toml.
 *
 * Safety model:
 *  - Bash commands are matched per compound-segment (split on && || ; |).
 *  - Each non-neutral segment must word-boundary-prefix-match a curated read
 *    prefix from the requested groups; otherwise the WHOLE command falls
 *    through to the LLM. Conservative by design: a false negative (a read the
 *    LLM still evaluates) is fine; a false positive (group-approving a write)
 *    is not.
 *  - A veto rejects any segment carrying shell control (command substitution,
 *    output redirection to a real file, backgrounding) or an unambiguous
 *    mutation flag (`-X`, `--field`, `--write`, `--fix`, `-delete`, ...). None
 *    of those tokens legitimately appears in a curated read command, so the
 *    veto can only catch a write that slipped past a read prefix.
 *  - Commands whose read form can be flipped to a write by an AMBIGUOUS short
 *    flag are EXCLUDED from the curated set whenever no veto already closes
 *    that specific flag: `sort -o`, `gh api -X`. `find -delete` and `awk`
 *    system()/pipe-to-shell are the opposite shape (#1057 phase 3, commit 3)
 *    — the bare command IS curated, because `shell-safety.ts`'s
 *    `hasExecPrimitive` already refuses exactly the dangerous forms
 *    (`EXEC_PRIMITIVE_TOKEN` for `-delete`/`-exec`/..., `EXEC_SCOPED_VETOES`
 *    for awk's `system()`/pipe-to-shell), consulted by `matchCoveredCommand`
 *    for every matched segment regardless of which group owns the prefix.
 *    `sort -o` has no such veto and stays excluded; the two are not
 *    interchangeable, and a future addition must check which shape it is
 *    before assuming either precedent applies. Users can add an excluded
 *    command via the `allow` list at their own discretion (per-segment
 *    prefix, not substring).
 *  - Non-Bash tools match by bare tool name.
 *
 * The segment splitter and shell-control veto live in `shell-safety.ts`; the
 * user allow list uses the same primitives (#536).
 */

import { looksLikeToolName } from './pattern-matcher.ts';
import { COMMAND_WRAPPERS, SHELL_C_BINARIES } from './risk-bands.ts';
import {
  isSensitiveWritePath,
  resolveDotDot,
  segmentTouchesSensitivePath,
} from './sensitive-paths.ts';
import {
  type CompoundJoiner,
  maskQuotedSpans,
  matchCoveredCommand,
  matchPrefix,
  rewriteRedirectClauses,
  shellWords,
  splitCompoundParts,
  stripShellGrammar,
} from './shell-safety.ts';
import { hasUnsafeWriteFlag } from './write-flag-safety.ts';

/**
 * Positional forms that are destructive without carrying any flag at all, so
 * `write-flag-safety.ts` cannot see them.
 *
 * `git checkout .` and `git checkout -- <path>` DISCARD uncommitted work
 * irreversibly. The branch-switch forms are what `vcs-write` is for.
 */
const WRITE_GROUP_POSITIONAL_VETOES: ReadonlyArray<{ family: RegExp; words: readonly string[] }> = [
  { family: /^git\s+(checkout|restore)\b/, words: ['.', '--'] },
  // #972: `git stash` is listed as a bare prefix so the plain form (which IS
  // `git stash push`) and `git stash pop` are covered. Word-boundary prefix
  // matching then also covers `git stash drop` and `git stash clear`, which
  // DISCARD stashed work irrecoverably — `clear` drops every stash at once.
  // Those two are refused here rather than by omitting the prefix, because the
  // matcher cannot express "exactly `git stash`" (`matchPrefix` accepts the
  // exact segment OR anything starting with `prefix + ' '`).
  { family: /^git\s+stash\b/, words: ['drop', 'clear'] },
];

/**
 * True if a destructive positional form applies to this segment.
 *
 * Matches against TOKENIZED words, not raw text (#960 second review). The
 * first cut used `/(^|\s)\.(\s|$)/`, which requires the `.` to be
 * whitespace-bounded in the source string — so `git checkout "."` sailed
 * through and irreversibly discarded uncommitted work, while the identical
 * `git checkout .` was correctly refused. `shellWords` removes the quotes
 * first, so both are now the same single word `.` and both are refused.
 */
function hasWriteGroupPositionalVeto(segment: string): boolean {
  for (const { family, words } of WRITE_GROUP_POSITIONAL_VETOES) {
    if (!family.test(segment)) continue;
    for (const word of shellWords(segment)) {
      if (words.includes(word)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// `sed -i` under a strict script-shape allowlist (#1057 phase 2, commit 4).
// Placed here, in `permission-groups.ts` alongside the rest of fs-write's
// veto plumbing, rather than in `write-flag-safety.ts`: the flag axis there
// answers "is every FLAG safe", but what a permitted sed SCRIPT is allowed
// to say is a shape no flag-letter allowlist can express, and it needs to
// interact with `hasUnsafeWriteFlag`'s call site to normalize `-i`'s attached
// suffix first (see `normalizeSedInPlaceSuffix`) -- both are decisions this
// file already owns for every other write prefix (`artifactCleanVeto`,
// `scratchTargetVeto`).
// ---------------------------------------------------------------------------

/**
 * `sed -i` accepts an attached backup suffix with no separator (`-i.bak`).
 * `write-flag-safety.ts`'s short-option scan checks every alphabetic
 * character of a `-`-prefixed token as a possible flag letter (by design —
 * see that module's doc), so an unnormalized `.bak` would need ITS OWN
 * letters on the safe list, which is not what that list means. Normalizes
 * every `-i<suffix>` token on a `sed` segment to bare `-i` before handing it
 * to `hasUnsafeWriteFlag`; every other token, and every non-sed segment,
 * passes through untouched.
 *
 * This is also exactly correct GNU getopt semantics, not a hack: `-i` takes
 * an OPTIONAL argument, so once it appears, getopt consumes the REST of that
 * token as its value regardless of what letters are in it — `-in` really is
 * `-i` with suffix `n`, not `-i -n`. The suffix's own SHAPE (must contain no
 * path separator or `*`) is verified independently by `sedScriptShapeVeto`,
 * which sees the original, unnormalized token.
 */
function normalizeSedInPlaceSuffix(segment: string): string {
  if (!/^sed\b/.test(segment)) return segment;
  return shellWords(segment)
    .map((w) => (/^-i.+$/.test(w) ? '-i' : w))
    .join(' ');
}

/**
 * Split `text` on UNESCAPED occurrences of the single delimiter character
 * `d`: a `d` preceded by a backslash is literal and does not split, and the
 * backslash+`d` pair is kept verbatim in the field (exactly as sed's own
 * parser would see it — this function only needs to find the field
 * boundaries, not unescape their contents).
 */
function splitOnUnescapedDelimiter(text: string, d: string): string[] {
  const fields: string[] = [];
  let current = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) {
      current += c + text[i + 1];
      i++;
      continue;
    }
    if (c === d) {
      fields.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  fields.push(current);
  return fields;
}

/**
 * True if `script` is EXACTLY one `s<D>...<D>...<D>[gIp0-9]*` or
 * `y<D>...<D>...<D>` sed command — `D` any single non-alphanumeric,
 * non-backslash delimiter, the three delimited fields containing no
 * unescaped `D`. Anything else fails closed: an address prefix (`/re/s///`,
 * `1,5s///`) and a brace block both fail the leading-letter check below (the
 * first character is not literally `s`/`y`); a trailing side-command
 * (`w file`, `W`, `e`, `r`, `R`) fails the `y`'s empty-trailer or the `s`'s
 * `[gIp0-9]*` check.
 *
 * The explicit `;`-inclusion check is NOT what catches a `;`-chained second
 * command appended after the closing delimiter — the field-count and
 * trailing-class checks already do, on their own: appending `; rm -rf /` (or
 * any other chained command) after a real `s///`/`y///` script inserts an
 * extra unescaped delimiter-free field, so `splitOnUnescapedDelimiter` no
 * longer returns exactly 4 fields and the shape fails regardless. What the
 * `;` check's own presence UNIQUELY refuses is `;` used AS THE DELIMITER
 * itself (`s;a;b;g`) — a shape that genuinely passes the field-count and
 * trailing-class checks on its own (4 fields, trailing `g`) and is refused
 * ONLY because this line runs first. It is kept, conservative, for a second
 * reason beyond that one refusal: it makes "this script contains no chained
 * command" a property auditable by reading ONE line, rather than by trusting
 * the delimiter-counting math above to have no adversarial case left in it.
 */
function sedScriptShapeOk(script: string): boolean {
  if (script.includes(';')) return false;
  const cmd = script[0];
  if (cmd !== 's' && cmd !== 'y') return false;
  const d = script[1];
  if (d === undefined || d === '\\' || /[A-Za-z0-9]/.test(d)) return false;
  const fields = splitOnUnescapedDelimiter(script.slice(1), d);
  if (fields.length !== 4) return false;
  const trailing = fields[3] ?? '';
  return cmd === 'y' ? trailing === '' : /^[gIp0-9]*$/.test(trailing);
}

/**
 * Script-shape veto for a `sed` segment: every script the command would
 * actually run — the bare positional script, or each `-e`/`--expression`
 * value — must pass `sedScriptShapeOk`. A `-f`/`--file` script (loaded from
 * an arbitrary external file) is not modeled here at all, because it is
 * already refused by the flag axis (`-f`/`--file` are not on `sed`'s safe
 * list in `write-flag-safety.ts`) before this veto's verdict can matter.
 *
 * `-i`'s own backup-suffix VALUE gets a second, independent check here, on
 * the ORIGINAL (unnormalized) token: a suffix containing `/` or `*` can
 * redirect GNU sed's backup to an arbitrary path (sed expands `*` to the
 * target's own name and treats the result as a path), which is a
 * destination-axis bypass `segmentTouchesSensitivePath` never sees — the
 * suffix is a flag VALUE, not the command's final file argument.
 *
 * BOTH branches below that check this suffix (the attached `-i<suffix>` form
 * and `--in-place=<suffix>`) are UNREACHABLE through the actual group-match
 * path today, probe-verified: `matchPrefix` (shell-safety.ts) requires the
 * curated `sed -i` prefix to be followed by a literal SPACE
 * (`segment.startsWith('sed -i ')`), which neither attached spelling
 * satisfies — an attached, glob-carrying `-i` suffix quoted directly onto the
 * flag does not start with `sed -i ` (the character right after `-i` is a
 * quote, not a space), and `sed --in-place=... ...` does not start with
 * `sed -i ` at all. Both fall
 * through UNMATCHED before this function, or any veto, is ever reached — see
 * the "documented residual" test block and the residuals comment above
 * `sedScriptShapeVeto`'s call site for the same limit stated from the
 * `matchPrefix` side. The branches are kept anyway, as defense-in-depth for
 * the day attached-suffix prefix matching is added (the ADR 0026 residual):
 * removing them now would silently reopen this exact bypass the moment that
 * prefix-matching gap closes. Reached directly by calling this exported
 * function with a crafted segment in tests, since the group path cannot
 * reach them today.
 *
 * Exported for tests ONLY (mirrors `MUTATION_TOKEN`'s convention above): the
 * two branches this comment describes have no OTHER way to be exercised
 * while `matchPrefix`'s space requirement stands.
 */
export function sedScriptShapeVeto(segment: string): boolean {
  if (!/^sed\b/.test(segment)) return false;
  const words = shellWords(segment);
  const hasScriptFlag = words.some(
    (w) => w === '-e' || w === '--expression' || w.startsWith('--expression='),
  );
  let positionalConsumed = false;
  for (let i = 1; i < words.length; i++) {
    const w = words[i] as string;
    if (w === '') continue;
    if (w === '-i' || /^-i.+$/.test(w)) {
      const suffix = w === '-i' ? '' : w.slice(2);
      if (!/^[A-Za-z0-9._-]*$/.test(suffix)) return true;
      if (w === '-i' && words[i + 1] === '') i++; // BSD `-i ''`: consume the empty suffix
      continue;
    }
    if (w === '--in-place' || w.startsWith('--in-place=')) {
      const suffix = w.startsWith('--in-place=') ? w.slice('--in-place='.length) : '';
      if (!/^[A-Za-z0-9._-]*$/.test(suffix)) return true;
      continue;
    }
    if (w === '-e' || w === '--expression') {
      const script = words[i + 1];
      if (script === undefined || !sedScriptShapeOk(script)) return true;
      i++;
      continue;
    }
    if (w.startsWith('--expression=')) {
      if (!sedScriptShapeOk(w.slice('--expression='.length))) return true;
      continue;
    }
    // Every other flag this family allows takes no argument; an unrecognized
    // one is the flag axis's job, not this veto's.
    if (w.startsWith('-')) continue;
    // The bare positional script -- only the FIRST such token, and only when
    // no `-e`/`--expression` supplied one instead; every later positional is
    // a FILE argument (covered independently by `segmentTouchesSensitivePath`).
    if (!hasScriptFlag && !positionalConsumed) {
      positionalConsumed = true;
      if (!sedScriptShapeOk(w)) return true;
    }
  }
  return false;
}

/**
 * Two residuals, DECLARED rather than open bugs, mirroring how `scratch` and
 * `artifact-clean` document their own honest limits above.
 *
 * 1. `matchPrefix` (shell-safety.ts) requires the curated prefix to be
 *    followed by a literal SPACE (`segment === p || segment.startsWith(p +
 *    ' ')`), which is exactly right for every OTHER prefix in this file but
 *    cannot match GNU's ATTACHED `-i` suffix spelling: `sed -i.bak 's/a/b/'
 *    f` does not start with `sed -i ` (the fifth character after `-i` is
 *    `.`, not a space), so it never reaches `sedScriptShapeVeto` at all --
 *    the whole command falls through UNMATCHED. Verified, not assumed:
 *    `sed -i.bak 's/a/b/' f` returns null under every group. Fixing this
 *    would mean rewriting the command text before prefix-matching runs (the
 *    same shape of pre-pass `sanitizeCommandForRedirectGrants` and
 *    `exciseHeredocsForGroups` use), and doing so safely requires the
 *    downstream veto to agree on which token is the suffix versus the
 *    script -- a second, independent walk that must never disagree with the
 *    first (#1000's law) for a feature already safe on its escalate side.
 *    Descoped rather than built under time pressure; the fallback is
 *    unconditionally safe (escalate to the LLM), never unsafe.
 * 2. This veto's `-i`/`-e` token walk assumes GNU getopt semantics
 *    throughout (a bare `-i` takes no argument unless one is attached in
 *    the SAME token; a BSD-style separate, non-empty suffix argument is not
 *    recognized). Real BSD/macOS sed disagrees: its `-i` MANDATORILY
 *    consumes the very next token as the backup suffix, so
 *    `sed -i 's/a/b/' file` -- this file's own first positive example --
 *    would, on a real BSD sed, use `'s/a/b/'` as the suffix and `file` as
 *    the (almost certainly invalid) script. This matcher cannot know which
 *    `sed` a bare `$PATH` lookup will resolve to, and there is no shape
 *    that reads identically under both getopt conventions once anything
 *    beyond a bare `-i ''` is involved -- the "BSD/GNU `-i` ambiguity ... at
 *    the token layer" this feature's design brief named as a legitimate
 *    stop condition. Accepted rather than solved because it is not a
 *    SAFETY gap: the divergent (BSD) reading fails closed on its own --
 *    sed errors out on a bogus script, or at worst writes a confusingly
 *    named backup -- never a sensitive-destination write or code execution,
 *    which remains this veto's only chartered property.
 */

/**
 * Every group that can MUTATE the filesystem, and therefore every group whose
 * matches must clear the sensitive-destination axis (`sensitive-paths.ts`).
 *
 * Consulted by `matchGroups`'s per-owner dispatch, because that dispatch is a
 * UNION: a prefix owned by two groups is approved when EITHER proof holds, so
 * the axis cannot live only inside one owner's veto or the other owner is a
 * way around it. That is not hypothetical — it is what the ADR 0023
 * adversarial pass found: `cp`/`mv`/`mkdir`/`touch`/`tee` are owned by both
 * `fs-write` and `scratch`, and `scratchTargetVeto` never checked sensitive
 * paths, so `cp /tmp/a /tmp/.env` approved at `balanced` where develop
 * escalated it.
 *
 * A new mutating group MUST be added here, and NOTHING CATCHES YOU IF YOU
 * FORGET. An earlier version of this comment claimed
 * `permission-groups.test.ts`'s per-group cases did. Measured, and all three
 * clauses were wrong: those cases live in `artifact-clean.test.ts`, not here;
 * removing `'artifact-clean'` from this set flips no test; and removing
 * `'fs-write'` flips none either, because its own `writeGroupVeto` re-checks
 * the axis independently. Only `'scratch'` is genuinely pinned (10 failures) —
 * it is the one group with no second copy of the check.
 *
 * The two checks masking each other is the real hazard: drop
 * `isProvedArtifactTarget`'s `isSensitiveWritePath` call alone and nothing
 * moves; drop `'artifact-clean'` here alone and nothing moves; drop BOTH and
 * `rm -rf dist/.env` approves at 0ms. Deliberate defence in depth, but it means
 * neither half is individually load-bearing in the test suite, so read a green
 * run as evidence about the PAIR and not about either member.
 *
 * The stated invariant is also weaker than the load-bearing one. What actually
 * prevents the escape is: every group sharing a PREFIX with a mutating group
 * must be in this set. A future non-mutating group that happened to list `cp`
 * would route around the axis without ever looking like a "mutating group".
 * No live instance today — the seven current groups' mutating and non-mutating
 * halves share no prefix — so this is a note on the comment, not on the code.
 */
const MUTATING_GROUPS: ReadonlySet<string> = new Set([
  'fs-write',
  'vcs-write',
  'scratch',
  'artifact-clean',
]);

/**
 * The veto profile every write-side group shares: the flag boundaries above,
 * plus the sensitive-destination axis a read group never needed
 * (`sensitive-paths.ts`).
 */
function writeGroupVeto(segment: string): boolean {
  return (
    hasUnsafeWriteFlag(normalizeSedInPlaceSuffix(segment)) ||
    hasWriteGroupPositionalVeto(segment) ||
    segmentTouchesSensitivePath(segment) ||
    sedScriptShapeVeto(segment)
  );
}

// ---------------------------------------------------------------------------
// `scratch` group (owner request: "basically any work in /tmp scratch is
// allowed", specifically that scratch deletes stop escalating under #994's
// risk ceiling). A command matches ONLY when every file target it touches
// provably resolves under a scratch root: `/tmp/...`, `/private/tmp/...`
// (macOS's real path for `/tmp`), `$TMPDIR/...`, `${TMPDIR}/...`.
//
// A second, independent redirect grant lives in this same machinery:
// `fs-write` (#1041 — 58% of trusted Bash escalations measured were plain
// file writes). `cat a.txt > notes.md`, `bun test > out.log 2>&1` and
// `git diff > review.diff` are read-side prefixes owned by OTHER groups
// (`read-only`, `build-test`, `vcs-read`) whose output redirect targets a
// RELATIVE, non-ascending, non-sensitive destination — exactly the operation
// `fs-write` already approves through the `Write` tool. `fs-write` itself
// never grants an ABSOLUTE target or one reached through an unprovable `cd`;
// that is scratch's grant to make, not this one's, and the two compose (a
// clause deletable by either grant is deleted).
//
// Neither grant is expressed as a stateless `PermissionGroup.segmentVeto` the
// way `fs-write`/`vcs-write`'s own prefix-matched segments are. Two things
// they need that a pure `(segment) => boolean` cannot express:
//
//   - A leading `cd` must make later RELATIVE targets in the SAME compound
//     command count as rooted (scratch's real traffic:
//     `cd /private/tmp/.../scratchpad && <work>`; fs-write's:
//     `cd sub && cat a > out.txt`). That is state carried ACROSS segments, in
//     order, which `matchCoveredCommand`'s per-segment veto hooks do not
//     thread through.
//   - `hasShellControl` (shell-safety.ts) vetoes ANY non-`/dev/null` output
//     redirect unconditionally, for every group, and runs before any
//     group-specific veto gets a look. A granted redirect target has to be
//     recognised BEFORE that check runs, not after.
//
// Both are handled here, in `matchGroups` itself, rather than through the
// `PermissionGroup` interface: `sanitizeCommandForRedirectGrants` removes a
// granted redirect clause before `matchCoveredCommand` ever sees it, tracking
// BOTH a scratch-rooted cwd and an fs-write relative offset in ONE walk over
// the command (never two walks that could disagree — #1000's law), and
// `scratchTargetVeto` is called directly by `matchGroups`'s own
// `vetoForMatched` closure, which threads that per-segment state the way a
// segment-by-segment veto function structurally cannot.
//
// Honest limits, not solved here, because static analysis cannot cover them:
//
//   - A symlink under `/tmp`, or under the relative start directory, pointing
//     outside it. Every check in this section is LEXICAL (path-segment text
//     analysis, like every other guard in this file); none of them resolve
//     the filesystem, and a symlink's target is invisible to a lexical check.
//   - `$TMPDIR`'s actual value is never expanded. `$TMPDIR/x` is matched by
//     SPELLING against the literal token, not by resolving to whatever
//     directory the shell would actually substitute at runtime.
// ---------------------------------------------------------------------------

/** Bash prefixes `scratch` covers directly, once every target validates. */
const SCRATCH_COMMANDS: readonly string[] = ['touch', 'cp', 'mv', 'tee', 'mkdir', 'rm', 'rmdir'];

/**
 * The tracked "current directory" state while walking a compound command.
 * `segments` is the path from a virtual filesystem root (`['tmp', 'x']` for
 * `/tmp/x`; `['private', 'tmp', 'x']` for `/private/tmp/x`; `['$TMPDIR', 'x']`
 * for `$TMPDIR/x`, the marker kept opaque rather than expanded).
 * `rootLen` is the number of leading segments that make up the ROOT itself —
 * `..` may never pop past it, which is what stops `cd /tmp && rm -rf ../..`
 * from resolving to anything above `/tmp`. `null` means "not known to be
 * under a scratch root" (never cd'd into one, or the last `cd` left it).
 */
type ScratchCwd = { readonly segments: readonly string[]; readonly rootLen: number } | null;

/**
 * Join `relParts` onto `base`, collapsing `.`/`..` lexically, and refusing to
 * pop below `floorLen` segments — the root boundary a scratch directory may
 * never be navigated above. Returns null on an attempted escape.
 */
function joinScratchSegments(
  base: readonly string[],
  floorLen: number,
  relParts: readonly string[],
): string[] | null {
  const segs = [...base];
  for (const part of relParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length <= floorLen) return null;
      segs.pop();
    } else {
      segs.push(part);
    }
  }
  return segs;
}

/**
 * Classify an ABSOLUTE-shaped token (`/tmp/...`, `/private/tmp/...`,
 * `$TMPDIR/...`, `${TMPDIR}/...`) into its scratch-root segments, or null if
 * it is not one of those four shapes. `..`/`.` are resolved via
 * `resolveDotDot` (sensitive-paths.ts) BEFORE the root check runs, the same
 * ordering that module documents and for the same reason: `/tmp/../etc`
 * fails every `startsWith('/tmp')` test only AFTER resolution, not before.
 */
function classifyScratchAbsolute(token: string): { segments: string[]; rootLen: number } | null {
  for (const marker of ['$TMPDIR', '${TMPDIR}']) {
    if (token === marker || token.startsWith(`${marker}/`)) {
      const rest = token.slice(marker.length).replace(/^\//, '');
      // The $TMPDIR/-PREFIX carve-out is consumed above; the REMAINDER must
      // contain no FURTHER `$`/`~` anywhere (#1061 -- see the anywhere-check
      // note on `resolveRelativeTarget` below for the mid-path bypass this
      // closes). `$TMPDIR/x` and `$TMPDIR/sub/file` stay granted; `$TMPDIR/$FOO`
      // does not, even though it starts with the trusted marker.
      if (rest.includes('$') || rest.includes('~')) return null;
      const extra = rest === '' ? [] : rest.split('/');
      const segs = joinScratchSegments(['$TMPDIR'], 1, extra);
      return segs === null ? null : { segments: segs, rootLen: 1 };
    }
  }
  if (token.startsWith('/')) {
    // Same anywhere-check as the `$TMPDIR` arm above, applied before dot-dot
    // resolution: a plain `/tmp/...`/`/private/tmp/...` token gets no
    // trusted-prefix carve-out at all, so ANY `$`/`~` anywhere refuses it.
    if (token.includes('$') || token.includes('~')) return null;
    const resolved = resolveDotDot(token);
    const segs = resolved.split('/').filter((s) => s !== '');
    if (segs[0] === 'tmp') return { segments: segs, rootLen: 1 };
    if (segs[0] === 'private' && segs[1] === 'tmp') return { segments: segs, rootLen: 2 };
    return null;
  }
  return null;
}

/**
 * Resolve any token (absolute-scratch, `$TMPDIR`-form, or a genuinely
 * relative path) to its scratch-root segments given the tracked `cwd`, or
 * null if it cannot be shown to land under one.
 *
 * An absolute path that is NOT one of the four scratch shapes (`/etc/...`,
 * `~/...`, `$HOME/...`, any other `$VAR/...`) is "judged on its own merits,
 * never inherited" from `cwd` — it returns null here regardless of what `cwd`
 * is, which is what stops `cd /tmp && rm -rf /Users/x` from resolving through
 * the tracked scratch directory.
 */
function resolveScratchTarget(
  token: string,
  cwd: ScratchCwd,
): { segments: readonly string[]; rootLen: number } | null {
  const absolute = classifyScratchAbsolute(token);
  if (absolute !== null) return absolute;
  if (token.startsWith('/')) return null;
  // Anywhere-check, not just a leading-character one (#1061). A relative
  // token composed onto a scratch-rooted cwd may contain NO `$`/`~` at ANY
  // position: `sub/$FOO`, `sub/${FOO}` and `../$FOO` all named an unresolved
  // shell expansion mid-path while starting with an ordinary-looking
  // character, so the old `token.startsWith('~') || token.startsWith('$')`
  // check (which only inspected the first character) granted them the
  // instant a `cd` had put the tracked cwd under a scratch root. Probe-
  // verified: `cd /tmp/$FOO && cat a > x` approved before this fix.
  if (token.includes('$') || token.includes('~')) return null;
  if (cwd === null) return null;
  const segs = joinScratchSegments(cwd.segments, cwd.rootLen, token.split('/'));
  return segs === null ? null : { segments: segs, rootLen: cwd.rootLen };
}

/**
 * True if `token` resolves to a path STRICTLY under a scratch root (deeper
 * than the root itself) given `cwd`. Strict, not root-or-equal, so `rm -rf
 * /tmp` and `rm -rf /private/tmp` — deleting the root, not something under it
 * — do not qualify; `resolveScratchTarget` (used directly, without the
 * strictness requirement) is what a `cd` TARGET is checked against instead,
 * since entering the scratch root itself is fine.
 */
function isStrictlyUnderScratchRoot(token: string, cwd: ScratchCwd): boolean {
  const resolved = resolveScratchTarget(token, cwd);
  return resolved !== null && resolved.segments.length > resolved.rootLen;
}

/**
 * A `cd`'s parsed operand, or the fact that one could not be extracted —
 * shared by BOTH cwd walks (`scratch`'s absolute-root tracking and
 * `fs-write`'s relative-offset tracking) so the two can never derive a
 * different operand from the same segment, which is exactly the
 * two-walks-that-must-agree defect #1000 found and fixed once already.
 * `target: null` covers every case NEITHER walk can resolve: a bare `cd`
 * (goes to `$HOME`), `cd -` (previous directory), any leading-dash option
 * (#1047 — `cd` reads it as OPTIONS, not an operand), and any operand shape a
 * redirect clause could hide inside (`cd ..>/dev/null`).
 */
type CdOperand = { readonly isCd: false } | { readonly isCd: true; readonly target: string | null };

/**
 * Parse a trimmed, grammar-peeled segment's `cd` operand, if it is a `cd` at
 * all. Both `advanceScratchCwd` and `advanceRelativeCwd` call this rather
 * than each re-deriving the operand from the segment text.
 */
function extractCdOperand(trimmedSegment: string): CdOperand {
  if (trimmedSegment === '') return { isCd: false };
  // Strip redirect clauses BEFORE tokenizing. `shellWords('cd ..>/dev/null')`
  // is `['cd', '..>/dev/null']`, and that glued token is neither `..` nor
  // `../…`, so the ascent was invisible and a tracked cwd never popped below
  // the root. Real bash ascends. Chained, `cd /tmp/x && cd ..>/dev/null && cd
  // ..>/dev/null && rm -rf etc` reached `rm -rf /etc` at `balanced`, on
  // SHIPPED releases.
  const words = shellWords(rewriteRedirectClauses(trimmedSegment, () => '').trim());
  if (words[0] !== 'cd') return { isCd: false };
  const target = words[1];
  // POSITIVE allowlist on the operand, not another round of subtracting known
  // -bad spellings. The #1047 fix rejected a leading dash; this found the same
  // hole one spelling over (`..>/dev/null`, `..>&1`, `..&>/dev/null`), and
  // `&>` is not even modelled by `rewriteRedirectClauses`. So the rule is now
  // "does this look like a path at all" -- shell metacharacters, whitespace and
  // quotes all disqualify. `$TMPDIR`, `${TMPDIR}`, `~` and `/tmp/x` are the
  // shapes `resolveScratchTarget`/`resolveRelativeTarget` genuinely handle, so
  // they stay in.
  if (target !== undefined && !/^[A-Za-z0-9._+/@~$:{}-]+$/.test(target)) {
    return { isCd: true, target: null };
  }
  // ANY leading dash resets, not just the exact `-` (#1047). `cd` reads a
  // leading-dash token as OPTIONS, so `cd -P` / `cd -L` / `cd --` / `cd -LP`
  // are an option with NO operand -- and a bare `cd` goes to `$HOME`. Testing
  // only `-` let `-P` be treated as a SUBDIRECTORY NAME: the tracked cwd
  // became `<scratch>/-P`, still under the root, while bash had left for
  // `$HOME`. So `cd /tmp/work && cd -P && rm -rf out` approved at 0ms and
  // deleted `~/out`. Verified in bash on darwin: the chain ends in `$HOME`.
  //
  // Resetting to null is the safe direction -- an unknowable cwd means no
  // relative target can be proved to land under either tracked root.
  if (target === undefined || target.startsWith('-')) return { isCd: true, target: null };
  return { isCd: true, target };
}

/**
 * Advance the tracked scratch `cwd` across one `cd` operand. A no-op for a
 * non-`cd` segment; a null operand (bare `cd`, `cd -`, or an unresolvable
 * shape — see `extractCdOperand`) resets to null rather than guess.
 */
function advanceScratchCwd(cwd: ScratchCwd, operand: CdOperand): ScratchCwd {
  if (!operand.isCd) return cwd;
  if (operand.target === null) return null;
  return resolveScratchTarget(operand.target, cwd);
}

/**
 * The tracked relative offset from wherever `fs-write`'s command runs, while
 * walking a compound command — the same shape of state `ScratchCwd` tracks
 * for an absolute scratch root, but for a starting directory this matcher
 * never learns the name of.
 *
 * `[]` means "still at the start" — the INITIAL state, which a command with
 * no `cd` at all never leaves. A non-empty array is a composed, non-ascending
 * relative path from there (`['sub']` after `cd sub`). `null` means "not
 * provable relative to the start": an absolute or `$VAR`/`~` cd, an
 * unreliable one (`|`/`||`), a #1047-shaped dash reset, or a composed offset
 * that tried to ascend above the start. `null` is STICKY — once the offset
 * from the start is unprovable, no later RELATIVE `cd` can rebuild it, the
 * same rule #1000 pins for scratch ("a relative cd after an unreliable one
 * does not rebuild the root").
 */
type RelativeCwd = readonly string[] | null;

/**
 * Resolve `token` to its offset from the fs-write start directory given
 * `relCwd`, or null if it cannot be shown to stay inside it.
 *
 * An absolute-shaped token (leading `/`) is refused outright, never composed
 * with `relCwd`: fs-write's grant is for a target IN TREE relative to
 * wherever the command runs, and an absolute path names a location this
 * matcher has no basis to trust regardless of the tracked offset — that is
 * `scratch`'s grant to make, for its own four rooted shapes, not this one's.
 *
 * A `~`/`$` ANYWHERE in the token also refuses it, not only when leading
 * (#1061). The old check only inspected the first character, so `sub/$FOO`
 * and `sub/${FOO}` — an unresolved shell expansion sitting mid-path — were
 * composed onto `relCwd` and granted like an ordinary relative path. Probe-
 * verified: `cat a > sub/$FOO` approved before this fix.
 *
 * Reuses `joinScratchSegments` with `floorLen: 0` — the start directory
 * itself is the floor a composed offset may never pop below, exactly the
 * same "may not ascend past the root" shape scratch's own walk already
 * enforces, just with the floor at 0 instead of scratch's root length.
 */
function resolveRelativeTarget(token: string, relCwd: RelativeCwd): RelativeCwd {
  if (token.startsWith('/')) return null;
  if (token.includes('$') || token.includes('~')) return null;
  if (relCwd === null) return null;
  return joinScratchSegments(relCwd, 0, token.split('/'));
}

/**
 * Advance the tracked fs-write relative offset across one `cd` operand.
 * Mirrors `advanceScratchCwd` exactly — same operand, same null-on-unknown
 * handling — composing through `resolveRelativeTarget` instead of
 * `resolveScratchTarget`.
 */
function advanceRelativeCwd(relCwd: RelativeCwd, operand: CdOperand): RelativeCwd {
  if (!operand.isCd) return relCwd;
  if (operand.target === null) return null;
  return resolveRelativeTarget(operand.target, relCwd);
}

/**
 * True if a `cd` in this position cannot be assumed to have moved the shell
 * the rest of the command runs in. Reading segments left-to-right models `&&`,
 * `;` and newline correctly and the other two operators not at all:
 *
 * - `||` — the right-hand side runs only if the left FAILED. `cd /etc || cd
 *   /tmp` ends in `/etc` whenever `/etc` exists, which is always; a
 *   left-to-right walk ends believing `/tmp`.
 * - `|` — a pipeline stage runs in a subshell (absent `lastpipe`), so its `cd`
 *   is discarded when the stage exits. True for a `cd` REACHED via `|` and for
 *   one FOLLOWED by `|`, since either position makes it a stage.
 *
 * Both directions matter because the consequence is not a missed match but a
 * tracked cwd that differs from the real one, under which a later relative
 * target is approved against a directory nobody checked. Returning true makes
 * the caller forget the directory rather than guess it, the same fail-closed
 * handling bare `cd` and `cd -` already get. Shared by both walks (`scratch`
 * and `fs-write`'s relative offset): a `cd`'s reliability does not depend on
 * which grant is asking.
 */
function cdEffectIsUnreliable(joiner: CompoundJoiner, nextJoiner: CompoundJoiner): boolean {
  return joiner === '|' || joiner === '||' || nextJoiner === '|';
}

/**
 * True if a redirect clause targeting `path` may be DELETED under the
 * `scratch` grant: the target resolves STRICTLY under a scratch root, AND is
 * not itself a sensitive destination.
 *
 * #1060 + ADR 0018 axis 3. `isStrictlyUnderScratchRoot` alone proves only the
 * destination-root half of a write-side match (axis 3's "under `/tmp`" half);
 * it never asked WHAT the target names, so `cat a > /tmp/.env`,
 * `cat a > /tmp/.git/hooks/pre-commit` and `cat a > /tmp/sub/package.json` all
 * qualified and had their redirect clause deleted before
 * `segmentTouchesSensitivePath` — this file's own axis-3 conjunct — ever got a
 * token to look at: the clause it would have vetoed was gone by the time that
 * check ran. Same "one proof holds, the other owner's veto never runs" shape
 * ADR 0018 exists to name for every other write-side match; this is that gap
 * inside `scratch`'s own redirect carve-out.
 *
 * Checked on the RESOLVED path, not the raw token, so a cd-established root
 * composed with a relative target still lands on the real destination before
 * the sensitivity check runs — `cd /tmp && cat a > .git/hooks/pre-commit` must
 * be caught exactly like the absolute spelling.
 */
function isGrantedScratchRedirectTarget(path: string, cwd: ScratchCwd): boolean {
  const resolved = resolveScratchTarget(path, cwd);
  if (resolved === null || resolved.segments.length <= resolved.rootLen) return false;
  return !isSensitiveWritePath(scratchSegmentsToPath(resolved.segments));
}

/** Render resolved scratch-root segments back into a path `isSensitiveWritePath` can read. */
function scratchSegmentsToPath(segments: readonly string[]): string {
  return segments[0] === '$TMPDIR' ? segments.join('/') : `/${segments.join('/')}`;
}

/**
 * True if a redirect clause targeting `path` may be DELETED under the
 * `fs-write` grant (#1041): it composes to a RELATIVE, non-ascending offset
 * from wherever the command runs, and is not a sensitive destination.
 *
 * fs-write's own axis-3 destination veto (`isSensitiveWritePath`) is reused
 * rather than re-derived, checked on the RESOLVED (cwd-composed) path for the
 * same reason `isGrantedScratchRedirectTarget` does: `cd sub && cat a >
 * .git/hooks/pre-commit` must be caught exactly like the un-cd'd spelling.
 * `resolveRelativeTarget` already refuses an absolute-shaped target and an
 * ascending composition, so an empty (root-itself) result is the only other
 * non-grant case left to check here.
 */
function isGrantedFsWriteRedirectTarget(path: string, relCwd: RelativeCwd): boolean {
  const resolved = resolveRelativeTarget(path, relCwd);
  if (resolved === null || resolved.length === 0) return false;
  return !isSensitiveWritePath(resolved.join('/'));
}

/** Which redirect grants are active for the current command — gates both the
 *  pre-pass itself and each individual clause deletion decision. */
interface RedirectGrants {
  readonly scratchActive: boolean;
  readonly fsWriteActive: boolean;
}

/** The per-segment cwd state both grants read, from ONE walk: the tracked
 *  scratch root (absolute) and the tracked fs-write offset (relative). */
interface RedirectGrantCwd {
  readonly scratch: ScratchCwd;
  readonly relative: RelativeCwd;
}

/**
 * Mirrors shell-safety.ts's PRIVATE `REDIRECT_CLAUSE_RE` (`/\d*>>?\s*&?\S+/g`)
 * so this module can find clause OFFSETS without that module exporting one
 * (ADR 0026: shell-safety.ts stays untouched). Used ONLY to decide whether a
 * clause is eligible for deletion below; the actual deletion still runs
 * through `rewriteRedirectClauses`, so a drift between the two patterns could
 * only ever change which segments this pre-scan is cautious about, never what
 * gets deleted once a segment passes it.
 */
const REDIRECT_CLAUSE_OFFSET_RE = /\d*>>?\s*&?\S+/g;

/**
 * True if `segment` contains a redirect-clause-shaped match whose start is
 * NOT preceded by whitespace or the start of the segment — i.e. it is glued
 * onto the end of a preceding word, the way `2>x` is glued onto `cat` in
 * `cat2>x`. Bash parses that as the single command name `cat2` (verified:
 * exit 127), not `cat` followed by a redirect, so deleting the glued clause
 * (as the grant pass below otherwise would) makes the matcher approve `cat`
 * while a DIFFERENT command actually runs. A real fd-redirect always has
 * whitespace, or nothing, before its digit: `cat 2>x`.
 *
 * Deliberately NOT the `/(^|\s)(clause)/`-with-a-captured-preceding-char
 * shape: that alternation requires CONSUMING the preceding character as part
 * of the match, so on `cat2>x` it never matches the `2>x` substring AT ALL
 * (the character before it, `t`, is neither whitespace nor start-of-string) —
 * it does not report the glued clause as "bad", it simply never sees it,
 * which would make a scan built that way vacuously pass. Finding every
 * REDIRECT_CLAUSE_RE-shaped match by its own offset, unconditionally, and
 * then inspecting the character immediately before that offset, is what
 * actually distinguishes the two shapes.
 */
function segmentHasGluedRedirectClause(segment: string): boolean {
  for (const m of segment.matchAll(REDIRECT_CLAUSE_OFFSET_RE)) {
    const idx = m.index ?? 0;
    if (idx > 0 && !/\s/.test(segment[idx - 1] as string)) return true;
  }
  return false;
}

/**
 * Remove every redirect clause in `segment` whose target an ACTIVE grant
 * covers: `scratch`'s absolute-root proof, `fs-write`'s relative-offset
 * proof, or both — a clause deletable by either grant is deleted. REMOVES the
 * clause entirely rather than retargeting it to `/dev/null`: a retargeted
 * clause would still leave a token like `2>/dev/null` sitting in the word
 * list `scratchTargetVeto` scans for positional arguments, which is neither a
 * flag nor a real target and would wrongly fail that scan.
 *
 * Only a `path` target is ever removed. `discard`/`fd-dup` need no help —
 * `hasShellControl` already permits them — and `opaque` must never be removed,
 * since removing it is exactly how a second operator hidden inside the greedy
 * match would escape the veto that was going to catch it.
 *
 * Callers MUST check `segmentHasGluedRedirectClause` first and skip calling
 * this at all when it is true (see the call site in
 * `sanitizeCommandForRedirectGrants`) — a glued clause is not modeled here,
 * because by the time a clause reaches this function's callback there is no
 * way to recover whether ITS particular match was glued or not: the deletion
 * has to be refused for the whole segment, before any deletion is attempted.
 */
function sanitizeSegmentRedirects(
  segment: string,
  cwd: RedirectGrantCwd,
  grants: RedirectGrants,
): string {
  return rewriteRedirectClauses(segment, (target, text) => {
    if (target.kind !== 'path') return text;
    if (grants.scratchActive && isGrantedScratchRedirectTarget(target.path, cwd.scratch)) return '';
    if (grants.fsWriteActive && isGrantedFsWriteRedirectTarget(target.path, cwd.relative))
      return '';
    return text;
  });
}

/**
 * Pre-pass over the WHOLE command, run when EITHER grant is active: removes
 * every redirect clause a granted proof covers, tracking `cd` across segments
 * exactly like the real match that follows will. This has to run BEFORE
 * `matchCoveredCommand`, not alongside it: `hasShellControl` cannot be told
 * "except this one clause", it returns one boolean for the whole segment, so
 * the only way to let a granted redirect through it is to remove the clause
 * before that check ever sees it.
 *
 * ONE walk over the command produces BOTH tracked states (`scratch` and
 * `relative`), from the same extracted `cd` operand at each step — never two
 * separate passes that could disagree, exactly the defect shape #1000 found
 * and fixed once already. `grants` only gates which state a clause deletion
 * may CONSULT; both states are always tracked regardless, so enabling
 * `fs-write` alone never changes what a `scratch`-only caller would have
 * computed, and vice versa — every existing scratch-only behavior is
 * bit-identical to before this function was generalized.
 *
 * The rebuilt string keeps each segment's ORIGINAL joining operator. An
 * earlier draft rebuilt with a uniform `&&`, reasoning that
 * `matchCoveredCommand` re-splits via `splitCompound` and never inspects which
 * separator joined two segments. That was true of `matchCoveredCommand` and
 * false of the cwd walks downstream of it, which track `cd` across segments
 * and so depend on exactly the operator a uniform `&&` erased: flattening
 * `true | cd /tmp` to `true && cd /tmp` converts a discarded subshell `cd`
 * into one the walk believes moved the shell.
 */
function sanitizeCommandForRedirectGrants(
  command: string,
  grants: RedirectGrants,
): RedirectGrantWalk {
  const parts = splitCompoundParts(command);
  const stateBySegment: RedirectGrantCwd[] = [];
  let scratchCwd: ScratchCwd = null;
  // fs-write's relative offset starts at the INITIAL state — `[]`, not null —
  // because the grant is available from the very first segment: a command
  // that never `cd`s at all is exactly as in-tree as one could hope to prove.
  let relativeCwd: RelativeCwd = [];
  let rebuilt = '';
  for (const [i, part] of parts.entries()) {
    // The state RECORDED for a segment is the one in effect when the shell
    // reaches it, i.e. before its own effect: a `cd` moves the segments after
    // it, not itself.
    stateBySegment.push({ scratch: scratchCwd, relative: relativeCwd });
    const trimmed = part.text.trim();
    // Detect the `cd` in the PEELED body, not the raw text. Judging raw text
    // here while `matchCoveredCommand` judges the peeled body is what made
    // `cd /tmp/work && if true; then cd /etc; fi && rm passwd` come back
    // `scratch:rm` — the tracker never saw `then cd /etc`, so it carried
    // `/tmp/work` forward and resolved `passwd` under the scratch root while
    // the real shell was in `/etc`. Two walks of one command that must agree,
    // computed from two different texts: the same defect shape as #1000.
    const stripped = trimmed === '' ? null : stripShellGrammar(trimmed);
    const body = stripped?.command ?? '';
    const words = body === '' ? [] : shellWords(body);
    let text = part.text;
    if (words[0] === 'cd') {
      // A `cd` that needed grammar peeled off it sits inside a conditional or
      // a loop body, so it runs zero or more times and the shell's directory
      // afterwards is not knowable from the text. Forget it rather than carry
      // a stale one forward — carrying it forward is what made the scratch
      // escape above auto-approve, so here "unknown" must mean null, never
      // "whatever it was before", for BOTH tracked states.
      const wrappedInGrammar = body !== trimmed;
      const unreliable =
        wrappedInGrammar || cdEffectIsUnreliable(part.joiner, parts[i + 1]?.joiner ?? null);
      const operand = extractCdOperand(body);
      scratchCwd = unreliable ? null : advanceScratchCwd(scratchCwd, operand);
      relativeCwd = unreliable ? null : advanceRelativeCwd(relativeCwd, operand);
    } else if (trimmed !== '') {
      // A glued clause (`cat2>x`) means bash reads a DIFFERENT command name
      // than the one this matcher is about to judge (#1061). Deleting even a
      // different, legitimately-spaced clause in the same segment would leave
      // that glued absorption behind, unexamined, in the command handed to
      // `matchCoveredCommand` — so ANY glued clause in the segment skips
      // deletion for the WHOLE segment, leaving `text` as the original
      // `part.text`. That fails closed exactly like every other unproven
      // redirect: `hasShellControl` sees the still-present, non-`/dev/null`
      // clause and vetoes the segment, same as before this grant existed.
      text = segmentHasGluedRedirectClause(part.text)
        ? part.text
        : sanitizeSegmentRedirects(
            part.text,
            { scratch: scratchCwd, relative: relativeCwd },
            grants,
          );
    }
    rebuilt += i === 0 ? text : `${joinerText(part.joiner)}${text}`;
  }
  return { command: rebuilt, stateBySegment };
}

/**
 * A redirect-grant pre-pass result: the rewritten command, plus BOTH tracked
 * cwd states in effect at each of its compound segments, BY INDEX.
 *
 * The trajectory is published rather than recomputed downstream because the
 * two used to be computed twice — once here and once by a closure threaded
 * through `matchCoveredCommand` — and two walks of the same command that must
 * agree are exactly the shape that produced the `|`/`||` desync this type
 * exists to prevent recurring. One walk, one answer, read by index.
 */
interface RedirectGrantWalk {
  readonly command: string;
  readonly stateBySegment: readonly RedirectGrantCwd[];
}

/** Render a joiner back into command text, preserving `splitCompoundParts`'s split. */
function joinerText(joiner: CompoundJoiner): string {
  if (joiner === null) return '';
  return joiner === 'newline' ? '\n' : joiner;
}

/**
 * Veto for a segment `scratch`'s own prefix matched (touch/cp/mv/tee/mkdir/
 * rm/rmdir). Every non-flag token, and the VALUE half of any `--flag=value`
 * token (so `--target-directory=/etc` is seen as `/etc`, the same
 * `--flag=value` unwrapping `sensitive-paths.ts` already does), must resolve
 * to a path strictly under a scratch root given `cwd`. Checking every token
 * rather than guessing which one is "the destination" mirrors
 * `segmentTouchesSensitivePath`'s own reasoning: getting a command's flag
 * grammar wrong is fatal in ONE direction for each kind of check, and
 * checking everything can only fail in the safe one here (an extra
 * escalation, never a wrongly-approved write).
 *
 * Any redirect clause still present in `segment` at this point is exempt by
 * construction: `sanitizeCommandForRedirectGrants` already removed every
 * clause EITHER grant covered (scratch's or fs-write's), and a non-exempt,
 * non-granted clause would have tripped `hasShellControl` before
 * `matchCoveredCommand` ever reached this veto. It is stripped here purely so
 * a leftover token like `2>&1` is not mistaken for a positional target.
 */
function scratchTargetVeto(segment: string, cwd: ScratchCwd): boolean {
  const stripped = rewriteRedirectClauses(segment, () => '').trim();
  const words = shellWords(stripped);
  for (const word of words.slice(1)) {
    if (word === '') continue;
    if (word.startsWith('-')) {
      const eq = word.indexOf('=');
      if (eq === -1) continue;
      const value = word.slice(eq + 1);
      if (value !== '' && !isStrictlyUnderScratchRoot(value, cwd)) return true;
      continue;
    }
    if (!isStrictlyUnderScratchRoot(word, cwd)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Heredoc excision (#1057 phase 2, commit 3). A pre-pass SIBLING of
// `sanitizeCommandForRedirectGrants`, run in the `matchGroups` path only --
// never the user allow-list path in `pattern-matcher.ts`. That asymmetry is
// deliberate and is documented alongside this in the phase's ADR.
//
// Heredocs appear NOWHERE in the decision code before this commit, and what
// happens today is a coincidence, not a policy. `tee /tmp/x <<EOF` (one
// physical line, no real newline in the string) approves, because `<<EOF`
// just sits as an inert extra token nothing looks at. A genuine MULTI-LINE
// heredoc escalates only by ACCIDENT: `splitCompoundParts` treats an
// unquoted newline as a command separator exactly like `;`, so the body
// becomes its own segment(s), and a body line essentially never happens to
// prefix-match a curated command. That is not a designed safety property --
// it is two unrelated mechanisms colliding -- and it is what this excision
// replaces with a deliberate one: give the heredoc body a real disposition
// instead of an accidental one.
//
// The rule, fail-closed at every step: find the heredoc operator (`<<` or
// `<<-`) on a physical line, read its delimiter WORD (bare, `'quoted'`, or
// `"quoted"`), and if the WORD is a plain `[A-Za-z0-9_]+` token, look for a
// LATER line that equals it exactly (leading tabs only, stripped, for
// `<<-`). Found: the operator, its word, every body line and the terminator
// line are all removed from the command text. Everything that remains flows
// through the EXISTING machinery completely unchanged (compound split,
// redirect grants, `hasShellControl`, group prefix coverage, every veto).
// Excision itself grants nothing -- it only deletes syntax that was inert to
// begin with, so whatever coverage decision the remaining text earns is the
// same decision it would earn had a human deleted the heredoc by hand.
//
// ANY of the following aborts excision for the WHOLE command, restoring it
// byte-for-byte and falling back to today's (safe, if accidental) behavior:
//
//   - a second `<<` on the same physical line (`cat <<A <<B`) -- rare, and
//     stacked heredocs are refused rather than modeled;
//   - a delimiter that is not a plain word once unquoted (empty, containing
//     `$`, a backslash, or other punctuation);
//   - no later line matches the delimiter exactly -- an unterminated
//     heredoc is exactly today's accidental-escalation shape, so leaving it
//     alone reproduces it rather than guessing where it ends;
//   - an UNQUOTED delimiter (`<<EOF`, not `<<'EOF'`/`<<"EOF"`) whose body
//     contains `$(`, a backtick, or `<(`. An unquoted heredoc body is LIVE:
//     the shell performs command/process substitution on it BEFORE it is
//     ever handed to the reading command. Excising it would DELETE that
//     execution from the text the matcher ever sees --
//     `cat > x <<EOF` / `$(rm -rf /)` / `EOF` would collapse to `cat > x`,
//     approve via the fs-write redirect grant, and the shell would still
//     run `rm -rf /` as a side effect of expanding the body nobody looked
//     at. A QUOTED delimiter needs no such scan: bash performs no expansion
//     at all on a quoted-delimiter body, so it is inert by construction.
//
// Quote masking is done PER LINE, not once over the whole multi-line
// command. A heredoc body is literal data and may contain an apostrophe or
// an unmatched quote character with no bearing on shell grammar at all
// (`it's done` is valid body text) -- masking the ENTIRE command in one pass
// would let that single stray quote desync `maskQuotedSpans`'s state for
// everything after it (an unterminated quote makes that function return its
// input completely UNMASKED, per its own contract), which could misread a
// LATER line's real operator as quoted, or vice versa. Per-line masking
// confines the blast radius of a body line's stray quote to that one line,
// which is never consulted for operator detection: operators are only
// looked for on lines a body has not yet started under.
// ---------------------------------------------------------------------------

/** Characters a heredoc delimiter must be made of, once unquoted. */
const HEREDOC_WORD_RE = /^[A-Za-z0-9_]+$/;

/** What scanning one physical line for a heredoc operator found. */
type HeredocOperatorScan =
  | { readonly kind: 'none' }
  | { readonly kind: 'multiple' }
  | { readonly kind: 'invalid' }
  | {
      readonly kind: 'found';
      /** Index in the line where the `<<` starts. */
      readonly opStart: number;
      /** Index in the line right after the (possibly quoted) delimiter word. */
      readonly opEnd: number;
      readonly dashed: boolean;
      readonly word: string;
      readonly quoted: boolean;
    };

/**
 * Find a heredoc operator on ONE physical line, quote-masked so a `<<` that
 * is really inside a quoted argument (`echo "a << b"`) is not mistaken for
 * one. `<<<` (here-strings) and any longer run of `<` are excluded outright
 * -- a run of 3+ `<` is never a heredoc operator.
 *
 * `kind: 'multiple'` and `kind: 'invalid'` are both reported rather than
 * silently treating the line as `'none'`, because the caller has to abort
 * the WHOLE excision on either -- a line this function cannot fully make
 * sense of must not have its *other* content silently reinterpreted.
 */
function scanHeredocOperator(line: string): HeredocOperatorScan {
  const masked = maskQuotedSpans(line);
  const starts: number[] = [];
  for (let i = 0; i < masked.length - 1; i++) {
    if (masked[i] !== '<' || masked[i + 1] !== '<') continue;
    if (masked[i - 1] === '<' || masked[i + 2] === '<') continue; // <<< / <<<<
    starts.push(i);
  }
  if (starts.length === 0) return { kind: 'none' };
  if (starts.length > 1) return { kind: 'multiple' };
  const opStart = starts[0] as number;
  let idx = opStart + 2;
  let dashed = false;
  if (masked[idx] === '-') {
    dashed = true;
    idx++;
  }
  while (masked[idx] === ' ' || masked[idx] === '\t') idx++;
  // From here, read the RAW line (not the masked view): the masked view has
  // replaced a quoted delimiter's characters, quotes included, with `_`.
  const quoteChar = line[idx];
  let word: string;
  let opEnd: number;
  if (quoteChar === "'" || quoteChar === '"') {
    const close = line.indexOf(quoteChar, idx + 1);
    if (close === -1) return { kind: 'invalid' };
    word = line.slice(idx + 1, close);
    opEnd = close + 1;
  } else {
    let end = idx;
    while (end < line.length && !/\s/.test(line[end] ?? '')) end++;
    word = line.slice(idx, end);
    opEnd = end;
  }
  if (!HEREDOC_WORD_RE.test(word)) return { kind: 'invalid' };
  return {
    kind: 'found',
    opStart,
    opEnd,
    dashed,
    word,
    quoted: quoteChar === "'" || quoteChar === '"',
  };
}

/** True if an UNQUOTED heredoc body carries live substitution the shell
 *  would execute while expanding it, before the reading command ever runs. */
function heredocBodyHasLiveSubstitution(bodyLines: readonly string[]): boolean {
  return bodyLines.some((l) => l.includes('$(') || l.includes('`') || l.includes('<('));
}

/**
 * Excise every heredoc this command contains, or return `command` completely
 * UNCHANGED the instant any single one cannot be proven safe to remove -- see
 * the section comment above for the full fail-closed rule.
 *
 * Run unconditionally in `matchGroups`'s Bash path, before every other
 * pre-pass and before compound splitting. That is safe rather than a
 * widening: excision does not grant coverage by itself, it only deletes
 * syntax that was inert (or, on any abort, leaves the command exactly as it
 * was), so it can only ever hand the EXISTING machinery a command that means
 * the same thing with less noise in it -- coverage is still decided entirely
 * by that machinery, same as if a human had deleted the heredoc by hand.
 */
function exciseHeredocsForGroups(command: string): string {
  if (!command.includes('<<')) return command;
  const lines = command.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    const op = scanHeredocOperator(line);
    if (op.kind === 'none') {
      out.push(line);
      i++;
      continue;
    }
    if (op.kind === 'multiple' || op.kind === 'invalid') return command;
    let terminatorAt = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const raw = lines[j] as string;
      const candidate = op.dashed ? raw.replace(/^\t+/, '') : raw;
      if (candidate === op.word) {
        terminatorAt = j;
        break;
      }
    }
    if (terminatorAt === -1) return command; // unterminated: fail closed
    const body = lines.slice(i + 1, terminatorAt);
    if (!op.quoted && heredocBodyHasLiveSubstitution(body)) return command; // live body: fail closed
    out.push(line.slice(0, op.opStart) + line.slice(op.opEnd));
    i = terminatorAt + 1; // skip every body line and the terminator line
  }
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// `artifact-clean` group (ADR 0023): deletion approves ONLY when every target
// is PROVABLY derived state. #956's blanket rule — deletion escalates at
// every level — already had one shipped exception: `scratch` (above) approves
// rm/rmdir whose every target provably resolves under a scratch root. So the
// real shipped rule since #994 is "deletion escalates unless the destination
// is PROVED disposable by lexical reasoning", and this section extends that
// proof from "under /tmp" to "at or under a directory whose exact name
// proclaims derived state".
//
// Three command families, each with its own veto profile (ADR 0018: a
// mutating group supplies its own vetoes or it does not ship):
//
//   - `rm`/`rmdir`: every non-flag token must be a relative, non-ascending,
//     expansion-free path with some exact-case segment on ARTIFACT_DIR_NAMES
//     and no `isSensitiveWritePath` hit. Flags are allowlisted
//     (write-flag-safety.ts: `-rRfv`/`-pv`, exact long spellings only).
//   - `git worktree remove`: structural check only (at most one `--force`,
//     no other flags, exactly one positional that is not `.`). Its safety
//     rests on a RUNTIME veto: git refuses any path that is not a registered
//     linked worktree of this repository, always refuses the main worktree,
//     and requires a SECOND `--force` for a locked one — which this group
//     never supplies. Committed work survives in the shared object store by
//     construction; only the worktree's uncommitted files are at stake.
//   - bare `bun install` (flag allowlist: `--frozen-lockfile` only). Its
//     lockfile and package.json are on BUILD_SURFACE (sensitive-paths.ts), so
//     no write group can edit them into something else first, and
//     `bun install <pkg>` is `bun add` in disguise and escalates.
//
//     "Lockfile-faithful" is what an EARLIER version of this comment claimed,
//     and it is only true of the `--frozen-lockfile` form. The ADR 0023
//     adversarial pass caught it: BARE `bun install` reconciles package.json
//     against the lockfile, so it may resolve new versions, rewrite the
//     lockfile, and run lifecycle scripts of whatever it installs. The bare
//     form is covered anyway because it is the measured miss this group exists
//     for (`rm -rf node_modules && bun install`) and narrowing to
//     `--frozen-lockfile` would drop that back below the 95% target — but it
//     is covered as a DECLARED residual, not because it is inert. Anyone
//     tightening this should tighten the coverage, not the wording.
//
// `/tmp`/`$TMPDIR` deletion is NOT re-implemented here — `scratch` covers it,
// and `matchGroups` tries every owning group's proof for a shared prefix.
// `git clean` is excluded in every form: its population is UNTRACKED files,
// and untracked is not derived — a file the agent created five minutes ago is
// untracked source (ADR 0023).
//
// Accepted residuals, DECLARED rather than open bugs (ADR 0023):
//
//   - The name list is a convention, not a guarantee: a SOURCE directory
//     genuinely named `build/` or `coverage/` is deletable at `trusted`.
//     Bounded honestly: tracked contents come back via `git checkout --
//     <path>` (shared history is untouched by rm); untracked contents are
//     lost — the same residual the owner accepted for worktree `--force`.
//   - Symlinks are invisible to every lexical check here, exactly as
//     `scratch` documents above: an INTERMEDIATE segment that is a symlink
//     (`packages/web` pointing elsewhere) makes `rm -rf packages/web/dist`
//     delete through it. The one lexically VISIBLE trigger — a trailing `/`
//     on a target, which makes `rm -rf link/` traverse the link target on
//     some platforms — is vetoed.
//
// #1024 makes this group a silent subagent grant: a subagent's `rm -rf dist`
// at `trusted` answers the hook with no render and no card. The visibility
// path is `auto_approve.subagent_alert` (an `rm` entry there alerts without
// blocking) — chosen, not overlooked (ADR 0023).
// ---------------------------------------------------------------------------

/**
 * Directory names whose EXACT spelling proclaims derived state.
 *
 * This is an allow surface and will attract additions (ADR 0023). An entry
 * qualifies only if the exact name proclaims derived state AND a command the
 * repo already runs regenerates it. `vendor` (often tracked), `tmp`
 * (proclaims temporariness but regenerates nothing), and any suffix/glob
 * form (`*.egg-info`) do not clear the bar.
 *
 * Matching is EXACT-CASE while `sensitive-paths.ts` lowercases, and the
 * asymmetry is deliberate (ADR 0010 applied to names): the deny check
 * lowercases to WIDEN; an allow check that lowercased would treat `Dist` as
 * `dist` on case-sensitive Linux, where they are different directories.
 * "Cleaning up" the inconsistency reopens a hole.
 */
const ARTIFACT_DIR_NAMES: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '__pycache__',
  '.venv',
]);

/**
 * Characters whose presence means the token rm receives is not the token
 * written: variable expansion, glob, or brace expansion would rewrite it
 * first, so no lexical proof about the written text can hold. `shellWords`
 * has removed quotes by the time this runs, so a QUOTED glob (`'dist*'`,
 * genuinely literal to the shell) is refused too — over-refusal, the safe
 * direction, costing an escalation on a filename that really contains one of
 * these characters.
 */
const ARTIFACT_EXPANSION_RE = /[$`*?[{}]/;

/**
 * True if `token` is PROVABLY at or under an exact-named derived-state
 * directory: relative, non-ascending, expansion-free, some path segment on
 * `ARTIFACT_DIR_NAMES`, and no sensitive hit. The proof is name-based, not
 * cwd-based — which is why a poisoning `cd` (see `artifactCleanPoisonWalk`)
 * has to be checked separately: the name `dist` proves the same thing in any
 * directory REACHED BY relative descent, and nothing at all in `/etc`.
 */
function isProvedArtifactTarget(token: string): boolean {
  if (token === '') return false;
  if (ARTIFACT_EXPANSION_RE.test(token)) return false;
  // Relative paths only: an absolute or home-rooted target can name any tree
  // on the machine, and the measured population this group exists for is
  // in-project relative cleanup (ADR 0023).
  if (token.startsWith('/') || token.startsWith('~')) return false;
  // Trailing-slash veto: `rm -rf link/` traverses a symlinked directory's
  // TARGET on some platforms. The one symlink trigger that is lexically
  // visible; the residuals note above records the rest. Checked on the RAW
  // token — `resolveDotDot` would silently drop the slash.
  if (token.endsWith('/')) return false;
  // Resolve `.`/`..` BEFORE the name scan, the same ordering
  // `sensitive-paths.ts` documents for its prefix axis: `dist/../src` names
  // `src` and must be judged as `src`.
  const resolved = resolveDotDot(token);
  if (resolved === '' || resolved === '..' || resolved.startsWith('../')) return false;
  if (!resolved.split('/').some((s) => ARTIFACT_DIR_NAMES.has(s))) return false;
  // The deny axis still applies ON TOP of the allow proof (ADR 0018):
  // `dist/.env` carries a qualifying segment AND a sensitive basename, and
  // the deny check wins.
  return !isSensitiveWritePath(token);
}

/**
 * True if a `cd`'s argument list is a single plain relative descendant —
 * the only `cd` shape that does not poison `artifact-clean` (see
 * `artifactCleanPoisonWalk`). Anything else (bare `cd` → `$HOME`, `cd -` →
 * unknowable, absolute, `~`, expansion, ascending, extra arguments) fails.
 */
function cdTargetIsPlainDescendant(words: readonly string[]): boolean {
  if (words.length !== 2) return false;
  const target = words[1];
  if (target === undefined || target === '') return false;
  // ANY leading dash, not just the exact `-`. Found by the ADR 0023
  // adversarial pass, and it was the whole group's worst case: `cd` treats a
  // leading-dash token as OPTIONS, not a directory, so `cd -P` / `cd -L` /
  // `cd --` / `cd -LP` parse as an option with NO operand -- and a bare `cd`
  // goes to `$HOME`. Verified in bash on darwin: each of those four lands in
  // `/Users/<user>`.
  //
  // Rejecting only `-` therefore let `cd -P && rm -rf .venv` read as "plain
  // relative descent", approve at 0ms, and delete the user's `~/.venv`. Worse,
  // a SECOND plain `cd` still descends normally from there, so
  // `cd -P && cd <anyproject> && rm -rf node_modules` reached any project
  // under `$HOME` -- with no card, and under #1024 as a silent subagent grant.
  //
  // Costs nothing real: a directory whose name starts with `-` cannot be
  // reached by `cd -foo` in bash either. It needs `cd ./-foo` (no leading
  // dash, still allowed) or `cd -- -foo` (three words, already poisons).
  if (target.startsWith('-')) return false;
  // POSITIVE allowlist, added after the leading-dash fix above proved too
  // narrow: `cd ..>/dev/null` and `cd ..&>/dev/null` carry the ascent inside a
  // token that is not dash-led, and `&>` is not modelled by
  // `rewriteRedirectClauses` at all. Enumerating bad spellings loses; asking
  // "does this look like a path" does not. Shell metacharacters, whitespace
  // and quotes all disqualify.
  if (!/^[A-Za-z0-9._+/@-]+$/.test(target)) return false;
  if (ARTIFACT_EXPANSION_RE.test(target)) return false;
  if (target.startsWith('/') || target.startsWith('~')) return false;
  const resolved = resolveDotDot(target);
  return resolved !== '..' && !resolved.startsWith('../');
}

/**
 * Pre-walk for `artifact-clean` (ADR 0023), beside
 * `sanitizeCommandForRedirectGrants`: for each compound segment BY INDEX,
 * whether a poisoning `cd` occurred anywhere earlier. A `cd` poisons unless its single
 * target is a plain relative descendant; a grammar-wrapped `cd` (`if ...;
 * then cd sub; fi`) poisons regardless of target, because it runs zero or
 * more times and the directory afterwards is unknowable from the text.
 * Poison is NEVER un-poisoned: after `cd /etc`, a later `rm -rf dist` names
 * `/etc/dist`, and no subsequent `cd` can make the tracked directory
 * trustworthy again for an ALLOW decision.
 *
 * Unlike `scratch`'s cwd tracking, the joining operators (`|`, `||`) need no
 * special handling here, because poison is one-directional: a GOOD `cd` that
 * may not have run is harmless either way (the artifact proof is name-based
 * and holds in the old directory too), and a BAD `cd` that may not have run
 * still poisons — over-escalation, the safe direction.
 */
function artifactCleanPoisonWalk(command: string): boolean[] {
  const poisonedBySegment: boolean[] = [];
  let poisoned = false;
  for (const part of splitCompoundParts(command)) {
    // Like the scratch walk: the state RECORDED for a segment is the one in
    // effect when the shell reaches it — a `cd` poisons the segments after
    // it, not itself (a `cd` segment is neutral and never matches anyway).
    poisonedBySegment.push(poisoned);
    const trimmed = part.text.trim();
    if (trimmed === '') continue;
    // Detect the `cd` in the PEELED body, not the raw text, for the same
    // reason the scratch walk does: `then cd /etc` is a `cd` that moves the
    // shell, and judging raw text here while `matchCoveredCommand` judges
    // the peeled body is the two-walks-that-must-agree defect shape (#1000).
    const body = stripShellGrammar(trimmed).command;
    if (body === '') continue;
    // Redirect clauses stripped BEFORE tokenizing, matching what
    // `artifactCleanVeto` already does to the same text -- two walks of one
    // command computed from two different strings is the #1000 defect shape,
    // and here it was live: `shellWords('cd ..>/dev/null')` glues the operand
    // to the redirect, so `cdTargetIsPlainDescendant` saw a token that was
    // neither `..` nor `../…` and set no poison. `cd ..>/dev/null && rm -rf
    // dist` approved at 0ms, and the segment is idempotent, so N of them climb
    // N levels -- reaching `~/.venv`, verbatim the outcome #1047 was supposed
    // to have closed. Stripping first also EARNS coverage:
    // `cd sub 2>/dev/null && rm -rf dist` now approves correctly.
    const stripped = rewriteRedirectClauses(body, () => '').trim();
    const words = shellWords(stripped);
    if (words[0] !== 'cd') continue;
    if (body !== trimmed || !cdTargetIsPlainDescendant(words)) poisoned = true;
  }
  return poisonedBySegment;
}

/**
 * Veto for a segment `artifact-clean`'s own prefix matched, dispatching by
 * the matched family. Returns true to REFUSE — fall through to the LLM,
 * where deletion still escalates at every level: the prompt half of #956's
 * rule is untouched by ADR 0023.
 *
 * Any redirect clause still present in `segment` is discard/fd-dup by
 * construction (`hasShellControl` vetoed everything else before this ran);
 * it is stripped so a leftover token like `2>/dev/null` is not mistaken for
 * a positional target — the same reasoning as `scratchTargetVeto`.
 */
function artifactCleanVeto(segment: string, matchedPrefix: string, poisoned: boolean): boolean {
  if (poisoned) return true;
  // A redirect character INSIDE a target token vetoes outright, before the
  // rewrite below can hide it. Found by the ADR 0023 PR review, and it was a
  // real bypass rather than the bounded residual an earlier draft of the ADR
  // claimed:
  //
  //     rm -rf 'dist>x/../../src'   ->  approved, and it deletes ../src
  //
  // `rewriteRedirectClauses` is quote-BLIND and runs on raw text, so it
  // truncated the token at the quoted `>` and `isProvedArtifactTarget` only
  // ever saw `dist`. The `..` segments the ascent guard exists to catch were
  // invisible to it. `hasShellControl` reads a quote-MASKED view and correctly
  // treats that `>` as literal, so nothing else objected. Verified against a
  // real filesystem: with a directory named `dist>x`, the command deleted a
  // sibling above the cwd -- and `mkdir 'dist>x'` is itself auto-approved by
  // `fs-write`, making it a two-step, both-silent chain.
  //
  // A genuine redirect clause is its own token (`2>/dev/null`, `>out.txt`), so
  // requiring the redirect shape to START the token keeps those working while
  // refusing an embedded one. Allow-side narrowing: the safe direction.
  if (shellWords(segment).some((w) => /[<>]/.test(w) && !/^\d*(?:>>?|<)/.test(w))) return true;
  const stripped = rewriteRedirectClauses(segment, () => '').trim();
  const words = shellWords(stripped);

  if (matchedPrefix === 'rm' || matchedPrefix === 'rmdir') {
    // Flag axis first: the exact allowlist in write-flag-safety.ts.
    if (hasUnsafeWriteFlag(stripped)) return true;
    const targets = words.slice(1).filter((w) => w !== '' && !w.startsWith('-'));
    // No target, no proof: a bare `rm -rf` approves nothing. And EVERY
    // token is checked rather than guessing which one is "the destination",
    // mirroring `segmentTouchesSensitivePath`'s reasoning: getting a
    // command's flag grammar wrong can only fail in the safe direction here
    // (an extra escalation, never a wrongly-approved delete).
    if (targets.length === 0) return true;
    return !targets.every(isProvedArtifactTarget);
  }

  if (matchedPrefix === 'git worktree remove') {
    // Defensive re-anchor: a prefix match guarantees the raw text starts
    // with the entry, and this guarantees the TOKENIZED view agrees.
    if (words[0] !== 'git' || words[1] !== 'worktree' || words[2] !== 'remove') return true;
    let force = 0;
    const positionals: string[] = [];
    for (const w of words.slice(3)) {
      if (w === '') continue;
      if (w === '-f' || w === '--force') {
        force++;
        continue;
      }
      // ANY other flag fails closed — `-C`, `--git-dir`, a bare `--`, a
      // value-carrying `--force=...`: the safety argument is git's runtime
      // refusal profile, and an unmodeled flag could change it.
      if (w.startsWith('-')) return true;
      positionals.push(w);
    }
    // A LOCKED worktree needs a second --force, which this group never
    // grants: the lock is a human's explicit "do not clean this up".
    if (force > 1) return true;
    if (positionals.length !== 1) return true;
    return positionals[0] === '.';
  }

  if (matchedPrefix === 'bun install') {
    if (words[0] !== 'bun' || words[1] !== 'install') return true;
    for (const w of words.slice(2)) {
      if (w === '' || w === '--frozen-lockfile') continue;
      // A positional makes it `bun add` in disguise; any other flag
      // (`--force`, `-g`, ...) is outside the lockfile-faithful shape.
      return true;
    }
    return false;
  }

  // A prefix this dispatch does not model is refused, not guessed.
  return true;
}

export interface PermissionGroup {
  /** Bare tool names this group approves (e.g. "Read", "Glob"). */
  readonly tools: readonly string[];
  /** Curated Bash command prefixes (word-boundary prefix match). */
  readonly commands: readonly string[];
  /**
   * Extra veto for a Bash segment this group's prefix matched (#959).
   *
   * Absent means the READ profile: the blanket `MUTATION_TOKEN` +
   * `hasScopedVeto` predicate every group used before write groups existed.
   * A write group MUST supply its own, because the read profile rejects
   * `--output`/`--write`/`-delete`-class tokens outright and would therefore
   * veto every write prefix by construction.
   *
   * Supplying one does NOT buy past `hasShellControl` or `hasExecPrimitive`:
   * those run in `matchCoveredCommand` regardless, and are about the segment
   * being a DIFFERENT command rather than about mutation.
   */
  readonly segmentVeto?: (segment: string) => boolean;
  /**
   * Extra veto for a TOOL match this group covers (#959). Absent means no
   * input inspection at all, which is the historical behavior and is correct
   * for read tools — `Read` is safe whatever `file_path` says.
   *
   * A write tool is the opposite: `Write` to `~/.remi/config.toml` or
   * `.git/hooks/pre-commit` is exactly the case a bare tool-name match would
   * wave through. Any group listing a mutating tool must supply this.
   */
  readonly toolVeto?: (toolName: string, toolInput: Record<string, unknown>) => boolean;
}

/**
 * Tool-input keys that name a destination on the mutating tools. `Write`,
 * `Edit` and `NotebookEdit` all carry exactly one of these.
 */
const TOOL_PATH_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/** Refuse a mutating tool call whose destination is sensitive (#959). */
function vetoSensitiveToolPath(_toolName: string, toolInput: Record<string, unknown>): boolean {
  for (const key of TOOL_PATH_KEYS) {
    const value = toolInput[key];
    if (typeof value === 'string' && isSensitiveWritePath(value)) return true;
  }
  return false;
}

export const BUILTIN_GROUPS: Readonly<Record<string, PermissionGroup>> = {
  'read-only': {
    tools: ['Read', 'Glob', 'Grep', 'NotebookRead'],
    commands: [
      'cat',
      'head',
      'tail',
      'less',
      'sed -n',
      'grep',
      'egrep',
      'rg',
      'wc',
      'file',
      'stat',
      'column',
      'cut',
      'uniq',
      'jq',
      'ls',
      // Pure lookups and string operations, added after a live session showed
      // them sinking otherwise-covered compound reads. None opens a file for
      // writing, none takes an output-path flag, and none executes what it
      // finds -- `which` resolves a PATH entry, it does not run it.
      'which',
      'basename',
      'dirname',
      'realpath',
      // macOS Spotlight query. Read-only by construction (`mdutil` is the
      // mutating sibling and is deliberately absent).
      'mdfind',
      'du',
      'df',
      // #1057 phase 3 commit 3: evidence-based addition from the #996/#999
      // corpora. `find` has a read form flippable to deletion / arbitrary
      // file-write by a flag this list cannot see by name alone -- but it
      // has a veto that fires on exactly that shape for EVERY matched
      // segment, regardless of which curated prefix matched it:
      // `EXEC_PRIMITIVE_TOKEN`'s `-delete`/`-exec`/`-execdir`/`-ok`/`-okdir`/
      // `-fprint*`/`-fls` entries (shell-safety.ts, consulted by
      // `matchCoveredCommand` unconditionally) PLUS the mirrored spellings in
      // `MUTATION_TOKEN` (below) that close the quote-splitting gap the raw
      // `EXEC_PRIMITIVE_TOKEN` regex alone missed (#1062 C3: `find . -fprin"t"
      // /tmp/x` unquotes to `-fprint` and was never checked against anything
      // but the still-quoted raw text). So the bare command name is safe to
      // curate here.
      //
      // `awk` is deliberately ABSENT (#1062 C1, CRITICAL RCE, adversarial
      // review of this branch). It was curated on the same theory as `find`
      // above -- that `EXEC_SCOPED_VETOES`'s system()/pipe-to-shell entry
      // covers every dangerous shape -- and that theory is false: awk is
      // Turing-complete, and the veto is a raw-text regex looking for
      // `system(`/`| sh` literally in the program text. Proven bypasses that
      // regex never sees: `cmd | getline r` (arbitrary command execution with
      // no `system(` token at all), `print > "/path"` and `getline < "/path"`
      // (file write/read entirely inside the program's own quoted string,
      // invisible to a check that only looks for shell redirection), and
      // trivial string-splicing of the literal token itself (`sys""tem(`).
      // None of these can be curated by a better flag/pattern rule -- the
      // program body is an arbitrary script, not an argument list -- so `awk`
      // is refused unconditionally at every level, like `curl`/`wget`/`perl`.
      'find',
      // `sort`/`tree`/`diff` are read transforms whose one write escape
      // (`-o`/`--output`) is refused by their SCOPED_VETOES entries below --
      // added together with the veto, never bare, because `sort -o out in`
      // is a real file write the name alone cannot reveal.
      'sort',
      'tree',
      'diff',
      // Pure text/stream transforms verified to carry no destination-writing
      // flag on either BSD or GNU builds: stdin/stdout (or their file
      // operands, read-only) only.
      'tr',
      'comm',
      'paste',
      'nl',
      'rev',
    ],
  },
  'vcs-read': {
    tools: [],
    commands: [
      'git show',
      'git log',
      'git diff',
      'git status',
      'git blame',
      'git ls-files',
      'git ls-tree',
      'git rev-parse',
      'git describe',
      'git cat-file',
      'git show-ref',
      'git for-each-ref',
      'git shortlog',
      // #1057 phase 3 commit 3: a remote READ. `git fetch` updates
      // remote-tracking refs (`origin/main`, ...) from the remote; it never
      // touches the working tree or the current branch -- that is `git
      // merge`/`git pull`'s job, not fetch's. `git push` (the write half of
      // remote sync) stays excluded at every level, unaffected by this.
      'git fetch',
      // `git reflog` alone exposes `git reflog expire|delete` (history loss);
      // pin to the read-only subcommands.
      'git reflog show',
      'git reflog exists',
      'git whatchanged',
      'git grep',
      'git stash list',
      'git config --get',
      'git config --list',
      'git config -l',
      // `git branch`/`git tag`/`git remote` are intentionally omitted: their
      // list flags (`-a`/`-l`/`-v`) sit one positional or `-d`/`-D`/`-m` away
      // from a delete/rename/add, and git overloads those short flags (e.g.
      // `-d` is delete for branch but `--directories` for `git grep`), so a
      // flag veto is unreliable. Use `git rev-parse --abbrev-ref HEAD` for the
      // current branch; users can add others to the `allow` list explicitly.
      'gh pr view',
      'gh pr diff',
      'gh pr list',
      'gh pr checks',
      'gh pr status',
      'gh issue view',
      'gh issue list',
      'gh issue status',
      'gh run view',
      'gh run list',
      'gh repo view',
      'gh release view',
      'gh release list',
      'gh search',
      'gh status',
    ],
  },
  'build-test': {
    tools: [],
    commands: [
      'bun test',
      'bun run test',
      'bun run typecheck',
      'bun run check',
      'bun run lint',
      'tsc --noEmit',
      'biome check',
      'bunx biome check',
      'pytest',
      'uv run pytest',
      'vitest run',
      // `eslint` is omitted: `--rulesdir`/`--resolve-plugins-relative-to` load
      // and execute arbitrary JS. NOTE: enabling build-test means you trust
      // running your project's own test/build commands, which execute project
      // code by design (and may write coverage/report artifacts).
    ],
  },
  /**
   * Outbound reads (ADR 0025). In NO level preset and in no shipped default —
   * every preset stays entirely local, and this one must be asked for by name.
   *
   * It exists because `WebFetch`/`WebSearch` previously matched nothing at all,
   * so every web call from every subagent parked, rendered and entered the
   * serial eval queue. Measured on a live 0.7.6 session: a fan-out of five
   * concurrent `general-purpose` agents saturated that queue and the waiters
   * escalated on `queue_timeout` WITHOUT the LLM ever running. The most common
   * thing a research subagent does took the most expensive path available.
   *
   * Deliberately NOT added to `trusted`: that level is chosen for git mutation
   * and proved-derived deletion, and someone who selected it for those reasons
   * would silently gain arbitrary outbound egress on upgrade — the exact
   * quiet-widening ADR 0023 fixed in `matchGroups` one release earlier.
   *
   * The asymmetry that settles it: a wrongly-escalated fetch is a nuisance, a
   * wrongly-approved one is an exfiltration channel. `WebFetch` takes an
   * arbitrary URL and a subagent is the context no human is watching.
   */
  'net-read': {
    tools: ['WebFetch', 'WebSearch'],
    // No commands. `curl`/`wget` are deliberately absent: they are general
    // process-executing tools whose flags write files (`-o`, `-O`) and whose
    // output is routinely piped into a shell. Covering them here would smuggle
    // a write and an exec path into a group whose name promises a read.
    commands: [],
  },
  // --- Write-side groups (#959). Opt-in via `approve_groups`; none is on by
  // --- default, so this addition changes no shipped behavior on its own.
  'fs-write': {
    // The measured pain: 57 of 225 escalations on a real machine were plain
    // writes, against a config whose `instructions` approve them in prose.
    tools: ['Write', 'Edit', 'NotebookEdit'],
    commands: [
      'mkdir',
      'touch',
      'tee',
      'cp',
      'mv',
      // #1057 phase 2 commit 4: in-place edits under a strict script-shape
      // allowlist (`sedScriptShapeVeto`, above) — every script must be a
      // single, unconditional `s///` or `y///`, so no address prefix, brace
      // block, or side-command (`w`/`e`/`r`/`R`) can ride through it.
      'sed -i',
      // `truncate`, `dd`, `shred`, `chmod` and `chown` are deliberately
      // absent at every strictness level (#956). `rm`/`rmdir` are absent
      // from THIS group for a polarity reason (ADR 0023): fs-write's
      // destination axis is a DENYlist ("not a known-bad path"), which is
      // the right shape for writes and fails OPEN for deletion — `rm -rf
      // src` touches nothing sensitive. Deletion approves only through a
      // destination-PROOF group, where the target must be shown disposable:
      // `scratch` (under a scratch root) and `artifact-clean` (exact-named
      // derived directories; `trusted` only). Everything else
      // deletion-shaped still escalates at every level.
    ],
    segmentVeto: writeGroupVeto,
    toolVeto: vetoSensitiveToolPath,
  },
  'vcs-write': {
    tools: [],
    commands: [
      'git add',
      'git commit',
      'git checkout',
      'git switch',
      'git merge',
      // #1057 phase 3 commit 3: remote read (`git fetch`) + local merge into
      // the current branch -- the write half is entirely local, exactly what
      // this group already covers via `git merge` on its own. `git push`
      // (the actual remote MUTATION) stays excluded at every level below,
      // untouched by this addition.
      'git pull',
      // #972: bare, not `git stash push`. `git stash` with no subcommand IS
      // push (git's own default), and `git stash pop` restores — both purely
      // local, both what this group exists to cover, and both were escalating
      // in the field because only the explicit `push` spelling was listed.
      // The `drop`/`clear` subcommands this necessarily also prefix-matches are
      // refused by WRITE_GROUP_POSITIONAL_VETOES above.
      'git stash',
      'git worktree add',
      // Excluded: `git push` (remote mutation), `git rm`, `git reset`,
      // `git clean`, `git branch -D`, `git worktree remove`. The flag vetoes
      // above catch the destructive forms of what IS listed -- `checkout .`,
      // `checkout --`, any `--force`/`--hard`/`-D`, `commit --no-verify`,
      // `stash drop`, `stash clear`.
    ],
    segmentVeto: writeGroupVeto,
  },
  // See the "`scratch` group" section above `PermissionGroup` for the full
  // design writeup, including why this entry has no `segmentVeto`: the
  // stateful cd-tracking and redirect handling it needs live in `matchGroups`
  // itself, not behind the stateless `(segment) => boolean` this field's type
  // requires.
  scratch: {
    tools: [],
    commands: SCRATCH_COMMANDS,
  },
  // See the "`artifact-clean` group" section above `PermissionGroup` for the
  // full design writeup (ADR 0023). Like `scratch`, no `segmentVeto` field:
  // its veto needs the cd-poison state for the segment's INDEX, which the
  // stateless `(segment) => boolean` signature has no room for, so
  // `matchGroups` calls `artifactCleanVeto` directly. Gated into `trusted`
  // only (levels.ts).
  'artifact-clean': {
    tools: [],
    commands: ['rm', 'rmdir', 'git worktree remove', 'bun install'],
  },
};

/**
 * Unambiguous mutation indicators. None legitimately appears in a curated read
 * command, so matching one can only mean a write snuck past a read prefix
 * (e.g. `git diff --output=f`, `biome check --write`, `find . -delete`).
 *
 * Exported for tests ONLY (#957 review). `shell-safety`'s per-segment-veto
 * tests need the real predicate rather than a hand-copied one: a duplicate
 * stays byte-identical right up until someone widens this list, at which
 * point those tests keep passing against a stale veto and report confidence
 * they no longer have.
 */
export const MUTATION_TOKEN =
  /(^|\s)(-X|--method|--field|--raw-field|--input|--output|--write|--apply|--fix|-delete|-exec|-execdir|-ok)(\s|=|$)/;

/** True if a name is a built-in group. */
export function isKnownGroup(name: string): boolean {
  return Object.hasOwn(BUILTIN_GROUPS, name);
}

/** All built-in group names (for validation / docs). */
export function knownGroupNames(): string[] {
  return Object.keys(BUILTIN_GROUPS);
}

/**
 * Family-scoped flag vetoes: a flag that flips a curated read prefix into a
 * write or code-execution, but whose flag letter is overloaded (it reads for
 * other commands), so it cannot live in the global MUTATION_TOKEN.
 */
const SCOPED_VETOES: ReadonlyArray<{ family: RegExp; flag: RegExp }> = [
  // `sed -n` is read; `sed -n -i`/`--in-place` rewrites the file. The suffix
  // can attach directly (`-i.bak`), so match any `-i` token (no read sed flag
  // starts with `-i`). `-i` is case-insensitive for grep, so it cannot be a
  // global mutation token — this veto is scoped to sed.
  { family: /^sed\b/, flag: /(^|\s)(-i|--in-place)/ },
  // `bun test --preload <file>` executes an arbitrary file before the suite.
  { family: /^bunx?\b/, flag: /(^|\s)--preload(\s|=|$)/ },
  // `sort` is a pure stream transform except `-o`/`--output`, which writes
  // the result to an arbitrary file. No read sort flag starts with `-o`, and
  // the prefix form catches the attached spelling (`-ofile`) too.
  { family: /^sort\b/, flag: /(^|\s)(-o|--output)/ },
  // `tree -o filename` writes the listing to a file (no long form exists).
  { family: /^tree\b/, flag: /(^|\s)-o/ },
  // Neither BSD nor GNU diff has a `-o`/`--output` write flag today; this
  // entry is defensive parity with `sort`/`tree` so a build that grows one
  // (or a lookalike binary) stays refused, and the long-standing
  // `diff ... -o /tmp/patch` adversarial pin keeps its null outcome.
  { family: /^diff\b/, flag: /(^|\s)(-o|--output)/ },
];

/** True if a family-scoped veto flag applies to this segment. */
function hasScopedVeto(segment: string): boolean {
  for (const { family, flag } of SCOPED_VETOES) {
    if (family.test(segment) && flag.test(segment)) return true;
  }
  return false;
}

/**
 * Decide whether a Bash command is fully covered by the given read prefixes.
 * Returns the (most specific) matched prefix, or null to fall through to the LLM.
 *
 * A command is approved only when EVERY compound segment is either neutral
 * (cd/pwd/echo/...) or matches a read prefix, none carries shell control or a
 * mutation flag, and at least one segment actually matched a read prefix (a
 * command of only neutral segments is not "a read").
 */
export function matchReadOnlyCommand(command: string, prefixes: readonly string[]): string | null {
  return matchCoveredCommand(command, prefixes, readSegmentVeto);
}

/**
 * The READ veto profile: the blanket predicate every group used before write
 * groups existed. Named (#959) because `matchGroups` now has to reference it
 * as the default for a group that declares no `segmentVeto` of its own.
 */
function readSegmentVeto(segment: string): boolean {
  if (MUTATION_TOKEN.test(segment) || hasScopedVeto(segment)) return true;
  // Re-check with quotes and escapes removed (#960 round 3). The regexes above
  // match RAW TEXT, which is the same flaw the write-side vetoes were rebuilt
  // to fix — and it was live here too, on groups that ship ENABLED BY DEFAULT:
  //
  //     git diff --"output"=f   -> approved (writes a file)
  //     biome check --"write"   -> approved (mutates source)
  //     sed -n -"i" x           -> approved (in-place edit)
  //
  // while their unquoted forms were all correctly refused. Checking the
  // reconstructed word list in ADDITION to the raw text can only ever add a
  // veto, never remove one, so no previously-refused command becomes allowed.
  const unquoted = shellWords(segment).join(' ');
  if (unquoted === segment) return false;
  return MUTATION_TOKEN.test(unquoted) || hasScopedVeto(unquoted);
}

/**
 * The group-owned per-segment veto dispatch, shared by `matchGroups` and
 * `matchComposedCommand` (#1057 phase 3, commit 1) — the SAME function, not a
 * copy, for the reason `evaluateDeterministic` gives for its own extraction:
 * a duplicated security check drifts the moment one copy is edited and the
 * other is not (ADR 0015/0017's warning, applied here to this dispatch
 * instead of the catastrophic-pattern list). Built once per Bash command from
 * that command's own ADR 0026 pre-pass state (`redirectGrants`,
 * `artifactPoison`), then called per matched segment with the OWNER whose
 * prefix matched.
 */
function vetoedByOwnerFor(
  redirectGrants: RedirectGrantWalk | null,
  artifactPoison: readonly boolean[] | null,
): (owner: string, segment: string, prefix: string, index: number) => boolean {
  return (owner, segment, prefix, index) => {
    // The sensitive-destination axis is a GLOBAL conjunct, checked before any
    // owner's own proof and never delegated to one. Found by the ADR 0023
    // adversarial pass: the owner union below is disjunctive, so a prefix
    // owned by both `fs-write` and `scratch` (`cp`, `mv`, `mkdir`, `touch`,
    // `tee`) was approved the moment scratch's laxer proof held — and
    // `scratchTargetVeto` never consulted `isSensitiveWritePath`. Measured
    // develop -> this branch at BALANCED, a level this ADR does not even
    // claim to touch:
    //
    //   cp /tmp/a /tmp/.env         develop: escalate -> branch: scratch:cp
    //   mv /tmp/a /tmp/id_rsa       develop: escalate -> branch: scratch:mv
    //   cp /tmp/a /tmp/.git/config  develop: escalate -> branch: scratch:cp
    //
    // It also falsified a shipped claim in `config.ts` ("the write groups
    // refuse sensitive destinations regardless of prefix ... credentials
    // (.env, id_rsa)"), which is exactly the ADR 0011 failure mode.
    //
    // Hoisting it here keeps the monotonicity the union was written for --
    // adding a group cannot introduce a sensitive destination, so it still
    // can only ADD approvals -- while restoring the property ADR 0010 wants:
    // a deny-shaped check is broad, and must not be escapable by finding
    // some OTHER owner whose positive proof happens to be laxer.
    //
    // Scoped to the MUTATING owners, not applied globally. A first cut
    // applied it to every owner and broke three read tests
    // (`jq .version package.json`, and two `/dev/null` redirect cases):
    // `segmentTouchesSensitivePath` is a WRITE-side axis, and READING a
    // sensitive path is exactly what `read-only` exists to allow.
    if (MUTATING_GROUPS.has(owner) && segmentTouchesSensitivePath(segment)) return true;
    if (owner === 'scratch') {
      return scratchTargetVeto(segment, redirectGrants?.stateBySegment[index]?.scratch ?? null);
    }
    if (owner === 'artifact-clean') {
      return artifactCleanVeto(segment, prefix, artifactPoison?.[index] ?? true);
    }
    const veto = BUILTIN_GROUPS[owner]?.segmentVeto ?? readSegmentVeto;
    return veto(segment);
  };
}

/**
 * Match a permission request against the named groups. Returns a descriptive
 * `"group:pattern"` string when matched, or null. Unknown group names are
 * ignored (validated separately at config load).
 */
export function matchGroups(
  toolName: string,
  toolInput: Record<string, unknown>,
  groupNames: readonly string[],
): string | null {
  const known = groupNames.filter(isKnownGroup);
  if (known.length === 0) return null;

  if (toolName === 'Bash') {
    const rawCommand = typeof toolInput['command'] === 'string' ? toolInput['command'].trim() : '';
    if (rawCommand === '') return null;
    // Heredoc excision (#1057 phase 2, commit 3), UNCONDITIONALLY, before
    // every other pre-pass and before compound splitting -- see the section
    // above `exciseHeredocsForGroups` for the full rule. Unlike the redirect
    // grants below, this does not need to be gated on which groups were
    // requested: excision cannot grant coverage by itself (it only deletes
    // syntax that was inert, or leaves the command untouched on any
    // ambiguity), so running it for every caller changes no group's
    // approvals except by removing noise the rest of this function would
    // otherwise have judged the accidental (pre-#1057) way.
    const heredocExcised = exciseHeredocsForGroups(rawCommand);
    // `scratch` and `fs-write` (see the section above `PermissionGroup`) each
    // need a redirect clause removed BEFORE `hasShellControl` ever sees it,
    // which has to happen on the whole command ahead of the per-segment
    // machinery below. Only run the pre-pass when at least one of the two
    // grants was actually requested, so every OTHER caller (in particular
    // `strict`, which lists neither) gets back out exactly the string it put
    // in (heredoc excision aside) and nothing here can change its behavior.
    const scratchActive = known.includes('scratch');
    const fsWriteActive = known.includes('fs-write');
    const redirectGrants =
      scratchActive || fsWriteActive
        ? sanitizeCommandForRedirectGrants(heredocExcised, { scratchActive, fsWriteActive })
        : null;
    const command = redirectGrants?.command ?? heredocExcised;
    // The cd-poison pre-walk for `artifact-clean` (ADR 0023). Like the
    // redirect-grant pre-pass: run only when the group was actually
    // requested, and walked over the SAME string `matchCoveredCommand`
    // receives, so the two agree by segment index (the redirect-grant
    // sanitize preserves segment count and joiners; it only rewrites redirect
    // clauses inside segments).
    const artifactPoison = known.includes('artifact-clean')
      ? artifactCleanPoisonWalk(command)
      : null;
    // Map each prefix to EVERY owning group that lists it, in request order.
    // Multiple owners are real, and load-bearing since ADR 0023: at
    // `trusted`, `rm` belongs to BOTH `scratch` (destination proof: under a
    // scratch root) and `artifact-clean` (name proof: an exact-named derived
    // directory), and a segment is approved when EITHER proof holds. The
    // previous first-registrant-wins map would have let `scratch` eat the
    // prefix and veto `rm -rf dist` outright. Trying every owner also makes
    // this matcher monotone in its group list — adding a group can only add
    // approvals — which first-wins quietly was not (a scratch-provable `cp`
    // under /tmp escalated the moment `fs-write` was requested alongside).
    const prefixOwners = new Map<string, string[]>();
    for (const name of known) {
      for (const cmd of BUILTIN_GROUPS[name]?.commands ?? []) {
        const owners = prefixOwners.get(cmd);
        if (owners === undefined) prefixOwners.set(cmd, [name]);
        else owners.push(name);
      }
    }
    // Per-segment veto (#957/#959): each matched segment is judged by the
    // profile of the group that matched IT, not by one blanket rule for the
    // whole command. A group with no `segmentVeto` gets the historical read
    // profile, so read-only/vcs-read/build-test behave exactly as before.
    // `scratch` and `artifact-clean` are special-cased directly (their vetoes
    // need per-INDEX state — the tracked scratch directory, the cd-poison
    // flag — which the stateless `PermissionGroup.segmentVeto` signature has
    // no room for). That state is looked up BY SEGMENT INDEX from the single
    // walk done in the pre-pass, rather than re-tracked by a closure here —
    // see `RedirectGrantWalk`.
    const vetoedByOwner = vetoedByOwnerFor(redirectGrants, artifactPoison);
    // The owner whose proof passed for the FIRST matched segment — the
    // segment whose prefix `matchCoveredCommand` returns — so the label
    // names the group that actually approved it, not the first registrant.
    let hitOwner: string | null = null;
    const hit = matchCoveredCommand(
      command,
      [...prefixOwners.keys()],
      readSegmentVeto,
      (segment, matchedPrefix, index) => {
        for (const owner of prefixOwners.get(matchedPrefix) ?? []) {
          if (!vetoedByOwner(owner, segment, matchedPrefix, index)) {
            if (hitOwner === null) hitOwner = owner;
            return false;
          }
        }
        return true;
      },
    );
    if (hit === null) return null;
    return `${hitOwner ?? prefixOwners.get(hit)?.[0] ?? 'group'}:${hit}`;
  }

  for (const name of known) {
    const group = BUILTIN_GROUPS[name];
    if (group?.tools.includes(toolName) !== true) continue;
    // A mutating tool must have its destination inspected; a bare tool-name
    // match would otherwise cover `Write` to `~/.remi/config.toml` (#959).
    if (group.toolVeto?.(toolName, toolInput) === true) return null;
    return `${name}:${toolName}`;
  }
  return null;
}

/** One `matchComposedCommand` verdict: the first allow-owned and first
 *  group-owned prefix that contributed to covering the command, so the
 *  caller's reasoning string can name one prefix from EACH source (proof
 *  that the union, not either source alone, is what covered it). Either
 *  field is null when that source contributed no segment at all — the
 *  degenerate case exercised by an empty `allowPrefixes` or empty
 *  `groupNames` (see the function doc). */
export interface ComposedMatch {
  readonly allowHit: string | null;
  readonly groupHit: string | null;
}

/**
 * Match a Bash command against the UNION of the user's own `allow` command
 * prefixes and the enabled permission groups (#1057 phase 3, commit 1).
 *
 * `matchAllowPattern` and `matchGroups` each run their OWN independent
 * `matchCoveredCommand` walk, and each demands EVERY segment be covered by
 * ITS OWN source alone. A chain whose segments are covered only by the UNION
 * of the two fails both walks even though a human reading the config would
 * call it obviously covered:
 *
 *     ssh hallu nvidia-smi | head -2     allow=["ssh hallu"]; head in read-only
 *     uv run pytest | tail -5            allow=["uv run"]; tail in read-only
 *
 * This runs ONE `matchCoveredCommand` walk over the union of prefixes instead,
 * so `ssh hallu` and `head` can each cover their own segment in the same pass.
 * `evaluateDeterministic` calls this ONLY after both `matchAllowPattern` and
 * `matchGroups` have already missed on the SAME command — see that method's
 * doc for why the ordering matters (unchanged reasoning strings, and outcomes,
 * for every single-source chain).
 *
 * Composition never widens what either source alone would approve for a
 * segment it matches:
 *
 *   - A segment whose matched prefix is owned ONLY by `allow` gets exactly
 *     `matchAllowPattern`'s treatment — no group veto is layered on top. The
 *     exec-primitive rule (`hasExecPrimitive(seg) && !hasExecPrimitive(hit)`)
 *     still applies, because `matchCoveredCommand` runs it unconditionally
 *     after any `vetoForMatched` verdict, allow included.
 *   - A segment whose matched prefix is owned by a GROUP gets `matchGroups`'s
 *     own `vetoedByOwnerFor` dispatch, unchanged (sensitive-path conjunct,
 *     `segmentVeto`, the scratch/artifact-clean per-index state walks).
 *   - A prefix owned by BOTH sources approves the segment when EITHER
 *     source's veto passes — the same first-passing-owner disjunction
 *     `matchGroups` already uses across multiple group owners, with "allow"
 *     simply added as one more candidate owner.
 *
 * The ADR 0026 pre-passes (heredoc excision, redirect grants) run exactly as
 * they do in `matchGroups`: heredoc excision unconditionally, redirect grants
 * gated on `scratch`/`fs-write` GROUP membership only. Allow membership never
 * extends that gate — `allow = ["python3"]` with no `fs-write` group must NOT
 * make a redirect grant available that group membership alone would not have
 * granted; see the paired test for the positive case (both active, and the
 * grant composes with an allow-covered head).
 */
export function matchComposedCommand(
  command: string,
  allowPrefixes: readonly string[],
  groupNames: readonly string[],
): ComposedMatch | null {
  const trimmed = command.trim();
  if (trimmed === '') return null;
  // Tool-name-shaped entries say nothing about shell commands (same filter
  // `matchAllowPattern` applies) -- dropping them here is what stops
  // `allow = ['Read']` from feeding "Read" into the union as a command prefix.
  const commandAllowPrefixes = allowPrefixes.filter((p) => p.length > 0 && !looksLikeToolName(p));
  const known = groupNames.filter(isKnownGroup);
  if (commandAllowPrefixes.length === 0 && known.length === 0) return null;

  // Same pre-passes as `matchGroups`, same gating (group membership only --
  // see the function doc for why allow membership must never extend it).
  const heredocExcised = exciseHeredocsForGroups(trimmed);
  const scratchActive = known.includes('scratch');
  const fsWriteActive = known.includes('fs-write');
  const redirectGrants =
    scratchActive || fsWriteActive
      ? sanitizeCommandForRedirectGrants(heredocExcised, { scratchActive, fsWriteActive })
      : null;
  const sanitized = redirectGrants?.command ?? heredocExcised;
  const artifactPoison = known.includes('artifact-clean')
    ? artifactCleanPoisonWalk(sanitized)
    : null;

  // Map each prefix to every owning source, in request order, `allow` first.
  // A prefix present in both an allow entry and a group's command list keeps
  // BOTH owners, exactly like `matchGroups` already does for a prefix two
  // groups both list.
  const prefixOwners = new Map<string, string[]>();
  for (const p of commandAllowPrefixes) {
    const owners = prefixOwners.get(p);
    if (owners === undefined) prefixOwners.set(p, ['allow']);
    else if (!owners.includes('allow')) owners.push('allow');
  }
  for (const name of known) {
    for (const cmd of BUILTIN_GROUPS[name]?.commands ?? []) {
      const owners = prefixOwners.get(cmd);
      if (owners === undefined) prefixOwners.set(cmd, [name]);
      else if (!owners.includes(name)) owners.push(name);
    }
  }

  const groupVeto = vetoedByOwnerFor(redirectGrants, artifactPoison);
  let allowHit: string | null = null;
  let groupHit: string | null = null;
  const hit = matchCoveredCommand(
    sanitized,
    [...prefixOwners.keys()],
    readSegmentVeto,
    (segment, matchedPrefix, index) => {
      for (const owner of prefixOwners.get(matchedPrefix) ?? []) {
        // `allow` carries no group veto of its own -- the allow path's only
        // per-segment check is the exec-primitive rule, and
        // `matchCoveredCommand` already applies that unconditionally after
        // this callback returns, allow-owned or not.
        const vetoed = owner === 'allow' ? false : groupVeto(owner, segment, matchedPrefix, index);
        if (!vetoed) {
          if (owner === 'allow') {
            if (allowHit === null) allowHit = matchedPrefix;
          } else if (groupHit === null) {
            groupHit = matchedPrefix;
          }
          return false;
        }
      }
      return true;
    },
  );
  if (hit === null) return null;
  return { allowHit, groupHit };
}

/**
 * Match a permission request against the named groups the way a STOP RULE has
 * to: does ANY part of this command belong to a class the user hard-blocked?
 *
 * `matchGroups` answers the opposite question — "is the ENTIRE command covered,
 * may I skip the LLM?" — and answers it precisely, returning null the moment
 * one compound segment is not covered. That precision is correct for an ALLOW
 * decision and backwards for a DENY one, which is ADR 0010's whole point: allow
 * matching is narrow, deny matching is broad, and a rule that fails in the
 * wrong direction is worse than no rule.
 *
 * Asking the precise matcher a deny question meant appending anything it did
 * not recognise defeated the block outright (#1001):
 *
 *     deny_groups = ["fs-write"]
 *     mkdir /tmp/x              -> denied
 *     mkdir /tmp/x && ls -la    -> NOT denied
 *
 * — including the exact `mkdir` the user configured it to stop.
 *
 * So this deliberately does NOT require total coverage, and deliberately does
 * NOT apply `segmentVeto`/`toolVeto`. Those vetoes exist to NARROW an allow
 * match (a mutation flag means "do not approve this"); applying them here would
 * mean a command that looks MORE dangerous is LESS likely to be denied.
 */

/**
 * Wrappers the DENY path unwraps that `COMMAND_WRAPPERS` (risk-bands.ts) does
 * not list.
 *
 * **The first version of this comment justified the split with a mechanism the
 * code does not have.** It claimed risk-bands must not strip `sudo`, because
 * `hasDangerousWholeWord` raises the band BECAUSE `sudo` is present and
 * unwrapping would lower it. Review disproved that empirically: that check runs
 * on the RAW segment text and short-circuits BEFORE `unwrapCommand` is called,
 * so adding `sudo` to the shared set changes its classification not at all
 * (`sudo mkdir` stays high, `sudo rm -rf /important` stays critical). Recorded
 * here rather than silently rewritten — a wrong explanation in a comment is the
 * failure ADR 0011 exists to name, and this file is where that ADR is cited.
 *
 * The real reason to keep `sudo`/`su`/`doas` separate is a genuine difference
 * in what the two consumers are asking. `classifyRisk` treats an elevation
 * wrapper's mere PRESENCE as the risk signal — privilege elevation is dangerous
 * regardless of what it wraps — while this matcher wants to see THROUGH it to
 * the operation being elevated. Those are different questions about the same
 * token, which is the one situation where two sets are right.
 *
 * The other eight names have no such argument, and review showed sharing them
 * would IMPROVE risk-bands rather than harm it: `setsid git push origin main
 * --force` grades `moderate` there today while the bare command grades `high`,
 * because the wrapper hides the command from the classifier. That is a live gap
 * in a shipped module, filed separately — they stay here until it is fixed, so
 * the deny path is not waiting on it.
 */
const DENY_EXTRA_WRAPPERS: ReadonlySet<string> = new Set([
  'sudo',
  'su',
  'doas',
  'runuser',
  'ionice',
  'setsid',
  'script',
  'chrt',
  'taskset',
  'proxychains',
  'systemd-run',
]);

function isDenyUnwrappableWrapper(word: string): boolean {
  return COMMAND_WRAPPERS.has(word) || DENY_EXTRA_WRAPPERS.has(word);
}

/**
 * Rewrite a segment's HEAD word into the command name the shell would actually
 * resolve, for the three spellings that hide it without any shell control:
 *
 *   /bin/mkdir x        path-qualified -- `matchPrefix` only knows bare names
 *   ${x:-mkdir} x       parameter expansion with a literal default
 *   {mkdir,} x          brace expansion
 *
 * All three confirmed to really run `mkdir` in review. Only the head word is
 * touched: an ARGUMENT that happens to look like a path is not a command name,
 * and rewriting those would invent matches.
 */
function normalizeHeadWord(words: readonly string[]): readonly string[] {
  const head = words[0];
  if (head === undefined || head === '') return words;
  let name = head;
  const expansion = /^\$\{[A-Za-z_][A-Za-z0-9_]*:?[-=]([^}]*)\}$/.exec(name);
  if (expansion !== null) name = expansion[1] ?? name;
  const brace = /^\{([^,{}]+),?\}$/.exec(name);
  if (brace !== null) name = brace[1] ?? name;
  if (name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1);
  return name === head ? words : [name, ...words.slice(1)];
}

/** Bounds the unwrap recursion below; a real command nests a handful of levels. */
const MAX_DENY_UNWRAP_DEPTH = 4;

/**
 * Find a denied prefix anywhere a segment could actually run one.
 *
 * A stop rule has to see through the things that HIDE a command name, and
 * review of #1001 proved five separate ways to hide one, each verified by
 * running it in real bash:
 *
 *     mkdir\t/tmp/x    'mkdir' /tmp/x    env mkdir /tmp/x
 *     sh -c "mkdir x"   true & mkdir x    x=$(mkdir /tmp/x)
 *
 * The first instinct — treat any segment carrying shell control as a match,
 * since ambiguity should block — was measured and abandoned. Over the real
 * corpus it made EVERY group name block ~44% of ordinary traffic, because
 * roughly 400 of 921 commands carry a redirect, a substitution or a wrapper
 * somewhere. A deny knob that blocks half of everything is one people switch
 * off, which is a worse security outcome than the gap it closes.
 *
 * So this UNWRAPS instead of refusing: it looks inside the wrapper, the `-c`
 * argument, the substitution and the backgrounded half, and matches the real
 * command name in each. Precise where precision is possible, and still broad in
 * the ADR 0010 sense — any ONE part matching is enough.
 */
function findDenyHitInSegment(
  segment: string,
  prefixes: readonly string[],
  depth: number,
): string | null {
  // `${IFS}` expands to a space, so `mkdir${IFS}/tmp/x` really runs `mkdir` --
  // a standard, deliberate filter-bypass technique, not an accident. Normalized
  // before anything else looks at the text.
  const seg = segment.replace(/\$\{IFS\}|\$IFS\b/g, ' ').trim();
  if (seg === '' || depth > MAX_DENY_UNWRAP_DEPTH) return null;

  // Grammar first (#999), so `do mkdir /tmp/x` cannot evade what `mkdir
  // /tmp/x` catches.
  const body = stripShellGrammar(seg).command || seg;

  // Raw text AND `shellWords`-tokenized text. Tokenizing is what defeats
  // quoting, escaping and tab separators — the shell strips those before
  // resolving a command name, so a raw-string compare is looking at something
  // the shell never sees.
  const words = shellWords(body);
  for (const candidate of [body, words.join(' '), normalizeHeadWord(words).join(' ')]) {
    const hit = matchPrefix(candidate, prefixes);
    if (hit !== null) return hit;
  }

  // A lone `&` backgrounds the left side and runs the right; `splitCompound`
  // deliberately leaves it glued (the allow path wants `hasShellControl` to
  // veto the whole segment), so the deny path splits it itself.
  if (/(^|[^&>])&(?![&>0-9])/.test(body)) {
    for (const part of body.split(/(?<![&>])&(?![&>0-9])/)) {
      const hit = findDenyHitInSegment(part, prefixes, depth + 1);
      if (hit !== null) return hit;
    }
  }

  // A wrapper renames the head token without changing what runs. Drop leading
  // wrapper tokens and their flags, then judge the remainder.
  if (isDenyUnwrappableWrapper(words[0] ?? '')) {
    // Scan forward from every position after the wrapper rather than trying to
    // model each wrapper's flag grammar. `runuser -u root -- mkdir` and
    // `script -q /tmp/log mkdir` both bury the real command behind a wrapper's
    // POSITIONAL argument, and enumerating which flags take values for eleven
    // wrappers is exactly the per-tool denylist that lost repeatedly in #1004.
    //
    // Broad, but scoped: it only applies once a wrapper head is confirmed, so
    // an ordinary command's arguments are never scanned this way.
    for (let i = 1; i < words.length; i++) {
      // Every position is tried, INCLUDING one that follows a flag. That
      // knowingly accepts a false positive: `env -u mkdir git status` unsets a
      // variable NAMED mkdir and runs `git status`, but reports
      // `fs-write:mkdir`.
      //
      // Skipping post-flag positions was tried and reverted. It broke two real
      // evasions immediately -- `su -c "mkdir /tmp/x"` (an interpreter's `-c`
      // value IS a command) and `ionice -c2 -n0 mkdir` (attached flags consume
      // no following token) -- because telling a flag's value from a command
      // needs each wrapper's flag grammar, which is the per-tool denylist that
      // lost repeatedly in #1004.
      //
      // The trade is asymmetric and settles it: the false positive
      // over-blocks, which for a stop rule the user opted into is a prompt;
      // the evasions under-block, which is the failure ADR 0010 calls
      // unacceptable.
      const hit = findDenyHitInSegment(words.slice(i).join(' '), prefixes, depth + 1);
      if (hit !== null) return hit;
    }
  }

  // An interpreter's `-c` argument is a command line, not an argument.
  if (SHELL_C_BINARIES.has(words[0] ?? '')) {
    const cIndex = words.indexOf('-c');
    const inner = cIndex === -1 ? undefined : words[cIndex + 1];
    if (inner !== undefined) {
      const hit = findDenyHitInSegment(inner, prefixes, depth + 1);
      if (hit !== null) return hit;
    }
  }

  // Command substitution runs its contents.
  for (const m of body.matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) {
    const inner = m[1] ?? m[2];
    if (inner === undefined || inner === '') continue;
    const hit = findDenyHitInSegment(inner, prefixes, depth + 1);
    if (hit !== null) return hit;
  }

  return null;
}

export function matchGroupsBroad(
  toolName: string,
  toolInput: Record<string, unknown>,
  groupNames: readonly string[],
): string | null {
  const known = groupNames.filter(isKnownGroup);
  if (known.length === 0) return null;

  if (toolName === 'Bash') {
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'].trim() : '';
    if (command === '') return null;
    const prefixToGroup = new Map<string, string>();
    for (const name of known) {
      for (const cmd of BUILTIN_GROUPS[name]?.commands ?? []) {
        if (!prefixToGroup.has(cmd)) prefixToGroup.set(cmd, name);
      }
    }
    const prefixes = [...prefixToGroup.keys()];
    for (const raw of splitCompoundParts(command)) {
      const seg = raw.text.trim();
      if (seg === '') continue;
      // AMBIGUITY MEANS BLOCK, the mirror image of the allow path. Shell
      // control, substitution or backgrounding means this module cannot say
      // what the segment runs — and for a stop rule "I cannot tell" must
      // resolve to a match, not to a pass. `matchGroups` refuses to APPROVE on
      // the same signal; refusing to DENY on it would be the identical
      // reasoning applied in the fatal direction.
      //
      // Review proved these are not theoretical. Every one of these really
      // executes a `mkdir` and every one evaded `deny_groups=["fs-write"]`,
      // verified against real bash:
      //   true & mkdir /tmp/x        (a lone `&` is not a compound separator)
      //   x=$(mkdir /tmp/x)          (substitution)
      //   sh -c "mkdir /tmp/x"       (wrapper)
      const hit = findDenyHitInSegment(seg, prefixes, 0);
      if (hit !== null) return `${prefixToGroup.get(hit) ?? 'group'}:${hit}`;
    }
    return null;
  }

  for (const name of known) {
    if (BUILTIN_GROUPS[name]?.tools.includes(toolName) === true) return `${name}:${toolName}`;
  }
  return null;
}
