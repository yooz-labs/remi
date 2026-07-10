/**
 * One-line drift phrase for a daemon whose recorded binary version differs
 * from the installed binary (#539: a daemon holds its binary for life;
 * upgrades only affect newly started daemons). Null when either side is
 * unknown or they match.
 *
 * The single source of the wording shared by `remi status` (daemon-manager)
 * and `remi ls` (ls-client), so the two commands' warnings cannot silently
 * drift apart (#766 release review).
 */
export function formatVersionDrift(
  runningVersion: string | undefined,
  installedVersion: string | undefined,
): string | null {
  if (!runningVersion || !installedVersion) return null;
  if (runningVersion === installedVersion) return null;
  return `runs remi ${runningVersion}; installed binary is ${installedVersion} — restart to apply`;
}
