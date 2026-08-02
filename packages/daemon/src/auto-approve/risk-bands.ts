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

/** Remote mutation: `git push`, `ssh`, mutating curl/wget/gh api/gh pr/gh issue. */
function isRemoteMutation(words: readonly string[]): boolean {
  const bin = words[0];
  if (bin === undefined) return false;
  if (bin === 'git' && words[1] === 'push') return true;
  if (bin === 'ssh') return true;
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
 */
function classifySegmentBand(rawSegment: string): 'moderate' | 'high' {
  const segment = rawSegment.trim();
  if (segment === '') return 'moderate';
  const words = shellWords(segment);
  if (isRemoteMutation(words)) return 'high';
  if (isDestructiveLocalOp(words)) return 'high';
  if (isPrivilegeElevation(words, segment)) return 'high';
  if (isPackageInstall(words)) return 'high';
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
 *    (see the per-category helpers above). For `Bash`, a compound command
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
