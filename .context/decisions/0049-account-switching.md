# ADR 0049: Account profiles, usage visibility and confirmed continuation across a person's own accounts

**Status:** proposed (design draft from card A01 of the land-branches-2026-11 plan; not accepted; the owner decides at checkpoint CP4)
**Date:** 2026-11-13
**Owner:** Yahya
**Builds on:** #1157 (profiles), the profile contract in `.context/issue-1595-backend-plan.md`, ADR 0032, ADR 0033, ADR 0036, ADR 0038, ADR 0043
**Epic text:** `.context/account-switching-epic.md` (titles and bodies, not filed)

## Context

The owner's idea, in substance:
a person or a team often holds several accounts with the same provider, and a session can run out of usage.
If remi tracks usage per account, then at about 98 percent remi (the software that wraps the whole system) should compact the session, or at least notify the user and then compact,
and switch smoothly to another account the user has, so the work continues.
Sessions with different scopes may also need different logins, so a session should be bound to an account.
It applies to Claude Code and to Codex, it is a continuation-of-work feature, and it must come as one phased epic whose first phase is useful alone.

Much of this is already designed.
Issue #1157 proposes per-session profiles: a profile chooses which state directory each harness uses (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) plus safe settings, and remi never touches a credential.
The backend plan (`.context/issue-1595-backend-plan.md`, section "Profile contract and wrapper settings (#1157)"), following the media and profile plan approved in #1313, proposes the contract: one immutable profile snapshot per session, `--remi-profile` before `REMI_PROFILE` before a folder mapping, a scrubbed child environment, and a `session_profiles` capability for remote choice.
None of it is built: the protocol has no profile field and the daemon reads `CLAUDE_CONFIG_DIR` and `CODEX_HOME` only for file-download protection (V7).

Two things are new in the owner's idea: tracking usage per account, and switching accounts when one runs low.
The second collides with #1157 hard rule 3 ("No automatic failover between accounts, so profiles cannot be used to sidestep a plan's usage limits") and with provider terms read for this ADR (V20 to V26).
This ADR records what the installed Command-Line Interfaces (CLIs) and their vendors' documentation actually expose, separates that from what is proposed, and proposes an order of work that is useful without the contested part.
It contains no implementation.

Citations: `[cmd: file]` is a command and its output under `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/A01/r1/` (Appendix A);
`[doc: URL]` is vendor documentation read on 2026-11-13 (Appendix B);
`[src: path:line]` is remi source at `origin/develop` `68940c1d` (Appendix C).
Installed versions: Claude Code 2.1.323, codex-cli 0.167.0 `[cmd: claude-help.txt, codex-help.txt]`.

## Verified facts

### Account selection and login

- **V1.** Claude Code supports several accounts at once through separate configuration directories: "To stay signed in to multiple accounts at once, such as work and personal accounts, give each account its own configuration directory. When you start `claude`, set the `CLAUDE_CONFIG_DIR` environment variable to the directory for the account you want to use. Each directory has its own settings, session history, and claude.ai login or API key."
  On macOS it "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry."
  Exception: two Console sign-ins without an Application Programming Interface (API) key are not kept apart, "because Claude Code stores that kind of sign-in outside the configuration directory." `[doc: code.claude.com/docs/en/authentication]`
- **V2.** Session history follows the configuration directory: `CLAUDE_CONFIG_DIR` "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path." `[doc: code.claude.com/docs/en/env-vars]`
  Under a fresh, empty directory, `claude auth status --json` prints `"loggedIn": false`, `"authMethod": "none"`, `"projectsDirectory": "<dir>/projects"`, `"configDirectory": "<dir>"`, `"loginExpiresAt": null` and exits 1; `--text` prints "Not logged in. Run claude auth login to authenticate." `[cmd: fresh-login-status.txt]`
- **V3.** Credentials in the environment outrank a stored login, in this order: a cloud provider selector, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profile and federation credentials, and last "Subscription OAuth credentials from `/login`." `[doc: code.claude.com/docs/en/authentication]`
  An expired login that cannot be refreshed makes "each model request" fail "with `Login expired · Please run /login`". (same page)
- **V4.** `claude auth` has `login` (`--claudeai`, `--console`, `--email`, `--sso`), `logout` and `status` (`--json` default, `--text`). `[cmd: claude-auth-help.txt]`
- **V5.** Codex keeps its login per `CODEX_HOME`: with `cli_auth_credentials_store`, "`file` stores credentials in `auth.json` under `CODEX_HOME` (defaults to `~/.codex`)", `keyring` and `auto` use the operating system credential store, and `ephemeral` "keeps credentials in memory only for the current process". `[doc: learn.chatgpt.com/docs/auth]`
  Under a fresh `CODEX_HOME`, `codex login status` prints "Not logged in" and exits 1. `[cmd: fresh-login-status.txt]`
  `codex login` takes `--with-api-key`, `--with-access-token` and `--device-auth`; Codex's own `-p, --profile` only "Layer[s] `$CODEX_HOME/<name>.config.toml` on top of the base user config", so it cannot select an account. `[cmd: codex-login-help.txt, codex-help.txt]`
