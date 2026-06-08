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
 *    substring `allow` list at their own discretion.
 *  - Non-Bash tools match by bare tool name.
 */

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
      'tree',
      'column',
      'cut',
      'uniq',
      'jq',
      'ls',
      'diff',
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
      'git reflog',
      'git whatchanged',
      'git grep',
      'git remote -v',
      'git remote show',
      'git remote get-url',
      'git branch -a',
      'git branch -r',
      'git branch -v',
      'git branch -vv',
      'git branch --list',
      'git branch --show-current',
      'git tag -l',
      'git tag --list',
      'git stash list',
      'git config --get',
      'git config --list',
      'git config -l',
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
      'eslint',
      'pytest',
      'uv run pytest',
      'vitest run',
    ],
  },
};

/** Benign segments that may appear in a compound command without needing a group. */
const NEUTRAL_PREFIXES: readonly string[] = ['cd', 'pwd', 'true', 'echo', ':'];

/**
 * Unambiguous mutation indicators. None legitimately appears in a curated read
 * command, so matching one can only mean a write snuck past a read prefix
 * (e.g. `git diff --output=f`, `biome check --write`, `find . -delete`).
 */
const MUTATION_TOKEN =
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
 * Split a command into compound segments on `&&`, `||`, `;`, and `|`,
 * respecting single/double quotes (best-effort). Backgrounding `&` is left in
 * the segment for the shell-control veto to catch.
 */
function splitCompound(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote !== null) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    if (c === ';') {
      segments.push(current);
      current = '';
      continue;
    }
    if (c === '&' && next === '&') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  segments.push(current);
  return segments;
}

/** True if the segment carries shell control that could escape the read prefix. */
function hasShellControl(segment: string): boolean {
  // Command / process substitution.
  if (segment.includes('$(') || segment.includes('`') || segment.includes('<(')) {
    return true;
  }
  // Backgrounding / control operator: a lone `&` anywhere that is not part of
  // `&&` (already split out), an fd-dup (`2>&1`, `>&2`), nor an `&>` redirect
  // (caught as redirection below). Catches `cmd &`, `cmd & other`, `a&b`.
  if (/(^|[^&>])&(?![&>0-9])/.test(segment)) {
    return true;
  }
  // Output redirection to anything other than /dev/null or an fd dup (2>&1).
  const redirs = segment.match(/\d*>>?\s*&?\S+/g);
  if (redirs) {
    for (const r of redirs) {
      const target = r.replace(/^\d*>>?\s*/, '');
      if (target !== '/dev/null' && !/^&\d+$/.test(target)) {
        return true;
      }
    }
  }
  return false;
}

/** Word-boundary prefix match: `seg === p` or `seg` starts with `p + ' '`. */
function matchPrefix(segment: string, prefixes: readonly string[]): string | null {
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
 * Decide whether a Bash command is fully covered by the given read prefixes.
 * Returns the (most specific) matched prefix, or null to fall through to the LLM.
 *
 * A command is approved only when EVERY compound segment is either neutral
 * (cd/pwd/echo/...) or matches a read prefix, none carries shell control or a
 * mutation flag, and at least one segment actually matched a read prefix (a
 * command of only neutral segments is not "a read").
 */
export function matchReadOnlyCommand(command: string, prefixes: readonly string[]): string | null {
  const segments = splitCompound(command);
  let matched: string | null = null;
  for (const raw of segments) {
    const seg = raw.trim();
    if (seg === '') continue;
    if (hasShellControl(seg) || MUTATION_TOKEN.test(seg)) return null;
    if (matchPrefix(seg, NEUTRAL_PREFIXES) !== null) continue;
    const hit = matchPrefix(seg, prefixes);
    if (hit === null) return null;
    if (matched === null) matched = hit;
  }
  return matched;
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
