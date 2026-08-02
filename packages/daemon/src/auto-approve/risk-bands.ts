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
 * ## Command-wrapper bypass (found in review, fixed before merge)
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
 * Fixed with two independent mechanisms, deliberately not just one:
 *
 * 1. `unwrapCommand` strips a known list of command-wrapper prefixes (`env`,
 *    `nohup`, `timeout`, `nice`, `time`, `stdbuf`, `command`, `xargs`,
 *    `sshpass`, plus bare `VAR=value` shell assignments) before any
 *    head-token check runs. It is necessarily incomplete — the list is a
 *    denylist, and an unenumerated wrapper is guaranteed to exist.
 * 2. `hasDangerousWholeWord` is the backstop for exactly that gap: it matches
 *    a small set of unconditionally-dangerous command names (`ssh`, `rm`,
 *    `rmdir`, `shred`, `truncate`) as WHOLE WORDS anywhere in the raw segment
 *    text, independent of tokenization or wrapper position. This is
 *    deliberately broad (ADR 0010: a deny-shaped judgment errs up) and
 *    ACCEPTS false positives as the cost of closing the bypass —
 *    `echo "use ssh to connect"` grades `high`. That costs one extra
 *    confirmation, which is the correct direction to be wrong in; narrowing
 *    it to avoid that false positive would reopen the one-word bypass this
 *    exists to close. The list stays small on purpose so it does not swallow
 *    the whole `moderate` band — see the constant's doc for why `scp`/`rsync`
 *    are excluded from it specifically.
 */

