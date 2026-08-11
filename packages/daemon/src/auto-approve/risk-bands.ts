/**
 * A deterministic RISK BAND classifier for auto-approve (#976 step 2).
 *
 * #976's owner framing: authorization is a function of TWO axes, risk and
 * authorization, and the risk axis "mostly already exists and does not need
 * an LLM" — `critical` is `enforceDenyFloor` / `matchesCatastrophicPattern`
 * (deny-floor.ts), `low` is coverage by an approve group (permission-groups.ts,
 * `matchGroups`), and "the residue between them is what actually needs
 * judging, and is much smaller than the current prompt implies." This module
 * IS that residue classifier: `high` vs `moderate` for the operations neither
 * existing guard already resolves.
 *
 * ADR 0015's amendment gives the bands their meaning: `critical` is never
 * approvable at any authorization grade; `high` requires `explicit`/`scoped`
 * authorization from a NON-TEXT channel (a human answer, session precedent, or
 * `config.toml` — never conversation text); `moderate` is reachable by
 * `implicit` (text-derived) authorization; `low` never reaches the model at
 * all. This module only produces the band — it makes no approve/deny/escalate
 * decision and nothing in production calls it yet. A later PR wires it into
 * the risk x authorization matrix.
 *
 * ## Design constraints (all load-bearing)
 *
 * - **Pure and total.** No I/O, no config, no engine call. Same
 *   `(toolName, toolInput)` always produces the same band.
 * - **ADR 0010's asymmetry applies.** This classifier is DENY-shaped — it is
 *   deciding something is dangerous, not that it is safe — so, per ADR 0010,
 *   it should match broadly and err toward the higher band when unsure. A
 *   false `high` costs an extra confirmation later; a false `moderate` on a
 *   genuinely dangerous command is the product failing at the thing #976
 *   exists to fix.
 * - **`low` cannot come from text.** A permission-group hit is the CALLER's
 *   knowledge (it ran `matchGroups` itself), not something `classifyRisk` can
 *   infer from a command string — the same command with no group configured
 *   is not "low risk", it is "not yet evaluated by a group". Expressed in the
 *   type: `classifyRisk` returns `Exclude<RiskBand, 'low'>`, so a caller
 *   cannot accidentally get `low` out of text inspection. `bandForGroupMatch`
 *   is the separate, tiny helper that turns the caller's own group-match
 *   result into `low`.
 *
 * ## Command-hiding bypasses (found in review, fixed before merge)
 *
 * The first version of this module keyed every `high` check on the HEAD
 * token of a Bash segment. That is a one-word bypass: `nohup rm -rf ./dist`
 * graded `moderate` while the identical operation, bare, graded `high` —
 * a wrapper binary in front hid the real command from every check. Two of the
 * measured misses were not hypothetical: `sshpass ... ssh ...` is the
 * `sshpass` entry in `run-authority-grading-sweep.ts`'s OPERATIONS list, and
 * `scp`/`rsync` with a remote destination are already in
 * `authority-counterfactual.ts`'s `RISKY_SHAPES` (lines 116-118) — this
 * module was narrower than the guard it exists to feed.
 *
 * A second review round measured the first fix as only PARTIAL: it closed the
 * bypass for 2 of 7 `high` sub-categories (the `ssh` branch of remote
 * mutation, and destructive-local), because the whole-word backstop's list is
 * small by design and the wrapper list only strips a PREFIX — it does nothing
 * for a command hidden inside `sh -c "..."`, inside `$(...)`/backticks/`<(...)`,
 * or behind an exec primitive (`find -exec`, `git -c core.hooksPath=`, `awk
 * 'system(...)'`), and a positional-index assumption in the `git`/`gh`
 * subcommand checks broke on an intervening global flag
 * (`git --no-pager push`, `gh --repo x/y pr merge`).
 *
 * Closed with mechanisms layered on top of each other, deliberately not just
 * one, reusing what already exists rather than inventing new detectors
 * (`shell-safety.ts` already exports and tests `hasExecPrimitive`/`:147` and
 * is already an ADR 0010 receipt):
 *
 * 1. `unwrapCommand` strips a known list of command-wrapper prefixes (`env`,
 *    `nohup`, `timeout`, `nice`, `time`, `stdbuf`, `command`, `xargs`,
 *    `sshpass`, `strace`, `unbuffer`, `firejail`, `faketty`, `unshare`,
 *    `watch`, `chroot`, plus bare `VAR=value` shell assignments) before any
 *    head-token check runs. It is necessarily incomplete — the list is a
 *    denylist, and an unenumerated wrapper is guaranteed to exist.
 * 2. `hasDangerousWholeWord` is a backstop for exactly that gap: it matches a
 *    small set of unconditionally-dangerous command names (`ssh`, `rm`,
 *    `rmdir`, `shred`, `truncate`, `sudo`, `doas`) as WHOLE WORDS anywhere in
 *    the raw segment text, independent of tokenization or wrapper position.
 *    Deliberately broad (ADR 0010: a deny-shaped judgment errs up) — see the
 *    constant's doc for the ACTUAL measured false-positive surface (it is
 *    wider than a single prose example suggests) and why `scp`/`rsync` are
 *    excluded from it specifically.
 * 3. `extractSubstitutions` finds `$(...)`, backtick, and `<(...)` spans,
 *    replaces each with a neutral placeholder in the OUTER segment (so the
 *    outer command's own word boundaries are not corrupted by whatever is
 *    inside), and RECURSES `classifySegmentBand` into each inner command
 *    text. This is why it is recursion and not a blanket escalate: it
 *    correctly separates `$(git rev-parse --show-toplevel)` (recurses to
 *    `moderate`) from `$(curl -X POST ...)` (recurses to `high`) instead of
 *    flagging every substitution regardless of content.
 * 4. `extractShellDashC` recognises `sh -c "..."` / `bash -c "..."` /
 *    `zsh -c "..."` (and `/bin/...`, `/usr/bin/...` forms) as a wrapper whose
 *    ENTIRE wrapped command is the `-c` argument, and recurses into it the
 *    same way.
 * 5. `hasExecPrimitive` (shell-safety.ts, already used by the permission-group
 *    and allow-list matchers) is reused as-is for `find -exec`,
 *    `git -c core.hooksPath=`, `awk 'system(...)'` and the rest of that
 *    family — not reimplemented.
 * 6. `gitSubcommandIndex`/`ghTopIndex` walk past a RECOGNISED global flag
 *    (`git --no-pager`, `gh --repo x/y`, ...) to find the actual subcommand,
 *    the same walk `unwrapCommand` already does for wrapper flags — replacing
 *    the fixed `words[1]`/`words[2]` indexing that broke on one.
 *
 * (3) and (4) both recurse through `classifyCommandMax`/`classifySegmentBand`
 * with a bounded depth (`MAX_RECURSION_DEPTH`) so a maliciously (or just
 * deeply) nested construct cannot loop; hitting the bound classifies `high`
 * rather than silently stopping, per the same err-broad direction.
 */

