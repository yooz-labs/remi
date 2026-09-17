import { execFileSync } from 'node:child_process';

/**
 * Canonical GitHub repository names used by the session-workflow grant.
 * GitHub treats owner and repository names case-insensitively, so the
 * normalized form is lower-case and never contains a URL or credential.
 */
const GITHUB_REPOSITORY_RE =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

export function normalizeGitHubRepository(value: string): string | undefined {
  const trimmed = value.trim();
  if (!GITHUB_REPOSITORY_RE.test(trimmed)) return undefined;
  return trimmed.toLowerCase();
}

/** Parse only the three credential-free GitHub remote URL forms Git emits. */
export function parseGitHubRemoteUrl(remote: string): string | undefined {
  const trimmed = remote.trim();
  const match =
    /^(?:https?:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)\s*([^/\s]+\/[^/\s]+?)(?:\.git)?$/i.exec(
      trimmed,
    );
  return match?.[1] === undefined ? undefined : normalizeGitHubRepository(match[1]);
}

/**
 * Read the already-configured local origin without contacting GitHub.
 * Fail closed for missing Git, an unreadable worktree, non-GitHub remotes,
 * and remotes that contain credentials or a non-canonical host.
 */
export function detectGitHubRepository(workingDirectory: string): string | undefined {
  if (workingDirectory.trim().length === 0) return undefined;
  try {
    const remote = execFileSync('git', ['config', '--get', 'remote.origin.url'], {
      cwd: workingDirectory,
      encoding: 'utf8',
      timeout: 2_000,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return parseGitHubRemoteUrl(remote);
  } catch {
    return undefined;
  }
}
