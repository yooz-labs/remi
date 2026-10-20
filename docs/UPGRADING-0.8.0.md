# Upgrade the CLI for native TestFlight

The native iPhone app 0.2.0 (11) and CLI 0.8.0 have separate version numbers and
distribution channels. Installing the new app does not update the CLI or a daemon
already running on a machine.

CLI 0.7.16 does not recognize `remi pair`: it can launch Claude with `pair` as a
prompt. Use CLI 0.8.0 or later on every machine you pair with the native app.

## Install the published CLI

After the 0.8.0 release is published, use the package manager that owns your CLI.
For Homebrew:

```sh
brew update
brew upgrade yooz-labs/tap/remi
command -v remi
remi --version
```

For the scoped npm package, using Bun:

```sh
bun install -g @yooz-labs/remi@0.8.0
command -v remi
remi --version
```

The npm package named plain `remi` is unrelated. If the version is still 0.7.16,
check `type -a remi`: another install, alias or cached shell command may take
precedence. Start a new shell after changing which installation is on PATH.

## Restart the hub and each session daemon

A running process keeps its old code after a package upgrade. Save your active
work and end old wrappers normally before starting replacements. `remi stop`
stops the hub; it leaves session daemons running. Do not use `remi stop --all`
unless you intend to stop those sessions too.

```sh
remi stop
remi start --no-relay
remi status
```

`--no-relay` keeps this first pairing check on the direct path, including when an
existing config explicitly enabled relay. Once the separate v2 deployment is
configured, the hub can be restarted with relay enabled.

## Pair the iPhone

For nearby direct pairing, the hub needs authentication enabled and a bind your
phone can reach. The default loopback bind is suitable for an SSH tunnel but
cannot be scanned as a reachable phone endpoint. Choose a private LAN/VPN
address in `[daemon] bind` before restarting the hub; `0.0.0.0` listens on all
IPv4 interfaces. Keep `[auth] enabled = "auto"` or `true`.

```sh
remi pair
```

In the native app, add a machine and scan the QR. Compare the device fingerprint
in the app with the terminal, then type its first four characters at the terminal
to approve. The code is single use, expires after five minutes, and grants no
access by itself. Direct WS traffic is not encrypted by Remi: use a trusted
network, VPN or SSH tunnel. Direct QR pairing refuses a TLS hub until native
secure endpoint pairing support is available; see [DIRECT-TLS.md](DIRECT-TLS.md).

For manual public-key provisioning and approval, see
[PROVISIONING.md](PROVISIONING.md). Never share a private identity export.

## Relay and push are separate deployment gates

Relay stays opt-in. This CLI release retires old connection codes; the v2 relay
requires its own Worker deployment and enrollment with `remi pair --relay`.
Follow [the deployment runbook](relay-worker-deploy-runbook.md), including the
irreversible Durable Object migration, matching Worker/hub push bearer and exact
`PUSH_AUDIENCE` origin. Old senders without that bearer cannot send pushes through
the new Worker, including on its retained legacy `/push` route.

An internal TestFlight build and green source CI do not establish all production
relay, signed-device, Watch, two-machine Mac or battery gates. Keep those checks
tracked in the [native handoff](../packages/native/handoff/testflight-backend.md).
