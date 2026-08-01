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

import { isSensitiveWritePath, segmentTouchesSensitivePath } from './sensitive-paths.ts';
import { matchCoveredCommand, shellWords } from './shell-safety.ts';
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
      'git stash push',
      'git worktree add',
      // Excluded: `git push` (remote mutation), `git rm`, `git reset`,
      // `git clean`, `git branch -D`, `git worktree remove`. The flag vetoes
      // above catch the destructive forms of what IS listed -- `checkout .`,
      // `checkout --`, any `--force`/`--hard`/`-D`, `commit --no-verify`.
    ],
    segmentVeto: writeGroupVeto,
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
  return MUTATION_TOKEN.test(segment) || hasScopedVeto(segment);
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
    const command = typeof toolInput['command'] === 'string' ? toolInput['command'].trim() : '';
    if (command === '') return null;
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
    const hit = matchCoveredCommand(
      command,
      [...prefixToGroup.keys()],
      readSegmentVeto,
      (segment, matchedPrefix) => {
        const owner = prefixToGroup.get(matchedPrefix);
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
