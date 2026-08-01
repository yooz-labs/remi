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

import { matchCoveredCommand } from './shell-safety.ts';

export interface PermissionGroup {
  /** Bare tool names this group approves (e.g. "Read", "Glob"). */
  readonly tools: readonly string[];
  /** Curated read-only Bash command prefixes (word-boundary prefix match). */
  readonly commands: readonly string[];
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
  return matchCoveredCommand(
    command,
    prefixes,
    (seg) => MUTATION_TOKEN.test(seg) || hasScopedVeto(seg),
  );
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
    const hit = matchReadOnlyCommand(command, [...prefixToGroup.keys()]);
    if (hit === null) return null;
    return `${prefixToGroup.get(hit) ?? 'group'}:${hit}`;
  }

  for (const name of known) {
    if (BUILTIN_GROUPS[name]?.tools.includes(toolName)) {
      return `${name}:${toolName}`;
    }
  }
  return null;
}
