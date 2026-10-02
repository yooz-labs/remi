# Licensing

Remi is open core.
This repository holds components under two licenses, chosen per directory.
The license file inside each directory below is the one that applies to that directory; this page is only a map.

| Directory | What it is | License | License file |
|---|---|---|---|
| `packages/daemon` | Daemon, CLI, PTY and session management | Apache License 2.0 | [packages/daemon/LICENSE](packages/daemon/LICENSE) |
| `packages/shared` | Shared protocol and types | Apache License 2.0 | [packages/shared/LICENSE](packages/shared/LICENSE) |
| `packages/web` | Mobile and web client | PolyForm Shield 1.0.0 | [packages/web/LICENSE.md](packages/web/LICENSE.md) |
| `packages/signaling` | Hosted relay (Cloudflare Worker) | PolyForm Shield 1.0.0 | [packages/signaling/LICENSE.md](packages/signaling/LICENSE.md) |
| `packages/macos` | Native Mac app | PolyForm Shield 1.0.0 | [packages/macos/LICENSE.md](packages/macos/LICENSE.md) |

Anything outside those directories, such as `scripts/`, `docs/`, `tests/`, `npm/` and the CI configuration under `.github/`, is licensed under the Apache License 2.0 unless a file states otherwise.
The Apache License 2.0 text is in [packages/daemon/LICENSE](packages/daemon/LICENSE).

## What the published packages contain

The `@yooz-labs/remi` npm packages ship the compiled `remi` binary.
It is built from `packages/daemon` and `packages/shared` only, plus third-party dependencies that keep their own licenses.
Nothing from `packages/web`, `packages/signaling` or `packages/macos` is compiled into it.
The npm packages are therefore licensed Apache-2.0 and carry the Apache `LICENSE` and `NOTICE` files.

## Contributing

A contribution is licensed under the license of the package it touches.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Questions

For commercial-use or dual-license inquiries about the PolyForm Shield parts: **dev@yooz.info**.
