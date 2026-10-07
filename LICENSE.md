# Licensing

Remi is open core.
This repository holds components under two licenses, chosen per package directory.
This page is both the map of those directories and the license statement for everything outside them.
Inside a package directory, the license file in that directory is the one that applies.

| Directory | What it is | License | License file |
|---|---|---|---|
| `packages/daemon` | Daemon, CLI, PTY and session management | Apache License 2.0 | [packages/daemon/LICENSE](packages/daemon/LICENSE) |
| `packages/shared` | Shared protocol and types | Apache License 2.0 | [packages/shared/LICENSE](packages/shared/LICENSE) |
| `packages/web` | Mobile and web client | PolyForm Shield 1.0.0 | [packages/web/LICENSE.md](packages/web/LICENSE.md) |
| `packages/signaling` | Hosted relay (Cloudflare Worker) | PolyForm Shield 1.0.0 | [packages/signaling/LICENSE.md](packages/signaling/LICENSE.md) |
| `packages/macos` | Native Mac app | PolyForm Shield 1.0.0 | [packages/macos/LICENSE.md](packages/macos/LICENSE.md) |

## Everything outside the package directories

Everything outside the five package directories is licensed under the Apache License 2.0 by location, unless a file states otherwise.
That covers the root files, `scripts/`, `docs/`, `tests/`, `npm/`, `config/`, the CI configuration under `.github/`, and `.context/` (internal notes and plans).
The Apache License 2.0 text is in [packages/daemon/LICENSE](packages/daemon/LICENSE).

This includes build tooling and documentation for the PolyForm Shield products when they live outside the product's package directory: `docs/MACOS_APP.md`, `docs/TESTFLIGHT.md`, `scripts/testflight-*.sh`, `scripts/generate-macos-*.sh`, `scripts/stage-macos-web.sh` and `tests/e2e`.
The products themselves, meaning the contents of `packages/web`, `packages/signaling` and `packages/macos`, stay under PolyForm Shield 1.0.0.

## What the published packages contain

The `@yooz-labs/remi` npm package (`npm/remi`) is a small Node launcher.
It selects one of four platform packages (`@yooz-labs/remi-darwin-arm64`, `-darwin-x64`, `-linux-arm64`, `-linux-x64`), and those hold the compiled `remi` binary.
The binary is built from `packages/daemon` and `packages/shared` only, plus third-party dependencies that keep their own licenses.
Nothing from `packages/web`, `packages/signaling` or `packages/macos` is compiled into it; `packages/daemon/tests/license-boundary.test.ts` fails if daemon or shared code imports them.
The npm packages are therefore licensed Apache-2.0 and carry the Apache `LICENSE` and `NOTICE` files, plus `THIRD_PARTY_NOTICES`: the license of every package the binary bundles from `node_modules`, generated at release time from the bundle's real inputs (`scripts/third-party-notices.ts`, #1131). The same file is attached to each GitHub release, and the Homebrew formula installs it with the binary.

`bun build --compile` also embeds the Bun runtime in the binary, which carries its own licenses; their notices are not shipped yet ([#1256](https://github.com/yooz-labs/remi/issues/1256)).

## Which versions this covers

The Apache-2.0 grant applies from the first release that contains this change.
Earlier tags and npm versions (0.7.15 and before, whose npm manifests declare UNLICENSED) remain under the license they shipped with.

## Contributing

Outside contributions to the Apache-2.0 parts (`packages/daemon`, `packages/shared`, and everything outside the package directories) are welcome and are licensed under Apache License 2.0.

Outside contributions to the PolyForm Shield 1.0.0 parts (`packages/web`, `packages/signaling`, `packages/macos`) are not accepted without a prior written agreement with Yooz Labs.
Those packages are published to be inspected, not to take outside changes;
a pull request that touches one without such an agreement is closed.
See [CONTRIBUTING.md](CONTRIBUTING.md) for how to reach an agreement first.

## Questions

For commercial-use or dual-license inquiries about the PolyForm Shield parts: **dev@yooz.info**.
