# Changelog

All notable changes to Remi are documented here.

## [Unreleased]

### Added
- **macOS app lifecycle polish** (#651, epic #648): "Open Remi at Login"
  menu toggle (SMAppService; independent of the hub's LaunchAgent), a
  copy-install-command menu item when no hub is running, and
  `docs/MACOS_APP.md` documenting the attach-only design — window close and
  app quit never touch the hub daemon; stopping it stays `remi stop` (a
  protocol-level stop is #747, blocked on #535).
- **Menu-bar icon states** (#650, epic #648): the rounded-square "r" now
  encodes live hub state from the `hub_status` census — thin outline (idle),
  bold "r" (local client attached), filled square with knocked-out "r"
  (remote client connected), dimmed when the hub is unreachable. Vector
  template assets (light/dark tinting) generated from SVG sources in
  `packages/macos/design/`; the menu shows a client-count line.
- **macOS menu-bar app shell** (#649, epic #648): `packages/macos/` — a
  sandboxed, attach-only SwiftUI accessory app (`MenuBarExtra` + window)
  hosting the existing web UI in a WKWebView over a bundled
  `remi-app://localhost` origin. Discovers the local hub by port scan,
  connects query-mode (never counted as a client), and injects the hub URL
  into the web app via `window.__REMI_NATIVE__`. Closing the window or
  quitting the app never touches the hub daemon (#651 groundwork); the app
  cannot stop the hub by design (sandbox; use `remi stop`). Build via
  `bun run build:macos-web` then Xcode; tests in `RemiTests` (real-hub
  integration gated on `TEST_RUNNER_REMI_TEST_BINARY`).
- **`hub_status` census broadcast** (#650, epic #648): hub-mode daemons now
  tell every client how many local and remote (non-query) clients are
  connected and how many child session daemons are live — the data source
  for the upcoming macOS menu-bar icon state. Sent to each connection right
  after its `hello_ack` and broadcast on every change; query clients
  (`remi ls`, the menu-bar app) receive it but are never counted.
- **Stale-daemon version drift surfaced** (#539, epic #648 phase 2): daemons
  hold their binary for life, so an upgrade silently leaves running daemons
  on old code. Every daemon now stamps its binary version into its
  live-sessions entry, status file, and connection-time `hello_ack`
  (`daemonVersion`); `remi ls` prints a per-daemon "runs remi vX; installed
  binary is vY — restart to apply" warning and `remi status` shows the hub's
  version with the same drift warning.
- **Session-less hub: `remi serve`** (#542, epic #648 phase 1): a supervisor
  daemon that binds a port (18765 preferred, 20-port probe, `--port` to
  override), serves the machine's session list, and spawns
  child session daemons on demand — without ever launching Claude itself. A
  session-less daemon now answers `hello` with `hello_ack{sessionId: null}`
  instead of a `NO_SESSION` error, and the live-sessions watcher (previously
  wrapper-mode-only) broadcasts newly spawned sibling daemons in all modes.

### Changed
- **`remi start` now launches the hub** instead of a one-session daemon: no
  more junk conversation in the app from starting a daemon. Sessions are
  created from the app or `remi new`. `remi stop` stops only the hub; running
  session daemons keep serving.
- **`--install` LaunchAgent/systemd runs `remi serve`** via the PATH-resolved
  `remi` binary (survives brew upgrades), with `KeepAlive.SuccessfulExit=false`
  so `remi stop` is not resurrected by launchd while crashes still restart.
  Existing installs keep the old behavior until `remi --install` is re-run.
- The hub self-writes `~/.remi/daemon.pid` (launchd-started hubs are now
  visible to `remi stop`/`status`), and `daemon-status.json` now belongs
  exclusively to the hub: every session daemon (hub-spawned or a manually
  run `remi --daemon`) writes a per-port `status-<port>.json` instead of
  racing the hub for the shared file.

## [0.6.18] - 2026-07-07

A hardening release: no new surface area, but a long soak (agent-team sessions,
live push delivery, multi-daemon reconnects) turned up a cluster of real bugs in
the 0.6.16/0.6.17 machinery, all fixed here.

### Added
- **Dynamic lock-screen action titles** (#719): a 2-4 option question push now
  shows its REAL option labels as lock-screen action buttons (e.g. "Yes, always
  allow: git push"), not generic Yes/No, via a Notification Service Extension
  that registers a category per notification.
- **Structured permission-suggestion handling** (#718): Claude Code's structured
  `permission_suggestions` (addRules/setMode/etc., current CC versions) are now
  parsed into real option buttons instead of being dropped into a fabricated
  3-option Yes/"Yes, always"/No card. Two-option prompts show an honest Yes/No;
  "Yes, always allow: ..." echoes the real permission-update entry back to
  Claude, so it actually persists the rule.
- **Message ack + queued indicator** (#663): the client now tracks per-message
  delivery (sending -> sent -> delivered -> failed with tap-to-retry) instead of
  assuming every send lands; a queued/read-only banner reflects `hello_ack`
  attach state.
- **Apple Watch can actually answer** (#665): mirrored lock-screen actions
  no longer require an unlock the Watch can't satisfy — auth is now required
  only on standing-grant actions ("Yes, always"), not one-shot Yes/No/option
  picks. A cold background launch (Watch tap with the app never opened) now
  installs the native answer relay instead of silently dropping the tap, and
  a failed relay leaves a visible "Answer not delivered" notification instead
  of failing invisibly.
- **iOS TestFlight via local upload** (#659): `scripts/testflight-ios.sh` mirrors
  yooz-Whisper's local archive/export/upload path; own app version line synced
  via `sync-app-version.mjs`.
- **Process-level error guards** (#534 minimal slice): unhandled rejections are
  logged and the daemon keeps serving; uncaught exceptions run cleanup then
  exit(1) so a supervisor (launchd/systemd) restarts it, instead of the process
  silently going dark.
- **Log rotation** for `remi.log` / `daemon.log` at 10MB (rotate-before-open,
  2 generations kept).

### Changed
- **Auto-approve eval queue is scoped per session** (#730): a session ending or
  answering no longer drains or cancels a DIFFERENT session's queued
  evaluations; team bursts across sessions stop competing for one shared slot.
- **Stop spares live teammates** (#711): a lead agent's `Stop` no longer
  releases every held permission hook as passthrough — only the lead's own
  holds/evals are cancelled, so a still-working teammate's pending "needs you"
  card stays honest instead of flipping to a phantom auto-release.
- **Foreign-session admission is fail-safe** (#672): a Claude session Remi
  doesn't recognize now gets a proper auto-approve/escalation path (sibling
  daemon check, then evaluate-or-escalate) instead of being silently dropped.
- **Same-device lock reclaim is bound to a client fingerprint** (#671):
  closes a spoofable-`deviceId` gap in the #662 reconnect-eviction path.
- **Sticky active session selection** (#688): the web client no longer
  silently swaps the active session to an unrelated one on a racing
  `hello_ack` or reconnect.
- Heartbeat margin widened and reconnects staggered (#664, #685) so multiple
  daemon connections going stale at the same tick don't thunder-herd.
- APNS device tokens are unregistered when a server is removed from the app
  (#690), instead of continuing to push forever.

### Fixed
- Subagent-context tracker leak that could silently deny the MAIN agent's own
  escalations (including `AskUserQuestion`) during team runs (#710).
- PTY-only prompts (native team-permission UI, MCP elicitation) that reached
  no hook were dropped instead of pushed (#712).
- In-app question cards flickering (vanish/reappear) and giving no trace of a
  lock-screen answer (#652).
- `AskUserQuestion` auto-answer rejecting a valid answer when an option label
  contained a comma (#654); multi-select's keystroke plan not matching the
  real TUI, leaving forms stuck mid-submit (#661); auto-answer failing on any
  review screen that partial-repaints instead of redrawing (#677).
- Dismiss-push 429s under multi-session bursts, from a too-low shared rate
  limit (#723); dismissals now retry with backoff and prune dead tokens.
- A held escalation that times out unanswered now sends a delivery-aware
  "answer in the terminal" handoff push instead of silently falling through
  to a passthrough terminal prompt with nothing on the phone (#733).
- Question pushes showing no banner or sound when the app was foregrounded,
  including via iPhone Mirroring (#734).
- A dead connection (no clean close) holding a session's write lock forever,
  silently dropping every subsequent input (#662).
- Recent-projects list not tappable on touch (#656); unnormalized tilde
  paths and inconsistent `projectPath` values breaking `--resume` (#674,
  #680); rotation dir-poll staying disarmed after a transient read failure
  (#676); duplicate `localhost`/`127.0.0.1` connection entries confusing the
  error banner (#682); unconfirmed/failed sends dropped on a rebind instead
  of staying retryable (#687); ack sent before the read-only check could
  reject it, leaving no error trace (#681); an auto-approve verdict racing
  ahead of a permission already resolved elsewhere (#673).

## [0.6.17] - 2026-06-28

Remote sessions now outlive the connection: disconnecting no longer kills the
session you created, ending one is a clean `/exit` that frees its daemon, and
starting one picks from your recent paths instead of a blind text prompt.

### Added
- **Persistent remote sessions** (#637): a session created from the app survives
  client disconnect instead of being killed by the orphan timeout. A new
  `daemon.persist_sessions` config (default on) detaches the session on
  disconnect and leaves it re-attachable; `pty_exit` and forced closes still
  apply. This is the whole point of a remote session — start it from your phone,
  walk away, reconnect later.
- **Recent-paths new-session sheet** (#638): the "+" button opens a bottom sheet
  of your recent project directories to start a session in, replacing the bare
  `window.prompt` path entry. Pick a recent path or type a new one; surfaces the
  same recent-directory data the CLI already exposes, so you always know the
  exact path you are starting in.
- **Exit session control** (#641): a per-session control (session row + chat
  menu) that ends a session by typing a graceful `/exit` on its PTY so Claude
  quits cleanly — flushing its transcript and printing its resume hint — with an
  8s force-close fallback if Claude ignores it. The daemon frees its port when
  its session ends, so no session-less daemon is left behind. Labeled "Exit
  session", distinct from the input-area Esc "Stop".

### Fixed
- A remotely-created session dying the instant its client disconnected — the main
  reason remote sessions felt disposable.
- A session-less "phantom" daemon lingering on its port after a session ended.

## [0.6.16] - 2026-06-27

Question-pipeline rework (epic #624): the auto-approve gate is the single
authority for what reaches your phone — killing phantom permission
notifications — and the new `AskUserQuestion` format is shown and answered
properly on a remote session.

### Added
- **Structured AskUserQuestion display** (#626): the full set of sub-questions —
  topic headers, per-option descriptions, and multi-select — flows from the hook
  to the client and renders as a real form, instead of collapsing to the first
  question with bare labels. The lock-screen push summarizes the question scope.
- **Multi-question answer + submit** (#627): a remote answer drives Claude's
  interactive AskUserQuestion terminal UI (built from live captures), verifying
  the review screen before submitting so it never submits the wrong answer. A
  **Cancel / Esc control on every question card** is the universal unstick — it
  escapes any prompt the app can't drive, so you are never stuck on a blocked
  Claude. Built-in env-gated PTY capture (`REMI_PTY_CAPTURE`) to re-verify the
  keystroke model when Claude Code's renderer changes.
- **Natural lock-screen summaries** (#628): on a generic escalation the deciding
  LLM also returns a one-line, plain-language question ("Force-push to main?")
  shown on the push instead of the raw "Allow Bash: <command>" — folded into the
  existing decision call, no added latency.
- **Escape from the chat input** (#627 review): long-pressing the send button opens
  a Stop dialog that sends a bare `Esc` to the session — interrupting Claude's
  running work or dismissing an on-screen prompt at any time, not only from a
  question card. One control (the send button), confirmation-gated so it can never
  fire accidentally, and reachable even while the input is empty.

### Changed
- **One gate, escalate-only** (#625): a question reaches your phone if and only if
  the auto-approve verdict is `escalate`. Approvals and denials are silent. The
  PTY screen-scraper no longer emits questions for hooked sessions — it was
  echoing prompts the gate had already auto-approved, the source of the phantom
  notifications (live logs showed 1,100+ pushes fired right after a 0 ms approve).

### Fixed
- Phantom permission notifications for actions the LLM/rules had already approved.
- AskUserQuestion prompts whose options/context were lost or answered incorrectly
  on the phone (the old single-digit path could not express the new tabbed form).

Notification-delivery robustness (epic #603): escalations reliably reach the
lock screen, a manual answer frees the GPU, dead device tokens self-heal, and
push works across mixed APNS environments.

### Added
- **`remi unstick [port]`** (#617): a force-release escape hatch for when an
  auto-approve eval and a held question get wedged. Each daemon releases its held
  permission hooks to the native terminal prompt, aborts the in-flight Ollama
  eval, and drains the eval queue. With no port every running daemon is unstuck;
  with a port, only the daemon on that port.
- **Persistent device-token registry + dead-token pruning** (#615): device
  tokens persist in `~/.remi/device-tokens.json` (atomic, multi-daemon safe), and
  a token APNS permanently rejects (`BadDeviceToken` / `Unregistered`) is pruned
  instead of being retried forever.
- **Per-identity push budget + dismiss isolation** on the signaling Worker
  (#605), replacing the shared per-IP limit that silently dropped pushes for
  multiple daemons behind one NAT.

### Changed
- **A manual answer now frees the Ollama GPU** (#617): each eval is tracked by id
  so an answer cancels exactly that question's eval (running, or dropped while
  still queued under contention) and never another permission's. Every answer
  path (held, passthrough, relay, stale) cancels its own eval, and answering one
  question no longer fails the session's other holds open.
- **Held escalations are delivery-gated** (#604): a hold whose notification is
  not confirmed delivered fails open fast to the terminal instead of blocking
  Claude for the full hold window. New config `delivery_confirm_timeout` and
  `hold_unconfirmed_timeout`.
- **Held escalations always reach the lock screen** (#606): they bypass the
  cosmetic dedups and push even when a client is attached-but-backgrounded, and
  the hold fails open fast if the push fails.

### Fixed
- **Push works across mixed sandbox + production APNS tokens** (#618): the
  signaling Worker tries the preferred environment first and retries the other on
  a `BadDeviceToken` mismatch, so a device whose token environment differs from
  the global flag still receives pushes — and dismissals, so a resolved
  question's lock-screen card clears instead of lingering.
- **APNS sandbox gate tolerates a whitespace-padded secret** (#613).
- **Cold-start answers never route to the wrong daemon** (#612): with multiple
  daemons and no per-session URL, the answer resolver returns unreachable instead
  of guessing.

## [0.6.14] - 2026-06-19

The iOS client side of native lock-screen permission answering, and correct
question text + options for plan/design escalations.

### Added
- **Native lock-screen answer** (#591 P2): the iOS app answers a held permission
  from the lock screen WITHOUT opening — a notification action is signed
  (Ed25519) and POSTed straight to the daemon's `/answer` endpoint, then
  forwarded to the in-app handler so the foreground path still works. Builds on
  the #591 P1 relay backend (0.6.13). The signer + per-session daemon URL are
  bridged to native storage via `@capacitor/preferences`; only an unencrypted
  identity is bridgeable, and a stale route is dropped on session eviction.

### Fixed
- **AskUserQuestion / ExitPlanMode escalations show the real question + options**
  (#597): these were surfaced as the generic "Allow <tool>" + Yes / Yes, always /
  No on both the in-app card and the lock-screen notification, because the
  question builder read only `permission_suggestions`. The daemon now extracts
  the real question text + option labels from the tool's `tool_input`
  (AskUserQuestion `questions[0]`; ExitPlanMode's standard plan-approval set) and
  emits them as picks, so answering selects the intended choice. Whitespace is
  collapsed so a multi-line question no longer renders as a run-together string.
  ExitPlanMode option order is reverified per Claude Code release (#598).

## [0.6.13] - 2026-06-19

Backend for native lock-screen permission answering, and a fix for subagent
permissions silently bypassing auto-approve.

### Added
- **Phone -> daemon answer relay (backend)** (#591, part of #575): the signaling
  Worker gains a `POST /answer/{code}` reverse route that forwards a permission
  answer into the daemon's room WebSocket, and the daemon accepts a
  self-authenticating (Ed25519-verified) relayed answer that needs no live
  WebSocket peer. This is the groundwork for answering a held permission from the
  iOS lock screen; the native handler that calls it lands separately (#591 P2).

### Fixed
- **Subagent permissions now reach auto-approve** (#593): a parallel/team
  subagent's PermissionRequest (which can carry a different or empty session_id)
  was dropped before the auto-approve gate when the transcript marker was not yet
  readable, so it was never evaluated and never showed an "evaluating" status.
  The binder now admits a subagent that owns the bound transcript via two
  file-free checks (exact path match, or the transcript being named after the
  bound session id), robust to a still-settling binding; sibling daemons'
  subagents stay isolated. A previously-silent "not admitted" drop is now logged.

### Note
- The lock-screen answer relay needs a Cloudflare signaling worker redeploy to
  expose the new `/answer/{code}` route; without it nothing breaks (the route's
  only caller is the not-yet-shipped native iOS handler, #591 P2).

## [0.6.12] - 2026-06-18

The biggest auto-approve UX change: escalated permissions are now held on the
hook and answered via the hook response (Model B), delivered and presented
faithfully, and the local model never decides design/plan questions (epic #571).
Plus a fix for a multi-host reconnect storm.

### Added
- **Hold the hook (Model B)** (#573): a binary permission the local model
  escalates HOLDS its `PermissionRequest` hook open and is answered via the
  `allow`/`deny` hook response — no PTY digit, no render race, no dependence on a
  warm socket. A long human-paced `auto_approve.hold_timeout` (default 1800s)
  fails open to the native prompt; a slow-eval fallback push fires at
  `auto_approve.push_hold_timeout` (default 60s). Holding only engages when
  auto-approve is on.
- **Never auto-decide design / plan-mode / long-form questions** (#572):
  `AskUserQuestion`, `ExitPlanMode`, and non-binary questions escalate to the
  user before the LLM, at zero latency. New `auto_approve.always_escalate_tools`.
- **Faithful notification** (#574): notification text comes from the hook
  (no more run-together "Doyouwanttoproceed?"); the real option labels are shown.
- **Connection-independent answer relay** (#575): a daemon `POST /answer`
  endpoint (same auth as the WebSocket) lets a tapped answer reach the daemon
  without a warm WebSocket; the iOS app gets a `content-available` pre-wake and
  a longer, fail-fast answer deadline.
- **Responsive status** (#576): `evaluating` / `approved` / `starting` states,
  the blocked-on-you state surfaces distinctly, and a faster status bar.
- **Cross-client question dismissal** (#585): answering on one device (or an
  auto-resolve, or `/clear`) dismisses the card on every client and clears the
  lock-screen push; duplicate device tokens are de-duplicated.

### Fixed
- **Held escalations now reach the phone** (#573): a held binary escalation was
  registered/pushed only on a PTY render that a held hook prevents, so it could
  sit unanswerable until the hold timeout — now pushed immediately.
- **Recurring "Transcript for session not found"** (#577): a durable
  transcript-index, client-side eviction of dead cached sessions, and a longer
  first-transcript fallback window.
- **Multi-host reconnect storm** (#586): `WebSocketClient` reset its reconnect
  backoff on transport-open (before auth), so any open-but-fail connection
  looped at ~1s forever and never escalated; the reset now happens only on a
  fully-established connection.

### Note
- The `content-available` pre-wake and the dismissal/collapse-id pushes require a
  Cloudflare **signaling worker redeploy** to take effect; without it they
  degrade gracefully to 0.6.11 push behavior.
- Native iOS Live Activities / Notification Service Extension are tracked
  separately (#575) and are not part of this release.

## [0.6.11] - 2026-06-11

A persistent remi status bar on the terminal's last row, visible even while
Claude shows a permission prompt — exactly when the native status line is hidden.

### Added
- **Reserved-row status bar in wrapper mode** (#565): remi reports `rows - 1` to
  Claude and pins the terminal's scroll region to the rows above, so it owns the
  bottom row exclusively and draws `remi:<port> <repo>:<branch> | <clients> |
  <state>` there. The auto-approve cue (`evaluating <N>s` / `needs you`) stays
  visible during prompts, when Claude's own status line is covered. Wrapper +
  real-TTY only; on by default, off-able via `terminal.status_bar` (or
  `REMI_TERMINAL_STATUS_BAR=false`). The native status line drops its remi prefix
  while the bar is active to avoid a duplicate line.

## [0.6.10] - 2026-06-11

The Claude Code status line now shows what auto-approve is doing, so you can tell
whether to wait (still deciding) or that a permission needs you — useful when a
heavy local model takes tens of seconds.

### Added
- **Auto-approve eval state in Claude's native status line** (#560): the status
  segment shows `evaluating <N>s` while a permission is being decided, `needs you`
  after an escalate, `approved` briefly after a silent approve, else Claude's
  agent status. Driven by a per-daemon in-flight count, so concurrent evals
  (parallel subagents, multiple sessions) can't get it stuck.

### Fixed
- Status line no longer prints a stray space in `remi :<port>` — now `remi:<port>`.
- Retired the shared title-bar auto-approve spinner, which could get stuck showing
  "evaluating" with the model idle when concurrent evals interleaved its
  start/stop. The status-line cue replaces it.

## [0.6.9] - 2026-06-11

Stops auto-approve from dropping correct verdicts when the eval is slow. With a
heavy local model the daemon would compute "approve" but the decision never
reached Claude in time, so you ended up hand-approving safe commands. Two causes,
both fixed.

### Fixed
- **PermissionRequest now waits for the verdict** (#537): Remi registered every
  Claude Code hook with a blanket 5-second timeout, so Claude gave up waiting and
  showed its own prompt before a 5-20s local-model eval could answer. The
  PermissionRequest hook now gets a long timeout (600s, covering the eval +
  serialization-queue budget) while every other hook keeps the short fail-fast
  timeout so a slow or dead daemon never gates worktree creation, prompt
  submission, or compaction. `install()` reconciles an existing hook's timeout in
  place, so the fix applies on the next daemon start. (This is why
  `auto_approve.timeout` alone didn't help: that bounds how long the eval *runs*,
  not how long Claude *waits*.)
- **A previous tool's PostToolUse no longer drops the next decision** (#537):
  `PreToolUse`/`PostToolUse` no longer cancel an in-flight auto-approve eval.
  Under synchronous decisions Claude blocks on the prompt, so the running eval is
  the verdict it is waiting for — only `Stop`/`SessionEnd` (a real session end)
  cancel an eval now.

## [0.6.8] - 2026-06-10

Fixes the auto-approve regression where permissions piled up as questions
whenever the model was busy. The evaluator was single-flight: any permission that
arrived while another evaluation was already running escalated to the user with
no model decision at all. During a burst (parallel subagents, fast tool
sequences) or whenever the GPU was occupied with a slow model, this produced a
flood of escalations even though the model's decisions were fine.

### Fixed
- **Concurrent permission evals now serialize instead of escalate-on-busy**
  (#551): evaluations run one at a time (one GPU); a request that arrives while
  another is in flight waits its turn and gets its own real decision rather than
  being escalated. The deny / allow / group fast-paths stay instant and are never
  queued.

### Added
- **`[auto_approve] queue_timeout`** (seconds, default 240; `0` = no bound): the
  maximum a permission may wait in the serialization queue before escalating
  gracefully, so a deep burst can never push a request toward the Claude Code
  hook budget. Configurable via `REMI_AUTO_APPROVE_QUEUE_TIMEOUT`; shown in
  `config show` and the startup banner.

## [0.6.7] - 2026-06-10

Makes auto-approve actually work with reasoning-tuned local models. A model that
wraps its verdict in a markdown code fence (notably `qwen3.6:35b-mlx`, which
fences every response) was escalating 100% of its decisions on formatting alone:
the parser did a strict `JSON.parse` of the raw text, choked on the leading
backtick, and fell back to "ask the user" even when the model had clearly
approved. This release makes the parser tolerant and tunes the heavy
second-opinion tier so it can actually answer.

### Fixed
- **Fenced-JSON verdicts are now parsed, not escalated** (#533): a deterministic,
  string-aware extractor strips a `` ```json `` code fence or a short preamble
  and parses the inner object, wired into both the binary decision parser and the
  multi-choice parser. Free text still escalates (no keyword guessing), and a
  top-level array still escalates rather than having an inner object lifted out as
  the verdict, including when the array follows a preamble or sits inside a fence.
  The model sweep for `qwen3.6:35b-mlx` went from 25/38 to 37/38 with no code
  change other than this parse fix.

### Added
- **Dedicated `escalate_model` timeout** (`[auto_approve] escalate_timeout`,
  seconds; `0` = reuse `timeout`): the heavy second-opinion model is usually cold
  and needs a longer budget than the fast model, so it no longer degrades into a
  timeout-then-escalate.
- **Second-opinion model warm-up**: on Ollama, the daemon pre-loads
  `escalate_model` at startup (best-effort, `keep_alive` 30m) so the first
  escalation isn't a cold start.
- The startup banner now logs `escalate_model` and `escalate_timeout`, so a
  configured second opinion is visible in the log.

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
