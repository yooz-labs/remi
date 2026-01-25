/**
 * Path resolution utilities.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve a directory path, expanding ~ and validating it exists.
 *
 * @param inputPath - Path to resolve (optional, defaults to cwd)
 * @returns Object with either `resolved` path or `error` message
 */
export function resolveDirectory(
  inputPath?: string | null,
): { resolved: string } | { error: string } {
  if (!inputPath) {
    return { resolved: process.cwd() };
  }

  let resolved = inputPath;

  // Expand ~ to home directory
  if (resolved.startsWith('~/')) {
    resolved = path.join(os.homedir(), resolved.slice(2));
  } else if (resolved === '~') {
    resolved = os.homedir();
  }

  // Resolve to absolute path
  resolved = path.resolve(resolved);

  // Check if directory exists
  if (!fs.existsSync(resolved)) {
    return { error: `Directory not found: ${resolved}` };
  }

  // Check if it's actually a directory
  const stat = fs.statSync(resolved);
  if (!stat.isDirectory()) {
    return { error: `Not a directory: ${resolved}` };
  }

  return { resolved };
}
