# Account continuation epic: issue drafts (not filed)

Design: [ADR 0049](decisions/0049-account-switching.md) (proposed).
Status: draft from card A01 of land-branches-2026-11; nothing here is filed.
Each issue below has a title and a body for `gh issue create --title "<title>" --body-file <body>`.
Each body sits between `~~~markdown` fences, with one paragraph or list item per line, as GitHub renders it.
Replace `EPIC` with the epic's issue number after filing it, and `PHASE-N` with the phase issue numbers.
Phases 1 to 5 can be filed at once; phase 6 is filed only to record the decision it waits on.

## Epic

Title: `Epic: account profiles, usage visibility and confirmed continuation (Claude Code and Codex)`

~~~markdown
## Goal

People and teams often hold several accounts with the same provider, and a session can run out of usage. remi wraps every session, so it can bind each session to an account (a profile), show how much of each account's plan usage is spent, compact a session on request, and, when the person confirms, continue the work in a new session on another of that person's own accounts. Claude Code and Codex both.

## Design

ADR 0049 (proposed) records what Claude Code 2.1.323 and codex-cli 0.167.0 and their vendors' documentation actually expose, what is not known, the provider terms that bear on switching accounts, and the decisions below. It builds on #1157 (profiles) and the profile contract in `.context/issue-1595-backend-plan.md`; it does not restart them.

## Phases

1. PHASE-1 Per-session account profiles for Claude Code and Codex (useful alone: a session runs under the account its project or the person chose).
2. PHASE-2 Profile paths, remote choice and the session badge (transcripts, status line and probes follow the profile; a phone picks a profile).
3. PHASE-3 Usage visibility per profile, read-only (what each CLI already reports, with source and age; a warning notice).
4. PHASE-4 Compaction on request and the handoff brief (same account).
5. PHASE-5 Continue a session on another of the person's profiles, confirmed by the person; PHASE-5B characterizes resuming the same conversation under another account.
6. PHASE-6 Automatic continuation: not started; waits on an owner decision and written vendor confirmation.

## Rules that hold in every phase

