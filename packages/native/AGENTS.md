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
| `Remi.xcodeproj` | Checked-in project. Its groups are synchronized folders: a file added under `Mac/`, `iPhone/` or the package is in the target with no project edit. Xcode may offer to update it to the recommended settings when it opens it; accept that in a commit of its own. | Shared; edit target settings rarely, in a commit of their own |
| `RemiKit/Sources/RemiKit/` | Everything that is not a screen: protocol models, identity and auth, the connection, the multi-machine store | Mac track (#1241) |
| `RemiKit/Package.swift` | The package manifest: targets, resources, test targets | Whichever track needs a change, in a small commit of its own |
| `RemiKit/Sources/RemiUI/` | The design system: tokens, shared components (question card, session row, machine row, transcript entries, composer), preview data | iPhone track |
| `RemiKit/Tests/` | Swift Testing tests for the package | Whoever owns the code under test |
| `Mac/` | The Mac app target (`RemiMac`) | Mac track (#1243) |
| `iPhone/` | The iPhone app target (`RemiPhone`) | iPhone track (#1244) |
| `DESIGN.md` | The design brief | Both; change it in its own commit and say so in the PR |

When two agents run the tracks at the same time, each changes only its own paths.
To change something the other track owns, open a small pull request into `develop` for just that change and name the reason; do not reformat or restructure the other track's files.
Rebase on `develop` at least daily.

## Platform and constraints

The items marked #1233 are the owner's decisions; the rest were set with the scaffold (#1239).

- **Minimum OS (#1233):** macOS 26 and iOS 26. Use current SwiftUI and the current design language (Liquid Glass) freely.
- **Swift 6** with complete strict concurrency.
- **No third-party dependencies** without the owner's approval; Apple frameworks only.
- **The Mac app targets the App Store (#1233)** if the sandbox allows it. It is sandboxed with `network.client` only (`Mac/Remi.entitlements`). It is a client of hubs, local and remote, and never spawns agents, never reads `~/.remi`, never signals a process. Anything that needs the machine (creating a worktree, starting a session) is a request to the hub.
- **Bundle ids:** Debug builds are `live.yooz.remi.dev`, so they install beside the apps in use today; Release is `live.yooz.remi`. Team `9DQ459HAZB`, automatic signing.
- **Signing, TestFlight and App Store uploads are the owner's (#1233).** No agent holds Apple credentials. TestFlight builds go up by pushing the archive directly, as in transit and whisper.
- **The Capacitor iPhone app** (`packages/web/ios/App`) retires (#1233) once the native app has the same mechanics. Read it to learn what it does; do not change it.
- **Not set yet, decided when first needed:**
  - App Transport Security for `ws://` connections. The WebView app sets `NSAllowsLocalNetworking` for `ws://127.0.0.1` (`packages/macos/Remi/Info.plist`); check what the native apps need on their first live connection (Mac M2).
  - Export compliance (`ITSAppUsesNonExemptEncryption`): the owner's answer, at the first TestFlight upload.
- American English, no em dashes, no emojis, in code, comments, commits and docs.

## The protocol

- **Messages:** JSON over WebSocket, `ws://<host>:<port>/ws`, defined in `packages/shared/src/protocol.ts` (types in `packages/shared/src/types.ts`).
- **The oracle:** the golden fixtures in `packages/shared/tests/fixtures/protocol/`. A Swift model must decode them; that is necessary, not sufficient, because a fixture holds one instance of each shape. Check a model's fields against the TypeScript type as well: a field marked `?` there is optional in Swift. `RemiKitTests/FixtureConformanceTests.swift` shows the pattern: it reads the real files from the repository, so the fixtures cannot drift.
- **Not frozen yet.** The protocol freeze (#1234 to #1238) is in progress: a machine object, the Decision shape, workspaces and worktrees, versioning, fixtures for everything.
  - Build against today's wire.
  - When you need something the wire does not carry yet, put it behind a type in RemiKit with a comment naming the issue, and use what exists today in its place. For example, a machine is a hub's `host:port` until #1234.
  - Never invent a wire field. Propose it on the issue instead.
- **Versions and capabilities (#1237, ADR 0035):** every `hello_ack` carries `protocolVersion` (now 1) and `capabilities` (the first is `workspaces`, #1236). Mirror `PROTOCOL_VERSION` and `hubSupport` from `packages/shared/src/protocol-version.ts` in RemiKit and decide with them, never by comparing `daemonVersion`. An ack without the two fields is from an older remi (golden `hello_ack_legacy`): treat it as version 1 with no capabilities. When a machine lacks what a screen needs, show `hubSupport`'s message, which names the side to update.
- **Workspaces (#1236, ADR 0036):** a daemon's own session-list entry may carry `workspace` (repository, worktree directory, branch, null when detached); absent means unknown (not read yet, an older daemon, or not a repository), and the branch can be one list behind; `create_session_request.workspace` asks the hub to make a worktree on a new branch, and `recent_repositories_request` lists the repositories of its recent sessions (most recently used first, reaching back a week; a list cut short by the hub's deadline is not marked), once the hub lists the `workspaces` capability.
- **The decision object (#1235, ADR 0038):** a card is the `question` message.
  - `kind` is an open set: render one you do not know as a generic card (its `text` and `options`), never as Allow/Deny.
  - `answerPath` (`structured`, `keystroke`, `none`; absent is unknown) says how an answer applies. `keystroke` can be refused as stale; `none` takes no answer, but keep its Cancel, which clears the card and denies a held Claude request.
  - `question_resolved.resolvedBy` (`phone`, `lockscreen`, `terminal`, `harness`, `timeout`; absent is unknown, never inferred) feeds "resolved elsewhere". Label from it when present, from `reason` otherwise. `phone` means remi delivered that answer first, not that it decided; `harness` names what ended the prompt, not who caused it.
  - Decode an unknown value of either field as nil. Aligning the app is #1291.
- **Local hub:** a machine runs a hub on `127.0.0.1:18765` (the first free port of 18765 to 18784). Its `daemonPorts` lists the session daemons, one per session, each with its own port.
- **Auth:**
  - Unknown clients are challenged (`auth_challenge`, Ed25519). A new key stays pending until the person runs `remi authorize <fingerprint>` on that machine (#873), and the app should show that state plainly.
  - `packages/macos/Remi/ClientIdentity.swift` and `HubClient.swift` already do this exchange in Swift; port what is right, not what is convenient.
  - **Pairing by QR (#1275, ADR 0037):** the canonical `remi://pair#` payload has strict v1 and v2 envelopes. V1 remains the CLI default; `--qr-version 2` opts in to one to four direct candidates and does not change protocol version 1. Decode exactly as `packages/shared/src/pairing.ts` does and pass every shared vector in `packages/shared/tests/fixtures/pairing/vectors.json`, including refusals by their exact error. `PairingPayload.swift` exposes the decoded version and ordered `candidateEndpoints(pairingLabel:)`; `endpoint` remains its first candidate. Before signing, check the whole `auth_challenge.serverPublicKey` against the link key. Answer with the usual signed `auth_response` plus `pairingNonce` and `pairingLabel`; never put the nonce in the WebSocket URL. The machine holds the answer up to 20 s while the person decides: `PAIRING_PENDING` means retry on a fresh connection with the same nonce, `AUTH_STORE_ERROR` and `PENDING_QUEUE_FULL` mean retry later, success means approved, and the pairing-specific rejection errors end the attempt with their exact message. Native source preserves the entire scanner or pasted-code payload through `AddMachineRequest` to `MachineStore.beginPairing`. Its memory-only coordinator attempts one permitted candidate at a time, Local before Tailscale, with reachability-only fallback; approval/store/queue retries stay on that candidate. Pending candidates are not saved. Authenticated Hello admits the same socket after clearing nonce/label and rechecking the original profile lifetime and policy. Both roots follow the attempt UUID and admitted profile ID. Source controls cover this flow; compatible app distribution and signed phone acceptance remain pending.
  - V2 addresses are dial hints only. Attempt ordering is all Local candidates before Tailscale, stable within each layer; the full machine key pin and terminal fingerprint approval remain the trust check.
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
- **The gates build unsigned** (`CODE_SIGNING_ALLOWED=NO`), so they do not exercise the entitlements. To run the Mac app, or check its sandbox, without the team's certificate, sign it ad hoc: add `CODE_SIGN_IDENTITY=- CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM=` to the `xcodebuild` command. The Mac app it builds is sandboxed with `network.client` (`codesign -d --entitlements - <app>` shows it).
- **Previews must render.** They are the design review surface.
- **Known baseline failures** (check before blaming your change; remove an entry when it is fixed):
  - `PairingAttemptTests` (about 30 issues in `swift test --package-path packages/native/RemiKit`) fail locally on a clean `origin/develop` with `owned empty launch directory required` from `RemiKit/Tests/Integration/pairing-source-fixture.ts`: the fixture wants its launch directory empty. Reproduced 2026-10-21 on Xcode 27.1 with `bun install` done; cause not yet found. Run the rest with `--skip PairingAttemptTests` and say so in the PR.
- **Xcode 27.1 compiler traps** seen in this tree (fix by splitting, not by suppressing):
  - A large `body` can fail with `failed to produce diagnostic for expression`: split it into `@ViewBuilder private var` parts, and avoid optional closure ternaries such as `cond ? method : nil` as an argument (use a small computed property).
  - `ScrollView { ... }` can report `ambiguous use of 'init'` (the `showsIndicators:` and plain overloads) when its content is too complex for the checker; the same split fixes it.
  - `.environment(\.accessibilityReduceTransparency, true)` does not compile in previews (the key path is read-only); `#Preview` setup helpers that touch main-actor types need `@MainActor`.
- **CI runs on pull requests:** `Build and Test (Native)` (`.github/workflows/native-app.yml`, an Xcode 27 runner, about 9 minutes; it is the only place the Mac `xcodebuild test` is known to run, because it cannot launch in some agent sandboxes) and `Spelling` (`crate-ci/typos` over the whole repository, config in `_typos.toml`). Run `typos` locally before opening a PR (`brew install typos-cli`), and still run the commands above; the PR says what passed and what could not run.
- **Running a hub for development** from the repository root: `bun install`, then `REMI_HOME=/tmp/remi-dev bun packages/daemon/src/cli.ts serve`. The Mac app and the iPhone simulator reach it on `127.0.0.1`. The app's first connection waits for approval (#873): `REMI_HOME=/tmp/remi-dev bun packages/daemon/src/cli.ts keys` lists its key as pending, and `REMI_HOME=/tmp/remi-dev bun packages/daemon/src/cli.ts authorize <fingerprint> --label dev` approves it.

## Git

- **Branches:** one per milestone, off `develop`, named `feature/issue-<number>-<short-name>` (for example `feature/issue-1244-remiui-tokens`). There is no epic branch.
- **Pull requests** go into `develop`, never into `main`. Never push to `develop` or `main` directly.
- **Worktrees live on `/Volumes/S1/worktrees/remi/`, never in the git folder** (builds and `node_modules` fill the home disk fast). Worktrees are optional: an agent that wants one creates it there (`git worktree add /Volumes/S1/worktrees/remi/<name> -b <branch> <base>`) and removes it once its branch is merged. `git worktree move` cannot cross devices, so to relocate one, save any uncommitted diff, `git worktree remove` it, and `git worktree add` the same branch on S1. (`../remi-worktrees/` is where hubs will create session worktrees, #1236; agents do not use it.)
- **Keep build output off the home disk.** Xcode writes DerivedData under `~/Library/Developer/Xcode/DerivedData` by default (about 400 to 600 MB per worktree). For worktree builds pass `-derivedDataPath /Volumes/S1/derived/remi-<worktree-name>` to every `xcodebuild`, and build the package from the worktree (its `.build` stays inside it).
- **Clean up when a branch merges.** Remove the worktree (`git worktree remove`), delete the local branch, delete that worktree's DerivedData folder (`/Volumes/S1/derived/remi-<name>`, or the `Remi-*` folder under the default location whose `info.plist` `WorkspacePath` is the removed worktree), and delete scratch files under `/tmp` (verification screenshots can contain session text, so they go first). Only delete what your own work created; other worktrees and their build folders belong to other work.
- **The dev app must never talk to a real hub.** The Add a machine sheet defaults to port 18765, which is the owner's real hub on this machine; adding it from a simulator creates a pending authorization request there. When verifying in a simulator, use your own hubs on other ports (for example 18790 and up with a throwaway `REMI_HOME`), and check the port field before every Add machine tap.
- **Branch from a fresh `origin/develop`.** Run `git fetch` first: a checkout's local `develop` can be far behind (it was 124 commits behind once, and the plan, the build errors and the baseline were all from stale code). Check `git rev-list --count develop..origin/develop`, then base the branch on `origin/develop`.
- **Run `bun install` once in a new checkout or worktree.** The git hooks (lefthook with Biome) run from its `node_modules`; without it, a commit that stages TypeScript or JSON fails the hook.
- **Commits:**
  - atomic: one logical change each;
  - message: subject under 50 characters, imperative, with the issue number;
  - a test that pins a behavior is committed before the change that satisfies it, where that applies.
- **No AI attribution** in commits or PRs (no `Co-Authored-By` lines).
- **In each PR,** say what was verified and how. A screenshot of the previews helps the design review.
