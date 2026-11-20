# Mac app hub control (#1805): requirements spec and phased plan

Lead spec and plan, 2026-11-17, for #1805 (part of #1157; native epic #1239).
Inputs: [research-a-feasibility.md](research-a-feasibility.md), [research-b-status-icon.md](research-b-status-icon.md), [icon-concepts/sheet.svg](icon-concepts/sheet.svg).
Base: `origin/develop` at `52ee818e` (0.9.1-dev.5); the keep-awake level 2 plan at `865457b2` (branch `docs/issue-1773-awake-level2-plan`, read only).
Status: proposed. Nothing is built before the owner approves (#1805, "Process"); the questions are in section 7.
Evidence marks: CHECKED, read by the lead at `52ee818e` (or the commit named); RESEARCH, taken from a research report, not re-read; UNVERIFIED, checked nowhere.
Amended the same day after the owner's note that the settings UI follows the VS Code model with `config.toml` as the file: D4 is rebuilt around a settings registry (D4.1, D4.2, D4.10 to D4.12), MH6 is split into MH6a to MH6c, and Q10 and Q11 are new.
Section numbers: "D4.n" is a part of decision D4; a bare "4.n" is a part of section 4 (the icon).

## 1. Goals, non-goals and the principle

**Principle.** The Mac app is a client of the hub.
The hub decides and validates; the app asks, shows and explains.
remi never reads, stores or relays a credential (ADR 0049 D10), and the app reaches the machine only through the hub (ADR 0051 F8), except for the narrow paths in D1 (b) and D4 that the owner must approve and section 3.5 writes into the rules.
Loopback is not identity (#873): the hub cannot tell this Mac's app from a phone, so nothing here trusts a connection because it is local.

| Goal | Owner ask | Done when |
|---|---|---|
| G1 | 1, monitor | The app shows, without a terminal, whether a hub runs on this Mac, its version, whether it is set to start at login, whether this app is approved, and the next step in words, for a hub started by anything (terminal, LaunchAgent, another app). |
| G2 | 1, start | Starting a hub costs one copy and paste now (D1 (a)); one click later only if the owner picks D1 (b). |
| G3 | 2, settings | A VS Code-style settings page, rendered from the hub's settings registry, reads and changes keep-awake and display settings, validated by the hub, with "applies to new sessions" or "applies after a hub restart" per key; a config file is created when none exists; a new key needs no app change. |
| G4 | 3, icon | The menu bar icon shows needs-you plus this Mac's keep-awake state (level 1 holding; level 2 armed, active, paused (waiting), disarmed), legible at 18 pt in light and dark, by shape and words, never color alone, with VoiceOver sentences. |
| G5 | 3, safety | Level 2 being active never depends on the menu bar alone: a notification, the Dock menu and the main window say it too. |

Non-goals:
- No hub inside the app bundle, no bundled `remi`, no launch agent registered by the app (D1 (d)).
- No read or write of `~/.remi` by the app: no temporary-exception entitlement, no user-picked `config.toml` (research A, options F and G), no read of the status file or the capability token.
- No app write of `[profiles.*]`, `auth`, `daemon`, `network`, `telegram`, `harness`, `notifications`, `prompts`, `features`, `terminal`, nor of `awake.level2`, `allow_phone`, `require_password_on_wake`, `foreign_holder_ignore`, `watchdog_interval_seconds`.
- No `sudo`, sudoers or LaunchDaemon step from the app (ADR 0050); no approval or policy keys (ADR 0030); keep-awake is not a `question` (ADR 0038).
- No self-approval of the app's key.
- No repository (workspace) scope of settings: a repository is untrusted content, and a cloned repository must not change keep-awake (a prompt-injection path); it would need its own ADR.
- Developer ID distribution (D1 (c)) is not planned here; if the owner picks it, it gets its own plan.
- Other machines' keep-awake in the icon (the menu lists them later).

## 2. What the plan rests on

New facts the research did not have (all CHECKED at `52ee818e` unless marked):

| # | Fact | Evidence | Used by |
|---|---|---|---|
| N1 | A hub status message already exists: `hub_status` (`localClients`, `remoteClients`, `sessions`, `hubVersion`, `pendingQuestions`, `questions`, `autostart`), sent after `hello_ack` and broadcast on change, hub only. The native app does not decode it. | `packages/shared/src/protocol.ts:1572-1613`, direction `:421`; `cli.ts:2518-2536`; `cli/hub-client-tracker.ts:1-115`; native `RemiKitTests/RelaySourceIntegrationTests.swift:278` expects `.unsupported(type: "hub_status")` | MH1, MH4 |
| N2 | `GET /auth-info` answers `{authRequired, fingerprint}` with no authentication and registers no key; the WebView Mac app already probes it on 18765 to 18784. This replaces research A's `auth_challenge` spike. | `server/websocket-server.ts:455-472`; `packages/macos/Remi/HubClient.swift:5-12, 351-360` | D2, MH1 |
| N3 | The native Mac app already accepts a pasted `remi://pair#` link; `PARITY.md:11` still says Mac "No" (doc drift). | `Mac/MacLiveRootView.swift:420, 2183-2185` | D3, MH1 |
| N4 | WebView precedent: commands `brew install yooz-labs/tap/remi`, `remi start`, `remi --install`; autostart shown from `hub_status`; an icon reducer. | `packages/macos/Remi/HubSetupCommands.swift:9-13`, `SettingsView.swift:5-16`, `IconState.swift:21-36` | MH1, MH2 |
| N5 | Config is loaded once per process at start (exit 1 on error); session daemons are separate detached processes with their own load, so `[awake]` level 1 (through `AwakeWiring`) and `display.max_bullet_length` apply to sessions started after a change, hub-owned keys after a hub restart. `remi reload` only validates. | `cli.ts:395-402, 1129, 1186-1188, 3704-3714`; `cli/daemon-manager.ts:598-645` | D4.6 |
| N6 | The awake plan's Mac-side control is `POST /local-keep-awake`, gated by the local capability token over loopback, the gate of `/local-secure-push`. The token lives in the remi home, so the sandboxed app cannot use it; its level 2 actions can only be L2-APP's wire messages. | awake `cards/L2-HUB-config-and-hub.md:23, 54` (`865457b2`); `websocket-server.ts:343-354`; `server/peer-helpers.ts:42-53` | 4.4, MH8 |
| N7 | The level 2 states changed today: `disabled, disarmed, armed, paused, starting, on, reverting`; `c7ab6f51` had no `paused` (a refusal was `armed` plus `lastRefusal`). Owner questions Q12 to Q14 there are open. | awake `cards/L2-POL-level2-policy.md:75`, `plan.md:13, 267-299` (`865457b2`) | 4.3 |
| N8 | The hub lists only `workspaces` today; the capability registry holds seven names. | `packages/daemon/src/cli/capabilities.ts:18`; `packages/shared/src/protocol-version.ts:35-48` | MH4, MH6b |
| N9 | The next free ADR number is 0052 (none from 0052 up on any remote branch). | `git ls-tree` of every remote branch | MH3 |
| N10 | `remi stop` without `--all` stops the hub only (inferred from the `--all` flag; not run). | `cli.ts:486`; `daemon-manager.ts:368-420` | D4.7 (MH6b verifies) |
| N11 | `parseConfigText` already validates text through the file-load path and hides a TOML syntax error's text; `remi config show` masks `bot_token`; only `[harness]` and `[awake]` refuse unknown keys (`[display]` merges and ignores them). | `config.ts:420-438, 1005` | D4.5, D4.10 |

Research claims re-checked (CHECKED): entitlements `Mac/Remi.entitlements:5-21` (sandbox, `network.client`, app group, keychain groups, push); `MenuBarExtra` `.window` and the `Settings` scene `Mac/RemiMacApp.swift:33-53`; `RemiMenuBarStatus` `RemiUI/MenuBarStatus.swift:7-29`; template icon `RemiUI/MenuBarIcon.swift:16-44`; label sets only `.accessibilityLabel` `Mac/MacNotificationCoordinator.swift:300`; `Mac/MacFirstRunView.swift:11-20`; `MachineConnectionStatus` `RemiKit/Store/MachineStore.swift:133-139`; Bonjour re-finds saved machines only `Discovery/LocalMachineDiscovery.swift:98-113`; default bind `config/config.ts:240`; an unknown `[awake]` key throws `config.ts:458-478`; ranges `:480-498`; `telegram.bot_token` `:183-188`; parse only with `smol-toml` `:11`; `initConfigFile` `wx`, 0600 `:918-933`; template `:805-829`; `REMI_MAX_BULLET_LENGTH` override `:731-737`; no `config_*`, `keep_awake` or `awake` string in `packages/shared/src` and none of the first two in `packages/daemon/src` (`git grep`, zero hits); `packages/native/AGENTS.md:39, 64, 66, 94, 104, 114`; ADR 0051 F8 `:62-64`, A1 `:147-155`, Q1 `:626-627`; ADR 0050 hub owns level 2 `:92`, item 5 `:98`, slice 4 `:146`, keys `:160-185`; ADR 0049 D10 `:354`; ADR 0035 items 2 to 5 `:26-45`.
Apple platform facts (sandbox, `NSUserUnixTask`, `SMAppService`, App Review 2.4.5, HIG menu bar, template images): RESEARCH (A section 4, B section 3), not re-read.

## 3. Decisions

### D1. How the app starts the hub

| Option | What happens | Sandbox | App Review | Security | Effort |
|---|---|---|---|---|---|
| (a) Commands-only first-run card | The app shows `brew install yooz-labs/tap/remi`, `remi start`, `remi --install`, each with Copy, and Check again (N4). | nothing new | none | smallest: the person runs every command | S, in MH1 |
| (b) Fixed-verb script through `NSUserUnixTask` | The app offers a script; the person saves it into `~/Library/Application Scripts/<bundle id>` (the app may read, not write, there); the app runs it with one verb. | nothing new; the script runs as the user outside the sandbox | medium: 2.4.5(iii) (the hub outlives the app); the API is for user-supplied scripts, so the app offers text and the person installs it; acceptance UNVERIFIED | verbs `start` and `restart` only; an absolute `remi` path fixed at save; no argument or environment passthrough; the app refuses a script whose bytes differ from the text it offered | M, MH9 |
| (c) Developer ID, not sandboxed | `Process` runs `remi start`; the app can read what the user reads. | sandbox optional; notarization; push and app group under a Developer ID profile UNVERIFIED | none, but no TestFlight and an updater dependency | largest: the app could read the token in `config.toml` | L, own plan |
| (d) Launchd-registered helper (`SMAppService.agent`) | A plist in the bundle runs a helper at login. | a bundled helper must be sandboxed (validation error 90296, RESEARCH A), so it cannot reach `~/.claude`, repositories or `~/.remi`; a plist running `/opt/homebrew/bin/remi` is UNVERIFIED | high: 2.4.5(ii), (iii) | a second owner of the hub beside `remi --install` | L |

Recommendation: (a) now, in MH1; (b) only if the owner, after using (a), wants a Start button inside the App Store build (Q1), as MH9, last; (c) only as a deliberate, separate decision; (d) rejected.
Restart uses the same mechanism: (a) shows the hub-written command (D4.7), (b) runs the `restart` verb.

### D2. How the app finds and attaches to a hub started earlier

| Option | Finds a hub started by anything? | Verdict |
|---|---|---|
| (a) Probe `GET /auth-info` on `127.0.0.1` | Yes, for a hub bound to loopback or all interfaces; no authentication, no pending key (N2). | adopt (MH1) |
| (b) The status file, through the hub | The file is out of reach; its facts (`hubVersion`, `sessions`, `pendingQuestions`, `autostart`) already arrive in `hub_status` once connected (N1). | adopt: decode `hub_status` (MH1) |
| (c) mDNS | Not advertised on the default loopback bind; discovery today only re-finds saved machines. | remote machines only |

Probe rules (MH1):
1. Range: Release 18765 to 18784 (`packages/native/AGENTS.md:64`); Debug builds and tests 18790 to 18799, a build setting pinned by a test, so a dev build never reaches the owner's hub (`AGENTS.md:114`).
2. Cadence: at launch, when the menu or the first-run view opens, and every 30 s while either is visible; nothing in the background (lead choice).
3. A probe never opens a WebSocket. A connection starts only from a saved machine or the person's "Add this Mac".
4. Match by fingerprint, not port: a saved `127.0.0.1` machine on a moved port is the same machine; a different fingerprint on a saved port is a different hub (another `REMI_HOME`, a reinstall), shown as such and never re-pinned silently.
5. `/auth-info` does not say hub or session daemon: the app names the lowest responder "Remi on this Mac" and confirms "hub" after approval from `hello_ack.sessionId == nil` (the WebView rule, `HubClient.swift:14-19`); MH4 may add an optional `role` to `/auth-info` (absent is unknown).
6. Plain HTTP only. A hub that answers only over signed direct TLS (ADR 0045), or binds only a LAN address, is not found as "This Mac"; PARITY.md states both limits, and the person adds it by address.

This Mac card (main window first run, the menu's This Mac section, Settings):

| State | Title | Detail | Action |
|---|---|---|---|
| no hub answers | "Remi isn't running on this Mac" | the three commands of D1 (a) with Copy | Check again |
| a hub answers, not saved | "Remi is running on this Mac" | port, short fingerprint | Add this Mac |
| saved, approval pending | "Waiting for approval on this Mac" | D3's command, or `remi pair` and paste | Check again |
| connected | "This Mac, remi <hubVersion>" | "Set to start at login" (`autostart: installed`, file presence only), "Runs until you log out; to keep it running: `remi --install`" (`none`), nothing when absent | Open |
| version or capability mismatch | `hubSupport` title | `hubSupport`'s message, naming the side to update | none |
| fingerprint changed | "A different Remi hub answers on this Mac" | old and new short fingerprints | Add as a new machine |

### D3. The first connection and its approval (#873)

What the app shows: "Waiting for approval on this Mac", the app's own fingerprint (short, full on Copy), the exact command `remi authorize <full fingerprint> --label "Remi for Mac"` with Copy, `remi keys` to list pending keys, Check again (`MachineStore.retryApproval`, `MachineStore.swift:1766`), and the alternative "run `remi pair` and paste the link here" (N3), which pins the hub's key and still asks the terminal to confirm (ADR 0037).
What the app must never do:
- approve its own key by any path: it never reads the capability token or the authorized-keys store, never runs `remi authorize`, `keys` or `pair`, and none of them is a script verb (D1 (b));
- suggest `--no-auth`, `auth.enabled = false`, a wider `bind`, or `tailscale serve` (root AGENTS.md, "Transport Options");
- show "connected" or trusted before `auth_result` succeeds (DESIGN.md principle 3);
- connect by itself to an unsaved local hub (each attempt adds a pending key, up to `PENDING_QUEUE_FULL`);
- retry approval faster than the store's existing backoff; Check again is the person's.
A hub with authentication off is shown with "This hub does not check devices" in the warning style, and refuses every settings write (D4.4).

### D4. The Settings design

**D4.1 The model: VS Code's settings editor, with `config.toml` as the file (owner, 2026-11-17).**
A settings registry in the daemon is the single source of truth for every setting a device may see; the hub serves it, with each setting's current and default value, through the `config` capability; the app renders the page from it, so a new key needs a registry entry and no app change.
The raw file stays the person's (D4.10).
Place: the Settings scene (`RemiMacApp.swift:44-53`) gains a "This Mac" tab: the hub facts of D2, then the registry's groups; the wire allows any machine, and the tab serves This Mac first.

**D4.2 The settings registry** (`packages/daemon/src/config/settings-registry.ts`, MH6a). One entry per key:

| Field | Meaning |
|---|---|
| `key`, `table` | TOML path (`awake.question_hold_minutes`); `table` is its first segment |
| `title`, `description` | a short title and one or two plain sentences, English (today's template comments, `config.ts:814-829`, are the first source) |
| `group`, `order` | the page section ("Keep awake", "Lid-closed mode", "Display") and the position in it |
| `type` | `boolean`, `integer`, `number`, `enum`, `string`, `stringList` |
| `default` | read from `DEFAULT_CONFIG`, never a second literal |
| `min`, `max`, `unit` | sanity bounds only (the validator's own constants, `AWAKE_MAX_*`, `config.ts:78-81`); units seconds, minutes, hours, percent, characters |
| `options` | for `enum`: each value and its label |
| `appliesAt` | `new-session`, `hub-restart` or `install` |
| `access` | required, no default: `app` (a granted device may write), `app-after-gate` (shown read only until Q4 and OG-L2 flip it to `app`), `terminal` (shown read only, with the step), `hidden` (never sent) |
| `platform` | `macos` or all |

Registry rules:
- The loader's supported-key set and range checks for `[awake]` and `[display]` come from the registry (one code path), and the generated template's two tables are written from it (titles and descriptions as comments), so loader, template, page and docs cannot disagree.
- Every numeric limit of the keep-awake plan is a setting with a default (the owner's rule of 2026-11-17, the 3 h run limit included; the awake lead is auditing the cards), so each lands as a registry entry with its slice: G2 and L2-HUB add entries, not validator code (CO-1 item 7).
- Drift test (MH6a), against the real loader through `parseConfigText` (`config.ts:420`): every default equals `DEFAULT_CONFIG`; the generated template loads to exactly `DEFAULT_CONFIG`; each numeric key loads at `min` and `max` and is refused at `min - 1` and `max + 1`; each enum option loads and a non-option is refused; a wrong type is refused; the served set is every entry whose `access` is not `hidden`.
- Only registry tables are served; `telegram`, `auth`, `daemon`, `network`, `harness`, `[profiles.*]` and every other table have no entry and never leave the machine.
- `terminal` for `awake.level2`, `allow_phone`, `require_password_on_wake`, `foreign_holder_ignore`, `watchdog_interval_seconds`, because each widens what devices may do (`allow_phone`), arms the behavior `allow_phone` exists to gate (`level2`), lowers a rail the owner required (`require_password_on_wake`), names processes the phone must not edit (`foreign_holder_ignore`, ADR 0050 `:121`) or applies only at install; deny by default (the #1063 lesson: fail closed rather than a denylist).

| Entries now (more arrive with their slices) | Group | Access | Applies |
|---|---|---|---|
| `awake.level1`, `question_hold_minutes`, `idle_grace_seconds`, `stuck_busy_minutes`, `ttl_minutes`; then `level1_battery_floor_percent` (#1773 G2) | Keep awake | app | new session |
| `display.max_bullet_length` | Display | app | new session |
| level 2 tunables (battery start and revert, minimum remaining, run limit and daily cap, idle revert, thermal, resume bounds) | Lid-closed mode | app-after-gate (Q4) | hub restart |
| the five `terminal` keys above | Lid-closed mode | terminal | hub restart, install |

**D4.3 Wire (ADR 0035).** Capability `config`, registry text "change keep-awake and display settings on this machine"; the hub lists it, session daemons do not and answer `UNSUPPORTED`.

| Message | Dir | Fields |
|---|---|---|
| `config_read_request` | c2d | `id` |
| `config_read_response` | d2c | `requestId`; `file: {exists, valid, error?}` (escaped, cut to 200 code points, the path shown as `config.toml`); `displayPath` (home-relative, `~/.remi/config.toml`, never a user name); `revision` (opaque hash of the bytes); `settings[]`: the D4.2 fields plus `value`, `setInFile`, `modified` (value differs from default), `writable` (access and this connection's grant), `overriddenBy?` (environment or flag), `running?` (the hub's loaded value); `unknownKeys[]` (names only); `pendingRestart`; `restartCommand`; `canWrite` |
| `config_write_request` | c2d | `id`, `revision`, `dryRun?`, `changes[]: {key, value}` or `{key, reset: true}` (1 to 16) |
| `config_write_response` | d2c | `requestId`, `ok`; success: `changes[]` with `appliesAt`, new `revision` (unchanged for `dryRun`); failure: `errors[]: {key?, code, message}`, code one of `CONFIG_NOT_PERMITTED`, `CONFIG_KEY_NOT_WRITABLE`, `CONFIG_VALUE_INVALID`, `CONFIG_CONFLICT`, `CONFIG_FILE_INVALID`, `CONFIG_UNSUPPORTED_FORM`, `CONFIG_WRITE_FAILED` |

A `type` or `access` value the app does not know draws that row read only ("update this app to change it").
Never on the wire: the file's bytes, a setting outside the registry or with `hidden` access, an unknown key's value, the name of any other table (so the presence of a Telegram token is not disclosed), an absolute path.
Golden fixtures in `packages/shared/tests/fixtures/protocol/`: `config_read_request`, `config_read_response` (one setting of each type, an unknown key), `config_read_response_invalid_file`, `config_write_request`, `config_write_request_reset`, `config_write_response`, `config_write_response_error`, and `hello_ack` listing `config`.
RemiKit decodes each (`FixtureConformanceTests`); a conformance test constructs both endpoints (ADR 0014); the capability has its documentation test (ADR 0035 item 4).

**D4.4 Who may write (Q3, recommended (b)).** A write needs an authenticated device key the person granted the `settings` scope at the terminal (proposed `remi keys grant <fingerprint> settings`, `remi keys revoke <fingerprint> settings`, shown by `remi keys`); a read needs any authorized device.
A hub with authentication off refuses every write (no key can hold a grant).
A capability-token holder (a local CLI) may write, since it can edit the file anyway.
The grant lives beside the key's label in the authorized-keys store (ADR 0037) and gets a security review.

**D4.5 Validation and the writer (MH6b).**
1. Re-read the file; a revision different from the request's is `CONFIG_CONFLICT` (a hand edit since the read wins; the app re-reads and shows it).
2. A current file that does not load with the hub's own loader is `CONFIG_FILE_INVALID`; the app never offers to overwrite it.
3. Build candidate bytes with a table-scoped line editor: replace the `key = value` line inside a plain `[awake]` or `[display]` header, append it at that table's end, or append the table at the file's end; a reset removes the key's line (Q10 (b)) and keeps the comment lines above it. Refuse `CONFIG_UNSUPPORTED_FORM` for top-level dotted keys, inline tables, a repeated key, a multi-line value, or a file that is a symlink, not regular, or not owned by the user.
4. Load the candidate with `parseConfigText` (`config.ts:420`), the path every remi command's load takes, relation checks included (a syntax error's text is already withheld, `:426-427`); any error is `CONFIG_VALUE_INVALID` with the loader's message, attached to its key. A `dryRun` stops here and writes nothing: that is the page's inline validation.
5. Every byte outside the edited lines stays identical (a property test over real configs: comments, `[profiles.*]`, a Telegram line, CRLF, no final newline).
6. Write atomically: a temporary file in the same directory, mode 0600, fsync, rename. Never a backup copy: a copy of the file copies the token (D10).
7. No file: create it as `remi config init` does (`generateDefaultConfig`, `wx`, 0600; `config.ts:918-933`), then apply the change.
8. Audit: one hub log line per write (`[Config] <label> <fingerprint prefix> set awake.question_hold_minutes 30 -> 45`, or `reset`) and the same as a JSON line in `REMIHOME/config-changes.log` (0600, rotated at 1 MB); registry values only, none secret.

**D4.6 When a change applies.** Each key carries `appliesAt` (N5): session-held keys (`[awake]` level 1, `display`) apply to sessions started after the change, running sessions keep theirs; hub-owned keys (level 2) apply after a hub restart.
`pendingRestart` is true while a hub-owned key in the file differs from what the running hub loaded; the This Mac card then says "Restart the hub to apply".
A key overridden by environment or flag (`REMI_MAX_BULLET_LENGTH`) says "set by the environment on this Mac; the file value applies only without it".

**D4.7 Restart.** The app never restarts the hub by itself, and no wire message restarts it: a remote-triggered restart is a new surface, and level 2's restart rule (awake Q12) makes a restart consequential.
The hub writes `restartCommand`: `launchctl kickstart -k gui/<uid>/com.yooz.remi` when it runs under its LaunchAgent, otherwise `remi stop && remi start`; the app shows it with Copy, and with MH9 the `restart` verb runs it.
The copy says what a restart does: sessions keep running (N10, verified by MH6b with a real child), devices reconnect, and lid-closed mode follows the keep-awake restart rule.

**D4.8 Version skew.**
- App older than hub: the page renders every served setting from the schema, new keys included; a `type` or `access` it does not know is read only; unknown fields, codes and enum values decode as unknown.
- Hub older than app: the page shows only what the hub serves; without `config` the tab shows `hubSupport`'s message (update remi on this Mac and restart it).
- Hub process older than the installed binary (#539): the running hub validates; keys are only ever added, so a newer binary loads them. A downgrade below a written key stops every remi command at load (`config.ts:458-478`); the recovery path covers it and the docs warn. Lead decision: no tolerant loader mode; the owner may revisit.

**D4.9 Recovery when the config is unreadable or has an unknown key.**
- File broken while the hub runs: reads return `file.valid = false` with the loader's message; the tab disables every control and says "The hub keeps running with the settings it started with, but it will not start again until the file is fixed. In Terminal: `remi config show`", with the docs link.
- Hub no longer starts (after a restart or a downgrade): the This Mac card shows "Remi isn't running on this Mac" with the commands, plus "If `remi start` reports a settings error, it names the file and the key: fix or delete that line, then start again"; `config-changes.log` shows what the app changed last.
- A failed write cannot leave a broken file: the candidate loads before the atomic rename.

**D4.10 The raw TOML file beside the page.**
- The file stays the person's: they edit it in any editor, and the hub reads it at start and at every `config_read_request`, so a hand edit shows on the next read, with "applies after a hub restart" where `running` differs from the file.
- The app re-reads when the Settings window becomes key and after every write; a hub-pushed change notice is not needed now.
- Comments, order and formatting survive app writes: one line of one table changes (D4.5 items 3 and 5).
- Keys the registry does not know: in a strict table (`[awake]`) the file does not load, and D4.9 shows the loader's message naming the key; in a tolerant table (`[display]`, N11) they are listed as "Unknown key, ignored by this remi" by name only, never their value, and the editor never deletes them.
- "Open config.toml" (VS Code's "Open Settings (JSON)") in a sandbox that cannot read `~/.remi`: the app shows `displayPath` with Copy, and the commands `open -t ~/.remi/config.toml` (the default text editor) and `remi config show` (effective values, token masked, N11) with Copy. "Open in editor" and "Show in Finder" hand the path to another app through `NSWorkspace` only if an MH7 spike shows the sandbox allows it without giving the app access (UNVERIFIED); never through an open panel or a security-scoped bookmark, which would make the app a reader. For a remote machine, Copy only.

**D4.11 What to take from VS Code, and what not.**

| VS Code behavior | Here |
|---|---|
| Settings editor rendered from contributed schemas | adopt: the registry (D4.2) |
| Search box and `@modified` filter | adopt: matches key, title and description; `@modified` and `@restart` filters |
| Grouped sections with a table of contents | adopt: the registry's `group`, a section list beside the page once there are more than five groups |
| Modified indicator | adopt: a bar beside a setting whose value differs from its default; "set in config.toml" in the detail when the line exists |
| Per-setting menu: reset, copy setting ID, copy as JSON | adopt: Reset to default, Copy key, Copy as TOML (`[awake]` plus the line) |
| Default value | adopt, always shown beside the current value ("Default: 30 minutes") |
| Description under each setting | adopt as plain text, escaped (the machine wrote it), with the key name in monospace |
| Inline validation | adopt: a `dryRun` write runs the hub's own validator and its message shows under the setting; the app checks only type and the sanity bounds before sending |
| Saves on change | adopt: a toggle saves at once, a number when editing ends |
| Restart-required hint | adopt: badge "Applies after a hub restart"; note "Applies to new sessions" |
| Open the JSON file | the sandbox-aware form of D4.10 |
| Scopes (user, workspace, folder, remote) | one scope, the machine (each machine has its own page); a profile's options stay read only (ADR 0051 Q1, A3); no repository scope (section 1) |
| Policy-managed settings | maps to environment and flag overrides, shown as "set by the environment on this Mac" |
| Settings Sync | skip: settings belong to their machine |
| Language overrides, extension settings | skip |
| "Edit in settings.json" for complex values | `string` and `stringList` settings are `terminal` access for now |

**D4.12 Surfaces and parity.**
- Native first: MH7 on the Mac. The registry, the wire and the pure presentation (`RemiSettingsPresentation` in RemiUI) are client-neutral, so iPhone and iPad can show the same page for any machine later, in a step of their own; a phone writes only with a grant (Q3).
- Terminal: `remi config list` (each setting with value, default, modified mark, access and "applies"), `remi config set <key> <value>` and `remi config reset <key>`, through the same registry, editor and validator (MH6c, Q11). Terminal-access keys are settable there: the terminal is the machine.
- Web: the browser client can render the same schema as a settings page in `packages/web` (MHW, Q11), after MH7, as another device that needs the same grant; the WebView Mac app and the retiring Capacitor app are not changed (`packages/native/AGENTS.md:42`).
- Docs: one yooz-docs page lists every setting, generated from the registry (MH6a).

### 3.5 Rule amendments (text proposed; MH3 applies it after Q2, Q3, Q5, and Q1 for the script)

| Rule | Today | Amended to |
|---|---|---|
| `packages/native/AGENTS.md:39` | "... It is a client of hubs, local and remote, and never spawns agents, never reads `~/.remi`, never signals a process. Anything that needs the machine ... is a request to the hub." | "... It is a client of hubs, local and remote. It finds this Mac's hub only through `GET /auth-info` on 127.0.0.1, which registers no key, and the hub's own messages. It never spawns agents, never reads or writes `~/.remi`, never signals a process and never approves its own key. Settings change only through the hub's `config` capability (ADR 0052), which writes the keys the hub lists as writable, for a device the person granted at the terminal. Anything else that needs the machine is a request to the hub." With Q1 (b), add: "The one program it runs is the script the person saved in its Application Scripts folder, by the verbs `start` and `restart`, only while the script's bytes match the text the app offered." |
| ADR 0051 F8 (`:62-64`) | "The native apps never touch the machine. ... never read `~/.remi`, never spawn a process ..." | append: "ADR 0052 is the only configuration write a device can request: settings of `[awake]` and `[display]` whose registry access is `app`, written by the hub for a granted device; `[profiles.*]` is never on it. The Mac app's optional start script (ADR 0052) is the only process it starts." |
| ADR 0051 A1 and Q1 (`:147-155, :626`) | "No app writes profile configuration ... The Mac app is no exception" | a scope note the owner approves (Q2): "Q1 covers profile configuration and everything a profile carries. Device-requested changes to other configuration follow ADR 0052, whose whitelist never includes `[profiles.*]`, `auth`, `daemon`, `network`, `telegram`, `harness`, or a key that widens what devices may see or do." |
| ADR 0050 slice 4 (`:146`) | "`keep_awake_status` and start and stop messages ..." | the awake lead records where the status rides (4.4; CO-1) |
| `packages/native/DESIGN.md:30` | one-color icon, outline versus fill | extended per phase (MH2 dashed, MH5 dot, MH8 sign), each in a commit of its own |
| `packages/native/VISUAL-ACCEPTANCE.md` | no menu bar evidence | a "Menu bar" section (4.8), added by MH2 |

## 4. The status icon

### 4.1 Direction: research B's E, in two steps, amended

E (a dot for level 1, a two-line sign for level 2 only, one template image, no color) is adopted. Amendments:
1. Vocabulary: armed, active, paused (waiting), disarmed. B's "armed with a refusal" is paused (waiting), first-class since `865457b2`.
2. Sign words: WAKE over ARM, WAIT, ON (the owner's "WAKE ON", spent on the risky state) and OFF (disarmed by something other than the person, until seen). B's LID presumes a cause, and FAIL is wrong for a resume-limit or breaker disarm. Words are Q6.
3. The mark speaks for this Mac's hub only; other machines' keep-awake is in the menu.
4. A keep-awake state is dropped the moment this Mac's hub is not `connected`; the dashed glyph shows only when no machine is connected (B risk 6); a down local hub beside connected machines shows in the This Mac row.
5. No color and no animation in either step; color stays a later option, only after a look at a real light bar.

### 4.2 Final state table

| Base | Condition | Glyph | Step |
|---|---|---|---|
| B1 error | no device identity | triangle | today |
| B2 offline | no machine connected | dashed square, "r" at 55 percent (100 under Increase Contrast) | MH2 |
| B3 calm | connected, nothing waits | thin outline, filled "r" | today |
| B4 needs you | pending count above 0 | filled square, "r" knocked out, count | today |

| Mark | This Mac's keep-awake | Drawn | VoiceOver part | Step |
|---|---|---|---|---|
| K0 | not reported; level 1 off or idle; level 2 off | nothing | nothing | - |
| K1 | level 1 holding | 4.5 pt dot, lower right, 1 pt halo | "keeping this Mac awake while agents work" | MH5 |
| K2 | level 2 armed | WAKE / ARM | "lid-closed mode armed, waiting for work" | MH8 |
| K3 | level 2 paused (waiting) | WAKE / WAIT | "lid-closed mode paused: <reason>; resumes when <waitingFor>" | MH8 |
| K4 | level 2 active | WAKE / ON | "keeping this Mac awake with the lid closed until <time>" | MH8 |
| K5 | level 2 disarmed by something other than the person, not yet seen | WAKE / OFF until the menu has been opened once | "lid-closed mode turned off: <reason>; arm it again to resume" | MH8 |
| K6 | level 2 disarmed by the person, or disabled | nothing | (menu only) | - |

Composition: B1 and B2 suppress every mark; a sign replaces the dot; order is glyph, count, sign (at most about 55 pt).
VoiceOver value: "Remi, " plus the base part ("unavailable", "no machine connected", "nothing needs you", "N requests need you") plus "; " and the mark part; for example "Remi, 2 requests need you; keeping this Mac awake with the lid closed until 14:30".

### 4.3 Provisional mapping from the level 2 state machines

| User-facing | `c7ab6f51` machine | `865457b2` machine |
|---|---|---|
| off | `disabled` | `disabled` |
| armed | `armed`, no `lastRefusal` | `armed` |
| paused (waiting) | `armed` with `lastRefusal` | `paused` |
| active | `starting`, `on`, `reverting` | `starting`, `on`, `reverting` |
| disarmed, by the person | `disarmed` after `stop` | `disarmed`, reason `stop` |
| disarmed, other | `disarmed` after a failure revert | `disarmed`, any other reason (switch failure, resume limit, breaker, restart after a crash, flag cleared by someone else) |

`reverting` counts as active: a risky state is never rounded down before the switch confirms.
The mapping is provisional: the wire carries the user-facing value and L2-APP owns the translation, so a change from Q12 to Q14 changes one function, not the app.

### 4.4 The `keep_awake_status` field (MH4 for level 1, L2-APP for level 2)

`hub_status.keepAwake`, optional, present on every `hub_status` from a hub listing capability `keep_awake_status` (registry text "show whether this Mac is kept awake"):

| Field | Values | Phase |
|---|---|---|
| `level1` | `off` (config), `idle`, `holding`, `unsupported` (not macOS) | MH4 |
| `level1Sessions` | sessions holding now | MH4 |
| `level2` | absent on a hub without level 2; `{state: off, armed, paused, active or disarmed; disarmedBy?: person or other; reason?: code; waitingFor?: code; until?: timestamp; origin?: automatic or explicit}` | L2-APP |
| `battery` | percent, absent without a battery | L2-APP |

Rules:
- Codes and numbers only, never process names, paths or command lines (another app holding the Mac is `reason: other-app`; names stay in `remi keep-awake status` at the Mac).
- The tracker re-broadcasts when this object changes (its change key, `hub-client-tracker.ts:98-115`, gains it).
- An unknown state draws no mark and the menu says "lid-closed mode: state not known".
- Why a capability for a visible field (ADR 0035 item 2 needs none): listing it promises the field on every `hub_status`, so absence is an error shown as unknown rather than "this Mac may sleep". If the ADR 0035 reviewer prefers the field alone, the app treats absence as unknown everywhere and loses only the update hint.
- Level 1 source: each session daemon's `awakeHold` in `status-<PORT>.json` (awake L2-HUB item 7); MH4 takes it forward with the awake lead's agreement (CO-1) or waits for L2-HUB.
- Level 2 actions (Arm, Disarm, Stop, Extend) are L2-APP's `keep_awake` messages; the Mac app is a device like a phone, so they need `allow_phone = true` at the Mac (Q8). Without it the menu shows the state and the terminal step, never a control (DESIGN.md principle 3).

### 4.5 Before the field exists

Step 1 ships only B1 to B4 with no mark, and no keep-awake row while no remi release can report it.
Once the app's mirrored registry knows `keep_awake_status` and this Mac's hub does not list it, the row shows `hubSupport`'s message ("Update remi on this Mac and restart it").
The icon never infers keep-awake from session status.

### 4.6 Accessibility

- Shapes and words only, so Differentiate Without Color needs no branch; a test pins that the bitmap is identical with the setting on and off, so a later color accent must add one.
- Increase Contrast: the dashed state's "r" goes from 55 to 100 percent alpha; nothing depends on alpha alone.
- Reduce Motion: nothing animates; any later pulse reads `accessibilityDisplayShouldReduceMotion` and draws a static mark instead.
- VoiceOver: label "Remi", value the 4.2 sentence. Whether `MenuBarExtra` forwards `.accessibilityValue` is UNVERIFIED; MH2's recording decides, and if not, the whole sentence goes in the label, with an app-delegate `NSStatusItem` as the fallback (B risk 11).
- Tooltip: the same sentence plus "on <machine name>".
- An accessibility announcement when level 2 becomes active or is disarmed by something other than the person (UNVERIFIED from a menu bar extra; MH8 checks).

### 4.7 When the system hides the menu bar item

The system may hide extras on a crowded bar or under the notch, and the app cannot detect it (HIG, RESEARCH B; UNVERIFIED), so level 2 safety never depends on the bar:
1. A local notification when level 2 becomes active, pauses for battery or thermal, or is disarmed by something other than the person; not on every resume (awake plan bound 9); the same transitions as the phone push of awake Q11, settled at its CP-HW (MH8).
2. The Dock menu (the app has a Dock icon; no `LSUIElement`) shows "This Mac: <hub state>" (MH2) and "Keep awake: <state>" with the allowed actions (MH8).
3. The main window's This Mac sidebar row repeats the state in words (MH5, MH8).
4. Settings, General: "Show Remi in the menu bar" (`MenuBarExtra(isInserted:)`), default on, as the HIG asks (MH2, Q9).
With notifications denied, the main window shows a banner for the same transitions.

### 4.8 Visual acceptance additions (MH2 writes them into VISUAL-ACCEPTANCE.md, "Menu bar")

- Build per the exact-commit rule (`packages/native/scripts/build-exact-native.sh --expected <commit>`), receipt attached.
- A screenshot of the real menu bar for every state of 4.2 the phase ships, light and dark, standard and Increase Contrast, cropped to the item with its neighbors; one on a crowded bar or a notch Mac showing what the system does with the sign; the popover per state.
- A VoiceOver recording (VoiceOver's caption panel captured, or screen with audio) of each state's sentence, and the tooltip.
- States come from a throwaway hub from source on 18790 or above with a temporary `REMI_HOME`, never the owner's hub; level 2 states before a MacBook run come from a fixture hub sending the golden `hub_status` frames, recorded as such.
- Who: the owner, or the manager's GUI run announced to the owner first, with an ad hoc signed build (`packages/native/AGENTS.md:94, 114`); an agent without a GUI session lists the states as not run.
- Pass: each state is told apart at 1x and 2x without color, the sign is not clipped, VoiceOver speaks the sentence, and nothing is drawn for a state the hub did not report.

## 5. Phases

Smallest useful slice first: MH1 and MH2 need no owner decision, no daemon change and no new entitlement; MH6a (the registry, no wire) needs only Q10, for its template part, and can land early so the keep-awake slices add registry entries.
Branches `feature/issue-1805-<short>` off a fresh `origin/develop`, worktrees under `/Volumes/S1/worktrees/remi/`, DerivedData under `/Volumes/S1/derived/remi-<worktree>`, test hubs on 18790 and up with a temporary `REMI_HOME`, never the owner's hub. The manager files one sub-issue of #1805 per step.

| Step | Goal | Tier | Needs | Depends | Timebox |
|---|---|---|---|---|---|
| MH1 | This Mac card and first-run commands card | worker-hard | xcode | - | 2.5d |
| MH2 | Icon step 1, VoiceOver sentences, Dock line, show-in-bar toggle | worker-hard | xcode | MH1 | 1.5d |
| OG-MH2 | real-bar evidence, TestFlight build | owner | Mac | MH2 | 30m |
| OQ-1 | owner batch 1: Q2, Q3, Q5, Q9, Q10, Q11 | owner | - | none; ask at once | - |
| MH3 | ADR 0052 and the 3.5 amendments | lead | - | OQ-1 | 0.5d |
| CO-1 | agreement with the awake lead (below) | lead | - | none | 30m |
| MH4 | `keep_awake_status`, level 1, on `hub_status` | worker-hard | - | CO-1; `awakeHold` published | 1.5d |
| MH5 | Icon step 2a: the level 1 dot and the This Mac keep-awake row | worker-hard | xcode | MH2, MH4 | 1d |
| MH6a | settings registry, drift test, generated template and reference | worker-hard | - | CO-1; #1798 merged | 1.5d |
| MH6b | `config` capability: schema, values, writes | worker-hard | - | MH3, MH6a | 3d |
| MH6c | `remi config list`, `set`, `reset` (only if Q11 says so) | worker | - | MH6b | 1d |
| MH7 | Settings This Mac tab, rendered from the schema | worker-hard | xcode | MH1, MH6b | 2.5d |
| OG-MH7 | owner check on his Mac, TestFlight build | owner | Mac | MH7 | 30m |
| MH7b | level 2 tunables writable: `access` to `app` in the registry (only if Q4 (b)) | worker | - | MH6b, L2-HUB, OG-L2 | 0.5d |
| MHW | web settings page from the same schema (only if Q11 says so) | worker | - | MH6b, MH7 | 1.5d |
| MH8 | Icon step 2b: level 2 sign, menu row, notifications, Dock, actions | worker-hard | xcode | MH5; L2-APP merged; Q6, Q7, Q8 | 2d |
| OG-MH8 | MacBook check of the level 2 states | owner | MacBook | MH8; OG-L2 | 1h |
| MH9 | optional one-click start script (only if Q1 (b)) | worker-hard | xcode | MH1, MH3 | 2d |
| OG-MH9 | owner's script check, TestFlight processing, App Review choice | owner | Mac | MH9 | 1h |

Common gates, named in each step:
- N-GATE: `swift test --package-path packages/native/RemiKit --skip PairingAttemptTests` (known baseline, `AGENTS.md:98`); `xcodebuild -project packages/native/Remi.xcodeproj -scheme RemiMac -destination 'platform=macOS' -derivedDataPath /Volumes/S1/derived/remi-<worktree> CODE_SIGNING_ALLOWED=NO build test`; the same with `-scheme RemiPhone -destination 'generic/platform=iOS Simulator' ... build`; `typos`. Hosted `Build and Test (Native)` green.
- T-GATE: `bunx biome check .`; `bun run typecheck`, `typecheck:web`, `typecheck:web-tests`, `typecheck:signaling`; `bun scripts/third-party-notices.ts --check`; `bun test packages/shared/tests` plus the step's named daemon test files; `typos`; hosted CI green.
- F-GATE (protocol steps): `bun packages/shared/tests/fixtures/protocol/generate.ts && bunx biome check --write packages/shared/tests/fixtures/protocol/` leaves no diff; `protocol-fixtures.test.ts`, `protocol-fixtures-additive.test.ts`, `macos-fixture-conformance.test.ts` pass.

**MH1. This Mac card and first-run commands card.**
Scope: RemiKit `Discovery/LocalHubProbe.swift` (new; D2 rules), a `hub_status` model (fields of N1), the store's local-hub facts behind a type; RemiUI `RemiThisMacPresentation` (pure: probe result, saved machine, connection status, `hub_status`, `hubSupport` to title, detail, commands, action); Mac `MacFirstRunView` (the D2 card states), a This Mac section in `MacLiveNeedsYouMenu`, a This Mac row in Settings Machines; `PARITY.md` (Mac pairing paste, This Mac, the D2.6 limits). No daemon change, no entitlement change.
Acceptance:
1. N-GATE.
2. `LocalHubProbeTests` against a real hub from source (`REMI_HOME=$(mktemp -d) bun packages/daemon/src/cli.ts serve --port <1879x>`, the pattern of `RemiKit/Tests/Integration/relay-fixture.ts`): finds the port; `authRequired` is true; the fingerprint equals the hub's; afterwards `bun packages/daemon/src/cli.ts keys` with that `REMI_HOME` lists no pending key; with the hub stopped the probe returns none within 2 s.
3. A test pins the Debug range 18790 to 18799 and the Release range 18765 to 18784.
4. `hub_status.json` decodes in `FixtureConformanceTests`; the `.unsupported(type: "hub_status")` expectation at `RelaySourceIntegrationTests.swift:278` is updated, not deleted.
5. `RemiThisMacPresentationTests` cover every row of the D2 card table and D3's command text.
6. `git diff origin/develop -- packages/native/Mac/Remi.entitlements packages/native/MacPushService` is empty.
7. Previews of every card state, light and dark, render.
Lenses: native code; security (a probe never authenticates; no connection to an unsaved hub; Debug range); honesty (DESIGN.md principle 3, PARITY.md says what ships).
Docs: yooz-docs `docs/tools/remi/guides/mac-app.md` (proposed path): This Mac, starting the hub, approving the app.

**MH2. Icon step 1.**
Scope: RemiUI `MenuBarStatus` (B1 to B4, sentence, tooltip) and `MenuBarIcon` (dashed state, Increase Contrast alpha); Mac `MacMenuBarLabel`; `applicationDockMenu` with the This Mac line; Settings General "Show Remi in the menu bar" (`isInserted`, kept in `UserDefaults`, a per-device convenience); DESIGN.md menu bar bullet and VISUAL-ACCEPTANCE.md "Menu bar" section, each in its own commit.
Acceptance: N-GATE; `MenuBarIconTests` alpha-bitmap tests of the dashed state at 1x and 2x, with and without Increase Contrast; `MenuBarStatusTests` for the sentences of B1 to B4 at counts 0, 1, 2; a test that the bitmap is identical with Differentiate Without Color on and off; the previews gallery (`MenuBarIcon.swift:116-154`) shows every state; OG-MH2 evidence per 4.8.
Lenses: design and accessibility; native code.

**MH3. ADR 0052 (lead).** "Mac app hub control: monitoring, settings through the hub, the start path": D1 to D4, 4.4, section 6; the 3.5 amendments applied in the same PR; the decisions README index; status Proposed until the owner approves in the PR.
Acceptance: `typos`; a fresh reviewer (strongest model, security and privilege lens) reads it before the owner; the owner's approval is recorded in the PR.

**CO-1. With the awake lead (before MH4).** Record in both boards: (1) who publishes `awakeHold` (recommended: MH4 takes L2-HUB item 7 forward as its own small PR and L2-HUB reads it); (2) status rides on `hub_status.keepAwake` under `keep_awake_status`, control stays L2-APP's `keep_awake`; (3) the wire carries the user-facing states of 4.3 and L2-APP translates; (4) codes, never process names; (5) the Mac app counts as a device under `allow_phone`; (6) the push transitions settled at CP-HW also drive the Mac notifications; (7) every `[awake]` key G2 and L2-HUB add is a registry entry (default, sanity bounds, title, description, `appliesAt`, `access`) in its own PR once MH6a merged, and MH6a migrates any that merged before it (one line in those cards' scope).

**MH4. `keep_awake_status`, level 1.**
Scope: shared `protocol.ts` (`HubStatusMessage.keepAwake?`), `protocol-version.ts` (`keep_awake_status`), `cli/capabilities.ts`; daemon `hub-client-tracker.ts` (census and change key), the census reader of `status-<PORT>.json`, `awakeHold` publication if CO-1 assigns it; fixture builders (`hub_status`, `hello_ack`); optional `role` on `/auth-info`.
Acceptance:
1. T-GATE and F-GATE.
2. A census test over real `status-<PORT>.json` files written by the daemon's own status writer in a temporary `REMI_HOME` (holding, idle, a stale file of a dead PID ignored).
3. A hub test (real hub from source, `env -i`, temporary `HOME` and `REMI_HOME`, a port from `reserveRange`): a client gets `hub_status.keepAwake.level1` equal to `idle`, and `hello_ack.capabilities` lists `keep_awake_status`.
4. A test asserts the serialized `keepAwake` has only the documented keys and value kinds.
Lenses: protocol (ADR 0035 additive, ADR 0014 both endpoints); privacy; daemon code.

**MH5. Icon step 2a.** RemiKit decodes `keepAwake` (fixture); RemiUI K1 dot (B section 4 geometry); the VoiceOver part; Mac This Mac row "Keep awake: holding for N sessions" or "This Mac may sleep"; DESIGN.md dot in its own commit.
Acceptance: N-GATE; bitmap tests of B3 plus K1 and B4 plus K1 at 1x and 2x; presentation tests for `off`, `idle`, `holding`, `unsupported`, absent with and without the capability (4.5); 4.8 evidence for the two new states.
Lenses: design and accessibility; native code.

**MH6a. The settings registry (no wire).**
Scope: daemon `config/settings-registry.ts` (D4.2); `validateAwakeTable` and `validateAwake` (`config.ts:458-498`) and a `[display]` range check read the registry; `generateDefaultConfig` writes `[awake]` and `[display]` from it (keys commented out with their defaults if Q10 (b)); a generator script (proposed `packages/daemon/scripts/settings-reference.ts`) printing the Markdown settings reference; `docs/agent-reference/keep-awake.md` points to it.
Acceptance:
1. T-GATE.
2. `settings-registry-drift.test.ts`, the D4.2 drift test, against `parseConfigText` and `DEFAULT_CONFIG`, with no stand-in for the loader.
3. A snapshot test of the generator's output; the generated template loads to exactly `DEFAULT_CONFIG`.
4. Revert checks, each with its failing test: change a default in `DEFAULT_CONFIG` only; widen a bound in the registry only; drop an entry's `access`.
Lenses: daemon code; docs ("say what ships": every description matches its key's behavior).

**MH6b. The `config` capability.**
Scope: shared messages, capability `config`, fixtures (D4.3); daemon `config/config-writer.ts` (pure editor, reset and candidate check, D4.5), a hub-only handler (`cli/handlers/config-events.ts`) serving the registry with values, the `settings` grant and `remi keys grant|revoke` (if Q3 (b)), the audit log, `restartCommand`; `docs/agent-reference/` config section; root AGENTS.md one line.
Acceptance:
1. T-GATE and F-GATE.
2. Writer property test (D4.5 item 5) over a corpus: the default template, a hand-edited file with comments, `[profiles.*]` from #1798's fixtures, a `[telegram]` line holding the placeholder `sentinel-not-a-token`, CRLF, no final newline; a reset removes exactly one line.
3. One refusal test per code of D4.3, including a `terminal` key, a top-level dotted key, an inline table, a symlinked file, a stale revision and an out-of-range value; a `dryRun` returns the loader's message on its key and leaves the file's bytes and mtime unchanged.
4. Handler tests on a real hub from source (temporary `REMI_HOME`, reserved port, `env -i`): the read serves exactly the registry's non-hidden entries with values, defaults and `modified`; an unknown `[display]` key whose value is `sentinel-not-a-token` appears by name only; an authorized key without the grant reads, and its write is `CONFIG_NOT_PERMITTED`; after the grant it writes; the mode stays 0600; the hub log and `config-changes.log` gain one line each; no frame contains `sentinel-not-a-token` or the word `telegram`.
5. A session daemon answers `UNSUPPORTED`; with authentication off every write is refused.
6. A real child session daemon survives `remi stop` without `--all` and is listed by the restarted hub (N10), or the D4.7 copy is changed to what the test shows.
7. Revert checks, each with its failing test: drop the grant check; give `awake.level2` `app` access; skip the candidate load.
Lenses: security and privilege (mandatory: it writes configuration and adds an auth scope), silent failure, protocol, daemon code.
Docs: yooz-docs `commands/keys.md` (the grant) and `commands/config.md` (the audit log, recovery).

**MH6c. Terminal parity (Q11).** `remi config list`, `set <key> <value>`, `reset <key>` on the registry, the writer and the validator; the person's own terminal needs no grant. Acceptance: T-GATE; the real CLI entry against a temporary `REMI_HOME` (`env -i`) lists every entry, sets and resets one, refuses an unknown key and an out-of-range value with the loader's message, and leaves every other byte of the file unchanged. Lenses: daemon code, docs.

**MH7. Settings This Mac tab, rendered from the schema.**
Scope: RemiKit models of the four messages (fixtures), `MachineStore` request plumbing; RemiUI `RemiSettingsPresentation` (pure: schema and values to groups, controls by `type`, search and `@modified`, modified bars, defaults, badges, read-only rows, unknown keys, every error code); Mac `MacPreferencesView` tab with the D4.11 behaviors, the per-setting menu (Reset to default, Copy key, Copy as TOML) and D4.10's path and commands; the conflict, invalid-file, no-grant ("This app can read settings but not change them; at this Mac run `remi keys grant <fp> settings`") and restart states; a spike recording whether `NSWorkspace` can open or reveal an unreadable path from the sandbox.
Acceptance: N-GATE; the fixtures decode; `RemiSettingsPresentationTests` render a fixture `config_read_response` holding one setting of each type and a key no app code names, with no app change; tests for search, `@modified`, reset, Copy as TOML, each badge, an inline `dryRun` error and an unknown `type` drawn read only; `git grep -n "question_hold_minutes" packages/native/Mac packages/native/RemiKit/Sources` finds no key name in app code; an integration test on a real hub from source reads, writes `awake.question_hold_minutes`, re-reads it, and gets `CONFIG_CONFLICT` after the test edits the temporary file between read and write; previews for normal, read only, invalid file and hub too old; screenshots of the tab in light, dark and Increase Contrast with a receipt.
Lenses: native code; security (no file access, no secret in previews or logs, machine text escaped); honesty.
Docs: yooz-docs `guides/keep-awake-settings.md`, linking the generated reference.
OG-MH7: on his own Mac and hub, the owner grants the app, changes one key, sees "applies to new sessions", runs `remi config show` to see it, and compares a copy of `config.toml` from before and after (only the edited line differs).

**MHW. Web settings page (Q11).** `packages/web` renders the same schema through the same capability, the same rules as D4.11 (no file affordance beyond Copy); after MH7, so the presentation rules are settled once. Acceptance: the web gates (`typecheck:web`, `typecheck:web-tests`, `bun test` of its files) and a Playwright run against a hub from source on a 1879x port. Lenses: web code, security (no secret in the page or the browser's storage).

**MH8. Icon step 2b.**
Scope: RemiKit `keepAwake.level2` and L2-APP's action messages; RemiUI signs drawn into the template image (no text layout), K2 to K5 sentences; the menu row per research B section 7 in the 4.3 vocabulary; notifications, Dock line and announcement of 4.7; DESIGN.md sign in its own commit.
Acceptance: N-GATE; bitmap tests of K2 to K5 with B3 and B4 at 1x and 2x, item width at most 56 pt; presentation tests turning fixture frames of both state machines (4.3) into the same user-facing state; notification policy tests (which transitions notify; not every resume); no action is drawn without `allow_phone` (fixture); 4.8 evidence for every K state; OG-MH8 on a MacBook during or after OG-L2.
Lenses: design and accessibility; safety (no control without `allow_phone`, stale state dropped); native code.

**MH9. Optional one-click start (Q1 (b)).**
Scope: Mac "Set up one-click start" sheet (the script text, the `remi` path, default `/opt/homebrew/bin/remi`, shown escaped, Save through `NSSavePanel` at the Application Scripts folder), a Start or Restart button on the This Mac card only while the saved script's SHA-256 matches; `NSUserUnixTask` with `start` or `restart`; the result is the exit code plus at most one escaped line. The script text is a RemiKit constant: fixed `PATH=/usr/bin:/bin`, the absolute `remi`, a `case` of the two verbs, anything else `exit 64`; `restart` uses `launchctl kickstart -k gui/$(id -u)/com.yooz.remi` when `~/Library/LaunchAgents/com.yooz.remi.plist` exists, otherwise `remi stop` and `remi start`.
Acceptance: N-GATE; the script text runs in a test with `REMI` pointing at a wrapper that runs remi from source with a temporary `REMI_HOME` and a 1879x port: `start` starts a hub, `restart` changes its PID, an unknown verb or an extra argument exits 64 and starts nothing; a changed script is refused by the app; OG-MH9.
Lenses: security and privilege (mandatory); App Review.
OG-MH9: the owner saves the script, clicks Start with no hub running, sees the hub start and outlive the app; a TestFlight build passes processing; the owner decides whether to submit it for review (2.4.5 risk).

**Collisions.**

| Step | Other work | Shared files | Rule |
|---|---|---|---|
| MH4, MH6b | profiles P2B, P2C, P3B, P4A, P4B; awake L2-APP | `packages/shared/src/protocol.ts`, `protocol-version.ts`, `packages/daemon/src/cli/capabilities.ts`, fixture builders | never two active; the second to merge regenerates fixtures |
| MH6a, MH6c | profiles P1A (#1798), P1B; awake G2, L2-POL, L2-HUB | `packages/daemon/src/config/config.ts` (validator, template), `cli/cmd-config.ts` | MH6a starts after #1798 merges and never while G2 or L2-HUB is active; after MH6a each new `[awake]` key is a registry entry (CO-1 item 7) |
| MH4 | awake L2-HUB item 7 | `power/awake-*`, the status writer | CO-1 names the owner of `awakeHold` |
| MH1, MH2, MH5, MH7, MH8 | profiles A1 to A4 (#1788 to #1791) | `MachineStore.swift`, `MacPreferencesView.swift`, `MacLiveRootView.swift`, RemiKit protocol models | one Mac-track card active per file; small PRs; the second rebases |
| MH8, MH7b | awake L2-APP, L2-HUB, OG-L2 | the level 2 wire, keys and states | start only after they merge; update 4.3 if Q12 to Q14 change the machine |
| MHW | the web client's settings and status surfaces (awake L2-APP is web first) | `packages/web/src` settings components | one active at a time |
| MH3 | ADR 0050, ADR 0051 | the ADR texts | MH3 edits only the 3.5 notes; the ADR 0050 note is the awake lead's |

**Docs (yooz-docs).** Each page ships in the release of its feature, never before; every command and output comes from the shipped build against a temporary `REMI_HOME`, recorded in the docs PR (ADR 0051 A4 rule). Pages: `guides/mac-app.md` (MH1; the icon legend grows with MH2, MH5, MH8; one-click start with MH9), `guides/keep-awake-settings.md` (MH7), `commands/keys.md` and `commands/config.md` (MH6b, MH6c), all under `docs/tools/remi/` (proposed paths; the directories exist at `yooz-docs` `c85eb08`, ADR 0051).
The settings reference, every setting with its key, title, description, type, default, bounds, unit, "applies" and who may change it, is generated from the registry by MH6a's script from the shipped build each release (proposed `reference/settings.md`, or `commands/config.md` if the site has no reference section), never edited by hand; the keep-awake slices' new keys reach it with no docs work beyond the registry entry.

## 6. Threat model

| Actor | Can already | With the `config` capability | With the start script |
|---|---|---|---|
| A1 prompt-injected agent on this Mac, as the user | type into its own session; edit `~/.remi/config.toml`; run any `remi` command, `remi authorize` of its own key included; read the capability token; `remi keep-awake start` (ADR 0050's same-user model) | nothing new: it writes the file directly | nothing new: it runs `remi start` |
| A2 a remote authorized device (lost phone, relay-attached, compromised client) | answer cards, chat, start and kill sessions | with a grant only: `app`-access settings within the registry's bounds (turn level 1 off so the Mac sleeps mid-work; raise holds to their caps; bullet length); each change logged with its label | none: the script runs only on a click in this Mac's app |
| A3 an unauthenticated network or browser peer | read `/auth-info` (fingerprint, `authRequired`) | nothing: authenticated messages only; with authentication off, writes are refused | nothing |
| A4 a compromised Mac app (sandboxed) | what A2 can, as an authorized device | as A2 if granted; no file, no token | start or restart the hub, which A1 can already do |
| A5 a same-user process that rewrites the saved script | run code as the user already | - | the app refuses a script whose bytes changed |

Why a registry with a required `access` (a whitelist): a key outside the registry's tables is never served or written, and a key inside them cannot compile without an access value; a denylist would make each new key writable by default, which is how a device could one day write `allow_phone` or `bind`.
Why no secret keys: a read that carried `telegram.bot_token` would relay a credential to every device (D10); only registry tables are served and an unknown key goes by name only, so not even the token's existence leaves the machine; the writer keeps no backup copy.
Schema-driven rendering shows text the machine wrote (titles, descriptions, units): the app escapes it (`packages/native/AGENTS.md`, "Escape text another party chose"), renders only its closed set of control types, and the machine is one the person approved.
Why a grant: loopback is not identity, so "the Mac app" cannot be recognized by address; the terminal decides which key may change settings, and a device cannot grant itself, as ADR 0051 A1 requires ("a device must not be able to widen what devices can see").
Audit: the hub log line and `config-changes.log` name the device label, the key and both values; a person sees what changed and undoes it in the app or the file.
Not protected: anything against A1 (same user: it can edit the file and the audit log); availability against a granted A2 (it can make the Mac sleep or stay awake longer, within the ranges); the script folder, which any same-user process can write (the hash check only stops the app from running a changed script).
The start path adds no privilege: a fixed `remi` path, two verbs, no argument or environment passthrough, never `authorize`, `keys`, `pair`, `config`, `--no-auth` or `--bind`, and the app shows the output escaped.

## 7. Owner questions

| Q | Question and options | Recommendation | Blocks | Ask |
|---|---|---|---|---|
| Q1 | Start path: (a) commands card only; (b) also a fixed-verb script through `NSUserUnixTask`; (c) Developer ID build | (a) now; decide (b) after a week of MH1 in daily use | MH9 | after OG-MH2 |
| Q2 | ADR 0051 Q1 scope: (a) profile-only, with ADR 0052's registry-limited `[awake]` and `[display]` write through the hub; (b) no app writes any configuration (the page is read only with commands) | (a) | MH3, MH6b, MH7 | now (OQ-1) |
| Q3 | Who may write settings: (a) any authorized device; (b) only device keys granted `settings` at the terminal; (c) nobody | (b) | MH6b | now (OQ-1) |
| Q4 | Level 2 tunables from the app: (a) terminal only; (b) a granted device, within the registry's bounds, after OG-L2. The five `terminal` keys of D4.2 stay terminal only either way | (b) | MH7b | at the awake plan's CP-HW |
| Q5 | Approve the amended texts of 3.5 (native AGENTS.md:39, ADR 0051 F8 and the A1 note) | approve | MH3 merge | now (OQ-1) |
| Q6 | Sign words: WAKE over ARM, WAIT, ON, OFF; or research B's LID and FAIL; or a closed-lid symbol; English only | WAKE over ARM, WAIT, ON, OFF; English | MH8 | with OG-MH2 screenshots |
| Q7 | After a disarm the person did not make: (a) WAKE / OFF until the menu is opened; (b) a notification only | (a) plus the notification | MH8 | with Q6 |
| Q8 | The Mac app's level 2 actions: (a) need `allow_phone = true` like any device; (b) a separate Mac-only flag | (a): loopback is not identity, and a Mac-only flag could not tell the app from a phone; a narrower grant is a key scope like Q3's | MH8, L2-APP | at the awake plan's CP-HW |
| Q9 | "Show Remi in the menu bar" toggle, default on, and a Dock menu | yes | MH2 | now (OQ-1) |
| Q10 | Reset to default: (a) write the default value into the key's line; (b) remove the line, as VS Code removes an entry, so a later release's default applies; and with (b), generate the template with every key commented out at its default | (b) both: an explicit line pins today's value forever, and today's template (`config.ts:814-829`) pins every `[awake]` key; existing files are unchanged, and the page shows "default" honestly | MH6a template, MH6b reset | now (OQ-1) |
| Q11 | Which surfaces get the settings page: (a) the Mac only; (b) also the terminal (`remi config list`, `set`, `reset`, MH6c); (c) also the web client (MHW); (d) also iPhone and iPad | (b) now; (c) after MH7, only if the owner still uses the browser client; (d) later, in its own step | MH6c, MHW | now (OQ-1) |

## 8. Risks and what I am least sure about

| # | Risk | Likelihood | Mitigation |
|---|---|---|---|
| R1 | App Review rejects the app-offered script (MH9) | medium | MH9 last and optional; OG-MH9 |
| R2 | `MenuBarExtra` does not redraw on every change or does not forward the VoiceOver value | medium | MH2 recording; `NSStatusItem` fallback |
| R3 | The system hides the wide sign | medium | 4.7 paths, unconditional |
| R4 | The level 2 machine changes again (Q12 to Q14) | high | user-facing states on the wire; MH8 after L2-APP |
| R5 | The line editor damages a hand-edited file | low | byte-identity property test; refuse odd forms; atomic rename |
| R6 | A downgrade after an app-written key stops every remi command | low | D4.9 recovery; docs warning |
| R7 | The `settings` grant changes the authorized-keys store (ADR 0037) | medium | security review; Q3 (a) is the smaller fallback |
| R8 | A false "not running": LAN-only bind, TLS-only hub | low | stated limits; add by address |
| R9 | Protocol-file collisions with profiles and awake | certain | the collision rules; fixture regeneration |
| R10 | A stale "active" after a hub crash | low | dropped when not connected; `reverting` counts as active |
| R11 | A TestFlight build's sandbox differs from the ad hoc build | medium | OG-MH2 and OG-MH7 on TestFlight builds |
| R12 | The app's hard-coded first-run commands drift from the CLI | low | stable commands; the restart command comes from the hub |
| R13 | Registry, loader, template and docs drift apart | low once MH6a lands | the loader reads the registry; the drift test; the generated reference |
| R14 | Moving the `[awake]` validator onto the registry collides with G2 and L2-HUB, which edit it | high | MH6a never active with them; CO-1 item 7; MH6a migrates keys that merged first |
| R15 | Generic rendering is worse than hand-made copy for a risky setting | medium | titles and descriptions are reviewed in the registry PR like UI copy; `terminal` access for anything that needs more than a control |

Least sure, in order:
1. Whether the per-key `settings` grant (Q3 (b)) is worth an auth-store change and one more terminal step, against (a)'s simplicity.
2. Whether the awake lead puts the status on `hub_status` (CO-1) and accepts the registry as where every keep-awake limit lands (CO-1 item 7); the icon contract does not depend on the first, MH4's scope does, and MH6a's order depends on the second.
3. Apple behavior: saving into Application Scripts through `NSSavePanel` plus `NSUserUnixTask` passing review; `MenuBarExtra` and VoiceOver values; how the system hides a wide item; whether `NSWorkspace` can open or reveal an unreadable path from the sandbox.
4. That session-held keys apply to new sessions only (N5): inferred from the per-process load; MH6b and OG-MH7 confirm it.
5. The level 2 vocabulary: it moved today and may move again; 4.3 is provisional by design.
