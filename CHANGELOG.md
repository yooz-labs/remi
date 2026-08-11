# Changelog

All notable changes to Remi are documented here.

## [Unreleased]

## [0.7.6] - 2026-08-11

Closes a P0 that shipped in every release to date: the daemon bound `0.0.0.0`
with auth resolving to off, so any host on the LAN could approve a pending
permission prompt — arbitrary tool execution on the developer's machine — or
type into the live Claude session. **The default is now loopback, and that
breaks LAN direct, Tailscale direct and mDNS discovery until you opt back in**
(see Breaking). Alongside it, this release's adversarial pass found a second
P0-class bypass in *shipped* `scratch` code, the deny floor stopped being blind
to any command tool not literally named `Bash`, deletion of provably-derived
artifacts is now approved deterministically instead of costing ~3.5s of GPU and
a human interruption, Linux gets a working eval backend, and the status bar no
longer freezes for as long as you deliberate.

### Breaking
- **The daemon binds `127.0.0.1` by default** (#880, #1046, [ADR 0024]). Was
  `0.0.0.0`. LAN direct, **Tailscale direct** and mDNS discovery stop working
  until you opt in with `bind` in `config.toml` or `--bind`; SSH tunnels and the
  relay are untouched. mDNS does not refuse — it stops advertising, so the
  daemon *disappears* rather than erroring, which is the confusing half.
  `tailscale serve` is **not** the workaround: it is a same-host reverse proxy,
  so every tailnet peer arrives as `127.0.0.1` and inherits the loopback auth
  exemption (#869). Installs that already materialized `bind = "0.0.0.0"` via
  `remi config init` keep the old behavior — a value on disk beats a changed
  default — and nothing breaks to make them look, so the boot warning is their
  only signal. It now names the exact remedy, and is emitted with
  `console.error` — deliberately **not** `logError`, which at that point in
  module init routes to a `writeToLog` that is still a no-op until
  `startLogFileSession` runs ~490 lines later, so the message would go nowhere
  (#1043).

### Fixed
- **P0: any LAN host could drive the daemon** (#880, #1046, [ADR 0024]). Five
  defaults composed into an unauthenticated remote-control surface: the
  wildcard bind, `auth.enabled = "auto"` resolving to `false` on every bind, a
  missing authenticator letting a bare `hello` reach `connected` so `answer` /
  `user_input` route straight to the handler map, an Origin gate that admits the
  absent Origin a non-browser client sends, and mDNS advertising the port.
  Verified against live daemons: `/auth-info` returned
  `{"authRequired":false,"fingerprint":null}`. `"auto"` is deliberately **not**
  made bind-aware — that alone is insufficient, because `cli.ts` builds the
  Authenticator with `tofuMode: 'auto-accept'` unless `--no-tofu`, making
  auth-on-a-network-bind first-comer-wins *and* persisting the unknown key. That
  fix belongs with the phone pairing flow.
- **P0-class: a `cd` option was read as a directory** (#1047, #1048). `cd` treats
  any leading-dash token as options, so `cd -P`, `cd -L`, `cd --` and `cd -LP`
  have **no operand** and go to `$HOME` (verified in bash on darwin 25.6). Both
  cwd models rejected only the exact string `-`. In shipped, live-at-`balanced`
  `scratch` code, `-P` was tracked as a *subdirectory name*, so the tracked cwd
  stayed under the proved root while bash had left for `$HOME`:
  `cd /tmp/work && cd -P && rm -rf out` approved at 0ms and deleted `~/out`.
  Found by the adversarial pass required by [ADR 0023], which reported `scratch`
  as failing safe here — checking that rather than accepting it is what found
  the live half.
- **The owner union silently discarded `fs-write`'s sensitive-destination veto**
  (#1048). `matchGroups`' first-registrant-wins → union rewrite fixed a real
  non-monotonicity, but the union was disjunctive over **vetoes** too: for the
  five prefixes owned by both `fs-write` and `scratch` (`cp`, `mv`, `mkdir`,
  `touch`, `tee`), scratch's laxer proof discarded fs-write's veto at
  `balanced` — `cp /tmp/a /tmp/.env` went from escalate to `scratch:cp` at 0ms.
  Now `segmentTouchesSensitivePath` is checked before any owner's proof, for a
  new `MUTATING_GROUPS` set; scoped to mutating groups because reading a
  sensitive path is what `read-only` exists to allow. This narrows `scratch`
  slightly beyond the old scratch-alone behavior (a genuinely disposable
  `/tmp/.env` now escalates) — deliberate, and `config.ts`'s documentation of
  the old carve-out is corrected in the same change.
- **The deny floor and risk ceiling ignored every command tool not named `Bash`**
  (#1020, #1046). `classifyRisk('terminal', {command: 'rm -rf /'})` returned
  `moderate` — the tier plain conversation text can supply — and
  `matchesCatastrophicPattern` returned `null`, leaving `enforceDenyFloor`
  nothing to stand on, so #976's "critical never approves, at any
  authorization" did not apply. Both sides now gate on the **input shape** via a
  shared `extractToolCommand`, not a tool-name list (a list cannot be complete —
  an MCP server can register a command-carrying tool under any name). Measured
  against `hook-diag.jsonl`, no tool but `Bash` carries a `command` field, so
  this was **latent, not live**. `precedent.ts`'s stale justification is
  corrected in the same change.
- **The free-port probe asked about the wrong host** (#1046). It defaulted to
  `0.0.0.0` while every caller listened on `daemon.bind`; the two agreed only
  because that config default was also `0.0.0.0`. A live bug for anyone already
  setting `bind = "127.0.0.1"`: on BSD a wildcard probe **succeeds** on a port
  another process holds on loopback, so the probe reports "free" and the real
  bind dies on `EADDRINUSE`. `bindHost` is now required on `isPortAvailable` /
  `findAvailableTcpPort` / `findAvailablePort` — there is no safe default, only
  "the host you are about to listen on". The hub test harness had the same
  mismatch, and it was not cosmetic: the rival hub died on `EADDRINUSE` before
  reaching the PID-file guard, so the #542 split-brain test had silently stopped
  testing #542.
- **The status bar froze for as long as a question was pending** (#1038, #1039,
  [ADR 0022]). `status-bar.ts` returned early while any question was live, with
  no upper bound, so a prompt a human sits on for ten minutes froze the row for
  ten minutes — usually on `needs you`, a cue contractually bounded at 60s. The
  freeze was subsumed by `PtyQuiescenceGate` the same evening it landed but never
  removed, and shipped in v0.7.4 and v0.7.5. Liveness is now bounded by
  `HEARTBEAT_MS` (~2s) and may never depend on the PTY going quiet — the case
  that most needs a live bar is exactly the case where it never does, because
  Claude's TUI spinner keeps animating while a permission is held.
- **`no clients` while a phone was attached** (#1039). No attach or detach path
  called `update()`, so attaching changed nothing visible until an unrelated
  status change flushed — hitting all four consumers of the shared snapshot
  (reserved-row bar, `status-<PORT>.json`, remote attach client, `remi_status`).
  Now `SessionRegistry.onAttachStateChanged` fires from the only two lines that
  mutate `attachedConnections`, so it is total over every attach path by
  construction, with no timer and no lag.
- **The eval model id was MLX-only on every platform** (#822, #1042).
  `auto_approve.provider` was platform-resolved but `auto_approve.model` was
  not, so Linux got an id llama.cpp cannot load. Adds `defaultModel()`; Linux
  resolves to `YoozLabs/Qwen3.5-4B-qat-GGUF:Q4_0`, where the `:Q4_0` suffix is
  **load-bearing** (`-hf` defaults to `:Q4_K_M`, which the YoozLabs repos do not
  publish, so the bare repo id resolves no file). `config.test.ts` asserted the
  MLX id unconditionally and would have turned CI red on merge, since CI runs
  `ubuntu-latest`.
- **The prompt promised what the risk ceiling revokes** (#1040, #1042).
  `prompt-builder` told the model in three places that user guidance was
  mandatory and only the deny floor could override it — untrue since #976:
  `enforceRiskCeiling` takes no config and no authority, so it structurally
  cannot honor the "unless the user's own config says otherwise" clause, and any
  model `approve` at `high`/`critical` becomes `escalate` regardless. Handed
  that contradiction the model either explained why it was disobeying or obeyed
  and was overridden anyway — both costing a full LLM call to reach `escalate`.
  The prompt now says what ships. The strict prompt baseline fixture moves with
  it, deliberately and once.

### Changed
- **Deletion approves when the target is provably derived** (#1048,
  [ADR 0023]), amending #956's blanket "deletion escalates at every level".
  Measured on a live daemon, that rule was the single largest cost centre of the
  mechanism — 134 escalate vs 129 approve (51%), 123 of the 134 Bash — spending
  ~3.5s of GPU and a human interruption on deletions regenerable by a command
  the repo already runs (`rm -rf dist`, `rm -rf node_modules && bun install`,
  `git worktree remove --force …`). Covering them moves a cold replay of the
  real escalation population from 17/21 (81%) to 20/21 (95.2%). **The
  prompt-side rule is untouched** — deletion still escalates on every path that
  reaches the LLM, at every level; the amendment lives entirely in the
  deterministic layer. This is not a new kind of exception: `scratch` has
  deterministically approved `rm`/`rmdir` under a proved scratch root since
  #994, and this extends the proof from "under `/tmp`" to "at or under a
  directory whose exact name proclaims derived state".
- **`remi model` verbs refuse on single-model llama.cpp** (#822, #1042). Every
  verb but `use` targets the engine's `/v1/llm/*` control plane, which
  `llama-server` does not serve; they surfaced as opaque 404s from a server that
  was running and answering evals, and now refuse with the reason and the
  restart command. Relatedly, `llama-server` ignores the request's `model` field
  in single-model mode, so a configured `escalate_model` is answered by the
  **primary** model and reported as if a heavier one had agreed — the daemon now
  says so.
- **The decision log records the deciding layer** (#1042):
  `decided_by=model|deny_floor|risk_ceiling`. Previously that existed only in
  reasoning prose, so "why did this escalate" cost a paragraph to answer and
  could not be counted — which is how a 51% escalate config went undiagnosed.
  Diagnostic only; no control flow reads it back.

### Known open
- **The relay is unaffected by the bind change** (#881). Default-on, dials
  outward, and still plaintext through the Worker in rotating-code mode. Name
  the direction: outbound `sendRaw` refuses without session keys (a breakage),
  while inbound still accepts plaintext (the leak).
- **Any local process while `require_local_auth` is false** (#869) — including,
  via `tailscale serve`, every tailnet peer.
- **Installs with `bind = "0.0.0.0"` already on disk** keep the exposure (#880);
  the boot warning is the only signal.
- **A bare tool-name `allow` entry carries no destination veto** (#1032, carried
  forward from 0.7.5, not yet decided).
- **Two deletion-proof residuals, weighed and accepted** ([ADR 0023]): `--`
  end-of-options hides a dash-leading target from the proof, and a quoted `>`
  truncates the target the proof sees. Both are bounded to deleting a relative
  junk-named path whose spelling is constrained to flag-shaped tokens; neither
  reaches source, an absolute path, or code execution.
- **`bun install` in the artifact corpus is not lockfile-faithful** ([ADR 0023]).
  Only `--frozen-lockfile` guarantees that; bare `bun install` may resolve new
  versions, rewrite the lockfile, and run lifecycle scripts. It stays covered
  because it is the measured miss, but as a declared residual rather than a
  claim of inertness.

[ADR 0022]: .context/decisions/0022-status-bar-never-freezes.md
[ADR 0023]: .context/decisions/0023-artifact-deletion-is-proved-not-judged.md
[ADR 0024]: .context/decisions/0024-loopback-bind-default.md

## [0.7.5] - 2026-08-10

Closes two P0 holes in the deterministic allow-list, both the same shape: a
crafted quote desynced the shell splitter so a live command separator was read
as quoted text, collapsing an injected command into a segment that prefix-
matched a covered read — and the 0ms allow path approved the whole thing,
tail included. One rode an escaped quote (`\"`), the other bash ANSI-C `$'...'`
quoting; the second was found while adversarially reviewing the fix for the
first. Same class as #536. Alongside them: subagent permissions with a
deterministic verdict are now answered at hook time instead of parking, quoted
prose no longer trips the shell-control veto, and two smaller UX fixes.

### Fixed
- **P0: an escaped quote could smuggle a command past the allow-list** (#1031,
  #1033). `splitCompoundParts` tracked quotes but not backslash escapes, so an
  escaped quote outside quotes (`\"`) opened a spurious quote span and a live
  separator after it (`;`/`&&`/`||`/`|`/newline) was swallowed into one segment
  — hidden from the per-segment veto in `matchCoveredCommand`. A covered read
  prefix then approved the injected tail. Now backslash escapes are consumed so
  an escaped quote never toggles quote state.
- **P0: bash ANSI-C `$'...'` quoting could smuggle a command past the
  allow-list** (#1034, #1035). The same desync via `$'\''` (the idiom for a
  literal single quote), mishandled by both `splitCompoundParts` and
  `maskQuotedSpans`, which treated `$'...'` as a plain single-quoted span. Both
  now recognize `$'...'` and apply C-style escapes inside it. Found during
  adversarial review of #1033.
- **Quoted prose no longer escalates** (#1023, #1028). `hasShellControl` was
  quote-blind, so a `gh issue create --body "…"` that mentioned a backtick, a
  `>` comparison, or an `&` tripped the veto and escalated even though `gh
  issue` was allow-listed. It now runs against a quote-masked view that removes
  only characters it can prove are literal, so real `$(…)`/backtick/redirect
  still veto.
- **Statusline reports the session's repo and branch, not the hub's** (#1025,
  #1029). A hub-spawned session daemon inherited the hub's working directory; a
  directory-less remote create-session request now lands the child in home
  rather than wherever the hub was started, and the statusline reflects the
  session's own directory.
- **Terminal status cue no longer collides with the spinner** (#1026, #1027).

### Changed
- **Deterministic subagent permissions are answered at hook time** (#1024,
  #1030; amends [ADR 0004]). An `agent_id`-tagged `PermissionRequest` whose
  deterministic layers return a plain approve (no deny match) is answered
  `{behavior:"allow"}` immediately — no park, no render, no LLM, no GPU queue.
  Everything else (no deterministic verdict, or a deny match) still parks for
  the PTY to arbitrate on render, exactly as before.

### Known open
- A bare tool-name `allow` entry (e.g. `["Write"]`) carries no destination veto,
  so since #1024 it grants a subagent silent hook-time write access to
  sensitive destinations a curated `approve_groups` write group would block
  (#1032, not yet decided).

[ADR 0004]: .context/decisions/0004-pty-as-arbiter-subagent-questions.md

## [0.7.4] - 2026-08-03

Closes four security holes and rebuilds auto-approve around deterministic
permission groups, so the local model decides far less and what it does
decide is bounded by a risk band it cannot argue its way past. Question cards
that could be created and then never removed by anything but eviction now
have working exits, and an answer meant for one session can no longer be
typed into another.

Two of the security fixes are things a 0.7.3 install is exposed to today: a
website you visit could answer your permission prompts (#535), and a tool
name in the allow-list approved any Bash command containing it (#536).

### Added
- **An earlier answer can authorize a later identical operation** (#976, #1017),
  **off by default**. Both directions are wired, and they ship with different
  defaults on purpose. The DENY direction is always on: a command the user
  refused earlier in the session now blocks a model `approve` for the same
  operation, because a stop rule that fires too rarely is the dangerous
  direction (ADR 0010). The APPROVE direction — an exact precedent minting
  `explicit` authorization, the only route above `implicit` under the ADR 0015
  amendment — is behind `[auto_approve] session_precedent`, default `false`.

  Default-off is not caution for its own sake. Four review rounds each found the
  same defect: `signatureForOperation` derives from `summarizeToolInput`, whose
  job is one readable line for a lock-screen card, so it drops whatever will not
  fit — `Write`'s `content`, `Read`'s `offset`/`limit`, a command's indentation.
  Every one of those made an approval authorize a strictly larger operation than
  the one answered. All four are closed and mutation-tested, and
  `precedentMayAuthorize` now fails closed to a per-tool allowlist. But #1019 is
  a KNOWN-OPEN instance of the same class — a Bash signature carries no `cwd`,
  so an approval in one worktree authorizes the same command in another. Turning
  this on before that lands is a decision the operator should make deliberately.

- **A `scratch` permission group** (#1000). `rm /tmp/scratch.bak` bands `high`,
  so with the #994 risk ceiling in place it escalated unconditionally and no
  conversation text could approve it — correct as a fallback, wrong as a policy
  for a scratch directory. `scratch` matches a Bash command only when EVERY file
  target it touches provably resolves under `/tmp`, `/private/tmp` (macOS's real
  path), or `$TMPDIR`, including a leading `cd` into one and output redirection
  from any otherwise-covered command. Deletion is in the group, which no other
  group allows. In `balanced` and `trusted`, not in `careful`.

- **`AuthorizationAssessment`, making the provenance ceiling structural** (#1010).
  ADR 0015's rule — text alone can never establish authorization — was a
  convention: `capGradeForTextProvenance` existed and callers were expected to
  remember it. The type now removes the remembering. Private constructor, two
  factories; `fromText` caps inside the factory so a text-derived grade above
  `implicit` is unrepresentable rather than merely rejected, and `fromPrecedent`
  is the only mint for `explicit`. The private field is load-bearing: TypeScript
  is structural, so an interface with the same fields could be forged by an
  object literal, while a class with a private member is nominal and cannot be.

- **Risk band and authority presence on every decision** (#1012), instrumentation
  only. Logged on every decision rather than only escalates, so the denominator
  is visible — "12% of escalates were eligible" means nothing without knowing how
  many escalates there were.

### Fixed
- **A model deny is no longer invisible** (#1015). An auto-approve deny produced
  no card, no push and no log line, so the operation simply did not happen and
  the user was never told why. Every deny is now logged unconditionally, on its
  own path rather than through `log_decisions` — a user who turned decision
  logging off asked for less noise about routine decisions, not to be kept
  unaware that an operation was blocked. A deny that matched the model floor
  also pushes a `kind: 'auto_denied'` notification naming the pattern it hit. Config-sourced denies log but do not push: the user wrote that rule, so
  it firing is the rule working. The fix covers all three deny paths, including
  the held-hook verdict that resolves after `push_hold_timeout` (60s by default)
  — the least visible of the three, since its card disappears through a quiet
  `content-available` dismiss that carries no title or body.

- **`deny_groups` now matches broadly, as a stop rule must** (#1001).
  `deny_groups` was answered by `matchGroups`, the same precise function that
  answers the ALLOW question, so appending anything the group did not recognize
  defeated the block outright — `mkdir /tmp/x` was denied, `mkdir /tmp/x && ls`
  was not. `matchGroupsBroad` matches if any segment hits, and deliberately does
  not apply the allow-side vetoes: those exist to NARROW an allow match, and
  applying them to a deny would mean a command that looks more dangerous is less
  likely to be blocked.

- **Subagent cards now have a working exit** (#1005, two changes). Tracing the 8
  ids in a real stale pending set: 7 of 8 subagent-tagged, every one removed
  ONLY by LRU eviction, 2.5 to 12.5 hours after being added — which is also why
  every reconnect re-sent exactly 8. A parked escalation that had already been
  retired still pushed a card, and retirement had deleted the signature entry
  every sweep iterates, so nothing could remove it (#1006). And a card that IS
  legitimately created now participates in render ownership, so a confirmed
  replacement prompt resolves it (#1008); previously that slot was scoped to
  hookless cards, while a parked subagent escalation is hook-born but answered
  `passthrough` at park time (ADR 0004), leaving the render as its only living
  evidence and tracked by nothing.

- **Shell grammar and assignments peel before matching** (#999). One
  unrecognized structural keyword vetoed a whole line: per-segment matching
  requires every segment to be covered, and `for`/`do`/`done` matched nothing,
  so every loop and conditional escalated no matter how safe its body was.
  `stripShellGrammar` only ever REMOVES grammar and hands the command inside to
  the normal matcher; it never decides anything is allowed. Terminators are
  peeled rather than treated as benign, so `done rm -rf /` re-judges the `rm`.
  Assignments peel for the same reason — `FOO=bar rm -rf /` really does run
  `rm`. Assignments were the largest single uncovered cohort in the real corpus,
  150 of 678.

- **An answer is never typed into a session with no prompt on screen** (#1002).
  A bare `1`, tapped on a phone for a different session's card, arrived in a
  live unrelated session as a chat message. #920's guard asks "is THIS prompt on
  screen?", which a hook-paired card can never satisfy — its id and text are the
  hook's, not the PTY parse — so the guard was scoped away from that cohort
  entirely. The presence question ("is ANY prompt on screen?") is answerable for
  both, and is now asked for both.

### Changed
- **An auto-approve deny now tells Claude why** (#976). The hook response
  carried a bare `{behavior:"deny"}`, so Claude learned only that it was
  refused — leaving it to guess or give up. `PermissionDecision` gains the
  `{behavior:'deny', message?, interrupt?}` variant the official hooks reference
  defines, where `message` is *"For `deny` only: tells Claude why the permission
  was denied"* — model-directed, not terminal UI. With `interrupt` unset the turn
  continues, so the reason is actionable.

  The message offers two exits, deliberately in this order: use a different
  approach, or ask the user to authorize explicitly. Leading with "ask the user"
  would push Claude to interrupt even when a safe equivalent existed. The second
  exit also closes the #976 loop — the user's answer arrives via
  `UserPromptSubmit` as genuine EXPLICIT authorization from a channel text cannot
  forge, which is the only route above `implicit` under the ADR 0015 amendment.

  Deliberately NOT claimed anywhere: that Claude will then ask. The docs
  guarantee only that it is not stopped and has been told why; what it does next
  is its own choice, and that is an expectation to verify by observation rather
  than a contract. The bare `'deny'` string stays valid and equivalent to
  omitting the message, so no existing caller changes.

### Fixed
- **Machine-generated text no longer reaches the auto-approve authority channel**
  (#982). `UserPromptSubmit` is authority's PRIMARY source, and `authority.ts`'s
  premise was that Claude Code puts only the human's keystrokes there. Measured
  over a live capture window: of 206 prompts carrying text, **72 (35%) were
  machine-generated** — 69 `<task-notification>`, 3 `<agent-message>` — and every
  one passed the provenance denylist, so all 72 were recorded as the human's own
  turns and rendered into the prompt as "what the human has actually typed".

  That is live influence, not a hypothetical: #954 measured a merely TOPICAL
  mention flipping `rm -rf ./build` from `deny` to `approve` 5/5, and task
  notifications routinely carry operation names, paths, and words like
  "approved" and "completed".

  Fixed with `isNonHumanForAuthority`, a stricter authority-scoped predicate:
  the existing denylist OR a leading markup tag. The display consumers
  (`transcript-message-bridge`, `transcript-discovery`) keep the old denylist
  deliberately — the two paths have opposite failure directions, exactly like
  allow vs deny matching (ADR 0010). Wrongly dropping text on a display surface
  hides the user's own message; wrongly accepting it on the authority surface
  lets a machine speak as the user into a permission decision.

  A shape rule rather than three more denylist entries, because the denylist
  fails open by design and this was three proofs of that in one sample — the
  next wrapper Claude Code introduces is undiscoverable by construction, and now
  fails closed. Measured cost on the same corpus: zero. No human-typed prompt
  began with `<` at all.

### Fixed
- **`git stash` and `git stash pop` are covered by `vcs-write`** (#972). Only
  the explicit `git stash push` spelling was listed, so the bare form — which is
  git's own default spelling of exactly that — and its `pop` counterpart went to
  the LLM and escalated, despite both being purely local.

  Listing bare `git stash` necessarily also prefix-matches `git stash drop` and
  `git stash clear`, which discard stashed work irrecoverably (`clear` discards
  every stash at once). Those are refused through the existing
  `WRITE_GROUP_POSITIONAL_VETOES` table that already guards `git checkout .`,
  because the matcher cannot express "exactly `git stash`" — `matchPrefix`
  accepts the exact segment OR anything starting with `prefix + ' '`. The veto
  matches tokenized words, so `git stash "drop"` is refused too; the raw-text
  version of that check is the bug #960 found in `git checkout "."`.
- **A model configured by its HuggingFace id is no longer reported missing**
  (#971). The engine keys inventory rows by nickname (`yooz-instruct-4b`) and
  carries the repo id alongside in `huggingFaceID`; `config.toml`'s `model`
  holds the repo id, which is the shipped default. `pullModel` compared `id` to
  `id` only, so its "already on disk" short-circuit missed a model that was
  cached AND loaded, dispatched a redundant download, then polled `/v1/state` —
  which missed for the same reason — for the full 30 minutes before logging
  "Could not fetch ... auto-approve will escalate until it is present".

  That warning was false: evaluations worked the whole time, because the engine
  DOES resolve a repo id on `/v1/llm/generate`, just not on the inventory
  routes. It fired 15 times in one user's log, once per daemon start.

  Matching now goes through `model-identity.ts`'s `findModel` (#843), which
  already existed for exactly this and which these two call sites had never
  adopted. `/v1/state` rows carry only `id`, so the configured name is
  translated to the canonical engine id through the inventory before probing —
  and re-translated mid-download, since the row appears only once the fetch is
  under way. An engine predating `huggingFaceID` (pre-0.7.8) still pulls by the
  configured name exactly as before.

  Verified against the live engine: `pullModel` for the repo id now returns in
  **45ms** where it previously threw after 1800s.
- **The auto-approve pill no longer sticks on "evaluating"** (#970). A cancelled
  eval was the one gate end path that told clients nothing: `onEvalStart` moves
  the pill to `evaluating`, `onHandled` moves it to `approved`, `onEscalate`
  relies on the question path's `waiting` — and `onCancelled` broadcast nothing
  at all. It self-healed only when a later `Stop`/`SessionEnd` `idle` or a
  `PreToolUse` happened to follow, and none arrives when the eval is cancelled
  at end-of-turn or during a disconnect, which is exactly when it was seen stuck
  in the field.

  The terminal statusline never had this bug: its `inFlight` count is decremented
  by every end path, which is why `status-writer.ts` can claim the cue "can never
  get stuck". The client cue had no equivalent property, and now does — asserted
  by a test enumerated over the verdicts, so a future end path that forgets the
  terminal half fails there instead of silently joining the hole.

  The correction broadcasts the session's CURRENT status from the registry rather
  than a chosen constant. Nothing was approved, denied, or escalated, so any fixed
  value would be a guess, and a wrong status is the same class of bug as a stuck one.

  Also pins the routing fact the fix rests on: a subagent eval never shows the pill
  and cannot reach this cue, because `arbitrateParkedRender` sends a `cancelled`
  verdict to `escalateRenderedParked()` rather than to `onCancelled`. An earlier
  draft added an `isSubagent` guard here; it was dead code (always `false`), and
  the test written for it passed with the guard deleted. Both were dropped in
  favor of asserting the real routing.
- **The auto-approve pill's held-hook (Model B / Part B, #573) end paths finish
  the #970 totality pass.** The previous fix covered the primary eval loop only;
  a HELD escalation's own end paths are a separate set, enumerated fresh against
  the live code rather than trusted from the prior pass: a Part-B late `allow`/
  `deny` verdict (`reconcileLateVerdict` -> `resolveHeld`) turned out to be
  ALREADY total — `resolveHeld` calls `markHandled` unconditionally, so it
  already broadcast `approved`. The genuine gap was Part-B's `cancelled` late
  verdict (`reconcileLateVerdict` -> `releaseHeld`), which calls neither
  `markHandled` nor any cue and left the pill on a stale `waiting` with nothing
  to correct it once the session moved on to something else. A new `onHeldCancelled`
  cue closes it, reusing the same `broadcastCurrentStatus()` the `cancelled` fix
  above introduced rather than guessing a value.

  Hold-timeout fail-open and the Stop/SessionEnd/external-resolution teardown
  paths were checked and deliberately left alone: each already has its own
  status coverage (the hold's own `waiting`, or the driving hook event's own
  status update in the same synchronous handler) — adding a broadcast there
  would risk trading a stuck pill for a wrong one, the same failure mode
  ADR 0020 warns against.
### Added
- **Separate in-app toggles for question and turn-complete notifications**
  (#968). Settings now has "Question alerts" and "Turn complete" instead of one
  "Notifications" switch — which was written by the settings panel and read by
  nothing, and could not have worked anyway: APNS pushes travel daemon →
  signaling Worker → APNS and never consult the client. The preference now
  rides up on `register_device_token` (idempotent and keyed by token, so
  flipping a toggle is just a re-register) and the daemon filters its per-token
  fan-out, so muting is enforced by the only party actually in the push path.
  Per device, not per machine: two phones can want different things.
- **An explicit `kind` on every push** (`question` | `turn_complete` |
  `subagent_alert` | `dismiss`), forwarded into the APNS payload. The classes
  were previously told apart by a NEGATIVE test ("no `questionId`, no
  `category`") that could not distinguish a turn-complete push from a subagent
  alert at all — on the wire both are exactly `{token, title, body}`, and the
  `": turn complete"` title suffix is display text, not a protocol field.
  Strictly additive: every field that previously carried routing information is
  sent unchanged, so an un-redeployed Worker or an older client behaves as before.

  Two classes are deliberately NOT mutable. `dismiss` is the quiet
  `content-available` push that CLEARS a resolved card; suppressing it would
  strand that card on the lock screen of the very device that asked for less
  noise. `subagent_alert` already has a user-facing control — it fires only on
  the patterns in `auto_approve.subagent_alert`. `notifications.on_turn_complete`
  in `config.toml` remains the machine-wide master switch and still wins.

  The load-bearing case, and the one with its own test: when every device has
  muted questions and no client is attached, the delivery outcome is
  `no_channel`, not `pushed`. `awaitDelivery` decides whether a HELD hook keeps
  Claude blocked, so reporting delivery for a fan-out of zero would block the
  hook on a card that will never appear anywhere. Malformed preferences fail
  toward delivering, for the same reason — verified by mutation (a coercing
  implementation reads `{questions: 0}` as "mute" and the test goes red).

### Changed
- **The auto-approve prompt's default guidelines now follow `level`** (#966).
  `level` selects which groups are approved deterministically, but whatever no
  group covers still reaches the LLM — which was reading fixed text telling it
  to escalate exactly what the chosen level said was routine. The same policy
  then gave different answers depending on whether a curated prefix happened to
  exist, which is not a distinction a user makes or can predict. `balanced`
  moves file writes into the prompt's APPROVE list; `trusted` also moves local
  git mutation. `strict` is **byte-identical** to the prompt that shipped
  before levels existed, asserted against a baseline captured from `develop`'s
  own `buildPrompt` rather than hand-transcribed. Fixed at every level, and
  each asserted rather than described: the DENY FLOOR, the response format,
  deletion, remote mutation (including `git push`), package install, unfamiliar
  commands, and design/direction questions. A level widens what is routine,
  never what is dangerous — two of the pre-existing escalate lines bundle an
  operation a level approves with one it must never approve (the git line names
  `git push` beside `git add`; the file line names `deletion` beside creation),
  so a level REPLACES those lines with narrower ones instead of removing them.

### Added
- **`[auto_approve] level` — a strictness preset over the permission groups**
  (#963). `strict` (the default) is exactly today's behavior; `balanced` adds
  `fs-write`; `trusted` adds `vcs-write`. This is where #956's premise lands:
  measured over 796 real evaluations, the 244 deterministic group approvals
  were honored exactly every time at 0ms, while **35 escalations explicitly
  cited the user's own `instructions` and escalated anyway** and 57 were plain
  writes against a config whose prose approved writes outright. Prose to a 4B
  model is asked; group membership is enforced. `instructions` keeps working
  and keeps its prompt placement, but stops being load-bearing: it becomes the
  exception layer for project-specific carve-outs the groups cannot encode.
  An explicit `approve_groups` OVERRIDES the preset rather than merging with
  it — a union could only widen, silently re-widening a list a user had
  deliberately narrowed — and the daemon logs which won, so a config written
  before levels existed keeps behaving exactly as it always has. `remi config`
  prints the resolved group list alongside the level, so the effective policy
  is inspectable without reading source. **The default is `strict`, not
  `trusted`:** phase 2 needed four adversarial review rounds to close eleven
  bypasses in the write groups, and defaulting them on in the same change that
  introduces the switch would bundle "does the mechanism work" with "is this
  policy right". Flipping the default is a one-line change and its own PR.

- **`UserPromptSubmit` is now a registered hook, feeding a new auto-approve
  authority summary** (#893, Q9). `REMI_REGISTERED_HOOK_EVENTS` grows from 14
  to 15; the listener is a single array push into a per-session
  `AuthorityStore` (`auto-approve/authority.ts`), and the event gets its own
  short 1s timeout (`hook-config-manager.ts`'s `hookTimeoutFor`, now a small
  per-event table instead of one flat default) rather than the plain 5s
  fail-fast budget, since its handler never has anything to wait on. The
  human's own typed turns are now threaded into the auto-approve LLM prompt
  as a delimited "CONVERSATION CONTEXT" block, distinct from and weaker than
  the existing USER GUIDANCE (config `instructions`) block: it is framed as
  reported history, not an instruction, and can only ever LOWER escalation
  for an operation already low/moderate risk. `UserPromptSubmit`'s `prompt`
  field is the PRIMARY source (direct from Claude Code, no transcript
  parsing); a filtered transcript read is the FALLBACK for a resumed
  session's prior turns, which the new registration never saw fire for.
  Measured across real transcripts, a `role: "user"` entry is not reliably
  human-typed: 5,518 `tool_result` envelopes; 703 genuine typed turns; 88
  plain-string entries carrying a top-level `isMeta: true` flag that are
  NOT human-typed (47 cross-session `<agent-message from="...">` deliveries
  — a SUBAGENT's own authored text in a "user"-role string, the most direct
  injection vector found, since filtering on role+shape alone would let a
  subagent write its own authority; 35 `<local-command-caveat>` notices; 5
  scheduled/heartbeat prompts; 2 `<system-reminder>`s); and 36/34 plain
  strings wrapped `<command-name>`/`<local-command-stdout>` that carry NO
  `isMeta` flag at all. Two different mechanisms handle this: `isMeta ===
  true` is checked first and excludes the whole 88-entry cohort
  structurally (`transcript/types.ts` now types the field); the
  `<command-name>`/`<local-command-stdout>` residual has no structural
  discriminator and is caught only by a textual-prefix denylist, which is
  why the hook stays the PRIMARY source and this filter only guards the
  fallback path — see `authority.ts`'s module doc for the full breakdown,
  and for why an original claim that `<local-command-stdout>` is reachable
  specifically via a `!`-prefixed bash command was corrected to
  unconfirmed (the only samples inspected were slash-command output; #938
  tracks getting a live capture to settle it).
  **The primary source is filtered too, defensively**: the design premise
  that `UserPromptSubmit.prompt` only ever carries the human's own
  keystrokes is UNVERIFIED (also #938) — the same `!`-bash-mode question
  above. The `UserPromptSubmit` listener therefore also runs
  `isWrappedNonHumanText` over `input.prompt` before recording it, so a
  wrapped-string failure of that premise is caught on the primary path too,
  not only the fallback. This is defense in depth, not proof the premise
  holds; the code comments say so explicitly.
  **Trust boundary**: `enforceAuthorityBoundary` is a code-level backstop,
  independent of the LLM's own reasoning, that downgrades an
  authority-influenced `approve` verdict to `escalate` whenever the
  operation matches a hardcoded catastrophic pattern (mirroring the
  prompt's DENY FLOOR) — authority text can never approve `rm -rf /`,
  `sudo rm`, `curl|sh`, or `chmod 777`, regardless of what the model
  decided or why.
  **Side effect on turn-complete notifications** (`#914`, `turn-timer.ts`):
  `TurnTimer` anchors a turn's elapsed-time measurement on the first hook
  event `onAnyEvent` sees for that `prompt_id`. `UserPromptSubmit` fires
  before every other registered event, so it is now that anchor instead of
  an approximation from the first tool-use/permission event — `elapsedMs`
  is now accurate rather than a slight underestimate. A turn whose real
  duration was already at or above `turn_complete_min_seconds` (default 60s)
  but whose OLD (underestimated) measurement fell just short will now
  correctly cross the threshold and notify, where it previously did not.
  This is an intended accuracy fix, not a regression, but it is
  user-visible: some sessions will see more turn-complete pushes for turns
  near the threshold.

- **`PermissionDenied` and `Elicitation`/`ElicitationResult` are now
  registered hooks, observe-only** (#889, Q4). A classifier-denied permission
  fires no tool call, so nothing previously proved a still-open escalation
  was resolved; `PermissionDenied` now routes into the same
  `AutoApproveGate.cancelExternallyResolved` funnel PreToolUse/PostToolUse
  use, matching on `tool_name` + `tool_input` + `agentId`. (It does carry a
  `tool_use_id`, unlike `PermissionRequest` — but the escalation it would match
  was registered from a `PermissionRequest`, which never sends one, so the
  exact-id branch is unreachable from this path today and the id is
  forward-compatible only.) An MCP `Elicitation` dialog previously
  arrived only as a PTY orphan (the dedicated hook was never registered, and
  the `Notification(elicitation_dialog)` variant that did fire was logged
  and ignored); it now builds an answerable, free-text `Question` card
  instead of fabricating Accept/Decline options nobody has verified against
  a real dialog, and `ElicitationResult` resolves that exact card by
  `elicitation_id`. Neither hook response encodes a decision —
  `REMI_REGISTERED_HOOK_EVENTS` grows from 11 to 14, each new registration
  measured at well under 1ms of added roundtrip latency locally.
  Review fix before merge: an `Elicitation` re-fired for an `elicitation_id`
  whose card was still open used to repoint the correlation map at the repeat,
  which `QuestionDedup` had already suppressed (same text, same zero options,
  so never "richer") — so `ElicitationResult` resolved an id that was never
  registered and the card the user could actually see was left with no
  automated way to clear. The map now refuses to displace a still-live card
  and never tracks an id that did not reach `sessionRegistry`, the same
  confirmed-delivery gate #888 landed. Review also added the two missing
  guards' tests plus one proving `PermissionDenied` resolves only its own
  agent when two escalations share a signature, and one proving Q5's residual
  unpaired-notification path still surfaces a card; and corrected
  `docs/claude-code-hook-contract.md`, which still listed all three
  newly-registered events as unregistered.

### Fixed
- **Conversation text can no longer decide a permission** (#954). Q9 (#893)
  added a CONVERSATION CONTEXT block to the auto-approve prompt with a
  constraint stated in three places -- it "can NEVER turn an operation that is
  remote, destructive, unfamiliar, or irreversible into an approve". Measured
  against the live 4B with `rm -rf ./build` held constant and only the block
  varying: no authority gave `deny` 5 runs of 5, and **"please clean out the
  build directory, it is stale" gave `approve` 5 of 5**. Unrelated chatter
  stayed `deny`, so the trigger was topical MENTION, not authorization -- a
  casual sentence moved the verdict two steps, skipping `escalate` entirely.
  `enforceAuthorityBoundary` caught none of it: it checks eight catastrophic
  substrings and `rm -rf ./build` is not one, and widening that list does not
  scale to "remote, destructive, unfamiliar, or irreversible". The rule is now
  enforced as a COUNTERFACTUAL instead of a pattern: when a risky-looking
  operation is approved with an authority block present, the same evaluation
  is re-run with the block removed, and a differing verdict means the
  conversation decided the outcome, which escalates. Authority may still
  resolve ambiguity -- an approve that survives without it stands untouched --
  so a user's `instructions` are unaffected. The second call is gated on all
  three conditions (risky shape, authority present, verdict was approve), a
  set close to empty in 796 measured evaluations, so steady-state latency is
  unchanged. A counterfactual that cannot run escalates rather than leaving
  the approve standing.

- **Quoted flags no longer slip past the permission-group vetoes** (#959). The
  curated group matcher tested flags and paths against the RAW command text,
  but the shell removes quotes and escapes before the program ever sees them,
  so one embedded quote defeated the check. This was live on the groups that
  ship ENABLED BY DEFAULT: `git diff --"output"=f` (writes a file),
  `biome check --"write"` (mutates source) and `sed -n -"i" x` (in-place edit)
  were all approved with no LLM call and no question card, while their
  identical unquoted forms were correctly refused. A new `shellWords()`
  (`auto-approve/shell-safety.ts`) performs real quote and escape removal --
  including `$'...'` and `$"..."`, and the backslash form `--o\utput` that
  needs no quotes at all -- and every veto now runs against tokenized words.
  The read-group check consults the reconstructed word list IN ADDITION to the
  raw text, so it can only ever add a refusal, never remove one; no command
  that was previously refused becomes allowed. Found in the third adversarial
  review round on #960, which also confirmed the same flaw on the new
  write-side groups before they shipped.
- **An auto-approve `deny` that matches no DENY FLOOR pattern is now escalated
  to you instead of silently blocking the command** (#953). `prompt-builder.ts`
  has always said "DENY IS RARE: deny ONLY operations in the DENY FLOOR... For
  anything else you would not approve, ESCALATE, never deny. Escalating lets
  the user answer; denying blocks them" — but nothing enforced it. The only
  code-level guard in the module, `enforceAuthorityBoundary`, moves `approve ->
  escalate` and explicitly never touches `deny`, and the config `deny` list
  defaults to empty, so the model's verdict was taken at face value. That
  mattered because a deny is invisible: `AutoApproveGate` returns `'deny'` to
  the hook and pushes no question card, so you were never asked and never
  learned the operation had been attempted. Measured against a live engine with
  the shipped 4B model on 16 cases drawn from the prompt's own ESCALATE list,
  **10 of 12 escalate-expected operations returned `deny`** — `rm -rf ./build`,
  `git push --force origin main`, `DROP TABLE`, `ssh`, `curl -X DELETE`,
  `find -delete` — while all four controls were correct, so this was the
  escalate/deny boundary specifically rather than a broken prompt or model. The
  model was not confused about the rule: on `rm -rf ./build` it reasoned "while
  not in the strict DENY FLOOR" and denied anyway. A new
  `auto-approve/deny-floor.ts` now owns `CATASTROPHIC_PATTERNS` (moved from
  `authority.ts`, which re-exports the matcher) plus `enforceDenyFloor`, which
  mirrors the existing guard's shape — it runs after the model decides, is
  blind to its reasoning, and only ever moves `deny -> escalate` when the
  operation matches no catastrophic pattern. It never touches `approve` and
  never produces a `deny`. Config `deny`/`deny_groups` matches are unaffected:
  they short-circuit before the LLM call, so this applies to model-produced
  denies only. Note the list is now asymmetric to widen — an added entry makes
  `enforceAuthorityBoundary` stricter but `enforceDenyFloor` looser — and that
  the exfiltration bullet is deliberately absent from it, so a model-denied
  exfiltration attempt now escalates rather than denies. Same root cause as
  #954: routing rules stated only in the prompt are not enforced.
- **A full teardown (`SessionEnd`, `remi unstick`) now resolves every
  still-open escalation instead of silently dropping its bookkeeping**
  (#948). `AutoApproveGate.cancelStale`'s mainOnly `Stop` sweep already
  routed each survivor through `resolveSupersededQuestion` so
  `question_resolved` + the APNS dismiss + the live-sessions mirror all
  fire — its own comment named this explicitly as "not a silent
  bookkeeping-only delete." The non-mainOnly branch (`SessionEnd`) and the
  separate `forceRelease` (`remi unstick`) did exactly that anyway: a bare
  `openQuestionSignatures.clear()` + `parkedInputs.clear()`. A PASSTHROUGH
  escalation — multi-choice/design, e.g. `AskUserQuestion` or
  `ExitPlanMode`, tracked only in `openQuestionSignatures` (never held) —
  had its bookkeeping dropped while its card stayed in the store with
  nothing left to resolve it. Reproduced: firing a `SessionEnd` with no
  intervening `Stop` (a session killed or dropped mid-prompt) left the
  card count at 1 before and 1 after. Every captured corpus session that
  reaches `SessionEnd` also has an earlier `Stop`, which already clears
  the card via the mainOnly sweep — the reason #949's replay never caught
  it.

  Both teardown paths now share a new `resolveAllOpenQuestions`, which
  resolves EVERY survivor through the same funnel — deliberately, unlike
  the mainOnly sweep, WITHOUT its `isSubagent` skip: that skip exists
  because a `Stop` means only the lead agent finished while a teammate may
  still be mid-turn, and a full teardown has no such survivor left to
  protect (`cancelStale`'s own docstring already said so). `parkedInputs`
  needed no separate clear call: every parked entry is registered under
  the same question id as its `openQuestionSignatures` counterpart
  (`parkSubagentForPTY` sets both together), and `releaseHeld` — reached
  by every `resolveSupersededQuestion` call — already deletes both maps'
  entries for a resolved qid unconditionally, before anything downstream
  can throw, so the loop retires every parked entry as a side effect of
  retiring its signature. Checked the neighboring
  `evalIdByQuestion.clear()` in `forceRelease` for the same defect:
  unaffected — that map is unrelated GPU-eval-cancellation bookkeeping
  with no card or notification duty of its own, and `forceRelease`'s
  subsequent untargeted `service.cancel(reason)` already aborts whatever
  eval is running regardless of which question it belonged to.

- **Every opt-in debug sink now stamps provenance on each record, so a
  synthetic test write is distinguishable from a real one by data** (#934).
  `REMI_HOOK_DEBUG=1` (`hook-diag.jsonl`) and `REMI_QUESTION_TRACE=1`
  (`question-trace.jsonl`) are both keyed on an env var the test suite runs
  under too, and both write to the SAME fixed `~/.remi/*` path a real
  session uses — `HookServer.handleRequest` cannot tell a test's HTTP POST
  from Claude Code's, and `QuestionStore`/`SessionRegistry` cannot tell a
  test calling `add()`/`remove()` directly from a real hook-driven mutation.
  93+ records in the owner's real `hook-diag.jsonl` had been contaminated
  with fabricated rows (including `SessionStart`/`UserPromptSubmit`, both
  contradicting confirmed hook-registration behavior), and 965 of 3,582
  lines in `question-trace.jsonl` carried the test suite's hardcoded
  question id. `REMI_PTY_CAPTURE` (`pty/pty-capture.ts`) turned out to be a
  third sink with the same class of problem — its destination is the env
  var's own value rather than a fixed path, but any test that spawns a real
  `PtySession` while a developer's shell has it set inherits the same
  contamination. All three now call a shared `debugProvenance()`
  (`src/debug/provenance.ts`) and stamp it on every record — `_provenance`
  for `hook-diag.jsonl`, `provenance` for `question-trace.jsonl`, a bare
  third token for `pty-capture`'s line-oriented (not JSONL) format. This
  stamps rather than gates: each sink's own env var still controls whether it
  writes at all, unconditionally.
  **Caught in review before merge:** the first version of `debugProvenance()`
  read `NODE_ENV === 'test'`, on the claim that `bun test` sets
  `NODE_ENV=test` for the whole process — true only when `NODE_ENV` is UNSET
  beforehand. A developer whose shell already exported `NODE_ENV=production`
  (or `development`, a shared `.envrc`, a container default) got a record
  stamped `_provenance: 'live'` for a genuinely synthetic write, silently
  RECREATING #934 while the field made it look solved — worse than no field
  at all, since the corpus builder trusts `'live'` outright. Fixed by having
  the test harness positively mark itself instead of inferring test-ness from
  any ambient variable: `tests/debug/test-harness-marker.ts`, loaded via two
  `bunfig.toml` files' (repo root and `packages/daemon`, since Bun does not
  search parent directories for the config) `[test].preload`, sets
  `REMI_TEST_HARNESS` unconditionally the moment `bun test` starts, before
  any test file runs — a default Bun itself never overrides is not the same
  as a variable this codebase always sets itself. `debugProvenance()` reads
  that marker with a plain truthiness check (not `=== '1'`) so the design
  fails toward `'test'`, never `'live'`, on any ambiguous value: a lost real
  record is recoverable by re-capturing, an admitted fabricated one is not.
  Gating the write itself on the marker was still rejected for the same
  reason gating on `NODE_ENV` was — a developer running the daemon and the
  test suite from the same checkout would silently lose real diagnostic
  capture the moment the marker mechanism had any bug of its own, with no
  signal anything was suppressed. The corpus builder (`build-hook-corpus.ts`)
  filters primarily on `_provenance`; the old `/tmp`-rooted-path heuristic
  (`looksLikeTestFixture`) survives only as a fallback for records captured
  before this field existed, not as the mechanism. Also added: the
  question-trace schema now records `Question.source` on every 'remove'
  event (`questionSource`) — cheap, since the removed `Question` object was
  already in scope at every call site — closing part of the gap #920 found
  where a stray PTY write could not be traced back to the card that produced
  it. The answer payload itself was NOT added and is deliberately untracked
  (no issue filed): `answer` **is** in scope one layer up, at all three
  `SessionRegistry.removeQuestion` call sites inside `input-events.ts`'s
  `handleAnswer`, but every OTHER removal call site repo-wide is hook- or
  system-driven and genuinely answerless, so threading an optional `answer`
  through `SessionRegistry.removeQuestion`'s signature would populate it at
  only a small minority of call sites — judged not cheap enough to do well in
  this change, versus `questionSource`, which the removed `Question` object
  already carries at essentially every call site.

- **The redundant `Notification(permission_prompt)` question synthesis is
  deleted** (#890, Q5). It fed a `QuestionPresenceTracker` stash that only
  ever mattered if it arrived with no paired `PermissionRequest` — a richer
  paired `PermissionRequest` (the common case) always superseded it, and the
  stash itself is never pushed on its own. A capture corpus (4244 events / 5
  sessions / one working day) found 68/68 `permission_prompt` notifications
  paired by `prompt_id`, 0 unpaired. The event still flips status to
  `'waiting'`; in the theoretical unpaired case, a still-rendering prompt
  falls to the same orphan-PTY fallback every other hook-less prompt already
  uses, not to silence.

- **`QuestionStore` is now the single owner of a session's pending-question
  state, and a hook-less question can resolve from a screen render alone**
  (#888). Measured from a real capture (#920): of 29 daily source-less
  questions, 12 were never removed (one still pending 2h51m later) because
  every removal path (`AutoApproveGate.cancelExternallyResolved`, the
  Stop/SubagentStop sweeps) matches a tool signature carried by a hook event
  — and a genuinely hook-less prompt (an agent-team native prompt, a bare
  subprocess `(y/n)`) has no hook and so no signature. Its only exits were
  the user answering it or the `MAX_PENDING_QUESTIONS` LRU cap.
  `question-parser.ts` now sets `source: 'pty'` on every PTY-parsed question
  (documented since #574 but never implemented, which is why this cohort was
  invisible), and `QuestionPresenceTracker` gained a render-resolution
  transition: when a CONFIRMED replacement push supersedes a hook-less
  question, the original is removed from the store — the screen disappearing
  IS its resolution evidence, since nothing else exists.

  A first version of this compared the PTY-parsed render's id alone and also
  treated a status-leaves-`'waiting'` transition or a session restart as
  resolution evidence. Review found both unsound and reachable in
  production: the PTY parser mints a fresh id on every parse even for a
  prompt that merely redraws (#486), and `cli.ts` calls
  `tracker.onStatusChange` unconditionally while gating the paired
  `QuestionDedup` reset behind `!hookServer` — so a PTY-text-parsed status
  false positive (confidence >= 0.5, not certainty) could resolve a question
  whose "replacement" render was then silently deduped, telling the client
  a still-live prompt was cancelled. Fixed: resolution now fires ONLY once a
  new dep, `isQuestionLive`, confirms the replacement actually landed in
  the store (not suppressed by dedup); the status and restart triggers were
  dropped entirely rather than patched, since neither can be trusted as
  evidence for one specific question (a real restart already resolves
  everything via the pre-existing `resolveAndClearQuestions`). A before/
  after repro on the real pipeline (20 hook-paired cycles + 15 hook-less
  renders, each a genuinely distinct render) went from 8 of 35 added never
  removed (7 via LRU eviction) to 0 of 35; a separate integration suite
  drives the real `MessageAPI`/`QuestionDedup` and reproduces the
  flap-then-redraw chain directly, pinning that a deduped replacement no
  longer swallows the original.

  `SessionRegistry`'s `addQuestion`/`removeQuestion`/`clearQuestions`/
  `getQuestion` are now thin adapters over a new `QuestionStore`
  (`packages/daemon/src/session/question-store.ts`), which is the only code
  that mutates the pending-question map; `ManagedSession.currentQuestions`
  is a live, read-only view over it. Review also found and fixed a second,
  related bug: `QuestionPresenceTracker`'s hook/PTY merge silently took the
  PTY parse's `source` even for a hook-paired (parked-then-rendered
  subagent permission) question, which meant `pending-question-label.ts`'s
  `source === 'permission_request'` branch never fired for that class —
  the macOS menu-bar app and hub census showed the full raw prompt text
  instead of the intended short "Permission: `<tool>`" label. The hook
  record's own `source` now wins, matching the existing text/options/
  agentId precedent.

  The gate's own per-question bookkeeping (`AutoApproveGate`'s
  `pendingHolds`/`openQuestionSignatures`/`parkedInputs`/`evalIdByQuestion`/
  `confirmedDeliveries`, `QuestionPresenceTracker`'s `pending`/`awaitingPTY`/
  `bufferedDuringEval`/`armedOrphanQuestion`) is intentionally left as a
  follow-up: each is metadata about resolving a question the store already
  owns, not a second opinion on whether it is pending, and collapsing it
  into one state machine safely needs the same trace-driven verification
  each earned individually (#751/#763/#767/#814). The PTY-as-arbiter policy
  (ADR 0004) is unchanged — only bookkeeping moved, never a push/arbitration
  decision.

- **Answering a `source: 'pty'` card whose on-screen prompt is gone no
  longer injects into the live PTY** (#920). `#888`'s own reclassification
  found the residual leak this issue tracks was never a memory problem: a
  `source: 'pty'` card can sit in the store, still "active," long after its
  prompt scrolled off screen, and the ONLY gate on the answer path was
  whether the question was still registered — never whether its prompt was
  still on screen. Answering one submitted the resolved option value (or
  free text verbatim) into whatever Claude was doing at that moment; this
  reproduced live twice in one working session (two bare `1`s landing as
  apparent user input, minutes apart, with no prompt pending). Had either
  landed while a real numbered prompt was up, it would have silently
  selected option 1 on a question the user never saw. `input-events.ts`'s
  answer handler now calls `QuestionPresenceTracker.isPromptCurrent` — the
  same gate `AutoApproveGate.answerRenderedParked` already uses immediately
  before its own PTY write — right before the injection, scoped to
  `source: 'pty'` cards only (a hook-paired question's merged id/text are
  the hook's, never the raw PTY parse, so a blanket check would misfire on
  that cohort). A refused answer clears the stale card (`question_resolved`
  fires so every client's view updates) and returns the existing
  `STALE_ANSWER` error the client already handles, rather than failing
  silently. No tracker wired for a session fails toward refusing, not
  injecting. Free-form PTY input (#795) and held-hook answers (never
  PTY-submitted) are untouched. **Does not cover `source: 'elicitation'`
  cards**, which take the same unguarded `submitInput` path with
  `allowsFreeText: true` — an arbitrary-free-text variant of this same
  hazard, worse than a stray digit. `isPromptCurrent` cannot be widened to
  catch it: elicitation ids/text are hook-minted and never observed by the
  PTY tracker, so the check would report "not current" for every
  elicitation card and refuse them all. Needs a different mechanism; filed
  separately as #940.

- **A question is now identified by one id for its whole prompt cycle**
  (#887). Up to three ids used to exist for a single subagent permission: the
  hook bridge minted one at `PermissionRequest`, the PTY parser minted a
  fresh one on every render, and the gate had to re-key its own bookkeeping
  (`openQuestionSignatures`) to follow whichever one the pushed card ended up
  under. Missing that re-key — which, verified while fixing this, happened on
  every parked-subagent-permission cycle in a session with no auto-approve
  configured, since the re-key only ran from inside the auto-approve
  arbiter — left the gate tracking a signature under an id no pushed card
  ever carried, so a later PreToolUse/PostToolUse/SubagentStop match could
  never find and resolve it. `QuestionPresenceTracker.consumeAndMerge` now
  ADOPTS the hook's id when pairing a PTY render with a parked hook record
  instead of minting a new one from the PTY parse; a genuinely hook-less
  prompt (an agent-team native prompt, a subprocess `(y/n)`) still gets its
  id from the PTY parse, since there is no hook to mint one first. The gate's
  `rekeySignatureToRendered` is deleted outright — nothing replaces it, since
  the id it used to chase never moves now.

  `Question` gained an optional `promptId` (Claude Code's own `prompt_id`,
  present on every hook event since 2.1.196), carried from the hook onto a
  hook-born question and through the PTY-render merge, as a same-turn
  correlation key distinct from the question's own `id`. The opt-in
  question-lifecycle trace (`REMI_QUESTION_TRACE=1`) now records it plus a
  `callSite` naming which internal function emitted each add/remove, closing
  the gap where a double-removal in a capture showed THAT it happened but not
  WHICH code path did it.

### Security
- **Lock-screen answers are sealed to the daemon** (#875). The signaling
  Worker's `/answer/{code}` route accepted `sessionId`, `questionId` and the
  answer text as plain JSON, and the client had a matching function to send
  them. The phone now seals the whole body, `auth` block included, to a
  long-lived P-256 key the daemon publishes in its auth challenge and the phone
  pins beside the fingerprint. Ephemeral-static ECDH, so it costs one request
  and no round trip, which is all a suspended phone gets.

  The Worker sees an opaque envelope and the room code it routes by. The daemon
  opens it, then verifies the signature that was inside, so sealing hides who
  answered from the Worker without excusing the phone from proving it.

  A phone with no pinned key **refuses to send** rather than falling back to
  plaintext; reconnecting once re-pins it. A daemon that cannot open a sealed
  answer drops it rather than acting on a partial one.

  Scope, stated plainly: **this path has no caller today.**
  `relayAnswerViaSignaling` has zero callers and the wired lock-screen path
  (`relayAnswerDirect`, `App.tsx:1929`) POSTs straight to the daemon with no
  Worker involved. So this seals a dormant route before #612 wires it, rather
  than stopping traffic in flight. Doing it in this order means whoever
  implements #612 inherits an encrypted path instead of adding a plaintext one.

  No forward secrecy on the daemon's side: the static key opens every answer
  ever sealed to it. A sleeping phone has no round trip to negotiate a fresh
  key, and rotating invalidates every pin until each phone reconnects. Recorded
  in `sealed-answer.ts` rather than left to be discovered.

### Security
- **The relay transport is encrypted end to end** (#543). The signaling Worker
  was built to relay a *handshake*; WebRTC was meant to carry the session and
  was never implemented, so the relay became the data path and
  `RelayAdapter.routeMessage` carries every protocol message, `user_input` and
  answers included, as plain JSON the Worker could read.

  The daemon now runs a signed ephemeral ECDH on top of the existing Ed25519
  auth handshake, so it costs no extra round trip, and encrypts every payload
  after it with AES-256-GCM. Each side signs its ephemeral key with its identity
  key, so a Worker that substituted one would be caught rather than trusted, and
  the session challenge is bound into both signatures so a recorded handshake
  cannot be replayed. Keys are per-connection and discarded on reset.

  A peer that cannot do the exchange is **refused**, not served in plaintext,
  and a payload that fails authenticated decryption drops the peer instead of
  being ignored. Both are deliberate: the failure this closes is precisely a
  silent fall back to the clear.

  Scope worth stating honestly: no shipped client speaks the relay peer protocol
  today, so this closes the path before anything drives it rather than stopping
  a live leak. The leak that IS live is the lock-screen answer route
  (`POST /answer/{code}`), which sends `sessionId`, `questionId` and the answer
  text to the Worker in the clear. That is a different path with no handshake to
  key from, and it is tracked separately.

### Removed
- **`packages/web/src/lib/signaling-client.ts`** (#543), 201 lines with zero
  references anywhere in the tree. It was the client half of the relay and was
  never wired up. Deleting it means nobody completes an unencrypted relay peer
  by accident; a future one starts from the encrypted handshake.

### Added
- **Turn-complete push notification** (#914). `Stop.last_assistant_message` is
  present on the already-registered `Stop` hook (100% of captured events,
  #891) but was only ever logged, never surfaced. remi now pushes
  "`<session>`: turn complete" with the actual last message when a turn runs
  long — gated on DURATION, not on every `Stop`, because `Stop` fires on every
  turn including two-second interactive ones and a push on all of them is
  worse than nothing. Duration is measured from `prompt_id` (present on every
  hook's common fields), the earliest-observed hook event for that turn to
  `Stop`, so it costs no new hook registration. New `[notifications]` config:
  `on_turn_complete` (default true) and `turn_complete_min_seconds` (default
  60). Never fires on a stop-hook re-entry, an empty message, or with no
  device registered. `notifySessionComplete()`
  (`packages/web/src/lib/notifications.ts`), dead code with zero callers that
  made #914 confusing in the first place, is deleted rather than wired up —
  the actual notification is a server-side APNS push with real content, which
  the client already displays generically.

- **Hook fields remi was already receiving and dropping are now consumed**
  (#891). No new hook registrations — this is entirely fields the
  already-registered `Stop`, `SubagentStop` and `PostToolUse` hooks carry.
  `SubagentStop.agent_transcript_path` now replaces the SubagentStart-time
  path *derivation* for the subagent-view switcher: Claude Code hands the
  real path over directly once the file is guaranteed to exist, so it wins
  over the guess (validated the same way `agentId` already was, so a
  malformed value can't override a good derived one; falls back to the
  derivation when absent). `Stop.last_assistant_message` and
  `PostToolUse.duration_ms` (above a 5s threshold) are now logged instead of
  silently discarded — neither reaches a client yet, since `Session` /
  `SessionUpdateMessage` have no text field to carry them and adding one is a
  protocol change, out of scope here.

- **Local capability token** (#869, groundwork). The daemon now keeps a random
  secret in `~/.remi/capability.key` (mode 0600) and the CLI presents it on
  connect, so a local client can prove it is one without a trust-on-first-use
  round trip. A new `[daemon] require_local_auth` retires the blanket loopback
  auth exemption: with it on, a loopback peer must present that token or
  complete the Ed25519 challenge, exactly like a remote client.

  It defaults to **off**, and only because the macOS app cannot yet do either.
  It is sandboxed with no access to `~/.remi` by design (#649/#651) and has no
  identity of its own, so turning this on before that ships would lock it out.
  A machine that only uses the CLI and the web client can turn it on today.

  Worth stating plainly: a file readable by the user does not stop a process
  running AS that user from reading it too. This raises the bar from "any local
  process can approve a permission" to "any process that can read your home
  directory can". That is an improvement, not a boundary.

### Security
- **A website you visit can no longer answer your permission prompts** (#535).
  The WebSocket upgrade validated no `Origin` and every HTTP endpoint answered
  with `Access-Control-Allow-Origin: *`, while auth is off by default on
  loopback binds and loopback peers are exempt even when it is on. WebSocket
  upgrades are not subject to the same-origin policy and a wildcard CORS header
  waives it for the rest, so any page could open `ws://127.0.0.1:<port>/ws` or
  POST `/answer` and approve a permission on your machine.

  A browser always sets `Origin` and a page cannot forge it, while native
  clients (CLI, iOS, macOS) send none. remi's own clients are allowed
  (`capacitor://localhost`, any loopback origin, `https://remi.yooz.live`, plus
  anything in the new `daemon.allowed_origins`) and everything else is refused,
  including the literal `null` a sandboxed iframe or `file://` page sends. The
  wildcard is replaced by an echo of the caller's own origin, which still serves
  the iOS port-scan probe that needed it.

  The hook endpoint is gated too, and more strictly. It is the softer target of
  the two: `req.json()` ignores `Content-Type`, so a page could POST a forged
  hook body as a CORS-simple request with no preflight and never read the reply.
  A forged `PermissionRequest` with an unknown session pushed a fake "Claude
  needs your permission" notification to your phone; with a known one it took an
  eval-queue slot ahead of real prompts. Only Claude Code posts hooks and it is
  not a browser, so ANY `Origin` is refused there.

  A local process can still connect by sending no `Origin`, which is
  indistinguishable from a native client. That needs a capability token and is
  tracked in #869.

  If you serve the web client from your own origin, add it to
  `~/.remi/config.toml` under `[daemon] allowed_origins`; the daemon logs the
  exact line when it refuses one.
- **A tool name in the allow-list no longer approves a Bash command that
  merely contains it** (#536). The shipped default `allow = ['Read', 'Glob',
  'Grep']` was documented as matching tools only; it substring-matched the
  Bash command string too, so `rm -rf Readme`, `rm -rf ~/Documents/Reading`
  and `python Read_data.py && rm -rf /tmp/x` were all approved at 0ms with no
  evaluation. A custom entry was wider still: `allow = ['git status']`
  approved `git status; rm -rf ~`, because a substring says nothing about the
  rest of the command.

  Allow now splits a command into compound segments and requires EVERY
  segment to be neutral (`cd`, `pwd`, `echo`) or match an entry, and vetoes
  command substitution, redirection to a real file, and backgrounding. The
  case that motivated substring matching still works: `cd /foo && git push
  origin main` matches a `git push` entry, which Claude Code's own prefix
  pattern misses.

  It also vetoes code-execution primitives, which are a different thing from
  writes: `find . -exec rm -rf {} +`, `git -c core.hooksPath=/tmp/evil
  status`, `tar --to-command=...` and `awk 'BEGIN{system(...)}'` do not make
  the allowed command write, they make it run a command the user never saw.
  Spelling the primitive out in the entry itself still works, since a prefix
  match means the user typed it. Ordinary mutation flags are untouched: an
  entry of `biome check --fix` is a write the user chose.

  **Deny is unchanged and stays a plain substring search**, along with
  `subagent_alert`. Over-matching a deny costs an evaluation; under-matching
  one costs a command that should have been refused.

  If a config relied on the old substring behavior for Bash, those commands
  now get evaluated instead of approved at 0ms. An allow entry shaped like a
  tool name but meant as a shell command (`Rscript`, `MSBuild`) now warns at
  config load, since it matches a tool of that name and never the command.

## [0.7.3] - 2026-07-28

Makes remi able to stop its own daemons, and to evict a model the engine
was holding.

### Fixed
- **A flaky gate can no longer cancel a release silently** (#856). `auto-release`
  declares the test gates as `needs`, so a red gate — including a flaky one —
  *skips* it rather than failing it: no tag, no npm publish, no GitHub release,
  no Homebrew update, and the only symptom is a tag that never appeared. Two
  different flaky tests did exactly that during the 0.7.1 cut, once on `main`.
  A new `Release Guard` job asserts the invariant directly: after a push to
  `main`, `main` must not still carry a `-dev` suffix. It runs on `always()`,
  because the case it exists for is precisely the one where the gates failed.

### Fixed
- **`remi model rm` can now evict the engine's active model** (#860). It could
  not, and no sequence of remi commands could: `isActive`/`deletable` in the
  engine's inventory are owned by the **TouchUp (proofread) picker**, not the
  LLM picker remi uses. `remi model use` writes remi's config and cannot
  release it; `POST /v1/llm/model` moves the LLM selection and leaves it
  undeletable; and restarting does not help, because a fresh engine re-selects
  and re-loads that tier at boot — so the printed advice ("stop the engine
  first") provably could not work. On an engine remi **owns**, `rm` now moves
  that picker to another model of the same purpose and then deletes, reporting
  both actions. On a `shared` engine it refuses, since repointing another
  host's picker is hostile.
- **`remi model ls` says what a model is active FOR** (#860) — `engine
  proofread tier` rather than a bare `engine active`. Because that flag belongs
  to a different picker, remi's own model could never carry it and a model remi
  never uses always did, which read as "the engine is ignoring the model I
  chose". It never was: remi passes its configured model explicitly on every
  evaluation.

### Added
- **`remi stop --all`** (#859) stops session daemons as well as the hub.

### Fixed
- **`remi stop` and `remi status` no longer deny that running daemons exist**
  (#859). Both resolved the *hub* only, via `daemon.pid` / `daemon-status.json`;
  session daemons write `status-<PORT>.json`, which nothing enumerated. So
  `status` reported "Daemon is not running" while `remi ls` listed a daemon
  right there. They now report session daemons too, and whatever `remi stop`
  does not stop, it names.
- **`remi kill` can stop a daemon that has stopped answering** (#859). It went
  only over the WebSocket, so a daemon wedged badly enough to ignore its socket
  was unreachable by every remi command and could be removed only with `pkill`
  — which matches on a name and will happily take down something unrelated.
  remi records that daemon's pid itself, so it now falls back to signalling it,
  saying plainly that graceful shutdown was skipped.

## [0.7.2] - 2026-07-27

Makes the engine's version visible and replaceable, and puts the model
commands where you would look for them.

### Added
- **`remi model restart`** (#852) — relaunch the engine on the version remi
  pins. Pinning did not imply running: `EngineHost`'s rule is that ownership is
  about who *starts* an engine, not who holds it, so an engine already answering
  is attached to however old it is, and upgrading remi never upgraded the engine
  it talks to. It refuses to kill an engine remi has no record of starting
  (killing whatever holds the port on a guess is how you take down something
  that mattered), refuses against a shared engine, and reports failure rather
  than success if the relaunched engine is still older than the pin.

### Fixed
- **`remi model status` reports the engine's version** (#852). remi never read
  it: it pinned which helper to *install* and inferred "old engine" from a
  missing field, so it could not tell you what you actually had. It now shows
  the running version next to the pinned one, and when the engine is older it
  names `remi model restart` instead of saying "upgrade the engine to 0.7.8+" —
  advice whose only implementation was a function with no callers.
- **`remi --help` shows the model commands under Auto-Approve** (#850), at the
  top of the section, rather than as the last line of Configuration where a
  user read the whole output and did not find them.
- **Two flaky tests that could silently cancel a release** (#848, #849). Both
  guessed at something the machine decides — one asserted a randomly chosen TCP
  port was free, the other slept a fixed 150ms and then asserted an `fs.watch`
  effect had already happened. Each blocked the 0.7.1 cut once, and a red test
  gate makes `auto-release` *skip*, so the only symptom is a tag that never
  appears. Fixed at the root rather than retried or disabled.

## [0.7.1] - 2026-07-27

Makes `remi model` usable on a fresh install and names models the way you
would actually look them up.

### Changed
- **The engine helper is pinned to yooz-engine 0.7.8** (#843), up from 0.7.7.
  0.7.8 is the first release whose model listings report each model's
  registered HuggingFace repo id, which is what lets remi correlate the id in
  your config to a row in the engine's catalogue. The pin is deliberate rather
  than "latest": a daemon that silently picks up a new engine is a daemon whose
  behavior changed without anyone choosing it.

### Fixed
- **`remi model` no longer needs a daemon to exist first** (#843). Every verb
  used to probe the port and give up when nothing answered, and nothing in the
  CLI ever *started* an engine — only the daemon did. So on a fresh install
  `remi model pull` failed until you had started a daemon, inverting the order
  anyone would try: fetch the weights, then run. The verbs that need an engine
  now start one themselves, fetching the helper on first use.
  - `status` deliberately does **not** start one: auto-starting an engine to
    answer "is an engine running?" destroys the question. It reports the state,
    the configured model, and what the outage costs you.
  - `use` needs no engine at all. It writes remi's config; gating that behind a
    running engine made the model impossible to configure while the engine was
    down, which is exactly when you are setting one up.
- **`remi model use` accepts a model's registered name** (#843). It required an
  exact match against the engine's canonical ids, so it refused
  `YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx` — the id remi itself ships as the
  default. Either name now works, and an id that *cannot* be checked against an
  older engine's catalogue is accepted with a note rather than refused.
- **Models are named by their registered HuggingFace repo** (#843), not by an
  internal nickname like `yooz-instruct-4b`, so the name you read is the one
  you can look up and type. Needs yooz-engine 0.7.8+, which reports the mapping
  (yooz-engine#308); against an older engine remi shows the canonical id.
- **`remi model rm` no longer blames remi for the engine's active model**
  (#843). It reported any active model as "the active model" and told you to
  run `remi model use <other>` — advice that provably cannot work, because
  `use` writes remi's config and never touches the engine's own picker. It now
  distinguishes the two cases and only suggests the remedy that applies.
- **`remi model status` says "not downloaded" only when it can actually tell**
  (#843), instead of reporting a present, working model as unknown.
- **`remi --help` lists `remi model`** (#843), which was otherwise
  undiscoverable.
- **`bump-version.sh` starts a dev line from any branch but `main`.** It decided
  "is this the dev line?" by testing whether the current branch was literally
  named `develop` — but the workflow forbids committing to `develop` directly,
  so every real bump happens on a feature branch and silently produced a
  *stable* version instead. That is how 0.7.0 shipped with no `-dev` suffix,
  which left `auto-bump-dev` with no counter to increment and `auto-release`
  with nothing to release: a release pipeline that fails by doing nothing.

## [0.7.0] - 2026-07-26

Replaces ollama with the Yooz engine as the local-LLM backend for
auto-approve. The measured result is a faster and safer evaluator: the
default model scores 38/38 on the permission grid with zero unsafe
approvals and a p95 of 2.26s, against 12.2s for the ollama-era default.

### Breaking
- **`auto_approve.provider = "ollama"` is no longer valid** (#809). ollama
  support is removed outright — no compatibility shim and no silent
  fallback — so a config that still names it fails to load with an
  actionable message, and that stops **every** remi command until it is
  edited, not just auto-approve. Change it to `"yooz"` on Apple Silicon or
  `"llamacpp"` on Linux, and set `model` to an id the chosen backend
  serves. If you never enabled auto-approve, nothing changes for you: it
  remains off by default.

### Added
- **Yooz engine transport** (#809): auto-approve talks to the engine's
  `/v1/llm/generate` on remi's reserved loopback port 19924.
- **`remi model`** (#819): `ls`, `ps`, `status`, `pull`, `cancel`, `rm`,
  `cleanup`, `load`, `unload`, `use` for managing the models auto-approve
  runs on. `use` persists your choice; every verb degrades with a clear
  message, in milliseconds, when no engine is answering.
- **Engine supervision** (#818): remi starts its own engine when none is
  running, attaches to one that already is regardless of who started it,
  and repairs after a crash on the next evaluation. The engine is detached
  on purpose — one session quitting must not take auto-approve down for
  the others. Requires `auto_approve.engine_path`; unset (the default), remi
  still attaches to a running engine and reports the gap rather than
  failing silently.
- **The model is fetched at boot when it is absent, and left alone when it
  is present** (#834): so a fresh install does not block its first
  permission on a multi-GB download.
- **Two-stage idle memory policy** (#820): after `cache_idle` (5 min) the
  prompt cache is dropped, after `keep_alive` (30 min) the weights are
  unloaded. Coordinated machine-wide, so ten sessions sharing one engine do
  not evict each other's work.
- **`auto_approve.model_cache`**: where the engine downloads weights, for
  pointing them at an external HuggingFace cache.

### Changed
- **Reasoning is off by default** (#822). Not a tuning preference: measured
  against a 0.8B model, an unsuppressed one spent its whole token budget
  reasoning and returned no content at all, turning every evaluation into
  an error.
- **The backend is chosen by platform** (#822): the engine on Apple
  Silicon, a llama.cpp server on Linux. An Intel Mac can run neither and is
  now told so at boot instead of waiting on an engine that cannot exist.
- **The default model is not a TouchUp tier.** `yooz-quality-v3` also
  reads 38/38, but six of those are responses carrying no verdict at all —
  it echoes the prompt back — and they "pass" only because an unparsable
  response is treated as escalate. The six are `rm -rf /`, a `dd` disk
  wipe, `chmod 777 /etc`, `base64 | bash`, `eval $X`, and a reverse shell.
  Safety by accident is not safety.

### Fixed
- **Neither the cache nor the weights are dropped mid-evaluation** (#827).
  The idle policy claimed a long evaluation kept pushing its deadline out;
  it did not, and a slow evaluation could have its cache pulled out from
  under it. Now tracked explicitly, across daemons as well as within one.
- **`remi model status` reports your model** (#836), not whichever tier the
  engine's picker happens to have active — it could previously say
  "loaded: yes" about a different model entirely.
- **A model named by its HuggingFace id is no longer reported as missing or
  disowned** (#837): the engine accepts both spellings but exposes no
  mapping between them, so remi now says it cannot tell rather than
  answering confidently and wrongly.

## [0.6.24] - 2026-07-25

Finishes the subagent permission story started in 0.6.23: a background
agent's prompt that actually reaches the screen is no longer an automatic
interruption.

### Changed
- **A rendered subagent permission is evaluated, not just parked** (#814):
  0.6.23 stopped evaluating a subagent's permission at hook time, because at
  that point the daemon cannot know whether the prompt will ever reach a
  human — and most never do. That left a gap: a prompt that *did* render
  always interrupted you, even when the configured auto-approve policy would
  have approved it outright. Now, the moment a parked prompt renders on the
  main PTY, the policy evaluates it there: an `approve`/`deny`/`pick` verdict
  is typed straight into the on-screen prompt, with no card and no
  interruption, while an `escalate` verdict still pushes a card to your
  phone carrying the model's summary, exactly as a main-session escalation
  does. An "always allow" option is never auto-picked — persisting a
  permission rule stays your call. Any failure along the way (no service, an
  eval error, an option that can't be identified on screen, a failed inject)
  falls back to asking you rather than guessing.

### Fixed
- **A subagent permission resolved outside Remi no longer leaves a stale
  card** (#814): when a parked permission was resolved outside Remi's own
  answer path — answered directly in the terminal, or inferred from its
  matching tool call having run — the cleanup looked the question up by the
  original hook-time id instead of the id of the prompt that actually
  rendered. `removeQuestion` no-oped and the `question_resolved` broadcast
  named an id no client held, so the card stayed on screen as a phantom, and
  the open-escalation signature leaked along with it. The signature is now
  re-keyed onto the rendered id at push time, so that cleanup path finds it.

## [0.6.23] - 2026-07-25

Background agents stop costing you GPU and stop making decisions in your name,
and the last structural cause of cards reappearing after you answer them is
gone.

### Changed
- **A background agent's permission is never LLM-evaluated** (#807): a
  subagent-tagged `PermissionRequest` now parks for PTY arbitration and returns
  `passthrough` immediately, before the evaluator is reached. Claude blocks on
  the hook response, so at decision time the daemon cannot know whether the
  prompt will ever render — and most never do (a live session logged 16
  subagent permission requests against 2 renders). Every one of those cost a
  GPU-backed LLM call, and each approve/deny verdict was applied to a prompt no
  human saw and no card recorded. Claude's own permission flow now decides:
  either its allowlist absorbs the request silently, or the prompt renders and
  the parked record pushes a card. The PTY, not the hook, decides whether you
  are asked. Evaluating a subagent prompt *after* it renders is #814.

### Added
- **Alerts for flagged background-agent commands** (#807): new
  `[auto_approve] subagent_alert` substring list. One branch of Claude's own
  permission flow allows a call without ever rendering it, so with the LLM out
  of that path nothing would otherwise mention a destructive background
  command. A match fires a dismiss-only notification plus an audit log line.
  This does **not** gate anything — the command runs; it closes the visibility
  gap, not the interdiction gap. Repeats of the same command collapse over five
  minutes, because useful patterns are broad and a banner nobody reads costs
  more than it buys. Defaults are irreversible-only (`rm -rf`, `push --force`,
  `reset --hard`, `DROP TABLE`, `TRUNCATE`, `sudo `, `chmod 777`); broad ones
  like `curl`/`ssh` are opt-in per machine.
- **Opt-in question-lifecycle trace** (#808): `REMI_QUESTION_TRACE=1` appends
  every question add and removal to `~/.remi/question-trace.jsonl` with the
  signal that caused it and whether it went through the `removeQuestion`
  funnel. The earlier phantom-card fixes were reasoned from hook semantics
  rather than live capture, which is why residuals survived; this is the
  capture tool.

### Fixed
- **Answered cards no longer reappear on reconnect** (#808): every attach now
  sends a `question_snapshot` carrying the authoritative live-question-id set,
  including — critically — an empty one when nothing is pending. #798 broadcast
  that snapshot only from `onQuestionsChanged`, and its own comment said the
  point was to resync a client reconnecting into a quiet session; but a quiet
  session is precisely one where nothing changes, so the broadcast never fired.
  Since `question_resolved` is never replayed, a resolve missed while
  disconnected was lost permanently with nothing able to correct the client.
  The re-send was purely additive and structurally could not retract a card.

### Known residuals (#808)
- A question answered by *denial* in the terminal fires no matching tool call,
  so it clears only on the owning agent's next `Stop`/`SubagentStop` — it
  persists while that agent keeps working.
- A card stuck in `submitting` is exempt from pruning indefinitely.
- `StopFailure` still leaves open escalations uncleared (#802).
- LRU eviction at the pending-question cap deletes without firing
  `question_resolved` or the push dismissal.

## [0.6.22] - 2026-07-18

Two big interaction-model changes from hands-on hub testing — the macOS app
becomes a real citizen of the desktop, and sessions stop pretending only one
device is allowed to talk — plus the end of phantom question cards.

### Added
- **macOS app shows in the Dock while its window is open** (#785): hybrid
  activation policy — opening the window adds the app to the Dock and
  Cmd-Tab, closing the last window returns it to menu-bar-only. Launch stays
  Dock-free; closing the window still never quits anything (#651).
- **Native macOS notifications for pending questions** (#786): session
  daemons mirror their pending questions into the live-sessions registry,
  the hub aggregates them into `hub_status`, and the menu-bar app posts one
  notification per new question (withdrawn automatically when the question
  is answered anywhere; clicking opens the window). Follow-up: surface the
  authorization-denied state in Settings (#793).
- **Needs-attention menu-bar icon state** (#787): while any question is
  pending the "r" glyph inverts (filled rounded square, knocked-out r),
  taking precedence over the client-connection states, and reverts on
  answer.
- **Hub autostart indication** (#788): the hub self-reports whether its
  `remi --install` LaunchAgent/systemd unit is installed via `hub_status`;
  Settings shows the state and the menu warns when the hub is running
  without autostart. Job-health verification (beyond file presence) is
  tracked in #791.
- **`question_snapshot` protocol message** (#798): the daemon broadcasts its
  authoritative live-question id set on every change, and clients prune any
  displayed card not in it — a self-healing backstop for the whole
  phantom-card bug family.

### Changed
- **The session exclusive write lock is gone** (#795): any connected
  non-query client can send input — no more one-client-per-session, FIFO
  queueing, or "read-only: another device is attached." The remotely-created
  session lockout (the creating phone racing every other client for the
  lock and losing) disappears with it. Safety moved to where it belongs: a
  per-session serialized PTY write queue (the missing piece when this was
  last attempted and reverted), verified by a regression test that fails
  without it. The raw terminal stream now reaches every attached client;
  resize is last-writer-wins; query mode remains the read-only monitor mode.

### Fixed
- **Phantom question cards** (#798, #799): two converging root causes.
  Client side, every reconnect replayed recent history and resurrected
  long-answered questions as fresh cards stamped "Just now" — replayed
  questions are now gated (parity with the terminal client's #753 fix),
  cards reconcile against the live snapshot, and a stale answer force-clears
  its named card instead of sticking at "Answering…". Daemon side,
  subagent/teammate permissions answered in the terminal never left the
  pending store (feeding phantoms to reconnect resends, the hub census, and
  lock-screen pushes): parked subagent escalations now register agent-scoped
  signatures, tool advancement resolves them, and terminal-denied questions
  clear on Stop/SubagentStop — always through the full resolution funnel so
  the broadcast, APNS dismissal, and hub mirror stay in sync. Conservative
  residual for StopFailure tracked in #802.

## [0.6.21] - 2026-07-17

Housekeeping release: TestFlight build 6 (macOS + iOS) version bump and
`.context` documentation pruning with ADR backfill. No runtime changes.

## [0.6.20] - 2026-07-10

App-polish follow-ups from the first TestFlight round: the macOS app learns
to onboard users onto a hub, and every client finally follows the system
light/dark appearance live.

### Added
- **macOS hub setup onboarding + Settings** (#773): when no hub is found, the
  main window now shows a native setup panel (install remi, `remi start`,
  `remi --install` as the hub's login item — each with a copy button and a
  "Check Again" rescan) instead of a bare copy-command menu item, and a
  "Set Up Hub…" menu entry opens it. A new Settings window (Cmd-,) keeps the
  two login-item concepts side by side but distinct: the APP at login
  (SMAppService toggle) and the HUB at login (the `remi --install`
  LaunchAgent, which the sandboxed app cannot install itself). Once a hub has
  been seen, the web view stays mounted across transient disconnects instead
  of being torn down; manual rescans cancel the pending backoff instead of
  stacking probe timers.

### Fixed
- **System theme changes now apply live** (#778): the web client sampled
  `prefers-color-scheme` once and never listened for changes, so a running
  app (especially the macOS/iOS shells, which stay open for days) kept the
  stale theme after the OS flipped appearance. A `matchMedia` change listener
  now re-applies the effective theme while the setting is "system", the iOS
  status-bar style re-syncs on every theme change, and the theme value is
  validated at the localStorage boundary. Fixing this also removed a latent
  bug where a dark OS preference could override an explicitly chosen Light
  theme's status-bar style.
- **npm publish pinned to npm 11** (#775/#776): npm 12.0.0 (released
  2026-07-09) ships without the `sigstore` module its own provenance path
  requires, which broke the v0.6.19 npm publish twice; the release workflow
  now pins `npm@11`.

## [0.6.19] - 2026-07-09

The hub release: `remi serve` / `remi start` become a session-less supervisor
and macOS gets a native menu-bar app (epic #648). Alongside it, a second
agent-team soak round (epic #757) fixes subagent question routing, duplicate
lock-screen answer notices, and what a terminal attach can see.

### Added
- **Terminal attach shows the status strip** (#754, #755): the daemon now
  broadcasts its status snapshot (`remi_status`) to connected clients on every
  flush, and `remi attach` draws the same reserved-row bar the wrapper shows
  (`repo:branch | attached | executing`). Both the bar and the Claude
  statusline replace the blunt "1 client" with `attached` /
  `attached (+N waiting)`, read from the exclusive PTY slot and its FIFO
  queue. The bar is drawn client-side: the attaching `remi` must also run
  this version.
- **Pending questions visible in `remi attach`** (#753): attaching to a
  session with a held question now prints a banner (question, options, and
  "answer on your phone, or run `remi unstick`") instead of a silently stuck
  terminal, and the daemon re-sends the authoritative pending set on attach,
  resume, and queue promotion so no surface misses it. Only held questions
  banner (the native prompt covers the rest), and an "answered" line confirms
  resolution.
- **macOS TestFlight pipeline** (#658 phase 2, epic #648):
  `bun run testflight:macos [-- --upload]` mirrors the iOS local path —
  stages the web UI, archives, exports a signed Mac App Store `.pkg`, and
  uploads via `altool -t macos`. Shared `config/app-release.json` version
  line now stamps BOTH Xcode projects (project regeneration re-stamps
  automatically), and the app gains its icon.
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

### Fixed
- **Orphan prompt routing survives subagent eval streams** (#767): the
  eval-in-flight buffer (#484) treated ANY auto-approve eval as owning the
  prompt cycle, so on sessions with back-to-back subagent evals every
  hook-less rendered prompt (agent-team teammate permissions, MCP dialogs,
  #751 parked renders) was captured and silently discarded by the next
  unrelated approve — questions never reached the phone. The buffer window is
  now opened only by main-context evals (counted, so concurrent evals cannot
  close each other's window), parked renders are matched before any buffering,
  and the previously invisible park/buffer/expiry decisions are logged.
- **Subagent permission questions are PTY-arbitered** (#751, #763): the
  auto-approve gate no longer holds-and-pushes subagent-tagged escalations
  blindly — it parks the question and passes the hook through, and the push
  fires only if Claude actually renders the prompt on the PTY. This kills
  both agent-team failure modes from the soak: background/subagent questions
  phantom-routed to the phone (the lead was going to answer them anyway) and
  real prompts never surfaced. Parked records are scoped to their owning
  agent (#763) — another agent's status churn can't expire them; they clear
  on the owner's own progress, a render, or a 120s TTL.
- **Duplicate lock-screen answer deliveries deduped** (#752): one tap can
  reach the daemon up to three times (native POST, in-app WebSocket,
  signaling relay). A TTL idempotency cache now recognizes replays across
  every spelling of the same answer (option value, label, AUQ selections),
  so a successfully applied answer no longer triggers a follow-up "couldn't
  deliver" push, and a replay can never inject into the live PTY.

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
