/**
 * CLI Argument Parser - Pure function for parsing remi CLI arguments.
 *
 * Extracted from cli.ts to enable unit testing. No side effects: no process.exit(),
 * no console output. Returns a ParsedArgs object that the caller uses to drive behavior.
 */

export type Subcommand =
  | 'ls'
  | 'attach'
  | 'code'
  | 'keygen'
  | 'export-key'
  | 'import-key'
  | 'authorize'
  | 'keys'
  | 'new'
  | 'kill'
  | 'detach'
  | 'recent'
  | 'start'
  | 'stop'
  | 'status'
  | 'logs';

export interface ParsedArgs {
  readonly port: number | undefined;
  readonly noTelegram: boolean;
  readonly maxBulletLength: number | undefined;
  readonly daemonMode: boolean;
  readonly signalingUrl: string | undefined;
  readonly noRelay: boolean;
  readonly resume: string | true | undefined;
  readonly showSessions: boolean;
  readonly install: boolean;
  readonly uninstall: boolean;
  readonly subcommand: Subcommand | undefined;
  readonly subcommandArg: string | undefined;
  readonly codeRefresh: boolean;
  readonly permanentCode: boolean;
  readonly force: boolean;
  readonly usePassphrase: boolean;
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
  readonly claudeArgs: readonly string[];
  readonly showVersion: boolean;
  readonly showHelp: boolean;
  readonly error: string | undefined;
}

const SUBCOMMANDS: ReadonlySet<string> = new Set<Subcommand>([
  'ls',
  'attach',
  'code',
  'keygen',
  'export-key',
  'import-key',
  'authorize',
  'keys',
  'new',
  'kill',
  'detach',
  'recent',
  'start',
  'stop',
  'status',
  'logs',
]);

const SUBCOMMANDS_WITH_POSITIONAL_ARG: ReadonlySet<string> = new Set([
  'attach',
  'import-key',
  'authorize',
  'kill',
  'detach',
]);

export function parseArgs(args: readonly string[]): ParsedArgs {
  let port: number | undefined;
  let noTelegram = false;
  let maxBulletLength: number | undefined;
  let daemonMode = false;
  let signalingUrl: string | undefined;
  let noRelay = false;
  let resume: string | true | undefined;
  let showSessions = false;
  let install = false;
  let uninstall = false;
  let subcommand: Subcommand | undefined;
  let subcommandArg: string | undefined;
  let codeRefresh = false;
  let permanentCode = false;
  let force = false;
  let usePassphrase = false;
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
      showSessions = true;
    } else if (arg === '--port' && nextArg) {
      port = Number.parseInt(nextArg);
      i++;
    } else if (arg === '--max-bullet-length' && nextArg) {
      maxBulletLength = Number.parseInt(nextArg);
      i++;
    } else if (arg === '--no-telegram') {
      noTelegram = true;
    } else if (arg === '--no-relay') {
      noRelay = true;
    } else if (arg === '--permanent-code') {
      permanentCode = true;
    } else if (arg === '--signaling-url' && nextArg) {
      signalingUrl = nextArg;
      i++;
    } else if (arg === '--install') {
      install = true;
    } else if (arg === '--uninstall') {
      uninstall = true;
    } else if (arg === '--force') {
      force = true;
    } else if (arg === '--passphrase') {
      usePassphrase = true;
    } else if (arg === '--no-tofu') {
      noTofu = true;
    } else if (arg === '--auth') {
      auth = true;
    } else if (arg === '--no-auth') {
      auth = false;
    } else if (arg === '--label' && nextArg) {
      label = nextArg;
      i++;
    } else if (arg === '--public-only') {
      publicOnly = true;
    } else if (arg === '--bind' && nextArg) {
      bindHost = nextArg;
      i++;
    } else if (arg === '--remove' && nextArg) {
      removeFingerprint = nextArg;
      i++;
    } else if (arg === '--local') {
      bindHost = 'localhost';
      noMdns = true;
    } else if (arg === '--no-mdns') {
      noMdns = true;
    } else if (arg === '--network') {
      network = true;
    } else if (arg === '--dir' && nextArg) {
      if (recent) {
        error = 'Error: --dir and --recent are mutually exclusive.';
      }
      dir = nextArg;
      i++;
    } else if (arg === '--recent') {
      if (dir) {
        error = 'Error: --dir and --recent are mutually exclusive.';
      }
      recent = true;
    } else if (arg === '--host' && nextArg) {
      host = nextArg;
      i++;
    } else if (arg === '--version' || arg === '-v') {
      showVersion = true;
    } else if (arg === '--help' || arg === '-h') {
      showHelp = true;
    } else if (SUBCOMMANDS.has(arg as string)) {
      subcommand = arg as Subcommand;
      if (
        SUBCOMMANDS_WITH_POSITIONAL_ARG.has(arg as string) &&
        nextArg &&
        !nextArg.startsWith('-')
      ) {
        subcommandArg = nextArg;
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
    claudeArgs,
    showVersion,
    showHelp,
    error,
  };
}
