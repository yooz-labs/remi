/**
 * Handler for the daemon lifecycle subcommands: `start`, `stop`, `status`, `logs`.
 *
 * These four all dispatch to functions in `daemon-manager.ts`; this module
 * keeps the dispatch in one place and shapes the `start` option forwarding
 * into a single options object so cli.ts can stay narrow.
 */

import * as dm from './daemon-manager.ts';

/** Subset of CLI flags needed for the `start` path. */
export interface StartDaemonOptions {
  readonly port?: number;
  readonly bindHost?: string;
  readonly auth?: boolean;
  readonly noMdns?: boolean;
  readonly noRelay?: boolean;
  readonly noTelegram?: boolean;
  readonly permanentCode?: boolean;
  readonly signalingUrl?: string;
  readonly pushSecret?: string;
  readonly orphanTimeout?: number;
}

/** Subcommands this handler owns. */
export type DaemonSubcommand = 'start' | 'stop' | 'status' | 'logs';

/**
 * Build the `--flag value` list that `remi start` should forward to the
 * spawned daemon process. Isolated so it can be unit-tested without
 * exercising the full daemon-manager path.
 */
export function buildStartDaemonArgs(opts: StartDaemonOptions): string[] {
  const extraArgs: string[] = [];
  if (opts.bindHost) extraArgs.push('--bind', opts.bindHost);
  if (opts.auth === true) extraArgs.push('--auth');
  if (opts.auth === false) extraArgs.push('--no-auth');
  if (opts.noMdns) extraArgs.push('--no-mdns');
  if (opts.noRelay) extraArgs.push('--no-relay');
  if (opts.noTelegram) extraArgs.push('--no-telegram');
  if (opts.permanentCode) extraArgs.push('--permanent-code');
  if (opts.signalingUrl) extraArgs.push('--signaling-url', opts.signalingUrl);
  if (opts.pushSecret) extraArgs.push('--push-secret', opts.pushSecret);
  if (opts.orphanTimeout !== undefined) {
    extraArgs.push('--orphan-timeout', String(opts.orphanTimeout));
  }
  return extraArgs;
}

/**
 * Run one of the daemon lifecycle subcommands.
 * Always exits 0 — errors inside daemon-manager are handled there.
 */
export async function runDaemonLifecycleCommand(
  sub: DaemonSubcommand,
  opts: StartDaemonOptions = {},
): Promise<number> {
  if (sub === 'start') {
    // Only pass port if user explicitly set --port flag.
    // Do NOT inherit REMI_PORT from env (it's set by wrapper sessions and
    // would conflict). The daemon finds its own free port.
    await dm.startDaemon({ port: opts.port, extraArgs: buildStartDaemonArgs(opts) });
    return 0;
  }
  if (sub === 'stop') {
    dm.stopDaemon();
    return 0;
  }
  if (sub === 'status') {
    dm.showDaemonStatus();
    return 0;
  }
  if (sub === 'logs') {
    dm.showDaemonLogs();
    return 0;
  }
  // Exhaustiveness check: if DaemonSubcommand gains a new value, this becomes
  // a type error rather than silently routing to showDaemonLogs.
  const _exhaustive: never = sub;
  void _exhaustive;
  return 0;
}
