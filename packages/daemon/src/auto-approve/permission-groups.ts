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
 *    flag (`sort -o`, `find -delete`, `awk` system(), `gh api -X`) are
 *    intentionally EXCLUDED from the curated set. Users can add them via the
 *    `allow` list at their own discretion (per-segment prefix, not substring).
 *  - Non-Bash tools match by bare tool name.
 *
 * The segment splitter and shell-control veto live in `shell-safety.ts`; the
 * user allow list uses the same primitives (#536).
 */

import {
  isSensitiveWritePath,
  resolveDotDot,
  segmentTouchesSensitivePath,
} from './sensitive-paths.ts';
import {
  type CompoundJoiner,
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

/**
 * The veto profile every write-side group shares: the flag boundaries above,
 * plus the sensitive-destination axis a read group never needed
 * (`sensitive-paths.ts`).
 */
function writeGroupVeto(segment: string): boolean {
  return (
    hasUnsafeWriteFlag(segment) ||
    hasWriteGroupPositionalVeto(segment) ||
    segmentTouchesSensitivePath(segment)
  );
}

// ---------------------------------------------------------------------------
// `scratch` group (owner request: "basically any work in /tmp scratch is
// allowed", specifically that scratch deletes stop escalating under #994's
// risk ceiling). A command matches ONLY when every file target it touches
// provably resolves under a scratch root: `/tmp/...`, `/private/tmp/...`
// (macOS's real path for `/tmp`), `$TMPDIR/...`, `${TMPDIR}/...`.
//
// This is deliberately NOT expressed as a stateless `PermissionGroup.
// segmentVeto` the way `fs-write`/`vcs-write` are. Two things it needs that a
// pure `(segment) => boolean` cannot express:
//
//   - A leading `cd` into a scratch root must make later RELATIVE targets in
//     the SAME compound command count as scratch-rooted (the owner's real
//     traffic: `cd /private/tmp/.../scratchpad && <work>`). That is state
//     carried ACROSS segments, in order, which `matchCoveredCommand`'s
//     per-segment veto hooks do not thread through.
//   - `hasShellControl` (shell-safety.ts) vetoes ANY non-`/dev/null` output
//     redirect unconditionally, for every group, and runs before any
//     group-specific veto gets a look. A scratch-rooted redirect target has
//     to be recognised BEFORE that check runs, not after.
//
// Both are handled here, in `matchGroups` itself, rather than through the
// `PermissionGroup` interface: `sanitizeCommandForScratch` removes a
// scratch-granted redirect clause before `matchCoveredCommand` ever sees it,
// and `scratchTargetVeto` is called directly by `matchGroups`'s own
// `vetoForMatched` closure, which threads a single `cwd` variable across the
// whole command the way a segment-by-segment veto function structurally
// cannot.
//
// Honest limits, not solved here, because static analysis cannot cover them:
//
//   - A symlink under `/tmp` pointing outside it. Every check in this section
//     is LEXICAL (path-segment text analysis, like every other guard in this
//     file); none of them resolve the filesystem, and a symlink's target is
//     invisible to a lexical check.
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
      const extra = rest === '' ? [] : rest.split('/');
      const segs = joinScratchSegments(['$TMPDIR'], 1, extra);
      return segs === null ? null : { segments: segs, rootLen: 1 };
    }
  }
  if (token.startsWith('/')) {
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
  if (token.startsWith('/') || token.startsWith('~') || token.startsWith('$')) return null;
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
 * Advance the tracked scratch `cwd` across one trimmed segment. A no-op for
 * anything other than a `cd`. Bare `cd` (goes to `$HOME`) and `cd -`
 * (previous directory, unknowable statically) both reset to null rather than
 * guess.
 */
function advanceScratchCwd(cwd: ScratchCwd, trimmedSegment: string): ScratchCwd {
  if (trimmedSegment === '') return cwd;
  const words = shellWords(trimmedSegment);
  if (words[0] !== 'cd') return cwd;
  const target = words[1];
  if (target === undefined || target === '-') return null;
  return resolveScratchTarget(target, cwd);
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
 * tracked scratch root that differs from the real one, under which a later
 * relative `rm -rf` is approved against a directory nobody checked. Returning
 * true makes the caller forget the directory rather than guess it, the same
 * fail-closed handling bare `cd` and `cd -` already get.
 */
function cdEffectIsUnreliable(joiner: CompoundJoiner, nextJoiner: CompoundJoiner): boolean {
  return joiner === '|' || joiner === '||' || nextJoiner === '|';
}

/**
 * Remove every redirect clause in `segment` whose target is a plain path under
 * a scratch root. REMOVES the clause entirely rather than retargeting it to
 * `/dev/null`: a retargeted clause would still leave a token like
 * `2>/dev/null` sitting in the word list `scratchTargetVeto` scans for
 * positional arguments, which is neither a flag nor a real target and would
 * wrongly fail that scan.
 *
 * Only a `path` target is ever removed. `discard`/`fd-dup` need no help —
 * `hasShellControl` already permits them — and `opaque` must never be removed,
 * since removing it is exactly how a second operator hidden inside the greedy
 * match would escape the veto that was going to catch it.
 */
function sanitizeSegmentRedirects(segment: string, cwd: ScratchCwd): string {
  return rewriteRedirectClauses(segment, (target, text) => {
    if (target.kind !== 'path') return text;
    return isStrictlyUnderScratchRoot(target.path, cwd) ? '' : text;
  });
}

/**
 * Pre-pass over the WHOLE command, run only when `scratch` is among the
 * requested groups: removes every redirect clause whose target is
 * scratch-rooted, tracking `cd` across segments exactly like the real match
 * that follows will. This has to run BEFORE `matchCoveredCommand`, not
 * alongside it: `hasShellControl` cannot be told "except this one clause", it
 * returns one boolean for the whole segment, so the only way to let a
 * scratch-rooted redirect through it is to remove the clause before that
 * check ever sees it.
 *
 * The rebuilt string keeps each segment's ORIGINAL joining operator. An
 * earlier draft rebuilt with a uniform `&&`, reasoning that
 * `matchCoveredCommand` re-splits via `splitCompound` and never inspects which
 * separator joined two segments. That was true of `matchCoveredCommand` and
 * false of the scratch veto downstream of it, which tracks `cd` across
 * segments and so depends on exactly the operator a uniform `&&` erased:
 * flattening `true | cd /tmp` to `true && cd /tmp` converts a discarded
 * subshell `cd` into one the veto believes moved the shell.
 */
function sanitizeCommandForScratch(command: string): ScratchSanitized {
  const parts = splitCompoundParts(command);
  const cwdBySegment: ScratchCwd[] = [];
  let cwd: ScratchCwd = null;
  let rebuilt = '';
  for (const [i, part] of parts.entries()) {
    // The cwd RECORDED for a segment is the one in effect when the shell
    // reaches it, i.e. before its own effect: a `cd` moves the segments after
    // it, not itself.
    cwdBySegment.push(cwd);
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
      // afterwards is not knowable from the text. Forget the directory rather
      // than carry a stale one forward — carrying it forward is what made the
      // escape above auto-approve, so here "unknown" must mean null, never
      // "whatever it was before".
      const wrappedInGrammar = body !== trimmed;
      cwd =
        wrappedInGrammar || cdEffectIsUnreliable(part.joiner, parts[i + 1]?.joiner ?? null)
          ? null
          : advanceScratchCwd(cwd, body);
    } else if (trimmed !== '') {
      text = sanitizeSegmentRedirects(part.text, cwd);
    }
    rebuilt += i === 0 ? text : `${joinerText(part.joiner)}${text}`;
  }
  return { command: rebuilt, cwdBySegment };
}

/**
 * A scratch pre-pass result: the rewritten command, plus the tracked scratch
 * directory in effect at each of its compound segments, BY INDEX.
 *
 * The trajectory is published rather than recomputed downstream because the
 * two used to be computed twice — once here and once by a closure threaded
 * through `matchCoveredCommand` — and two walks of the same command that must
 * agree are exactly the shape that produced the `|`/`||` desync this type
 * exists to prevent recurring. One walk, one answer, read by index.
 */
interface ScratchSanitized {
  readonly command: string;
  readonly cwdBySegment: readonly ScratchCwd[];
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
 * construction: `sanitizeCommandForScratch` already removed every
 * scratch-granted one, and a non-exempt, non-granted clause would have
 * tripped `hasShellControl` before `matchCoveredCommand` ever reached this
 * veto. It is stripped here purely so a leftover token like `2>&1` is not
 * mistaken for a positional target.
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
      // `rm`, `rmdir`, `truncate`, `dd`, `shred`, `chmod` and `chown` are
      // deliberately absent at every strictness level (#956). Deletion and
      // permission changes are where escalation earns its cost; a write group
      // that quietly covered them would be the #536 mistake in a new place.
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
    // `scratch` (see the section above `PermissionGroup`) needs a redirect
    // clause removed BEFORE `hasShellControl` ever sees it, which has to
    // happen on the whole command ahead of the per-segment machinery below.
    // Only run the pre-pass when `scratch` was actually requested, so every
    // OTHER caller (in particular `strict`, which never lists it) gets back
    // out exactly the string it put in and nothing here can change its
    // behavior.
    const scratchActive = known.includes('scratch');
    const scratch = scratchActive ? sanitizeCommandForScratch(rawCommand) : null;
    const command = scratch?.command ?? rawCommand;
    // Map each prefix back to its owning group for the descriptive return.
    const prefixToGroup = new Map<string, string>();
    for (const name of known) {
      for (const cmd of BUILTIN_GROUPS[name]?.commands ?? []) {
        if (!prefixToGroup.has(cmd)) prefixToGroup.set(cmd, name);
      }
    }
    // Per-segment veto (#957/#959): each matched segment is judged by the
    // profile of the group that matched IT, not by one blanket rule for the
    // whole command. A group with no `segmentVeto` gets the historical read
    // profile, so read-only/vcs-read/build-test behave exactly as before.
    // `scratch` is special-cased directly (its veto needs the tracked scratch
    // directory, which the stateless `PermissionGroup.segmentVeto` signature
    // has no room for). That directory is looked up BY SEGMENT INDEX from the
    // single walk done in the pre-pass, rather than re-tracked by a closure
    // here — see `ScratchSanitized`.
    const hit = matchCoveredCommand(
      command,
      [...prefixToGroup.keys()],
      readSegmentVeto,
      (segment, matchedPrefix, index) => {
        const owner = prefixToGroup.get(matchedPrefix);
        if (owner === 'scratch') {
          return scratchTargetVeto(segment, scratch?.cwdBySegment[index] ?? null);
        }
        const group = owner === undefined ? undefined : BUILTIN_GROUPS[owner];
        const veto = group?.segmentVeto ?? readSegmentVeto;
        return veto(segment);
      },
    );
    if (hit === null) return null;
    return `${prefixToGroup.get(hit) ?? 'group'}:${hit}`;
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
      const hit = matchPrefix(seg, prefixes);
      if (hit !== null) return `${prefixToGroup.get(hit) ?? 'group'}:${hit}`;
    }
    // KNOWN GAP, deliberately not closed here: a segment behind a shell grammar
    // keyword (`do rm -rf /`) does not prefix-match, so it evades a deny the
    // bare form catches. `stripShellGrammar` (#999) is what fixes it and lives
    // on an unmerged branch; peeling before the match above is a two-line
    // change once that lands. Noted rather than worked around, because the
    // workaround would be a second grammar recognizer — the exact defect shape
    // this module has already produced four times.
    return null;
  }

  for (const name of known) {
    if (BUILTIN_GROUPS[name]?.tools.includes(toolName) === true) return `${name}:${toolName}`;
  }
  return null;
}
