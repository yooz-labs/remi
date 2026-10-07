/**
 * CLI Argument Parser - Pure function for parsing remi CLI arguments.
 *
 * Extracted from cli.ts to enable unit testing. No side effects: no process.exit(),
 * no console output. Returns a ParsedArgs object that the caller uses to drive behavior.
 *
 * Callers MUST check `error` before using any other field.
 */

import { HARNESS_IDS, isHarnessId } from '@remi/shared';
import type { HarnessId } from '@remi/shared';

const SUBCOMMAND_LIST = [
  'ls',
  'attach',
  'code',
  'config',
  'keygen',
  'export-key',
  'import-key',
  'authorize',
  'keys',
  'new',
  'kill',
  'detach',
  'recent',
  'reload',
  'unstick',
  'start',
  'stop',
  'status',
  'logs',
  'serve',
  'model',
  'migrate-permissions',
  'codex',
  'pair',
] as const;

export type Subcommand = (typeof SUBCOMMAND_LIST)[number];

const SUBCOMMANDS: ReadonlySet<string> = new Set(SUBCOMMAND_LIST);

const SUBCOMMANDS_WITH_POSITIONAL_ARG: ReadonlySet<Subcommand> = new Set<Subcommand>([
  'attach',
  'config',
  'import-key',
  'authorize',
  'kill',
  'detach',
  'unstick',
  'model',
  'migrate-permissions',
]);

/** Subcommands that take a VERB plus its own operands (`remi model pull <id>`),
 *  rather than the single positional every other subcommand takes. Their words
 *  are collected into `subcommandArgs` instead of falling through to
 *  `claudeArgs` -- a stray `pull` reaching Claude would be nonsense. #819 */
const SUBCOMMANDS_WITH_ARG_LIST: ReadonlySet<Subcommand> = new Set<Subcommand>(['model']);

/** Auto-approve switches removed in #1125 (ADR 0030). Accepted and ignored. */
const REMOVED_SWITCH_FLAGS: ReadonlySet<string> = new Set(['--auto-approve', '--no-auto-approve']);

/** Auto-approve flags removed in #1125 that took a value. Accepted and ignored,
 *  value included. */
const REMOVED_VALUE_FLAGS: ReadonlySet<string> = new Set([
  '--auto-approve-model',
  '--auto-approve-provider',
  '--auto-approve-api-key',
  '--auto-approve-allow',
  '--auto-approve-deny',
  '--auto-approve-instructions',
  '--auto-approve-multichoice',
  '--auto-approve-multichoice-model',
]);

export function isSubcommand(s: string): s is Subcommand {
  return SUBCOMMANDS.has(s);
}

/** Check if a string looks like a filesystem path (for `remi new /path` support). */
export function isPathLike(s: string): boolean {
  return (
    s === '.' ||
    s.startsWith('/') ||
    s.startsWith('~/') ||
    s.startsWith('./') ||
    s.startsWith('../')
  );
}