import { matchesCatastrophicPattern } from './deny-floor.ts';
import { isSensitiveWritePath, segmentTouchesSensitivePath } from './sensitive-paths.ts';
import { hasExecPrimitive, shellWords, splitCompound } from './shell-safety.ts';

export const RISK_BANDS = ['low', 'moderate', 'high', 'critical'] as const;

export type RiskBand = (typeof RISK_BANDS)[number];

const RISK_BAND_RANK: Readonly<Record<RiskBand, number>> = {
  low: 0,
  moderate: 1,
  high: 2,
  critical: 3,
};

/** Numeric rank for ordering comparisons (`low` lowest, `critical` highest). */
export function riskBandRank(band: RiskBand): number {
  return RISK_BAND_RANK[band];
}

/** True if `band` is at least as severe as `threshold`. */
export function riskBandAtLeast(band: RiskBand, threshold: RiskBand): boolean {
  return riskBandRank(band) >= riskBandRank(threshold);
}

/**
 * Fold a permission-group match into `low`. This is the ONLY place this
 * module produces `low`, and it exists precisely because `classifyRisk`
 * cannot: `low` means "a permission group already covers it", which the
 * caller learns by running `matchGroups` (permission-groups.ts) itself — by
 * the time that returns a hit, the LLM is never consulted at all, so there is
 * no text-only judgment call left to make.
 *
 * Typical caller shape:
 *
 *     const groupHit = matchGroups(toolName, toolInput, approveGroups);
 *     const band: RiskBand = bandForGroupMatch(groupHit) ?? classifyRisk(toolName, toolInput);
 */
export function bandForGroupMatch(groupHit: string | null): RiskBand | undefined {
  return groupHit === null ? undefined : 'low';
}

/**
 * Command-wrapper binaries that hide the real command's head token behind an
 * innocuous one (#976 field report). Stripped by `unwrapCommand` before any
 * head-token check runs. Inherently incomplete — see the module doc's
 * "Command-wrapper bypass" section for why `hasDangerousWholeWord` exists as
 * a second, independent mechanism rather than relying on this list alone.
 */
export const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'nohup',
  'timeout',
  'nice',
  'time',
  'stdbuf',
  'command',
  'xargs',
  'sshpass',
  'strace',
  'unbuffer',
  'firejail',
  'faketty',
  'unshare',
  'watch',
  'chroot',
]);

/**
 * Flags on a wrapper binary that consume a SEPARATE following token as their
 * value (as opposed to an attached form like `-I{}` or `-oL`, which is a
 * single token and needs no extra consumption). Not exhaustive — an
 * unrecognised value flag can leave its value sitting in front of the real
 * head, which is one more reason `hasDangerousWholeWord` exists as a backstop
 * rather than trusting this table to be complete.
 */
const WRAPPER_VALUE_FLAGS: Readonly<Record<string, ReadonlySet<string>>> = {
  // `-S`/`--split-string` is deliberately ABSENT: its value is not inert
  // metadata like `-u`/`-C`, it is a full command line that env re-splits and
  // executes. Discarding it as a value flag erased the command entirely, so
  // `env -S 'PYTEST_PLUGINS=evil_plugin pytest'` graded `moderate` while the
  // bare form graded `high` (#1004 re-review, proven by real execution).
  // `extractEnvSplitString` extracts and RECURSES into it instead, the same
  // shape `extractShellDashC` already uses for `sh -c`.
  env: new Set(['-u', '--unset', '-C', '--chdir']),
  timeout: new Set(['-s', '--signal', '-k', '--kill-after']),
  nice: new Set(['-n', '--adjustment']),
  stdbuf: new Set(['-i', '-o', '-e', '--input', '--output', '--error']),
  xargs: new Set([
    '-I',
    '-P',
    '-L',
    '-n',
    '-d',
    '-s',
    '-a',
    '--replace',
    '--max-procs',
    '--max-lines',
    '--max-args',
    '--delimiter',
    '--max-chars',
    '--arg-file',
  ]),
  sshpass: new Set(['-p', '-f', '-d', '-P', '-U']),
  time: new Set(['-f', '-o', '--format', '--output']),
};

