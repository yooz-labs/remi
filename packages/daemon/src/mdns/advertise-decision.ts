/**
 * Why mDNS is or is not advertising (#1051).
 *
 * `startMdnsIfNeeded` used to collapse three suppression conditions into one
 * bare `return null`, while every OTHER exit from that function said something
 * ("Advertising on local network", "Failed to start: ..."). Before #880 that
 * was nearly harmless, because `isLocalhostBind` was false on a stock install.
 * Since the bind default moved to loopback it is the path EVERY stock install
 * takes — so the one unexplained exit became the common one.
 *
 * What that costs: mDNS does not refuse a discovery attempt, it stops
 * answering. From the phone's side the daemon does not error, it VANISHES. The
 * user's reading is "Remi is broken" or "my network is broken", and nothing in
 * the daemon's own output contradicts it.
 *
 * This module is the decision only — a pure function so it can be tested
 * without booting a daemon, since the caller in `cli.ts` is module-level
 * startup code with no seam. The caller owns the sink, which is deliberate:
 * before the stdout redirect (daemon/serve mode) the terminal is reachable,
 * after it (wrapper mode) the terminal belongs to Claude's TUI and the log file
 * is the only honest destination. Both are already passed in as `logFn`.
 */

/** What is suppressing the advertisement, in the order the caller checks. */
export type MdnsSuppression =
  /** `--no-mdns` on the command line. */
  | { readonly kind: 'cli-flag' }
  /** `network.mdns = false` in config.toml. */
  | { readonly kind: 'config' }
  /** The daemon is bound to loopback, so there is nothing off-machine to find. */
  | { readonly kind: 'loopback'; readonly bindHost: string };

export interface MdnsAdvertiseInputs {
  readonly cliNoMdns: boolean;
  readonly configMdns: boolean;
  readonly isLocalhostBind: boolean;
  readonly bindHost: string;
}

/**
 * Which condition suppresses advertising, or null when it should advertise.
 *
 * Order matches the caller's `||` chain exactly, and that matters: with both
 * `--no-mdns` and a loopback bind in play, reporting the loopback would hand
 * the user a remedy (`set daemon.bind`) that their own explicit flag would then
 * override. Naming the most deliberate cause first is the only ordering that
 * cannot produce advice which does not work.
 */
export function mdnsSuppression(inputs: MdnsAdvertiseInputs): MdnsSuppression | null {
  if (inputs.cliNoMdns) return { kind: 'cli-flag' };
  if (!inputs.configMdns) return { kind: 'config' };
  if (inputs.isLocalhostBind) return { kind: 'loopback', bindHost: inputs.bindHost };
  return null;
}

/**
 * The line to log for a suppression.
 *
 * Deliberate suppressions state the fact and stop. The loopback case is the
 * only one the user did not ask for — it arrived with a changed default — so it
 * is the only one that names a remedy. #1051 is explicit that the other two
 * must not nag: someone who passed `--no-mdns` does not need to be told how to
 * undo it every boot.
 */
export function mdnsSuppressionMessage(suppression: MdnsSuppression): string {
  switch (suppression.kind) {
    case 'cli-flag':
      return '[mDNS] Not advertising: --no-mdns was passed.';
    case 'config':
      return '[mDNS] Not advertising: network.mdns = false in ~/.remi/config.toml.';
    case 'loopback':
      return `[mDNS] Not advertising: bound to ${suppression.bindHost}, so there is nothing to discover off this machine (loopback is the default since #880). Set daemon.bind in ~/.remi/config.toml to advertise on your network — and set auth.enabled = true with it, because "auto" resolves to false on every bind.`;
  }
}
