/**
 * `remi migrate-permissions [config-path]` (#1125, ADR 0030).
 *
 * remi no longer judges permissions; Claude Code's own `permissions` rules
 * do. This prints a user's old `[auto_approve] allow` / `deny` lists as a
 * Claude Code `permissions` block, for the user to paste into
 * `~/.claude/settings.json` (or a project's `.claude/settings.json`) THEMSELVES.
 *
 * Three properties are the whole contract:
 *
 *   - It NEVER writes a file. Settings files are the user's; merging into one
 *     can clobber rules remi has never seen. Output goes to stdout (the JSON)
 *     and stderr (what changed meaning, what could not be carried over, and
 *     how to apply it).
 *   - It reads the RAW TOML, not the loaded config: `[auto_approve]` is no
 *     longer part of the schema, so the loader would drop it, and a value
 *     the old validator refused must still be readable here.
 *   - It never emits a rule that grants more than the old entry did, and
 *     never emits a deny that silently matches nothing. An entry with no
 *     faithful Claude Code form is listed under "NOT carried over" with the
 *     reason, never guessed at.
 *
 * What the old matcher did (`auto-approve/pattern-matcher.ts`, deleted in
 * #1125), which is what "faithful" is measured against:
 *   - allow, Bash: every compound segment had to word-boundary-prefix-match an
 *     entry; tool-shaped entries (`Read`, `Bash`) were dropped, so a bare
 *     `Bash` in `allow` never approved anything (#536).
 *   - allow, other tools: the entry had to equal the tool name.
 *   - deny, Bash: a plain substring search over the whole command, including
 *     tool-shaped entries.
 *   - deny, other tools: the tool name, plus that substring search over any
 *     command-carrying input.
 *
 * What Claude Code matches (code.claude.com/docs/en/permissions, checked
 * 2026-10-01): a Bash rule matches each subcommand separately, after
 * splitting on `&&`, `||`, `;`, `|`, `|&`, `&` and newlines and stripping
 * wrappers such as `timeout` and `nohup`; `*` stands for any text; `:*` is
 * only a trailing wildcard, the same as ` *`; deny wins over allow. Whether a
 * leading `*` also matches empty text is not documented, so substring rules
 * of the form `Bash(*x*)` are not emitted.
 *
 * The mapping that follows:
 *   - allow `x` (a command) becomes `Bash(x:*)`: the same word-boundary
 *     prefix per subcommand the old matcher used. An allow entry shaped like
 *     a mid-command pattern (`push --force`) is flagged: it matches only
 *     commands that start with it, which in practice is none;
 *   - deny `x` (a command) becomes `Bash(x*)`: Claude Code matches it only at
 *     the START of a subcommand, where remi matched it anywhere, so every such
 *     rule is reported as narrower;
 *   - a known tool name or an MCP tool id stays as is;
 *   - an entry already shaped `Tool(...)` passes through (remi never applied
 *     that form; it only ever matched it as shell text), except a blanket
 *     allow such as `Bash(*)`;
 *   - not carried over: bare `Bash`, unknown tool-shaped words, entries with
 *     shell operators, redirection, substitution, parentheses or `*`, and deny
 *     patterns that sit mid-command (`push --force`, `DROP TABLE`).
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';
import { parse as parseToml } from 'smol-toml';
import { CONFIG_PATH } from '../config/config.ts';
import { SUBAGENT_ALERT_MOVE_HINT } from './auto-approve-removal.ts';

export interface MigratePermissionsIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/** Write all of `text` to `fd` before returning. `process.stdout.write` to a
 *  pipe can still be buffered when the caller then runs `process.exit`, which
 *  truncates a large block piped to a slow reader. */
function writeAllSync(fd: number, text: string): void {
  const buf = Buffer.from(text, 'utf-8');
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      // A non-blocking pipe that is momentarily full: wait and retry.
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err;
      Bun.sleepSync(1);
    }
  }
}

const defaultIO: MigratePermissionsIO = {
  out: (text) => writeAllSync(1, `${text}\n`),
  err: (text) => writeAllSync(2, `${text}\n`),
};

