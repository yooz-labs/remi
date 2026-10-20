import type { HarnessId } from '@remi/shared';
import type { ParsedArgs } from './arg-parser.ts';

type LaunchArgs = Pick<
  ParsedArgs,
  'subcommand' | 'harness' | 'install' | 'uninstall' | 'showSessions'
>;

/** #1473: the configured default belongs to CLI session launches, not hub/management commands. */
export function isSessionLaunch(args: LaunchArgs): boolean {
  if (args.install || args.uninstall || args.showSessions) return false;
  return (
    args.subcommand === undefined ||
    args.subcommand === 'new' ||
    args.subcommand === 'claude' ||
    args.subcommand === 'codex'
  );
}

/** Keep legacy remote omission for implicit Claude; every explicit choice is named. */
export function resolveLaunchHarness(
  args: LaunchArgs,
  configuredDefault: 'claude' | 'codex',
): { harnessId: HarnessId; remoteHarness: HarnessId | undefined } {
  const alias =
    args.subcommand === 'claude' || args.subcommand === 'codex' ? args.subcommand : undefined;
  const explicit = args.harness ?? alias;
  const harnessId = explicit ?? (isSessionLaunch(args) ? configuredDefault : 'claude');
  return {
    harnessId,
    remoteHarness: explicit ?? (harnessId === 'codex' ? 'codex' : undefined),
  };
}
