# Handoff: the Mac app (Mac track)

You design and build remi's native Mac app, and you own RemiKit's core (the code both apps share that is not a screen).
The iPhone track ([ios.md](ios.md)) builds the iPhone app and owns RemiUI, the design system; start from [README.md](README.md), which says how the tracks are run and in what order.

- **Issues:** #1243 (the Mac app), #1241 (RemiKit core), under the epic #1239.
- **Project:** `packages/native/Remi.xcodeproj`, scheme `RemiMac`.
- **Branches and pull requests:** one branch per milestone off `develop`, pull requests into `develop` ([../AGENTS.md](../AGENTS.md#git)).

## What you own

- `packages/native/Mac/`: the `RemiMac` target.
- `packages/native/RemiKit/Sources/RemiKit/`:
  - protocol models;
  - identity and auth;
  - the connection: WebSocket, reconnect, the `auth_challenge` exchange;
  - the store that holds many machines and their sessions at once.

The iPhone track consumes RemiKit; keep its public API small, documented and stable, and say in each PR what changed in it.

## Milestones

**M1: design pass, with preview data only (no networking).**
- [ ] **The three-column window:**
  - machines and repositories;
  - sessions (status, harness, worktree or branch, open-card badge);
  - the session view (transcript, inline cards, composer).
- [ ] **Screens and sheets:** the new-session sheet (machine, repository, worktree, harness, model), the menu bar extra (cards that need the person), and the empty and first-run states.
- [ ] **RemiUI components:** use them as the iPhone track publishes them. Where one is missing, build a Mac-only view in `Mac/` and replace it later, rather than writing into RemiUI.
- [ ] **Previews:** every screen has previews in light and dark mode, at a large Dynamic Type size, and in the "machine unreachable" and "waiting for approval" states.
- **Done when** the previews render and the owner has reviewed screenshots in the PR.

**M2: RemiKit core (#1241).**
- [ ] **Codable models** for every message the Mac app sends or reads, each decoding its golden fixture. Extend `FixtureConformanceTests`, or add files beside it.
- [ ] **Identity:** an Ed25519 device key in the Keychain, and the `auth_challenge` / `auth_response` exchange, including the pending state for an unknown key (#873). The person approves the key with `remi authorize <fingerprint>` on the machine. Learn from `packages/macos/Remi/ClientIdentity.swift` and `HubClient.swift`.
- [ ] **The connection:** WebSocket with reconnect and backoff, `hello` / `hello_ack`, the session list, joining the session daemons in `daemonPorts`, questions and answers, transcript loading.
- [ ] **The store:** observable state for N machines at once. Identify a machine by its hub's `host:port` until the machine object lands (#1234), behind a type that can change.
- **Done when** a test connects to a real hub started from source, gets approved, lists its sessions and answers a card. No mocks: the hub is real. The fixtures pass, and the iPhone track can build against the API.

**M3: the Mac app, live.**
- [ ] **The window works on real hubs:** wire it to the store, for the local hub on `127.0.0.1` and one other machine over a direct connection.
- [ ] **Cards answered by their meaning, following the daemon's rules:**
  - a held card is answered through the hook;
  - a `terminalOnly` card has no controls;
  - `PROMPT_WAITING` refuses chat while a prompt is up.
- [ ] **Native notifications** for cards, and the menu bar extra live.
- [ ] **New session:** creating a session through the hub (`create_session_request`). Worktree creation waits for #1236; until then the sheet takes a directory.
- **Done when** the owner can use it for a day on two machines instead of the WebView window.

## Out of scope for now

- **Relay v2 and its Swift port** (#1242, X2): not until the owner starts it.
- **Diffs, files and a terminal view:** X5 (#1245).
- **Changing the daemon or the protocol:** propose it on the protocol-freeze issues (#1234 to #1238) instead.
- **The existing WebView Mac app** in `packages/macos`: read it, do not change it.