/**
 * Claude Code tool names a bare-name rule can refer to: the current built-in
 * set (code.claude.com/docs/en/tools-reference, 2026-10-01) plus the older
 * names remi's matcher knew (`Task`, `BashOutput`, `KillShell`,
 * `NotebookRead`, `SlashCommand`, `MultiEdit`), which an old config may hold.
 */
export const CLAUDE_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Agent',
  'AskUserQuestion',
  'Bash',
  'BashOutput',
  'CronCreate',
  'CronDelete',
  'CronList',
  'Edit',
  'EnterPlanMode',
  'EnterWorktree',
  'ExitPlanMode',
  'ExitWorktree',
  'Glob',
  'Grep',
  'KillShell',
  'ListMcpResourcesTool',
  'LSP',
  'Monitor',
  'MultiEdit',
  'NotebookEdit',
  'NotebookRead',
  'PowerShell',
  'Read',
  'ReadMcpResourceTool',
  'Skill',
  'SlashCommand',
  'Task',
  'TaskCreate',
  'TaskGet',
  'TaskList',
  'TaskOutput',
  'TaskStop',
  'TaskUpdate',
  'TodoWrite',
  'ToolSearch',
  'WebFetch',
  'WebSearch',
  'Write',
]);

/** A Claude Code rule that already names its tool: `Bash(git push:*)`,
 *  `WebFetch(domain:example.com)`, `mcp__srv__tool(x)`. */
const TOOL_RULE = /^([A-Za-z_][\w-]*)\((.*)\)$/s;

/** Shell operators, redirection and substitution. Claude Code splits a
 *  command on the operators and matches each piece alone, so no rule can span
 *  one; redirection and substitution change what runs. */
