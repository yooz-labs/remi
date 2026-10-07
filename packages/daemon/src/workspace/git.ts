/**
 * Running git for workspaces (#1236, ADR 0036): one command at a time, as an argument vector,
 * never through a shell, in a process group of its own, with no standard input, no terminal
 * prompt, `core.fsmonitor` off, and an environment without remi's secrets or any `GIT_*` variable
 * the daemon inherited (a `GIT_DIR` would point every command at another repository). Each command
 * is raced against a deadline; when it passes, the group (git and the hooks and filters it started,
 * which hold the pipes open) is sent SIGTERM, then SIGKILL after a grace period.
 */

import { escapeUnsafeText } from '@remi/shared';
import { withoutRemiSecrets } from '../pty/child-env.ts';

/** How long a git process group has to exit after SIGTERM before SIGKILL. */
const KILL_GRACE_MS = 2_000;
/** How much of git's stderr goes into the log detail. */
const MAX_DETAIL = 500;

/** Any C0 control, DEL or C1 control: none belongs in a path, a branch or a revision. */
export function hasControl(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) as number;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true;
  }
  return false;
}

/** What one git command did. `timedOut` means the deadline passed and its group was ended. */
export interface GitResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

/** The hub's environment for git: no remi secret, no inherited `GIT_*`, never a prompt. */
function gitEnv(): Record<string, string | undefined> {
  const env = withoutRemiSecrets(process.env);
  for (const name of Object.keys(env)) {
    if (name.startsWith('GIT_')) delete env[name];
  }
  env['GIT_TERMINAL_PROMPT'] = '0';
  return env;
}

/** SIGTERM to the whole group now, SIGKILL after a grace period; either may find it gone. */
function endGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    // already gone
  }
  setTimeout(() => {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }, KILL_GRACE_MS).unref();
}

/**
 * One git command, in a process group of its own, raced against `deadlineAt`. The race matters: a
 * hook or filter git started keeps the output pipes open after git itself is killed, so waiting for
 * the pipes would wait for the hook.
 */
export async function runGit(
  git: string,
  cwd: string,
  args: readonly string[],
  deadlineAt: number,
): Promise<GitResult> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) {
    return { code: -1, stdout: '', stderr: 'timed out before git started', timedOut: true };
  }
  const proc = Bun.spawn([git, '-c', 'core.fsmonitor=false', ...args], {
    cwd,
    env: gitEnv(),
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
    detached: true,
  });
  const finished = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]).then(([stdout, stderr, code]) => ({ code, stdout, stderr, timedOut: false }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), remaining);
  });
  const result = await Promise.race([finished, expired]);
  clearTimeout(timer);
  if (result !== null) return result;
  endGroup(proc.pid);
  finished.catch(() => {});
  return { code: -1, stdout: '', stderr: `timed out after ${remaining} ms`, timedOut: true };
}

/** git's stderr for the log: escaped, on one line, cut. */
export function detailOf(result: GitResult): string {
  const text = escapeUnsafeText(result.stderr.trim()).replaceAll('\n', ' | ');
  return text.length > MAX_DETAIL ? `${text.slice(0, MAX_DETAIL)} [cut]` : text;
}

/** The git on the daemon's PATH, or null. */
export function findGit(): string | null {
  return Bun.which('git', { PATH: process.env['PATH'] ?? '' });
}