import { matchesCatastrophicPattern } from './deny-floor.ts';
import { isSensitiveWritePath, segmentTouchesSensitivePath } from './sensitive-paths.ts';
import { shellWords, splitCompound } from './shell-safety.ts';

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
const COMMAND_WRAPPERS: ReadonlySet<string> = new Set([
  'env',
  'nohup',
  'timeout',
  'nice',
  'time',
  'stdbuf',
  'command',
  'xargs',
  'sshpass',
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
  env: new Set(['-u', '--unset', '-C', '--chdir', '-S', '--split-string']),
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
 * rule would otherwise leave `30` as the presumed head.
 */
const WRAPPER_POSITIONAL_ARG: Readonly<Record<string, RegExp>> = {
  timeout: /^[0-9]+(\.[0-9]+)?[smhd]?$/i,
};

/** True for a bare `NAME=value` shell assignment token (`FOO=1 cmd`, valid with or without `env`). */
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
    while (rest.length > 0 && isAssignmentToken(rest[0] ?? '')) {
      rest = rest.slice(1);
    }
    const head = rest[0];
    if (head === undefined || !COMMAND_WRAPPERS.has(head)) return rest;
    rest = rest.slice(1);
    const valueFlags = WRAPPER_VALUE_FLAGS[head];
    while (rest.length > 0) {
      const token = rest[0] ?? '';
      if (isAssignmentToken(token)) {
        rest = rest.slice(1);
        continue;
      }
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
 * cannot hide "ssh" or "rm" from a word-boundary scan of the raw text.
 *
 * Deliberately SMALL and restricted to names dangerous UNCONDITIONALLY — any
 * invocation of `ssh`/`rm`/`rmdir`/`shred`/`truncate` is remote or
 * destructive whatever its arguments — NOT a general keyword list, per the
 * instruction to keep whole-token matching narrow enough that it does not
 * swallow the `moderate` band. `scp` and `rsync` are excluded ON PURPOSE:
 * they are ordinary local file copies without a remote destination, so
 * flagging their names alone would be wrong far more often than a wrapper
 * hides them. They are instead checked for an actual remote destination
 * argument by `isScpOrRsyncRemote` below.
 *
 * Accepted trade-off (ADR 0010: err broad in the deny direction) — this WILL
 * misclassify prose containing these words (`echo "use ssh to connect"`,
 * `git commit -m "fix rm bug"` both grade `high`). That costs one extra
 * confirmation later, the correct direction to be wrong in; narrowing this to
 * avoid the false positive reopens the one-word bypass it exists to close.
 */
const DANGEROUS_WHOLE_WORDS: readonly string[] = ['ssh', 'rm', 'rmdir', 'shred', 'truncate'];

const DANGEROUS_WHOLE_WORD_PATTERNS: readonly RegExp[] = DANGEROUS_WHOLE_WORDS.map(
  (word) => new RegExp(`\\b${word}\\b`),
);

/** True if `segment`'s raw text contains a `DANGEROUS_WHOLE_WORDS` entry as a whole word. */
function hasDangerousWholeWord(segment: string): boolean {
  return DANGEROUS_WHOLE_WORD_PATTERNS.some((pattern) => pattern.test(segment));
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
  if (words[0] !== 'gh' || words[1] !== 'api') return false;
  return words
    .slice(2)
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
  if (words[0] !== 'gh') return false;
  if (words[1] === 'pr' && (words[2] === 'merge' || words[2] === 'close' || words[2] === 'create'))
    return true;
  if (words[1] === 'issue' && (words[2] === 'create' || words[2] === 'close')) return true;
  return false;
}

/** Remote mutation: `git push`, `ssh`, remote `scp`/`rsync`, mutating curl/wget/gh api/gh pr/gh issue. */
function isRemoteMutation(words: readonly string[]): boolean {
  const bin = words[0];
  if (bin === undefined) return false;
  if (bin === 'git' && words[1] === 'push') return true;
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
    const sub = words[1];
    if (sub === 'rm' || sub === 'clean') return true;
    if (sub === 'reset' && words.includes('--hard')) return true;
    if (sub === 'branch' && words.includes('-D')) return true;
    if (hasGitForceFlag(words)) return true;
  }
  return false;
}

/**
 * True if a `chmod`/`chown` segment's target looks like it reaches outside
 * the project tree. This module is pure — no cwd, no config — so "the
 * project tree" cannot be resolved exactly; the same limits `sensitive-
 * paths.ts` documents apply here. Two broad (ADR 0010: err up) signals stand
 * in for it: the target matches the existing sensitive-destination denylist
 * (`segmentTouchesSensitivePath`, which already covers system trees and
 * home-rooted secrets), OR any argument is an absolute (`/...`) or
 * home-rooted (`~...`) path — a relative path is the ordinary shape of "a
 * file in the project I'm sitting in"; an absolute path is not something this
 * function can confirm stays under it, so it classifies up rather than
 * assuming it does.
 */
function targetsOutsideProject(segment: string): boolean {
  if (segmentTouchesSensitivePath(segment)) return true;
  return shellWords(segment).some((word) => word.startsWith('/') || word.startsWith('~'));
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
 * Head-token checks run against `unwrapCommand`'s output (a command-wrapper
 * prefix stripped away), not the raw tokenization — see the module doc's
 * "Command-wrapper bypass" section. `hasDangerousWholeWord` runs against the
 * RAW segment text independently, as the backstop for whatever
 * `unwrapCommand` does not recognise.
 */
function classifySegmentBand(rawSegment: string): 'moderate' | 'high' {
  const segment = rawSegment.trim();
  if (segment === '') return 'moderate';
  const words = unwrapCommand(shellWords(segment));
  if (isRemoteMutation(words)) return 'high';
  if (isDestructiveLocalOp(words)) return 'high';
  if (isPrivilegeElevation(words, segment)) return 'high';
  if (isPackageInstall(words)) return 'high';
  if (hasDangerousWholeWord(segment)) return 'high';
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
 *    `timeout 30`, `sshpass -p ...`, ... — cannot hide its real head token,
 *    and separately scanned for a small set of unconditionally-dangerous
 *    whole words (`hasDangerousWholeWord`) as a backstop for whichever
 *    wrapper that list does not know about. For `Bash`, a compound command
 *    (`&&`, `||`, `;`, `|`) is split with `splitCompound` (shell-safety.ts —
 *    the same segmenter `permission-groups.ts` and the user allow-list
 *    matcher already share) and the band is the MAXIMUM across segments: one
 *    dangerous segment makes the whole command `high` regardless of what
 *    else it is chained with, in either order.
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

  for (const rawSegment of splitCompound(command)) {
    if (classifySegmentBand(rawSegment) === 'high') return 'high';
  }
  return 'moderate';
}
