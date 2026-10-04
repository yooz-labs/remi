/**
 * Argument validation for `remi codex` (epic #1175, phase 2 #1176): pure
 * functions, plus `resolveCodexWorkingDirectory`, which reads the filesystem.
 *
 * remi launches exactly `codex --no-alt-screen <validated arguments>`, so what
 * a user (or a remote client) can add is what has to be policed. Both
 * validators are default-deny ALLOWLISTS of flags; they differ in who may use
 * which:
 *
 * - `validateCodexArgs` is for a person at their own terminal. It allows
 *   `-m/--model`, `-a/--ask-for-approval`, `-s/--sandbox`, `--add-dir`,
 *   `-i/--image`, `--dangerously-bypass-approvals-and-sandbox`/`--yolo`,
 *   `-h/--help`, `-V/--version` and `--no-alt-screen`, and refuses every other
 *   flag. A denylist is not enough: the one this file started with missed
 *   `--worktree` (it moves the session's cwd like `-C/--cd`) and
 *   `--not-so-yolo` within one Codex release, and a flag remi does not know
 *   fails silently (an approval path that never reaches the phone), where a
 *   false refusal costs one retry. The denylist that remains only picks a more
 *   explanatory message for the flags remi knows it must not pass.
 * - `validateCodexRemoteArgs` is for a request that arrives over the wire
 *   (phase 5): loopback clients and capability-token holders skip auth, so
 *   unvalidated arguments would be a remote privilege boundary. It allows a
 *   model, an approval policy, a sandbox mode and `resume <uuid>`, with bounded
 *   size, and is total: any input that is not an array of those is a refusal,
 *   never a throw.
 *
 * What ships for subcommands: Codex reads an unknown name or alias as a
 * subcommand, so remi does not rely on a list of names for safety. The
 * returned arguments are `[...flags, 'resume', uuid]` or
 * `[...flags, '--', ...promptWords]`: a prompt always follows an inserted `--`,
 * so clap cannot take it for a subcommand, whatever its spelling. The name
 * list (`SUBCOMMAND_NAMES`) only gives the user a clear refusal when the FIRST
 * positional is a Codex subcommand name, instead of starting an interactive
 * session whose prompt is that word. Only `resume <uuid>` runs a subcommand.
 *
 * A token after a `--` the user typed is prompt text. `arg-parser.ts` drops
 * that `--` from `claudeArgs` but keeps it in `passthroughArgs`, which `remi
 * codex` hands to this validator (#1177). So a word after the user's `--` is
 * prompt text, never a flag, and a Codex flag that has the same name as one of
 * remi's (`-h`, `--version`, `--dir`, `--port`, `--resume`) cannot be passed
 * through remi: remi reads its own flags anywhere before the `--`.
 *
 * `validateCodexArgs` is consumed by the Codex launch (#1177); the remote
 * validator is the hub's, in phase 5, and until then only its tests call it.
 *
 * Not verified, because remi must not start Codex to find out: the flag lists
 * come from the epic plan, the spike, and a read-only look at the embedded
 * clap strings of Codex 0.160.0 by a reviewer. `-i/--image` is treated as
 * taking one value; a comma-separated list is one value and passes through.
 */

import * as fs from 'node:fs';

export type CodexArgsResult =
  | { readonly ok: true; readonly args: string[]; readonly resumeThreadId: string | null }
  | { readonly ok: false; readonly error: string };

/** Flags `remi codex` allows locally that take a value (long forms and short letters). */
const VALUED_LONG_FLAGS: readonly string[] = [
  '--model',
  '--ask-for-approval',
  '--sandbox',
  '--add-dir',
  '--image',
];
const VALUED_SHORT_LETTERS: readonly string[] = ['m', 'a', 's', 'i'];

/** Flags allowed locally that take no value. */
const BOOLEAN_LONG_FLAGS: readonly string[] = [
  '--dangerously-bypass-approvals-and-sandbox',
  '--yolo',
  '--help',
  '--version',
];
const BOOLEAN_SHORT_FLAGS: readonly string[] = ['-h', '-V'];

const NO_ALT_SCREEN = '--no-alt-screen';

/**
 * Flags remi knows it must not pass, with why. They are refused by the
 * allowlist anyway; this only chooses the message. Each group is one message,
 * so a flag missing here is still refused, with the generic one.
 */
const DENIED_FLAG_REASONS: ReadonlyArray<{ flags: readonly string[]; reason: string }> = [
  {
    flags: ['-C', '--cd', '--worktree'],
    reason:
      'remi identifies the session by its working directory, which this flag changes; change directory first',
  },
  {
    flags: [
      '-c',
      '--config',
      '--enable',
      '--disable',
      '-p',
      '--profile',
      '--strict-config',
      '--dangerously-bypass-hook-trust',
      '--no-daemon',
      '--remote',
      '--remote-auth-token-env',
    ],
    reason:
      'it can make the Codex TUI use its own app-server, or another one, instead of the shared one remi attaches to',
  },
  {
    flags: ['--approve-for-me', '--not-so-yolo'],
    reason: 'it changes who decides approval requests, which remi relays to the phone',
  },
  {
    flags: ['--search', '--oss', '--local-provider'],
    reason: 'it changes the session setup in ways remi does not model yet',
  },
];

