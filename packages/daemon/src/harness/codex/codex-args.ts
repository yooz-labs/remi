/**
 * Argument validation for `remi codex` (epic #1175, phase 2 #1176): pure
 * functions, no process and no filesystem except `resolveCodexWorkingDirectory`.
 *
 * remi launches exactly `codex --no-alt-screen <validated arguments>` and
 * nothing else, so what a user (or a remote client) can add is what has to be
 * policed. Two policies, because the principals differ (the epic plan, section
 * 6.2, items 9 and 10):
 *
 * - `validateCodexArgs` is for a person at their own terminal: the user is the
 *   principal, so it is a DENYLIST of the flags that break remi's model (they
 *   change how the TUI reaches its app-server, or what directory identifies
 *   the session) plus a refusal of every subcommand but `resume <uuid>`. A bare
 *   prompt is passed through.
 * - `validateCodexRemoteArgs` is for a request that arrives over the wire
 *   (phase 5): loopback clients and capability-token holders skip auth, so
 *   unvalidated arguments would be a remote privilege boundary. It is a
 *   default-deny ALLOWLIST: a model, an approval policy, a sandbox mode, and
 *   `resume <uuid>`, with bounded size.
 *
 * Both are consumed by the Codex launch (phase 3) and the hub (phase 5); this
 * phase has no production caller, and tests are their only users until then.
 *
 * Not verified, because remi must not start Codex to find out: the flag and
 * subcommand lists come from the epic plan (the spike's findings and the
 * owner's installed `codex --help` as the plan author remembered it). If Codex
 * enables clap's long-flag abbreviation, an abbreviation such as `--conf`
 * would not match a denylisted name here; the live step checks it. The lead
 * refreshes the subcommand list from `codex --help` during that step.
 */

import * as fs from 'node:fs';

export type CodexArgsResult =
  | { readonly ok: true; readonly args: string[]; readonly resumeThreadId: string | null }
  | { readonly ok: false; readonly error: string };

/** Long flags `remi codex` refuses, matched as `--name` and as `--name=value`. */
const DENIED_LONG_FLAGS = [
  '--config',
  '--enable',
  '--disable',
  '--profile',
  '--strict-config',
  '--dangerously-bypass-hook-trust',
  '--no-daemon',
  '--search',
  '--approve-for-me',
  '--remote',
  '--remote-auth-token-env',
  '--oss',
  '--local-provider',
  '--cd',
] as const;

/** Short flags refused, including every attached form (`-cX`, `-pX`, `-CX`). */
const DENIED_SHORT_FLAGS = ['c', 'p', 'C'] as const;

/**
 * Allowed flags that take a value. Only needed to tell a flag's value from the
 * positional that follows it, so `-m x resume <uuid>` reads `resume` as the
 * subcommand and not `x`. A flag not listed here is taken to have no value.
 */
const VALUED_LONG_FLAGS: readonly string[] = [
  '--model',
  '--ask-for-approval',
  '--sandbox',
  '--add-dir',
];
const VALUED_SHORT_FLAGS: readonly string[] = ['m', 'a', 's'];

/** Subcommands refused: `remi codex` runs the interactive TUI only. */
const REFUSED_SUBCOMMANDS: readonly string[] = [
  'fork',
  'exec',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'app-server',
  'proxy',
  'completion',
  'debug',
  'apply',
  'cloud',
  'sandbox',
  'review',
];

const NO_ALT_SCREEN = '--no-alt-screen';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(error: string): CodexArgsResult {
  return { ok: false, error };
}

function deniedFlagMessage(flag: string): string {
  if (flag === '--cd' || flag === '-C') {
    return `remi codex does not accept ${flag}: remi identifies the session by its working directory, so change directory before running remi codex`;
  }
  return `remi codex does not accept ${flag}: it is not passed through to Codex`;
}

/**
 * Validate the arguments of a local `remi codex` (the user is the principal).
 *
 * Returns the arguments to put after `codex --no-alt-screen`. `--no-alt-screen`
 * is accepted and removed (remi adds its own, so it appears exactly once), and
 * `--` and what follows it (prompt text) are kept as written. `resumeThreadId`
 * is the lowercased uuid of `resume <uuid>`, or null for a fresh session.
 * Refused: a denylisted flag (also as `--flag=value`, or attached to a short
 * one), every subcommand but `resume <uuid>`, and a `resume` without an
 * explicit uuid or with anything after it but options.
 */
