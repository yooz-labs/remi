/**
 * `remi migrate-permissions [config-path]` (#1125, ADR 0030).
 *
 * remi no longer judges permissions; Claude Code's own `permissions` rules
 * do. This prints a user's old `[auto_approve] allow` / `deny` lists as a
 * Claude Code `permissions` block, for the user to paste into
 * `~/.claude/settings.json` (or a project's `.claude/settings.json`) THEMSELVES.
 *
 * Two properties are the whole contract:
 *
 *   - It NEVER writes a file. Settings files are the user's; merging into one
 *     can clobber rules remi has never seen. Output goes to stdout (the JSON)
 *     and stderr (what could not be mapped, and how to apply it).
 *   - It reads the RAW TOML, not the loaded config: `[auto_approve]` is no
 *     longer part of the schema, so the loader would drop it, and a value
 *     the old validator refused must still be readable here.
 *
 * Mapping (Claude Code rule syntax):
 *   - an entry already shaped `Tool(...)` passes through unchanged;
 *   - a bare tool name (`Read`, `WebFetch`, `mcp__server__tool`) stays as is;
 *   - anything else was a Bash command prefix in remi and becomes
 *     `Bash(<prefix>:*)`, trimmed.
 * What has no mechanical translation (permission groups, `level`, per-agent
 * sections, non-string entries) is listed on stderr, never guessed at.
 */

import * as fs from 'node:fs';
import { errorToString } from '@remi/shared';
import { parse as parseToml } from 'smol-toml';
import { CONFIG_PATH } from '../config/config.ts';

export interface MigratePermissionsIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

const defaultIO: MigratePermissionsIO = {
  out: (text) => process.stdout.write(`${text}\n`),
  err: (text) => process.stderr.write(`${text}\n`),
};

/** A Claude Code rule that already names its tool: `Bash(git push:*)`,
 *  `WebFetch(domain:example.com)`, `mcp__srv__tool(x)`. */
const TOOL_RULE = /^[A-Za-z_][\w-]*\(.*\)$/s;

/** A bare tool name, the same shape remi's matcher treated as a tool (#536):
 *  an uppercase-initial single token, or an MCP tool id. */
function isBareToolName(entry: string): boolean {
  if (/\s/.test(entry)) return false;
  return entry.startsWith('mcp__') || /^[A-Z][A-Za-z0-9_]*$/.test(entry);
}

/** The Claude Code rule for one remi allow/deny entry, or null when it has no
 *  translation (not a string, or empty). */
export function toClaudeRule(entry: unknown): string | null {
  if (typeof entry !== 'string') return null;
  const trimmed = entry.trim();
  if (trimmed.length === 0) return null;
  if (TOOL_RULE.test(trimmed)) return trimmed;
  if (isBareToolName(trimmed)) return trimmed;
  return `Bash(${trimmed}:*)`;
}

export interface PermissionsMigration {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  /** Human-readable notes about what was not carried over. */
  readonly unmapped: readonly string[];
}

function mapList(value: unknown, key: 'allow' | 'deny', unmapped: string[]): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    unmapped.push(
      `auto_approve.${key} is not a list (${JSON.stringify(value)}); nothing taken from it`,
    );
    return [];
  }
  const rules: string[] = [];
  for (const entry of value) {
    const rule = toClaudeRule(entry);
    if (rule === null) {
      unmapped.push(`auto_approve.${key} entry ${JSON.stringify(entry)} (empty or not a string)`);
    } else if (!rules.includes(rule)) {
      rules.push(rule);
    }
  }
  return rules;
}

/** Map a raw `[auto_approve]` table. Pure: no I/O. */
export function migratePermissions(table: unknown): PermissionsMigration {
  const unmapped: string[] = [];
  if (table === undefined) return { allow: [], deny: [], unmapped };
  if (table === null || typeof table !== 'object' || Array.isArray(table)) {
    unmapped.push('auto_approve is not a table; nothing taken from it');
    return { allow: [], deny: [], unmapped };
  }
  const t = table as Record<string, unknown>;
  const allow = mapList(t['allow'], 'allow', unmapped);
  const deny = mapList(t['deny'], 'deny', unmapped);
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
  return { allow, deny, unmapped };
}

/**
 * Run the command. Returns the exit code: 0 when the config was readable (even
 * with nothing to migrate), 1 when it exists but cannot be read or parsed.
 */
export function runMigratePermissionsCommand(
  configPath: string = CONFIG_PATH,
  io: MigratePermissionsIO = defaultIO,
): number {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      io.out(JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2));
      io.err(`No config file at ${configPath}; nothing to migrate.`);
      return 0;
    }
    io.err(`Cannot read ${configPath}: ${errorToString(err)}`);
    return 1;
  }

  const { allow, deny, unmapped } = migratePermissions(parsed['auto_approve']);
  io.out(JSON.stringify({ permissions: { allow, deny } }, null, 2));

  const notes: string[] = [];
  if (!('auto_approve' in parsed)) {
    notes.push(`${configPath} has no [auto_approve] table; nothing to migrate.`);
  }
  if (unmapped.length > 0) {
    notes.push('Not carried over:');
    for (const u of unmapped) notes.push(`  - ${u}`);
  }
  if (deny.some((r) => r.startsWith('Bash('))) {
    notes.push(
      'Note: remi matched deny entries as substrings anywhere in a command; Claude Code Bash rules match a command prefix, so review the deny rules above.',
    );
  }
  notes.push(
    'Nothing was written. Paste the "permissions" block into ~/.claude/settings.json (or a project .claude/settings.json) yourself, merging with any rules already there.',
  );
  for (const n of notes) io.err(n);
  return 0;
}
