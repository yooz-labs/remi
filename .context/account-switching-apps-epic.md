# Profiles in the apps: issue drafts

Design: [ADR 0051](decisions/0051-account-profiles-in-the-apps.md), proposed on 2026-11-14 for #1784; the owner answered its questions Q1 to Q11 the same day.
The daemon side is [ADR 0049](decisions/0049-account-switching.md) and its drafts in [account-switching-epic.md](account-switching-epic.md).

Status: on 2026-11-14 the manager applied the amended #1749 and the additions to #1748, #1750 and #1751 (the old bodies are backed up in the manager's scratchpad). The #1752 addition is not adopted (Q11), the phase 5 draft is applied when that issue is filed, and Apps 1 to 4 were filed as #1788, #1789, #1790 and #1791 (each with the unknown-value acceptance item for profiles that run the Claude Code harness without Claude credentials); Apps 5 is not filed. The same item was added to #1749 and #1750.
This file holds three kinds of text, each for the manager to apply with `gh`; workers never edit issues:

1. the proposed amended title and body of the filed #1749 (owner answer Q2), to apply with `gh issue edit 1749 --title "<title>" --body-file <body>`;
2. proposed additions to the filed #1748, #1750 and #1751 and to the unfiled phase 5 draft, each to be merged into that issue's body;
3. five app issues, each a title and a body for `gh issue create --title "<title>" --body-file <body>`.

