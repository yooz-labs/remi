# ADR 0051: Account profiles in the apps: account manager, session profile, usage and confirmed continuation

**Status:** Proposed (design for #1784; no implementation; not yet reviewed by the owner)
**Date:** 2026-11-14
**Owner:** Yahya
**Builds on:** ADR 0049 (the daemon side, accepted as the direction), ADR 0035, ADR 0036, ADR 0038, ADR 0039, ADR 0019, #1157, #1748 to #1752
**Epic text:** `.context/account-switching-apps-epic.md` (titles and bodies, not filed)

## Context

The owner asked on 2026-11-14 (#1784) that multiple accounts be designed for the apps as well as the daemon,
taking ideas from the T3 Code app, which is MIT licensed (https://github.com/pingdotgg/t3code).
ADR 0049 designs the daemon side: profiles that select each harness's own state directory, the effective-login check, observed usage with source and age, compaction on request, and a continuation the person confirms.
Its D7 sketches what a phone shows, and the filed phases #1749 and #1750 put a badge, a picker and a usage panel in the web client.
Nothing yet says where a person manages accounts, how the native iPhone, iPad and Mac apps show them, what is shared between devices, or what each screen needs on the wire.
This ADR is that app-side design.
It proposes; it contains no implementation.

Where inspiration and remi's own rules disagree, remi's rules win:
ADR 0049 D10 (remi never reads, copies, stores, prints or relays a credential, never runs a login from a phone, never chooses a profile the person did not configure, never sends an email, workspace name or account identifier to a client, and does not switch automatically while phase 6 is unapproved);
the harness seam (ADR 0032 and 0033);
the decision object (ADR 0038);
capability gating (ADR 0035: a client checks the daemon's capability list before it sends a request an older daemon would ignore);
the native layout (`packages/native/DESIGN.md`, the iPad Board in `packages/native/handoff/ipad-board.md`);
and the design brief's principles: calm by default, honest, one accent for "needs you", state never shown by color alone.

Citations:
`[t3doc: path]` and `[t3src: path:lines]` are T3 Code documentation and source at commit `b60abf32e0b8247b2a425f8065be77352a3b86e4` of `pingdotgg/t3code` (`main`, committed 2026-11-14 21:11 UTC), read with `gh api` and `raw.githubusercontent.com`;
`[src: path:line]` is remi at `origin/develop` `ab811011` (0.8.3-dev.41);
`[0049 Dn]`, `[0049 Vn]` and `[0049 Gn]` are ADR 0049's decisions, verified facts and gaps.
No T3 Code source or documentation text is copied here or proposed for reuse.
A few user-interface strings are quoted as short phrases where the wording itself is the finding; any reuse of T3 Code's code would carry its MIT notice, and none is proposed.

## What the apps are today (verified at `ab811011`)

- **F1. Nothing in any client mentions an account profile.**
  A case-insensitive search for "profile" over `packages/shared/src/protocol.ts`, `packages/native/RemiKit/Sources/RemiKit/Protocol/` and `packages/web/src` returns nothing.
- **F2. Capabilities.**
  The daemon lists one base capability, `workspaces` `[src: packages/daemon/src/cli/capabilities.ts:18]`;
  the registry documents seven names `[src: packages/shared/src/protocol-version.ts:41-47]`;
  RemiKit mirrors them, plus a reserved `terminal_view`, and decides with `HubSupport.check` `[src: packages/native/RemiKit/Sources/RemiKit/Protocol/ProtocolSupport.swift:18-28, 138-173]`;
  the web client calls `hubSupport` `[src: packages/web/src/hooks/useConnectionManager.ts:192, 1152]`.
- **F3. iPhone and iPad.**
  The Machines sheet is "the home of machine management" (`DESIGN.md`).
  The new-session sheet has Machine, Repository, Workspace (only when `draft.workspaceCapable`), Agent (harness and model) and Launch summary sections `[src: packages/native/iPhone/NewSessionSheet.swift:43-141]`.
  The same target runs on iPad as the Board, laid out from the width it is given (`handoff/ipad-board.md`).
- **F4. Mac.**
  Preferences has General, Machines and Identity tabs `[src: packages/native/Mac/MacPreferencesView.swift:36-45]`, and Machines is a split view of machine rows and a detail.
  The main window has three columns: machines with the Inbox above them, the sessions of the selected machine grouped by workspace, and the session (`DESIGN.md`).
- **F5. Where a session's metadata shows.**
  The shared session row shows the harness as an uppercase caption `[src: packages/native/RemiKit/Sources/RemiUI/Rows.swift:43]`;
  a Board tile's subtitle is the machine, the project and the harness unless it is Claude `[src: packages/native/RemiKit/Sources/RemiUI/BoardTile.swift:609-612]`;
  the Mac session detail shows a harness metadata label `[src: packages/native/Mac/MacSessionDetail.swift:642]`;
  the web session card shows a harness label `[src: packages/web/src/components/session/SessionCard.tsx:47, 86]`.
- **F6. Web.**
  One connection is one machine.
  The new-session sheet starts Claude Code in a recent or typed directory, with no harness picker `[src: packages/web/src/components/session/NewSessionModal.tsx]`.
  Settings has identity, Theme, Font Size, Preferences, secure push and About sections `[src: packages/web/src/components/settings/SettingsPanel.tsx:455-570]`.
- **F7. Sealed pushes are a closed set.**
  The native push codec maps each kind to one byte and rejects an unknown byte as malformed `[src: packages/native/RemiKit/Sources/RemiPush/NativePushCodec.swift:10-19]`, so a sealed push of a new kind is dropped by an older app: it fails closed.
  An informational payload has no category, so it has no lock-screen actions (same file, `Information` and `Category`).
- **F8. The native apps never touch the machine.**
  They are sandboxed with `network.client` only, never read `~/.remi`, never spawn a process; anything that needs the machine is a request to the hub (`packages/native/AGENTS.md`, "Platform and constraints").
  The Mac app on the same machine is a wire client like any other: loopback is not identity (#873).
- **F9. "Profile" already means something in the native code.**
  ADR 0039's native follow-up speaks of a machine's route "profile" and "profile transfer", so account profiles need a distinct type name in RemiKit.
- **F10. An older client drops a message type it does not know, and an older daemon refuses one.**
  The native connection reports an unknown type as unsupported and does nothing else with it `[src: packages/native/RemiKit/Sources/RemiKit/Transport/RemiConnection.swift:938-939]`;
  the web client's deserializer drops it (ADR 0013, context);
  the daemon answers an unknown inbound type with `UNKNOWN_MESSAGE` (ADR 0013).
- **F11. Where the new controls would sit.**
  The iPhone session has a "Session actions" menu `[src: packages/native/iPhone/SessionScreen.swift:418]`;
  the Mac presents its own new-session sheet, `MacLiveNewSessionSheet` `[src: packages/native/Mac/MacLiveRootView.swift:454-470]`;
  the web chat header has an actions menu `[src: packages/web/src/components/chat/ChatHeader.tsx:60-82]`.

## What T3 Code does

T3 Code is a server with web, desktop and mobile clients.
Each finding below says what was read in documentation, what was read in source, and what could not be verified.

- **T1. Accounts are provider instances.**
  Source: an instance is a named configuration of one driver (`driver`, an optional display name, an optional accent color, environment variables, an enabled flag and the driver's own settings), keyed by a slug id and changed by `create`, `upsert` and `remove` mutations `[t3src: packages/contracts/src/providerInstance.ts:75-99]`;
  its environment variables can be marked sensitive or hold secret references `[t3src: packages/contracts/src/providerInstance.ts:31-60]`.
  Source: the Claude usage code reads a usage response typed by the Claude Agent SDK `[t3src: apps/server/src/provider/claudeUsageLimits.ts:1, 186-238]`, and the account (email, subscription type, token source) comes from an initialization object `[t3src: apps/server/src/provider/ClaudeProvider.ts:585-600]`;
  so T3 Code talks to Claude through the SDK's control channel, an inference from these two files that was not traced further.
  remi runs the interactive CLI in a pseudo-terminal (PTY) and has no such channel.
  That the SDK's initialization carries a subscription type is a lead for ADR 0049 G12 (a Claude plan field), not a fact remi has verified.
- **T2. Adding, naming and removing.**
  Documentation: a second Claude account is a second configuration directory, signed in at the environment's machine with `CLAUDE_CONFIG_DIR=<dir> claude auth login` and added as another Claude instance;
  on mobile, "Add Claude account" takes a name and the folder, and the login "still happens on the environment's machine" `[t3doc: docs/user/providers-claude.md, "Separate accounts or configurations"]`.
  A second Codex account is either a managed in-app "Connect with ChatGPT" sign-in, or `CODEX_HOME=<dir> codex login` on the machine plus a manually configured instance `[t3doc: docs/user/providers-codex.md:5-34, 64-101]`.
  Source: the web add flow is a wizard of Provider, Identity and Config steps `[t3src: apps/web/src/components/settings/AddProviderInstanceDialog.logic.ts:8-10]`;
  Identity asks for a Label, an Instance ID (letters, digits, `-` or `_`, suggested from the label) and an optional accent color `[t3src: apps/web/src/components/settings/AddProviderInstanceDialog.tsx:625-690]`.
  The mobile form takes a name and a config folder and describes the folder as one already signed in on that server `[t3src: apps/mobile/src/features/settings/ClaudeAccounts.tsx:177-178, 234-235]`, saved as a create or upsert `[t3src: apps/mobile/src/features/settings/claude-accounts.ts:35-73]`;
  rows say signed in, not signed in, not installed or turned off, next to the folder path `[t3src: apps/mobile/src/features/settings/ClaudeAccounts.tsx:70-78, 123]`.
  Removal asks for confirmation and says the instance's saved settings will be removed `[t3src: apps/web/src/components/settings/ProviderSettingsPanel.tsx:141-149, 838-857]`; mobile has a Remove alert `[t3src: apps/mobile/src/features/settings/ClaudeAccounts.tsx:92-106]`.
  Source: settings can show a provider sign-in in an embedded terminal that relays the process's output and the person's keystrokes `[t3src: apps/web/src/components/settings/ProviderAuthTerminal.tsx]`.
  Documentation: a managed ChatGPT sign-in for a remote environment can finish on a local machine that then transfers "the issued client registration and tokens" to the destination `[t3doc: docs/internals/providers.md:65-69]`.
  Not verified: whether the server's remove handler deletes any directory (only the client call was read), and the server side of the embedded sign-in.
- **T3. One session list across accounts.**
  Source: every thread names its instance (the runtime's, else the model selection's), resolved per environment because default ids "name different accounts on different servers" `[t3src: apps/mobile/src/features/threads/thread-provider-instance.ts:19-40]`;
  the row shows the instance badge only when it has an accent color or when more than one instance of the same driver exists `[t3src: packages/client-runtime/src/state/providerInstanceDisplay.ts:64-82]`.
- **T4. Which accounts can continue a thread: the same state directory.**
  Documentation: Codex instances that share the thread's `CODEX_HOME` path can continue it;
  a "shadow home" gives a second account its own `auth.json` while sharing sessions and configuration;
  a separate `CODEX_HOME` cannot continue the other's threads `[t3doc: docs/user/providers-codex.md:64-113]`.
  Claude instances can switch only within the same configuration directory, and separate directories stay isolated `[t3doc: docs/user/providers-claude.md:35-38]`.
  Source: the continuation key is `codex:home:<shared home path>` `[t3src: apps/server/src/provider/Drivers/CodexHomeLayout.ts:49-72]` and `claude:home:<resolved config directory>` `[t3src: apps/server/src/provider/Drivers/ClaudeHome.ts:146-154]`,
  attached to every provider snapshot `[t3src: packages/provider-core/src/server/instanceIdentity.ts:6-21]` and handed to the web model picker as a lock `[t3src: apps/web/src/components/chat/ProviderModelPicker.tsx:96-97, 295-296]`.
  The shadow home is built from symbolic links to every entry of the shared home except a private set (`auth.json`, `auth.lock`, `models_cache.json`) and a local set (`log`, `memories`, `tmp`, `.DS_Store`) `[t3src: apps/server/src/provider/Drivers/CodexHomeLayout.ts:32-42, 350-452]`.
  Not verified: where the lock is set and whether the server refuses an instance from another group; whether OpenAI supports linking one `CODEX_HOME`'s state into another (ADR 0049 G9 records resuming across homes as experimental and untested).
- **T5. The email, blurred until clicked.**
  Source (web): a component shows a deterministic scrambled stand-in of the same shape, keeping `@`, `.`, `-` and `_`, under a CSS blur, and the real value only after a click;
  its tooltip offers to reveal, and its accessible name names the toggle, not the value `[t3src: apps/web/src/components/settings/RedactedSensitiveText.tsx:8-58]`.
  It is used for the signed-in account's email in the instance card and the authentication section `[t3src: apps/web/src/components/settings/ProviderInstanceCard.tsx:207-218, 788, 1000; apps/web/src/components/settings/ProviderAuthenticationSection.tsx:175-185]`.
  Source (mobile): a fixed mask until a tap, with the email in the accessibility label only while revealed and a hint that says what a tap does `[t3src: apps/mobile/src/features/settings/SettingsProviderAccountsRouteScreen.tsx:526-545]`.
  So the email itself reaches every client in the provider snapshot (put there by the server `[t3src: apps/server/src/provider/ClaudeProvider.ts:900-905]` and read by the client `[t3src: apps/web/src/components/settings/ProviderInstanceCard.tsx:788]`); the blur is presentation.
  Documentation: the Codex guide at this commit does not mention the email or the blur, although #1784's description says it does; the behavior was found only in source.
- **T6. Usage and limits: pooled, polled, and partly fetched with a token.**
  Documentation: "Usage → Limits" pools every subscription account per provider into one number per window, with one segment per account;
  the same account signed in on several environments counts once;
  opening it checks the environments automatically, at most every five minutes per client;
  banked reset credits can be redeemed with a "Use reset" action;
  a pooled-accounts proxy hub can be connected with a management key;
  a home-screen widget shows remaining quota `[t3doc: docs/user/usage.md:111-192]`.
  Token history and an estimated API-equivalent cost are a separate view `[t3doc: docs/user/usage.md:9-58]`.
  Source: Claude windows come from the SDK's usage control response (five-hour, seven-day, model-scoped weekly windows and a monthly spend percentage) `[t3src: apps/server/src/provider/claudeUsageLimits.ts:186-238]`;
  Codex windows come from the app-server's rate limits, preferring the `codex` bucket of `rateLimitsByLimitId` `[t3src: apps/server/src/provider/codexUsageLimits.ts:116-134]`.
  Source: Claude reset credits read `claudeAiOauth.accessToken` from `<config dir>/.credentials.json` (skipped on macOS, where the login is in the Keychain) and call `https://api.anthropic.com` with it as a bearer token `[t3src: apps/server/src/provider/claudeResetCredits.ts:15, 21-23, 197-205]`.
  Not verified: whether the SDK usage request makes a model request or counts against usage; the five-minute schedule (documentation only); the proxy hub client (`apps/server/src/usage/cliproxyApi.ts`, not read).
- **T7. At a limit.**
  Documentation: the thread names the limit and the wait; Claude holds the turn until the window reopens; Codex says to send again after the reset `[t3doc: docs/user/providers-claude.md:84-90; docs/user/providers-codex.md:140-145]`.
  Source: the banner offers an automatic resume the server schedules at the reset, a snooze until the reset, and, for ChatGPT limits, a usage link or a copyable request to a workspace admin `[t3src: apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx:37-152]`.
- **T8. What it does not do, as far as was read.**
  No action at a limit continues on another account: changing accounts is the person's choice in the model picker, within one continuation key (T4).
  A search of the twelve documentation pages read for rotation and failover terms found nothing about accounts.
  Not verified across the whole repository (8,180 files outside its vendored `.repos/`).
- **T9. A principle worth keeping.**
  Documentation: "Setup must not happen as a health-check side effect": a status probe must not start a session, run hooks or open a login `[t3doc: docs/internals/providers.md:52-57]`.

## Decisions (proposed)

### A1. Profiles belong to the machine; apps read them, the terminal changes them

A profile is configuration on one machine (`[profiles.<id>]` in that machine's `config.toml`, #1748), and every device sees the same profiles of that machine.
In the first slices no app writes profile configuration: creating, renaming, removing a profile, adopting an existing directory, mapping folders and choosing which profiles devices may see or select all happen at the machine.
An app guides those steps (A3) and checks the result (A2).
Reasons: the login step needs the machine's terminal anyway [0049 D10], so a remote "create" only splits one task across two devices while adding a configuration-writing surface to the wire;
a profile's directory is a path, and the phase 2 contract sends no local path of a profile (#1749);
and a device must not be able to widen what devices can see (a hidden profile cannot be unhidden by a device that cannot see it).
The Mac app is no exception, even on the same machine (F8).
Whether apps may later write some of it is open question Q1.

### A2. The account manager: one list per machine

Each machine has an Accounts list, shown only when that machine lists `session_profiles`:

- **Rows.** The built-in default sign-in first ("Default sign-in", which changes nothing), then each profile the machine shares with devices, by its label, with the id in a secondary monospaced line.
  Each row says, in words and a symbol of distinct shape, for each harness the profile configures: signed in, signed out, not its own sign-in, or not checked.
  Once `profile_usage` is listed, the row adds one line: the largest current window, its percentage and its age ("Weekly 72% used, 12 min ago"), or "Usage unknown".
- **Detail.** Sign-in per harness with its age and, when it is not signed in or not its own, the reason in words and the command to run at the machine (A3);
  whether devices may start sessions in it ("New sessions from devices can use this profile", or "Only the machine can start sessions in this profile");
  the sessions currently on it (from the session list, no new request);
  usage (A5) and, from phase 3, "Same account as Work", "Not the same account as any other profile", or "Cannot tell for Claude" [0049 D11, G17];
  and Manage: Rename, Remove, and the sign-in command, each as a guide (A3).
- **Check.** One button re-runs the effective-login check for that profile on the machine (`claude auth status --json` and `codex login status` under the profile's launch environment [0049 D1]).
  It reads which credential would be used, never the credential; it starts no session, no hook and no login (T9).
  The hub runs at most one check per profile at a time and at most one per profile every 15 seconds for all devices together; a device that asks sooner gets the last result with its age.
  Nothing polls: status is checked before every launch [0049 D1] and when a person asks.
- **Placement.** iPhone and iPad: in the Machines sheet, each machine's section gains "Accounts" with a count, which opens the list inside the sheet's navigation (on a regular-width iPad the sheet shows the list and the detail side by side).
  Mac: Preferences, Machines tab, the machine's detail gains an Accounts card;
  the machine row's context menu in the main window gains "Accounts and Usage…", which opens that card;
  a menu command "Show Accounts and Usage" opens it for the selected machine (its shortcut is chosen against the existing command map, `RemiMacCommandRules`).
  Web: Settings gains an Accounts section for the connected machine.

### A3. What "add" means when remi never signs in for the person

"Add" is a guided terminal step, never a login and never a configuration write from the device.
The person fills a short form: a label, an id (suggested from the label, editable, `[a-z0-9][a-z0-9-]{0,31}` as the backend plan proposes), the harnesses (Claude Code, Codex or both), and the kind of sign-in it expects (a subscription or an API key [0049 D1]).
The device sends these to the hub in a `profile_guide_request`;
the hub validates them (the id is free and well formed, the label is 1 to 64 safe characters and does not look like an email address, A10) and answers with the exact commands for that machine: create the profile, sign in to each harness in the person's terminal, and allow devices to select it, in the syntax that machine's remi understands.
The device shows the commands with Copy and Share, never runs them, and offers "Check now", which lists the profiles again: "Found and signed in", "Found, not signed in yet" or "Not found yet".
Adopting an existing directory (for example `~/.claude-work` from the documented alias) is the same guide with a directory field; the hub echoes the typed path only inside the command it returns and stores nothing.
Rename, Remove and sign-in follow the same pattern.
Remove never deletes the profile's directory, and the guide says so; the hub refuses a removal guide while a session runs in that profile.
Because the hub writes the commands, an app does not hard-code the CLI's syntax across the many remi versions it talks to.
T3 Code lets mobile save a configuration folder directly (T2); this keeps the form and drops the remote write (A1).

### A4. The session's profile

- **Badge.** A session shows its profile's label beside the harness:
  the shared session row (iPhone drawer, iPad sidebar, Mac session column), the Board tile's subtitle,
  the session's own view (on iPhone, under the title and as the first line of the Session actions menu; the Mac detail metadata; the web chat header)
  and the session card on the web (F5, F11).
  While a machine shares no profile other than the default, no badge is drawn on rows and tiles, and the session detail still says "Default sign-in";
  this follows T3 Code's rule of badging only when it disambiguates (T3) and the design brief's "calm by default", and departs from a literal reading of [0049 D7] (open question Q3).
  The badge is text, never color: remi does not give profiles accent colors (T1 has them), because the one accent means "needs you".
- **Picker at session creation.** The new-session sheet gains a Profile row in the Agent section, beside the harness.
  When the person picks a directory or repository, the device asks the hub for the profiles and the default the hub resolves for that directory (`session_profiles_request {directory}`), preselects that default and says why: "From this folder's mapping", "This machine's default" or "Built-in default sign-in".
  The device remembers no last choice: every sheet starts from the hub's resolution, so the app never chooses a profile the machine's rules would not [0049 D10].
  A profile is offered only for a harness it configures.
  When `profile_status` is listed and the chosen profile is signed out or not its own sign-in, the row says so with the command, and Create is disabled until a Check passes; when the status is unknown, Create stays enabled and the hub's own refusal (#1748) is shown in place, with the draft kept.
- **What is immutable.** A session runs on the profile it started with for its whole life: the id and the private snapshot of selector paths and revision [0049 D1, #1748] do not change on reconnect or resume.
  There is no "change account" on a running session.
  Moving work to another profile is a continuation (A8), which makes a new session and links the two.
  This departs from T3 Code, whose picker can move an existing thread to another account that shares its state directory (T4).
- **When the profile changes under a session.** The label shown is the profile's current label.
  If the profile's definition changed after the session started, the detail says "This profile's settings changed after the session started; the session keeps the settings it started with";
  if the profile was removed, the badge reads the label from the session's snapshot with "(removed)", and Resume shows the hub's refusal (#1748).
  Both need an optional `profile.state` on the session entry (A12).

### A5. Usage: observed numbers with their source and age, never invented ones

From phase 3, each profile has a usage section, and a machine-wide Usage view lists every shared profile:

- Each window is one row: its name ("5-hour", "Weekly", from the reported window length), "N% used" as text and a bar, the reset time in the viewer's time zone with a relative form, the source in words ("Reported by Claude Code's status line" or "Reported by Codex"), and the observation's age.
  Percentages are shown as reported, rounded to a whole number; nothing is extrapolated, paced or summed.
- A window whose reset time has passed shows "Reset at 3:45 PM; no reading since", never 0%.
- "Usage unknown" when nothing was observed, with what would update it ("Updates when a session on this profile gets a reply").
- "Billed per request" for an API-key profile [0049 D2].
- "Blocked by Codex" when Codex reports `ordinaryUsageAllowed: false`, whatever the percentages say [0049 V12].
- "Usage cleared because the account under this profile changed at 2:10 PM" after an account change [0049 D11].
- The plan, where Codex reports one ("Codex plan: Pro"), and for Claude only what the person declared ("Declared: individual subscription") [0049 D1].
- Other limits Codex reports by bucket (`rateLimitsByLimitId`) are collapsed under "Other limits reported by Codex" with their ids escaped and the note that their meaning is not documented [0049 G5].
- The two thresholds are shown as text ("Warning at 90%, offer at 95%") [0049 D3], set at the machine.
- There is no Refresh button: remi observes and does not fetch [0049 D2], and the screen says what makes a number update.
  T3 Code checks on open (T6); remi does not start anything to read usage.
- Usage is per machine. The same account under profiles on two machines appears twice, and the Usage view says so, because a fingerprint never leaves its machine [0049 D11]; T3 Code merges them by account (T6), which needs identifiers remi does not send.
- On a Board tile or a session row, usage appears only when the profile's largest current window is at or above its warning threshold: a gauge symbol and "Weekly 91%", in the neutral tone, with the age in the accessibility value.
- Claude Code's own wait after a limit, which phase 3 surfaces from `quota_auto_resume_*` [0049 V10], shows on the session as "Waiting for the usage reset; Claude Code continues at 3:45 PM".

### A6. Notices and pushes

- Crossing the warning threshold sends `usage_warning` [0049 Q8] to devices that enabled it, once per profile, window and reset period.
  It is informational: no category, so no lock-screen actions (F7), and opening it opens the profile's usage.
- On the legacy plaintext push path, which still passes through the Worker until the R7 gate, a `usage_warning` carries only its kind and the machine ("A profile on Studio passed its usage warning");
  the label and the numbers ride only in the sealed path or are read in the app after opening (open question Q7).
- The per-device switch for `usage_warning` lives in iPhone Preferences and Mac Settings, next to the existing notification switches, and rides up on `register_device_token` [0049 Q8].
  A device registers it only when its app can show it, because an older native app drops an unknown sealed kind (F7).
- In the app, an active warning is a one-line notice row in the Inbox, styled like a machine problem line and in the neutral tone: "Work on Studio: weekly window 91% used".
  It is not a card and it does not use the "needs you" accent.
  Dismissing it hides it on that device only.
  The menu bar extra keeps counting only cards that need the person.

### A7. Compaction and the handoff brief (phase 4)

The session's actions menu gains "Compact now" and "Handoff brief", each shown only when the machine lists its capability.
"Compact now" is refused, with the reason in words, while a turn runs, a prompt is up, a Codex approval is live or the session is in a usage-limit wait [0049 D4]; during the request the menu item reads "Compacting…" until the result or the deadline ("Not confirmed; the session is unchanged").
A Claude compaction summary reaches only the requesting device and is shown in a sheet, held in memory only.
"Handoff brief" opens a read-only sheet with the brief, what it could not read, and Copy; it is kept in memory only and cleared when the sheet closes.

### A8. The continuation offer and its confirmation (phase 5, after 5A passes and the owner says go)

- **The offer is not a question card.** It is its own message behind `session_continuation`, never a `question`,
  because an older client renders an unknown `kind` as a generic card with its options (ADR 0038 item 7), which could be answered without the confirm screen,
  and a card with two to four plain options can get lock-screen buttons (`DESIGN.md`, "Lock screen").
  An older client drops the new message entirely (F10).
- **Where it shows.** One offer per profile [0049 D3]: an Inbox row ("Work on Studio is at 95% of its weekly window; 2 sessions") and a banner in each listed session.
  The row uses the "needs you" accent only while a session on that profile is stopped at the limit (a turn failed on a usage limit, or the limit wait), because then the work cannot go on without the person; at the offer threshold alone it is a neutral notice.
- **Choices.** "Compact now" (idle only), "Continue on" a named eligible profile (each with its usage, age and the sessions already on it), "Wait for the reset" when Claude Code's own wait is running, and the harness's own ways past a limit, shown as the commands to run at the terminal or through `remi attach` [0049 D7].
- **Confirm screen, in the app only.** Choosing "Continue on" opens a full sheet that first asks the hub for a preview (`continuation_preview_request`) and shows, in this order:
  what happens (the source session stops, a new session starts in the same directory on the target profile with a brief or summary as its first message);
  what differs between the two profiles (permission rules, hooks, Codex approval policy, sandbox mode and model provider), as rule texts and hook commands, escaped, collapsed by count and expandable [0049 D5];
  what the new session will not have [0049 D5];
  "Billed per request" for an API-key target;
  and the sessions already on the target.
  When the target allows more than the source, when its usage is unknown, or when "same account" is unknown, each needs its own acknowledgment, a labeled switch that is off by default.
  The confirm button ("Continue on Personal") is never the default button, is disabled until the preview has loaded and every required acknowledgment is on, and sends `continue_session_request` with the preview's id.
  The hub refuses a request whose preview has expired (two minutes is proposed), was issued to another connection,
  or no longer matches the two profiles' revisions ("These profiles changed since you reviewed them"), and the sheet reloads the preview.
- **Never from the lock screen** [0049 Q9]: no notification category carries a continuation action;
  the notification response handlers have no path that sends `continue_session_request`;
  the Mac's notification banners and menu bar extra only open the sheet;
  and the hub refuses the request through the notification answer endpoint and through Telegram, which cannot show the two lists.
- **Progress and result.** The sheet shows each step [0049 D5] as it is reported.
  On success it links the new session and marks the old one "Continued on Personal";
  on a failure it names the step, says the source session is still resumable under its own profile, and offers nothing automatic.
  After a hub restart mid-continuation, the session shows the persisted step and no button retries it on its own.
- Phase 6 (opt-in automatic continuation per profile pair) has no app design here: it is not approved to start [0049 D9], and no control for it is drawn.

### A9. What is shared across devices and what stays on one device

| Item | Lives in | Shared by every device of the person |
|---|---|---|
| Profiles: ids, labels, harness settings, directories, folder mappings | the machine's `config.toml` | yes, read only; directories and mappings never leave the machine |
| Which profiles devices may see and select | the machine | yes |
| Sign-in state and its age | probed on the machine | yes, the same answer to every device |
| Thresholds (warning, offer) | the machine, per profile | yes |
| Usage snapshots | the machine | yes |
| Account fingerprint | the machine only | never sent; only the "same account" relation is |
| A session's profile and snapshot; continuation lineage | the machine's session record | yes |
| Whether `usage_warning` is pushed to this device | this device, sent up on `register_device_token` | no |
| Dismissal of a usage notice row | this device | no |
| The profile chosen in an open new-session sheet | that sheet only, never stored | no |
| A last-known copy of profiles and usage for offline display | this device's cache, shown with its age, cleared by Forget machine | no |
| A continuation preview and its acknowledgments | the requesting connection, in memory | no |

### A10. Privacy defaults

- **No identifier reaches the app.** No email, workspace name, account id, profile directory, folder mapping or environment value is on the wire [0049 D10, #1749].
  The question T3 Code answers with a blurred email ("which account is signed in here?", T5) is answered on the machine instead: "signed in, its own sign-in", "same account as Work", and the Codex plan.
  So nothing needs blurring by default, and the masked-until-revealed pattern stays in reserve: if the owner ever allows an identifier on the wire (open question Q5), it arrives masked, never stored, with T3 Code's accessibility treatment (the value is in the accessibility label only while revealed).
- **Labels are not emails.** The hub refuses a label that looks like an email address, in the guide (A3) and at `remi profile add`, with "Use a name such as Work, not an email address", so D10 is not defeated by the one free-text field.
- **Lock screen.** A `usage_warning` on the legacy path carries no label or number (A6); the sealed path follows the system's "Show Previews" setting like other remi notifications.
- **Hook commands** on the confirm screen are held in memory only and cleared when the sheet closes (A8); they are text the person wrote and may contain secrets, so they are never cached, logged or sent to another device.
- **Briefs and summaries** are held in memory only (A7).

### A11. Accessibility

- Every state is text plus a symbol of distinct shape; nothing is color alone (the brief's rule).
- The badge's accessibility label is "Profile Work"; a removed one is "Profile Work, removed".
- A usage row reads as one element: "Weekly window, 72 percent used, resets Friday at 3:45 PM, reported by Codex 4 minutes ago"; an unknown one reads "Weekly window, usage unknown".
- At accessibility text sizes the bars are replaced by the text rows, and the Accounts list and the confirm screen wrap without truncating labels or commands (commands scroll sideways, as the terminal pane does).
- Commands are announced as code, with Copy as a separate action.
- The confirm screen's reading order is the order of A8: what happens, what differs, what is lost, the acknowledgments, then the button; the Escape key and the Cancel button close it on the Mac, and Return does not confirm.
- Reduce Motion: no animated bars or progress; Reduce Transparency: the confirm sheet uses an opaque surface.
- On the iPhone, no haptic for usage notices (calm); a success haptic after a continuation completes.

### A12. Wire contract and capabilities, by phase

Every name below is proposed for its phase's ADR amendment and golden fixtures (ADR 0035, ADR 0012); a client sends none of these requests to a machine that does not list the capability, and decodes an unknown enum value as unknown, never as the best case.
The "cannot" texts follow `PROTOCOL_CAPABILITIES`.

| Phase (issue) | Capability ("cannot ...") | Messages and fields | Screens |
|---|---|---|---|
| 1 (#1748) | none | none: profiles, the effective-login check and `remi profile` are local | none; the apps change nothing |
| 2 (#1749, as filed) | `session_profiles` ("start a session in a chosen account profile") | `session_profiles_request {directory?}` and response `{profiles: [{id, label, harnesses}], default: {id, source}}` with `source` one of `folder`, `machine_default`, `built_in` (proposed; #1749 names "the resolved default"); `create_session_request.profile`; `profile: {id, label}` on session-list entries, `hello_ack` and the create result; proposed optional `profile.state`: `current`, `changed` or `removed` | badge, picker, read-only Accounts list (labels and harnesses) |
| 2b (proposed daemon issue, Q2) | `profile_status` ("check the sign-in of its account profiles") | `profile_status_request` and response `{profiles: [{id, label, isDefault, selectable, harnesses: [{harness, expects, login, source?, reason?, checkedAt?}]}]}` listing every profile shared with devices (Q6), with `login` one of `signed_in`, `signed_out`, `not_own_login`, `unknown`, `source` a name from a closed set (`ANTHROPIC_API_KEY`, `apiKeyHelper`, ...), never a value, and `reason` one of `harness_missing`, `timeout`, `not_checked`, `error`; `profile_check_request {id}`; `profile_guide_request {action, id, label?, harnesses?, expects?, directory?}` and response `{steps: [{text, command?}]}` or a refusal code | Accounts list and detail with sign-in, Check, the Add, Rename, Remove and sign-in guides; picker warnings |
| 3 (#1750) | `profile_usage` ("show account usage") | `profile_usage_request` and response, and an unsolicited `profile_usage_update`, each `{profiles: [{id, billing, windows: [{id, lengthMinutes?, usedPercent?, resetsAt?, source, observedAt}], buckets?, ordinaryUsageAllowed?, limitReached?, plan?, planDeclared?, sameAccountAs?, sameAccount?, accountChangedAt?, thresholds: {warn, offer}}]}`, for profiles shared with devices only (`sameAccountAs` never names a profile that is not shared); a session-list `limitWait {since, continuesAt?}`; push kind `usage_warning` | usage section and view, tile and row markers, Claude's wait on the session, the notice row, the per-device switch |
| 4 (#1751) | `session_compaction` ("compact a session on request"), `handoff_brief` ("write a handoff brief for a session") | `compact_request {sessionId}` and `compact_result {outcome, reason?, summary?}`; `handoff_brief_request {sessionId}` and `handoff_brief_result {brief, omitted}` | Compact now, Handoff brief |
| 5A (#1752) | none | none; characterization only | none |
| 5 (not filed) | `session_continuation` ("continue a session on another account profile") | `continuation_offer` (unsolicited, per profile: trigger, sessions with their state, eligible targets with usage and session counts, the harness's own options); `continuation_preview_request {sessionId, targetProfile}` and response `{previewId, expiresAt, expectedState, differs, broader, lost, billing, targetSessions, acknowledgments}`; `continue_session_request {sessionId, targetProfile, mode, expectedState, previewId, acknowledged}`; `continuation_progress {step}`; `continue_session_response`; session-list `continuedFrom` and `supersededBy` | offer row and banner, confirm sheet, progress, result, lineage links |
| 5B (not filed) | `continuation_resume`, only if 5B passes | `mode: "resume"` | a second choice on the confirm sheet |
| 6 (not approved) | none | none | none |

The first slice that is useful alone is phase 2's: from any device, a person starts a session in a chosen profile and sees which profile every session uses.

## Screens and their states

Placement:

| Screen | iPhone | iPad | Mac | Web |
|---|---|---|---|---|
| Accounts list and detail | Machines sheet, machine section, Accounts | the same sheet, list and detail side by side in regular width | Preferences, Machines, machine detail, Accounts card; machine row context menu; menu command | Settings, Accounts |
| Add, Rename, Remove, sign-in guides | sheet over the Accounts list | form sheet | sheet over Preferences | modal |
| Profile picker | new-session sheet, Agent section | the same sheet | `MacLiveNewSessionSheet` | new-session sheet (#1749) |
| Badge | drawer row, session view and its Session actions menu | Board tile subtitle, sidebar row | session column row, session detail metadata | session card, chat header (#1749) |
| Usage | profile detail; badge opens the profile sheet | badge opens a popover | badge opens a popover; Accounts card | chat header badge, Settings (#1750) |
| Usage notice | Inbox notice row | Inbox notice row | Inbox notice row | banner |
| Compact, brief | session actions menu | session actions menu | session actions menu | chat header menu |
| Continuation offer and confirm | Inbox row, session banner, full sheet | the same, form sheet | Inbox row, session banner, window sheet | banner, modal |

### Accounts list (per machine)

| State | When | Shows | Actions |
|---|---|---|---|
| Unsupported | the machine does not list `session_profiles` | `hubSupport`'s message, which names the capability and says to update remi on that machine and restart it | none |
| Loading | first request in flight | the rows of the last-known copy, dimmed, or a placeholder | none |
| Default only | only the built-in default is shared | "Default sign-in" row and "No other profiles are shared with your devices. Profiles hidden from devices are not listed." | Add a profile (guide) |
| Listed | profiles returned | rows (A2) | open detail; Add |
| Status unavailable | `session_profiles` without `profile_status` | rows with labels and harnesses only, and `hubSupport`'s message for `profile_status` once | open detail (no Check) |
| Offline | the machine is unreachable | the last-known rows dimmed and captioned "Last known, 2 hours ago" | none |
| Failed | the request failed or timed out | "Could not load profiles from Studio" | Try again |

### Profile detail

| State | When | Shows | Actions |
|---|---|---|---|
| Signed in | `login: signed_in` | "Signed in, its own sign-in" per harness, with age | Check |
| Signed out | `signed_out` | "Not signed in" and the command from the hub | Copy, Check |
| Not its own sign-in | `not_own_login` | "Another credential would be used: apiKeyHelper" (the source name only) and what to change at the machine | Copy, Check |
| Unknown | `unknown` | "Not checked" or the reason ("Codex is not installed on Studio", "The check timed out") | Check |
| Checking | check in flight | "Checking…" | none |
| Checked just now | asked within the hub's interval | the last result with its age | Check disabled until the interval ends |
| Removed | the profile disappeared from the list | "This profile was removed on Studio" | back |

### Add, Rename, Remove and sign-in guides

| State | When | Shows | Actions |
|---|---|---|---|
| Form | opened | label, id (suggested), harnesses, expected sign-in (Add); new label (Rename); confirmation text (Remove) | Continue |
| Refused | the hub refused the values | the reason in words: "That id is taken", "Use a name such as Work, not an email address", "A session is running in this profile" | edit, Cancel |
| Commands | the hub returned steps | each step's text and command, numbered | Copy, Share, Check now |
| Found | Check now finds the profile signed in | "Work is ready on Studio" | Done |
| Partly done | found but not signed in, or not selectable | which step remains | Copy, Check now |
| Not found yet | not listed | "Not found on Studio yet. Run the commands above, then check again." | Check now |

### Profile picker (new-session sheet)

| State | When | Shows | Actions |
|---|---|---|---|
| Hidden | the machine does not list `session_profiles` | nothing; the sheet is as today | none |
| Resolving | directory chosen, request in flight | "Profile: resolving…" | Create waits |
| Preselected | the hub answered | the default and its reason | pick another |
| Chosen | the person picked one | "Chosen by you" | pick another |
| Not usable | `profile_status` says signed out or not its own sign-in | the reason and the command | Check; Create disabled |
| Harness missing | the profile does not configure the chosen harness | not offered | none |
| Refused at create | the hub refused the profile | the hub's message, draft kept | change profile, Copy command |

### Session badge

| State | When | Shows |
|---|---|---|
| None | no `session_profiles`, or only the default is shared and the session uses it | no badge on rows and tiles; "Default sign-in" in the session detail |
| Label | the session's profile is current | the label |
| Changed | `profile.state: changed` | the label; the detail note of A4 |
| Removed | `profile.state: removed` | "Work (removed)" |
| Near limit | phase 3, the profile's largest current window is at or above the warning | label, gauge symbol, "Weekly 91%" |
| Waiting | phase 3, Claude Code's own wait | "Waiting for the usage reset; continues at 3:45 PM" |
| Continued | phase 5 lineage | "Continued on Personal" or "Continued from …", each a link |

### Usage section and view

| State | When | Shows |
|---|---|---|
| Unsupported | no `profile_usage` | `hubSupport`'s message |
| Unknown | no observation | "Usage unknown" and what updates it |
| Observed | windows present | rows (A5) |
| Reset passed | `resetsAt` before now | "Reset at …; no reading since" |
| Per request | API-key billing | "Billed per request" |
| Blocked | `ordinaryUsageAllowed: false` | "Blocked by Codex" |
| Account changed | `accountChangedAt` set | "Usage cleared because the account under this profile changed at …" |
| Offline | machine unreachable | last known, dimmed, with its age |

### Continuation confirm sheet

| State | When | Shows | Actions |
|---|---|---|---|
| Loading preview | opened | "Reviewing the two profiles…" | Cancel |
| Preview | the hub answered | the contents of A8, in its order, and the acknowledgments | acknowledgments, Cancel; confirm when all required are on |
| Refused | a precondition failed | the precondition by name, for example "A prompt is waiting in this session; answer it first" | Cancel, open the session |
| Expired | the preview expired or the profiles changed | "These profiles changed since you reviewed them" | Review again |
| In progress | request accepted | each step as reported | none (closing the sheet leaves it running and visible on the session) |
| Done | success | links to the new session and the old one | Open new session |
| Failed | a step failed | the step, "Your session is still resumable on Work" | Close |

## What T3 Code does that remi will not copy, and why

- **Signing in from the app.** T3 Code offers a managed ChatGPT sign-in, an embedded sign-in terminal and a token handoff between machines (T2).
  remi never runs a login from a phone or relays a token [0049 D10]; the Claude Code legal page forbids developers to "collect, store, or intermediate" Claude.ai credentials [0049 V20].
- **Reading a credential to call a vendor endpoint.** T3 Code reads the Claude access token from the configuration directory to read and redeem reset credits (T6).
  remi calls no usage or account endpoint with a credential [0049 O6, D10].
- **Storing secrets in profile settings from the app.** T3 Code's instances hold sensitive environment variables and secret references (T1).
  remi's apps never see or edit a profile's environment values; a profile's `env` stays in the machine's configuration (A1, A10).
- **The email on the client, even blurred.** T3 Code sends the signed-in email to every client and masks it in the view (T5).
  remi sends none and answers "which account" on the machine (A10).
- **Pooling accounts into one allowance.** T3 Code's limits view sums every account of a provider into one number per window (T6).
  That presents separate accounts as one allowance, which is the framing remi must not use [0049 D10: never describe the feature as a way to get more usage]; remi shows each profile on its own.
- **Polling and probing for usage.** T3 Code checks limits when the view opens and runs SDK probes (T6).
  remi only observes what a running session's CLI already reports [0049 D2], and starts nothing to read usage.
- **Linking another account's state into a shared home, and switching a thread's account.** T3 Code's shadow home links one `CODEX_HOME`'s sessions into another so a second login continues the same thread (T4).
  That layout is undocumented by the vendor and is ADR 0049's `resume` mode, gated on phase 5B [0049 C3, G9]; remi keeps a session on one profile for life (A4).
- **Merging the same account across machines.** T3 Code counts an account once across environments (T6), which needs account identifiers on the client.
  remi's fingerprint never leaves its machine [0049 D11].
- **Per-account accent colors.** T3 Code colors instances (T1).
  remi's one accent means "needs you", and state is never color alone.
- **Automatic resume at the reset.** T3 Code schedules a resume at the reset (T7).
  Claude Code already continues on its own after a limit [0049 V10, C4], and remi surfaces that wait instead of adding a second scheduler.
- **A pooled-accounts proxy hub.** T3 Code can read usage from a proxy hub that pools accounts, and its documentation says agent requests can be sent through that hub by configuring the provider separately (T6).
  remi neither reads from nor routes through such a pool: services that "route requests through consumer subscriptions" are what Anthropic's Usage Policy names as unauthorized [0049 V22].

What remi takes from T3 Code: accounts as named configurations on the machine that share one session list (T1, T3);
a label with an id suggested from it (T2);
the login always at the machine, with the app showing how (T2);
the insight that which accounts can continue a conversation is decided by the state directory, which is why a continuation in remi is a new session (T4);
badging only when it disambiguates (T3);
the reveal pattern with the value kept out of the accessibility label until revealed, held in reserve (T5);
and status checks that never set anything up (T9).

## Consequences

- The apps gain an account manager that never writes configuration; every change is one copy-and-paste at the machine, which costs a trip to the terminal that remi requires for the login anyway.
- A new daemon addition (`profile_status`, Q2) is needed before the account manager can show sign-in state; without it, slice 1 still ships the badge, the picker and a read-only list.
- Several capabilities are added over phases 2 to 5, each with fixtures and its phase's ADR amendment; RemiKit's `HubCapability` and the web registry grow with them.
- RemiKit needs a type name that is not "profile" alone (F9); `AccountProfile` is proposed.
- The same account on two machines shows twice; the screen says so.
- `usage_warning` on the legacy push path says less than other pushes (A6), until the R7 gate retires that path.
- Nothing here changes the decision object: the continuation offer is a separate message, and older clients ignore it.

## Open questions for the owner

Each has a recommended option.

- **Q1. App writes to profile configuration.** (a) none: guided commands only (A1, A3); (b) allow creating a profile with a remi-managed directory and renaming its label, behind a capability, never adopting a directory or changing what devices may see; (c) full editing as in T3 Code. **Recommended: (a) for slices 1 to 4, revisited after use.**
- **Q2. Where sign-in status, Check and the guides live on the daemon.** (a) a new daemon issue, "Profiles phase 2b", with its own capability `profile_status`, after #1749; (b) an amendment to #1749 before it starts. **Recommended: (a), so #1749 ships as filed and app slice 1 needs only it.**
- **Q3. The badge when only the default is shared.** (a) hide it on rows and tiles, show "Default sign-in" in the detail (A4); (b) always show it, the literal reading of ADR 0049 D7. **Recommended: (a).**
- **Q4. The noun in the interface.** (a) "Accounts" for the section and "profile" in commands and detail text, because people think in accounts and the CLI is `remi profile`; (b) "Profiles" everywhere. **Recommended: (a).**
- **Q5. Showing the signed-in email.** (a) never (A10, ADR 0049 D10); (b) in the app, masked until revealed, never stored or logged, which needs D10 amended. **Recommended: (a).**
- **Q6. Profiles devices may see but not select.** (a) list them in the account manager with "Only the machine can start sessions in this profile"; (b) list only selectable ones, as the backend plan's picker does. **Recommended: (a) for the manager, (b) for the picker.**
- **Q7. `usage_warning` text on the legacy plaintext push.** (a) kind and machine only (A6); (b) the same text as the sealed path. **Recommended: (a) until the R7 gate.**
- **Q8. Refreshing usage on request.** (a) no Refresh: observe only (A5); (b) let the hub call `account/rateLimits/read` on request for a profile with a live Codex session, rate-limited. **Recommended: (a); (b) can be added later without changing the screens.**
- **Q9. The offer in the Inbox.** (a) an Inbox row and session banners, with the accent only while a session is stopped at the limit (A8); (b) session banners only. **Recommended: (a).**
- **Q10. A profile filter in session lists.** (a) none; search matches labels; (b) a filter chip per profile. **Recommended: (a) until asked.**

## Appendix: sources read

T3 Code at `b60abf32e0b8247b2a425f8065be77352a3b86e4`.
GitHub code search was used to find files; it indexes the default branch, and every file cited was then fetched at the commit above.

- Documentation read in full: `docs/user/providers-codex.md`, `docs/user/providers-claude.md`, `docs/user/usage.md`.
- Documentation read in part: `docs/internals/providers.md` (lines 30 to 80), `docs/user/thread-migration.md` (the first thirty lines), `docs/orchestration-v2/provider-switching-and-context.md` (the first sixty lines).
- Documentation fetched and only searched (for rotation, failover and account-switching terms): `docs/README.md`, `docs/user/portable-handoffs.md`, `docs/user/devices.md`, `docs/user/project-settings.md`, `docs/user/faq.md`, `docs/internals/context-handoffs.md`.
- Source read in the parts cited:
  `packages/contracts/src/providerInstance.ts`,
  `packages/provider-core/src/server/instanceIdentity.ts`,
  `packages/client-runtime/src/state/providerInstanceDisplay.ts`,
  `apps/web/src/providerInstances.ts`,
  under `apps/web/src/components/settings/`: `AddProviderInstanceDialog.tsx`, `AddProviderInstanceDialog.logic.ts`, `ProviderInstanceCard.tsx`, `ProviderSettingsPanel.tsx`, `ProviderAuthenticationSection.tsx`, `ProviderAuthTerminal.tsx`, `RedactedSensitiveText.tsx`;
  `apps/web/src/components/chat/ProviderModelPicker.tsx`, `apps/web/src/components/chat/UsageLimitRecoveryBanner.tsx`,
  `apps/mobile/src/features/threads/thread-provider-instance.ts`,
  under `apps/mobile/src/features/settings/`: `ClaudeAccounts.tsx`, `claude-accounts.ts`, `SettingsProviderAccountsRouteScreen.tsx`;
  under `apps/server/src/provider/`: `ClaudeProvider.ts`, `claudeUsageLimits.ts`, `codexUsageLimits.ts`, `claudeResetCredits.ts`, `Drivers/ClaudeHome.ts`, `Drivers/CodexHomeLayout.ts`.
- Source fetched and only searched or not read: `packages/contracts/src/providerUsageLimits.ts` (searched for the email field), `apps/web/src/components/settings/providerStatus.ts`, `apps/server/src/provider/CodexProvider.ts`, `apps/server/src/provider/CodexChatGptAuth.ts`, `apps/server/src/provider/Drivers/ClaudeDriver.ts`.

remi at `origin/develop` `ab811011`: the files cited in F1 to F11, `packages/native/AGENTS.md`, `packages/native/DESIGN.md`, `packages/native/handoff/ipad-board.md`, `packages/native/PARITY.md`, ADR 0035, 0036, 0038, 0039 and 0049, `.context/account-switching-epic.md`, `.context/issue-1595-backend-plan.md` (section "Profile contract and wrapper settings"), and issues #1157, #1748 to #1752 and #1784.
