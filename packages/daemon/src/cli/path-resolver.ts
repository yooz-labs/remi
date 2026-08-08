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
 *
 * Does NOT resolve symlinks (no realpath): two paths that are equivalent only
 * through a symlinked segment (macOS `/tmp` vs `/private/tmp`) normalize to
 * different strings and will not compare equal. Same blind spot as the exact
 * string equality this replaced; acceptable for sibling-daemon detection.
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

/**
 * Resolve a directory to an absolute path suitable for a spawned child
 * process's `cwd` option, or `undefined` if it isn't a real, existing
 * directory. Unlike `resolveDirectory`, silent on failure by design: the
 * caller (`spawnRemiDaemon`) uses this only as a best-effort belt-and-braces
 * fix (#1025). A non-empty but invalid directory is left for the child's OWN
 * `--dir` handling — which calls `resolveDirectory` and reports the error —
 * to catch; falsy input (no directory requested) is handled upstream by
 * `resolveRequestedSessionDirectory` for a remote request, so by the time a
 * LOCAL spawn reaches here with no directory, "inherit the parent's cwd" is
 * the intended behavior, not an error to catch.
 */
export function resolveExistingDirectory(inputPath: string | null | undefined): string | undefined {
  if (!inputPath) return undefined;
  const resolved = normalizeProjectPath(inputPath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) return undefined;
  return resolved;
}

/**
 * Resolve the directory for a REMOTE create-session request (#1025): no
 * directory, or an empty/whitespace-only string, means "home" — the
 * contract `NewSessionModal.tsx` documents ("empty string = home/cwd") and
 * what `RecentProjects`'s default entry sends. The hub's own cwd is an
 * accident of wherever `remi serve` happened to be started and is never a
 * meaningful default for a request that arrived over the wire, unlike a
 * LOCAL `remi new` from a shell, which correctly inherits the invoking
 * shell's cwd — this helper is for the remote path only, never the local one.
 */
export function resolveRequestedSessionDirectory(directory: string | undefined): string {
  const trimmed = directory?.trim();
  return trimmed || os.homedir();
}
