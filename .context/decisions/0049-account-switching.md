# ADR 0049: Account profiles, usage visibility and confirmed continuation across a person's own accounts

**Status:** proposed (design draft from card A01 of the land-branches-2026-11 plan, revised the same day with the A02 advisor review's findings F1 to F12; not accepted; the owner decides at checkpoint CP4)
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

**Positioning (revised after A02).**
#1157 says that no reviewed competitor advertises per-session account switching.
That is no longer true: on 2026-11-13, AgentsRoom pins an account per project, folder or agent with the same two variables and shows usage per account, and several tools switch accounts automatically at a usage threshold (claude-swap, ccswap, codex-switch, Happier pools); the dated addendum in `.context/competitive-review-2026-10.md` lists them with sources.
Profiles are therefore table stakes, not a differentiator.
What can differ is the method: remi copies no credential, calls no usage endpoint, and shows where every number came from and how old it is.
Most of the tools above copy, replace or store login tokens, which the Claude Code legal page forbids to developers ("may not collect, store, or intermediate Claude.ai credentials or session tokens", V20).
Automatic rotation would trade that position for parity with those tools.

Citations: `[cmd: file]` is a command and its output under `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/A01/r1/` or `.../A01/r2/` (Appendix A);
`[doc: URL]` is vendor documentation read on 2026-11-13 (Appendix B);
`[src: path:line]` is remi source or documentation at `origin/develop` `68940c1d` (Appendix C).
Installed versions: Claude Code 2.1.323 and codex-cli 0.167.0 when r1 ran; later the same day Claude Code had updated itself to 2.1.325, with an identical `claude --help` and one new `claude auth status` field (`consoleProfileSignInOffered`) `[cmd: r1/claude-help.txt, r2/versions.txt, r2/claude-help-diff.txt, r2/claude-auth-status-sources.txt]`.
Facts about a CLI hold for the version named; V8 to V11 are rechecked at every phase gate.
Facts V27 onward were added after the A02 review.

## Verified facts

### Account selection and login

- **V1.** Claude Code supports several accounts at once through separate configuration directories: "To stay signed in to multiple accounts at once, such as work and personal accounts, give each account its own configuration directory. When you start `claude`, set the `CLAUDE_CONFIG_DIR` environment variable to the directory for the account you want to use. Each directory has its own settings, session history, and claude.ai login or API key."
  On macOS it "keys the macOS Keychain entry to that directory too, so a session with a different `CLAUDE_CONFIG_DIR` reads a different entry."
  Exception: two Console sign-ins without an Application Programming Interface (API) key are not kept apart, "because Claude Code stores that kind of sign-in outside the configuration directory." `[doc: code.claude.com/docs/en/authentication]`
- **V2.** Session history follows the configuration directory: `CLAUDE_CONFIG_DIR` "Override the configuration directory (default: `~/.claude`). All settings, session history, and plugins are stored under this path." `[doc: code.claude.com/docs/en/env-vars]`
  Under a fresh, empty directory, `claude auth status --json` prints `"loggedIn": false`, `"authMethod": "none"`, `"projectsDirectory": "<dir>/projects"`, `"configDirectory": "<dir>"`, `"loginExpiresAt": null` and exits 1; `--text` prints "Not logged in. Run claude auth login to authenticate." `[cmd: r1/fresh-login-status.txt]`
- **V3.** Credentials in the environment outrank a stored login, in this order: a cloud provider selector, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_API_KEY`, `apiKeyHelper`, `CLAUDE_CODE_OAUTH_TOKEN`, Anthropic profile and federation credentials, and last "Subscription OAuth credentials from `/login`." `[doc: code.claude.com/docs/en/authentication]`
  An expired login that cannot be refreshed makes "each model request" fail "with `Login expired · Please run /login`". (same page)
- **V4.** `claude auth` has `login` (`--claudeai`, `--console`, `--email`, `--sso`), `logout` and `status` (`--json` default, `--text`). `[cmd: r1/claude-auth-help.txt]`
- **V27.** `claude auth status --json` reports the credential that will actually be used, without validating it.
  With a placeholder string (not a credential) in `ANTHROPIC_API_KEY`, it prints `"loggedIn": true`, `"authMethod": "api_key"`, `"apiKeySource": "ANTHROPIC_API_KEY"` and exits 0;
  with a placeholder `apiKeyHelper` in the profile directory's `settings.json`, `"authMethod": "api_key_helper"`, `"apiKeySource": "apiKeyHelper"`, exit 0;
  with a placeholder `ANTHROPIC_API_KEY` in the `env` of an untrusted project's `.claude/settings.json`, run from that project, `"loggedIn": false`, exit 1;
  with `ANTHROPIC_BASE_URL` set, nothing in the output changes (`"apiProvider": "firstParty"`). `[cmd: r2/claude-auth-status-sources.txt]`
  So `loggedIn: true` alone does not prove a working login, and `authMethod` with `apiKeySource` tells remi whether the profile's own login is what will be used.
- **V28.** Credential sources outside the configuration directory: Anthropic profiles live in "your Anthropic configuration directory, by default `~/.config/anthropic`"; an "Active profile" (the `active_config` file, or a profile named `default`) ranks "Above when its auth mode is `oidc_federation`; below a working `/login` credential when its auth mode is `user_oauth`"; federation also reads variables "such as `ANTHROPIC_IDENTITY_TOKEN_FILE`".
  A keyless Console sign-in "signs you out of any claude.ai login stored on the machine".
  Managed settings can require an organization (`forceLoginOrgUUID`: Claude Code "exits at startup if the claude.ai credential in use belongs to an organization that isn't listed") and can supply credentials ("ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or apiKeyHelper, even when managed settings supply them").
  `ANTHROPIC_BASE_URL` routes requests "through a custom API endpoint". `[doc: code.claude.com/docs/en/authentication]`
  Project settings carry "Team permissions, hooks, plugins, and the environment variables the project needs", and "most `env` values apply only after each teammate trusts the folder". `[doc: code.claude.com/docs/en/settings]`
- **V5.** Codex keeps its login per `CODEX_HOME`: with `cli_auth_credentials_store`, "`file` stores credentials in `auth.json` under `CODEX_HOME` (defaults to `~/.codex`)", `keyring` and `auto` use the operating system credential store, and `ephemeral` "keeps credentials in memory only for the current process". `[doc: learn.chatgpt.com/docs/auth]`
  Under a fresh `CODEX_HOME`, `codex login status` prints "Not logged in" and exits 1. `[cmd: r1/fresh-login-status.txt]`
  `codex login` takes `--with-api-key`, `--with-access-token` and `--device-auth`; Codex's own `-p, --profile` only "Layer[s] `$CODEX_HOME/<name>.config.toml` on top of the base user config", so it cannot select an account. `[cmd: r1/codex-login-help.txt, r1/codex-help.txt]`
  Its configuration has `model_provider`, `approval_policy`, `sandbox_mode`, `forced_login_method` and `forced_chatgpt_workspace_id`. `[cmd: r2/codex-config-keys.txt]`
- **V6.** The Codex app-server reports the account it runs under (`account/read` returns `{type: "chatgpt", email, planType, workspaceName}`, `{type: "apiKey"}` and others) and announces changes (`account/updated`, "emitted whenever auth mode changes", with `planType` "when available").
  `planType` takes values such as `plus`, `pro`, `team`, `business`, `enterprise` and `edu`. `[cmd: r1/codex-app-server-schema.txt, r2/codex-config-keys.txt; doc: learn.chatgpt.com/docs/app-server]`
  Its experimental surface, absent from the standard schema and from the documentation page, has `accountSession/list` and `accountSession/switch {sessionId, accountId, allowBrowserLogin?}`, which answer with one `activeSessionId`: several logins inside one `CODEX_HOME`, one active at a time. `[cmd: r1/codex-app-server-schema.txt]`
- **V7.** remi today:
  the Codex control socket is resolved under `CODEX_HOME` of the daemon process `[src: harness/codex/codex-socket.ts:85-93; cli.ts:2290]`;
  a hub-spawned child copies the hub's environment `[src: cli/daemon-manager.ts:619-627]`;
  the agent's PTY (pseudo-terminal) environment is `process.env` plus the session's overrides, minus remi's own secrets `[src: pty/pty-session.ts:211-218; pty/child-env.ts:21-25]`;
  Codex `-p/--profile`, `-c` and similar flags are refused because they can make the TUI (terminal user interface) use an app-server remi cannot reach `[src: harness/codex/codex-args.ts:102-118; .context/strategy-2026-10.md:95]`;
  `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are read only to protect download roots `[src: cli.ts:1530-1531]`;
  Claude paths are hardcoded at `~/.claude/projects` `[src: transcript/transcript-discovery.ts:29]` and `~/.claude/settings.json` `[src: cli/statusline-installer.ts:81]`;
  the protocol has no profile field and the daemon has no handler for `account/*`, rate limits or `thread/compact` (both greps return 0) `[cmd: r1/source-citations.txt]`;
  a stored session already carries an optional `harness` whose absence means Claude `[src: session/session-store.ts:43-54]`, the pattern an optional `profile` would follow.

### What a configuration directory carries besides the login

- **V29.** "If you set `CLAUDE_CONFIG_DIR`, every `~/.claude` path on this page lives under that directory instead. The same applies to `.claude.json`".
  The global files there include `CLAUDE.md` ("Instructions loaded every session"), `rules/`, `settings.json` ("Permissions, hooks, env vars, model defaults"), `skills/`, `commands/`, `agents/`, `workflows/`, `agent-memory/`, `.claude.json` ("App state, account details, UI toggles, personal MCP servers") and `projects/<project>/memory/` ("Auto memory"); its application data includes transcripts, `file-history/`, `plans/` and `tasks/`, and "`jobs/` and `daemon/`: background session state". `[doc: code.claude.com/docs/en/claude-directory]`
  A fresh directory gains `.claude.json` after one `claude auth status` `[cmd: r1/fresh-login-status.txt]`.
  remi's held-prompt answers grant standing permissions only "for this session" (`destination: "session"`) `[src: docs/agent-reference/questions-and-notifications.md:33]`, and a Claude session resumed through a hub "came back in the permission mode of its earlier life" `[src: docs/agent-reference/harnesses-and-codex.md:11]`.

### Usage signals

- **V8.** Claude Code passes plan usage to the status line command on standard input:
  `rate_limits.five_hour.used_percentage` and `rate_limits.seven_day.used_percentage` ("from 0 to 100") with `resets_at` ("Unix epoch seconds").
  "`rate_limits`: appears only for claude.ai Pro, Max, and Ultra subscribers, or behind a Claude apps gateway that sets a spend limit for you. Even then, it appears only after the first API response in the session. Each window ... may be independently absent".
  The command runs at session start and again when "A new assistant message arrives", "`/compact` finishes", a window "reaches its `resets_at` time" and a few other events, debounced at 300 ms; "The event-driven triggers can go quiet when the main session is idle".
  An optional `refreshInterval` "re-runs your command every N seconds in addition to the event-driven updates", which refreshes the recorded file, not the data's lag. `[doc: code.claude.com/docs/en/statusline]`
  remi's own status line script reads only `context_window.used_percentage` and `model.display_name` `[src: cli/statusline-installer.ts:57]`, and remi installs it only where no `statusLine` is already set (same file, header).
- **V9.** A turn that ends on an API error fires `StopFailure` with `error` one of `rate_limit`, `overloaded`, `authentication_failed`, `oauth_org_not_allowed`, `account_on_hold`, `billing_error`, `invalid_request`, `model_not_found`, `server_error`, `max_output_tokens`, `cloud_credential_error`, `unknown`; no value separates a usage limit from a rate limit. `[doc: code.claude.com/docs/en/hooks]`
  remi registers `StopFailure` and shows `rate_limit` as "Rate or usage limit reached" `[src: hooks/hook-types.ts:724-739; notifications/turn-failed.ts:59-61]`.
- **V10.** Claude Code continues by itself after a usage limit resets: "When a claude.ai usage limit stops Claude mid-task, Claude Code waits in the open session and continues the task on its own after the limit resets. Automatic continue is on by default in interactive sessions signed in with a claude.ai subscription."
  The wait ends without continuing when "The conversation changes hands: you switch accounts with `/login`, clear or rewind the conversation, `/resume` another session, ...", and after three automatic continuations.
  It is not offered for "API keys, cloud providers, and usage-based billing: usage there is metered per request, so there is no reset to wait for", nor in "Background sessions and `-p` runs". `[doc: code.claude.com/docs/en/interactive-mode]`
  `Notification` hooks report it as `quota_auto_resume_fired`, `quota_auto_resume_stale` and `quota_auto_resume_disabled` (Claude Code 2.1.234 or later) `[doc: code.claude.com/docs/en/hooks]`; remi already registers `Notification` `[src: hooks/hook-types.ts:727]`.
- **V30.** The limit wait is a screen state of its own.
  While Claude Code waits, the bottom lines read "Usage limit reached · limit resets 3:45pm" and "Continuing automatically at 3:45pm · Esc to cancel".
  When automatic continue does not start or is off, "Claude Code opens the usage-limit options menu once per reset window when you hit a limit at your own terminal".
  The wait also ends early, continuing at once if usage is available again, "when you finish adding usage credits with `/usage-credits`, sign back in after `/upgrade`, or switch models with `/model` during the wait". `[doc: code.claude.com/docs/en/interactive-mode]`
  In remi, a numbered selection box on screen makes `promptUp` report a prompt (`menu`), which refuses chat with `PROMPT_WAITING` `[src: docs/agent-reference/questions-and-notifications.md:225-236]`, and while a prompt is up a Stop "types no `/exit` and force-closes the session" `[src: docs/agent-reference/questions-and-notifications.md:252]`, kept because "a forced close is always safe" `[src: docs/agent-reference/questions-and-notifications.md:304-305]`.
- **V11.** `/usage` shows "plan usage limits" and `/rate-limit-options` offers waiting, usage credits or an upgrade; "Claude Code can also open this menu on its own when you hit a limit at your own terminal." `[doc: code.claude.com/docs/en/commands]`
  "Pro and Max plans have a five-hour session limit and a weekly limit. These limits are shared across Claude and Claude Code ... Max and Ultra plans also have a separate weekly limit for Fable." `[doc: support.claude.com/en/articles/11145838]`
- **V12.** Codex exposes plan usage on the app-server.
  `account/rateLimits/read` returns `ordinaryUsageAllowed` ("Backend permission for ordinary included usage ... Null means unavailable; clients must not infer recovery from percentages or reset times"), `rateLimits` (a `RateLimitSnapshot`), `rateLimitsByLimitId` ("Multi-bucket view keyed by metered `limit_id`") and `accountId`.
  A snapshot has `primary` and `secondary` windows `{usedPercent, windowDurationMins, resetsAt}`, `credits`, `planType` and `rateLimitReachedType`.
  `account/rateLimits/updated` is a "Sparse rolling rate-limit update" that clients "should merge ... into the most recent `account/rateLimits/read` response or refetch". `[cmd: r1/codex-app-server-schema.txt]`
  The documentation says the notification is "emitted whenever a user's ChatGPT rate limits change" and that `resetsAt` "is a Unix timestamp (seconds) for the next reset". `[doc: learn.chatgpt.com/docs/app-server]`
- **V13.** A failed Codex turn carries `codexErrorInfo` such as `usageLimitExceeded` or `rateLimitExceeded` `[cmd: r1/codex-app-server-schema.txt]`, which remi already phrases `[src: notifications/turn-failed.ts:72-75]`.
  `thread/tokenUsage/updated` reports per-thread tokens and `modelContextWindow`: context size, not plan usage. `[cmd: r1/codex-app-server-schema.txt]`
- **V14.** "Pro plans currently have no five-hour limit." "Weekly limits may also apply." "If you reach your usage limits during an active turn, the agent will be able to continue working on that turn ... subject to fair use limits." `[doc: learn.chatgpt.com/docs/pricing]`
- **V31.** Account changes are announced: Claude's `Notification` types include `auth_success` and `auth_storage_failure` `[doc: code.claude.com/docs/en/hooks]`, and Codex sends `account/updated` (V6).

Usage signals at a glance (from V8 to V14):

| Harness | Signal | What it measures | Granularity | Latency | Where it is missing |
|---|---|---|---|---|---|
| Claude | status line `rate_limits` | plan 5-hour and 7-day windows, 0 to 100, reset time | per account | on each assistant message, `/compact` and window reset, 300 ms debounce; quiet when idle | API keys, cloud providers, Team and Enterprise (G1), the Fable weekly limit (G2), any idle profile (G3) |
| Claude | `StopFailure` `error` | the turn failed, `rate_limit` among 12 values | per turn | at the failure | no usage versus rate split (G4); whether it fires at a usage-limit pause is G16 |
| Claude | `Notification` `quota_auto_resume_*` | Claude Code's own wait after a limit | per wait | at the event | Claude Code before 2.1.234 |
| Claude | `/usage`, `/rate-limit-options` | plan usage, options at a limit | per account | on demand | interactive only, not machine-readable |
| Codex | `account/rateLimits/read` | `primary`, `secondary` and per-limit windows (`usedPercent`), `ordinaryUsageAllowed` | per account (per app-server) | on request | API keys (G5) |
| Codex | `account/rateLimits/updated` | sparse changes to the same | per account | "whenever ... change" (cadence G5) | as above |
| Codex | `turn/completed` `codexErrorInfo` | the turn failed, `usageLimitExceeded` or `rateLimitExceeded` | per turn | at the failure | none known |
| Codex | `thread/tokenUsage/updated` | context tokens, not plan usage | per thread | per turn | not a usage signal |

### Compaction

- **V15.** Claude: `/compact [instructions]` summarizes the conversation `[doc: code.claude.com/docs/en/commands]`; auto-compaction runs at the auto-compact window and on idle compaction; `--autocompact <auto|tokens>` sets the window `[cmd: r1/claude-help.txt]`; `DISABLE_COMPACT` turns all compaction off `[doc: code.claude.com/docs/en/env-vars]`.
  `PreCompact` (matcher `manual` or `auto`) can block compaction and its stdout becomes "instructions for the compaction summary"; `PostCompact` receives `trigger` and `compact_summary`, "the conversation summary generated by the compact operation", and has no decision control; `SessionStart` fires with source `compact`. `[doc: code.claude.com/docs/en/hooks]`
  remi types both compaction hooks `[src: hooks/hook-types.ts:378-398]` but registers neither `[src: hooks/hook-types.ts:724-739]`, so that a slow or dead remi never gates compaction (#203) `[src: hooks/hook-config-manager.ts:140-146]`.
- **V16.** Codex: `thread/compact/start {threadId}` returns `{}` at once and progress arrives as "a `contextCompaction` item lifecycle (`item/started` then `item/completed`)"; `thread/compacted` is deprecated `[doc: learn.chatgpt.com/docs/app-server]`.
  The item is `{type: "contextCompaction", id}`: it carries no summary text. Configuration has `model_auto_compact_token_limit`. `[cmd: r1/codex-app-server-schema.txt]`

### Resume

- **V17.** Claude resumes with `-r, --resume [value]` ("by session ID or name"), `--fork-session` and `--session-id <uuid>` `[cmd: r1/claude-help.txt]`, from session history kept under the configuration directory (V2).
  `CLAUDE_CODE_PROJECT_DIR_NAME` chooses the folder name inside `<config dir>/projects`; no variable read in the environment-variable reference shares history between configuration directories. `[doc: code.claude.com/docs/en/env-vars]`
- **V18.** Codex resumes with `codex resume [SESSION_ID]` and forks with `codex fork` `[cmd: r1/codex-resume-appserver-help.txt]`.
  On the app-server, `thread/resume` takes a `threadId`; resuming from `history` or from a rollout `path` ("[UNSTABLE] Specify the rollout path to resume from") exists only in the experimental schema `[cmd: r1/codex-app-server-schema.txt]`.
  "If the configured model provider differs from the thread's saved provider, `thread/resume` and new input return `-32600` with `data.type` set to `modelProviderMismatch`." `[doc: learn.chatgpt.com/docs/app-server]`
- **V19.** A remi hub resumes a Claude session by starting a child daemon with `--resume` `[src: docs/agent-reference/hub-mode.md:32]` through the same starter a `create_session_request` uses `[src: cli/handlers/create-session-events.ts:276]`.

### Provider terms

- **V20.** Claude Code's legal page: "Advertised usage limits for Pro, Max, and Ultra plans assume ordinary, individual usage of Claude Code and the Agent SDK."
  "Anthropic does not permit third-party developers to offer Claude.ai login into their own applications, or to route requests through Free, Pro, Max, or Ultra plan credentials on behalf of their users. Moreover, developers may not collect, store, or intermediate Claude.ai credentials or session tokens".
  It does not "prevent an end user from signing in to the unmodified Claude Code binary with their own Claude subscription".
  On names: "you can't use the Claude Code or Anthropic names or logos as part of your own product, feature, or company name".
  For questions: "For questions about permitted authentication methods for your use case, please contact sales". `[doc: code.claude.com/docs/en/legal-and-compliance]`
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
  3.3: Customer will not "(h) interfere with or disrupt the Services, including circumvent any rate limits or restrictions or bypass any protective measures or safety mitigations for the Services; (i) violate or circumvent Usage Limits or otherwise configure the Services to avoid Usage Limits."
  Section 17 defines the term so that it reaches plan limits: "“Usage Limits” means End User, messaging, token, throughput rate, or other limits on Customer’s use of the Services as described in the applicable Order Form or Documentation", and "“Documentation” means the documentation OpenAI provides to Customer or otherwise makes publicly available." `[doc: cdn.openai.com/osa/openai-services-agreement.pdf]`
- **V25.** OpenAI's "Sign in with ChatGPT" guidance for open-source tools expects several accounts per person, chosen by the person: "Your app needs to manage multiple account registrations so users can choose an existing ChatGPT account or add another."
  "Within your OSS app, you may choose to offer an account picker that allows the user to:" continue with a saved account, use a different account, or sign out.
  "Usage in one app contributes to the same five-hour usage total, and no app receives a separate allowance."
  Asked explicitly, the fetch found no mention of automatic, rotating or limit-triggered switching. `[doc: developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions]`
- **V26.** OpenAI's consumer Terms of Use and its help articles on account switching and Codex usage limits could not be read: each returned HTTP 403 to the fetch tool (Appendix B).
- **V32. Secondary, not relied on.** An article dated Feb 19, 2026 reports an Anthropic employee's post on X: "It's not against terms of service to have multiple MAX accounts." `[doc: piunikaweb.com/2026/02/19/anthropic-claude-max-ban-agent-sdk-clarification/]`
  The A02 review also cites a search excerpt saying that accounts on one billing method share one rate-limit pool (its source S12, not read as a page).
  Neither is vendor text; neither says anything about switching when a limit is reached.

## Gaps (written as gaps, not filled)

- **G1.** Claude `rate_limits` is documented for Pro, Max and Ultra only; Team and Enterprise plans are not mentioned (V8).
- **G2.** The status line documents `five_hour`, `seven_day` and `spend_limit` windows, while the support article names a separate weekly Fable limit on Max and Ultra (V11): a session can hit a limit the signal does not show.
- **G3.** No Claude command reports plan usage outside an interactive session (`/usage` is a TUI command), so a profile with no running session has only its last observed value, or none.
- **G4.** `StopFailure` does not separate a usage limit from a rate limit (V9); remi's #905 records the same.
- **G5.** Codex: the cadence of `account/rateLimits/updated`, its behavior under API-key authentication, and what each `rateLimitsByLimitId` bucket means are not documented.
- **G6.** What survives compaction: Claude's "what survives compaction" page was not read; Codex documents nothing, and its compaction item has no summary text (V16).
- **G7.** Whether a compaction request counts against the plan's usage limit is not stated by either vendor; it is a model request, so it probably does.
- **G8.** Resuming a Claude session under another configuration directory (copying its transcript there, or sharing `projects/` by a symbolic link, then `--resume`) is undocumented and untested, and so is whether the conversation's signed thinking blocks stay valid under another account.
- **G9.** Codex resume or fork by rollout path from another `CODEX_HOME` exists only as an experimental, unstable parameter and is untested.
- **G10.** `accountSession/switch`: whether it changes the login for every thread on that app-server, and how it interacts with a running turn, is untested and undocumented.
- **G11.** Whether Claude Code treats a remi hub child's PTY as "your own terminal" for its automatic continue and its options menu is untested.
- **G12.** What `claude auth status --json` and `codex login status` print with a real login (the `authMethod` value of a claude.ai login, any plan or account field, possibly an email address) was not run on purpose; only the logged-out and placeholder outputs (V2, V5, V27) are verified.
- **G13.** No text read says whether either vendor allows a person to continue work on their own second subscription when the first reaches its limit, by hand or automatically.
- **G14.** #1157's phase 1 gate (two profiles stay logged in through 24 hours of token refresh) and its socket-path-length gotcha have not been rechecked on the installed versions; `codex-socket.ts:7-8` notes that Codex links the control path to a short socket elsewhere.
- **G15.** Configuration-level isolation: whether a keyless Console sign-in's sign-out crosses configuration directories; whether a trusted project's `env` credential applies in `claude auth status` as it does in a session; and whether Codex keys its `keyring` entries by `CODEX_HOME` (if not, two profiles could share one login) are not documented and untested.
- **G16.** The Claude usage-limit state itself: which hooks fire when a limit pauses a task (`StopFailure`, only `Notification`, or neither), what remi's screen parse sees (the two footer lines, the options menu), and which stop path works there; for Codex, what the TUI shows at a limit. Reaching a limit needs a real account, so this is an owner-run characterization (phase 5A).
- **G17.** Claude exposes no account identifier remi has observed (the logged-out and placeholder outputs carry none), so "same account" may stay unknown for Claude.
- **G18.** The CLIs update themselves (Claude Code moved from 2.1.323 to 2.1.325 during this card), so every fact about a CLI is a fact about one version.
- **G19.** OpenAI's channel for a question about multiple accounts was not read (its help center returned HTTP 403).

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
The proposal therefore uses the largest observed window percentage per account, with its age, against two configurable thresholds below 100, and treats an observed limit failure (V9, V13) or the limit-wait state (V30) as the authoritative event.

## Options considered

- **O1. Documentation only.** Tell users to run `CLAUDE_CONFIG_DIR=... remi` themselves (V1). Lost: a remote session cannot pick an account, transcripts and status probes stay on `~/.claude` (V7), nothing records which account a session used.
- **O2. Profiles only (#1157).** Explicit, per-session account selection. Kept as phase 1 and 2: useful alone, entirely within documented mechanisms (V1, V5), no terms question beyond #1157's. Table stakes in the market (Positioning).
- **O3. Profiles, read-only usage, and human-confirmed continuation.** Proposed below. Usage comes only from what each CLI already reports (V8, V12); a continuation to another of the person's own profiles happens only when the person confirms it, after seeing what differs between the two profiles and what the new session will not have.
- **O4. Standing automatic rotation at a threshold (the idea as stated).** Rejected. It contradicts #1157 hard rule 3, and it reads directly against OpenAI's "configure the Services to avoid Usage Limits", a term defined to cover limits "described in the applicable Order Form or Documentation" (V24), and plausibly against Anthropic's "bypass ... restrictions ... established within our products" and "create multiple accounts, to ... circumvent product guardrails" together with "ordinary, individual usage" (V20, V22). The tools that do it copy or replace tokens (Positioning).
- **O5. Provider-native in-session switching.** Claude's `/login` in a running session switches the conversation's account (V10), and Codex has an experimental `accountSession/switch` (V6). Rejected as remi's mechanism: `/login` would replace the login stored for that profile's directory (inferred from V1: one login per directory, not tested), so the profile would no longer mean one account, and it needs a browser login at that terminal; `accountSession/switch` is experimental and probably global to the app-server (G10). Both stay available to the person, and remi's notices may mention them.
- **O6. remi reads tokens or calls usage endpoints itself.** Rejected outright: it breaks #1157 hard rule 1 and "developers may not collect, store, or intermediate Claude.ai credentials or session tokens" (V20).
- **O7. A one-shot continuation armed by the person for one session.** The person arms, in the app, a single continuation for one session onto one chosen target; it fires at most once, on the authoritative limit event, and expires at the source window's reset. Kept as the only shape phase 6 may take, behind Q1, Q2 and Q11.

For the material carried into the new session:

- **C1. The compaction summary from account A** (Claude `compact_summary`, V15). Best quality; needs headroom on A (G7), so not available in the limit wait; Codex exposes no summary text (V16).
- **C2. A deterministic handoff brief built by remi** from what it already reads (the transcript or thread items, the directory and branch). No model call, always available, lower quality.
- **C3. The same conversation resumed under account B** (Claude transcript copy or a shared `projects/` link, Codex rollout path). Closest to "continue the work", but undocumented or experimental (G8, G9).
- **C4. Wait for the reset** (Claude's automatic continue, V10). Already provided by Claude Code; remi should surface it, not replace it.

## Proposed decision (proposed, not accepted)

**D1. Profiles, as #1157 and the backend plan define them, with the effective login checked.**
A profile is local configuration: an immutable `id`, a `label`, and per harness the state directory it selects (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`) and the kind of login it expects (subscription or API key), plus the settings bundle #1157 lists.
Selection precedence, launch environment, the per-session snapshot, refusal of a logged-out or unknown explicit profile, and the built-in `default` that changes nothing follow the contract proposed in the backend plan and #1313.
The launch environment removes the credential variables of V3, the selectors of V28 (`ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`), `ANTHROPIC_BASE_URL` unless the profile sets it, and the variables a phase 1 characterization shows Codex reads as credentials; then applies the profile's selectors; then remi's secret scrub last.
The session record gains an optional `profile` (absent means `default`), following the `harness` pattern (V7).
A hub passes the profile to a child through the child's environment, so the existing seams follow it: the child's PTY inherits it (V7) and Codex resolves that profile's socket and app-server (V7).

Before every launch, remi asks the harness which credential it will use, never what it is.
Claude: `claude auth status --json` under the exact launch environment and directory; the profile is accepted only when `authMethod` matches its expected kind and `apiKeySource` is absent unless the profile expects an API key (V27); otherwise an explicit profile is refused with "this profile's login is not what will be used" and the source name (for example `apiKeyHelper`).
Codex: the exit code of `codex login status`, and `account/read`'s `type` once attached (V6).
Configuration-level sources the status may not show are warnings, read by name only, never by content: an Anthropic profile directory with an `active_config` file or `configs/` entries (V28), `forceLoginOrgUUID` or `forceLoginMethod` keys in managed settings, and `apiKeyHelper` or credential-named `env` keys in managed, user or project settings (V28).
remi keeps, on the machine only, the non-identifying facts it needs to enforce Q6 and to label quota: Claude `authMethod`, `apiProvider` and `apiKeySource` names, Codex `Account.type` and `planType`.
Codex reports a plan type (V6); Claude reports none remi has seen (G12), so for Claude the "individual subscription" marking of Q6 is self-declared by the person unless the phase 1 gate finds a plan field, and remi says so where the marking is shown.
Login itself always runs the harness's own flow in the person's terminal (#1157 hard rule 2).

**D2. Usage is observed, never fetched with a credential.**
Claude: remi's status line script also records the numeric `rate_limits` windows (`used_percentage`, `resets_at`) it already receives (V8), per session, into a remi-owned file the daemon reads; where the person has their own `statusLine`, remi offers to wrap it (record, then run the person's command with the same input) and otherwise reports "unknown".
Codex: the session's existing app-server client calls `account/rateLimits/read` at attach and after each `turn/completed`, and merges `account/rateLimits/updated` (V12).
Both feed one per-profile snapshot: for each window, its percentage, length, reset time, source and observation time, plus Codex's `ordinaryUsageAllowed` and `rateLimitReachedType`.
Observations merge per window by observation time: an older observation never overwrites a newer one, and a sparse Codex update replaces only the fields it carries.
The account fingerprint (D11) is attached to every observation; an observation whose fingerprint differs from the profile's last one starts a new snapshot instead of merging.
`accountId`, email and workspace names are dropped on receipt, after the fingerprint is computed (V6, V12).
A value is shown with its source and age; an absent value is "unknown", never estimated (G1 to G3); an API-key profile shows "billed per request" instead of a window (V10).

**D3. Thresholds and notices.**
Per profile: `warn_percent` (default 90) and `offer_percent` (default 95), each settable from 50 to 99 (Q3).
They are evaluated at turn ends (Claude `Stop`, Codex `turn/completed`) against the largest observed window.
Crossing `warn_percent` sends one notice per profile, window and reset period (a new push kind, Q8).
Crossing `offer_percent`, a turn failing on `rate_limit` or `usageLimitExceeded` (V9, V13), or a session entering the limit wait (D5), makes remi offer the choices in D7 to authenticated clients; it starts nothing on its own.
There is one offer per profile, not per session: every session on that profile is listed in it, each continued separately.
When Claude Code's own automatic continue is waiting (V10), the offer says when Claude will continue.

**D4. Compaction on request.**
A client or the terminal may ask remi to compact a session on its current account.
Claude: remi types `/compact` with remi's handoff instructions through the same guarded write path chat uses (no prompt up, no turn running, not in the limit wait), and learns completion from a newly registered, non-blocking `PostCompact` hook (V15), with `SessionStart` source `compact` as a second signal.
`PreCompact` stays unregistered, so remi still never gates compaction (#203).
Codex: remi calls `thread/compact/start` and waits for the `contextCompaction` item to complete (V16).
A deadline bounds the wait; on expiry the session is untouched and the request reports "not confirmed".
In the limit wait there is no headroom (V30), so compaction is not offered there; the brief (C2) is.

**D5. Continuation on another of the person's profiles, confirmed by the person.**
The hub owns it, because it already starts and resumes children (V19).
Request: session, target profile, mode `summary` (default; C1 or C2) or `resume` (C3, only after phase 5B passes, Q4).

The source session is in one of two states, and the request names which it expects:
**idle** (no turn running) or **limit wait**.
Limit wait is a distinct state: for Claude it is entered on the hook and screen signature that phase 5A characterizes (G16) from among `StopFailure` `rate_limit`, `Notification` `quota_auto_resume_*` and the footer and menu of V30;
for Codex, on a turn failed with `usageLimitExceeded`, `ordinaryUsageAllowed` false, or a non-null `rateLimitReachedType` (V12, V13).
In limit wait, a numbered menu that matches the characterized limit signature does not count as a prompt for this request, while a held hook, a hook-backed prompt in the terminal, any other menu and any Codex approval still do;
remi types nothing into the wait or the menu (no Esc, no digit, no `/exit`), takes the brief (C2), and stops the source by forced close (V30).
Until phase 5A has passed, a source in limit wait is refused with "answer or cancel Claude's usage-limit screen first".

Preconditions, each refused with a reason that names it:
the session is a hub child (a wrapper session gets the exact command to run instead);
the state is idle or limit wait as above;
no prompt is up and no Codex approval card is live (ADR 0038 cards are answered or dismissed first);
the target profile is configured, allowed for this directory, marked as a continuation target, and, for a remote caller, remotely selectable;
the target's effective login is its own (D1) and its last snapshot is below `offer_percent` with `ordinaryUsageAllowed` not false, or is unknown and the person confirmed "unknown";
the target is not the same account as the source (D11), or "same account" is unknown and the screen says so;
no other continuation of this session is in flight.

Before the person confirms, remi shows two lists.
**What differs:** the permission rules (`permissions` allow, ask and deny) and hooks of the two profiles' settings for Claude, and `approval_policy`, `sandbox_mode` and `model_provider` for Codex (V5, V29), as a diff of rule texts and hook commands, never of `env` values; a target that allows more than the source is flagged and needs its own confirmation.
**What the new session will not have:** the permission mode and the standing grants of this session (V29), background tasks and background-session state, and anything that lives in the source profile's directory and not the target's: settings, hooks, plugins, skills, MCP servers, the user `CLAUDE.md` and auto-memory (V29).
An API-key target is labeled "billed per request" (V10).
Sessions already running on the target profile are listed.

Steps:
(1) material: from idle, if the source account has headroom, compact on it (D4) and take Claude's `compact_summary`; otherwise, or for Codex, or in limit wait, or when compaction fails, build the brief (C2);
(2) stop the source session: through the existing Stop path from idle, by forced close from limit wait;
(3) start the target session through the hub starter with the target profile, the same directory and the same harness;
(4) submit the material as its first message through the structured or guarded submit path (ADR 0043 for Codex);
(5) record lineage: the new session carries `continuedFrom`, and the source record is marked `supersededBy`.
The source stays resumable under its own profile, but resuming a superseded session warns that the continued session may be editing the same working tree and needs a confirmation.
A failure at any step stops there, reports which step, and never retries or picks another profile.

**D6. Scopes.**
Per project: a profile's `folders` mapping, longest match at a path-component boundary (backend plan).
Per session group: no new object; a group is a continuation lineage plus the workspace a session runs in (ADR 0036), and the profile is recorded per session.
Per remote request: `create_session_request.profile` and the continuation request accept only remotely selectable profile ids, checked at the trust boundary like `harness` and `args` (ADR 0033), behind the `session_profiles` capability.
Remote visibility: once transcript discovery spans every profile, every enrolled device would see every profile's sessions; phase 2 decides a per-profile `remote_visible` setting (proposed default: visible, which is today's behavior), and a session or transcript of a profile that is not remotely visible is not listed to remote clients.

**D7. What a phone shows, and when.**
On every session: its profile label (never an email).
On demand: a usage panel per profile, each window with percentage, reset time, source and age, or "billed per request".
At `warn_percent`: one notice.
At `offer_percent`, on a usage-limit failure, or in the limit wait: one offer per profile with
"Compact now" (idle only),
"Continue on" a named profile (only eligible targets, each with its own usage, age, and the sessions already on it),
"Wait for reset" (Claude's own wait, when present),
and the harness's own ways past a limit: adding usage credits with `/usage-credits` and switching models with `/model` (V30), shown as the commands to run at the terminal or through `remi attach` until phase 5A shows a safe way for remi to send them.
Confirming a continuation needs the app (no lock-screen action), because it spends another account, and shows the two lists of D5.
After a continuation: the result, and links between the new session and the superseded one.

**D8. Failure modes.**

| Situation | Behavior |
|---|---|
| Continuation asked mid-turn | Refused; offered again at the turn end |
| Claude hook held, prompt in the terminal, or a menu up that is not the characterized limit menu | Refused, the reason says answer or dismiss first |
| Codex approval pending | Refused; a pending request stays on the old app-server after a stop `[src: docs/agent-reference/harnesses-and-codex.md:33]`, so it must be answered first |
| Claude in its usage-limit wait, or its options menu open | Before phase 5A: refused, "answer or cancel Claude's usage-limit screen first". After: allowed through the limit-wait path of D5 only when the screen matches the characterized signature; remi types nothing, takes the brief, stops by forced close, and the confirm screen says Claude's own wait ends (V10) |
| Target at or above `offer_percent`, or `ordinaryUsageAllowed` false | Not offered |
| Target usage unknown | Offered as "unknown", needs explicit confirmation |
| Target is the same account as the source | Refused; "same account unknown" is shown as such |
| The account under a profile changed (`auth_success`, `account/updated`, a new fingerprint) | That profile's snapshot is discarded and no offer names it until a fresh observation |
| Target logged out, expired, revoked, or its effective login is not its own | Refused with `remi profile login <id>` or the source name; nothing is stopped |
| Target allows more than the source | Shown in the diff, needs its own confirmation |
| Target's first turn fails (`authentication_failed`, `account_on_hold`, `rate_limit`, `usageLimitExceeded`) | The existing failed-turn notice; no further switch; the source session stays resumable |
| Compaction on the source fails, is blocked, or hits the limit | Fall back to the brief (C2) |
| The superseded source is resumed later | Warned, needs a confirmation |
| Hub restarts during a continuation | The step reached is persisted; nothing resumes on its own; clients see the state |
| Two clients ask at once | The first wins, the second is refused |

**D9. Automatic continuation is not built** until the owner amends #1157 hard rule 3 (Q1) and the vendor concerned answers in writing (Q2).
If it is ever built, it takes only the shape of O7 (Q11): armed by the person in the app for one session and one target; fires at most once, on the authoritative limit event; expires at the source window's reset; never while a card is live; never between a team, business or enterprise seat and anything else; a notice before and after; all of D5's preconditions, with the confirmation replaced by the arming.
There is no standing rotation per profile pair.

**D10. What remi never does:** read, copy, store, print or relay a credential or token; run a login from a phone; choose a profile the person did not configure; continue onto a seat of another person (V21, V24); describe the feature as a way to get more usage; log, store or forward an email, workspace name or account identifier (only its keyed hash, D11, stays on the machine); use "Claude Code" or "Anthropic" in a feature, product or command name (V20), and, by the same caution, no OpenAI or Codex mark either.

**D11. A local account fingerprint.**
remi keeps a keyed hash (an HMAC with a random key generated on the machine, in an owner-only file under the remi home) of each provider account identifier it receives, never sent, logged or shown.
It answers two questions only: are two profiles the same account (refuse a continuation onto it), and did the account under a profile change (discard its usage snapshot, warn the person).
Source: Codex `accountId` from `account/rateLimits/read` (V12); Claude has none remi has observed (G17), so for Claude both answers are "unknown" unless the phase 1 gate finds a stable identifier.
Claude `auth_success` and Codex `account/updated` (V31) also invalidate the profile's snapshot until a fresh observation.

## Consequences

- Phase 1 and 2 deliver #1157 for both harnesses with no terms question beyond #1157's own, and the protocol freeze gets its profile fields; they also close a gap #1157 did not cover: a profile whose effective login is not its own (V27, V28) is caught before launch.
- remi learns account usage only where a CLI already reports it to a client; some plans and limits stay "unknown" (G1 to G3), and the user interface must say so instead of guessing.
- Registering `PostCompact` adds one hook call per compaction; it cannot block, but its latency against a dead remi must be measured before it ships (Q7).
- Continuation is a stop and a new session: the new account does not see the old conversation, only its summary or brief, until the `resume` mode passes its gate (G8, G9). It also changes the agent's configuration, which is why D5 shows what differs and what is lost.
- The continuation that matters most, at the limit itself, depends on a characterization only the owner can run (G16, phase 5A); until then the limit wait is refused.
- The idea's strongest form (standing automatic rotation at 98 percent) is not designed, perhaps ever, because of terms risk; this ADR says so instead of designing around it. The market position this keeps is the method, not the feature (Positioning).
- New wire shapes (profile fields, usage snapshot, compaction and continuation requests, a usage push kind) each need fixtures and an ADR amendment under ADR 0035 and ADR 0019.

## Open questions for the owner

Each has a recommended option.
Q11 to Q13 come from the A02 review; its question on vendor answers is merged into Q2.

- **Q1. Automatic switching.** (a) keep #1157 hard rule 3: no automatic switching, only confirmed continuation; (b) allow phase 6 after written vendor answers, in the shape Q11 chooses; (c) build it now. **Recommended: (a) now; (b) only with written answers.**
- **Q2. Vendor answers and phase 5.** (a) ask now, Anthropic through the channel its legal page names ("contact sales", V20) and OpenAI through a channel the owner chooses (G19); release phase 5 after an answer or 30 days of silence; phase 6 only with written answers; (b) block phase 5 until written answers; (c) do not ask. **Recommended: (a); phases 1 to 4 do not depend on the answer.**
- **Q3. Thresholds.** (a) warn 90, offer 95, both configurable; (b) warn and offer at 98 as stated. **Recommended: (a), because the signal lags by up to one turn and compaction needs headroom; 98 stays available as a setting.**
- **Q4. Default continuation material.** (a) summary or brief in a new session; (b) resume the same conversation under the new account. **Recommended: (a) by default; (b) only after phase 5B passes.**
- **Q5. Material when the source account has no headroom.** (a) remi's deterministic brief; (b) resume under the target and compact there (needs Q4 (b)); (c) wait for the reset. **Recommended: (a), with (c), `/usage-credits` and `/model` offered beside it.**
- **Q6. Eligible targets.** (a) only profiles marked `continuation_target`, individual subscriptions of the same person, never to or from a team, business or enterprise seat (those seats are single-user under the business terms, V24, and the sign-in method decides which data-handling policies apply, `[doc: learn.chatgpt.com/docs/auth]`), enforced from Codex `planType` and self-declared for Claude until a plan field is found (D1); (b) any configured profile. **Recommended: (a).**
- **Q7. Register Claude's `PostCompact` hook.** (a) yes, after measuring that a dead remi does not delay compaction; (b) no, detect completion from `SessionStart` and the status line only. **Recommended: (a).**
- **Q8. Push kind for usage.** (a) a new kind `usage_warning`, mutable per device; (b) reuse `turn_failed`. **Recommended: (a); `turn_failed` means a turn ended.**
- **Q9. Phone authority.** (a) an authenticated client may start a continuation with an in-app confirmation, only to remotely selectable targets; (b) terminal only. **Recommended: (a), never from the lock screen.**
- **Q10. Flag name.** (a) `--remi-profile` and `REMI_PROFILE` as the backend plan proposes; (b) `--profile`. **Recommended: (a), so provider flags keep their meaning.**
- **Q11. Shape of phase 6.** (a) per session, one shot, armed in the app, expiring at the reset (O7); (b) standing rotation per profile pair; (c) never. **Recommended: (a), still behind Q1 and Q2.**
- **Q12. Local account fingerprint.** (a) a keyed hash kept on the machine (D11); (b) nothing stored, and "same account" stays unknown. **Recommended: (a).**
- **Q13. Tiering.** (a) profiles and usage free in remi; (b) continuation reserved for super-yooz. **Recommended: (a); a competitor already caps added accounts by paid plan (competitive review addendum).**

## Appendix A: commands and versions

Outputs are saved under `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/A01/r1/` (first round) and `.../A01/r2/` (after A02).
No command ran with a real account's state directory except the help texts, which read no credential; the r2 placeholder strings are not credentials.

| Command | Version | Exit | Evidence |
|---|---|---|---|
| `claude --version` | 2.1.323, later 2.1.325 | 0 | `r1/claude-help.txt`, `r2/versions.txt` |
| `claude --help` | 2.1.323 and 2.1.325, identical | 0 | `r1/claude-help.txt`, `r2/claude-help-diff.txt` |
| `claude auth --help`, `claude auth status --help`, `claude auth login --help`, `claude auth logout --help` | 2.1.323 | 0 | `r1/claude-auth-help.txt` |
| `env -i PATH HOME=<scratch> CLAUDE_CONFIG_DIR=<empty> claude auth status --text` and `--json` | 2.1.323 | 1, 1 | `r1/fresh-login-status.txt` |
| `claude auth status --json` with a placeholder `ANTHROPIC_API_KEY`, a placeholder `apiKeyHelper`, a placeholder project `env`, and `ANTHROPIC_BASE_URL` | 2.1.325 | 0, 0, 1, 1 | `r2/claude-auth-status-sources.txt` |
| `codex --version`, `codex --help` | codex-cli 0.167.0 | 0 | `r1/codex-help.txt`, `r2/versions.txt` |
| `codex login --help`, `codex login status --help`, `codex logout --help` | 0.167.0 | 0 | `r1/codex-login-help.txt` |
| `codex resume --help`, `codex fork --help`, `codex app-server --help` | 0.167.0 | 0 | `r1/codex-resume-appserver-help.txt` |
| `env -i PATH HOME=<scratch> CODEX_HOME=<empty> codex login status` | 0.167.0 | 1 | `r1/fresh-login-status.txt` |
| `codex app-server generate-ts --out <scratch>` and `--experimental` | 0.167.0 | 0 | `r1/codex-app-server-schema.txt`, `r2/codex-config-keys.txt` |
| `codex app-server generate-json-schema --out <scratch>` | 0.167.0 | 0 | `r1/codex-json-schema-listing.txt` (file names only) |

Key outputs, verbatim:

```text
$ claude --version
2.1.323 (Claude Code)            (r1; r2 later the same day: 2.1.325 (Claude Code))
$ codex --version
codex-cli 0.167.0
$ env -i ... CLAUDE_CONFIG_DIR=$FRESH/claude claude auth status --text
Not logged in. Run claude auth login to authenticate.
[exit 1]
$ env -i ... CLAUDE_CONFIG_DIR=$FRESH/claude claude auth status --json
{ "loggedIn": false, "authMethod": "none", "apiProvider": "firstParty", "analyticsDisabled": false,
  "projectsDirectory": "$FRESH/claude/projects", "configDirectory": "$FRESH/claude", "loginExpiresAt": null }
[exit 1]
$ env -i ... CLAUDE_CONFIG_DIR=$FRESH/c1 ANTHROPIC_API_KEY=placeholder-not-a-key claude auth status --json   (2.1.325)
{ "loggedIn": true, "authMethod": "api_key", "apiProvider": "firstParty", "analyticsDisabled": false,
  "projectsDirectory": "$FRESH/c1/projects", "configDirectory": "$FRESH/c1", "loginExpiresAt": null,
  "consoleProfileSignInOffered": true, "apiKeySource": "ANTHROPIC_API_KEY" }
[exit 0]
$ env -i ... CLAUDE_CONFIG_DIR=$FRESH/c2 claude auth status --json   (c2/settings.json: {"apiKeyHelper":"echo placeholder-not-a-key"})
{ "loggedIn": true, "authMethod": "api_key_helper", ..., "apiKeySource": "apiKeyHelper" }
[exit 0]
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
$ codex app-server generate-ts --experimental (ClientRequest.ts excerpt; v2/Config.ts keys)
"method": "accountSession/list", id: RequestId, params: AccountSessionsListParams
"method": "accountSession/switch", id: RequestId, params: AccountSessionsSwitchParams
approval_policy: AskForApproval | null
sandbox_mode: SandboxMode | null
forced_login_method: ForcedLoginMethod | null
```

## Appendix B: documentation and terms read on 2026-11-13

Quotes as returned are in `r1/web-sources.txt` and `r2/web-sources-r2.txt` in the evidence directory.

| URL | Result |
|---|---|
| https://code.claude.com/docs/en/authentication | read |
| https://code.claude.com/docs/en/legal-and-compliance | read |
| https://code.claude.com/docs/en/statusline | read |
| https://code.claude.com/docs/en/hooks | read in three parts |
| https://code.claude.com/docs/en/interactive-mode | read (section "Wait for a usage limit to reset") |
| https://code.claude.com/docs/en/commands | read |
| https://code.claude.com/docs/en/env-vars | read in two parts |
| https://code.claude.com/docs/en/settings | read (r2) |
| https://code.claude.com/docs/en/claude-directory | read (r2) |
| https://support.claude.com/en/articles/11145838-using-claude-code-with-your-max-plan | read |
| https://www.anthropic.com/legal/consumer-terms | read (effective Oct 8, 2025) |
| https://www.anthropic.com/legal/aup | read (effective Nov 12, 2026) |
| https://www.anthropic.com/legal/commercial-terms | read (effective Jun 17, 2025) |
| https://learn.chatgpt.com/docs/auth (from developers.openai.com/codex/auth) | read |
| https://learn.chatgpt.com/docs/app-server (from developers.openai.com/codex/app-server) | read in two parts |
| https://learn.chatgpt.com/docs/pricing | read |
| https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions | read |
| https://cdn.openai.com/osa/openai-services-agreement.pdf | read (ONLINE v.010126; definitions in r2) |
| https://piunikaweb.com/2026/02/19/anthropic-claude-max-ban-agent-sdk-clarification/ | read (r2; secondary) |
| Competitor pages listed in the competitive review addendum | read (r2) |
| https://openai.com/policies/terms-of-use/ (and the row and en-GB variants, and /policies/services-agreement/) | not read: HTTP 403 |
| https://help.openai.com/en/articles/20001068-use-multiple-accounts-with-account-switching | not read: HTTP 403 |
| https://help.openai.com/en/articles/11369540-codex-usage-limits | not read: HTTP 403 |

## Appendix C: remi source and documentation cited

Excerpts with line numbers are in `r1/source-citations.txt`, taken at `68940c1d`:
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
Added in r2, at the same commit:
`docs/agent-reference/questions-and-notifications.md` (33, 225-236, 252, 304-305),
`docs/agent-reference/harnesses-and-codex.md` (11, 33),
`docs/agent-reference/hub-mode.md` (32).
