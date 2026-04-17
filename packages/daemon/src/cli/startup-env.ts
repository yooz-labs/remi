/**
 * Startup environment helpers: git context detection and .env file loading.
 *
 * Extracted from cli.ts to shrink the main CLI module and isolate small,
 * independently-testable units.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Current working directory's git context — short form used in status line. */
export interface GitInfo {
  repo: string;
  branch: string;
}

/**
 * Detect the project name and branch from the current working directory.
 *
 * Avoids shelling out to `git` — reads `.git/HEAD` directly so it works in
 * minimal environments (compiled binary, LaunchAgent) without a git CLI.
 *
 * Falls back to directory basename and `'?'` branch on any IO or parse error.
 */
export function detectGitInfo(cwd: string = process.cwd()): GitInfo {
  try {
    const repo = path.basename(cwd);
    const headFile = path.join(cwd, '.git', 'HEAD');
    if (fs.existsSync(headFile)) {
      const head = fs.readFileSync(headFile, 'utf-8').trim();
      const branch = head.startsWith('ref: refs/heads/') ? head.slice(16) : head.slice(0, 8);
      return { repo, branch };
    }
    return { repo, branch: '?' };
  } catch {
    return { repo: path.basename(cwd), branch: '?' };
  }
}

/**
 * Parse a single `.env`-style line.
 * Returns `null` for blank lines, comments, or malformed entries.
 *
 * Supports:
 *   - KEY=value
 *   - KEY="quoted value"
 *   - KEY='quoted value'
 *   - leading/trailing whitespace
 *   - `#` comments (anywhere the line starts, after trim)
 *
 * Does NOT support: escape sequences, multiline values, variable expansion.
 */
export function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;
  const eqIndex = trimmed.indexOf('=');
  if (eqIndex <= 0) return null;
  const key = trimmed.slice(0, eqIndex).trim();
  let value = trimmed.slice(eqIndex + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  }
  return { key, value };
}

/**
 * Load a `.env` file into `process.env`, respecting already-set variables
 * (existing values win). Silently returns if the file does not exist.
 *
 * `envPath` defaults to `./.env` — matches the prior cli.ts behavior.
 */
export function loadDotenvFile(envPath: string = path.join(process.cwd(), '.env')): void {
  if (!fs.existsSync(envPath)) return;
  const envContent = fs.readFileSync(envPath, 'utf-8');
  for (const line of envContent.split('\n')) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    if (!process.env[parsed.key]) {
      process.env[parsed.key] = parsed.value;
    }
  }
}
