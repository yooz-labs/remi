# Capture a usage limit for profiles phase 5A

## When to use this

Use this procedure only when a Claude Code or Codex session in ordinary work is near or has just reached a real plan usage limit. Do not start work, spend prompts, or repeat requests to cause a limit. If stopping the task would interrupt important work, leave it running and record the stop and resume questions as untested.

This is an owner-run capture for #1752. It does not enable profile behavior or automatic continuation. The capture can contain prompts, agent output, keystrokes, file paths, account details, and email. Keep raw files on the owner's machine until they have been redacted. Never open, copy, print, or log a credential file or keychain entry.

## Set up a capture session

The switches are opt-in. `REMI_HOOK_DEBUG=1` appends raw hook payloads to `hook-diag.jsonl` under the process's Remi home. `REMI_QUESTION_TRACE=1` appends question lifecycle records to `question-trace.jsonl` under that same Remi home. Both files append and rotate at 10 MB, keeping `.1` and `.2` files. Use the timestamps to select the capture window; do not delete or truncate earlier records.

`REMI_PTY_CAPTURE` must name an absolute, unused file path of its own. It records both `IN` keystrokes and `OUT` terminal bytes, and rotates at 10 MB through `.1` and `.2`; a later rotation replaces those sibling files. Choose a private local path that does not already exist. Use a different path for every harness and capture run.

For a direct wrapper session in the owner's terminal, set the three switches before launching the harness. These examples write the PTY file under the owner's home directory; replace the example filename with a new private path if it already exists.

Claude:

```sh
REMI_HOOK_DEBUG=1 \
REMI_QUESTION_TRACE=1 \
REMI_PTY_CAPTURE="$HOME/.remi-usage-limit-claude.pty" \
remi claude
```

Codex:

```sh
REMI_HOOK_DEBUG=1 \
REMI_QUESTION_TRACE=1 \
REMI_PTY_CAPTURE="$HOME/.remi-usage-limit-codex.pty" \
remi codex
```

These wrapper commands use the normal Remi home. The hook and question traces may therefore contain earlier records as well as this run. This does not set the environment of a Remi hub already running from a LaunchAgent. Do not restart or change the owner's real hub to add these switches. For a hub-child capture, use the separate local hub below.

For the hub-child question, start a second hub with a separate absolute Remi home and an unused port above 18790. This example uses a loopback-only, unauthenticated hub so a local Remi client can reach it without pairing. Keep it on `127.0.0.1`; do not expose the port through a proxy, tunnel, LAN, or relay. Do not change the real hub.

In one terminal:

```sh
REMI_HOME="$HOME/.remi-capture" \
REMI_HOOK_DEBUG=1 \
REMI_QUESTION_TRACE=1 \
REMI_PTY_CAPTURE="$HOME/.remi-usage-limit-hub-child.pty" \
remi serve --bind 127.0.0.1 --no-auth --port 18791
```

In another terminal, create the session through that hub from the project directory you already use for normal work:

```sh
REMI_HOME="$HOME/.remi-capture" \
remi new --host 127.0.0.1 --dir "$PWD" --port 18791 --harness claude
```

If port 18791 is occupied, choose another unused port above 18790 and use it in both commands. Use a Remi client running on the same Mac for the Stop observation, and connect it only to this loopback hub. If no client can reach the loopback hub without changing the real hub, record the hub-child Stop result as untested. When done, stop this second hub from the terminal where `remi serve` is running. Its child inherits the hub's environment, including the three capture switches and `REMI_HOME`.

## What answers each question

| #1752 question | Evidence to inspect | What to record |
| --- | --- | --- |
| Which Claude hooks fire at a usage limit, and in what order? | The `hook_event_name` and timestamps in `hook-diag.jsonl`; use `question-trace.jsonl` for related question lifecycle records. | Whether `StopFailure` with `rate_limit` appears, whether `Notification` with a `quota_auto_resume_*` value appears, or neither; record event order and time deltas without payload text. |
| What does Remi see in Claude's limit UI, including the footer lines and options menu? | PTY capture `OUT` lines, plus the Remi client display and question trace. | Record the two footer line shapes (`Usage limit reached · limit resets …` and `Continuing automatically at … · Esc to cancel`), with clock times replaced by `HH:MM`; note whether a usage-limit menu appears and whether Remi presents a numbered menu. If a permission or trust menu appears naturally, record whether it matches; do not create one for this capture. |
| Does Claude Code treat a hub child's PTY as “your own terminal”? | The PTY capture from the separate hub run and the visible Claude TUI behavior. | Record the result for the footer and options menu separately. If the limit does not occur during ordinary work, mark it unobserved. |
| Does Stop while the menu is open leave the transcript intact and resumable? | Record the menu state before Stop; after Stop, use `remi --sessions all` and the relevant resume command from the same Remi home. | Record whether Stop closed the session, whether the transcript remains available, and whether resume restores the conversation. Do not copy transcript contents into the result. |
| What does Codex show at a limit, which app-server frames arrive, and does an overlay wait for input? | PTY capture `OUT` lines and the Remi log under that run's Remi home (`remi.log` for a wrapper, `daemon.log` for the hub). | Record the TUI and overlay behavior. There is no current switch that captures Codex app-server frames. Use only frames Remi explicitly logged; if `turn/completed` with `usageLimitExceeded` or `account/rateLimits/updated` with `rateLimitReachedType` and `ordinaryUsageAllowed` are not visible in the log, mark the frame answer as a capture gap. Do not infer a frame from the TUI. |
| Can `/model` or `/usage-credits` be sent safely, or only shown? | PTY capture `IN` and `OUT` lines, plus the visible harness state. | Do not type either command into a waiting limit menu or overlay. Record a result only if normal work has already shown a safe outcome; otherwise write “not tested” and choose no-go for that harness. |

## The stop path

Use the Remi client's Stop control on the session only when it is safe to end that work. Record whether the usage-limit menu or overlay was visible. When a prompt is up, Stop does not type `/exit` or press Enter; the daemon force-closes the session so Enter cannot select a menu item. If stopping is not safe, skip this step and mark the stop and resume result untested.

After a Claude Stop, inspect the session list with `remi --sessions all`, then try `remi --resume <id>` from the same Remi home. For a capture hub, prefix both commands with `REMI_HOME="$HOME/.remi-capture"`. Keep the transcript on the owner's machine and record only whether it remained available and resumed. A Codex resume check, if the owner chooses to make one, uses `remi codex resume <id>` from the same Remi home.

## Redact before anything is kept

Treat every raw capture, Remi log, and transcript as private. Before placing any result in `.context/` or sharing it with an agent, remove prompts, agent output, tool arguments, file paths, session IDs, account and plan details, email, and machine names. Never include the raw capture files or transcript.

Keep only hook event names and their order, time deltas, the footer and menu line shapes, and the outcome for each question. Replace clock times in screen lines with `HH:MM`. Keep the `IN`/`OUT` distinction only when it is needed to say whether a command was sent or merely shown. After extracting the redacted facts, remove raw files that are no longer needed.

## Hand back

The owner records the result in `.context/profiles-5a-result.md` or gives an agent only redacted files. Include the version strings from `claude --version` and `codex --version`, one answer for each #1752 question, any capture gaps, and a go or no-go for the limit-wait path for each harness. An untested or unobservable item is not a go. Agents can turn a recorded redacted signature into fixtures afterwards; no fixture or real capture belongs in this preparation change.