export interface ParsedArgs {
  readonly port: number | undefined;
  readonly noTelegram: boolean;
  readonly maxBulletLength: number | undefined;
  readonly daemonMode: boolean;
  readonly signalingUrl: string | undefined;
  readonly noRelay: boolean;
  readonly resume: string | true | undefined;
  readonly showSessions: 'running' | 'all' | 'exited' | false;
  readonly install: boolean;
  readonly uninstall: boolean;
  readonly subcommand: Subcommand | undefined;
  readonly subcommandArg: string | undefined;
  /** All operands of a verb-taking subcommand (#819): `remi model pull foo` ->
   *  `['pull', 'foo']`. Empty for every other subcommand; `subcommandArg`
   *  remains the first element so existing callers are unaffected. */
  readonly subcommandArgs: readonly string[];
  readonly codeRefresh: boolean;
  readonly permanentCode: boolean;
  readonly force: boolean;
  /** `remi stop --all`: also stop session daemons, not just the hub (#859). */
  readonly stopAll: boolean;
  readonly usePassphrase: boolean;
  readonly decrypt: boolean;
  readonly encrypt: boolean;
  readonly noTofu: boolean;
  readonly auth: boolean | undefined;
  readonly label: string | undefined;
  readonly publicOnly: boolean;
  readonly bindHost: string | undefined;
  readonly removeFingerprint: string | undefined;
  readonly noMdns: boolean;
  readonly network: boolean;
  readonly host: string | undefined;
  readonly dir: string | undefined;
  readonly recent: boolean;
  readonly pushSecret: string | undefined;
  readonly orphanTimeout: number | undefined;
  /**
   * Removed auto-approve flags that were given (#1125, ADR 0030), in order,
   * without their values. Accepted and ignored so existing LaunchAgent plists
   * and scripts keep starting; the caller prints one notice naming them.
   */
  readonly removedFlags: readonly string[];
  readonly claudeArgs: readonly string[];
  /**
   * The words `claudeArgs` holds, with the user's own `--` kept in place (#1177). `remi codex`
   * validates the words after a `--` as prompt text, not as flags, so it must see where they begin.
   */
  readonly passthroughArgs: readonly string[];
  /**
   * The tokens after the first `--`, and only those, without the `--` (#1179). This is what a
   * hub appends to a child daemon's command line, last (`create-session-events.ts`), so a daemon
   * reads its harness's arguments from here and ignores stray tokens: an existing LaunchAgent
   * plist with a loose word in it starts exactly as before.
   */
  readonly explicitArgs: readonly string[];
  /**
   * The harness `--harness <id>` names: how a hub tells a child daemon its harness (#1177), and how
   * `remi new --host <ip> --harness codex` asks a remote hub for one (#1179). User-facing; the help
   * of `new` lists it.
   */
  readonly harness: HarnessId | undefined;
  readonly showVersion: boolean;
  readonly showHelp: boolean;
  /** Callers MUST check this before using any other field. */
  readonly error: string | undefined;
}

/**
 * The words that are neither a remi flag nor after a `--` (#1179 review): `claudeArgs` holds them
 * first and then the tokens after the `--` (`explicitArgs`), so they are what is left at the front.
 * A command that sends its harness arguments somewhere that reads only `explicitArgs` (`--host`, a
 * Codex `--daemon`) must refuse these, or the person gets what they did not ask for, silently.
 */
export function looseArgs(
  parsed: Pick<ParsedArgs, 'claudeArgs' | 'explicitArgs'>,
): readonly string[] {
  return parsed.claudeArgs.slice(0, parsed.claudeArgs.length - parsed.explicitArgs.length);
}

