# Account profiles in the apps: issue drafts

Design: [ADR 0051](decisions/0051-account-profiles-in-the-apps.md), proposed on 2026-11-14 for #1784; the daemon side is [ADR 0049](decisions/0049-account-switching.md) and its drafts in [account-switching-epic.md](account-switching-epic.md).
Status: drafts, none filed.
They wait on the owner's answers to ADR 0051's open questions Q1 to Q10; where an answer would change a draft, the draft says which criterion flips.
Each issue below has a title and a body for `gh issue create --title "<title>" --body-file <body>`.
Each body sits between `~~~markdown` fences, with one paragraph or list item per line, as GitHub renders it.
Bodies name the daemon phases by their filed numbers (#1748 to #1752); the unfiled ones keep the placeholders `PHASE-2B` and `PHASE-5`, to be replaced when they are filed.

## Map

| Draft | Needs on the daemon | Capability | Platforms | Useful alone |
|---|---|---|---|---|
| Daemon prerequisite (phase 2b) | #1749 | `profile_status` | daemon, shared | sign-in status and guided setup for any client |
| Apps 1: badge, picker, read-only list | #1749 | `session_profiles` | iPhone, iPad, Mac (the web badge and picker are #1749's own scope) | yes: start a session in a chosen profile from any device and see every session's profile |
| Apps 2: account manager | phase 2b | `profile_status` | iPhone, iPad, Mac, web | yes: see and check each profile's sign-in and set one up without guessing commands |
| Apps 3: usage | #1750 | `profile_usage` | iPhone, iPad, Mac (the web panel is #1750's own scope) | yes: see each profile's usage with source and age, and get one warning |
| Apps 4: compaction and brief | #1751 | `session_compaction`, `handoff_brief` | iPhone, iPad, Mac, web | yes: compact a long session or read its brief from a phone |
| Apps 5: confirmed continuation (not filed) | phase 5, after #1752 passes and the owner says go | `session_continuation` | iPhone, iPad, Mac, web | yes, once phase 5 exists |

Phases 1 (#1748), 5A (#1752), 5B and 6 have no app work: phase 1 and 5A add nothing to the wire, 5B is a characterization, and phase 6 is not approved to start (ADR 0049 D9).

## Rules every draft below follows

These restate ADR 0049 D10 and ADR 0051 for the person implementing a slice; they are repeated in each body that needs them.

- No app writes profile configuration, runs a command, or performs a sign-in; the hub writes the commands and the person runs them at the machine (ADR 0051 A1, A3; Q1).
- No email, account identifier, workspace name, profile directory, folder mapping or environment value is decoded, shown, cached or logged by an app, because none is on the wire (ADR 0049 D10, ADR 0051 A10).
- A client checks the machine's capability with `HubSupport.check` (Swift) or `hubSupport` (TypeScript) before it sends any request below, and decodes an unknown enum value as unknown, never as the best case (ADR 0035).
- Tests use the golden fixtures in `packages/shared/tests/fixtures/protocol/`, a hub started from source with a temporary `REMI_HOME`, and fake `claude` and `codex` executables on `PATH` where a probe must answer; nothing that replaces remi's or the app's own logic is mocked.
- Every slice that changes a screen passes the visual gate in `packages/native/VISUAL-ACCEPTANCE.md` with a receipt (iPhone, iPad full screen and the narrowest regular-width window the slice claims, Mac; light and dark; standard text and Accessibility 5; Reduce Transparency and Reduce Motion where anything is translucent or animated) and updates `packages/native/PARITY.md` with what ships.

## Daemon prerequisite

Title: `Profiles phase 2b: sign-in status, check and guided setup for clients`

~~~markdown
Depends on #1749. Design: ADR 0051 (proposed), A2, A3 and A12, and open question Q2 (whether this is its own issue or an amendment to #1749; this draft assumes its own issue). Builds on ADR 0049 D1 (the effective-login check) and D10.

## Goal

A client can show, for each profile a machine shares with devices, whether each harness is signed in with the profile's own sign-in, ask the machine to check again, and get the exact commands to add, sign in to, rename or remove a profile, without the client ever writing configuration, running a command or seeing a path, an email or an environment value. Useful alone: any client, the web one included, can tell a person why a profile cannot start and what to type at the machine.

## Scope

A capability `profile_status` ("check the sign-in of its account profiles") in `PROTOCOL_CAPABILITIES`, listed only when everything below works.

`profile_status_request` and `profile_status_response {profiles: [{id, label, isDefault, selectable, harnesses: [{harness, expects, login, source?, reason?, checkedAt?}]}]}`: every profile shared with devices (remotely visible, #1749), the built-in default first; `selectable` says whether a device may start a session in it; `login` is one of `signed_in`, `signed_out`, `not_own_login`, `unknown`; `source` is a name from a closed list (the variables and settings #1748 checks, such as `ANTHROPIC_API_KEY` and `apiKeyHelper`), never a value; `reason` is one of `harness_missing`, `timeout`, `not_checked`, `error`. Whether profiles that are visible but not selectable are listed follows the owner's answer to ADR 0051 Q6 (recommended: listed, with `selectable: false`).

`profile_check_request {id}`: re-runs #1748's effective-login check for that profile under its exact launch environment, with a deadline; at most one check per profile at a time and one per profile every 15 seconds for all clients together; a request inside the interval gets the last result with its `checkedAt`. The check starts no session, no hook and no login.

`profile_guide_request {action, id, label?, harnesses?, expects?, directory?}` with `action` one of `add`, `login`, `rename`, `remove`, and `profile_guide_response {steps: [{text, command?}]}` or a refusal code: the hub validates the values (id pattern `[a-z0-9][a-z0-9-]{0,31}`; `add` needs a free id, the others an existing one; label 1 to 64 safe code points and not shaped like an email address; `remove` refused while a session runs in that profile) and returns the exact `remi profile` commands for this machine, including the step that lets devices select the profile. It changes nothing. A typed `directory` (adopting an existing configuration directory) appears only inside the returned command and is not stored.

`remi profile` gains `rename` and `remove` if #1748 did not add them; `remove` deletes the configuration table only, never the directory, and says so. `remi profile add` refuses a label shaped like an email address with the same message.

Golden fixtures for every message and refusal, and an ADR 0049 amendment (or ADR 0051's, if the owner prefers) recording the shapes.

## Out of scope

Any configuration write from a client (ADR 0051 Q1). Usage (#1750).

## Acceptance criteria

- [ ] A client that does not see `profile_status` on `hello_ack` sends none of these requests (the shared `hubSupport` test covers the new name), and a daemon without the handler answers `UNKNOWN_MESSAGE` (pinned).
- [ ] With fake `claude` and `codex` executables printing the documented `auth status` and `login status` shapes, each `login` value is produced by the case that should produce it, including `not_own_login` with `source: "apiKeyHelper"` for a placeholder `apiKeyHelper` in the profile's settings, and `unknown` with `reason: "harness_missing"` when `codex` is absent from `PATH`.
- [ ] Two `profile_check_request`s for one profile inside 15 seconds spawn one probe (counted by the fake executable's invocation log).
- [ ] A planted marker string in a profile's directory path, in its `env` values and in the fake executables' output never appears in any frame the daemon sends (a test scans every frame of a full list, check and guide sequence).
- [ ] `profile_guide_request {action: "add"}` with an email-shaped label, a taken id or a malformed id is refused with its own code; with good values it returns commands that, run in the test's own shell against the same temporary `REMI_HOME`, make the profile appear in the next `profile_status_response`.
- [ ] A removal guide for a profile with a running session is refused; `remi profile remove` leaves the directory on disk.
- [ ] A profile that is not remotely visible appears in no response, and `sameAccountAs`-style references to it are impossible because no message names it.

## Test approach

The real daemon and hub from source with a temporary `REMI_HOME` and temporary profile directories; fake `claude` and `codex` executables on `PATH` that record their argv and the names (not values) of credential variables and print the documented shapes; two-sided conformance tests that construct the real daemon handler and the real web and RemiKit decoders (ADR 0014). No real account is needed.

Part of #1784
~~~

## Apps 1

Title: `Profiles in the apps 1: session profile badge, new-session picker and read-only account list (iPhone, iPad, Mac)`

~~~markdown
Depends on #1749 (the `session_profiles` capability, `create_session_request.profile`, and `profile: {id, label}` on session entries, `hello_ack` and the create result). Design: ADR 0051 (proposed), A1, A2 (list only), A4, A11, A12 and the "Profile picker" and "Session badge" state tables. The web client's badge and picker are already in #1749's scope; this issue is the native apps.

## Goal

From an iPhone, an iPad or a Mac, a person starts a session in a profile the machine offers, with the machine's own default preselected and its reason shown, and sees which profile every session runs in. Useful alone, and the base every later slice builds on.

## Scope

RemiKit: `AccountProfile` models (a name distinct from the machine route profile of ADR 0039) for `session_profiles_response`, the session entry's `profile` and the create result; `HubCapability.sessionProfiles` with its "cannot" text; decoding of an unknown `default.source` or `profile.state` as nil.

New-session sheet (iPhone `PhoneNewSessionSheet`, Mac `MacLiveNewSessionSheet`): a Profile row in the Agent section, shown only when the selected machine lists `session_profiles`. When the directory or repository changes, the sheet sends `session_profiles_request {directory}` and preselects the returned default with its reason ("From this folder's mapping", "This machine's default", "Built-in default sign-in"). Profiles that do not configure the chosen harness are not offered. The choice is never stored; each sheet starts from the hub's answer. A refusal from the hub at create is shown in place with the draft kept.

Badge: the profile label beside the harness in the shared session row (`RemiUI/Rows.swift`: iPhone drawer, iPad sidebar, Mac session column), the Board tile subtitle (`RemiUI/BoardTile.swift`), the Mac session detail metadata, and the iPhone session view and its Session actions menu. Text only, escaped, never colored. While the machine shares only the default and the session uses it, no badge on rows and tiles and "Default sign-in" in the session detail (ADR 0051 Q3; if the owner answers Q3 (b), the badge always shows and the criterion below flips). Removed and changed states only if #1749 ships `profile.state`.

Read-only Accounts list: in the iPhone and iPad Machines sheet, each machine's section gains Accounts with a count; on the Mac, the machine detail in Preferences gains an Accounts card. Rows show the label, the id and the harnesses; the screen says that sign-in status needs a newer remi on that machine (`HubSupport`'s message for `profile_status`) until Apps 2.

Search in the drawer and the Mac session column matches profile labels.

## Out of scope

Sign-in status, Check and the setup guides (Apps 2); usage (Apps 3); the web client (#1749).

## Acceptance criteria

- [ ] `FixtureConformanceTests` decode every #1749 golden fixture that carries a profile, read from the repository's files; a fixture variant with an unknown `default.source` decodes with the reason as nil and the sheet shows no reason line.
- [ ] With the `hello_ack` and `hello_ack_legacy` fixtures (no `session_profiles`), the presentation models produce no Profile row, no badge, and an Accounts entry whose text is `HubSupport`'s message naming the capability.
- [ ] Against a hub started from source that lists `session_profiles`, the encoded `create_session_request` carries the chosen `profile`; against one that does not, it carries no `profile` field (the test inspects the frame).
- [ ] Changing the directory in the sheet sends a new `session_profiles_request` and replaces the preselection; relaunching the app leaves no stored profile choice (the test checks `UserDefaults` and the store's persisted snapshot for any profile key).
- [ ] A profile without the chosen harness is not offered (table test over the fixture's `harnesses`).
- [ ] A label holding a bidirectional control character from a fixture renders escaped in the row, the tile and the sheet, and VoiceOver reads "Profile" followed by the escaped label.
- [ ] With only the default shared, rows and tiles have no badge and the session detail says "Default sign-in" (flips if Q3 is answered (b)).
- [ ] The visual gate passes with a receipt; PARITY.md gains "Session profile badge", "Profile picker" and "Account list (read only)" rows saying what ships.
- [ ] `swift test --package-path packages/native/RemiKit`, the Mac `xcodebuild ... build test` and the iPhone `xcodebuild ... build` pass, and `typos` is clean.

## Test approach

Swift Testing on RemiKit and RemiUI presentation models with the golden fixtures; one integration test against a hub from source with a temporary `REMI_HOME` and two configured profiles (fake `claude` on `PATH`), for the outgoing frame and the default resolution; previews at the visual gate's sizes. No mock replaces the store, the connection or the decoder.

Part of #1784
~~~

## Apps 2

Title: `Profiles in the apps 2: account manager with sign-in status, Check and guided setup (iPhone, iPad, Mac, web)`

~~~markdown
Depends on PHASE-2B (`profile_status`) and on Apps 1. Design: ADR 0051 (proposed), A1, A2, A3, A10, A11 and the "Accounts list", "Profile detail" and "Add, Rename, Remove and sign-in guides" state tables; open questions Q1 (no configuration writes from apps) and Q6 (visible but not selectable profiles).

## Goal

On every client, a person sees each profile's sign-in for each harness with its age, asks the machine to check again, and adds, signs in to, renames or removes a profile by running commands the machine wrote for them. The app never writes configuration, never runs a command and never signs in. Useful alone: the most common failure ("this profile is not signed in" or "another credential would be used") is visible and fixable from a phone.

## Scope

RemiKit and the web client: models and decoders for `profile_status_response` and `profile_guide_response`; `HubCapability.profileStatus`; an unknown `login` decodes as unknown, never as signed in.

Accounts list and Profile detail as in ADR 0051 A2: per harness, signed in, signed out, not its own sign-in (with the source name only) or unknown (with the reason), each in words and a symbol of distinct shape; Check; whether devices may start sessions in the profile; the sessions on it (counted from the session list).

Guides (Add, sign-in, Rename, Remove): a short form, `profile_guide_request`, then the hub's steps with Copy and Share and "Check now". The Add form suggests an id from the label. Refusals are shown in words. Remove says the directory stays.

Picker warnings (Apps 1's Profile row): with a known `signed_out` or `not_own_login`, the row shows the reason and the command and Create is disabled until a Check passes; with `unknown`, Create stays enabled.

Offline: the last-known list, dimmed and captioned with its age; Forget machine clears it.

Web: Settings gains an Accounts section for the connected machine with the same list, detail, Check and guides, behind `hubSupport(['profile_status'])`.

Placement: iPhone and iPad in the Machines sheet (list and detail side by side in regular width); Mac in Preferences, Machines, the machine detail's Accounts card, plus "Accounts and Usage…" in the machine row's context menu and a "Show Accounts and Usage" menu command whose shortcut is checked against `RemiMacCommandRules`; web in Settings.

## Out of scope

Configuration writes from any client (Q1). Usage (Apps 3).

## Acceptance criteria

- [ ] Each `login` value and each `reason` in the PHASE-2B fixtures maps to its own text and symbol (table test on the presentation model); an unknown value shows "Not checked", never "Signed in".
- [ ] Check sends one `profile_check_request`, shows "Checking…" until the response, and a second press inside the hub's interval shows the last result with its age; the integration test against a hub from source with a fake `claude` counts one probe.
- [ ] The Add guide against a hub from source returns commands; the test runs them in its own shell with the same temporary `REMI_HOME`, presses Check now, and sees the profile listed as signed in (the fake `claude` answers signed in for that directory).
- [ ] Copy places exactly the command text on the pasteboard (iPhone, Mac) or the clipboard (web); no code path in the app or the web client executes a command (a source guard test over the new files).
- [ ] An email-shaped label and a taken id are refused with the hub's message and the form keeps its values.
- [ ] A planted marker in the test hub's profile directory path and `env` never appears in any frame the client receives or in anything it persists (integration test scanning frames and the persisted store).
- [ ] With the machine offline, the list shows the last-known rows with their age and no actions; Forget machine removes them (store test).
- [ ] VoiceOver reads each harness row as one element with its state and age; at Accessibility 5 commands wrap or scroll sideways without truncation (previews in the visual gate).
- [ ] The visual gate passes with a receipt, PARITY.md gains an "Account manager" row, the native gates and the web gates (`bunx biome check`, every type check including the web package's, `bun test`) pass, and `typos` is clean.

## Test approach

Swift Testing and the web client's tests on presentation models fed by the PHASE-2B golden fixtures; integration tests against a hub from source with temporary profile directories and fake `claude` and `codex` executables; two-sided conformance with the real daemon handler (ADR 0014). No real account is needed; no mock replaces the store, the connection or the decoders.

Part of #1784
~~~

## Apps 3

Title: `Profiles in the apps 3: usage per profile, the usage warning and Claude Code's limit wait (iPhone, iPad, Mac)`

~~~markdown
Depends on #1750 (`profile_usage`, the usage snapshot and its updates, the `usage_warning` push kind) and on Apps 1. Design: ADR 0051 (proposed), A5, A6, A9, A10, A11 and the "Usage section and view" and "Session badge" state tables; open questions Q7 (legacy push text) and Q8 (no Refresh). The web usage panel and warning are #1750's own scope; this issue is the native apps.

## Goal

A person sees, for each profile on each machine, how much of each usage window is spent, where the number came from and how old it is, gets one warning before a limit, and sees when Claude Code is waiting for a reset on its own. No number is invented, extrapolated, summed across profiles or fetched on demand. Useful alone.

## Scope

RemiKit: models for `profile_usage_response` and `profile_usage_update`, the session entry's `limitWait`, and the sealed push kind `usage_warning` (a new byte in `NativePushCodec.Kind`, informational, no category).

Usage section in the Profile detail and a machine-wide Usage view: one row per window with its name from the reported length, "N% used" as text and a bar, the reset time in the viewer's time zone, the source in words and the observation's age; "Usage unknown" with what updates it; "Billed per request"; "Blocked by Codex" when `ordinaryUsageAllowed` is false, whatever the percentages say; "Reset at …; no reading since" when the reset has passed, never 0%; "Usage cleared because the account under this profile changed at …"; Codex's plan and Claude's declared plan; Codex buckets collapsed as "Other limits reported by Codex" with escaped ids; the thresholds as text; "Same account as …" or "Cannot tell for Claude"; a note that the same account on another machine appears there separately. No Refresh control.

Markers: on a Board tile and a session row, a gauge symbol and "Weekly 91%" only while the profile's largest current window is at or above its warning threshold and its reset is in the future, in the neutral tone. On the session, "Waiting for the usage reset; Claude Code continues at …" from `limitWait`.

Warning: the per-device `usage_warning` switch in iPhone Preferences and Mac Settings, registered on `register_device_token` only by builds that can show it; the notification opens the profile's usage; an Inbox notice row in the neutral tone, dismissible per device; the menu bar extra is unchanged.

Placement: iPhone, the profile sheet from the badge and the Machines sheet; iPad, a popover from the badge; Mac, a popover from the badge and the Accounts card.

## Out of scope

Any on-demand usage fetch (Q8). The continuation offer (Apps 5).

## Acceptance criteria

- [ ] Every #1750 golden fixture decodes; a window without `usedPercent` shows "Usage unknown" for that window; an unknown `source` shows "Reported by the machine" rather than a guessed harness.
- [ ] With a fixed clock, a window whose `resetsAt` is in the past renders "Reset at …; no reading since" and never a percentage (table test).
- [ ] `ordinaryUsageAllowed: false` with `usedPercent: 10` renders "Blocked by Codex" (presentation test).
- [ ] The accessibility value of a usage row contains the window name, the percentage or "usage unknown", the reset time, the source and the age (unit test); at Accessibility 5 the bars are replaced by text (previews).
- [ ] The tile and row marker appears exactly when the largest current window is at or above the profile's warning threshold with a future reset (table test over both sides of the threshold and a passed reset).
- [ ] A sealed `usage_warning` capsule built by the daemon's real encoder decodes in `NativePushCodec`, produces an informational payload with no category, and offers no notification actions (test on the category registry); a capsule of an unknown kind byte is still rejected as malformed.
- [ ] The device registers for `usage_warning` only when its switch is on, and the switch's state is sent on `register_device_token` (integration against a hub from source).
- [ ] The Inbox notice row uses the neutral tone, never the attention accent (presentation test), and dismissing it on one device leaves it on another (two-store test).
- [ ] No Refresh control exists in the usage views (view inspection or source guard test).
- [ ] The visual gate passes with a receipt; PARITY.md gains "Usage per profile" and "Usage warning" rows; the native gates pass and `typos` is clean.

## Test approach

Swift Testing on presentation models fed by #1750's golden fixtures and a fixed clock; the daemon's real sealed-push encoder for the push test; integration against a hub from source where a stand-in app-server or a recorded status-line file supplies observations, as #1750's own tests do. The owner-run check that the panel agrees with `/usage` and `/status` within one turn is #1750's gate, rechecked once on a signed device for this slice.

Part of #1784
~~~

## Apps 4

Title: `Profiles in the apps 4: compact a session and read its handoff brief (iPhone, iPad, Mac, web)`

~~~markdown
Depends on #1751 (`session_compaction`, `handoff_brief`). Design: ADR 0051 (proposed), A7, A10 and A12.

## Goal

From any client, a person compacts a session on its current account or reads a handoff brief of the work so far. Useful alone: a long session can be compacted from a phone.

## Scope

The session's actions menu (iPhone Session actions, iPad, Mac, the web chat header menu) gains "Compact now" and "Handoff brief", each shown only when the machine lists its capability.

"Compact now" sends `compact_request`; while it runs the item reads "Compacting…"; a refusal (a turn running, a prompt up, a Codex approval live, a usage-limit wait) is shown in words from its code; the deadline shows "Not confirmed; the session is unchanged"; a Claude summary is shown in a sheet to the requesting device only.

"Handoff brief" sends `handoff_brief_request` and shows the brief read-only, with what it could not read and Copy.

Summaries and briefs are held in memory only and cleared when their sheet closes.

## Acceptance criteria

- [ ] Without the capability the menu item is absent (presentation test with `hello_ack_legacy`).
- [ ] Each refusal code in #1751's fixtures maps to its own sentence (table test), and a refused request sends nothing else.
- [ ] A second press while a compaction is in flight sends nothing (store test).
- [ ] After the summary or brief sheet closes, the store holds no copy and nothing was written to the app's container (store test and a container listing in the integration test).
- [ ] Against a hub from source with a fake `claude` that records its input, "Compact now" from an idle session reaches the guarded write path and the result is shown; from a session with a prompt up it is refused with the reason.
- [ ] The visual gate passes with a receipt; PARITY.md gains a "Compact and handoff brief" row; native and web gates pass and `typos` is clean.

## Test approach

Presentation tests on #1751's fixtures; integration against a hub from source with fake `claude` and the stand-in Codex app-server, as #1751's tests do. The real `/compact` run is #1751's owner gate.

Part of #1784
~~~

## Apps 5 (not filed: follows phase 5, which follows #1752 passing and the owner's go)

Title: `Profiles in the apps 5: confirm a continuation on another of the person's profiles (never from the lock screen)`

~~~markdown
Depends on PHASE-5 (`session_continuation`), Apps 2 and Apps 3. Design: ADR 0051 (proposed), A8, A10, A11 and the "Continuation confirm sheet" state table; ADR 0049 D5, D7, D8 and the owner's answer to Q9 (a phone starts a continuation only with an in-app confirmation, never from the lock screen); ADR 0051 Q9 (the Inbox row).

## Goal

When a profile nears or hits its limit, a person sees one offer for that profile, reviews in the app what will happen, what differs between the two profiles and what the new session will not have, and confirms a continuation onto another of their own profiles; nothing happens without that confirmation, and nothing can be confirmed from a notification.

## Scope

RemiKit and the web client: `continuation_offer`, `continuation_preview_request/response`, `continue_session_request`, `continuation_progress`, `continue_session_response`, and the session entries' `continuedFrom` and `supersededBy`.

The offer is never a `question` and never enters the question pipeline: an Inbox row ("Work on Studio is at 95% of its weekly window; 2 sessions") and a banner in each listed session, with "Compact now" (idle only), "Continue on" each eligible profile with its usage, age and sessions, "Wait for the reset" when Claude Code's own wait runs, and the harness's own options as commands for the terminal. The attention accent only while a session on that profile is stopped at the limit.

Confirm sheet (full sheet on iPhone, form sheet on iPad, window sheet on Mac, modal on web): loads the preview, then shows what happens, what differs (rule texts and hook commands, escaped, collapsed by count), what the new session will not have, "Billed per request" for an API-key target, and the sessions on the target; one acknowledgment switch each for a broader target, unknown usage and unknown same-account, off by default; the confirm button is never the default button, is disabled until the preview loaded and every required acknowledgment is on, and sends the preview's id. Expired or changed previews reload. Progress shows each reported step; the result links both sessions or names the failed step and says the source is still resumable.

Never from the lock screen: no notification category or action for it; notification response handlers and the Mac menu bar extra only open the sheet.

Hook commands, briefs and the preview are held in memory only and cleared when the sheet closes.

## Acceptance criteria

- [ ] A `continuation_offer` fixture fed through the client's message handling never produces a question card, a notification category or a lock-screen action (test on the question pipeline and the category registry).
- [ ] A source guard test shows that no notification response handler and no menu bar extra action in the native apps, and no notification handler in the web client, can send `continue_session_request`; the hub's refusal of a request through the notification answer endpoint and through Telegram is PHASE-5's own criterion.
- [ ] The confirm button is disabled before the preview arrives and while any required acknowledgment is off, and is never the default button (state test and, on the Mac, a keyboard test that Return does not confirm).
- [ ] Against a hub from source with two profiles and fake `claude`, a confirmed request carries the preview id; changing the target profile's settings between preview and confirm makes the hub refuse, and the sheet reloads the preview.
- [ ] A failure injected at each step through the fake executables is shown with its step name, and the client sends no further request on its own.
- [ ] The Inbox row uses the attention accent only when a listed session is stopped at the limit (presentation test over each trigger).
- [ ] After the sheet closes, the store holds no hook command, brief or preview (store test).
- [ ] The visual gate passes with a receipt; PARITY.md gains a "Confirmed continuation" row; native and web gates pass and `typos` is clean.
- [ ] Owner-run gate: on a signed iPhone, a real continuation between two of the owner's profiles is confirmed in the app, and a notification for the same offer offers no action.

## Test approach

Presentation and store tests on PHASE-5's golden fixtures; integration against a hub from source with two temporary profiles and fake `claude` and `codex` executables that record their environment and first input and fail on command; a source guard test for the notification paths. The real continuation needs two real logins and is the owner's gate.

Part of #1784
~~~
