/**
 * Directory-path resolution for CLI flags like `--dir` and interactive
 * `remi recent` picks. Handles `~` / `~/...` expansion, converts relative
 * to absolute paths, and validates the result exists and is a directory.
 *
 * Returns a tagged result so the caller can distinguish success from a
 * human-readable error without throwing.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export type ResolveDirectoryResult = { resolved: string } | { error: string };

/**
 * Expand a leading `~`/`~/` and resolve to an absolute path. Pure string
 * manipulation, no filesystem access — safe to run against untrusted or
 * legacy stored values (e.g. re-normalizing a `LiveSessionEntry.projectPath`
 * read back off disk) as well as fresh CLI input.
 */
export function normalizeProjectPath(inputPath: string): string {
  let resolved = inputPath;
  if (resolved.startsWith('~/')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  } else if (resolved === '~') {
    resolved = os.homedir();
  }
  return path.resolve(resolved);
}

export function resolveDirectory(inputPath: string | null | undefined): ResolveDirectoryResult {
  if (!inputPath) {
    return { resolved: process.cwd() };
  }

  const resolved = normalizeProjectPath(inputPath);
  if (!fs.existsSync(resolved)) {
    return { error: `Directory not found: ${resolved}` };
  }
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${resolved}` };
  }
  return { resolved };
}
