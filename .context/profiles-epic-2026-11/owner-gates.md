# Owner gates

Each gate needs a real account, a physical device, TestFlight or a real usage limit, so no agent runs it.
The manager sets the gate `owner` when its Depends are done, sends the owner this section once, and records the owner's result with `decide ... --by owner`.
Record only what each gate asks for: never an email, an account id, a token, or a path of the owner's machine in anything committed or posted.

## OG-P1: two profiles, two accounts, 24 hours (issue #1748)

After P1B merged; build from the develop tip in a worktree the owner chooses (for example `/Volumes/S1/worktrees/remi/profiles-develop-verify` after DV), and run that build by its absolute path (called `REMI` below).
Use a separate remi home so the running 0.8.x hub's state is untouched: `export G="$HOME/.remi-profiles-gate"` (absolute).

0. In a plain terminal (not through remi), run `claude auth status --text` and `codex login status` and note by eye, without recording it, which account your default sign-in is.
1. `REMI_HOME="$G" "$REMI" profile add work --label Work --claude` and `REMI_HOME="$G" "$REMI" profile add personal --label Personal --claude` (add `--codex` too to check Codex; unless P1C found keychain sign-ins separated per `CODEX_HOME`, first add the line `cli_auth_credentials_store = "file"` to each profile's Codex `config.toml`, as the build's refusal says; this keeps a plaintext `auth.json` with mode 0600 in that directory).
2. `REMI_HOME="$G" "$REMI" profile login work --harness claude`, then the same for `personal`, each with the matching account in Claude Code's own sign-in.
3. `REMI_HOME="$G" "$REMI" profile ls`: both show "signed in".
4. Two terminals, two repositories: `REMI_HOME="$G" "$REMI" --remi-profile work --port 18801` and `REMI_HOME="$G" "$REMI" --remi-profile personal --port 18802`.
5. In each session's shell: `claude auth status --json | jq '{authMethod, apiProvider}'`, and `claude auth status --json | jq -r .configDirectory` compared with the profile's directory shown by `REMI_HOME="$G" "$REMI" profile show <id>`. Record: the `authMethod` value (expected `claude.ai`, risk R1) and whether `configDirectory` matched (yes or no). Do not record `subscriptionType`, an email or a path: the board and log are pushed to a public repository (J12).
6. Use both sessions normally for 24 hours; then `REMI_HOME="$G" "$REMI" profile ls` still shows both signed in.
7. `REMI_HOME="$G" "$REMI" profile ls` shows the built-in default first, and a session started without `--remi-profile` (and no folder mapping) reports `~/.claude` as its `configDirectory`.
8. Repeat step 0 in a plain terminal and confirm by eye, unrecorded, that the default sign-in is the same account as before (#1157's "the default profile still sees the existing login").
Record: pass or fail per item, `claude --version`, `codex --version`, and the `authMethod` value.

## OG-P2: a phone-started session lands in the right profile (issue #1749)

After P2D merged: a hub from the develop build, `REMI_HOME="$G"`, on a port above 18790 with the binding the owner normally uses for the phone; a folder mapped to `work`; a device allowed to select it.
From the phone's web client, start a session in that folder; check the badge reads Work and `claude auth status --json | jq -r .configDirectory` in that session is the work profile's directory.
Record: pass or fail.

## OG-P3: usage agrees with the CLIs (issue #1750)

After P3C merged, on a real subscription, with the gate's `REMI_HOME="$G"`: first check that the profile's Claude `settings.json` names remi's status line (P2A registers it into profile directories inside a scratch remi home); then, after one turn in a profile session, the web usage panel's windows agree with Claude Code's `/usage` (and, for a Codex profile, Codex's `/status`) within one turn; a Refresh shows its outcome.
Record: pass or fail per harness, and the plan type shown for Codex.

## OG-P4: one real compaction per harness, and the stopped-remi latency (issue #1751)

Before P4A merges (plan J7): with `PostCompact` registered by P4A's branch build, stop remi (`kill` the session daemon you started for this check, nothing else), run `/compact` in the still-open Claude session, and measure how long compaction takes compared with the same `/compact` without the hook (the exact procedure is in P4A's PR body).
After P4A merged: one real compaction through remi per harness (Claude and Codex) completes and reports.
Record: the two durations, pass or fail per harness.

## OG-A3: usage on a signed device (issue #1790)

After A3 merged and a TestFlight build exists (an upload needs the owner's go and a build number above the real current one): on a physical iPhone, the usage view agrees with `/usage` and `/status` within one turn, and a `usage_warning` arrives with the shared text.
Record: pass or fail.

## OG-5A: the usage-limit characterization (issue #1752)

Opportunistic: when a real session reaches a usage limit in normal work, follow `.context/profiles-5a-capture.md` (written by P5A-PREP), redact, and record each #1752 question's answer with versions.
Record: #1752's acceptance items, then CP5.

## TestFlight uploads

Never by an agent without the owner's go for that upload and a build number above the real current one, given by the owner (the manager never reads `~/.appstoreconnect`).