const SHELL_SYNTAX = /[|&;<>`\n]|\$\(/;

/**
 * First words that, in a deny list, almost always sit AFTER a program name:
 * git and package-manager subcommands, and SQL verbs. remi matched `push
 * --force` anywhere (so inside `git push --force`); Claude Code would read
 * `Bash(push --force*)` as a command named `push` and never match.
 */
const MID_COMMAND_WORDS: ReadonlySet<string> = new Set([
  'add',
  'am',
  'apply',
  'bisect',
  'branch',
  'checkout',
  'cherry-pick',
  'clean',
  'clone',
  'commit',
  'config',
  'delete',
  'deploy',
  'destroy',
  'drop',
  'fetch',
  'filter-branch',
  'gc',
  'install',
  'merge',
  'prune',
  'publish',
  'pull',
  'push',
  'rebase',
  'remote',
  'remove',
  'reset',
  'restore',
  'revert',
  'stash',
  'submodule',
  'switch',
  'tag',
  'truncate',
  'uninstall',
  'unpublish',
  'update',
  'upgrade',
  'worktree',
]);

/** A single token shaped like a tool name: uppercase-initial, or an MCP id.
 *  The shape remi's matcher treated as a tool (#536). */
function isToolShaped(entry: string): boolean {
  if (/\s/.test(entry)) return false;
  return entry.startsWith('mcp__') || /^[A-Z][A-Za-z0-9_]*$/.test(entry);
}

function isMidCommand(entry: string): boolean {
  if (entry.startsWith('-')) return true;
  const first = entry.split(/\s+/)[0] ?? '';
  return /^[A-Z]/.test(first) || MID_COMMAND_WORDS.has(first.toLowerCase());
}

export type EntryOutcome =
  /** Emitted. `note` explains a change of meaning the user should review. */
  | { readonly kind: 'rule'; readonly rule: string; readonly note?: string }
  /** Not emitted; `reason` says why. */
  | { readonly kind: 'skip'; readonly reason: string };

/** Translate one old `allow` or `deny` entry. Pure. */
export function classifyEntry(entry: unknown, list: 'allow' | 'deny'): EntryOutcome {
  if (typeof entry !== 'string' || entry.trim().length === 0) {
    return { kind: 'skip', reason: 'empty or not a string' };
  }
  const trimmed = entry.trim();

  const toolRule = TOOL_RULE.exec(trimmed);
  if (toolRule) {
    const inner = (toolRule[2] ?? '').trim();
    if (list === 'allow' && (inner === '' || inner === '*' || inner === ':*')) {
      return {
        kind: 'skip',
        reason: `allows every ${toolRule[1]} call in Claude Code; remi never applied this form (it only matched it as shell-command text)`,
      };
    }
    return {
      kind: 'rule',
      rule: trimmed,
      note: 'remi never applied this form (it only matched it as shell-command text); passed through as written because it is already Claude Code syntax',
    };
  }

  if (isToolShaped(trimmed)) {
    if (trimmed === 'Bash') {
      return {
        kind: 'skip',
        reason:
          list === 'allow'
            ? 'remi never let a bare `Bash` entry approve a shell command (tool names are not shell patterns, #536); in Claude Code it would allow every shell command'
            : 'remi matched it only as text inside shell commands; in Claude Code a bare `Bash` deny removes the shell tool entirely',
      };
    }
    if (trimmed.startsWith('mcp__') || CLAUDE_TOOL_NAMES.has(trimmed)) {
      return { kind: 'rule', rule: trimmed };
    }
    return {
      kind: 'skip',
      reason:
        list === 'allow'
          ? 'not a Claude Code tool name'
          : 'not a Claude Code tool name; remi matched it as text anywhere in a shell command, which no Claude Code rule reproduces',
    };
  }

  if (SHELL_SYNTAX.test(trimmed)) {
    return {
      kind: 'skip',
      reason:
        'contains a shell operator, redirection or substitution; Claude Code matches each subcommand separately, so no rule can span it',
    };
  }
  if (/[()]/.test(trimmed)) {
    return { kind: 'skip', reason: 'contains parentheses, which Claude Code rule syntax reserves' };
  }
  if (trimmed.includes('*')) {
    return {
      kind: 'skip',
      reason: 'contains `*`, which remi matched literally and Claude Code reads as a wildcard',
    };
  }

  if (list === 'allow') {
    // An allow entry that only ever made sense mid-command (`push --force`,
    // `DROP TABLE`) never matched a command START in remi either (allow was a
    // per-segment prefix match), so the prefix rule is faithful but matches
    // nothing in practice. Said so, so nobody reads it as a grant.
    return isMidCommand(trimmed)
      ? {
          kind: 'rule',
          rule: `Bash(${trimmed}:*)`,
          note: 'kept as a prefix rule; matches only commands that start with it',
        }
      : { kind: 'rule', rule: `Bash(${trimmed}:*)` };
  }

  if (isMidCommand(trimmed)) {
    return {
      kind: 'skip',
      reason:
        'remi matched it anywhere inside a command (for example after `git`); Claude Code Bash rules match from the start of each subcommand, so there is no faithful rule. Write the full command form yourself, such as `Bash(git push --force*)`',
    };
  }
  // Keep one trailing space: `sudo ` must not become a rule that also matches
  // `sudoedit`. `Bash(sudo *)` is the documented "sudo, or sudo + anything".
  const prefix = /\s$/.test(entry) ? `${trimmed} ` : trimmed;
  return {
    kind: 'rule',
    rule: `Bash(${prefix}*)`,
    note: 'now matches only a subcommand that STARTS with it; remi matched it anywhere in the command',
  };
}

export interface PermissionsMigration {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  /** Emitted rules whose meaning changed, one line each. */
  readonly changed: readonly string[];
  /** What was not carried over, one line each, with the reason. */
  readonly unmapped: readonly string[];
}

function mapList(
  value: unknown,
  key: 'allow' | 'deny',
  changed: string[],
  unmapped: string[],
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    unmapped.push(
      `auto_approve.${key} is not a list (${JSON.stringify(value)}); nothing taken from it`,
    );
    return [];
  }
  const rules: string[] = [];
  for (const entry of value) {
    const outcome = classifyEntry(entry, key);
    if (outcome.kind === 'skip') {
      unmapped.push(`${key} ${JSON.stringify(entry)}: ${outcome.reason}`);
      continue;
    }
    if (rules.includes(outcome.rule)) continue;
    rules.push(outcome.rule);
    if (outcome.note !== undefined) {
      changed.push(`${key} ${JSON.stringify(entry)} -> ${outcome.rule}: ${outcome.note}`);
    }
  }
  return rules;
}

/** Map a raw `[auto_approve]` table. Pure: no I/O. */
export function migratePermissions(table: unknown): PermissionsMigration {
  const changed: string[] = [];
  const unmapped: string[] = [];
  if (table === undefined) return { allow: [], deny: [], changed, unmapped };
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    unmapped.push('auto_approve is not a table; nothing taken from it');
    return { allow: [], deny: [], changed, unmapped };
  }
  const t = table as Record<string, unknown>;
  const allow = mapList(t['allow'], 'allow', changed, unmapped);
  const deny = mapList(t['deny'], 'deny', changed, unmapped);
  for (const key of ['approve_groups', 'deny_groups'] as const) {
    const v = t[key];
    if (Array.isArray(v) && v.length > 0) {
      unmapped.push(
        `auto_approve.${key} = ${JSON.stringify(v)}: permission groups have no Claude Code equivalent; write the rules you want by hand`,
      );
    } else if (v !== undefined && !Array.isArray(v)) {
      unmapped.push(`auto_approve.${key} = ${JSON.stringify(v)}: not carried over`);
    }
  }
  if (t['level'] !== undefined) {
    unmapped.push(
      `auto_approve.level = ${JSON.stringify(t['level'])}: strictness presets have no Claude Code equivalent`,
    );
  }
  const agents = t['agents'];
  if (agents !== null && typeof agents === 'object' && !Array.isArray(agents)) {
    for (const name of Object.keys(agents as Record<string, unknown>).sort()) {
      unmapped.push(`auto_approve.agents.${name}: per-agent sections are not carried over`);
    }
  } else if (agents !== undefined) {
    unmapped.push('auto_approve.agents: not carried over');
  }
  return { allow, deny, changed, unmapped };
}

/** stderr hint for a legacy `auto_approve.subagent_alert`, or null. It is a
 *  remi notification setting, not a permission, so it never goes in the JSON. */
function subagentAlertHint(parsed: Record<string, unknown>): string | null {
  const aa = parsed['auto_approve'];
  if (aa === null || typeof aa !== 'object' || !('subagent_alert' in aa)) return null;
  const notifications = parsed['notifications'];
  const modernSet =
    notifications !== null &&
    typeof notifications === 'object' &&
    'subagent_alert' in notifications;
  return modernSet
    ? 'auto_approve.subagent_alert is ignored because [notifications] subagent_alert is set; delete it from [auto_approve].'
    : SUBAGENT_ALERT_MOVE_HINT;
}

/**
 * Run the command. `configPath` is the path the user named, or undefined for
 * the default `~/.remi/config.toml`. Returns the exit code: 0 when the config
 * was readable (even with nothing to migrate) or the DEFAULT config does not
 * exist; 1 when a path the user named does not exist, or a config cannot be
 * read or parsed.
 */
export function runMigratePermissionsCommand(
  configPath: string | undefined,
  io: MigratePermissionsIO = defaultIO,
  defaultPath: string = CONFIG_PATH,
): number {
  const filePath = configPath ?? defaultPath;
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(fs.readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      if (configPath !== undefined) {
        io.err(`No config file at ${filePath}.`);
        return 1;
      }
      io.out(JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2));
      io.err(`No config file at ${filePath}; nothing to migrate.`);
      return 0;
    }
    io.err(`Cannot read ${filePath}: ${errorToString(err)}`);
    return 1;
  }

  const { allow, deny, changed, unmapped } = migratePermissions(parsed['auto_approve']);
  io.out(JSON.stringify({ permissions: { allow, deny } }, null, 2));

  const notes: string[] = [];
  if (!('auto_approve' in parsed)) {
    notes.push(`${filePath} has no [auto_approve] table; nothing to migrate.`);
  }
  if (changed.length > 0) {
    notes.push('Carried over, with a different meaning (review each):');
    for (const c of changed) notes.push(`  - ${c}`);
  }
  if (unmapped.length > 0) {
    notes.push('NOT carried over:');
    for (const u of unmapped) notes.push(`  - ${u}`);
  }
  const alertHint = subagentAlertHint(parsed);
  if (alertHint !== null) notes.push(alertHint);
  notes.push(
    'Nothing was written. Paste the "permissions" block into ~/.claude/settings.json (or a project .claude/settings.json) yourself, merging with any rules already there.',
  );
  for (const n of notes) io.err(n);
  return 0;
}
