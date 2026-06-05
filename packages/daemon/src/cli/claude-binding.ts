/**
 * Resolve the deterministic Claude session-id binding for a PTY spawn.
 *
 * The daemon needs to know which transcript .jsonl the spawned `claude` will
 * write to before Claude has written its first line. Otherwise sibling daemons
 * sharing a cwd race through `findLatestTranscript` (newest-by-mtime) and can
 * adopt each other's transcripts — leading to cross-daemon answer routing
 * (#427).
 *
 * Resolution order:
 *   1. User passed `--session-id <uuid>` explicitly: respect it.
 *   2. User passed `--resume <uuid>` without `--fork-session`: Claude reuses
 *      that session id, so it's also our binding.
 *   3. User passed `--resume <uuid> --fork-session`: Claude creates a NEW
 *      session id; pre-assign one and inject `--session-id` so we know it.
 *   4. Otherwise (fresh spawn): pre-assign and inject `--session-id`.
 *
 * Cases (2) and (3) can be combined: when `--resume` is present we inject
 * `--session-id` only if `--fork-session` is also there, because Claude with
 * `--resume <X>` alone preserves X.
 *
 * The function is pure and returns the augmented args. It does not touch the
 * store; the caller is responsible for persisting `claudeSessionId` to
 * `sessionStore` BEFORE `Bun.spawn` so siblings see it on first race tick.
 */

import { randomUUID } from 'node:crypto';

export interface ClaudeBindingResult {
  /** The session id Claude will use; either pre-existing in args or freshly minted. */
  readonly claudeSessionId: string;
  /**
   * The args to pass to `Bun.spawn`. Equal to input args plus any injection.
   * Invariant by source: `fresh` and `user-resume-fork` always contain an
   * injected `--session-id <claudeSessionId>` pair; `user-session-id` and
   * `user-resume` never inject because the binding is already in the user's
   * args (or, in the resume case, implicit in `--resume`).
   */
  readonly args: readonly string[];
  /** How the binding was determined; useful for diagnostics + tests. */
  readonly source: 'user-session-id' | 'user-resume' | 'user-resume-fork' | 'fresh';
}

const SESSION_ID_FLAGS = new Set(['--session-id']);
const RESUME_FLAGS = new Set(['-r', '--resume']);
const FORK_FLAGS = new Set(['--fork-session']);
const NAME_FLAGS = new Set(['-n', '--name']);

/**
 * Find a flag's value in an argv list. Supports both `--flag value` and
 * `--flag=value` shapes. Returns undefined if absent or if the flag has no
 * following value.
 */
function findFlagValue(args: readonly string[], flagSet: ReadonlySet<string>): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg) continue;
    if (flagSet.has(arg)) {
      const next = args[i + 1];
      if (next && !next.startsWith('-')) return next;
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0 && flagSet.has(arg.slice(0, eq))) {
      return arg.slice(eq + 1);
    }
  }
  return undefined;
}

/** True if any of the bare flags (no value expected) is present. */
function hasBareFlag(args: readonly string[], flagSet: ReadonlySet<string>): boolean {
  return args.some((a) => flagSet.has(a));
}

function isUuidLike(value: string | undefined): value is string {
  if (!value) return false;
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Resolve the claudeSessionId we will lock for this PTY and return augmented
 * spawn args. `displayName` is appended via `-n` only when the user did not
 * already set one, so an operator peeking at the PTY (or at /resume picker)
 * can tell which daemon owns this session.
 */
export function resolveClaudeBinding(
  extraArgs: readonly string[],
  options: { readonly displayName?: string } = {},
): ClaudeBindingResult {
  const args = [...extraArgs];

  const existingSessionId = findFlagValue(args, SESSION_ID_FLAGS);
  const resumeId = findFlagValue(args, RESUME_FLAGS);
  const isFork = hasBareFlag(args, FORK_FLAGS);
  const hasName = hasBareFlag(args, NAME_FLAGS);

  let claudeSessionId: string;
  let source: ClaudeBindingResult['source'];

  if (isUuidLike(existingSessionId)) {
    claudeSessionId = existingSessionId;
    source = 'user-session-id';
  } else if (isUuidLike(resumeId) && !isFork) {
    claudeSessionId = resumeId;
    source = 'user-resume';
  } else if (isUuidLike(resumeId) && isFork) {
    claudeSessionId = randomUUID();
    args.push('--session-id', claudeSessionId);
    source = 'user-resume-fork';
  } else {
    claudeSessionId = randomUUID();
    args.push('--session-id', claudeSessionId);
    source = 'fresh';
  }

  if (!hasName && options.displayName) {
    args.push('-n', options.displayName);
  }

  return { claudeSessionId, args, source };
}
