# Remi reference: hub mode

Moved verbatim out of `AGENTS.md` to keep it under the instruction-size limit; `AGENTS.md` keeps the summary and the standing invariants.

## Hub mode (`remi serve` / `remi start`)

Epic #648 phase 1 (#542). The hub is a **session-less supervisor**: it binds
the well-known port (18765 preferred, 20-port probe), runs the shared services
(WebSocket, mDNS, the relay when enabled, Telegram, device tokens), serves the machine's
session list (`daemonPorts` from `~/.remi/live-sessions/`), and spawns child
`remi --daemon` session daemons on create-session requests. It **never**
spawns Claude, never installs Claude hook config in its cwd, and never
registers itself in live-sessions.

- `remi serve` = foreground hub (the LaunchAgent/systemd entrypoint).
- `remi start` = detached hub launcher; `remi stop`/`status` manage it.
  `remi start` no longer creates a Claude session in the cwd.
- The hub self-writes `~/.remi/daemon.pid`; `remi status`/`stop` fall back to
  `daemon-status.json` (`mode: "hub"`) when the PID file is missing.
- `daemon-status.json` belongs exclusively to the hub. Every session daemon
  (hub-spawned children, which get `REMI_SPAWNED_CHILD=1`, and manually run
  `remi --daemon`) writes a per-port `status-<PORT>.json` instead.
- A session-less daemon answers `hello` with `hello_ack{sessionId: null}`;
  clients then discover children via the session-list `daemonPorts` broadcast
  (live-sessions watcher, all modes).
- `--install` generates a LaunchAgent running `<PATH-resolved remi> serve`
  with `KeepAlive.SuccessfulExit=false` (clean stop stays stopped; crash
  exit(1) restarts).
- A `create_session_request` may name a harness and its arguments (#1179, "Harness identity and
  `create_session_request`" below). The hub itself is still session-less and Claude-only: it only
  spawns the child daemon that hosts the Codex or Claude session.
- A `resume_session_request` that reaches the hub starts a **child session daemon** with `--resume` (#1129; #1124 had refused it, because the shared handler used to run Claude inside the hub, and when that Claude exited the hub exited 0 and the LaunchAgent did not restart it).
  The handler (`cli/handlers/resume-session-events.ts`) resolves the stored session as a daemon does (a remi id, a Claude id, or a transcript on disk), then calls `startSession` (`cli/handlers/create-session-events.ts`), the path a `create_session_request` takes, with `--resume <claude id>` in the stored directory.
  So the remote-argument allowlist and the refusal of a Claude session a live remi session already holds apply to a resume exactly as to a create request that names `--resume`.
  Resolution: a record of another harness is never resumed with Claude's flag, by its remi id or any other; a Claude id with several exited rows (every resume adds one) resolves to the newest, and two live rows are still refused as ambiguous (`findResumableByClaudeSessionId`); a session found only as a transcript resumes in the `cwd` the transcript recorded (`readTranscriptCwd`, the first 64 KiB), and only an old transcript with none falls back to decoding the project folder's name, which cannot be decoded when the project has a dash in its name.
  The response is `resume_session_response{success, sessionId, port}`.
  A failure from the child start carries `startSession`'s short, host-free text; a failure to resolve names the id the requester sent (written out and cut at 80 characters) and, for a missing directory, the session's own project path, but never the cause of an unreadable store, which only the log gets.
  A stored id that is not a UUID is refused before the start, and a session already resumed through this hub in the last 15 seconds (or still being started) is refused as "just resumed": the new row learns its Claude id only once Claude binds, so a double tap or a second phone would otherwise pass the held check and start a second child that loses the race.
  The hub attaches nobody and sends no `hello_ack`: the session is in the child, which a client reaches through the session list's `daemonPorts` and a direct connection.
  The web client refreshes its list and opens the session when the child's `hello_ack` arrives (`lib/resume-follow.ts`), only if the person is still on the session they were on when they tapped Resume (not when the answer arrives, which a hub sends only after the child registers) and within 30 seconds, because a background event never replaces a choice (#688); a child that never says hello (a port the device cannot reach) is reported in the chat when the window ends. No Telegram path sends this request.
  The hub still never runs Claude: `createResumeSessionHandlers` takes `childSessions` (a starter in hub mode, `null` for a session daemon or wrapper), not a flag, and the hub's branch returns before any path that calls `createNewSession` (a runtime branch, tested by giving the hub's handler a `createNewSession` that throws).
  What was run: a real hub with a fake `claude` that records its argv (`integration/hub-resume.test.ts`), and LV-4's spawn and `--resume` through a hub with a real Claude Code (ADR 0033).
  Not verified live: a real Claude's binding and hooks in a session resumed through a child.
  A daemon that hosts Codex refuses `resume_session_request` with `UNSUPPORTED` (#1179); resuming a Codex thread through a hub is not built.
