# Card G01: a throwaway hub with fake sessions for the manager's visible simulator checks

Status: ready
Tier: worker
Timebox: M, 3 hours; escalate at 1 day or two failed approaches
Needs: none (no Xcode, no simulator)
Depends: develop `3bb7ad9d`
Branch: none (nothing is committed; the fixture lives outside git)
Worktree: `/Volumes/S1/worktrees/remi/preview-develop` (read and run only; it is a detached checkout of develop; never commit there)
Plan: `packages/native/AGENTS.md` ("Running a hub for development", "The dev app must never talk to a real hub")

## Goal

A script outside the repository, `/Volumes/S1/yooz/remi/gui-fixture/start-hub.sh`, starts a throwaway hub on 127.0.0.1 port 18791 with its own `REMI_HOME` under `/Volumes/S1/yooz/remi/gui-fixture/home`, keeps it empty of the owner's data, and registers eight fake sessions (four that are waiting for the person with a pending question, four that are idle, with a few transcript lines each) so the iPad Board has cards to show; a matching `stop-hub.sh` stops everything it started; the manager then pairs the simulator app with it.

## Context

- The owner's real hub is PID 2140 on port 18765 (`remi serve --port 18765`, state under `~/.remi`). It must not be touched, signalled or have its state read; the ONLY allowed contact is the two read-only checks named in Acceptance 1 and the Gates (`ps -p 2140 -o command` and `remi status`, which prints process status and never reads `~/.remi` data), run before and after to show it is unchanged. Never use port 18765 to 18769 (the real hub and its session daemons) and never use `~/.remi`.
- Start the fixture hub the way the repository documents: from the worktree root, `env -i` with only the variables needed (PATH, HOME is NOT the owner's real state because `REMI_HOME` overrides state, but give `HOME=/Volumes/S1/yooz/remi/gui-fixture/home-user` so nothing resolves to the real `~/.remi`), `REMI_HOME=/Volumes/S1/yooz/remi/gui-fixture/home bun packages/daemon/src/cli.ts serve --port 18791`. Authentication is on; the app's first connection waits for approval: `keys` lists it, `authorize <fingerprint> --label dev` approves it (the manager does that step). Do not use `--no-auth`.
- No relay, no push secret, no APNS: the fixture must not contact the Worker or any external host.
- How to get fake sessions: a session daemon wraps a command in a PTY (`remi -- COMMAND`) and registers with the hub on its port; find out how the hub discovers session daemons and how a pending question is produced (the hook bridge for Claude, or the PTY output parser's question patterns such as `[Y/n]`; see `docs/agent-reference/questions-and-notifications.md` and `packages/daemon/src/cli.ts`). The fake agent is a small shell or Bun script that prints a few lines, then a question in a form the daemon recognizes, then waits for input. It must never start Claude or Codex and must not call the network.
- Session names should be readable on the Board (for example "Native iOS 1" to "Native iOS 4" waiting, "Protocol freeze 1" to "Protocol freeze 4" idle).
- Nothing is committed to the repository; this is local tooling. Evidence goes to `/Volumes/S1/yooz/remi/artifacts/land-branches-2026-11/G01/r1/`.

## Scope

May create and change: files under `/Volumes/S1/yooz/remi/gui-fixture/` only; the evidence folder.
May read: the repository worktree. May run: the fixture hub and fake sessions on ports 18791 to 18799.
No other file; no repository change; never touch `~/.remi`, port 18765, PID 2140 or the other session daemons (ports 18766 to 18769).

## Decided design

Settled:
1. `start-hub.sh` is idempotent: it refuses to start if port 18791 is already in use, writes the PIDs it starts to `/Volumes/S1/yooz/remi/gui-fixture/pids`, and `stop-hub.sh` kills only those PIDs (never a `pgrep -f` pattern, never a process it did not record).
2. The hub binds 127.0.0.1 only (the simulator reaches it there).
3. `status.sh` prints the hub's own `remi status` for the fixture `REMI_HOME` and the list of fake sessions, and `keys.sh` wraps `keys` and `authorize` for the fixture hub.
The worker may choose: the fake agent's language, how sessions are registered, names of the helper scripts.

Never do: touch the real hub or `~/.remi`; send a signal to a process you did not start; use `--no-auth`; contact an external host; read or print secrets.

## Acceptance

1. `/Volumes/S1/yooz/remi/gui-fixture/start-hub.sh` starts the hub; `/Volumes/S1/yooz/remi/gui-fixture/status.sh` shows eight sessions, four with a pending question; the real hub is unchanged (`remi status` for the real hub, PID 2140, still running with the same session list, read-only).
2. A raw WebSocket or CLI check that the fixture hub lists the eight sessions and that unauthenticated clients are refused or pending (not trusted); quote the command and the result line.
3. `/Volumes/S1/yooz/remi/gui-fixture/stop-hub.sh` stops only the recorded PIDs, and `lsof -nP -iTCP:18791 -sTCP:LISTEN` prints nothing afterwards; start it again and leave it running at the end.
4. A short `README.txt` in the fixture folder says how to start, stop, pair a simulator (including the one command to approve its key) and the port rules.

## Gates

`lsof -nP -iTCP:18791 -sTCP:LISTEN` shows the fixture hub listening on 127.0.0.1 only; `ps -p 2140 -o command` still shows `remi serve --port 18765`; `git -C /Volumes/S1/worktrees/remi/preview-develop status --short` prints nothing.

## Stop conditions

Sessions cannot be produced without starting a real agent or contacting the network; anything would touch the real hub or `~/.remi`; the hub needs a code change to run (report instead of patching).

## Report

The preamble's report, plus the exact commands to start, stop and pair, the port in use, and what the fake sessions look like on the hub (names and which are waiting).
