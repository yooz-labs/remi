# Account continuation epic: issue drafts (not filed)

Design: [ADR 0049](decisions/0049-account-switching.md) (proposed).
Status: draft from card A01 of land-branches-2026-11, revised with the A02 advisor review (F1 to F12); nothing here is filed.
Each issue below has a title and a body for `gh issue create --title "<title>" --body-file <body>`.
Each body sits between `~~~markdown` fences, with one paragraph or list item per line, as GitHub renders it.
Replace `EPIC` with the epic's issue number after filing it, and `PHASE-N` with the phase issue numbers.
Phases 1 to 5B can be filed at once; phase 5 is not started before phase 5A passes; phase 6 is filed only to record the decisions it waits on.

## Epic

Title: `Epic: account profiles, usage visibility and confirmed continuation (Claude Code and Codex)`

~~~markdown
## Goal

People and teams often hold several accounts with the same provider, and a session can run out of usage. remi wraps every session, so it can bind each session to an account (a profile), check that the account a session will use is really that profile's, show how much of each account's plan usage is spent, compact a session on request, and, when the person confirms, continue the work in a new session on another of that person's own accounts. Claude Code and Codex both.

## Design

ADR 0049 (proposed) records what Claude Code (2.1.323, then 2.1.325) and codex-cli 0.167.0 and their vendors' documentation actually expose, what is not known, the provider terms that bear on switching accounts, and the decisions below. It builds on #1157 (profiles) and the profile contract in `.context/issue-1595-backend-plan.md`; it does not restart them.

## Positioning

Per-session profiles are table stakes: on 2026-11-13 other tools already pin accounts per project and switch at a usage threshold (see the addendum in `.context/competitive-review-2026-10.md`). What remi offers is the method: no credential copied, no usage endpoint called, the source and age shown on every number, and a continuation only when the person confirms it.

## Phases

1. PHASE-1 Per-session account profiles for Claude Code and Codex, with the effective login checked (useful alone: a session runs under the account its project or the person chose, and remi says when something else would be used).
2. PHASE-2 Profile paths, remote choice, remote visibility and the session badge.
3. PHASE-3 Usage visibility per profile, read-only (what each CLI already reports, with source and age; a warning notice; a local account fingerprint).
4. PHASE-4 Compaction on request and the handoff brief (same account).
5. PHASE-5A Characterize the usage-limit state of both harnesses (owner-run gate before PHASE-5).
6. PHASE-5 Continue a session on another of the person's profiles, confirmed by the person.
7. PHASE-5B Characterize resuming the same conversation under another account.
8. PHASE-6 One-shot continuation armed per session: not started; waits on owner decisions and written vendor answers.

## Rules that hold in every phase

