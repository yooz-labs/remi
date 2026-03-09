/**
 * Session name generation for human-readable session identifiers.
 *
 * Format: hostname:dirname/branch (or hostname:dirname if no git).
 * Colon separates hostname from path. Disambiguation from the
 * host:port/session remote URL format relies on checking whether
 * the segment after the colon is a numeric port.
 */

import { execSync } from 'node:child_process';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Generate a human-readable session name from the working directory.
 *
 * Format: hostname:dirname/branch or hostname:dirname (no git).
 * The hostname has `.local` suffix stripped if present.
 */
export function generateSessionName(cwd: string): string {
  const hostname = cleanHostname(os.hostname());
  const dirname = path.basename(cwd) || cwd;
  const branch = detectGitBranch(cwd);

  if (branch) {
    return `${hostname}:${dirname}/${branch}`;
  }
  return `${hostname}:${dirname}`;
}

/**
 * Make a name unique by appending `:2`, `:3`, etc. if it already exists.
 */
export function makeUniqueName(baseName: string, existingNames: Set<string>): string {
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let counter = 2;
  while (existingNames.has(`${baseName}:${counter}`)) {
    counter++;
  }
  return `${baseName}:${counter}`;
}

/**
 * Strip `.local` suffix from hostname (common on macOS).
 */
export function cleanHostname(hostname: string): string {
  if (hostname.endsWith('.local')) {
    return hostname.slice(0, -6);
  }
  return hostname;
}

let gitNotFoundWarned = false;

/**
 * Detect the current git branch in the given directory.
 * Returns null if not a git repo or git is unavailable.
 */
function detectGitBranch(cwd: string): string | null {
  try {
    const result = execSync('git rev-parse --abbrev-ref HEAD', {
      cwd,
      encoding: 'utf-8',
      timeout: 2000,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const branch = result.trim();
    if (branch && branch !== 'HEAD') {
      return branch;
    }
    return null;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' && !gitNotFoundWarned) {
      gitNotFoundWarned = true;
      console.warn('git not found in PATH; session names will not include branch');
    }
    return null;
  }
}
