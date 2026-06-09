# Changelog

All notable changes to Remi are documented here.

## [Unreleased]

## [0.6.6] - 2026-06-09

A reliability fix for session binding. When a project directory accumulates many
past Remi sessions (Remi reuses one loopback port per directory, so each run
leaves a `remi:<port>` transcript behind), the no-hooks rotation detector could
crawl that history and lock onto a long-dead session, then drop the live
session's hook events as "foreign". This made auto-approve appear dead in a
freshly restarted session.

### Fixed
- **Binder dir-poll no longer locks onto stale history** (#529): the no-hooks
  rotation poll now applies a freshness gate, so a same-port transcript whose
  file is older than 5 minutes is treated as historical and ignored rather than
  adopted as a live rotation. A genuine rotation writes a fresh transcript and
  is still picked up immediately.

## [0.6.5] - 2026-06-09

Auto-approve becomes synchronous and far more reliable: the daemon now answers
permission hooks with a decision instead of typing into the terminal, which
removes the parallel-subagent leak and the dropped-decision races. Plus
permission groups, a heavy-model "second opinion" tier, richer phone prompts,
and a session-binding fix.

### Added
- **Permission groups** (#495): read-only / VCS-read / build-test commands are
  fast-pathed to approve with **no LLM call at all**, using compound-segment-aware
  matching. Configurable via `[auto_approve] approve_groups` / `deny_groups`.
- **`escalate_model` second-opinion tier** (#522): an optional heavier model
  consulted ONLY when the fast model would escalate a main-agent permission. If
  it approves, the action is auto-approved; otherwise you are asked. The heavy
  model's latency only hits would-escalate cases, never the common path.
- Escalated permission prompts now carry **tool + command context** on the
  phone, e.g. `Allow Bash: git push origin develop`, and name the agent for
  subagent prompts (`code-reviewer · Bash: …`) instead of a bare "Do you want
  to proceed?" (#497).

### Changed
- **Synchronous permission decisions** (#496): the daemon returns the verdict in
  the Claude Code hook response (`allow` / `deny`) instead of injecting `1`/`3`
  into the PTY. This fixes the parallel-subagent leak (a subagent's prompt could
  leak to the app and strand the pending list) and the `Cancelled stale eval`
  dropped-decision races. The auto-approve eval now blocks Claude until it
  returns (well under the hook timeout); the permission-groups fast-path keeps
  the common case instant.
- Default auto-approve model is now `qwen3.5:4b` (fast, RAM-light across
  platforms); heavier models belong in `escalate_model` (#522).

### Fixed
- Session binder no longer wedges on a stale lock: when a daemon restarts or
  attaches mid-session and adopts a dead session id, it now re-adopts the live
  session that owns its `remi:<port>` transcript marker instead of dropping its
  own hooks as "foreign" forever (#518).

## [0.6.4] - 2026-06-08

Auto-approve fixes (instruction-following + an Ollama transport seam) and a
terminal cue so escalations are visible without looking at the phone.

### Added
- Terminal cue for the auto-approve lifecycle (#513): an animated terminal-title
  status (spinner while the LLM evaluates, then a check when auto-handled or a
  warning when escalated) plus a desktop notification on escalation. Configurable
  via a new `[terminal]` section: `notify = "osc9"` (default; also `osc777`,
  `bell`, `off`) and `status_cue = true`. Written out-of-band to the terminal, so
  it never disturbs Claude's display; tmux-passthrough aware; inert when
  auto-approve is off or running headless.
- Optional Ollama-native transport for auto-approve (`auto_approve.disable_thinking`,
  default off): routes through `/api/chat` with reasoning disabled. Faster, but it
  lowers decision quality (the reasoning is load-bearing for following broad
  instructions), so it stays opt-in (#512).

### Fixed
- Auto-approve now follows the user's `instructions` over the built-in defaults:
  the guidance is framed as the primary authority and only the deny floor can
  override it, so a broad "approve everything except irreversible deletes" policy
  is honored instead of being silently escalated (#512).

## [0.6.3] - 2026-06-08

Epic #499: a single source of truth for the live Claude session, plus
subagent views.

### Added
- Subagent views (epic #499): the app can switch the displayed view to a
  subagent's chat. The daemon tracks each subagent the session spawns
  (deterministic transcript path `<main>/subagents/agent-<id>.jsonl`) and
  pushes a `session_views` message; the client surfaces each subagent as a
  read-only entry that loads its transcript through the normal flow (#502).

### Changed
- The TranscriptBinder is now the **default** session-binding driver (epic
  #499). It is the single source of truth for the live Claude session and was
  shadow- and real-Claude-validated as equivalent to the old path.
  `REMI_TRANSCRIPT_BINDER_ENABLED=false` is a kill-switch back to the old path
  until that path is removed (#503).

### Fixed
- Session source of truth (epic #499): the client no longer gets stuck on
  "Transcript for session X not found" after a daemon restart or `/clear`
  rotation. The daemon now answers a stale transcript request with its
  **current** session (`currentSessionId` / `currentClaudeSessionId` /
  `currentTranscriptPath`) instead of a dead-end `NOT_FOUND`, and always
  stamps `hello_ack` with the authoritative binding; the client follows that
  redirect (and the reconnect-mid-rotation adopt) by switching to the current
  session and auto-loading its transcript (#500, #501).

## [0.6.2] - 2026-06-07

A pass over the question -> auto-approve -> notification pipeline, plus a
duplicate-notification fix and CI automation.

### Fixed
- Duplicate APNS notifications: the output processor re-emitted the same
  on-screen prompt on every parse cycle (a fresh question id each time),
  flooding the notification pipeline. It now emits a question only on the
  rising edge (when the on-screen prompt actually changes), cleared when the
  agent leaves the `waiting` state (#486).

### Changed
- Auto-approve now buffers a permission prompt while the local LLM is
  evaluating it and pushes a notification **only when the verdict is
  escalate** (the user must answer). Auto-approved/denied permissions no
  longer fire a phantom push. Auto-approve remains opt-in (`enabled = false`),
  and read-only tools (`Read`/`Glob`/`Grep`) plus read-only `gh`/`git` queries
  are approved by default while remote mutations escalate (#482, #484).
- Question dedup is now per-agent, so a background subagent's prompt no longer
  suppresses the main agent's identically-worded one; ambiguous cross-agent
  prompts are surfaced without misattributed option labels (#483).

### Internal
- `auto-bump-dev` workflow: the `-dev.N` counter now increments automatically
  on every push to `develop` (version-only; no publish) (#479).

## [0.6.1] - 2026-06-05

### Changed
- Internal: the session-binding + transcript-watcher subsystem is unified
  into a single `TranscriptBinder` (epic #453). Ships **behind a feature
  flag, default off** (`transcript_binder_shadow` / `transcript_binder_enabled`)
  — no behavior change in the default configuration, verified at runtime
  against the old path. Includes a re-arming directory poll for no-hooks
  rotations, an extracted `QuestionPipeline` (notification dispatch +
  auto-approve gate), a no-cache `SessionBindingStore`, the four
  previously-unwired hook events (StopFailure, PostToolUseFailure,
  SubagentStart/Stop), and relay/telegram adapter silent-drop fixes
  (#459, #462, #464, #466, #468, #471, #472).

### Fixed
- `sessions.json` write now uses a per-process temp path, fixing a
  multi-writer race where two daemons starting in the same `~/.remi` could
  crash one on the atomic rename (#461).

### Internal
- Added a manual real-Claude e2e harness for the transcript-binding
  subsystem under `tests/e2e/transcript-binding/` (not wired into CI) (#475).

## [0.6.0] - 2026-06-04

Redesign + a sweep of session/transcript reliability work. Changelog
entries for 0.5.0–0.5.3 were not kept at the time; this section documents
the headline changes since the last documented release.

### Added
- iOS/web redesign: lime design system with bundled fonts (Inter Tight /
  JetBrains Mono), `StatusPill` + session-display helpers, redesigned
  sessions/chat/question-card screens, connect bottom sheet, settings
  reskin, and a generated app icon (light/dark/tinted) (#446, #448).
- Auto-approve multi-choice handling: skip-by-default with optional
  evaluation via an alternate model (#399); `permission_suggestions`
  accepts object-shaped entries (#417).
- PTY-presence question gate: questions are surfaced based on what is
  actually visible on the PTY, with keyed multi-question routing (#415,
  #418, #419, #441).
- iMessage-style reply: chat input is decoupled from the answer flow so a
  typed message is not hijacked by a pending question (#401).
- iOS edge-swipe back gesture from chat to the session list (#411).
- Daemon port-range scan when connecting by hostname with no port (#393).

### Changed
- Wire protocol carries `claudeSessionId` and `transcriptPath` end to end
  (`hello_ack`, `session_list_response`, `question`,
  `transcript_binding_changed`); the daemon refuses outbound answers with
  `STALE_BINDING` when the client's claimed binding no longer matches.
  New fields are optional and backward compatible (#429, #430).
- Session rotation on `/clear` and `/resume` is announced with a single
  atomic `session_rotated` message (replacing the former `session_reset`)
  so the client clears, rebinds, and re-fetches the transcript in one step
  (#443). **Upgrade note:** after updating the daemon, reconnect older
  mobile/web clients once — a pre-0.6.0 client will not act on
  `session_rotated` and may show a stale chat after `/clear`/`/resume`
  until it reconnects.

### Fixed
- Cross-daemon answer routing: two daemons in the same cwd no longer
  cross-route responses. Deterministic PTY→transcript binding via a
  pre-assigned `--session-id <uuid>` removes the mtime discovery race
  (#427, #428, #429, #430).
- Transcript-watcher start reliability: a leftover daemon whose Claude
  child has died no longer wedges a co-located session (`claudeChildPid`
  liveness + a `remi:<port>` transcript ownership marker), and a session
  whose fallback poll timed out before Claude wrote its transcript now
  self-heals its watcher on the next hook event (#451, #452).
- SessionEpoch reliability: prompt-chrome question detection, host-identity
  connection resolver, and reconnect-mid-rotation reconcile (#435, #440,
  #445).
- APNS/question fixes: no duplicate push within a prompt cycle, the
  default 3-option set never clobbers a richer pending question, and PTY
  questions the user can answer are no longer dropped by the
  subagent-context filter (#405, #407, #409, #413).
- CORS headers on HTTP endpoints so the iOS Capacitor app can scan ports
  (#403).
- Light-mode accent contrast and connect-landing fixes (#449, #450).

### Internal
- Auto-approve tests honor `SKIP_LLM_TESTS=1` (skip the Ollama-gated suite).

## [0.4.4] - 2026-03-20

### Added
- Per-command help: `remi ls --help`, `remi kill --help`, etc. show subcommand-specific usage (#115)
- `--orphan-timeout SECS` flag for configurable session cleanup; 0 disables automatic cleanup (#120)
- `SESSION_BUSY` error with clear message when attaching to a session already in use (#119, #121)

### Fixed
- `remi start` fails with EADDRINUSE when wrapper sessions are running (#114)
- Only retry WebSocket adapter on port conflict, not all adapters
- Deduplicate sessions from LAN and VPN IPs in `remi ls --network` (#118)
- SESSION_BUSY check moved before canResume guard (was unreachable) (#121)
- Kill session with active client now notifies the attached client before disconnect (#119)

## [0.4.4-dev.3] - 2026-03-20

### Fixed
- `remi start` daemon lifecycle: port probing, REMI_PORT env stripping, EADDRINUSE retry (#114)

## [0.4.4-dev.2] - 2026-03-20

### Added
- CLI help redesigned with grouped use cases (Quick Start, Remote Access, Session Management, Service, Identity & Auth) and subtle ANSI color (#101)
- NO_COLOR env var and non-TTY pipe detection for color suppression

### Fixed
- Session names no longer truncated at 26 chars; name column adapts to terminal width (#100)
- NO_COLOR test cleanup bug (was setting string "undefined" instead of removing env var)
- Added missing options to help text (--no-mdns, --no-tofu, --force, --max-bullet-length)

## [0.4.4-dev.1] - 2026-03-20

### Added
- Dev release workflow: `bump-version.sh dev` creates prerelease versions (0.4.4-dev.1)
- Release pipeline detects -dev tags: publishes to npm @dev, GitHub prerelease, skips Homebrew (#98)

## [0.4.3] - 2026-03-20

### Added
- Universal remote target resolver: `host:port/session` format works for attach, kill, and detach (#96)
- `remi new /path` treats positional path-like args as `--dir` shorthand
- `isPathLike()` detection for /, ~/, ./, ../, and bare `.`

### Fixed
- `remi kill host:port/session` now works (was sending create instead of kill) (#89)
- REMI_PORT env var respected for attach/kill/detach (was regression)
- `remi attach localhost:port` correctly uses specified port for auto-attach
- Dead code cleanup in target resolver (colonIdx null check)

## [0.4.2] - 2026-03-15

### Added
- Extracted arg parser into testable `parseArgs()` function with 93 unit tests (#87)
- Standard Unix `--` separator support for all subcommands
- Input validation: port range (1-65535), missing flag values, mutual exclusion
- Docker integration test infrastructure (2 daemon containers, 13 tests)
- `.dockerignore` to reduce Docker build context
- CI triggers on push/PR to develop branch

### Fixed
- `remi new --host X`, `remi new --dir /path`, `remi new --recent` now work (arg parser break bug) (#87)

## [0.4.1] - 2026-03-14

### Changed
- `remi ls --network` groups sessions by machine hostname instead of per-daemon headers (#85)
- PORT column replaces HOST column in grouped output
- Single-machine summary: "N session(s) on machine-name"
- Composite grouping key prevents merging different machines with same hostname

## [0.4.0] - 2026-03-14

### Added
- Session history protocol: `session_history_request`/`session_history_response` with `RecentDirectory` type (#83)
- `remi recent` command: browse recent project directories (local and remote)
- `remi new --host <ip>`: create session on remote daemon and auto-attach
- `remi new --dir <path>`: start session in specific directory
- `remi new --recent`: interactive directory picker from session history
- `remi kill <name>`: kill a session by name or ID
- `remi detach [name]`: detach from session (stub, Ctrl+B d for interactive)
- Web app: recent projects section in session list with start buttons
- `--dir` and `--recent` mutual exclusion with clear error
- Branch strategy documentation (main/develop/feature branches)

## [0.3.16] - 2026-03-14

### Fixed
- `remi ls --host` probes all ports and suppresses session-creation noise (#81)
