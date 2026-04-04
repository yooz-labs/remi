# AGENTS.md

This file provides guidance to coding agents working in this repository. It is derived from the repo-local [`CLAUDE.md`](/Users/yahya/Documents/git/yooz/remi/CLAUDE.md), the parent [`../CLAUDE.md`](/Users/yahya/Documents/git/yooz/CLAUDE.md), and the current project structure.

## Scope And Priority

- Prefer this file for repo-specific guidance.
- Use [`CLAUDE.md`](/Users/yahya/Documents/git/yooz/remi/CLAUDE.md) for Remi architecture and release details.
- Use [`../CLAUDE.md`](/Users/yahya/Documents/git/yooz/CLAUDE.md) for Yooz-wide standards unless this repo overrides them.
- Check [`/.context/plan.md`](/Users/yahya/Documents/git/yooz/remi/.context/plan.md) before starting non-trivial feature work.
- Review relevant files in [`/.rules/`](/Users/yahya/Documents/git/yooz/remi/.rules) before changing workflow, testing, CI, or documentation conventions.

## What This Repo Is

Remi is a cross-platform monitor for Claude Code sessions. It lets a user run agent sessions on a workstation and monitor or respond from a browser or mobile device.

Core workflows:

1. Session persistence and reattachment
2. Multi-machine discovery on the local network
3. Chat-style monitoring and response for Claude Code sessions

## Monorepo Structure

```text
remi/
├── packages/
│   ├── daemon/      # Bun + TypeScript backend and CLI
│   ├── shared/      # Shared protocol, crypto, identity, types
│   ├── signaling/   # Cloudflare Workers signaling/relay service
│   └── web/         # React + Vite + Capacitor client
├── tests/
│   ├── e2e/         # Playwright end-to-end tests
│   └── integration/ # Integration environment and scripts
├── scripts/         # Release/publish/install helpers
├── .context/        # Plan, research, ideas, scratch notes
└── .rules/          # Repo-specific standards
```

Important directories:

- [`packages/daemon/src`](/Users/yahya/Documents/git/yooz/remi/packages/daemon/src): CLI, PTY/session management, transcript parsing, adapters, auth, mDNS
- [`packages/shared/src`](/Users/yahya/Documents/git/yooz/remi/packages/shared/src): protocol and shared types consumed across packages
- [`packages/signaling/src`](/Users/yahya/Documents/git/yooz/remi/packages/signaling/src): Durable Object room logic and signaling utilities
- [`packages/web/src`](/Users/yahya/Documents/git/yooz/remi/packages/web/src): React client UI, connection flow, chat/session components, hooks, lib utilities
- [`tests/e2e`](/Users/yahya/Documents/git/yooz/remi/tests/e2e): browser-level flows
- [`tests/integration`](/Users/yahya/Documents/git/yooz/remi/tests/integration): integration setup scripts and Docker assets

## Primary Commands

Use Bun for JavaScript and TypeScript work.

```bash
# Install dependencies
bun install

# Root checks
bun test
bun run typecheck
bun run lint

# Main app entry points
bun run dev
bun run daemon

# Package-focused work
cd packages/daemon && bun test
cd packages/shared && bun test
cd packages/signaling && bun test
cd packages/web && bun run build

# End-to-end tests
bun run test:e2e
```

Useful build commands:

```bash
bun run build:binary
bun run build:all
```

## Architecture Notes

High-level flow:

1. Claude Code runs under the Remi daemon on the host machine.
2. The daemon manages PTY sessions, transcripts, questions, delivery state, and discovery.
3. Clients connect directly over WebSocket or through the signaling/relay service.
4. The web/mobile client renders sessions, transcript content, and question/answer flows.

Key files to understand first:

- [`packages/daemon/src/cli.ts`](/Users/yahya/Documents/git/yooz/remi/packages/daemon/src/cli.ts): CLI entry and wrapper mode
- [`packages/daemon/src/session/session-registry.ts`](/Users/yahya/Documents/git/yooz/remi/packages/daemon/src/session/session-registry.ts): session lifecycle
- [`packages/daemon/src/transcript`](/Users/yahya/Documents/git/yooz/remi/packages/daemon/src/transcript): transcript ingestion and parsing
- [`packages/daemon/src/mdns`](/Users/yahya/Documents/git/yooz/remi/packages/daemon/src/mdns): LAN discovery
- [`packages/signaling/src/connection-room.ts`](/Users/yahya/Documents/git/yooz/remi/packages/signaling/src/connection-room.ts): relay room state
- [`packages/web/src/App.tsx`](/Users/yahya/Documents/git/yooz/remi/packages/web/src/App.tsx): top-level client state and orchestration
- [`packages/web/src/lib`](/Users/yahya/Documents/git/yooz/remi/packages/web/src/lib): message routing, deduplication, signaling helpers

## Agent Working Rules

### Planning

- For non-trivial feature work, inspect [`/.context/plan.md`](/Users/yahya/Documents/git/yooz/remi/.context/plan.md) and update context files if the work materially changes the current plan.
- Document research in [`/.context/research.md`](/Users/yahya/Documents/git/yooz/remi/.context/research.md) when exploring new dependencies, patterns, or architecture.
- Update repo documentation when a change introduces a new convention or architectural pattern.

### Code Search And Editing

- Prefer fast targeted search (`rg`) over reading large files end-to-end.
- Start from the relevant package instead of scanning the whole repo.
- Follow existing patterns in the touched package; `daemon`, `web`, `shared`, and `signaling` have different concerns and dependencies.

### Testing

- Follow the strict no-mocks rule in [`/.rules/testing.md`](/Users/yahya/Documents/git/yooz/remi/.rules/testing.md).
- Use real implementations, real file system interactions, and real integration paths where feasible.
- If a real test environment is required and unavailable, say that clearly instead of inventing mocks.
- Run the narrowest meaningful tests for the changed area, then broader checks if the change crosses package boundaries.

### Style And Tooling

- Use Bun, not npm or yarn, unless Bun is genuinely blocked.
- TypeScript is strict; keep changes type-safe.
- Use Biome at the repo level for formatting/lint-style checks.
- Keep imports and exports consistent with surrounding code.

## Git And Release Workflow

Project-specific workflow overrides the generic parent rule here:

- Branch feature work from `develop`, not `main`.
- Never push directly to `main` or `develop`.
- Use short-lived branches such as `feature/*`, `fix/*`, `docs/*`, or `refactor/*`.
- Keep commits atomic and use commit messages like `feat: add session badge`.
- Do not edit version numbers manually for releases.
- Use [`scripts/bump-version.sh`](/Users/yahya/Documents/git/yooz/remi/scripts/bump-version.sh) for release version changes.

Release model:

- `develop` is the integration branch.
- `main` is the stable release branch.
- Promote stable work by merging `develop` into `main`.

## Package-Specific Guidance

### `packages/daemon`

- Treat this as the operational core: CLI behavior, PTY control, session lifecycle, auth, parsing, adapters, and discovery.
- Changes here often need tests because regressions impact persistence and remote control directly.
- Be careful with behavior around detach/reattach, transcript parsing, and question routing.

### `packages/shared`

- Keep protocol and types stable and explicit.
- Any protocol shape change likely affects daemon, web, and possibly signaling together.

### `packages/signaling`

- This is Cloudflare Workers code. Keep relay behavior simple and durable-object-safe.
- Validate protocol assumptions against both daemon and web clients before changing message flow.

### `packages/web`

- Preserve the established mobile/web client patterns unless intentionally redesigning.
- Build and smoke-test UI changes because this package has independent tooling from the Bun-only backend packages.
- Be mindful that Capacitor artifacts live under this package and may not need edits for ordinary UI work.

## Before Finishing

- Run relevant tests or checks for the touched area.
- Mention any unverified paths, especially if they require real network, mobile, or relay infrastructure.
- If architecture or workflow assumptions changed, update [`CLAUDE.md`](/Users/yahya/Documents/git/yooz/remi/CLAUDE.md), [`/.context/plan.md`](/Users/yahya/Documents/git/yooz/remi/.context/plan.md), or the relevant file in [`/.rules/`](/Users/yahya/Documents/git/yooz/remi/.rules).