/**
 * Wrappers whose FIRST non-flag positional argument is a bare value (not the
 * wrapped command) and must be skipped too — `timeout 30 ssh ...` has no
 * flag in front of `30`, so the generic "stop at the first non-flag token"
 * rule would otherwise leave `30` as the presumed head. `chroot NEWROOT cmd`
 * is the same shape with an unconstrained value (a path), so its pattern
 * matches any non-empty token unconditionally.
 */
const WRAPPER_POSITIONAL_ARG: Readonly<Record<string, RegExp>> = {
  timeout: /^[0-9]+(\.[0-9]+)?[smhd]?$/i,
  chroot: /^\S+$/,
};

/** A bare `NAME=value` shell assignment token (`FOO=1 cmd`, valid with or without `env`). */
function isAssignmentToken(word: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(word);
}

/**
 * Strip leading command-wrapper tokens, their flags/flag-values, and bare
 * `VAR=value` shell assignments, to find the real command's head token.
 * Loops so chained wrappers (`nice nohup rm ...`) are fully unwrapped.
 *
 * Best-effort, not a shell parser — see `WRAPPER_VALUE_FLAGS`'s doc for what
 * that costs and why `hasDangerousWholeWord` exists as an independent
 * backstop rather than a fallback that only matters if this is imperfect.
 */
function unwrapCommand(words: readonly string[]): readonly string[] {
  let rest = words;
  for (;;) {
    // Assignments are NOT stripped. Stripping them made
    // `HOME=/tmp/evilhome git commit` grade `moderate` -- byte-identical to a
    // plain `git commit` -- so `enforceRiskCeiling`, whose job is to override a
    // wrong LLM approval, could never fire on it. Leaving the token in place is
    // what lets the head-position check below see it.
    const head = rest[0];
    if (head === undefined || !COMMAND_WRAPPERS.has(head)) return rest;
    rest = rest.slice(1);
    const valueFlags = WRAPPER_VALUE_FLAGS[head];
    while (rest.length > 0) {
      const token = rest[0] ?? '';
      // An assignment is NOT consumed here either. This inner loop is a second
      // stripper, and removing only the outer one left `env
      // PYTEST_PLUGINS=evil_plugin pytest` grading `moderate` while the bare
      // form correctly graded `high` -- `env` is the one wrapper that really
      // does take `NAME=value` arguments, and stripping them handed the head
      // token straight to the band check with the dangerous part discarded.
      // Leaving the token in place is what lets the head-position check see it.
      if (!token.startsWith('-')) break;
      rest = rest.slice(1);
      if (valueFlags?.has(token) === true) rest = rest.slice(1);
    }
    const positionalPattern = WRAPPER_POSITIONAL_ARG[head];
    if (positionalPattern?.test(rest[0] ?? '') === true) {
      rest = rest.slice(1);
    }
  }
}

/**
 * Command names that are dangerous regardless of position or wrapping,
 * matched as WHOLE WORDS (`\b...\b`) anywhere in the raw segment text — not
 * through the tokenizer, so a quoted phrase like `echo "use ssh to connect"`
 * still contains the word "ssh". Backstop for `unwrapCommand`'s inherent
 * incompleteness: an unenumerated wrapper still hides the head token, but
 * cannot hide "ssh"/"rm"/"sudo" from a word-boundary scan of the raw text.
 *
 * Deliberately SMALL and restricted to names dangerous UNCONDITIONALLY — any
 * invocation of `ssh`/`rm`/`rmdir`/`shred`/`truncate`/`sudo`/`doas` is remote,
 * destructive, or privilege-elevating whatever its arguments — NOT a general
 * keyword list, per the instruction to keep whole-token matching narrow
 * enough that it does not swallow the `moderate` band. `scp` and `rsync` are
 * excluded ON PURPOSE: they are ordinary local file copies without a remote
 * destination, so flagging their names alone would be wrong far more often
 * than a wrapper hides them. They are instead checked for an actual remote
 * destination argument by `isScpOrRsyncRemote` below.
 *
 * ## Accepted trade-off (ADR 0010: err broad in the deny direction) —
 * measured, not a single cherry-picked example
 *
 * `\b`-word-boundary matching treats `-` and `/` as non-word characters, so
 * this fires on any PATH SEGMENT, PACKAGE NAME, or BRANCH NAME that contains
 * one of these words as a hyphen- or slash-delimited component, not only on
 * prose. Measured real cases, all grading `high`:
 *
 *     cat packages/rm-utils/index.ts            (a path segment)
 *     grep -rn "ssh-agent" packages/daemon/src   (a quoted search term)
 *     npm rm left-pad                            (npm's OWN "rm" subcommand)
 *     ls -la config/ssh/known_hosts.example      (a directory name)
 *     git checkout feature/rm-old-cache-logic    (a branch name)
 *
 * (Prose like `echo "use ssh to connect"` and `git commit -m "fix rm bug"`
 * also grades `high`, for the same reason.) That costs one extra confirmation
 * on an ordinary read-only command, the correct direction to be wrong in;
 * narrowing this to avoid the false positive reopens the one-word bypass it
 * exists to close. Keep the behavior — describe it accurately rather than
 * understating it with a single softened example.
 */
