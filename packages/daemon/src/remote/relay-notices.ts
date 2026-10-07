/**
 * Boot text for the relay (#1193). Kept apart from `relay-adapter.ts` so
 * `cli.ts` can print it without loading the adapter, which it only imports when
 * a relay will actually start.
 */

/**
 * Printed instead of registering an adapter when the relay is requested (a
 * `relay = true` left in `config.toml`, typically) but cannot run: it needs
 * `--auth --permanent-code`, and without them nothing could connect. Names how to
 * use it properly, what to use today, and how to silence the notice. Carries no
 * code or secret.
 */
export const RELAY_NOT_STARTED_NOTICE =
  'Relay not started: network.relay is on, but no relay client can connect without --auth --permanent-code.\n' +
  'For remote access use --auth --permanent-code, an SSH tunnel, or an explicit daemon.bind with --auth (Tailscale or LAN). ' +
  'To silence this notice, set network.relay = false in config.toml or pass --no-relay.';
