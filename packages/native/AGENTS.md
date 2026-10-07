# Native apps: agent instructions

The native SwiftUI apps for remi: a Mac app that works like Conductor (many agent sessions across machines and worktrees, one window) and an iPhone app.
Codex builds them in Xcode, starting from [handoff/README.md](handoff/README.md).
The work has two tracks, the Mac app ([handoff/mac.md](handoff/mac.md)) and the iPhone app ([handoff/ios.md](handoff/ios.md)): one agent can take them in turn, or two agents can run them at the same time.

Everything in the root [AGENTS.md](../../AGENTS.md) applies here too.
The parts you need most:
- "Verify before you describe": a doc or comment that claims more than the code does is a bug. Say what ships, not what was intended.
- "Question Detection and Notifications": what a card means and how it is answered.
- "Transport Options": how clients reach a machine today.

The roadmap is [`.context/plan.md`](../../.context/plan.md); the native scope is [`.context/native-apps-plan-2026-10.md`](../../.context/native-apps-plan-2026-10.md); the epic is #1239.

## Layout and ownership

| Path | What it is | Owner |
|---|---|---|
| `Remi.xcodeproj` | Checked-in project. Its groups are synchronized folders: a file added under `Mac/`, `iPhone/` or the package is in the target with no project edit. | Shared; edit target settings rarely, in a commit of their own |
| `RemiKit/Sources/RemiKit/` | Everything that is not a screen: protocol models, identity and auth, the connection, the multi-machine store | Mac track (#1241) |
| `RemiKit/Sources/RemiUI/` | The design system: tokens, shared components (question card, session row, transcript entries, composer), preview data | iPhone track |
| `RemiKit/Tests/` | Swift Testing tests for the package | Whoever owns the code under test |
| `Mac/` | The Mac app target (`RemiMac`) | Mac track (#1243) |
| `iPhone/` | The iPhone app target (`RemiPhone`) | iPhone track (#1244) |
| `DESIGN.md` | The design brief | Both; change it in its own commit and say so in the PR |

When two agents run the tracks at the same time, each changes only its own paths.
To change something the other track owns, open a small pull request into `develop` for just that change and name the reason; do not reformat or restructure the other track's files.
Rebase on `develop` at least daily.

## Platform and constraints (owner decisions, #1233)

- **Minimum OS:** macOS 26 and iOS 26. Use current SwiftUI and the current design language (Liquid Glass) freely.
- **Swift 6** with complete strict concurrency.
- **No third-party dependencies** without the owner's approval; Apple frameworks only.
- **The Mac app targets the App Store** if the sandbox allows it. It is sandboxed with `network.client` only (`Mac/Remi.entitlements`). It is a client of hubs, local and remote, and never spawns agents, never reads `~/.remi`, never signals a process. Anything that needs the machine (creating a worktree, starting a session) is a request to the hub.
- **Bundle ids:** Debug builds are `live.yooz.remi.dev`, so they install beside the apps in use today; Release is `live.yooz.remi`. Team `9DQ459HAZB`, automatic signing.
- **Signing, TestFlight and App Store uploads are the owner's.** No agent holds Apple credentials. TestFlight builds go up by pushing the archive directly, as in transit and whisper.
- **The Capacitor iPhone app** (`packages/web/ios/App`) retires once the native app has the same mechanics. Read it to learn what it does; do not change it.
- American English, no em dashes, no emojis, in code, comments, commits and docs.

## The protocol

- **Messages:** JSON over WebSocket, `ws://<host>:<port>/ws`, defined in `packages/shared/src/protocol.ts` (types in `packages/shared/src/types.ts`).
- **The oracle:** the golden fixtures in `packages/shared/tests/fixtures/protocol/`. A Swift model is right when it decodes them. `RemiKitTests/FixtureConformanceTests.swift` shows the pattern: it reads the real files from the repository, so it cannot drift.
- **Not frozen yet.** The protocol freeze (#1234 to #1238) is in progress: a machine object, the Decision shape, workspaces and worktrees, versioning, fixtures for everything.
  - Build against today's wire.
  - When you need something the wire does not carry yet, put it behind a type in RemiKit with a comment naming the issue, and use what exists today in its place. For example, a machine is a hub's `host:port` until #1234.
  - Never invent a wire field. Propose it on the issue instead.
- **Local hub:** a machine runs a hub on `127.0.0.1:18765` (the first free port of 18765 to 18784). Its `daemonPorts` lists the session daemons, one per session, each with its own port.
- **Auth:**
  - Unknown clients are challenged (`auth_challenge`, Ed25519). A new key stays pending until the person runs `remi authorize <fingerprint>` on that machine (#873), and the app should show that state plainly.
  - `packages/macos/Remi/ClientIdentity.swift` and `HubClient.swift` already do this exchange in Swift; port what is right, not what is convenient.
- **Relay v2** (reaching a machine from anywhere, end-to-end encrypted) is on the relay epic branch, not on develop. Its Swift port is phase X2 (#1242), and nobody starts it before the owner says so.

## Security

- **Keys:** device keys live in the Keychain, never in files or `UserDefaults`.
- **No secrets anywhere visible:** no credentials, tokens or keys in code, logs, previews, fixtures or commits.
- **Escape text another party chose:** text from a machine (a command, a path, an agent's message) can hold control or bidirectional characters. Show it escaped where it could mislead (see `escapeUnsafeText` in `packages/shared/src/display-text.ts`).
- **Cards follow the daemon's rules** (root AGENTS.md):
  - an option is answered by its meaning;
  - a `terminalOnly` card has no answer controls;
  - a standing grant says it lasts "for this session";
  - a card with `detail` is answered in the app, never from a lock-screen button.
- **Crypto and identity code gets a security review** in this repository before it merges.

## Tests and gates

- **Swift Testing** (`import Testing`) for new tests.
- **No mocks that replace business logic.** Test against the real fixtures, a real hub started from source, or real objects.
- **Preview data comes from the fixtures:** hand-written sample data must not claim shapes the wire does not have.
- **Before every PR**, all of these pass:
  - `swift test --package-path packages/native/RemiKit`
  - `xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' CODE_SIGNING_ALLOWED=NO build test`
  - `xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiPhone -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build`
- **Previews must render.** They are the design review surface.
- **There is no CI job for the native apps yet.** It needs a macOS 26 runner (#1240); until then the commands above are the gate, and the PR says they passed.
- **Running a hub for development** from the repository root: `bun install`, then `REMI_HOME=/tmp/remi-dev bun packages/daemon/src/cli.ts serve`. The Mac app and the iPhone simulator reach it on `127.0.0.1`.

## Git

- **Branches:** one per milestone, off `develop`, named `feature/issue-<number>-<short-name>` (for example `feature/issue-1244-remiui-tokens`). There is no epic branch.
- **Pull requests** go into `develop`, never into `main`. Never push to `develop` or `main` directly.
- **Worktrees are optional.** An agent that wants one creates it next to the repository, under `../remi-worktrees/` from the repository root, and removes it once its branch is merged.
- **Run `bun install` once in a new checkout or worktree.** The git hooks (lefthook with Biome) run from its `node_modules`; without it, a commit that stages TypeScript or JSON fails the hook.
- **Commits:**
  - atomic: one logical change each;
  - message: subject under 50 characters, imperative, with the issue number;
  - a test that pins a behavior is committed before the change that satisfies it, where that applies.
- **No AI attribution** in commits or PRs (no `Co-Authored-By` lines).
- **In each PR,** say what was verified and how. A screenshot of the previews helps the design review.