- **V6.** The Codex app-server reports the account it runs under (`account/read` returns `{type: "chatgpt", email, planType, workspaceName}`, `{type: "apiKey"}` and others) and announces changes (`account/updated`).
  Its experimental surface, absent from the standard schema and from the documentation page, has `accountSession/list` and `accountSession/switch {sessionId, accountId, allowBrowserLogin?}`, which answer with one `activeSessionId`: several logins inside one `CODEX_HOME`, one active at a time. `[cmd: codex-app-server-schema.txt; doc: learn.chatgpt.com/docs/app-server]`
- **V7.** remi today:
  the Codex control socket is resolved under `CODEX_HOME` of the daemon process `[src: harness/codex/codex-socket.ts:85-93; cli.ts:2290]`;
  a hub-spawned child copies the hub's environment `[src: cli/daemon-manager.ts:619-627]`;
  the agent's PTY (pseudo-terminal) environment is `process.env` plus the session's overrides, minus remi's own secrets `[src: pty/pty-session.ts:211-218; pty/child-env.ts:21-25]`;
  Codex `-p/--profile`, `-c` and similar flags are refused because they can make the TUI (terminal user interface) use an app-server remi cannot reach `[src: harness/codex/codex-args.ts:102-118; .context/strategy-2026-10.md:95]`;
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are read only to protect download roots `[src: cli.ts:1530-1531]`;
  Claude paths are hardcoded at `~/.claude/projects` `[src: transcript/transcript-discovery.ts:29]` and `~/.claude/settings.json` `[src: cli/statusline-installer.ts:81]`;
  the protocol has no profile field and the daemon has no handler for `account/*`, rate limits or `thread/compact` (both greps return 0) `[cmd: source-citations.txt]`;
  a stored session already carries an optional `harness` whose absence means Claude `[src: session/session-store.ts:43-54]`, the pattern an optional `profile` would follow.

### Usage signals

- **V8.** Claude Code passes plan usage to the status line command on standard input:
  `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` ("from 0 to 100") with `resets_at` ("Unix epoch seconds").
  "`rate_limits`: appears only for claude.ai Pro, Max, and Ultra subscribers, or behind a Claude apps gateway that sets a spend limit for you. Even then, it appears only after the first API response in the session. Each window ... may be independently absent".
  The command runs at session start and again when "A new assistant message arrives", "`/compact` finishes", a window "reaches its `resets_at` time" and a few other events, debounced at 300 ms; "The event-driven triggers can go quiet when the main session is idle". `[doc: code.claude.com/docs/en/statusline]`
  remi's own status line script reads only `context_window.used_percentage` and `model.display_name` `[src: cli/statusline-installer.ts:57]`, and remi installs it only where no `statusLine` is already set (same file, header).
- **V9.** A turn that ends on an API error fires `StopFailure` with `error` one of `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`; no value separates a usage limit from a rate limit. `[doc: code.claude.com/docs/en/hooks]`
  remi registers `StopFailure` and shows `rate_limit` as "Rate or usage limit reached" `[src: hooks/hook-types.ts:724-739; notifications/turn-failed.ts:59-61]`.
- **V10.** Claude Code continues by itself after a usage limit resets: "When a claude.ai usage limit stops Claude mid-task, Claude Code waits in the open session and continues the task on its own after the limit resets. Automatic continue is on by default in interactive sessions signed in with a claude.ai subscription."
  The wait ends without continuing when "The conversation changes hands: you switch accounts with `/login`, clear or rewind the conversation, `/resume` another session, ...", and after three automatic continuations.
  It is not offered for "API keys, cloud providers, and usage-based billing: usage there is metered per request, so there is no reset to wait for", nor in "Background sessions and `-p` runs". `[doc: code.claude.com/docs/en/interactive-mode]`
  `Notification` hooks report it as `quota_auto_resume_fired`, `quota_auto_resume_stale` and `quota_auto_resume_disabled` (Claude Code 2.1.234 or later) `[doc: code.claude.com/docs/en/hooks]`; remi already registers `Notification` `[src: hooks/hook-types.ts:727]`.
- **V11.** `/usage` shows "plan usage limits" and `/rate-limit-options` offers waiting, usage credits or an upgrade; "Claude Code can also open this menu on its own when you hit a limit at your own terminal." `[doc: code.claude.com/docs/en/commands]`
  "Pro and Max plans have a five-hour session limit and a weekly limit. These limits are shared across Claude and Claude Code ... Max and Ultra plans also have a separate weekly limit for Fable." `[doc: support.claude.com/en/articles/11145838]`
- **V12.** Codex exposes plan usage on the app-server.
  `account/rateLimits/read` returns `ordinaryUsageAllowed` ("Backend permission for ordinary included usage ... Null means unavailable; clients must not infer recovery from percentages or reset times"), `rateLimits` (a `RateLimitSnapshot`), `rateLimitsByLimitId` ("Multi-bucket view keyed by metered `limit_id`") and `accountId`.
  A snapshot has `primary` and `secondary` windows `{usedPercent, windowDurationMins, resetsAt}`, `credits`, `planType` and `rateLimitReachedType`.
  `account/rateLimits/updated` is a "Sparse rolling rate-limit update" that clients "should merge ... into the most recent `account/rateLimits/read` response or refetch". `[cmd: codex-app-server-schema.txt]`
  The documentation says the notification is "emitted whenever a user's ChatGPT rate limits change" and that `resetsAt` "is a Unix timestamp (seconds) for the next reset". `[doc: learn.chatgpt.com/docs/app-server]`