export function parseArgs(args: readonly string[]): ParsedArgs {
  let port: number | undefined;
  let noTelegram = false;
  let maxBulletLength: number | undefined;
  let daemonMode = false;
  let signalingUrl: string | undefined;
  let noRelay = false;
  let resume: string | true | undefined;
  let showSessions: 'running' | 'all' | 'exited' | false = false;
  let install = false;
  let uninstall = false;
  let orphanTimeout: number | undefined;
  let subcommand: Subcommand | undefined;
  let subcommandArg: string | undefined;
  const subcommandArgs: string[] = [];
  let codeRefresh = false;
  let permanentCode = false;
  let force = false;
  let stopAll = false;
  let usePassphrase = false;
  let decrypt = false;
  let encrypt = false;
  let noTofu = false;
  let auth: boolean | undefined;
  let label: string | undefined;
  let publicOnly = false;
  let bindHost: string | undefined;
  let removeFingerprint: string | undefined;
  let noMdns = false;
  let network = false;
  let host: string | undefined;
  let pushSecret: string | undefined;
  let dir: string | undefined;
  let recent = false;
  const removedFlags: string[] = [];
  let showVersion = false;
  let showHelp = false;
  let error: string | undefined;
  const claudeArgs: string[] = [];
  const passthroughArgs: string[] = [];
  const explicitArgs: string[] = [];
  let harness: HarnessId | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    // Standard Unix: everything after '--' is passthrough
    if (arg === '--') {
      passthroughArgs.push('--');
      for (let j = i + 1; j < args.length; j++) {
        const a = args[j];
        if (a) {
          claudeArgs.push(a);
          passthroughArgs.push(a);
          explicitArgs.push(a);
        }
      }
      break;
    }

    if (arg === '--daemon') {
      daemonMode = true;
    } else if (arg === '--resume') {
      if (nextArg && !nextArg.startsWith('-')) {
        resume = nextArg;
        i++;
      } else {
        resume = true;
      }
    } else if (arg === '--sessions') {
      if (nextArg === '--all' || nextArg === 'all') {
        showSessions = 'all';
        i++;
      } else if (nextArg === '--exited' || nextArg === 'exited') {
        showSessions = 'exited';
        i++;
      } else {
        showSessions = 'running';
      }
    } else if (arg === '--port') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --port requires a value.';
      } else {
        const parsed = Number.parseInt(nextArg);
        if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
          error = `Error: Invalid port "${nextArg}". Must be 1-65535.`;
        } else {
          port = parsed;
        }
        i++;
      }
    } else if (arg === '--max-bullet-length') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --max-bullet-length requires a value.';
      } else {
        const parsed = Number.parseInt(nextArg);
        if (Number.isNaN(parsed) || parsed < 0) {
          error = `Error: Invalid max-bullet-length "${nextArg}". Must be a non-negative integer.`;
        } else {
          maxBulletLength = parsed;
        }
        i++;
      }
    } else if (arg === '--orphan-timeout') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --orphan-timeout requires a value in seconds.';
      } else {
        const parsed = Number.parseInt(nextArg);
        if (Number.isNaN(parsed) || parsed < 0) {
          error = `Error: Invalid orphan-timeout "${nextArg}". Must be a non-negative integer (seconds).`;
        } else {
          orphanTimeout = parsed;
        }
        i++;
      }
    } else if (arg === '--no-telegram') {
      noTelegram = true;
    } else if (arg === '--no-relay') {
      noRelay = true;
    } else if (arg === '--permanent-code') {
      permanentCode = true;
    } else if (arg === '--signaling-url') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --signaling-url requires a value.';
      } else {
        signalingUrl = nextArg;
        i++;
      }
    } else if (arg === '--push-secret') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --push-secret requires a value.';
      } else {
        pushSecret = nextArg;
        i++;
      }
    } else if (arg === '--install') {
      if (uninstall) {
        error = 'Error: --install and --uninstall are mutually exclusive.';
      }
      install = true;
    } else if (arg === '--uninstall') {
      if (install) {
        error = 'Error: --install and --uninstall are mutually exclusive.';
      }
      uninstall = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--all') {
      // Only `stop` defines a top-level `--all` today; harmless elsewhere.
      stopAll = true;
    } else if (arg === '--passphrase') {
      usePassphrase = true;
    } else if (arg === '--decrypt') {
      decrypt = true;
    } else if (arg === '--encrypt') {
      encrypt = true;
    } else if (arg === '--no-tofu') {
      noTofu = true;
    } else if (arg === '--auth') {
      auth = true;
    } else if (arg === '--no-auth') {
      auth = false;
    } else if (arg === '--label') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --label requires a value.';
      } else {
        label = nextArg;
        i++;
      }
    } else if (arg === '--public-only') {
      publicOnly = true;
    } else if (arg === '--bind') {
      if (!nextArg) {
        error = 'Error: --bind requires a value.';
      } else {
        bindHost = nextArg;
        i++;
      }
    } else if (arg === '--remove') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --remove requires a value.';
      } else {
        removeFingerprint = nextArg;
        i++;
      }
    } else if (arg === '--local') {
      bindHost = 'localhost';
      noMdns = true;
    } else if (arg === '--no-mdns') {
      noMdns = true;
    } else if (arg === '--network') {
      network = true;
    } else if (arg === '--dir') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --dir requires a value.';
      } else {
        if (recent) {
          error = 'Error: --dir and --recent are mutually exclusive.';
        }
        dir = nextArg;
        i++;
      }
    } else if (arg === '--recent') {
      if (dir) {
        error = 'Error: --dir and --recent are mutually exclusive.';
      }
      recent = true;
    } else if (arg === '--host') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --host requires a value.';
      } else {
        host = nextArg;
        i++;
      }
    } else if (arg === '--harness') {
      if (!nextArg || nextArg.startsWith('-')) {
        error = 'Error: --harness requires a value.';
      } else if (!isHarnessId(nextArg)) {
        error = `Error: unknown harness "${nextArg}". Known: ${HARNESS_IDS.join(', ')}.`;
      } else {
        harness = nextArg;
        i++;
      }
    } else if (arg !== undefined && REMOVED_SWITCH_FLAGS.has(arg)) {
      removedFlags.push(arg);
    } else if (arg !== undefined && REMOVED_VALUE_FLAGS.has(arg)) {
      // Swallow the value too, so it is not mistaken for a Claude argument or
      // a subcommand. A missing value is not an error any more: nothing reads it.
      removedFlags.push(arg);
      if (nextArg !== undefined && !nextArg.startsWith('-')) i++;
    } else if (arg === '--version' || arg === '-v') {
      showVersion = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (
      isSubcommand(arg as string) &&
      subcommand !== 'codex' &&
      !(arg === 'codex' && subcommand !== undefined)
    ) {
      // Once `codex` is the subcommand, the words after it are Codex's (a prompt may say
      // "status" or "config"), so a later subcommand name is not a subcommand. And `codex`
      // itself is a subcommand only when none was given: `remi stop codex` stops.
      subcommand = arg as Subcommand;
      if (SUBCOMMANDS_WITH_ARG_LIST.has(subcommand)) {
        // Consume every following operand up to the first flag: the verb and
        // its arguments both belong to this subcommand.
        //
        // Flags are NOT swallowed wholesale -- `remi model --help` must still
        // reach the global help branch -- so only flags this subcommand
        // actually defines are collected, by name.
        const OWN_FLAGS: ReadonlySet<string> = new Set(['--all']);
        while (
          args[i + 1] &&
          (!(args[i + 1] as string).startsWith('-') || OWN_FLAGS.has(args[i + 1] as string))
        ) {
          subcommandArgs.push(args[i + 1] as string);
          i++;
        }
        subcommandArg = subcommandArgs[0];
      } else if (
        SUBCOMMANDS_WITH_POSITIONAL_ARG.has(subcommand) &&
        nextArg &&
        !nextArg.startsWith('-')
      ) {
        subcommandArg = nextArg;
        i++;
      } else if (
        subcommand === 'new' &&
        nextArg &&
        !nextArg.startsWith('-') &&
        isPathLike(nextArg)
      ) {
        // remi new /path → treat as --dir
        if (recent) {
          error = 'Error: --dir and --recent are mutually exclusive.';
        }
        dir = nextArg;
        i++;
      }
      if (arg === 'code' && nextArg === '--refresh') {
        codeRefresh = true;
        i++;
      }
    } else if (
      subcommand &&
      SUBCOMMANDS_WITH_POSITIONAL_ARG.has(subcommand) &&
      !subcommandArg &&
      arg &&
      !arg.startsWith('-')
    ) {
      subcommandArg = arg;
    } else if (arg) {
      claudeArgs.push(arg);
      passthroughArgs.push(arg);
    }
  }

  if (
    error === undefined &&
    subcommand === 'codex' &&
    harness !== undefined &&
    harness !== 'codex'
  ) {
    error = `Error: --harness ${harness} conflicts with the codex subcommand.`;
  }

  return {
    port,
    noTelegram,
    maxBulletLength,
    daemonMode,
    signalingUrl,
    noRelay,
    resume,
    showSessions,
    install,
    uninstall,
    subcommand,
    subcommandArg,
    subcommandArgs,
    codeRefresh,
    permanentCode,
    force,
    stopAll,
    usePassphrase,
    decrypt,
    encrypt,
    noTofu,
    auth,
    label,
    publicOnly,
    bindHost,
    removeFingerprint,
    noMdns,
    network,
    host,
    pushSecret,
    dir,
    recent,
    removedFlags,
    orphanTimeout,
    claudeArgs,
    passthroughArgs,
    explicitArgs,
    harness,
    showVersion,
    showHelp,
    error,
  };
}

/**
 * Parse host:path syntax for the `new` command.
 * Supports `host:~/path` and `host:/absolute/path` but not `host:port`.
 * Handles bracketed IPv6: `[::1]:~/path`.
 *
 * Returns { host, directory } where directory is set only if path was found.
 */
export function parseHostPath(raw: string): { host: string; directory?: string } {
  // Bracketed IPv6: [::1]:~/path or [fe80::1]:~/path
  if (raw.startsWith('[')) {
    const closeBracket = raw.indexOf(']');
    if (closeBracket > 0 && raw[closeBracket + 1] === ':') {
      const afterColon = raw.slice(closeBracket + 2);
      if (afterColon.startsWith('/') || afterColon.startsWith('~')) {
        return { host: raw.slice(0, closeBracket + 1), directory: afterColon };
      }
    }
    return { host: raw };
  }

  const colonIdx = raw.indexOf(':');
  if (colonIdx > 0) {
    const afterColon = raw.slice(colonIdx + 1);
    if (afterColon.startsWith('/') || afterColon.startsWith('~')) {
      return { host: raw.slice(0, colonIdx), directory: afterColon };
    }
  }
  return { host: raw };
}