remi never reads, copies, stores, prints or relays a credential or token; each CLI keeps its own login in its own store and remi only chooses which store a session uses (#1157 hard rule 1).

Login always runs the CLI's own flow in the person's terminal; a phone shows status and the command, never performs a login (#1157 hard rule 2).

No automatic switching between accounts (#1157 hard rule 3) unless the owner amends that rule in PHASE-6.

No email, account id or workspace name is logged, stored or sent to a client; a profile is shown by its label.

Tests use the real daemon, hub and parsers with fake `claude` and `codex` executables on `PATH` and the labeled stand-in app-server, as the repository already does; nothing that replaces remi's own logic is mocked. Anything that needs a real login or a model call is an owner-run gate, listed as such.

## Open owner questions

ADR 0049 lists ten (Q1 to Q10), each with a recommended option. Phases 1 to 4 do not depend on Q1 or Q2.
~~~

## Phase 1

Title: `Profiles phase 1: per-session account profiles for Claude Code and Codex`

~~~markdown
Part of EPIC. Builds on #1157 (its phase 1 `profile-core` and phase 4 `profile-harnesses`) and the profile contract in `.context/issue-1595-backend-plan.md`. Design: ADR 0049, D1.

## Goal

A session runs under the account its profile selects, for Claude Code and Codex, from the terminal and from a hub. Useful alone: a person with a work and a personal subscription can keep a work repository on the work account without aliases.

## Scope

`[profiles.<id>]` in `config.toml` with an immutable `id`, a `label`, and per harness the state directory it selects (`claude` sets `CLAUDE_CONFIG_DIR`, `codex` sets `CODEX_HOME`), plus `folders`, `harness`, `args` and `env` as #1157 lists them; `[profiles] default`.

Default directories under the remi home (short canonical paths, created on first use, never renamed), or an existing directory the profile adopts explicitly.

Selection precedence: `--remi-profile <id>` > `REMI_PROFILE` > the longest `folders` match at a path-component boundary > `[profiles] default` > the built-in `default`, which sets nothing and leaves today's behavior unchanged.

Launch environment for an explicit profile: start from the inherited environment, remove every credential and provider selector Claude Code documents as outranking a stored login (`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`) and, for Codex, every variable a characterization in this phase shows Codex reads as a credential (`OPENAI_API_KEY` and `CODEX_ACCESS_TOKEN` are candidates, unverified), apply the profile's selectors and `env`, then remi's secret scrub last. Pass a complete child environment, because `PTYSession.start()` merges `process.env` again.

Hub children receive the profile through their environment, so the child's PTY and Codex socket resolution follow it with no further change.

The session record stores an optional `profile` id and a private snapshot (selector paths and a revision); absence means `default`. Resume keeps the snapshot; a deleted or changed profile refuses resume with a safe message.

`remi profile ls | add <id> | show <id> | login <id> [--harness claude|codex]`. Status comes only from `claude auth status --json` (`loggedIn`, `loginExpiresAt`) and the exit code of `codex login status`, run under the profile's environment; no other field is parsed, logged or printed. `login` runs the harness's own login in the person's terminal.

An explicit profile that is unknown or logged out refuses to start, naming `remi profile login <id>`.

## Out of scope

Transcript, status line and probe paths (PHASE-2), protocol fields and the phone (PHASE-2), usage (PHASE-3).

## Acceptance criteria

- [ ] With no `[profiles]` table, every existing launch path produces the same argv and environment as before (pinned by a test before the change).
- [ ] The precedence matrix (flag, variable, nested folders, default, built-in) resolves as specified, including a folder boundary case (`/a/b` does not match `/a/bc`).
- [ ] An explicit Claude profile's agent process sees `CLAUDE_CONFIG_DIR` set to the profile's directory and none of the removed variables, even when the daemon's own environment sets them.
- [ ] An explicit Codex profile's TUI and remi's app-server client both use the profile's `CODEX_HOME`.
- [ ] A hub-created child started with a profile records it, and a resume through the hub keeps it.
- [ ] A logged-out explicit profile refuses to start and prints `remi profile login <id>`; nothing is spawned.
- [ ] `remi profile ls` shows, per profile and harness, logged in, logged out or unknown, and never an email.
- [ ] Owner-run gate: two concurrent sessions in two profiles on the owner's machine each report `loggedIn: true` for their own `configDirectory`, both stay logged in through 24 hours of normal use, and `default` still sees the existing login (#1157's phase 1 gate, rechecked on the installed versions).

## Test approach

Real daemon and hub from source with a temporary `REMI_HOME`; fake `claude` and `codex` executables on `PATH` that record their argv, the values of `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, and the names (not values) of credential variables present; their `auth status` and `login status` subcommands print the documented logged-out and logged-in shapes, which tests remi's handling of the CLI's answer, not the CLI. The real config parser and resolver are used for the precedence matrix. The existing child-environment secret test is extended to the profile scrub list. The owner-run gate uses real logins and is recorded by the owner; agents never run it.
~~~

## Phase 2

Title: `Profiles phase 2: profile paths, remote choice and the session badge`

~~~markdown
Part of EPIC. Depends on PHASE-1. Completes the remaining scope of #1157 (`profile-paths`, `profile-phone`). Design: ADR 0049, D1, D6 and D7.

## Goal

Everything remi does for a session follows that session's profile, and a phone can create a session in a profile and see which profile each session uses.

## Scope

Transcript discovery scans each configured profile's `projects/` directory, not only `~/.claude/projects` (`transcript/transcript-discovery.ts:29`); a Claude session's transcript path comes from its profile.

The status line installer writes to the profile's `settings.json`, not only `~/.claude/settings.json` (`cli/statusline-installer.ts:81`), with the same "only when no `statusLine` is set" rule.

File-download protection covers every configured profile directory, adopted ones included (`cli.ts:1530-1531`, ADR 0045 root policy).

Protocol: a `session_profiles` capability; `session_profiles_request/response` returning only `{id, label, harnesses}` for remotely selectable profiles and the default resolved for an optional validated directory; `create_session_request.profile`; the session list entry and `hello_ack` carry `profile: {id, label}`. Limits as the backend plan proposes (32 profiles, id `[a-z0-9][a-z0-9-]{0,31}`, label 1 to 64 safe code points, 64 KiB frames). Golden fixtures and an ADR 0049 amendment.

Web client: a profile badge on the session card and chat header, and a profile picker in the new-session sheet that defaults by folder. Telegram shows the label.

## Acceptance criteria

- [ ] Two sessions in two profiles both reach the phone's chat view with their own transcripts.
- [ ] The status line works in each profile's sessions.
- [ ] A remote `create_session_request.profile` naming a profile that is not remotely selectable is refused before a port is probed or anything is spawned; one naming a selectable profile starts the child in it.
- [ ] Against a daemon without the capability (which would ignore the field), the web client hides the picker.
- [ ] No response or log line carries a local path, email or environment value of a profile.
- [ ] Downloads refuse a file under any configured profile directory, active or not.

## Test approach

Temporary profile directories holding synthetic transcripts read by the real discovery code; the real installer against temporary settings files; two-sided conformance tests that construct the real daemon handler and the real web decoder (ADR 0014); hub integration with fake `claude` recording its environment; web component tests for the badge and picker. Owner-run gate: a session started from the phone in a mapped folder lands in the right profile.
~~~

## Phase 3

Title: `Usage visibility per profile (read-only)`

~~~markdown
Part of EPIC. Depends on PHASE-2. Design: ADR 0049, D2, D3 and D7, and its section on what "98 percent" can be measured against.

## Goal

The person sees how much of each account's plan usage is spent, from what each CLI already reports to its own clients, with the source and the age of every number, and gets one warning before a limit.

## Scope

Claude: remi's status line script also records the numeric `rate_limits.five_hour` and `rate_limits.seven_day` windows (`used_percentage`, `resets_at`) it receives on standard input (documented at code.claude.com/docs/en/statusline), into a remi-owned per-session file the daemon reads; where the person has their own `statusLine`, remi offers to wrap it (record, then run the person's command on the same input) and otherwise shows "unknown". Present only for Pro, Max and Ultra and only after the first response; absent windows stay absent.

Claude: surface Claude Code's own wait after a usage limit from the `Notification` types `quota_auto_resume_fired`, `quota_auto_resume_stale` and `quota_auto_resume_disabled`, and the `StopFailure` `rate_limit` value remi already receives.

Codex: the session's app-server client calls `account/rateLimits/read` at attach and after each `turn/completed`, and merges `account/rateLimits/updated`; it keeps `primary`, `secondary` and `rateLimitsByLimitId` windows (`usedPercent`, `windowDurationMins`, `resetsAt`), `ordinaryUsageAllowed` and `rateLimitReachedType`, and drops `accountId`, email and workspace names on receipt.

One snapshot per profile, shared by its sessions, each window with percentage, length, reset time, source and observation time; "unknown" is a value, never an estimate.

Protocol: a usage snapshot on request and on change for authenticated clients, behind a capability, with fixtures. A new push kind `usage_warning` (mutable per device; ADR 0019 amendment) sent once per profile, window and reset period when the largest window crosses `warn_percent` (default 90, settable 50 to 99) at a turn end.

Web client: a usage panel per profile and the warning.

## Acceptance criteria

- [ ] The status line script records exactly the documented numeric fields and nothing else, and still prints the same status text as before.
- [ ] A Codex session's snapshot updates on `account/rateLimits/updated` and on the read after `turn/completed`; a sparse update never clears a value it does not carry.
- [ ] `ordinaryUsageAllowed: false` is shown as blocked whatever the percentages say; `null` is shown as unknown.
- [ ] A profile never observed shows "unknown"; a value shows its age.
- [ ] The warning is sent once per profile, window and reset period, respects the device preference, and is never sent for an unknown value.
- [ ] No email, account id, plan workspace name or credential appears in any file, log line, push or client message (a test scans them).

## Test approach

Run the real generated status line script with the documentation's example input on standard input and check the recorded file and the printed text. Drive the real Codex app-server client against the labeled stand-in app-server, which answers `account/rateLimits/read` and sends `account/rateLimits/updated` frames built from the installed CLI's generated schema and labeled synthetic (like `synthetic-from-schema.jsonl`), because the redaction rules drop captured account frames. Push tests use the real dispatcher with a local HTTP sink. Owner-run gate: on a real subscription the panel agrees with `/usage` (Claude) and `/status` (Codex) within one turn.
~~~

## Phase 4

Title: `Compaction on request and the handoff brief`

~~~markdown
Part of EPIC. Depends on PHASE-1; independent of PHASE-3. Design: ADR 0049, D4 and option C2.

## Goal

From the terminal or a phone, the person can compact a session on its current account and get a handoff brief of the work so far. Useful alone (a long session can be compacted remotely), and the two building blocks of PHASE-5.

## Scope

A compaction request for one session, refused while a turn runs or a prompt is up (the same `promptUp` signal chat and Stop read) or a Codex approval card is live.

Claude: type `/compact` with remi's handoff instructions through the guarded write path chat uses; register `PostCompact` (never `PreCompact`, so remi still never gates compaction, #203) and report completion with its `compact_summary`; `SessionStart` with source `compact` is the second signal. Before shipping, measure that a stopped remi does not delay compaction with the registered hook.

Codex: call `thread/compact/start` and report completion when the `contextCompaction` item completes on that thread (the deprecated `thread/compacted` is accepted as a second signal). Codex exposes no summary text.

A bounded deadline; on expiry the request reports "not confirmed" and the session is untouched.

The handoff brief: built by remi without a model call from what it already reads (the session's directory, branch and a bounded `git status` count, the last user messages and the last final answer from the transcript or thread items), bounded in size, escaped like other harness text, kept local until used.

Protocol: `compact_request/result` and `handoff_brief_request/result`, behind capabilities, with fixtures.

## Acceptance criteria

- [ ] A compaction request while a prompt is up or a turn runs is refused with the reason and types nothing.
- [ ] Claude: completion is reported from the `PostCompact` hook, and the summary reaches only the requesting authenticated client.
- [ ] Codex: completion is reported from the `contextCompaction` item on the right thread; an item on another thread is ignored.
- [ ] The deadline reports "not confirmed" without touching the session.
- [ ] The brief is the same for the same inputs, bounded, and states what it could not read.
- [ ] Hook registration still excludes `PreCompact`, and the latency measurement with a stopped remi is recorded in the PR.

## Test approach

The real hook server receiving the documented `PostCompact` and `SessionStart` payloads; the guarded write path against a real PTY running a fake `claude` that records its input; the real Codex client against the stand-in app-server emitting the `contextCompaction` item lifecycle; the brief builder on the repository's redacted transcript corpus and a temporary git repository. Owner-run gates: one real `/compact` through remi on each harness, and the stopped-remi latency check, both need an account.
~~~

## Phase 5

Title: `Continue a session on another of the person's profiles (confirmed)`

~~~markdown
Part of EPIC. Depends on PHASE-2, PHASE-3 and PHASE-4, and on owner answers to ADR 0049 Q2, Q3, Q5, Q6 and Q9. Design: ADR 0049, D3, D5, D7 and D8.

## Goal

When a profile nears or hits its limit, the person can confirm one action that compacts or briefs the session, stops it, and starts a new session in the same directory on another of their own profiles with that material as its first message. Nothing happens without that confirmation.

## Scope

A hub request `continue_session_request {sessionId, targetProfile, mode}` with mode `summary` (the default; compaction summary when the source has headroom, otherwise the brief) and `resume` reserved for PHASE-5B.

Preconditions, each refused with a reason naming it: a hub child session (a wrapper session gets the exact command instead); no turn running; no prompt up and no Codex approval live; the target configured, allowed for the directory, marked `continuation_target`, remotely selectable for a remote caller; the target logged in; the target's last snapshot below `offer_percent` (default 95) with `ordinaryUsageAllowed` not false, or unknown and confirmed as unknown; no other continuation of this session in flight.

Steps: material, stop the source through the existing Stop path, start the target through the hub starter with the same directory and harness, submit the material as the first message (structured submission for Codex, ADR 0043; the guarded write path for Claude), record `continuedFrom`, report the result. A failure stops at its step, reports it, and never retries or picks another profile. The step reached is persisted across a hub restart and nothing resumes on its own.

The offer: at `offer_percent` at a turn end, or on a turn failed on `rate_limit` or `usageLimitExceeded`, authenticated clients get "Compact now", "Continue on" a named profile (eligible targets only, each with its usage and age) and "Wait for reset" when Claude Code's own wait is running. Confirmation needs the app; no lock-screen action.

Protocol and web client for the offer, the confirmation, the progress and the result, with fixtures.

## Acceptance criteria

- [ ] Every precondition has a test that refuses with its own reason and leaves the source session untouched.
- [ ] A continuation in `summary` mode ends with the source stopped and resumable under its own profile, and the target running in the same directory under the target profile with the material as its first message.
- [ ] A target that is logged out, at its threshold or blocked is never offered and is refused if requested directly.
- [ ] A failure injected at each step stops there, reports the step, and starts nothing else.
- [ ] Two concurrent requests: the first wins, the second is refused.
- [ ] No automatic path exists: a test asserts that no code path sends `continue_session_request` without a client confirmation or a terminal command.
- [ ] Owner-run gate: on the owner's machine, a real session continues from one real profile to another and the new session picks up the work from its first message.

## Test approach

Hub integration with two profiles and fake `claude` and `codex` executables that record their environment and first input and can exit with the documented failures; the real prompt tracker and the stand-in app-server create the "prompt up" and "approval live" states; failures are injected through the fake executables, never by replacing remi's handlers. The owner-run gate needs two real logins and model calls.
~~~

## Phase 5B

Title: `Characterize resuming the same conversation under another profile`

~~~markdown
Part of EPIC. A go or no-go characterization for PHASE-5's `resume` mode (ADR 0049 option C3, gaps G8 and G9, owner question Q4). No product code.

## Goal

Learn, on the installed versions, whether a conversation started under one account can continue under another as the same conversation, and at what cost, before remi offers it.

## Questions

Claude: does `claude --resume <id>` (and with `--fork-session`) under configuration directory B accept a transcript copied from directory A's `projects/<folder>/`, and what else from A does the session need? Session history lives under the configuration directory, and no documented variable shares it.

Codex: does an app-server under `CODEX_HOME` B resume or fork a thread from A's rollout with the experimental `thread/resume` or `thread/fork` `path` parameter, and does `modelProviderMismatch` or anything else refuse it?

Does the first turn after the move send the whole history to the new account (prompt caches are per account), and how much does compaction first reduce it?

## Acceptance criteria

- [ ] Each question answered with commands and outputs on throwaway sessions and the owner's own accounts, recorded in `.context/` with versions.
- [ ] A go or no-go for each harness, with the conditions under which it holds.
- [ ] No credential file opened, printed or copied; only transcripts and rollouts of throwaway sessions are moved.

## Test approach

Owner-run with throwaway sessions, because it needs real logins and model calls. Agents may prepare the script and read only the CLI's own outputs.
~~~

## Phase 6

Title: `Automatic continuation (waits on an owner decision and vendor confirmation)`

~~~markdown
Part of EPIC. Not started. Depends on PHASE-5 and on two decisions: the owner amending #1157 hard rule 3 (ADR 0049 Q1) and written confirmation from the vendor concerned (Q2).

## Why it waits

Automatic rotation to keep working past a usage limit reads against provider terms read for ADR 0049: OpenAI's Services Agreement forbids customers to "violate or circumvent Usage Limits or otherwise configure the Services to avoid Usage Limits" (3.3(i)), and Anthropic's Usage Policy forbids to "Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products" and to "create multiple accounts, to avoid detection, circumvent product guardrails", while Claude Code's legal page says advertised plan limits "assume ordinary, individual usage". OpenAI's consumer Terms of Use could not be read (HTTP 403) and are unverified. No text read allows automatic switching between one person's own accounts.

## If both decisions allow it

Opt-in per pair of profiles; only between one person's own individual subscriptions, never to or from a team, business or enterprise seat; at most once per session per reset window; never while a prompt or approval is live; a notice before and after; one setting that turns it off; the same preconditions and steps as PHASE-5 with the confirmation replaced by the opt-in.

## Acceptance criteria

- [ ] The owner's decision on Q1 and the vendor's written answer are linked here before any code.
- [ ] If either is no, this issue is closed as not planned and ADR 0049 records why.
~~~