export function validateCodexArgs(args: readonly string[]): CodexArgsResult {
  const separator = args.indexOf('--');
  const options = separator === -1 ? args : args.slice(0, separator);
  const promptTail = separator === -1 ? [] : args.slice(separator);

  const kept: string[] = [];
  const positionals: string[] = [];

  for (let i = 0; i < options.length; i++) {
    const token = options[i] as string;
    if (token === NO_ALT_SCREEN) continue;

    if (token.startsWith('--')) {
      const name = token.split('=', 1)[0] as string;
      if ((DENIED_LONG_FLAGS as readonly string[]).includes(name)) {
        return refuse(deniedFlagMessage(name));
      }
      kept.push(token);
      if (VALUED_LONG_FLAGS.includes(name) && !token.includes('=') && i + 1 < options.length) {
        kept.push(options[++i] as string);
      }
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      // A short flag, or a cluster of them: `-m`, `-mVALUE`, `-vc`. Walk it so a
      // denied letter cannot hide behind another flag, and stop at a valued
      // letter, whose remainder is its value.
      let takesNextToken = false;
      for (let c = 1; c < token.length; c++) {
        const letter = token[c] as string;
        if ((DENIED_SHORT_FLAGS as readonly string[]).includes(letter)) {
          return refuse(deniedFlagMessage(`-${letter}`));
        }
        if (VALUED_SHORT_FLAGS.includes(letter)) {
          takesNextToken = c === token.length - 1;
          break;
        }
      }
      kept.push(token);
      if (takesNextToken && i + 1 < options.length) kept.push(options[++i] as string);
      continue;
    }

    positionals.push(token);
    kept.push(token);
  }

  // The first token after `--` is positional too, and could be a subcommand.
  const subcommandSlots =
    promptTail.length > 1 ? [...positionals, promptTail[1] as string] : positionals;
  const refused = subcommandSlots.find((p) => REFUSED_SUBCOMMANDS.includes(p));
  if (refused !== undefined) {
    return refuse(
      `remi codex runs the interactive TUI only: the ${refused} subcommand is not supported`,
    );
  }

  const resumeAt = subcommandSlots.indexOf('resume');
  if (resumeAt === -1) {
    return { ok: true, args: [...kept, ...promptTail], resumeThreadId: null };
  }
  if (resumeAt !== 0) {
    return refuse('remi codex: put `resume <uuid>` before any prompt');
  }
  const threadId = positionals[1];
  if (threadId === undefined || !UUID_PATTERN.test(threadId)) {
    return refuse(
      'remi codex resume needs an explicit session id (a UUID); `resume --last` and the picker are not supported',
    );
  }
  if (subcommandSlots.length !== 2) {
    return refuse('remi codex resume <uuid> takes no prompt');
  }
  return { ok: true, args: [...kept, ...promptTail], resumeThreadId: threadId.toLowerCase() };
}

/** Bounds on a remote request's arguments. */
const REMOTE_MAX_ARGS = 16;
const REMOTE_MAX_ARG_LENGTH = 256;
/** A model name: no leading hyphen, so it can never read as a flag. */
const REMOTE_MODEL_PATTERN = /^[A-Za-z0-9._:[\]][A-Za-z0-9._:[\]-]{0,63}$/;
const REMOTE_APPROVAL_POLICIES: readonly string[] = ['untrusted', 'on-request'];
const REMOTE_SANDBOX_MODES: readonly string[] = ['read-only', 'workspace-write'];

/**
 * Validate the arguments of a Codex session requested over the wire
 * (default-deny). Accepted, each at most once and in any order: `-m` or
 * `--model` followed by a model name, `-a untrusted|on-request`,
 * `-s read-only|workspace-write`, and `resume <uuid>`. Everything else is
 * refused, including a prompt, `--`, `--no-alt-screen` (remi adds it) and the
 * `--flag=value` spelling. At most 16 arguments of at most 256 characters
 * each, none containing NUL. Returns the arguments as given.
 */
export function validateCodexRemoteArgs(args: readonly unknown[]): CodexArgsResult {
  if (args.length > REMOTE_MAX_ARGS) {
    return refuse(`remote codex arguments: at most ${REMOTE_MAX_ARGS} are allowed`);
  }
  for (const arg of args) {
    if (typeof arg !== 'string') return refuse('remote codex arguments must be strings');
    if (arg.length > REMOTE_MAX_ARG_LENGTH) {
      return refuse(`remote codex arguments: at most ${REMOTE_MAX_ARG_LENGTH} characters each`);
    }
    if (arg.includes('\0')) return refuse('remote codex arguments must not contain NUL');
  }
  const tokens = args as readonly string[];

  const seen = new Set<string>();
  let resumeThreadId: string | null = null;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] as string;
    const value = tokens[i + 1];
    let slot: string;
    switch (token) {
      case '-m':
      case '--model':
        slot = 'model';
        if (value === undefined || !REMOTE_MODEL_PATTERN.test(value)) {
          return refuse(`remote codex arguments: ${token} needs a model name`);
        }
        break;
      case '-a':
        slot = 'approval';
        if (value === undefined || !REMOTE_APPROVAL_POLICIES.includes(value)) {
          return refuse(
            `remote codex arguments: -a must be ${REMOTE_APPROVAL_POLICIES.join(' or ')}`,
          );
        }
        break;
      case '-s':
        slot = 'sandbox';
        if (value === undefined || !REMOTE_SANDBOX_MODES.includes(value)) {
          return refuse(`remote codex arguments: -s must be ${REMOTE_SANDBOX_MODES.join(' or ')}`);
        }
        break;
      case 'resume':
        slot = 'resume';
        if (value === undefined || !UUID_PATTERN.test(value)) {
          return refuse('remote codex arguments: resume needs a session id (a UUID)');
        }
        resumeThreadId = value.toLowerCase();
        break;
      default:
        return refuse(`remote codex arguments: ${JSON.stringify(token)} is not allowed`);
    }
    if (seen.has(slot)) return refuse(`remote codex arguments: ${slot} given twice`);
    seen.add(slot);
    i++;
  }
  return { ok: true, args: [...tokens], resumeThreadId };
}

/**
 * The session's working directory as `realpath` resolves it, which must exist
 * and be a directory. Identity matching compares this against the cwd Codex
 * reports for a thread, so the symlink-resolved form is the one to hold.
 */
export function resolveCodexWorkingDirectory(
  directory: string,
):
  | { readonly ok: true; readonly directory: string }
  | { readonly ok: false; readonly error: string } {
  let real: string;
  try {
    real = fs.realpathSync(directory);
  } catch {
    return { ok: false, error: `working directory does not exist: ${directory}` };
  }
  if (!fs.statSync(real).isDirectory()) {
    return { ok: false, error: `working directory is not a directory: ${directory}` };
  }
  return { ok: true, directory: real };
}
