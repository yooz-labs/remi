# Changelog

All notable changes to Remi are documented here.

## [Unreleased] (develop)

### Added
- Per-command help: `remi ls --help`, `remi kill --help`, etc. show subcommand-specific usage (#115)
- Deduplicate sessions from LAN and VPN IPs in `remi ls --network` (#110)

### Fixed
- `remi start` fails with EADDRINUSE when wrapper sessions are running (#114)
- Only retry WebSocket adapter on port conflict, not all adapters

## [0.4.4-dev.3] - 2026-03-20

### Fixed
- `remi start` daemon lifecycle: port probing, REMI_PORT env stripping, EADDRINUSE retry (#114)

## [0.4.4-dev.2] - 2026-03-20

### Added
- CLI help redesigned with grouped use cases (Quick Start, Remote Access, Session Management, Service, Identity & Auth) and subtle ANSI color (#101)
- NO_COLOR env var and non-TTY pipe detection for color suppression

### Fixed
- Session names no longer truncated at 26 chars; name column adapts to terminal width (#100)
- NO_COLOR test cleanup bug (was setting string "undefined" instead of removing env var)
- Added missing options to help text (--no-mdns, --no-tofu, --force, --max-bullet-length)

## [0.4.4-dev.1] - 2026-03-20

### Added
- Dev release workflow: `bump-version.sh dev` creates prerelease versions (0.4.4-dev.1)
- Release pipeline detects -dev tags: publishes to npm @dev, GitHub prerelease, skips Homebrew (#98)

## [0.4.3] - 2026-03-20

### Added
- Universal remote target resolver: `host:port/session` format works for attach, kill, and detach (#96)
- `remi new /path` treats positional path-like args as `--dir` shorthand
- `isPathLike()` detection for /, ~/, ./, ../, and bare `.`

### Fixed
- `remi kill host:port/session` now works (was sending create instead of kill) (#89)
- REMI_PORT env var respected for attach/kill/detach (was regression)
- `remi attach localhost:port` correctly uses specified port for auto-attach
- Dead code cleanup in target resolver (colonIdx null check)

## [0.4.2] - 2026-03-15

### Added
- Extracted arg parser into testable `parseArgs()` function with 93 unit tests (#87)
- Standard Unix `--` separator support for all subcommands
- Input validation: port range (1-65535), missing flag values, mutual exclusion
- Docker integration test infrastructure (2 daemon containers, 13 tests)
- `.dockerignore` to reduce Docker build context
- CI triggers on push/PR to develop branch

### Fixed
- `remi new --host X`, `remi new --dir /path`, `remi new --recent` now work (arg parser break bug) (#87)

## [0.4.1] - 2026-03-14

### Changed
- `remi ls --network` groups sessions by machine hostname instead of per-daemon headers (#85)
- PORT column replaces HOST column in grouped output
- Single-machine summary: "N session(s) on machine-name"
- Composite grouping key prevents merging different machines with same hostname

## [0.4.0] - 2026-03-14

### Added
- Session history protocol: `session_history_request`/`session_history_response` with `RecentDirectory` type (#83)
- `remi recent` command: browse recent project directories (local and remote)
- `remi new --host <ip>`: create session on remote daemon and auto-attach
- `remi new --dir <path>`: start session in specific directory
- `remi new --recent`: interactive directory picker from session history
- `remi kill <name>`: kill a session by name or ID
- `remi detach [name]`: detach from session (stub, Ctrl+B d for interactive)
- Web app: recent projects section in session list with start buttons
- `--dir` and `--recent` mutual exclusion with clear error
- Branch strategy documentation (main/develop/feature branches)

## [0.3.16] - 2026-03-14

### Fixed
- `remi ls --host` probes all ports and suppresses session-creation noise (#81)