const DANGEROUS_WHOLE_WORDS: readonly string[] = [
  'ssh',
  'rm',
  'rmdir',
  'shred',
  'truncate',
  'sudo',
  'doas',
];

const DANGEROUS_WHOLE_WORD_PATTERNS: readonly RegExp[] = DANGEROUS_WHOLE_WORDS.map(
  (word) => new RegExp(`\\b${word}\\b`),
);

/** True if `segment`'s raw text contains a `DANGEROUS_WHOLE_WORDS` entry as a whole word. */
function hasDangerousWholeWord(segment: string): boolean {
  return DANGEROUS_WHOLE_WORD_PATTERNS.some((pattern) => pattern.test(segment));
}

/**
 * Recursion depth bound for `extractSubstitutions`/`extractShellDashC`.
 * Guards against a maliciously (or just deeply) nested construct looping;
 * hitting the bound classifies `high` rather than silently stopping, per this
 * module's err-broad direction (ADR 0010) — see the callers.
 */
const MAX_RECURSION_DEPTH = 4;

/** Placeholder substituted for an extracted `$(...)`/backtick/`<(...)` span so the OUTER segment's word boundaries survive whatever whitespace was inside it. */
const SUBSTITUTION_PLACEHOLDER = '__SUBST__';

/** Index of the `)` matching the `(` at `text[openIndex]`, or -1 if unterminated. Handles nesting; does not track quotes (best-effort, see `extractSubstitutions`). */
function findMatchingParen(text: string, openIndex: number): number {
  let depth = 1;
  for (let i = openIndex + 1; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Index of the next backtick after `start` not immediately preceded by a backslash, or -1. */
function findClosingBacktick(text: string, start: number): number {
  for (let i = start; i < text.length; i++) {
    if (text[i] === '`' && text[i - 1] !== '\\') return i;
  }
  return -1;
}

interface SubstitutionExtraction {
  /** `segment` with every `$(...)`/backtick/`<(...)` span replaced by `SUBSTITUTION_PLACEHOLDER`. */
  readonly sanitized: string;
  /** The extracted inner text of each span found, in order. */
  readonly inner: readonly string[];
}

/**
 * Find `$(...)`, backtick, and `<(...)` command/process substitutions in a
 * raw segment, replacing each with a neutral placeholder and returning its
 * inner text separately for the caller to recurse into
 * (`classifySegmentBand`).
 *
 * Best-effort, not a shell parser: this does NOT track quote state, so a
 * literal `$(` inside a single-quoted string (where the shell would NOT
 * expand it) is still extracted and recursed into. That can only make this
 * module MORE cautious, never less — the safe direction (ADR 0010) — and it
 * is correct for the common case a double-quoted string, where the shell
 * DOES expand `$(...)`.
 */
function extractSubstitutions(segment: string): SubstitutionExtraction {
  let sanitized = '';
  const inner: string[] = [];
  let i = 0;
  while (i < segment.length) {
    const c = segment[i];
    const next = segment[i + 1];
    if ((c === '$' || c === '<') && next === '(') {
      const close = findMatchingParen(segment, i + 1);
      if (close === -1) {
        sanitized += segment.slice(i);
        break;
      }
      inner.push(segment.slice(i + 2, close));
      sanitized += SUBSTITUTION_PLACEHOLDER;
      i = close + 1;
      continue;
    }
    if (c === '`') {
      const close = findClosingBacktick(segment, i + 1);
      if (close === -1) {
        sanitized += segment.slice(i);
        break;
      }
      inner.push(segment.slice(i + 1, close));
      sanitized += SUBSTITUTION_PLACEHOLDER;
      i = close + 1;
      continue;
    }
    sanitized += c;
    i++;
  }
  return { sanitized, inner };
}

/** `sh`/`bash`/`zsh`/`dash`/`ksh`, bare or path-qualified (`/bin/...`, `/usr/bin/...`). */
export const SHELL_C_BINARIES: ReadonlySet<string> = new Set([
  'sh',
  'bash',
  'zsh',
  'dash',
  'ksh',
  '/bin/sh',
  '/bin/bash',
  '/bin/zsh',
  '/bin/dash',
  '/bin/ksh',
  '/usr/bin/sh',
  '/usr/bin/bash',
  '/usr/bin/zsh',
  '/usr/bin/env',
]);

/**
 * `sh -c "..."` / `bash -c "..."` / `zsh -c "..."` (and path-qualified
 * forms): the ENTIRE wrapped command lives inside the `-c` argument, a single
 * already-dequoted token by the time `shellWords` has run — unlike
 * `unwrapCommand`'s wrappers, which just prepend to the same word list, this
 * shape needs the argument extracted and independently re-parsed. Returns
 * that argument, or null if this is not a `-c` shell invocation.
 */
function extractShellDashC(words: readonly string[]): string | null {
  const bin = words[0];
  if (bin === undefined || !SHELL_C_BINARIES.has(bin)) return null;
  const cIndex = words.indexOf('-c');
  if (cIndex === -1) return null;
  return words[cIndex + 1] ?? null;
}

/**
 * The command line inside `env -S '<...>'` / `env --split-string '<...>'`, or
 * null when there is none.
 *
 * env's own documented feature: the value is re-split and executed, so it is
 * COMMAND CONTENT, not an argument. It must be judged, not skipped — the same
 * reasoning as `sh -c`, and handled the same way (extract, then recurse via
 * `classifyCommandMax`, which re-applies every band rule including this one).
 */
function extractEnvSplitString(words: readonly string[]): string | null {
  if (words[0] !== 'env') return null;
  for (let i = 1; i < words.length; i++) {
    const w = words[i];
    if (w === '-S' || w === '--split-string') return words[i + 1] ?? null;
    // GNU long-option equals form. BSD env (macOS) has no `--split-string` at
    // all, but remi targets Linux too, where GNU getopt accepts it.
    if (w?.startsWith('--split-string=') === true) return w.slice('--split-string='.length);
    // `env -Sfoo` attached form -- works on BSD env, verified on this machine.
    if (w?.startsWith('-S') === true && w.length > 2) return w.slice(2);
  }
  return null;
}

/**
 * `user@host:path` or bare `host:path` remote destination/source argument —
 * the shape `scp`/`rsync` use for a remote endpoint. Excludes a URL scheme
 * (`https://...`) via the negative lookahead: a scheme's colon is always
 * followed by `//`, which this remote-path shape never is.
 */
function hasRemoteDestinationArg(words: readonly string[]): boolean {
  return words.some((w) => /^([\w.-]+@)?[\w.-]+:(?!\/\/)\S*$/.test(w));
}

/**
 * `scp`/`rsync` carrying a remote destination or source (#976, mirrors
 * `authority-counterfactual.ts`'s `RISKY_SHAPES` entries for `scp `/`rsync`,
 * lines 116-118). A purely local invocation (`rsync -av ./src/ ./backup/`) is
 * an ordinary file copy and stays out of this check on purpose — the
 * conditional check here is why `scp`/`rsync` are NOT in
 * `DANGEROUS_WHOLE_WORDS` above.
 */
function isScpOrRsyncRemote(words: readonly string[]): boolean {
  const bin = words[0];
  if (bin !== 'scp' && bin !== 'rsync') return false;
  return hasRemoteDestinationArg(words);
}

/**
 * Package-manager (binary, subcommands) pairs whose invocation runs
 * arbitrary install/post-install scripts. `uv add` and `uv pip install` are
 * handled separately below since `uv`'s subcommand is two tokens deep for the
 * latter.
 */
const PACKAGE_INSTALL_SUBCOMMANDS: Readonly<Record<string, readonly string[]>> = {
  bun: ['add', 'install', 'i'],
  npm: ['install', 'i', 'add', 'ci'],
  pnpm: ['add', 'install', 'i'],
  yarn: ['add', 'install'],
  pip: ['install'],
  pip3: ['install'],
  gem: ['install'],
  cargo: ['install'],
};

/** True for `bun add`, `npm install`, `pip install`, `uv add`, ... (#976). */
function isPackageInstall(words: readonly string[]): boolean {
  const bin = words[0];
  const sub = words[1];
  if (bin === undefined || sub === undefined) return false;
  if (bin === 'uv') {
    if (sub === 'add') return true;
    if (sub === 'pip' && words[2] === 'install') return true;
    return false;
  }
  return PACKAGE_INSTALL_SUBCOMMANDS[bin]?.includes(sub) ?? false;
}

/**
 * Walk `words` from `fromIndex`, skipping recognised flags (and, for a flag
 * in `valueFlags`, its separate value token too), and return the index of
 * the first non-flag token found — the actual subcommand once global flags
 * are skipped past. Returns -1 if every remaining token is a flag.
 *
 * The same walk `unwrapCommand` already does for wrapper flags, reused here
 * to fix a DIFFERENT bug: `words[1] === 'push'`-style fixed-index checks
 * silently miss the subcommand when an intervening global flag shifts it
 * (`git --no-pager push`, `gh --repo x/y pr merge`) — not a wrapper hiding a
 * command, just an ordinary flag nobody accounted for.
 */
function skipFlags(
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
const GIT_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--exec-path',
]);

/** Index of `git`'s subcommand (`push`, `status`, ...), skipping global flags, or -1. */
function gitSubcommandIndex(words: readonly string[]): number {
  if (words[0] !== 'git') return -1;
  return skipFlags(words, 1, GIT_GLOBAL_VALUE_FLAGS);
}

/** Global gh flags that take a separate value token. */
const GH_GLOBAL_VALUE_FLAGS: ReadonlySet<string> = new Set(['--repo', '-R', '--hostname']);

/** Index of `gh`'s top-level subcommand (`pr`, `issue`, `api`, ...), skipping global flags, or -1. */
function ghTopIndex(words: readonly string[]): number {
  if (words[0] !== 'gh') return -1;
  return skipFlags(words, 1, GH_GLOBAL_VALUE_FLAGS);
}

/**
 * `curl`/`wget` with a mutating method or a data-carrying flag. A bare
 * `curl <url>` is a GET and stays `moderate`; only an explicit method
 * override or a body flag makes it a remote mutation.
 */
function isMutatingCurlOrWget(words: readonly string[]): boolean {
  const bin = words[0];
  if (bin === 'curl') {
    return words
      .slice(1)
      .some(
        (w) =>
          w === '-X' ||
          w.startsWith('-X') ||
          w === '--request' ||
          w.startsWith('--request=') ||
          w === '-d' ||
          w.startsWith('--data'),
      );
  }
  if (bin === 'wget') {
    return words
      .slice(1)
      .some(
        (w) =>
          w === '--method' ||
          w.startsWith('--method=') ||
          w === '--post-data' ||
          w.startsWith('--post-data=') ||
          w === '--post-file' ||
          w.startsWith('--post-file='),
      );
  }
  return false;
}

/** `gh api` carrying a method override or a field flag mutates (#976, mirrors prompt-builder.ts's remote-mutation bullet). */
function isMutatingGhApi(words: readonly string[]): boolean {
  const topIndex = ghTopIndex(words);
  if (topIndex === -1 || words[topIndex] !== 'api') return false;
  return words
    .slice(topIndex + 1)
    .some(
      (w) =>
        w === '-X' ||
        w.startsWith('-X') ||
        w === '--method' ||
        w.startsWith('--method=') ||
        w === '-f' ||
        w === '-F' ||
        w === '--field' ||
        w.startsWith('--field=') ||
        w === '--raw-field' ||
        w.startsWith('--raw-field='),
    );
}

/** `gh pr merge/close/create`, `gh issue create/close` (#976). */
function isMutatingGhPrOrIssue(words: readonly string[]): boolean {
  const topIndex = ghTopIndex(words);
  if (topIndex === -1) return false;
  const top = words[topIndex];
  const action = words[topIndex + 1];
  if (top === 'pr' && (action === 'merge' || action === 'close' || action === 'create'))
    return true;
  if (top === 'issue' && (action === 'create' || action === 'close')) return true;
  return false;
}

/** Remote mutation: `git push`, `ssh`, remote `scp`/`rsync`, mutating curl/wget/gh api/gh pr/gh issue. */
function isRemoteMutation(words: readonly string[]): boolean {
  const bin = words[0];
  if (bin === undefined) return false;
  const gitSub = gitSubcommandIndex(words);
  if (gitSub !== -1 && words[gitSub] === 'push') return true;
  if (bin === 'ssh') return true;
  if (isScpOrRsyncRemote(words)) return true;
  return isMutatingCurlOrWget(words) || isMutatingGhApi(words) || isMutatingGhPrOrIssue(words);
}

/**
 * `-f`/`--force` (and `--force-*` variants, e.g. `--force-with-lease`) on any
 * git invocation. Deliberately not scoped to a subcommand list: `-f`/`--force`
 * does not appear on git's read-only commands in practice, so checking for it
 * on ANY git segment is broad in the safe direction rather than requiring an
 * enumerated subcommand match (ADR 0010).
 */
function hasGitForceFlag(words: readonly string[]): boolean {
  return words.some(
    (w) => w === '-f' || w === '--force' || w.startsWith('--force=') || w.startsWith('--force-'),
  );
}

/**
 * Destructive local operations: unconditional deletion tools, `find -delete`,
 * and the specific git forms that discard history/work irrecoverably.
 * `git reset --hard`/`git clean`/`git branch -D`/`git rm` are named
 * explicitly per #976's spec; any OTHER git command carrying `--force`/`-f`
 * is caught by `hasGitForceFlag` rather than enumerated one subcommand at a
 * time.
 */
function isDestructiveLocalOp(words: readonly string[]): boolean {
  const bin = words[0];
  if (bin === undefined) return false;
  if (bin === 'rm' || bin === 'rmdir' || bin === 'shred' || bin === 'truncate') return true;
  if (bin === 'find' && words.includes('-delete')) return true;
  if (bin === 'git') {
    const gitSub = gitSubcommandIndex(words);
    const sub = gitSub === -1 ? undefined : words[gitSub];
    if (sub === 'rm' || sub === 'clean') return true;
    if (sub === 'reset' && words.includes('--hard')) return true;
    if (sub === 'branch' && words.includes('-D')) return true;
    if (hasGitForceFlag(words)) return true;
  }
  return false;
}

/**
 * True if a single word looks like it names a destination outside the
 * project tree — absolute (`/...`), home-rooted (`~...` or `$HOME`/`$home`,
 * case-insensitively — matching how `sensitive-paths.ts`'s own
 * `isSensitiveWritePath` normalizes `$HOME` for its OWN check, which this
 * fallback was inconsistent with until this fix), or ascending via a bare
 * `..` path segment anywhere (`../../../`, `-R ../../../`). A relative path
 * with no `..` segment is the ordinary shape of "a file in the project I'm
 * sitting in"; any of the three above is not something this function can
 * confirm stays under it, so it classifies up rather than assuming it does
 * (same reasoning for all three — an absolute path and a pure `..`-ascent
 * both "escape" the tree, just by different routes).
 */
function looksOutsideProject(word: string): boolean {
  if (word.startsWith('/') || word.startsWith('~')) return true;
  const lowered = word.toLowerCase();
  if (lowered === '$home' || lowered.startsWith('$home/')) return true;
  return word.split('/').includes('..');
}

/**
 * True if a `chmod`/`chown` segment's target looks like it reaches outside
 * the project tree. This module is pure — no cwd, no config — so "the
 * project tree" cannot be resolved exactly; the same limits `sensitive-
 * paths.ts` documents apply here. Two broad (ADR 0010: err up) signal
 * sources stand in for it: the target matches the existing
 * sensitive-destination denylist (`segmentTouchesSensitivePath`, which
 * already covers system trees and home-rooted secrets), OR any argument
 * `looksOutsideProject`.
 */
function targetsOutsideProject(segment: string): boolean {
  if (segmentTouchesSensitivePath(segment)) return true;
  return shellWords(segment).some(looksOutsideProject);
}

/** Privilege elevation: `sudo`/`doas`, or `chmod`/`chown` outside the project tree. */
function isPrivilegeElevation(words: readonly string[], segment: string): boolean {
  const bin = words[0];
  if (bin === 'sudo' || bin === 'doas') return true;
  if (bin === 'chmod' || bin === 'chown') return targetsOutsideProject(segment);
  return false;
}

/**
 * Classify one already-split compound-command segment. Never returns
 * `critical` — the catastrophic check runs once over the WHOLE command in
 * `classifyRisk`, matching how `matchesCatastrophicPattern` is used
 * everywhere else in this module (deny-floor.ts, authority.ts): a single
 * substring search over the raw command, not a per-segment one.
 *
 * Order of checks, all documented in the module doc's "Command-hiding
 * bypasses" section:
 *
 * 1. `hasDangerousWholeWord` on the RAW segment text (includes whatever is
 *    inside a substitution, as an extra layer — it does not depend on the
 *    extraction below finding it).
 * 2. `extractSubstitutions` pulls out `$(...)`/backtick/`<(...)` spans and
 *    RECURSES into each (bounded by `depth`), then continues with the
 *    SANITIZED segment (placeholders instead of substitution text) for
 *    every check below, so a substitution's internal whitespace cannot
 *    corrupt this segment's own word boundaries.
 * 3. `hasExecPrimitive` (shell-safety.ts, reused as-is) on the sanitized text.
 * 4. `extractShellDashC` recognises `sh -c "..."` and recurses into the `-c`
 *    argument (bounded by `depth`).
 * 5. The head-token checks, against `unwrapCommand`'s output of the
 *    sanitized, tokenized segment.
 *
 * Hitting `MAX_RECURSION_DEPTH` on a segment that still has more to unpack
 * classifies `high` rather than silently stopping (err broad, ADR 0010).
 */
function classifySegmentBand(rawSegment: string, depth: number): 'moderate' | 'high' {
  const segment = rawSegment.trim();
  if (segment === '') return 'moderate';

  if (hasDangerousWholeWord(segment)) return 'high';

  const { sanitized, inner } = extractSubstitutions(segment);
  if (inner.length > 0) {
    if (depth >= MAX_RECURSION_DEPTH) return 'high';
    for (const innerCommand of inner) {
      if (classifyCommandMax(innerCommand, depth + 1) === 'high') return 'high';
    }
  }

  if (hasExecPrimitive(sanitized)) return 'high';

  const rawWords = shellWords(sanitized);
  // Read BEFORE unwrapping: `unwrapCommand` strips `env` and its flags, so by
  // the time `words` exists the `-S` marker is gone. The first draft of this
  // ran on `words` and never fired at all -- two cases passed anyway, by the
  // accident that the extracted command happened to land at index 0 and trip
  // the assignment rule. Probing the attached form (`env -S'...'`) is what
  // exposed it.
  const envSplit = extractEnvSplitString(rawWords);
  const words = unwrapCommand(rawWords);

  // A leading assignment sets the environment the following command runs in,
  // and what that does is defined by the TOOL, not by anything visible here:
  // `HOME=` redirects git's hooks, `PYTEST_PLUGINS=` imports arbitrary Python,
  // `HTTPS_PROXY=` moves the network. The command after it can look entirely
  // benign to a model, which is exactly when the ceiling has to be the thing
  // that says no.
  //
  // Head position only: an assignment matters as a PREFIX. A later
  // `FOO=bar`-shaped token is just an argument (`git commit -m FOO=bar`).
  if (isAssignmentToken(words[0] ?? '')) return 'high';

  const shellArg = extractShellDashC(words);
  if (shellArg !== null) {
    if (depth >= MAX_RECURSION_DEPTH) return 'high';
    if (classifyCommandMax(shellArg, depth + 1) === 'high') return 'high';
  }

  if (envSplit !== null) {
    if (depth >= MAX_RECURSION_DEPTH) return 'high';
    if (classifyCommandMax(envSplit, depth + 1) === 'high') return 'high';
  }

  if (isRemoteMutation(words)) return 'high';
  if (isDestructiveLocalOp(words)) return 'high';
  if (isPrivilegeElevation(words, sanitized)) return 'high';
  if (isPackageInstall(words)) return 'high';
  return 'moderate';
}

/**
 * Split `command` on compound operators (`splitCompound`, shell-safety.ts)
 * and take the MAXIMUM band across segments — the same logic `classifyRisk`
 * uses at the top level, factored out so `classifySegmentBand` can recurse
 * into an extracted substitution or `sh -c` argument through the SAME
 * compound-aware path rather than a simplified one.
 */
function classifyCommandMax(command: string, depth: number): 'moderate' | 'high' {
  for (const rawSegment of splitCompound(command)) {
    if (classifySegmentBand(rawSegment, depth) === 'high') return 'high';
  }
  return 'moderate';
}

/**
 * Tool-input keys naming a write destination, shared with
 * `permission-groups.ts`'s `vetoSensitiveToolPath` (kept as a local literal
 * rather than imported: that array is `permission-groups.ts`-internal, and
 * duplicating three string literals here is cheaper than exporting an
 * internal constant across an ownership boundary for it).
 */
const WRITE_TOOL_PATH_KEYS: readonly string[] = ['file_path', 'notebook_path', 'path'];

/**
 * Non-Bash tools, classified by what the tool NAME already tells us it can
 * do — the same reasoning `permission-groups.ts` uses for its `toolVeto`
 * hook, applied here without config or group membership:
 *
 * - Read-only tools (`Read`, `Glob`, `Grep`, `NotebookRead`, and anything else
 *   not named below) cannot be made remote, destructive, or privilege-
 *   elevating by their input — a read's `file_path` argument only says WHAT
 *   is read, never something the tool then does to it. `moderate` is the
 *   honest default (never `low`; see the module doc).
 * - Mutating tools (`Write`, `Edit`, `NotebookEdit`) inspect their
 *   destination path the same way `permission-groups.ts`'s `fs-write` group
 *   does: `moderate` for an ordinary project-relative destination, `high`
 *   when it lands on the existing sensitive-destination denylist (system
 *   trees, credentials, `.git/hooks`, this mechanism's own config, build
 *   surfaces the default groups later execute).
 */
function classifyNonBashTool(
  toolName: string,
  toolInput: Record<string, unknown>,
): 'moderate' | 'high' {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    for (const key of WRITE_TOOL_PATH_KEYS) {
      const value = toolInput[key];
      if (typeof value === 'string' && isSensitiveWritePath(value)) return 'high';
    }
  }
  return 'moderate';
}