- **V13.** A failed Codex turn carries `codexErrorInfo` such as `usageLimitExceeded` or `rateLimitExceeded` `[cmd: codex-app-server-schema.txt]`, which remi already phrases `[src: notifications/turn-failed.ts:72-75]`.
  `thread/tokenUsage/updated` reports per-thread tokens and `modelContextWindow`: context size, not plan usage. `[cmd: codex-app-server-schema.txt]`
- **V14.** "Pro plans currently have no five-hour limit." "Weekly limits may also apply." "If you reach your usage limits during an active turn, the agent will be able to continue working on that turn ... subject to fair use limits." `[doc: learn.chatgpt.com/docs/pricing]`

Usage signals at a glance (from V8 to V14):

| Harness | Signal | What it measures | Granularity | Latency | Where it is missing |
|---|---|---|---|---|---|
| Claude | status line `rate_limits` | plan 5-hour and 7-day windows, 0 to 100, reset time | per account | on each assistant message, `/compact` and window reset, 300 ms debounce; quiet when idle | API keys, cloud providers, Team and Enterprise (G1), the Fable weekly limit (G2), any idle profile (G3) |
| Claude | `StopFailure` `error` | the turn failed, `rate_limit` among 12 values | per turn | at the failure | no usage versus rate split (G4) |
| Claude | `Notification` `quota_auto_resume_*` | Claude Code's own wait after a limit | per wait | at the event | Claude Code before 2.1.234 |
| Claude | `/usage`, `/rate-limit-options` | plan usage, options at a limit | per account | on demand | interactive only, not machine-readable |
| Codex | `account/rateLimits/read` | `primary`, `secondary` and per-limit windows (`usedPercent`), `ordinaryUsageAllowed` | per account (per app-server) | on request | API keys (G5) |
| Codex | `account/rateLimits/updated` | sparse changes to the same | per account | "whenever ... change" (cadence G5) | as above |
| Codex | `turn/completed` `codexErrorInfo` | the turn failed, `usageLimitExceeded` or `rateLimitExceeded` | per turn | at the failure | none known |
| Codex | `thread/tokenUsage/updated` | context tokens, not plan usage | per thread | per turn | not a usage signal |

### Compaction

