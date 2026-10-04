/**
 * The remote argument allowlist for Claude (#1179, #1165 B): what a
 * `create_session_request` may add to the `claude` command line. Loopback
 * clients and capability-token holders skip authentication, so unvalidated
 * arguments would be a remote privilege boundary (`--dangerously-skip-permissions`,
 * `--settings`, `--mcp-config`, `--add-dir` and `--append-system-prompt` among them).
 *
 * Default deny. Allowed, each slot at most once: `--resume <uuid>` or `-r <uuid>`
 * (the UUID comes out lowercase), `--fork-session` only beside a `--resume <uuid>`, and
 * `--model <name>` with a name of `[A-Za-z0-9._:\[\]-]{1,64}` that does not start with a
 * hyphen (the issue's pattern allows one, which would let a flag stand in as the value).
 * At most 16 arguments of at most 256 characters, none containing NUL. Total over any
 * input: what is not an array of strings is a refusal, never a throw, because the daemon
 * feeds it parsed wire JSON.
 *
 * `--continue` and `-c` are refused, amending #1165 B's list (ADR 0033, Phase 5 review):
 * Claude's launch injects `--session-id` for a session with none of its own
 * (`claude-binding.ts`), Claude Code very likely rejects `--session-id` beside
 * `--continue` unless `--fork-session` is given, and that is unverified, so it fails
 * closed. A remote request resumes a session by id. `--fork-session` with no resume is
 * refused for the same reason (the launch would inject `--session-id` beside it).
 * Claude's launch adds `--session-id` and `-n` itself, so neither is allowed.
 *
 * `--resume` through a hub spawns a child daemon that passes the arguments on (#1179).
 * It is UNVERIFIED against a real Claude: whether a resumed session keeps a permissive
 * permission mode from its earlier life is unknown, and is on the LV-4 checklist (the
 * Claude half). That a resumed session then behaves (binding, hooks) is #1129's.
 *
 * Lives beside Claude's side of the seam, not in `harness/codex/`, whose
 * boundary keeps Claude out; `cli.ts` is the one importer (`HarnessRegistry`).
 */

import type { RemoteArgsResult } from './registry.ts';

const MAX_ARGS = 16;
const MAX_ARG_LENGTH = 256;
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,63}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const refuse = (error: string): RemoteArgsResult => ({ ok: false, error });

export function validateClaudeRemoteArgs(args: unknown): RemoteArgsResult {
  if (!Array.isArray(args)) return refuse('claude arguments must be an array');
  if (args.length > MAX_ARGS) return refuse(`claude arguments: at most ${MAX_ARGS} are allowed`);
  for (const arg of args) {
    if (typeof arg !== 'string') return refuse('claude arguments must be strings');
    if (arg.length > MAX_ARG_LENGTH) {
      return refuse(`claude arguments: at most ${MAX_ARG_LENGTH} characters each`);
    }
    if (arg.includes('\0')) return refuse('claude arguments must not contain NUL');
  }
  const tokens = args as readonly string[];

  const seen = new Set<string>();
  const out: string[] = [];
  /** The session a `--resume` names, for the hub's held-session check (#1204 round 2, P10). */
  let resumeId: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const value = tokens[i + 1];
    let slot: string;
    let takesValue = false;
    switch (token) {
      case '--resume':
      case '-r':
        slot = 'resume';
        takesValue = true;
        if (value === undefined || !UUID_PATTERN.test(value)) {
          return refuse(`claude arguments: ${token} needs a session id (a UUID)`);
        }
        break;
      case '--continue':
      case '-c':
        return refuse(
          `claude arguments: ${token} is not allowed; a remote request resumes a session by its id (--resume <uuid>)`,
        );
      case '--fork-session':
        slot = 'fork';
        break;
      case '--model':
        slot = 'model';
        takesValue = true;
        if (value === undefined || !MODEL_PATTERN.test(value)) {
          return refuse('claude arguments: --model needs a model name');
        }
        break;
      default:
        return refuse(`claude arguments: ${JSON.stringify(token)} is not allowed`);
    }
    if (seen.has(slot)) return refuse(`claude arguments: ${slot} given twice`);
    seen.add(slot);
    out.push(token);
    if (takesValue) {
      // A UUID is lowercase on the way out, whatever case it came in.
      const shown = slot === 'resume' ? (value as string).toLowerCase() : (value as string);
      if (slot === 'resume') resumeId = shown;
      out.push(shown);
      i++;
    }
  }
  if (seen.has('fork') && !seen.has('resume')) {
    return refuse('claude arguments: --fork-session needs --resume <uuid>');
  }
  return { ok: true, args: out, resumeThreadId: resumeId };
}