/**
 * Classify the deterministic risk band of a tool call.
 *
 * Precedence, checked in this order:
 *
 * 1. **`critical`** — `matchesCatastrophicPattern` matches (deny-floor.ts).
 *    Delegated, never duplicated: this module owns none of that pattern
 *    list, so it cannot drift from `enforceDenyFloor`'s.
 * 2. **`high`** — deterministically-detectable remote mutation, destructive/
 *    irreversible local operations, privilege elevation, or package install
 *    (see the per-category helpers above). Each segment is first unwrapped
 *    (`unwrapCommand`) so a command-wrapper prefix — `nohup`, `env FOO=1`,
 *    `timeout 30`, `sshpass -p ...`, ... — cannot hide its real head token;
 *    `sh -c "..."`/`$(...)`/backtick/`<(...)` content is extracted and
 *    RECURSED into; `hasExecPrimitive` (shell-safety.ts) catches
 *    `find -exec`/`git -c core.hooksPath=`/`awk 'system(...)'`; and a small
 *    set of unconditionally-dangerous whole words (`hasDangerousWholeWord`)
 *    is a backstop for whichever wrapper the list does not know about. See
 *    the module doc's "Command-hiding bypasses" section for the full list of
 *    mechanisms. For `Bash`, a compound command (`&&`, `||`, `;`, `|`) is
 *    split with `splitCompound` (shell-safety.ts — the same segmenter
 *    `permission-groups.ts` and the user allow-list matcher already share)
 *    and the band is the MAXIMUM across segments: one dangerous segment
 *    makes the whole command `high` regardless of what else it is chained
 *    with, in either order.
 * 3. **`moderate`** — everything else. The honest default: an unfamiliar
 *    command is `moderate`, not `high` — this function does not attempt to
 *    enumerate "safe" commands (that is the permission-group matcher's job,
 *    and is `low`, and is not reachable from here — see `bandForGroupMatch`).
 *
 * `low` is structurally unreachable: the return type excludes it. See the
 * module doc for why.
 *
 * Pure and total: no I/O, no config, no engine call. Same inputs, same band.
 */