- **V15.** Claude: `/compact [instructions]` summarizes the conversation `[doc: code.claude.com/docs/en/commands]`; auto-compaction runs at the auto-compact window and on idle compaction; `--autocompact <auto|tokens>` sets the window `[cmd: claude-help.txt]`; `DISABLE_COMPACT` turns all compaction off `[doc: env-vars]`.
  `PreCompact` (matcher `manual` or `auto`) can block compaction and its stdout becomes "instructions for the compaction summary"; `PostCompact` receives `trigger` and `compact_summary`, "the conversation summary generated by the compact operation", and has no decision control; `SessionStart` fires with source `compact`. `[doc: code.claude.com/docs/en/hooks]`
  remi types both compaction hooks `[src: hooks/hook-types.ts:378-398]` but registers neither `[src: hooks/hook-types.ts:724-739]`, so that a slow or dead remi never gates compaction (#203) `[src: hooks/hook-config-manager.ts:140-146]`.
- **V16.** Codex: `thread/compact/start {threadId}` returns `{}` at once and progress arrives as "a `contextCompaction` item lifecycle (`item/started` then `item/completed`)"; `thread/compacted` is deprecated `[doc: learn.chatgpt.com/docs/app-server]`.
  The item is `{type: "contextCompaction", id}`: it carries no summary text. Configuration has `model_auto_compact_token_limit`. `[cmd: codex-app-server-schema.txt]`

### Resume

- **V17.** Claude resumes with `-r, --resume [value]` ("by session ID or name"), `--fork-session` and `--session-id <uuid>` `[cmd: claude-help.txt]`, from session history kept under the configuration directory (V2).
  `CLAUDE_CODE_PROJECT_DIR_NAME` chooses the folder name inside `<config dir>/projects`; no variable read in the environment-variable reference shares history between configuration directories. `[doc: code.claude.com/docs/en/env-vars]`
- **V18.** Codex resumes with `codex resume [SESSION_ID]` and forks with `codex fork` `[cmd: codex-resume-appserver-help.txt]`.
  On the app-server, `thread/resume` takes a `threadId`; resuming from `history` or from a rollout `path` ("[UNSTABLE] Specify the rollout path to resume from") exists only in the experimental schema `[cmd: codex-app-server-schema.txt]`.
  "If the configured model provider differs from the thread's saved provider, `thread/resume` and new input return `-32600` with `data.type` set to `modelProviderMismatch`." `[doc: learn.chatgpt.com/docs/app-server]`
- **V19.** A remi hub resumes a Claude session by starting a child daemon with `--resume <claude id>` through the same starter a `create_session_request` uses (`AGENTS.md`, "Hub mode") `[src: cli/handlers/create-session-events.ts:276]`.

### Provider terms

- **V20.** Claude Code's legal page: "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
  It does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription". `[doc: code.claude.com/docs/en/legal-and-compliance]`
- **V21.** Anthropic Consumer Terms (effective Oct 8, 2025), section 2: "You may not share your Account login information, Anthropic API key, or Account credentials with anyone else." "You also may not make your Account available to anyone else."
  Section 3 forbids access "through automated or non-human means, whether through a bot, script, or otherwise" except "via an Anthropic API Key or where we otherwise explicitly permit it", and "bypassing any of our systems or protective measures".
  No clause names usage limits or multiple accounts. `[doc: anthropic.com/legal/consumer-terms]`
- **V22.** Anthropic Usage Policy (effective Nov 12, 2026), "Do Not Abuse Our Platform" (the fetch tool returned these bullets in contiguous fragments, joined here with " / "):
  "Coordinate malicious activity across multiple accounts, or create multiple accounts, to avoid detection, / circumvent product guardrails, or generate identical or similar inputs that otherwise violate our Usage Policy";
  "Intentionally bypass or interfere with capabilities, restrictions, or guardrails established within our products, / including by circumvention of the account sign-up or log-in process / ... / without prior authorization from Anthropic";
  "Resell, proxy, or otherwise provide access to Claude through unauthorized means, / including services that route requests through consumer subscriptions or misrepresent the product or client being used". `[doc: anthropic.com/legal/aup]`
- **V23.** Anthropic Commercial Terms (effective Jun 17, 2025, for Team, Enterprise and API users): no clause found on usage limits, credential sharing, multiple accounts or automated access; D.2 incorporates the Usage Policy. `[doc: anthropic.com/legal/commercial-terms]`
- **V24.** OpenAI Services Agreement ("ONLINE v.010126", the business agreement), 3.1: "Customer will not share Account access credentials or individual login credentials between multiple users."
  3.2: "End User Accounts may only be provisioned to, registered for, and used by, a single End User."
  3.3: Customer will not "(h) interfere with or disrupt the Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations for the Services; (i) violate or circumvent Usage Limits or otherwise configure the Services to avoid Usage Limits." `[doc: cdn.openai.com/osa/openai-services-agreement.pdf]`
- **V25.** OpenAI's "Sign in with ChatGPT" guidance for open-source tools expects several accounts per person, chosen by the person: "Your app needs to manage multiple account registrations so users can choose an existing ChatGPT account or add another."
  "Within your OSS app, you may choose to offer an account picker that allows the user to:" continue with a saved account, use a different account, or sign out.
  "Usage in one app contributes to the same five-hour usage total, and no app receives a separate allowance."
  Asked explicitly, the fetch found no mention of automatic, rotating or limit-triggered switching. `[doc: developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions]`
- **V26.** OpenAI's consumer Terms of Use and its help articles on account switching and Codex usage limits could not be read: each returned HTTP 403 to the fetch tool (Appendix B).

## Gaps (written as gaps, not filled)

- **G1.** Claude `rate_limits` is documented for Pro, Max and Ultra only; Team and Enterprise plans are not mentioned (V8).
- **G2.** The status line documents `five_hour`, `seven_day` and `spend_limit` windows, while the support article names a separate weekly Fable limit on Max and Ultra (V11): a session can hit a limit the signal does not show.
- **G3.** No Claude command reports plan usage outside an interactive session (`/usage` is a TUI command), so a profile with no running session has only its last observed value, or none.
- **G4.** `StopFailure` does not separate a usage limit from a rate limit (V9); remi's #905 records the same.
- **G5.** Codex: the cadence of `account/rateLimits/updated`, its behavior under API-key authentication, and what each `rateLimitsByLimitId` bucket means are not documented.
- **G6.** What survives compaction: Claude's "what survives compaction" page was not read; Codex documents nothing, and its compaction item has no summary text (V16).
- **G7.** Whether a compaction request counts against the plan's usage limit is not stated by either vendor; it is a model request, so it probably does.
- **G8.** Resuming a Claude session under another configuration directory (copying its transcript there, then `--resume`) is undocumented and untested.
- **G9.** Codex resume or fork by rollout path from another `CODEX_HOME` exists only as an experimental, unstable parameter and is untested.
- **G10.** `accountSession/switch`: whether it changes the login for every thread on that app-server, and how it interacts with a running turn, is untested and undocumented.
- **G11.** Whether Claude Code treats a remi hub child's PTY as "your own terminal" for its automatic continue and its `/rate-limit-options` menu is untested.
- **G12.** What `claude auth status --json` and `codex login status` print when logged in (possibly an email address) was not run on purpose; only the logged-out output (V2, V5) is verified.
- **G13.** No text read says whether either vendor allows a person to continue work on their own second subscription when the first reaches its limit, by hand or automatically.
- **G14.** #1157's phase 1 gate (two profiles stay logged in through 24 hours of token refresh) and its socket-path-length gotcha have not been rechecked on Claude Code 2.1.323 or codex-cli 0.167.0; `codex-socket.ts:7-8` notes that Codex links the control path to a short socket elsewhere.

## What "98 percent" can be measured against

Two different percentages exist, and the owner's idea concerns the second.

1. **Context window** (Claude `context_window.used_percentage`, Codex `thread/tokenUsage/updated`): how full one conversation is. Compaction exists for this. It says nothing about the account.
2. **Plan usage window** (Claude `rate_limits.*.used_percentage`, Codex `primary`/`secondary` `usedPercent`): how much of an account's 5-hour or weekly allowance is spent. It is per account, shared by every session and app on that account (V11, V25).

Measured against the second, "98 percent" has four weaknesses, each traced to a fact or a gap above:
the Claude value updates on assistant messages and goes quiet when idle (V8), so it lags by up to one turn, and nothing bounds what one long turn spends (an inference, not measured);
it is not documented for some plans, nor for a separate model limit (G1, G2);
Codex Pro has no five-hour window (V14), and an API key has no reset window at all (V10);
and the vendor's schema says clients "must not infer recovery from percentages or reset times" (V12, `ordinaryUsageAllowed`).
Compaction is itself a model request, probably on the account that is about to run out (G7), so a threshold must leave room for it.
The proposal therefore uses the largest observed window percentage per account, with its age, against two configurable thresholds below 100, and treats an observed limit failure (V9, V13) as the authoritative event.

## Options considered

- **O1. Documentation only.** Tell users to run `CLAUDE_CONFIG_DIR=... remi` themselves (V1). Lost: a remote session cannot pick an account, transcripts and status probes stay on `~/.claude` (V7), nothing records which account a session used.
- **O2. Profiles only (#1157).** Explicit, per-session account selection. Kept as phase 1 and 2: useful alone, entirely within documented mechanisms (V1, V5), no terms question beyond #1157's.
- **O3. Profiles, read-only usage, and human-confirmed continuation.** Proposed below. Usage comes only from what each CLI already reports (V8, V12); a continuation to another of the person's own profiles happens only when the person confirms it.
- **O4. Automatic rotation at a threshold (the idea as stated).** Rejected for now. It contradicts #1157 hard rule 3, and it reads directly against OpenAI's "configure the Services to avoid Usage Limits" for business accounts (V24) and plausibly against Anthropic's "bypass ... restrictions ... established within our products" and "create multiple accounts, to ... circumvent product guardrails" together with "ordinary, individual usage" (V20, V22). Kept as the last phase, behind an owner decision and written vendor confirmation (Q1, Q2).
- **O5. Provider-native in-session switching.** Claude's `/login` in a running session switches the conversation's account (V10), and Codex has an experimental `accountSession/switch` (V6). Rejected as remi's mechanism: `/login` would replace the login stored for that profile's directory (inferred from V1: one login per directory, not tested), so the profile would no longer mean one account, and it needs a browser login at that terminal; `accountSession/switch` is experimental and probably global to the app-server (G10). Both stay available to the person, and remi's notices may mention them.
- **O6. remi reads tokens or calls usage endpoints itself.** Rejected outright: it breaks #1157 hard rule 1 and "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" (V20).

For the material carried into the new session:

- **C1. The compaction summary from account A** (Claude `compact_summary`, V15). Best quality; needs headroom on A (G7); Codex exposes no summary text (V16).
- **C2. A deterministic handoff brief built by remi** from what it already reads (the transcript or thread items, the directory and branch). No model call, always available, lower quality.
- **C3. The same conversation resumed under account B** (Claude transcript copy, Codex rollout path). Closest to "continue the work", but undocumented or experimental (G8, G9).
- **C4. Wait for the reset** (Claude's automatic continue, V10). Already provided by Claude Code; remi should surface it, not replace it.

## Proposed decision (proposed, not accepted)

**D1. Profiles, as #1157 and the backend plan define them.**
A profile is local configuration: an immutable `id`, a `label`, and per harness the state directory it selects (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`), plus the settings bundle #1157 lists.
Selection precedence, launch environment (inherited credential variables from V3, and those a phase 1 characterization shows Codex reads, removed; then the profile's selectors; then remi's secret scrub last), the per-session snapshot, refusal of a logged-out or unknown explicit profile, and the built-in `default` that changes nothing follow the contract proposed in the backend plan and #1313.
The session record gains an optional `profile` (absent means `default`), following the `harness` pattern (V7).
A hub passes the profile to a child through the child's environment, so the existing seams follow it: the child's PTY inherits it (V7) and Codex resolves that profile's socket and app-server (V7).
Login status is read only from `claude auth status --json` (`loggedIn`, `loginExpiresAt`) and the exit code of `codex login status`, run under the profile's environment; no other field is parsed, logged or forwarded (G12).
Login itself always runs the harness's own flow in the person's terminal (#1157 hard rule 2).

**D2. Usage is observed, never fetched with a credential.**
Claude: remi's status line script also records the numeric `rate_limits` windows (`used_percentage`, `resets_at`) it already receives (V8), per session, into a remi-owned file the daemon reads; where the person has their own `statusLine`, remi offers to wrap it (record, then run the person's command with the same input) and otherwise reports "unknown".
Codex: the session's existing app-server client calls `account/rateLimits/read` at attach and after each `turn/completed`, and merges `account/rateLimits/updated` (V12).
Both feed one per-profile snapshot: for each window, its percentage, length, reset time, source and observation time, plus Codex's `ordinaryUsageAllowed` and `rateLimitReachedType`.
`accountId`, email and workspace names are dropped on receipt (V6, V12).
A value is shown with its source and age; an absent value is "unknown", never estimated (G1 to G3).

**D3. Thresholds and notices.**
Per profile: `warn_percent` (default 90) and `offer_percent` (default 95), each settable from 50 to 99 (Q3).
They are evaluated at turn ends (Claude `Stop`, Codex `turn/completed`) against the largest observed window.
Crossing `warn_percent` sends one notice per profile, window and reset period (a new push kind, Q8).
Crossing `offer_percent`, or a turn failing on `rate_limit` or `usageLimitExceeded` (V9, V13), makes remi offer the choices in D5 to authenticated clients; it starts nothing on its own.
When Claude Code's own automatic continue is waiting (V10), the notice says when Claude will continue.

**D4. Compaction on request.**
A client or the terminal may ask remi to compact a session on its current account.
Claude: remi types `/compact` with remi's handoff instructions through the same guarded write path chat uses (no prompt up, no turn running), and learns completion from a newly registered, non-blocking `PostCompact` hook (V15), with `SessionStart` source `compact` as a second signal.
`PreCompact` stays unregistered, so remi still never gates compaction (#203).
Codex: remi calls `thread/compact/start` and waits for the `contextCompaction` item to complete (V16).
A deadline bounds the wait; on expiry the session is untouched and the request reports "not confirmed".

**D5. Continuation on another of the person's profiles, confirmed by the person.**
The hub owns it, because it already starts and resumes children (V19).
Request: session, target profile, mode `summary` (default; C1 or C2) or `resume` (C3, only after its characterization gate passes, Q4).
Preconditions, each refused with a reason that names it:
the session is a hub child (a wrapper session gets the exact command to run instead);
no turn is running;
no prompt is up and no Codex approval card is live (ADR 0038 cards are answered or dismissed first);
the target profile is configured, allowed for this directory, marked as a continuation target, and, for a remote caller, remotely selectable;
the target is logged in (D1) and its last snapshot is below `offer_percent` with `ordinaryUsageAllowed` not false, or is unknown and the person confirmed "unknown";
no other continuation of this session is in flight.
Steps:
(1) material: if the source account has headroom, compact on it (D4) and take Claude's `compact_summary`; otherwise, or for Codex, or when compaction fails, build the brief (C2);
(2) stop the source session through the existing Stop path;
(3) start the target session through the hub starter with the target profile, the same directory and the same harness;
(4) submit the material as its first message through the structured or guarded submit path (ADR 0043 for Codex);
(5) record lineage (`continuedFrom`) on the new session and leave the source session resumable under its own profile.
A failure at any step stops there, reports which step, and never retries or picks another profile.

**D6. Scopes.**
Per project: a profile's `folders` mapping, longest match at a path-component boundary (backend plan).
Per session group: no new object; a group is a continuation lineage plus the workspace a session runs in (ADR 0036), and the profile is recorded per session.
Per remote request: `create_session_request.profile` and the continuation request accept only remotely selectable profile ids, checked at the trust boundary like `harness` and `args` (ADR 0033), behind the `session_profiles` capability.

**D7. What a phone shows, and when.**
On every session: its profile label (never an email).
On demand: a usage panel per profile, each window with percentage, reset time, source and age.
At `warn_percent`: one notice.
At `offer_percent` or on a usage-limit failure: an offer with "Compact now", "Continue on" a named profile (only eligible targets, each with its own usage and age), and "Wait for reset" (Claude's own wait, when present).
Confirming a continuation needs the app (no lock-screen action), because it spends another account.
After a continuation: the result, and a link from the new session to the old one.

**D8. Failure modes.**

| Situation | Behavior |
|---|---|
| Continuation asked mid-turn | Refused; offered again at the turn end |
| Claude hook held, prompt in the terminal, or a menu up | Refused, the reason says answer or dismiss first |
| Codex approval pending | Refused; a pending request stays on the old app-server after a stop (`AGENTS.md`, Codex approvals), so it must be answered first |
| Claude's own automatic continue is waiting | Allowed; the confirm screen says the wait ends, as Claude's documentation says it does when the conversation changes hands (V10) |
| Target at or above `offer_percent`, or `ordinaryUsageAllowed` false | Not offered |
| Target usage unknown | Offered as "unknown", needs explicit confirmation |
| Target logged out, expired or revoked | Refused with `remi profile login <id>`; nothing is stopped |
| Target's first turn fails (`authentication_failed`, `account_on_hold`, `rate_limit`, `usageLimitExceeded`) | The existing failed-turn notice; no further switch; the source session stays resumable |
| Compaction on the source fails, is blocked, or hits the limit | Fall back to the brief (C2) |
| Hub restarts during a continuation | The step reached is persisted; nothing resumes on its own; clients see the state |
| Two clients ask at once | The first wins, the second is refused |

**D9. Automatic continuation is not built** until the owner amends #1157 hard rule 3 and the vendor concerned confirms in writing (Q1, Q2).
If it is ever built: opt-in per pair of profiles, only between one person's own individual subscriptions, at most once per session per reset window, never while a card is live, a notice before and after, and one switch that turns it off.

**D10. What remi never does:** read, copy, store, print or relay a credential or token; run a login from a phone; choose a profile the person did not configure; continue onto a seat of another person (V21, V24); describe the feature as a way to get more usage; log or forward an email, account id or workspace name.

## Consequences

- Phase 1 and 2 deliver #1157 for both harnesses with no terms question beyond #1157's own, and the protocol freeze gets its profile fields.
- remi learns account usage only where a CLI already reports it to a client; some plans and limits stay "unknown" (G1 to G3), and the user interface must say so instead of guessing.
- Registering `PostCompact` adds one hook call per compaction; it cannot block, but its latency against a dead remi must be measured before it ships (Q7).
- Continuation is a stop and a new session: the new account does not see the old conversation, only its summary or brief, until the `resume` mode passes its gate (G8, G9).
- The idea's strongest form (automatic rotation at 98 percent) is deferred, perhaps forever, by terms risk; this ADR says so instead of designing around it.
- New wire shapes (profile fields, usage snapshot, compaction and continuation requests, a usage push kind) each need fixtures and an ADR amendment under ADR 0035 and ADR 0019.

## Open questions for the owner

Each has a recommended option.

- **Q1. Automatic switching.** (a) keep #1157 hard rule 3: no automatic switching, only confirmed continuation; (b) build it after written vendor confirmation, opt-in per profile pair; (c) build it now. **Recommended: (a) now, revisit (b) only with written answers.**
- **Q2. Ask the vendors in writing first.** (a) ask Anthropic and OpenAI before releasing the continuation phase; (b) ship without asking. **Recommended: (a); phases 1 to 4 do not depend on the answer.**
- **Q3. Thresholds.** (a) warn 90, offer 95, both configurable; (b) warn and offer at 98 as stated. **Recommended: (a), because the signal lags by up to one turn and compaction needs headroom; 98 stays available as a setting.**
- **Q4. Default continuation material.** (a) summary or brief in a new session; (b) resume the same conversation under the new account. **Recommended: (a) by default; (b) only after its characterization gate passes.**
- **Q5. Material when the source account has no headroom.** (a) remi's deterministic brief; (b) resume under the target and compact there (needs Q4 (b)); (c) wait for the reset. **Recommended: (a), with (c) offered beside it.**
- **Q6. Eligible targets.** (a) only profiles marked `continuation_target`, individual subscriptions of the same person, never to or from a team, business or enterprise seat (those seats are single-user under the business terms, V24, and the sign-in method decides which data-handling policies apply, `[doc: learn.chatgpt.com/docs/auth]`); (b) any configured profile. **Recommended: (a).**
- **Q7. Register Claude's `PostCompact` hook.** (a) yes, after measuring that a dead remi does not delay compaction; (b) no, detect completion from `SessionStart` and the status line only. **Recommended: (a).**
- **Q8. Push kind for usage.** (a) a new kind `usage_warning`, mutable per device; (b) reuse `turn_failed`. **Recommended: (a); `turn_failed` means a turn ended.**
- **Q9. Phone authority.** (a) an authenticated client may start a continuation with an in-app confirmation, only to remotely selectable targets; (b) terminal only. **Recommended: (a), never from the lock screen.**
- **Q10. Flag name.** (a) `--remi-profile` and `REMI_PROFILE` as the backend plan proposes; (b) `--profile`. **Recommended: (a), so provider flags keep their meaning.**

## Appendix A: commands and versions

All outputs are saved under `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/A01/r1/`.
No command ran with a real account's state directory except the help texts, which read no credential.

| Command | Version | Exit | Evidence |
|---|---|---|---|
| `claude --version` | 2.1.323 (Claude Code) | 0 | `claude-help.txt` |
| `claude --help` | 2.1.323 | 0 | `claude-help.txt` |
| `claude auth --help`, `claude auth status --help`, `claude auth login --help`, `claude auth logout --help` | 2.1.323 | 0 | `claude-auth-help.txt` |
| `env -i PATH HOME=<scratch> CLAUDE_CONFIG_DIR=<empty> claude auth status --text` and `--json` | 2.1.323 | 1, 1 | `fresh-login-status.txt` |
| `codex --version`, `codex --help` | codex-cli 0.167.0 | 0 | `codex-help.txt` |
| `codex login --help`, `codex login status --help`, `codex logout --help` | 0.167.0 | 0 | `codex-login-help.txt` |
| `codex resume --help`, `codex fork --help`, `codex app-server --help` | 0.167.0 | 0 | `codex-resume-appserver-help.txt` |
| `env -i PATH HOME=<scratch> CODEX_HOME=<empty> codex login status` | 0.167.0 | 1 | `fresh-login-status.txt` |
| `codex app-server generate-ts --out <scratch>` and `--experimental` | 0.167.0 | 0 | `codex-app-server-schema.txt` (excerpts) |
| `codex app-server generate-json-schema --out <scratch>` | 0.167.0 | 0 | `codex-json-schema-listing.txt` (file names only) |

Key outputs, verbatim:

```text
$ claude --version
2.1.323 (Claude Code)
$ codex --version
codex-cli 0.167.0
$ env -i ... CLAUDE_CONFIG_DIR=$FRESH/claude claude auth status --text
Not logged in. Run claude auth login to authenticate.
[exit 1]
$ env -i ... CLAUDE_CONFIG_DIR=$FRESH/claude claude auth status --json
{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", "analyticsDisabled": false,
  "projectsDirectory": "$FRESH/claude/projects", "configDirectory": "$FRESH/claude", "loginExpiresAt": null }
[exit 1]
$ env -i ... CODEX_HOME=$FRESH/codex codex login status
Not logged in
[exit 1]
$ claude auth status --help
  --json      Output as JSON (default)
  --text      Output as human-readable text
$ claude auth login --help
  --claudeai       Use Claude subscription (default)
  --console        Use Anthropic Console (API usage billing) instead of Claude subscription
  --email <email>  Pre-populate email address on the login page
  --sso            Force SSO login flow
$ claude --help (excerpts)
  --autocompact <auto|tokens>           Auto-compact window size (auto, or 100k–1M tokens)
  --fork-session                        When resuming, create a new session ID instead of reusing the original
  -r, --resume [value]                  Resume a conversation by session ID or name, or open interactive picker
  --session-id <uuid>                   Use a specific session ID for the conversation (must be a valid UUID)
$ codex --help (excerpts)
  login             Manage login
  logout            Remove stored authentication credentials
  resume            Resume a previous interactive session (picker by default; use --last to continue the most recent)
  fork              Fork a previous interactive session (picker by default; use --last to fork the most recent)
  -p, --profile <CONFIG_PROFILE_V2>
          Layer $CODEX_HOME/<name>.config.toml on top of the base user config
$ codex login --help (excerpts)
  status  Show login status
      --with-api-key
      --with-access-token
      --device-auth
$ codex app-server generate-ts (standard ClientRequest.ts and ServerNotification.ts, excerpts)
"method": "account/rateLimits/read", id: RequestId, params?: GetAccountRateLimitsParams | undefined
"method": "account/read", id: RequestId, params: GetAccountParams
"method": "thread/compact/start", id: RequestId, params: ThreadCompactStartParams
"method": "account/rateLimits/updated", "params": AccountRateLimitsUpdatedNotification
"method": "thread/compacted", "params": ContextCompactedNotification
$ codex app-server generate-ts --experimental (ClientRequest.ts, excerpt)
"method": "accountSession/list", id: RequestId, params: AccountSessionsListParams
"method": "accountSession/switch", id: RequestId, params: AccountSessionsSwitchParams
```

## Appendix B: documentation and terms read on 2026-11-13

Quotes as returned are in `web-sources.txt` in the evidence directory.

| URL | Result |
|---|---|
| https://code.claude.com/docs/en/authentication | read |
| https://code.claude.com/docs/en/legal-and-compliance | read |
| https://code.claude.com/docs/en/statusline | read |
| https://code.claude.com/docs/en/hooks | read in three parts |
| https://code.claude.com/docs/en/interactive-mode | read (section "Wait for a usage limit to reset") |
| https://code.claude.com/docs/en/commands | read |
| https://code.claude.com/docs/en/env-vars | read in two parts |
| https://support.claude.com/en/articles/11145838-using-claude-code-with-your-max-plan | read |
| https://www.anthropic.com/legal/consumer-terms | read (effective Oct 8, 2025) |
| https://www.anthropic.com/legal/aup | read (effective Nov 12, 2026) |
| https://www.anthropic.com/legal/commercial-terms | read (effective Jun 17, 2025) |
| https://learn.chatgpt.com/docs/auth (from developers.openai.com/codex/auth) | read |
| https://learn.chatgpt.com/docs/app-server (from developers.openai.com/codex/app-server) | read in two parts |
| https://learn.chatgpt.com/docs/pricing | read |
| https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions | read |
| https://cdn.openai.com/osa/openai-services-agreement.pdf | read (ONLINE v.010126) |
| https://openai.com/policies/terms-of-use/ (and the row and en-GB variants, and /policies/services-agreement/) | not read: HTTP 403 |
| https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching | not read: HTTP 403 |
| https://help.openai.com/en/articles/11369540-codex-usage-limits | not read: HTTP 403 |

## Appendix C: remi source cited

Excerpts with line numbers are in `source-citations.txt` in the evidence directory, taken at `68940c1d`:
`packages/daemon/src/cli.ts` (1530-1531, 2290),
`harness/codex/codex-socket.ts` (1-8, 85-93),
`harness/codex/codex-session.ts` (98-99),
`harness/codex/codex-args.ts` (102-118),
`transcript/transcript-discovery.ts` (29),
`cli/statusline-installer.ts` (57, 81),
`tunnel/file-download-session-host.ts` (30-38),
`pty/pty-session.ts` (208-218),
`pty/child-env.ts` (21-25),
`cli/daemon-manager.ts` (598, 619-627),
`hooks/hook-types.ts` (378-398, 724-739),
`hooks/hook-server.ts` (433-445),
`hooks/hook-config-manager.ts` (140-146),
`notifications/turn-failed.ts` (59-61, 72-75),
`session/session-store.ts` (29-36, 43-54),
`harness/types.ts` (162-193),
`cli/handlers/create-session-events.ts` (276),
`.context/issue-1595-backend-plan.md` (168-181),
`.context/strategy-2026-10.md` (95).