/**
 * Codex subcommand names (and aliases) known to the installed 0.160.0, for the
 * clear refusal when the first positional is one. Not a safety list: see the
 * file header.
 */
const SUBCOMMAND_NAMES: readonly string[] = [
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
  'agents',
  'queue',
  'archive',
  'unarchive',
  'delete',
  'migrate-rollouts',
  'plugin',
  'doctor',
  'features',
  'execpolicy',
  'exec-server',
  'responses-api-proxy',
  'stdio-to-uds',
  'cloud-tasks',
  'update',
  'app',
  'remote-control',
  'a',
];

/** The shape of a Codex thread id (a UUID), the only thing remi stores or prints as one. */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function refuse(error: string): CodexArgsResult {
  return { ok: false, error };
}

function refusedFlagMessage(flag: string): string {
  const denied = DENIED_FLAG_REASONS.find((group) => group.flags.includes(flag));
  if (denied) {
    return `remi codex refuses ${flag} on purpose: ${denied.reason}; run codex directly if you need it`;
  }
  return `remi codex does not support ${flag} yet: run codex directly`;
}

/** `-i`, an attached `-iPATH`, `--image` or `--image=PATH`. */
function isImageFlag(flag: string): boolean {
  return flag === '--image' || flag.startsWith('--image=') || flag.startsWith('-i');
}

/** A token that is a flag, not a value: it starts with `-` and is more than a lone `-`. */
function looksLikeFlag(token: string): boolean {
  return token.length > 1 && token.startsWith('-');
}

/**
 * Validate the arguments of a local `remi codex` (the user is the principal,
 * but only allowlisted flags pass; see the file header).
 *
 * Returns the arguments to put after `codex --no-alt-screen`:
 * `[...flags, 'resume', uuid]` for a resume, otherwise `[...flags]` or
 * `[...flags, '--', ...promptWords]`. `--no-alt-screen` is accepted and
 * removed, because the launch adds its own and it must appear exactly once.
 * A valued flag takes the next token as its value only if that token is not
 * itself flag-shaped, so `-m -c x=y` is a refusal and not a model named `-c`.
 * A token after a `--` the user typed is prompt text, and a lone `-` is a
 * positional. `resumeThreadId` is the lowercased uuid of `resume <uuid>`, or
 * null for a fresh session.
 */