export function classifyRisk(
  toolName: string,
  toolInput: Record<string, unknown>,
): Exclude<RiskBand, 'low'> {
  if (matchesCatastrophicPattern(toolName, toolInput) !== null) {
    return 'critical';
  }

  if (toolName !== 'Bash') {
    return classifyNonBashTool(toolName, toolInput);
  }

  const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
  if (command.trim() === '') return 'moderate';

  return classifyCommandMax(command, 0);
}

/**
 * Which layer produced the verdict that actually shipped (#1040).
 *
 * The reasoning string already says this in prose ("Risk ceiling (#976):
 * model approved a high-risk operation..."), which is why answering "why did
 * this escalate" means reading paragraphs and why the answer cannot be
 * counted across a session at all. A field can be grepped and tallied.
 *
 * MUST stay total over the set of guards in `auto-approve-service.ts` that can
 * replace the model's verdict after it returns. A guard with no member here
 * does not merely lose a label — it falls through to the `'model'` default and
 * reports that the model produced a verdict it did not produce, which is worse
 * than no field at all because it will be counted. The first cut of this type
 * shipped covering two of six guards and was caught in review; `'model'` being
 * the default is exactly what made the omission invisible.
 *
 * Diagnostic only. Nothing reads it back to decide anything, so it cannot
 * drift into being a second, competing copy of the decision.
 */
export type DecidingLayer =
  | 'model'
  | 'deny_floor'
  | 'trust_boundary'
  | 'risk_ceiling'
  | 'precedent'
  | 'counterfactual'
  | 'counterfactual_failed';

/**
 * The matrix context a decision was taken in, for the decision log (#976).
 *
 * Extracted as a pure function rather than inlined into the template so the
 * FORMAT is testable without an engine. The service's decision log only fires
 * after a real LLM round-trip, and the repo forbids mocks, so an inline
 * template string would be effectively untestable — and this string is not
 * decoration, it is the measurement the decision to build (or not build) the
 * matrix's widening half rests on.
 *
 * Both fields matter and neither is sufficient alone. `band` says whether a
 * grade could ever be decisive (`critical` never approves; `high` needs a
 * witness text cannot supply; only `moderate` is in play). `authority` says
 * whether there was any text to grade. The eligible population is the
 * intersection, and it has never been counted.
 */
export function formatMatrixContext(
  band: RiskBand,
  authorityPresent: boolean,
  decidedBy: DecidingLayer = 'model',
): string {
  return `[band=${band} authority=${authorityPresent ? 'yes' : 'no'} decided_by=${decidedBy}]`;
}