Each body or addition sits between `~~~markdown` fences, with one paragraph or list item per line, as GitHub renders it.
Bodies name the daemon phases by their filed numbers (#1748 to #1752); the unfiled phase 5 keeps the placeholder `PHASE-5`.

## Map

| Draft | Needs on the daemon | Capability | Platforms | Useful alone |
|---|---|---|---|---|
| Apps 1: badge, picker, filter chip, read-only list | #1749 as amended | `session_profiles` | iPhone, iPad, Mac (the web parts are in #1749) | yes: start a session in a chosen profile from any device, see and filter every session's profile |
| Apps 2: profile manager | #1749 as amended | `profile_status` | iPhone, iPad, Mac (the web Profiles section is in #1749) | yes: see and check each profile's sign-in and settings, and set one up from copyable commands |
| Apps 3: usage and Refresh | #1750 with the additions below | `profile_usage` | iPhone, iPad, Mac (the web panel is in #1750) | yes: see and refresh each profile's usage with source, age and reset time, and get one warning |
| Apps 4: compaction and brief | #1751 | `session_compaction`, `handoff_brief` | iPhone, iPad, Mac, web | yes: compact a long session or read its brief from a phone |
| Apps 5: confirmed continuation (not filed) | phase 5, after #1752 passes and the owner says go | `session_continuation` | iPhone, iPad, Mac, web | yes, once phase 5 exists |

Phases 1 (#1748), 5A (#1752), 5B and 6 have no app slice: phase 1 and 5A add nothing to the wire, 5B is a characterization, and phase 6 is not approved to start (ADR 0049 D9).

## Rules every draft follows

These restate ADR 0049 D10 and ADR 0051 for the person implementing a slice; each body repeats the ones it needs.

- Every interface text says "profile" (ADR 0051 Q4); "account" only where a text means the provider's account itself (the same-account relation, the account under a profile changing, a plan).
- No client writes profile configuration, runs a command or performs a sign-in; the hub writes the commands, the client shows them with a Copy action, and the person runs them at the machine (Q1).
- No email, account identifier, workspace name, profile directory, folder mapping or environment value is decoded, shown, cached or logged by a client, because none is on the wire (ADR 0049 D10, ADR 0051 A13, Q5).
- A client checks the machine's capability with `HubSupport.check` (Swift) or `hubSupport` (TypeScript) before it sends any request below, and decodes an unknown enum value as unknown, never as the best case (ADR 0035).
- Tests use the golden fixtures in `packages/shared/tests/fixtures/protocol/`, a hub started from source with a temporary `REMI_HOME`, and fake `claude` and `codex` executables on `PATH` where a probe must answer; nothing that replaces remi's or the app's own logic is mocked.
- Every slice that changes a screen passes the visual gate in `packages/native/VISUAL-ACCEPTANCE.md` with a receipt (iPhone, iPad full screen and the narrowest regular-width window the slice claims, Mac; light and dark; standard text and Accessibility 5; Reduce Transparency and Reduce Motion where anything is translucent or animated) and updates `packages/native/PARITY.md` with what ships.
- **Documentation (Q1).** A copyable, verified profile setup guide ships with each feature and never before it exists. On the daemon side, the gate is the "daemon documentation gate" below; on the app side, the "app documentation gate".

The daemon documentation gate, as a checkbox for each daemon issue that adds a command, a default or a behavior a person relies on:

~~~markdown
- [ ] Documentation: the profile setup guide (`docs/tools/remi/guides/profiles.md`) and the command reference (`docs/tools/remi/commands/profile.md`) in the `yooz-docs` repository document every default and command this phase ships, each command in a code block the site's copy button covers; every command and its output on those pages come from running the shipped build against a temporary `REMI_HOME`, recorded in the docs pull request; the docs pull request merges for the release that ships the feature and not before, and the pages describe nothing that is not built.
~~~

The app documentation gate, as a checkbox for each app slice:

~~~markdown
- [ ] Documentation: every command the slice shows comes from the hub's answer and has a Copy action; the screen links to the docs page for this feature, which is published for the release that ships it (no link to a page that does not exist); that page describes the screens this slice ships and nothing unbuilt.
~~~

## #1749 as amended (owner answer Q2; to apply with `gh issue edit`)

Title: `Profiles phase 2: profile paths, remote choice, the session badge and the profile manager contract`

~~~markdown
Depends on Profiles phase 1. Completes the remaining scope of #1157 (`profile-paths`, `profile-phone`). Design: ADR 0049 (accepted as the direction, 2026-11-13), D1, D6 and D7; ADR 0051 (proposed, owner answers of 2026-11-14), A1 to A6, A13 and A15. Amended by the owner's answer to ADR 0051 Q2: sign-in status, Check, the setup guides and the read-only profile settings join this phase instead of a separate issue.

## Goal

Everything remi does for a session follows that session's profile; a phone can create a session in a profile and see which profile each session uses; the person decides which profiles' sessions remote devices may see and which they may start sessions in; and any client can show each profile's sign-in, ask the machine to check it again, show its settings read only, and give the person the exact commands to add, sign in to, rename, remove or list profiles, without any client writing configuration, running a command or seeing a path, an email or an environment value.

## Owner decisions this phase follows

ADR 0049 (2026-11-13): Q13, profiles are free in remi, including remote choice; Q9 (for the later continuation phase), a phone acts on another profile only with an in-app confirmation, never from the lock screen, so the profile fields added here carry no lock-screen action.

ADR 0051 (2026-11-14): Q1, no client writes profile configuration, and the commands and defaults are documented on the docs site with the release that ships them; Q2, this amendment; Q3, no badge on session rows and tiles while only the default is shared; Q4, every interface text says "profile"; Q5, never an email; Q6, profiles devices may see but not select are listed in the profile manager, and the new-session picker lists only selectable ones; Q10, a profile filter chip in session lists.

## Scope

Transcript discovery scans each configured profile's `projects/` directory, not only `~/.claude/projects` (`transcript/transcript-discovery.ts:29`); a Claude session's transcript path comes from its profile.

The status line installer writes to the profile's `settings.json`, not only `~/.claude/settings.json` (`cli/statusline-installer.ts:81`), with the same "only when no `statusLine` is set" rule.

File-download protection covers every configured profile directory, adopted ones included (`cli.ts:1530-1531`, ADR 0045 root policy).

Remote visibility: decide and implement a per-profile `remote_visible` setting (proposed default: visible, today's behavior); sessions and transcripts of a profile that is not remotely visible are not listed to remote clients, because discovery across every profile would otherwise show every profile's sessions to every enrolled device. Remote selectability (which profiles a device may start sessions in) as the backend plan proposes.

Protocol, part 1, capability `session_profiles` ("start a session in a chosen profile"): `session_profiles_request {directory?}` and response `{profiles: [{id, label, harnesses}], default: {id, source}}` for remotely selectable profiles only, `source` one of `folder`, `machine_default`, `built_in`; `create_session_request.profile`; the session list entry, `hello_ack` and the create result carry `profile: {id, label, state?}`, `state` one of `current`, `changed`, `removed`. Limits as the backend plan proposes (32 profiles, id `[a-z0-9][a-z0-9-]{0,31}`, label 1 to 64 safe code points and not shaped like an email address, 64 KiB frames).

Protocol, part 2, capability `profile_status` ("show or check the sign-in of its profiles"), listed only when everything in this part works:

- `profile_status_request` and response `{profiles: [{id, label, isDefault, selectable, harnesses: [{harness, expects, login, source?, reason?, checkedAt?}]}]}`: every remotely visible profile, the built-in default first, with `selectable` per ADR 0051 Q6; `login` one of `signed_in`, `signed_out`, `not_own_login`, `unknown`; `source` a name from a closed list (the variables and settings Profiles phase 1 checks, such as `ANTHROPIC_API_KEY` and `apiKeyHelper`), never a value; `reason` one of `harness_missing`, `timeout`, `not_checked`, `error`.
- `profile_check_request {id}`: re-runs Profiles phase 1's effective-login check for that profile under its exact launch environment, with a deadline; at most one check per profile at a time and one per profile every 15 seconds for all clients together; a request inside the interval gets the last result with its `checkedAt`. The check starts no session, no hook and no login.
- `profile_settings_request {id}` and response: the default harness; per harness, that it is configured and the sign-in it expects; `args` as escaped text, with a value starting with `/` or `~` replaced by a marker; `env` and `folders` as counts only; whether it is the machine's default, remotely visible and selectable; and the harness's own rules, read by key only: Claude Code `permissions.allow`, `ask` and `deny` rule texts and `hooks` counts per event from the profile's user `settings.json`, Codex `approval_policy`, `sandbox_mode` and `model_provider` from its `config.toml`; never `env`, `apiKeyHelper`, hook commands or any other key; `rulesError` (`missing`, `invalid`) when a file cannot be read.
- `profile_guide_request {action, id?, label?, harnesses?, expects?, directory?}`, `action` one of `add`, `login`, `rename`, `remove`, `list`, and response `{steps: [{text, command?}]}` or a refusal code: the hub validates the values (`add` needs a free, well-formed id, the others an existing one; the label rule above; `remove` refused while a session runs in that profile) and returns the exact `remi profile` commands for this machine, including the step that lets devices select the profile. It changes nothing. A typed `directory` (adopting an existing configuration directory) appears only inside the returned command and is not stored.

`remi profile` gains `rename` and `remove` if Profiles phase 1 did not add them; `remove` deletes the configuration table only, never the directory, says so, and is refused while a session runs in that profile. `remi profile add` refuses a label shaped like an email address.

Golden fixtures for every message and refusal, and an ADR 0049 amendment recording the shapes (ADR 0051 A15 lists them).

Web client: a profile badge on the session card and chat header, with none on the card while only the default is shared; a profile picker in the new-session sheet that preselects the hub's default with its reason and offers only selectable profiles; a profile filter chip above the session list that narrows only that list; a Profiles section in Settings with each profile's sign-in, Check, its settings read only, the defaults, and the guides with Copy. Telegram shows the label.

## Acceptance criteria

- [ ] Two sessions in two profiles both reach the phone's chat view with their own transcripts.
- [ ] The status line works in each profile's sessions.
- [ ] A remote `create_session_request.profile` naming a profile that is not remotely selectable is refused before a port is probed or anything is spawned; one naming a selectable profile starts the child in it.
- [ ] Against a daemon without the capability (which would ignore the field), the web client hides the picker.
- [ ] A profile with `remote_visible = false` has none of its sessions or transcripts in any remote list and appears in no `session_profiles_response` or `profile_status_response`, and the decision and its default are recorded in the ADR amendment.
- [ ] No response or log line carries a local path, email or environment value of a profile: a planted marker string in a profile's directory path, its `env` values, its `settings.json` (`env`, `apiKeyHelper`, a hook command) and the fake executables' output never appears in any frame of a full list, check, settings and guide sequence.
- [ ] Downloads refuse a file under any configured profile directory, active or not.
- [ ] A client that does not see `session_profiles` or `profile_status` sends none of their requests (the shared `hubSupport` tests cover both names), and a daemon without a handler answers `UNKNOWN_MESSAGE` (pinned).
- [ ] With fake `claude` and `codex` executables printing the documented `auth status` and `login status` shapes, each `login` value is produced by the case that should produce it, including `not_own_login` with `source: "apiKeyHelper"` for a placeholder `apiKeyHelper` in the profile's settings, and `unknown` with `reason: "harness_missing"` when `codex` is absent from `PATH`.
- [ ] Two `profile_check_request`s for one profile inside 15 seconds spawn one probe (counted by the fake executable's invocation log).
- [ ] `profile_settings_response` returns the permission rule texts and hook counts of a test profile, replaces a path-like argument value, gives `env` and `folders` as counts, and sets `rulesError: "invalid"` for an unparsable `settings.json`.
- [ ] `profile_guide_request {action: "add"}` with an email-shaped label, a taken id or a malformed id is refused with its own code; with good values it returns commands that, run in the test's own shell against the same temporary `REMI_HOME`, make the profile appear in the next `profile_status_response`. `remi profile add` refuses the same email-shaped label.
- [ ] A removal guide for a profile with a running session is refused; `remi profile remove` leaves the directory on disk.
- [ ] The web picker offers only selectable profiles and preselects the hub's default with its reason; the web filter chip narrows only the session list; the web session card shows no badge while only the default is shared.
- [ ] Documentation: the profile setup guide (`docs/tools/remi/guides/profiles.md`) and the command reference (`docs/tools/remi/commands/profile.md`) in the `yooz-docs` repository document every default and command this phase ships, each command in a code block the site's copy button covers; every command and its output on those pages come from running the shipped build against a temporary `REMI_HOME`, recorded in the docs pull request; the docs pull request merges for the release that ships the feature and not before, and the pages describe nothing that is not built.

## Test approach

Temporary profile directories holding synthetic transcripts read by the real discovery code; the real installer against temporary settings files; fake `claude` and `codex` executables on `PATH` that record their argv and the names (not values) of credential variables and print the documented shapes; two-sided conformance tests that construct the real daemon handler and the real web decoder (ADR 0014); hub integration with fake `claude` recording its environment; web component tests for the badge, picker, filter chip and Profiles section. Owner-run gate: a session started from the phone in a mapped folder lands in the right profile. No real account is needed for anything else.

Part of #1157
~~~

## Proposed additions to the other daemon issues

### #1748 (Profiles phase 1)

~~~markdown
## Additions (ADR 0051, owner answers of 2026-11-14)

Scope: `remi profile add` refuses a label shaped like an email address, with "Use a name such as Work, not an email address" (ADR 0051 A13).

- [ ] `remi profile add` with an email-shaped label is refused and writes nothing.
- [ ] Documentation: the profile setup guide (`docs/tools/remi/guides/profiles.md`) and the command reference (`docs/tools/remi/commands/profile.md`) in the `yooz-docs` repository document the defaults this phase ships (the built-in default that changes nothing, the selection precedence, where remi creates a profile's directories) and every `remi profile` command it ships (`ls`, `add`, `show`, `login`), each command in a code block the site's copy button covers; every command and its output come from running the shipped build against a temporary `REMI_HOME`, recorded in the docs pull request; the docs pull request merges for the release that ships the feature and not before, and the pages describe nothing that is not built.
~~~

### #1750 (Profiles phase 3)

~~~markdown
## Additions (ADR 0051 A8 and A9, owner answers Q7 and Q8 of 2026-11-14)

Refresh on request (Q8): `profile_usage_refresh_request {id}` under `profile_usage`, answered with the usage response plus `refresh: {id, outcome}` and the profile's `refreshedAt`. Codex: the hub calls `account/rateLimits/read` through the app-server client of a running remi Codex session on that profile (the most recently active one) and merges the answer by observation time; with no such session it starts no session and no app-server and answers `no_live_session`. Claude Code: no credential-free on-demand source is verified (ADR 0051 Q11), so the hub re-reads the latest status-line reading of every running session on the profile and keeps the newest per window (`reread`); it types nothing into a session and runs no command. API key: `not_applicable`. Per profile, at most one refresh in flight and one hub read every 30 seconds for all clients together (`too_soon` returns the current snapshot); a 10-second deadline for the Codex read (`timeout`); `error` otherwise; a failed refresh never clears a number. The ADR 0049 amendment records the added read cadence (D2 named attach and each turn end).

`usage_warning` text (Q7, the owner's informed decision against the recommendation): the title is "<profile label>: usage warning" and the body "<harness> <window> window <N>% used; resets <time and zone>", the reset clause left out when the reset time is unknown; nothing else (no machine or session name, path, email, account id or plan); escaped and bounded like other push text. One function builds it and both the legacy and the secure sender receive its output unchanged, as `buildTurnFailedText` does for `turn_failed`. Until the R7 gate retires the legacy push (or the machine's one-way activation latch retires it earlier), this text, the profile label, harness, window, percentage and reset time, is visible in plaintext to the signaling Worker and to Apple's push service; on the secure path they see delivery metadata only. Collapse key `usage-warning-<profile id>-<window id>`; device preference `pushPrefs.usageWarning`, on by default.

`profile_settings_response` gains `thresholds: {warn, offer}`.

Web client: the usage panel gains Refresh, showing each outcome in words, and every number shows its source, age and reset time.

- [ ] Against the stand-in app-server, each allowed Codex refresh sends exactly one `account/rateLimits/read`; two refreshes inside 30 seconds send one; a profile with no running Codex session answers `no_live_session` and the spawn log shows no session or app-server started.
- [ ] A Claude Code refresh leaves the fake `claude`'s input log empty and answers `reread` with the newest recorded reading.
- [ ] An API-key profile answers `not_applicable`; a Codex read past 10 seconds answers `timeout` and the previous numbers remain with their age.
- [ ] For one warning, the legacy `/push` body (captured by a local HTTP sink) and the secure sender's input carry identical titles and bodies; a source guard test finds no other construction of `usage_warning` text.
- [ ] The text holds the label, harness, window, percentage and reset time and nothing else: a scan with planted markers in the machine name, session name, profile directory and account identifiers finds none of them.
- [ ] Documentation: the usage section of the profile setup guide in `yooz-docs` explains what each number is, its source, age and reset time, what Refresh does for each harness, the `usage_warning` text, and that until the legacy push is retired that text is visible to the Worker and Apple in plaintext; it merges for the release that ships the feature and not before, and describes nothing that is not built.
~~~

### #1751 (Profiles phase 4)

~~~markdown
## Additions (ADR 0051, owner answers of 2026-11-14)

- [ ] Documentation: the profile setup guide in `yooz-docs` gains a section on compacting a session and reading its handoff brief, with the refusals and what each means; it merges for the release that ships the feature and not before, and describes nothing that is not built.
~~~

### #1752 (Profiles phase 5A), not applied: the owner answered ADR 0051 Q11 with no, so (b) is not adopted

~~~markdown
## Addition (ADR 0051 Q11 (b))

Claude Code: in an idle session, does the status line's documented run "when a window reaches its reset time" record a new `rate_limits` reading, or the old one? Observed opportunistically on the owner's machine with the same redaction as the other questions.

- [ ] The answer recorded in `.context/` with the Claude Code version, and a go or no-go for treating that run as a credential-free refresh for Claude Code.
~~~

### Phase 5 draft (not filed; add when it is filed)

~~~markdown
- [ ] Documentation: the profile setup guide in `yooz-docs` gains a section on continuing a session on another profile: what the offer means, what the confirm screen shows, that nothing happens without the in-app confirmation, and that a notification cannot confirm it; it merges for the release that ships the feature and not before.
~~~

## Apps 1

Title: `Profiles in the apps 1: session profile badge, new-session picker, profile filter and read-only profile list (iPhone, iPad, Mac)`

~~~markdown
Depends on #1749 as amended (the `session_profiles` capability, `create_session_request.profile`, and `profile: {id, label, state?}` on session entries, `hello_ack` and the create result). Design: ADR 0051 (proposed; owner answers of 2026-11-14), A1, A2 (list only), A5, A6, A14, A15 and the "Profile picker", "Session badge" and "Profile filter chip" state tables. The web client's parts are in #1749; this issue is the native apps.

## Goal

From an iPhone, an iPad or a Mac, a person starts a session in a profile the machine lets devices select, with the machine's own default preselected and its reason shown, sees which profile every session runs in, and narrows a session list to one profile. Useful alone, and the base every later slice builds on.

## Owner decisions this slice follows (ADR 0051)

Q3: no badge on rows and tiles while only the default is shared, "Default sign-in" in the session detail. Q4: every text says "profile". Q6: the picker lists only selectable profiles. Q10: a profile filter chip in session lists.

## Scope

RemiKit: `AccountProfile` models (a code name distinct from the machine route profile of ADR 0039; every screen says "profile") for `session_profiles_response`, the session entry's `profile` and the create result; `HubCapability.sessionProfiles` with its "cannot" text; decoding of an unknown `default.source` or `profile.state` as nil.

New-session sheet (iPhone `PhoneNewSessionSheet`, Mac `MacLiveNewSessionSheet`): a Profile row in the Agent section, shown only when the selected machine lists `session_profiles`. When the directory or repository changes, the sheet sends `session_profiles_request {directory}` and preselects the returned default with its reason ("From this folder's mapping", "This machine's default", "Built-in default sign-in"). Only selectable profiles that configure the chosen harness are offered. The choice is never stored; each sheet starts from the hub's answer. A refusal from the hub at create is shown in place with the draft kept.

Badge: the profile label beside the harness in the shared session row (`RemiUI/Rows.swift`: iPhone drawer, iPad sidebar, Mac session column), the Board tile subtitle (`RemiUI/BoardTile.swift`), the Mac session detail metadata, and the iPhone session view and its Session actions menu. Text only, escaped, never colored. None on rows and tiles while the machine shares only the default and the session uses it; "Default sign-in" in the session detail. Changed and removed states from `profile.state`.

Profile filter chip: iPhone drawer below the machine strip; iPad drawer or sidebar and the Board's toolbar; Mac session column filter row beside the existing filter. Values "All profiles" and each profile with sessions in view, with the machine label when a profile label repeats across machines in view; one choice; kept until the app quits, cleared at launch; narrows only that list, never the Inbox, notifications or the menu bar count; a menu at accessibility text sizes; states as in ADR 0051's "Profile filter chip" table. Search in the drawer and the Mac session column also matches profile labels.

Read-only Profiles list: in the iPhone and iPad Machines sheet, each machine's section gains "Profiles" with a count; on the Mac, the machine detail in Preferences gains a Profiles card and the machine row's context menu gains "Profiles and Usage…". Rows show the label, the id and the harnesses, including profiles devices may see but not select, marked "Only the machine can start sessions in this profile" (from `profile_status` when listed; Apps 2 adds the rest).

## Out of scope

Sign-in status, Check, settings and the setup guides (Apps 2); usage (Apps 3); the web client (#1749).

## Acceptance criteria

- [ ] `FixtureConformanceTests` decode every #1749 golden fixture that carries a profile, read from the repository's files; a fixture variant with an unknown `default.source` or `profile.state` decodes those fields as nil and the screen claims nothing for them.
- [ ] With the `hello_ack` and `hello_ack_legacy` fixtures (no `session_profiles`), the presentation models produce no Profile row, no badge, no filter chip, and a Profiles entry whose text is `HubSupport`'s message naming the capability.
- [ ] Against a hub started from source that lists `session_profiles`, the encoded `create_session_request` carries the chosen `profile`; against one that does not, it carries no `profile` field (the test inspects the frame).
- [ ] Changing the directory in the sheet sends a new `session_profiles_request` and replaces the preselection; relaunching the app leaves no stored profile choice and the filter chip back at "All profiles" (the test checks `UserDefaults` and the store's persisted snapshot for any profile key).
- [ ] A profile without the chosen harness, or not selectable, is not offered in the picker (table test over the fixtures).
- [ ] With only the default shared, rows and tiles have no badge and the session detail says "Default sign-in".
- [ ] The filter chip narrows the drawer, sidebar, Board and Mac session column to the chosen profile and never changes the Inbox list, the pending notification set or the menu bar count (store tests); a chosen profile that disappears from the list falls back to "All profiles" with the note.
- [ ] A label holding a bidirectional control character from a fixture renders escaped in the row, the tile, the chip and the sheet, and VoiceOver reads "Profile" followed by the escaped label; the chip reads "Profile filter" with its value.
- [ ] App documentation gate: the picker's reason line and the Profiles list link to the docs guide's section on how a new session picks a profile, published for the release that ships this slice.
- [ ] The visual gate passes with a receipt; PARITY.md gains "Session profile badge", "Profile picker", "Profile filter" and "Profile list (read only)" rows saying what ships.
- [ ] `swift test --package-path packages/native/RemiKit`, the Mac `xcodebuild ... build test` and the iPhone `xcodebuild ... build` pass, and `typos` is clean.
- [ ] No text, icon or logic assumes that a Claude Code profile is an Anthropic account: a profile whose expectation or sign-in state the app does not know (the daemon will later report profiles that run the Claude Code harness without Claude credentials, ADR 0051 A8) shows the profile label and no sign-in claim, and is not drawn as signed in (presentation test with an unknown-value fixture).

## Test approach

Swift Testing on RemiKit and RemiUI presentation models with the golden fixtures; one integration test against a hub from source with a temporary `REMI_HOME` and two configured profiles (fake `claude` on `PATH`), for the outgoing frame and the default resolution; previews at the visual gate's sizes. No mock replaces the store, the connection or the decoder.

Part of #1784
~~~

## Apps 2

Title: `Profiles in the apps 2: profile manager with sign-in status, Check, settings and copyable setup commands (iPhone, iPad, Mac)`

~~~markdown
Depends on #1749 as amended (`profile_status`) and on Apps 1. Design: ADR 0051 (proposed; owner answers of 2026-11-14), A1 to A4, A13, A14 and the "Profiles list", "Profile detail: sign-in", "Profile detail: settings (read only)" and "Add, Rename, Remove and sign-in guides" state tables. The web Profiles section is in #1749; this issue is the native apps.

## Goal

On an iPhone, an iPad or a Mac, a person sees each profile's sign-in for each harness with its age, asks the machine to check again, reads the profile's settings, and adds, signs in to, renames, removes or lists profiles by copying commands the machine wrote for them. The app never writes configuration, never runs a command and never signs in. Useful alone: the most common failure ("this profile is not signed in" or "another credential would be used") is visible and fixable from a phone.

## Owner decisions this slice follows (ADR 0051)

Q1: guided commands only, shown with Copy and documented on the docs site. Q4: "profile" everywhere, and the profile detail shows its rules and options read only. Q5: never an email. Q6: profiles devices may see but not select are listed, marked as such.

## Scope

RemiKit: models and decoders for `profile_status_response`, `profile_settings_response` and `profile_guide_response`; `HubCapability.profileStatus`; an unknown `login` decodes as unknown, never as signed in.

Profiles list and profile detail as in ADR 0051 A2: per harness, signed in, signed out, not its own sign-in (with the source name only) or unknown (with the reason), each in words and a symbol of distinct shape; Check; whether devices may start sessions in the profile; the sessions on it (counted from the session list); the "How a new session picks a profile" section with the `list` command and Copy.

Settings, read only, as in ADR 0051 A3: default harness, expected sign-in per harness, arguments (escaped, path-like values replaced by the hub), environment variables and folders as counts, machine default, visibility and selectability, Claude Code permission rules (counts that expand to rule texts) and hook counts per event, Codex approval policy, sandbox mode and model provider, the unreadable state, and the "Per-profile remi settings are planned (#1157) and not built" line. No control edits any of it.

Guides (Add, sign-in, Rename, Remove, List): a short form, `profile_guide_request`, then the hub's steps, each command in a monospaced block with Copy (and Share on iPhone and iPad), "Check now", and a link to the docs guide. The Add form suggests an id from the label. Refusals are shown in words. Remove says the directory stays.

Picker warnings (Apps 1's Profile row): with a known `signed_out` or `not_own_login`, the row shows the reason and the command and Create is disabled until a Check passes; with `unknown`, Create stays enabled.

Offline: the last-known list, dimmed and captioned with its age; Forget machine clears it.

Placement: iPhone and iPad in the Machines sheet (list and detail side by side in regular width); Mac in Preferences, Machines, the machine detail's Profiles card, the "Profiles and Usage…" context menu item, and a "Show Profiles and Usage" menu command whose shortcut is checked against `RemiMacCommandRules`.

## Out of scope

Configuration writes from any client (Q1). Usage (Apps 3). The web client (#1749).

## Acceptance criteria

- [ ] Each `login` value and each `reason` in the #1749 fixtures maps to its own text and symbol (table test on the presentation model); an unknown value shows "Not checked", never "Signed in".
- [ ] Check sends one `profile_check_request`, shows "Checking…" until the response, and a second press inside the hub's interval shows the last result with its age; the integration test against a hub from source with a fake `claude` counts one probe.
- [ ] The settings view renders every field of the #1749 `profile_settings_response` fixtures, shows "None" for an empty one and the unreadable state for `rulesError`, and has no editable control (view inspection or source guard test).
- [ ] The Add guide against a hub from source returns commands; the test runs them in its own shell with the same temporary `REMI_HOME`, presses Check now, and sees the profile listed as signed in (the fake `claude` answers signed in for that directory).
- [ ] Copy places exactly the command text on the pasteboard; no code path in the new files executes a command (a source guard test).
- [ ] An email-shaped label and a taken id are refused with the hub's message and the form keeps its values.
- [ ] A planted marker in the test hub's profile directory path, `env` and `settings.json` secrets never appears in any frame the app receives or in anything it persists (integration test scanning frames and the persisted store).
- [ ] With the machine offline, the list shows the last-known rows with their age and no actions; Forget machine removes them (store test).
- [ ] VoiceOver reads each harness row as one element with its state and age; at Accessibility 5 commands and rule texts wrap or scroll sideways without truncation (previews in the visual gate).
- [ ] App documentation gate: every command shown comes from the hub's answer and has Copy; each guide links to the docs guide page, published for the release that ships this slice; the page describes these screens and nothing unbuilt.
- [ ] The visual gate passes with a receipt, PARITY.md gains a "Profile manager" row, the native gates pass, and `typos` is clean.
- [ ] A profile whose `expects`, `login` or source the app does not know renders as unknown, with no "Expects a subscription" or "Expects an API key" claim and no sign-in prompt, and its guide still shows the hub's copyable commands (presentation test with an unknown-value fixture; ADR 0051 A8, profiles that run the Claude Code harness without Claude credentials are coming).

## Test approach

Swift Testing on presentation models fed by the #1749 golden fixtures; integration tests against a hub from source with temporary profile directories and fake `claude` and `codex` executables; two-sided conformance with the real daemon handler (ADR 0014). No real account is needed; no mock replaces the store, the connection or the decoders.

Part of #1784
~~~

## Apps 3

Title: `Profiles in the apps 3: usage per profile with Refresh, the usage warning and Claude Code's limit wait (iPhone, iPad, Mac)`

~~~markdown
Depends on #1750 with ADR 0051's proposed additions (`profile_usage` with `profile_usage_refresh_request`, the usage snapshot and its updates, the `usage_warning` push kind) and on Apps 1. Design: ADR 0051 (proposed; owner answers of 2026-11-14), A7, A8, A9, A12, A13, A14 and the "Usage section, view and Refresh" and "Session badge" state tables. The web usage panel and its Refresh are in #1750; this issue is the native apps.

## Goal

A person sees, for each profile on each machine, how much of each usage window is spent, where the number came from, how old it is and when it resets; refreshes it when it may be stale; gets one warning before a limit; and sees when Claude Code is waiting for a reset on its own. No number is invented, extrapolated or summed across profiles. Useful alone.

## Owner decisions this slice follows (ADR 0051)

Q7 (the owner's informed decision against the recommendation): the `usage_warning` text on the legacy plaintext push is the same as on the sealed path, the profile label, harness, window, percentage and reset time; until the R7 gate retires the legacy push (or the machine's activation latch retires it earlier), that text is visible in plaintext to the signaling Worker and to Apple's push service. Q8: usage is refreshable on request. Q11 was answered no: Refresh on a Claude Code profile only re-reads the latest report. The owner's added requirement: profiles that run the Claude Code harness without Claude credentials are anticipated; no phase hard-codes Claude Code as an Anthropic account.

## Scope

RemiKit: models for `profile_usage_response`, `profile_usage_update`, the refresh outcome, the session entry's `limitWait`, and the sealed push kind `usage_warning` (a new byte in `NativePushCodec.Kind`, informational, no category).

Usage section in the profile detail and a machine-wide Usage view: one row per window with its name from the reported length, "N% used" as text and a bar, the reset time in the viewer's time zone, the source in words and the observation's age; "Usage unknown" with what updates it; "Billed per request"; "Blocked by Codex" when `ordinaryUsageAllowed` is false, whatever the percentages say; "Reset at …; no reading since" when the reset has passed, never 0%; "Usage cleared because the account under this profile changed at …"; Codex's plan and Claude Code's declared plan; Codex buckets collapsed as "Other limits reported by Codex" with escaped ids; the thresholds as text; "Same account as …" or "Cannot tell for Claude Code"; a note that the same account on another machine appears there separately.

Refresh: on each profile's usage and in the Usage view; sends `profile_usage_refresh_request`; shows each outcome in words (`refreshed`, `reread` with the Claude Code note, `too_soon` with when it was last refreshed, `no_live_session`, `timeout`, `error`); hidden for an API-key profile with "Billed per request; there is nothing to refresh"; the numbers stay, with their source, age and reset time, through every outcome; disabled until the hub's interval ends.

Markers: on a Board tile and a session row, a gauge symbol and "Weekly 91%" only while the profile's largest current window is at or above its warning threshold and its reset is still ahead, in the neutral tone. On the session, "Waiting for the usage reset; Claude Code continues at …" from `limitWait`.

Warning: the per-device `usage_warning` switch in iPhone Preferences and Mac Settings, on by default, registered on `register_device_token` only by builds that can show it; the notification shows the shared text and opens the profile's usage; an Inbox notice row in the neutral tone, dismissible per device; the menu bar extra is unchanged. The switch's footnote says, in plain words, that until the machine stops using the legacy push path the warning's text passes through remi's push relay and Apple without end-to-end encryption.

Placement: iPhone, the profile sheet from the badge and the Machines sheet; iPad, a popover from the badge; Mac, a popover from the badge and the Profiles card.

## Out of scope

Any automatic usage check (refresh happens only when a person asks). The continuation offer (Apps 5).

## Acceptance criteria

- [ ] Every #1750 golden fixture decodes; a window without `usedPercent` shows "Usage unknown" for that window; an unknown `source` or refresh `outcome` shows a neutral phrase rather than a guessed one.
- [ ] With a fixed clock, a window whose `resetsAt` is in the past renders "Reset at …; no reading since" and never a percentage (table test).
- [ ] `ordinaryUsageAllowed: false` with `usedPercent: 10` renders "Blocked by Codex" (presentation test).
- [ ] Every rendered number has a source, an age and a reset time or "reset time unknown" beside it (presentation test over all fixtures).
- [ ] Against a hub from source with the stand-in app-server, Refresh on a Codex profile with a running session shows `refreshed` and the new age; a second press inside 30 seconds shows `too_soon` and sends nothing new to the app-server; a Codex profile without a running session shows `no_live_session`; a Claude Code profile shows `reread` with the note; a timeout keeps the previous numbers and their age.
- [ ] The accessibility value of a usage row contains the window name, the percentage or "usage unknown", the reset time, the source and the age (unit test); Refresh announces its outcome; at Accessibility 5 the bars are replaced by text (previews).
- [ ] The tile and row marker appears exactly when the largest current window is at or above the profile's warning threshold with a future reset (table test over both sides of the threshold and a passed reset).
- [ ] A sealed `usage_warning` capsule built by the daemon's real encoder decodes in `NativePushCodec`, produces an informational payload with no category whose title and body equal the shared builder's output for the same input, and offers no notification actions; a capsule of an unknown kind byte is still rejected as malformed.
- [ ] The device registers for `usage_warning` only when its switch is on, and the switch's state is sent on `register_device_token` (integration against a hub from source); the switch's footnote states the plaintext exposure of Q7.
- [ ] The Inbox notice row uses the neutral tone, never the attention accent (presentation test), and dismissing it on one device leaves it on another (two-store test).
- [ ] App documentation gate: the usage view links to the docs guide's usage section (what each number is, Refresh per harness, the warning's text and its plaintext exposure), published for the release that ships this slice.
- [ ] The visual gate passes with a receipt; PARITY.md gains "Usage per profile", "Usage refresh" and "Usage warning" rows; the native gates pass and `typos` is clean.
- [ ] A Claude Code profile with no reported usage windows shows "Usage is not reported for this profile" and no Refresh action, and no code path maps the harness name to Anthropic windows (presentation test; ADR 0051 A8).

## Test approach

Swift Testing on presentation models fed by #1750's golden fixtures and a fixed clock; the daemon's real sealed-push encoder and the shared text builder for the push test; integration against a hub from source where the stand-in app-server or a recorded status-line file supplies observations, as #1750's own tests do. The owner-run check that the panel agrees with `/usage` and `/status` within one turn is #1750's gate, rechecked once on a signed device for this slice.

Part of #1784
~~~

## Apps 4

Title: `Profiles in the apps 4: compact a session and read its handoff brief (iPhone, iPad, Mac, web)`

~~~markdown
Depends on #1751 (`session_compaction`, `handoff_brief`). Design: ADR 0051 (proposed; owner answers of 2026-11-14), A10, A13 and A15.

## Goal

From any client, a person compacts a session on its current profile or reads a handoff brief of the work so far. Useful alone: a long session can be compacted from a phone.

## Scope

The session's actions menu (iPhone Session actions, iPad, Mac, the web chat header menu) gains "Compact now" and "Handoff brief", each shown only when the machine lists its capability.

"Compact now" sends `compact_request`; while it runs the item reads "Compacting…"; a refusal (a turn running, a prompt up, a Codex approval live, a usage-limit wait) is shown in words from its code; the deadline shows "Not confirmed; the session is unchanged"; a Claude Code summary is shown in a sheet to the requesting device only.

"Handoff brief" sends `handoff_brief_request` and shows the brief read-only, with what it could not read and Copy.

Summaries and briefs are held in memory only and cleared when their sheet closes.

## Acceptance criteria

- [ ] Without the capability the menu item is absent (presentation test with `hello_ack_legacy`).
- [ ] Each refusal code in #1751's fixtures maps to its own sentence (table test), and a refused request sends nothing else.
- [ ] A second press while a compaction is in flight sends nothing (store test).
- [ ] After the summary or brief sheet closes, the store holds no copy and nothing was written to the app's container (store test and a container listing in the integration test).
- [ ] Against a hub from source with a fake `claude` that records its input, "Compact now" from an idle session reaches the guarded write path and the result is shown; from a session with a prompt up it is refused with the reason.
- [ ] App documentation gate: the menu items link to the docs guide's section on compaction and the handoff brief, published for the release that ships this slice.
- [ ] The visual gate passes with a receipt; PARITY.md gains a "Compact and handoff brief" row; native and web gates (`bunx biome check`, every type check including the web package's, `bun test`) pass and `typos` is clean.

## Test approach

Presentation tests on #1751's fixtures; integration against a hub from source with fake `claude` and the stand-in Codex app-server, as #1751's tests do. The real `/compact` run is #1751's owner gate.

Part of #1784
~~~

## Apps 5 (not filed: follows phase 5, which follows #1752 passing and the owner's go)

Title: `Profiles in the apps 5: confirm a continuation on another of the person's profiles (never from the lock screen)`

~~~markdown
Depends on PHASE-5 (`session_continuation`), Apps 2 and Apps 3. Design: ADR 0051 (proposed; owner answers of 2026-11-14), A11, A13, A14 and the "Continuation confirm sheet" state table; ADR 0049 D5, D7, D8 and the owner's answer to its Q9 (a phone starts a continuation only with an in-app confirmation, never from the lock screen); ADR 0051 Q9 (an Inbox row and session banners, the accent only while a session is stopped at the limit).

## Goal

When a profile nears or hits its limit, a person sees one offer for that profile, reviews in the app what will happen, what differs between the two profiles and what the new session will not have, and confirms a continuation onto another of their own profiles; nothing happens without that confirmation, and nothing can be confirmed from a notification.

## Scope

RemiKit and the web client: `continuation_offer`, `continuation_preview_request/response`, `continue_session_request`, `continuation_progress`, `continue_session_response`, and the session entries' `continuedFrom` and `supersededBy`.

The offer is never a `question` and never enters the question pipeline: an Inbox row ("Work on Studio is at 95% of its weekly window; 2 sessions") and a banner in each listed session, with "Compact now" (idle only), "Continue on" each eligible profile with its usage, age, reset time and sessions, "Wait for the reset" when Claude Code's own wait runs, and the harness's own options as copyable commands for the terminal. The attention accent only while a session on that profile is stopped at the limit.

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
- [ ] App documentation gate: the offer and the confirm sheet link to the docs guide's section on continuing a session, published for the release that ships this slice.
- [ ] The visual gate passes with a receipt; PARITY.md gains a "Confirmed continuation" row; native and web gates pass and `typos` is clean.
- [ ] Owner-run gate: on a signed iPhone, a real continuation between two of the owner's profiles is confirmed in the app, and a notification for the same offer offers no action.

## Test approach

Presentation and store tests on PHASE-5's golden fixtures; integration against a hub from source with two temporary profiles and fake `claude` and `codex` executables that record their environment and first input and fail on command; a source guard test for the notification paths. The real continuation needs two real logins and is the owner's gate.

Part of #1784
~~~