export function validateCodexArgs(args: readonly string[]): CodexArgsResult {
  const separator = args.indexOf('--');
  const head = separator === -1 ? args : args.slice(0, separator);
  const userPromptWords = separator === -1 ? [] : args.slice(separator + 1);

  const flags: string[] = [];
  const positionals: string[] = [];

  /** The value of the valued flag at `head[i]`, or null when the next token is missing or flag-shaped. */
  const nextValue = (i: number): string | null => {
    const value = head[i + 1];
    return value === undefined || looksLikeFlag(value) ? null : value;
  };

  for (let i = 0; i < head.length; i++) {
    const token = head[i] as string;
    if (token === NO_ALT_SCREEN) continue;

    if (token.startsWith('--')) {
      const name = token.split('=', 1)[0] as string;
      const joined = token.includes('=');
      if (VALUED_LONG_FLAGS.includes(name)) {
        flags.push(token);
        if (!joined) {
          const value = nextValue(i);
          if (value === null) return refuse(`remi codex: ${name} needs a value`);
          flags.push(value);
          i++;
        }
      } else if (BOOLEAN_LONG_FLAGS.includes(name) && !joined) {
        flags.push(token);
      } else if (BOOLEAN_LONG_FLAGS.includes(name)) {
        return refuse(`remi codex: ${name} takes no value`);
      } else {
        return refuse(refusedFlagMessage(name));
      }
      continue;
    }

    if (looksLikeFlag(token)) {
      const letter = token[1] as string;
      if (BOOLEAN_SHORT_FLAGS.includes(token)) {
        flags.push(token);
      } else if (VALUED_SHORT_LETTERS.includes(letter)) {
        flags.push(token);
        if (token.length === 2) {
          const value = nextValue(i);
          if (value === null) return refuse(`remi codex: -${letter} needs a value`);
          flags.push(value);
          i++;
        }
      } else {
        return refuse(refusedFlagMessage(`-${letter}`));
      }
      continue;
    }

    positionals.push(token);
  }

  const first = positionals[0];
  if (first === 'resume') {
    const threadId = positionals[1];
    if (threadId === undefined || !UUID_PATTERN.test(threadId)) {
      return refuse(
        'remi codex resume needs an explicit session id (a UUID); `resume --last` and the picker are not supported',
      );
    }
    if (positionals.length !== 2 || userPromptWords.length > 0) {
      return refuse('remi codex resume <uuid> takes no prompt');
    }
    // The output has no `--` before `resume`, so if `-i/--image` takes several values (not
    // verified) Codex would read `resume` and the id as image paths and start a fresh session
    // while remi expects the thread. Refused, not guessed.
    if (flags.some(isImageFlag)) {
      return refuse(
        'remi codex: -i/--image cannot be combined with resume; Codex may read `resume` and the id as image paths and start a new session instead of resuming',
      );
    }
    return {
      ok: true,
      args: [...flags, 'resume', threadId],
      resumeThreadId: threadId.toLowerCase(),
    };
  }
  if (first !== undefined && SUBCOMMAND_NAMES.includes(first)) {
    return refuse(
      `remi codex runs the interactive TUI only: ${first} is a Codex subcommand; to send it as prompt text put it after --`,
    );
  }

  const promptWords = [...positionals, ...userPromptWords];
  return {
    ok: true,
    args: promptWords.length > 0 ? [...flags, '--', ...promptWords] : flags,
    resumeThreadId: null,
  };
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
 * each, none containing NUL.
 *
 * Total over any input: what is not an array of strings (undefined, null, a
 * number, an object that only looks like an array) is a refusal, never a
 * throw, because phase 5 feeds it parsed wire JSON. The returned arguments are
 * the flags in the order given, then `resume <uuid>` last, the same shape the
 * local validator returns.
 */
export function validateCodexRemoteArgs(args: unknown): CodexArgsResult {
  if (!Array.isArray(args)) return refuse('remote codex arguments must be an array');
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
  const flags: string[] = [];
  let resumeThreadId: string | null = null;
  let resumeToken: string | null = null;
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
        flags.push(token, value);
        break;
      case '-a':
        slot = 'approval';
        if (value === undefined || !REMOTE_APPROVAL_POLICIES.includes(value)) {
          return refuse(
            `remote codex arguments: -a must be ${REMOTE_APPROVAL_POLICIES.join(' or ')}`,
          );
        }
        flags.push(token, value);
        break;
      case '-s':
        slot = 'sandbox';
        if (value === undefined || !REMOTE_SANDBOX_MODES.includes(value)) {
          return refuse(`remote codex arguments: -s must be ${REMOTE_SANDBOX_MODES.join(' or ')}`);
        }
        flags.push(token, value);
        break;
      case 'resume':
        slot = 'resume';
        if (value === undefined || !UUID_PATTERN.test(value)) {
          return refuse('remote codex arguments: resume needs a session id (a UUID)');
        }
        resumeThreadId = value.toLowerCase();
        resumeToken = value;
        break;
      default:
        return refuse(`remote codex arguments: ${JSON.stringify(token)} is not allowed`);
    }
    if (seen.has(slot)) return refuse(`remote codex arguments: ${slot} given twice`);
    seen.add(slot);
    i++;
  }
  return {
    ok: true,
    args: resumeToken === null ? flags : [...flags, 'resume', resumeToken],
    resumeThreadId,
  };
}

/** The filesystem calls `resolveCodexWorkingDirectory` makes, so a test can make one fail. */
export interface WorkingDirectoryFs {
  realpathSync(path: string): string;
  statSync(path: string): { isDirectory(): boolean };
  accessSync(path: string, mode: number): void;
}

function errnoMessage(directory: string, err: unknown): string {
  switch ((err as NodeJS.ErrnoException | undefined)?.code) {
    case 'ENOENT':
      return `working directory does not exist: ${directory}`;
    case 'EACCES':
    case 'EPERM':
      return `working directory is not accessible (permission denied): ${directory}`;
    case 'ELOOP':
      return `working directory is behind a symlink loop: ${directory}`;
    case 'ENOTDIR':
      return `working directory has a path component that is not a directory: ${directory}`;
    default:
      return `working directory cannot be resolved (${(err as NodeJS.ErrnoException | undefined)?.code ?? 'unknown error'}): ${directory}`;
  }
}

/**
 * The session's working directory as `realpath` resolves it, which must exist,
 * be a directory, and be searchable by this process. Identity matching compares
 * this against the cwd Codex reports for a thread, so the symlink-resolved form
 * is the one to hold. The empty string is refused (it would resolve to the
 * process's own cwd), every failure is a refusal that names its errno, and a
 * directory that disappears between the checks is a refusal, not a throw.
 */
export function resolveCodexWorkingDirectory(
  directory: string,
  ops: WorkingDirectoryFs = fs,
):
  | { readonly ok: true; readonly directory: string }
  | { readonly ok: false; readonly error: string } {
  if (typeof directory !== 'string' || directory === '') {
    return { ok: false, error: 'working directory is empty' };
  }
  let real: string;
  try {
    real = ops.realpathSync(directory);
  } catch (err) {
    return { ok: false, error: errnoMessage(directory, err) };
  }
  try {
    if (!ops.statSync(real).isDirectory()) {
      return { ok: false, error: `working directory is not a directory: ${directory}` };
    }
    ops.accessSync(real, fs.constants.X_OK);
  } catch (err) {
    return { ok: false, error: errnoMessage(directory, err) };
  }
  return { ok: true, directory: real };
}
