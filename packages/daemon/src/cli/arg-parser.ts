/**
 * CLI Argument Parser - Pure function for parsing remi CLI arguments.
 *
 * Extracted from cli.ts to enable unit testing. No side effects: no process.exit(),
 * no console output. Returns a ParsedArgs object that the caller uses to drive behavior.
 *
 * Callers MUST check `error` before using any other field.
 */

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
  'start',
  'stop',
  'status',
  'logs',
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
  readonly codeRefresh: boolean;
  readonly permanentCode: boolean;
  readonly force: boolean;
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
  readonly orphanTimeout: number | undefined;
  readonly claudeArgs: readonly string[];
  readonly showVersion: boolean;
  readonly showHelp: boolean;
  /** Callers MUST check this before using any other field. */
  readonly error: string | undefined;
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
  let codeRefresh = false;
  let permanentCode = false;
  let force = false;
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
  let dir: string | undefined;
  let recent = false;
  let showVersion = false;
  let showHelp = false;
  let error: string | undefined;
  const claudeArgs: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];

    // Standard Unix: everything after '--' is passthrough
    if (arg === '--') {
      for (let j = i + 1; j < args.length; j++) {
        const a = args[j];
        if (a) claudeArgs.push(a);
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
    } else if (arg === '--version' || arg === '-v') {
      showVersion = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (isSubcommand(arg as string)) {
      subcommand = arg as Subcommand;
      if (SUBCOMMANDS_WITH_POSITIONAL_ARG.has(subcommand) && nextArg && !nextArg.startsWith('-')) {
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
    } else {
      if (arg) claudeArgs.push(arg);
    }
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
    codeRefresh,
    permanentCode,
    force,
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
    dir,
    recent,
    orphanTimeout,
    claudeArgs,
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