remi never reads, copies, stores, prints or relays a credential or token; each CLI keeps its own login in its own store and remi only chooses which store a session uses (#1157 hard rule 1).

Login always runs the CLI's own flow in the person's terminal; a phone shows status and the command, never performs a login (#1157 hard rule 2).

No automatic switching between accounts (#1157 hard rule 3) unless the owner amends that rule for PHASE-6.

No email, workspace name or account identifier is logged, stored or sent to a client; a profile is shown by its label, and an account identifier survives only as a keyed hash kept on the machine.

No feature, product or command name uses "Claude Code" or "Anthropic" (the Claude Code legal page forbids it), and by the same caution none uses an OpenAI or Codex mark.

Tests use the real daemon, hub and parsers with fake `claude` and `codex` executables on `PATH` and the labeled stand-in app-server, as the repository already does; nothing that replaces remi's own logic is mocked. Anything that needs a real login or a model call is an owner-run gate, listed as such. Facts about a CLI are rechecked on the installed version at every phase gate, because the CLIs update themselves.

## Vendor questions

Ask now: Anthropic through the channel its legal page names ("contact sales"), OpenAI through a channel the owner chooses. PHASE-5 is released after an answer or 30 days of silence; PHASE-6 needs written answers.

## Open owner questions

ADR 0049 lists thirteen (Q1 to Q13), each with a recommended option. Phases 1 to 4 do not depend on Q1, Q2 or Q11.
~~~

## Phase 1

Title: `Profiles phase 1: per-session account profiles for Claude Code and Codex`

~~~markdown
Part of EPIC. Builds on #1157 (its phase 1 `profile-core` and phase 4 `profile-harnesses`) and the profile contract in `.context/issue-1595-backend-plan.md`. Design: ADR 0049, D1.

## Goal

A session runs under the account its profile selects, for Claude Code and Codex, from the terminal and from a hub, and remi refuses or warns when the credential the harness would actually use is not that profile's login. Useful alone: a person with a work and a personal subscription can keep a work repository on the work account without aliases, and learns when a project setting or an environment variable would silently use another credential.

## Scope

`[profiles.<id>]` in `config.toml` with an immutable `id`, a `label`, per harness the state directory it selects (`claude` sets `CLAUDE_CONFIG_DIR`, `codex` sets `CODEX_HOME`) and the kind of login it expects (subscription or API key), plus `folders`, `harness`, `args` and `env` as #1157 lists them; `[profiles] default`.

Default directories under the remi home (short canonical paths, created on first use, never renamed), or an existing directory the profile adopts explicitly.

Selection precedence: `--remi-profile <id>` > `REMI_PROFILE` > the longest `folders` match at a path-component boundary > `[profiles] default` > the built-in `default`, which sets nothing and leaves today's behavior unchanged.

Launch environment for an explicit profile: start from the inherited environment, remove every credential and provider selector Claude Code documents as outranking a stored login (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`), `ANTHROPIC_BASE_URL` unless the profile sets it, and, for Codex, every variable a characterization in this phase shows Codex reads as a credential (`OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` are candidates, unverified); apply the profile's selectors and `env`; then remi's secret scrub last. Pass a complete child environment, because `PTYSession.start()` merges `process.env` again.

Effective-login check before every launch: run `claude auth status --json` under the exact launch environment and directory and accept the profile only when `authMethod` matches its expected kind and `apiKeySource` is absent unless it expects an API key (ADR 0049 V27 shows a placeholder `ANTHROPIC_API_KEY` or `apiKeyHelper` reported as `api_key` or `api_key_helper` with `loggedIn: true`); an explicit profile that fails is refused with "this profile's login is not what will be used" and the source name. Codex: the exit code of `codex login status` under the profile's environment.

Configuration-level warnings, read by name only and never by content: an Anthropic profile directory (`~/.config/anthropic`) with an `active_config` file or `configs/` entries; `forceLoginOrgUUID` or `forceLoginMethod` keys in managed settings; `apiKeyHelper` or credential-named `env` keys in managed, user or project settings. Each warning names the source, never a value.

Keep on the machine only the non-identifying facts later phases need: Claude `authMethod`, `apiProvider` and the `apiKeySource` name. Nothing else from the status output is parsed, logged or printed.

Hub children receive the profile through their environment, so the child's PTY and Codex socket resolution follow it with no further change.

The session record stores an optional `profile` id and a private snapshot (selector paths and a revision); absence means `default`. Resume keeps the snapshot; a deleted or changed profile refuses resume with a safe message.

`remi profile ls | add <id> | show <id> | login <id> [--harness claude|codex]`. `login` runs the harness's own login in the person's terminal.

An explicit profile that is unknown or logged out refuses to start, naming `remi profile login <id>`.

## Out of scope

Transcript, status line and probe paths (PHASE-2), protocol fields and the phone (PHASE-2), usage and the account fingerprint (PHASE-3).

## Acceptance criteria

- [ ] With no `[profiles]` table, every existing launch path produces the same argv and environment as before (pinned by a test before the change).
- [ ] The precedence matrix (flag, variable, nested folders, default, built-in) resolves as specified, including a folder boundary case (`/a/b` does not match `/a/bc`).
- [ ] An explicit Claude profile's agent process sees `CLAUDE_CONFIG_DIR` set to the profile's directory and none of the removed variables, even when the daemon's own environment sets them.
- [ ] An explicit Codex profile's TUI and remi's app-server client both use the profile's `CODEX_HOME`.
- [ ] A profile expecting a subscription whose directory holds a placeholder `apiKeyHelper` is refused with "this profile's login is not what will be used" and `apiKeyHelper` named; with the placeholder removed the refusal is gone.
- [ ] Each configuration-level source listed above produces its warning, and no warning text contains a value from a settings file.
- [ ] A hub-created child started with a profile records it, and a resume through the hub keeps it.
- [ ] A logged-out explicit profile refuses to start and prints `remi profile login <id>`; nothing is spawned.
- [ ] `remi profile ls` shows, per profile and harness, logged in, logged out, not its own login, or unknown, and never an email.
- [ ] Characterization recorded in the PR: whether Codex keys its `keyring` credential entries by `CODEX_HOME` (two empty `CODEX_HOME` directories with `cli_auth_credentials_store = "keyring"`, compared by `codex login status` only), and which variables Codex reads as credentials; if keyring entries are not separated, profiles using `keyring` are refused and the PR says so.
- [ ] Owner-run gate: two concurrent sessions in two profiles on the owner's machine each report their own `configDirectory` with a subscription `authMethod` (the value is recorded for later phases), both stay logged in through 24 hours of normal use, and `default` still sees the existing login (#1157's phase 1 gate, rechecked on the installed versions).

## Test approach

Real daemon and hub from source with a temporary `REMI_HOME`; fake `claude` and `codex` executables on `PATH` that record their argv, the values of `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and the names (not values) of credential variables present; their `auth status` and `login status` subcommands print the documented shapes, which tests remi's handling of the CLI's answer, not the CLI. A characterization test runs the installed `claude auth status --json` against empty scratch directories with placeholder strings, as ADR 0049 V27 did (no account, no model call), and is skipped when `claude` is absent. The real config parser and resolver are used for the precedence matrix. The existing child-environment secret test is extended to the profile scrub list. The owner-run gate uses real logins and is recorded by the owner; agents never run it.
~~~

## Phase 2

Title: `Profiles phase 2: profile paths, remote choice and the session badge`

~~~markdown
Part of EPIC. Depends on PHASE-1. Completes the remaining scope of #1157 (`profile-paths`, `profile-phone`). Design: ADR 0049, D1, D6 and D7.

## Goal

Everything remi does for a session follows that session's profile, a phone can create a session in a profile and see which profile each session uses, and the person decides which profiles' sessions remote devices may see.

## Scope

Transcript discovery scans each configured profile's `projects/` directory, not only `~/.claude/projects` (`transcript/transcript-discovery.ts:29`); a Claude session's transcript path comes from its profile.

The status line installer writes to the profile's `settings.json`, not only `~/.claude/settings.json` (`cli/statusline-installer.ts:81`), with the same "only when no `statusLine` is set" rule.

File-download protection covers every configured profile directory, adopted ones included (`cli.ts:1530-1531`, ADR 0045 root policy).

Remote visibility: decide and implement a per-profile `remote_visible` setting (proposed default: visible, today's behavior); sessions and transcripts of a profile that is not remotely visible are not listed to remote clients, because discovery across every profile would otherwise show every profile's sessions to every enrolled device.

Protocol: a `session_profiles` capability; `session_profiles_request/response` returning only `{id, label, harnesses}` for remotely selectable profiles and the default resolved for an optional validated directory; `create_session_request.profile`; the session list entry and `hello_ack` carry `profile: {id, label}`. Limits as the backend plan proposes (32 profiles, id `[a-z0-9][a-z0-9-]{0,31}`, label 1 to 64 safe code points, 64 KiB frames). Golden fixtures and an ADR 0049 amendment.

Web client: a profile badge on the session card and chat header, and a profile picker in the new-session sheet that defaults by folder. Telegram shows the label.

## Acceptance criteria

- [ ] Two sessions in two profiles both reach the phone's chat view with their own transcripts.
- [ ] The status line works in each profile's sessions.
- [ ] A remote `create_session_request.profile` naming a profile that is not remotely selectable is refused before a port is probed or anything is spawned; one naming a selectable profile starts the child in it.
- [ ] Against a daemon without the capability (which would ignore the field), the web client hides the picker.
- [ ] A profile with `remote_visible = false` has none of its sessions or transcripts in any remote list, and the decision and its default are recorded in the ADR amendment.
- [ ] No response or log line carries a local path, email or environment value of a profile.
- [ ] Downloads refuse a file under any configured profile directory, active or not.

## Test approach

Temporary profile directories holding synthetic transcripts read by the real discovery code; the real installer against temporary settings files; two-sided conformance tests that construct the real daemon handler and the real web decoder (ADR 0014); hub integration with fake `claude` recording its environment; web component tests for the badge and picker. Owner-run gate: a session started from the phone in a mapped folder lands in the right profile.
~~~

## Phase 3

Title: `Usage visibility per profile (read-only)`

~~~markdown
Part of EPIC. Depends on PHASE-2. Design: ADR 0049, D2, D3, D7 and D11, and its section on what "98 percent" can be measured against.

## Goal

The person sees how much of each account's plan usage is spent, from what each CLI already reports to its own clients, with the source and the age of every number, gets one warning before a limit, and remi can tell when two profiles are the same account or when the account under a profile changed.

## Scope

Claude: remi's status line script also records the numeric `rate_limits.five_hour` and `rate_limits.seven_day` windows (`used_percentage`, `resets_at`) it receives on standard input (documented at code.claude.com/docs/en/statusline), into a remi-owned per-session file the daemon reads; where the person has their own `statusLine`, remi offers to wrap it (record, then run the person's command on the same input) and otherwise shows "unknown". Present only for Pro, Max and Ultra and only after the first response; absent windows stay absent. `refreshInterval` may refresh the recorded file; it does not make the data newer.

Claude: surface Claude Code's own wait after a usage limit from the `Notification` types `quota_auto_resume_fired`, `quota_auto_resume_stale` and `quota_auto_resume_disabled`, and the `StopFailure` `rate_limit` value remi already receives.

Codex: the session's app-server client calls `account/rateLimits/read` at attach and after each `turn/completed`, and merges `account/rateLimits/updated`; it keeps `primary`, `secondary` and `rateLimitsByLimitId` windows (`usedPercent`, `windowDurationMins`, `resetsAt`), `ordinaryUsageAllowed`, `rateLimitReachedType`, `Account.type` and `planType`, and drops `accountId`, email and workspace names on receipt.

Account fingerprint: a keyed hash (an HMAC with a random key generated on the machine, in an owner-only file under the remi home) of each provider account identifier received (Codex `accountId`), never sent, logged or shown, attached to every observation. Claude `auth_success` and Codex `account/updated` discard the profile's snapshot until a fresh observation; an observation with a new fingerprint starts a new snapshot. For Claude the fingerprint is "unknown" unless PHASE-1's gate found a stable identifier.

One snapshot per profile, shared by its sessions, each window with percentage, length, reset time, source and observation time; observations merge per window by observation time (an older one never overwrites a newer one; a sparse Codex update replaces only the fields it carries); "unknown" is a value, never an estimate; an API-key profile shows "billed per request".

Protocol: a usage snapshot on request and on change for authenticated clients, behind a capability, with fixtures. A new push kind `usage_warning` (mutable per device; ADR 0019 amendment) sent once per profile, window and reset period when the largest window crosses `warn_percent` (default 90, settable 50 to 99) at a turn end.

Web client: a usage panel per profile and the warning.

## Acceptance criteria

- [ ] The status line script records exactly the documented numeric fields and nothing else, and still prints the same status text as before.
- [ ] A Codex session's snapshot updates on `account/rateLimits/updated` and on the read after `turn/completed`; a sparse update never clears a value it does not carry; an older observation from a second session never overwrites a newer one.
- [ ] `ordinaryUsageAllowed: false` is shown as blocked whatever the percentages say; `null` is shown as unknown.
- [ ] Two Codex profiles logged in to the same account are reported as the same account; an `account/updated` or a changed fingerprint discards the profile's snapshot.
- [ ] A profile never observed shows "unknown"; a value shows its age; an API-key profile shows "billed per request".
- [ ] The warning is sent once per profile, window and reset period, respects the device preference, and is never sent for an unknown value.
- [ ] No email, account id, workspace name or credential appears in any file, log line, push or client message (a test scans them); the fingerprint key file is owner-only.

## Test approach

Run the real generated status line script with the documentation's example input on standard input and check the recorded file and the printed text. Drive the real Codex app-server client against the labeled stand-in app-server, which answers `account/rateLimits/read` and sends `account/rateLimits/updated` and `account/updated` frames built from the installed CLI's generated schema and labeled synthetic (like `synthetic-from-schema.jsonl`), because the redaction rules drop captured account frames. The real hook server receives the documented `Notification` `auth_success` payload. Push tests use the real dispatcher with a local HTTP sink. Owner-run gate: on a real subscription the panel agrees with `/usage` (Claude) and `/status` (Codex) within one turn.
~~~

## Phase 4

Title: `Compaction on request and the handoff brief`

~~~markdown
Part of EPIC. Depends on PHASE-1; independent of PHASE-3. Design: ADR 0049, D4 and option C2.

## Goal

From the terminal or a phone, the person can compact a session on its current account and get a handoff brief of the work so far. Useful alone (a long session can be compacted remotely), and the two building blocks of PHASE-5.

## Scope

A compaction request for one session, refused while a turn runs, a prompt is up (the same `promptUp` signal chat and Stop read), a Codex approval card is live, or the session is in a usage-limit wait (there is no headroom there; the brief is offered instead).

Claude: type `/compact` with remi's handoff instructions through the guarded write path chat uses; register `PostCompact` (never `PreCompact`, so remi still never gates compaction, #203) and report completion with its `compact_summary`; `SessionStart` with source `compact` is the second signal. Before shipping, measure that a stopped remi does not delay compaction with the registered hook.

Codex: call `thread/compact/start` and report completion when the `contextCompaction` item completes on that thread (the deprecated `thread/compacted` is accepted as a second signal). Codex exposes no summary text.

A bounded deadline; on expiry the request reports "not confirmed" and the session is untouched.

The handoff brief: built by remi without a model call from what it already reads (the session's directory, branch and a bounded `git status` count, the last user messages and the last final answer from the transcript or thread items), bounded in size, escaped like other harness text, kept local until used.

Protocol: `compact_request/result` and `handoff_brief_request/result`, behind capabilities, with fixtures.

## Acceptance criteria

- [ ] A compaction request while a prompt is up, a turn runs or the session is in a usage-limit wait is refused with the reason and types nothing.
- [ ] Claude: completion is reported from the `PostCompact` hook, and the summary reaches only the requesting authenticated client.
- [ ] Codex: completion is reported from the `contextCompaction` item on the right thread; an item on another thread is ignored.
- [ ] The deadline reports "not confirmed" without touching the session.
- [ ] The brief is the same for the same inputs, bounded, and states what it could not read.
- [ ] Hook registration still excludes `PreCompact`, and the latency measurement with a stopped remi is recorded in the PR.

## Test approach

The real hook server receiving the documented `PostCompact` and `SessionStart` payloads; the guarded write path against a real PTY running a fake `claude` that records its input; the real Codex client against the stand-in app-server emitting the `contextCompaction` item lifecycle; the brief builder on the repository's redacted transcript corpus and a temporary git repository. Owner-run gates: one real `/compact` through remi on each harness, and the stopped-remi latency check, both need an account.
~~~

## Phase 5A

Title: `Characterize the usage-limit state of Claude Code and Codex (gate before phase 5)`

~~~markdown
Part of EPIC. A go or no-go characterization, owner-run, that gates PHASE-5's limit-wait path (ADR 0049 V30, gap G16, D5 and D8). No product code beyond what capture needs.

## Goal

Learn, on the installed versions, exactly what a session looks like to remi when a plan usage limit pauses it, so PHASE-5 can act in that state without typing into a screen it does not understand.

## Questions

Claude: when a usage limit pauses a task, which hooks fire and in what order (`StopFailure` with `rate_limit`, only `Notification` with `quota_auto_resume_*`, or neither)? What does remi's screen parse see: the two footer lines ("Usage limit reached · limit resets ..." and "Continuing automatically at ... · Esc to cancel") and, when automatic continue does not start or is off, the usage-limit options menu, which `promptUp` would report as a numbered menu? Does Claude Code treat a hub child's PTY as "your own terminal" for both? Does a Stop (forced close, since `/exit` is not typed while a menu is up) leave the transcript intact and resumable?

Codex: what the TUI shows at a limit, which frames the app-server sends (`turn/completed` with `usageLimitExceeded`, `account/rateLimits/updated` with `rateLimitReachedType`, `ordinaryUsageAllowed`), and whether any overlay waits for input.

Both: whether `/model` or `/usage-credits` can be sent safely in that state, or only shown to the person.

## Acceptance criteria

- [ ] Each question answered on the owner's machine with remi's opt-in hook trace and a PTY capture of a session that reached a real limit (opportunistically, when one is reached in normal work), recorded in `.context/` with versions and with account details, prompts and output text redacted.
- [ ] A screen and hook signature for the Claude limit wait that remi's parser can match exactly, with a negative control (a permission menu and a trust menu do not match it).
- [ ] A go or no-go for D5's limit-wait path per harness, and the stop path to use.
- [ ] No credential file opened, printed or copied.

## Test approach

Owner-run, because reaching a usage limit needs a real account. Agents may prepare the capture configuration and turn the recorded signature into fixtures for PHASE-5's tests afterwards.
~~~

## Phase 5

Title: `Continue a session on another of the person's profiles (confirmed)`

~~~markdown
Part of EPIC. Depends on PHASE-2, PHASE-3, PHASE-4 and PHASE-5A, and on owner answers to ADR 0049 Q2, Q3, Q5, Q6 and Q9. Released after a vendor answer or 30 days of silence after the questions are sent (Q2). Design: ADR 0049, D3, D5, D7, D8 and D11.

## Goal

When a profile nears or hits its limit, the person can confirm one action that compacts or briefs the session, stops it, and starts a new session in the same directory on another of their own profiles with that material as its first message. Nothing happens without that confirmation, and the person sees what differs between the two profiles and what the new session will not have before confirming.

## Scope

A hub request `continue_session_request {sessionId, targetProfile, mode, expectedState}` with mode `summary` (the default; compaction summary when the source has headroom, otherwise the brief) and `resume` reserved for PHASE-5B, and `expectedState` `idle` or `limitWait`.

Limit wait, as characterized by PHASE-5A: a numbered menu matching the recorded limit signature does not count as a prompt for this request, while a held hook, a hook-backed prompt, any other menu and any Codex approval still do; remi types nothing into the wait or the menu, takes the brief, and stops the source by forced close. If PHASE-5A returned no-go for a harness, its limit wait is refused with "answer or cancel the usage-limit screen first".

Preconditions, each refused with a reason naming it: a hub child session (a wrapper session gets the exact command instead); the expected state holds; no prompt up and no Codex approval live; the target configured, allowed for the directory, marked `continuation_target`, remotely selectable for a remote caller; the target's effective login is its own (PHASE-1 check); the target's last snapshot below `offer_percent` (default 95) with `ordinaryUsageAllowed` not false, or unknown and confirmed as unknown; the target is not the same account as the source by fingerprint (unknown is shown as unknown); no other continuation of this session in flight.

Confirm screen: a diff of the two profiles' permission rules and hooks (Claude `settings.json` `permissions` and `hooks`; Codex `approval_policy`, `sandbox_mode`, `model_provider`), rule texts and hook commands only, never `env` values, with a target that allows more flagged for its own confirmation; a list of what the new session will not have (the permission mode and standing grants of this session, background tasks and background-session state, and the source profile's settings, hooks, plugins, skills, MCP servers, user `CLAUDE.md` and auto-memory where the target's differ); "billed per request" for an API-key target; the sessions already on the target.

Steps: material, stop the source (Stop path from idle, forced close from limit wait), start the target through the hub starter with the same directory and harness, submit the material as the first message (structured submission for Codex, ADR 0043; the guarded write path for Claude), record `continuedFrom` on the new session and `supersededBy` on the source, report the result. A failure stops at its step, reports it, and never retries or picks another profile. The step reached is persisted across a hub restart and nothing resumes on its own. Resuming a superseded session warns that the continued session may be editing the same working tree and needs a confirmation.

The offer: one per profile, listing every session on it, at `offer_percent` at a turn end, on a turn failed on `rate_limit` or `usageLimitExceeded`, or in the limit wait: "Compact now" (idle only), "Continue on" an eligible profile (with its usage, age and sessions), "Wait for reset" when Claude Code's own wait is running, and the harness's own `/usage-credits` and `/model`, shown as commands for the terminal or `remi attach` unless PHASE-5A found a safe way to send them. Confirmation needs the app; no lock-screen action.

Protocol and web client for the offer, the confirmation screen, the progress and the result, with fixtures.

## Acceptance criteria

- [ ] Every precondition has a test that refuses with its own reason and leaves the source session untouched.
- [ ] A continuation in `summary` mode from idle ends with the source stopped, marked superseded and resumable under its own profile, and the target running in the same directory under the target profile with the material as its first message.
- [ ] A continuation from the limit wait, replayed from PHASE-5A's recorded signature, types nothing into the source's PTY, takes the brief and stops the source by forced close; a permission or trust menu with the same layout is refused.
- [ ] The confirm screen shows the permission and hook diff and the loss list; a more permissive target needs its own confirmation; no `env` value appears.
- [ ] A target that is logged out, not its own login, the same account, at its threshold or blocked is never offered and is refused if requested directly.
- [ ] A failure injected at each step stops there, reports the step, and starts nothing else.
- [ ] Two concurrent requests: the first wins, the second is refused; N sessions on one profile produce one offer.
- [ ] No automatic path exists: a test asserts that no code path sends `continue_session_request` without a client confirmation or a terminal command.
- [ ] Owner-run gate: on the owner's machine, a real session continues from one real profile to another, from idle and from a real limit wait, and the new session picks up the work from its first message.

## Test approach

Hub integration with two profiles and fake `claude` and `codex` executables that record their environment and first input, replay PHASE-5A's recorded limit screens, and exit with the documented failures; the real prompt tracker and the stand-in app-server create the "prompt up" and "approval live" states; temporary profile directories with differing `settings.json` and `config.toml` drive the real diff; failures are injected through the fake executables, never by replacing remi's handlers. The owner-run gate needs two real logins and model calls.
~~~

## Phase 5B

Title: `Characterize resuming the same conversation under another profile`

~~~markdown
Part of EPIC. A go or no-go characterization for PHASE-5's `resume` mode (ADR 0049 option C3, gaps G8 and G9, owner question Q4). No product code.

## Goal

Learn, on the installed versions, whether a conversation started under one account can continue under another as the same conversation, and at what cost, before remi offers it.

## Questions

Claude: does `claude --resume <id>` (and with `--fork-session`) under configuration directory B accept a transcript copied from directory A's `projects/<folder>/`, and what else from A does the session need? Session history lives under the configuration directory, and no documented variable shares it.

Claude, without copying anything: does a shared `projects/` directory (a symbolic link from both profiles' configuration directories to one place) let profile B resume A's session, and what does it break (auto-memory, cleanup, concurrent writers)?

Claude: do the conversation's signed thinking blocks stay valid when the next request comes from another account, or must they be dropped (for example by compacting first)?

Codex: does an app-server under `CODEX_HOME` B resume or fork a thread from A's rollout with the experimental `thread/resume` or `thread/fork` `path` parameter, and does `modelProviderMismatch` or anything else refuse it?

Both: does the first turn after the move send the whole history to the new account (prompt caches are per account), and how much does compaction first reduce it?

## Acceptance criteria

- [ ] Each question answered with commands and outputs on throwaway sessions and the owner's own accounts, recorded in `.context/` with versions.
- [ ] A go or no-go for each harness and route (copy, shared link, rollout path), with the conditions under which it holds.
- [ ] No credential file opened, printed or copied; only transcripts and rollouts of throwaway sessions are moved or linked.

## Test approach

Owner-run with throwaway sessions, because it needs real logins and model calls. Agents may prepare the script and read only the CLI's own outputs.
~~~

## Phase 6

Title: `One-shot continuation armed per session (waits on owner decisions and vendor answers)`

~~~markdown
Part of EPIC. Not started. Depends on PHASE-5 and on three decisions: the owner amending #1157 hard rule 3 (ADR 0049 Q1), written answers from the vendor concerned (Q2), and the shape (Q11, recommended: this one).

## Why it waits

Automatic rotation to keep working past a usage limit reads against provider terms read for ADR 0049: OpenAI's Services Agreement forbids customers to "violate or circumvent Usage Limits or otherwise configure the Services to avoid Usage Limits" (3.3(i)), where "Usage Limits" means limits "described in the applicable Order Form or Documentation", and Anthropic's Usage Policy forbids to "Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products" and to "create multiple accounts, to avoid detection, circumvent product guardrails", while Claude Code's legal page says advertised plan limits "assume ordinary, individual usage". OpenAI's consumer Terms of Use could not be read (HTTP 403) and are unverified. No text read allows automatic switching between one person's own accounts.

## The only shape it may take

Not standing rotation. The person arms, in the app, one continuation for one session onto one chosen target; it fires at most once, on the authoritative limit event (a turn failed on the usage limit, or the characterized limit wait), and expires at the source window's reset. Only between one person's own individual subscriptions, never to or from a team, business or enterprise seat; never while a prompt or approval is live; a notice when armed, when it fires and when it expires; all of PHASE-5's preconditions, confirm-screen contents and steps, with the confirmation given at arming time.

## Acceptance criteria

- [ ] The owner's decisions on Q1 and Q11 and the vendor's written answer are linked here before any code.
- [ ] If any of them is no, this issue is closed as not planned and ADR 0049 records why.
~~~
