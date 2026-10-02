# Strategy: retire the local judge, become a reliable multi-harness control plane

Date: 2026-10-01 (revision 2, same day).
Status: owner decisions D1, D2, D3a, D5 made; D8 (license) decided 2026-10-01 and implemented in #1128 (Apache-2.0 core, PolyForm Shield apps and relay); phase-0 hotfix is PR #1122.
Companion documents: [competitive-review-2026-10.md](competitive-review-2026-10.md) (feature matrix and positioning).
Sources: `develop` at `3a5e8b27`; installed Claude Code 2.1.287 and Codex 0.159.1; Codex source at tag `rust-v0.159.1`; OpenCode source at v1.18.34; vendor docs; an independent second opinion (Fable advisor) that spot-checked the load-bearing claims.
Claims not verified live are marked "(unverified)".

## 1. Summary

1. **Retire the local large language model (LLM) judge and the deterministic rule layer** (D1, decided). Each harness's first-party approval decides; remi relays what is still asked, plus turn ends and denials.
2. **Compete on reliability, not breadth.** At least six free tools already claim "multi-harness, multi-machine, local-first" (competitive review). remi's wedge is: every prompt reaches the phone, every answer lands, for users the vendors exclude (API keys, Bedrock, Vertex, gateways, zero-retention orgs), with no vendor in the path on direct connections.
3. **Move to structured control planes and stop parsing TUIs.** Codex app-server, OpenCode's HTTP server, and Claude hooks plus `claude agents --json` plus the transcript. The PTY becomes a byte pipe for the local terminal.
4. **Rebuild the relay on the right unit** (D5, decided to finish it): one long-lived end-to-end encrypted (E2E) room per machine, not ten fixes to a per-process design.
5. **Native SwiftUI apps come after the protocol is frozen**, not before.

## 2. Owner decisions (2026-10-01)

| | Decision | Status |
|---|---|---|
| D1 | Delete the LLM judge **and** the rule-matching layer | Decided |
| D2 | `remi codex [args]`, `remi opencode [args]`; `remi` alone stays Claude; `remi -c` keeps passing `--continue` to Claude | Decided |
| D3 | Prompts show in the terminal immediately; answering from the phone is possible but not the default mode; prefer hooks/structured answers over keystrokes | Decided; Claude mechanism in D3a |
| D5 | Finish the relay; Tailscale stays a documented option, not the requirement | Decided; see section 8 for "rebuild, don't patch" |
| D6 | Keep and improve multi-choice cards (AskUserQuestion) in notifications; fix answers dropped from notifications and the Watch | Decided |
| D7 | Later: native SwiftUI Mac and iOS apps built in Xcode, UX on par with OpenAI's apps and Conductor | Decided, sequenced after protocol freeze |
| D3a | Claude prompts: hold the hook, let Claude's own dialog show, answer from the phone through the hook response | Decided 2026-10-01 as a remi-drawn prompt; revised 2026-10-02 after the live spike (see D3a) |
| D8 | Open core: open-source the daemon, CLI and shared protocol (like OpenCode); keep the native Mac app, mobile app and hosted relay under PolyForm Shield as the first-class products | Decided 2026-10-01: Apache-2.0 core (`packages/daemon`, `packages/shared`), PolyForm Shield for `packages/web`, `packages/signaling` and `packages/macos`; implemented in #1128 |

### D3a (revised 2026-10-02: held hook, native dialog)

On Codex and OpenCode, "show in the terminal now" and "answer structurally from the phone" are compatible: both harnesses let a second client answer the prompt the terminal is showing, first answer wins, and the terminal dismisses its prompt.

**Correction (2026-10-02).** Revision 1 of this document said that on Claude the two were incompatible, because "nothing outside Claude can answer the native dialog once it is on screen" and "holding the hook keeps the native dialog from rendering". Both claims were wrong; they came from desk research and remi's own Model B comments, not from a test. A live spike on Claude Code 2.1.287 (results on #1126) showed that the native dialog renders about 0.1 s after the `PermissionRequest` POST while remi holds the hook, in both renderers, and that the held hook's later `allow`/`deny` resolves the dialog already on screen. A local answer also works: first answer wins, and a local "No" aborts the held HTTP request.

So Claude is compatible too, and the remi-drawn prompt chosen on 2026-10-01 is unnecessary. Decision: hold the hook, let Claude's own dialog show, and let the phone answer through the hook response (Phase 3, #1126; AskUserQuestion and ExitPlanMode in Phase 4, #1127). Typing digits into the PTY is retired for permission prompts; the spike also showed why it is dangerous: a card numbered from the hook's suggestions disagreed with the screen, and a phone "No" typed an out-of-range digit whose trailing Enter confirmed "Yes" (P0 hotfix against develop).

## 3. Why retire the local judge

| Evidence | Source |
|---|---|
| LLM layer approves 87 of 275 operations it evaluates (31.6%) | `.context/approval-rate-baseline-2026-08.md` |
| Escalation p50 5.3 s, p95 25 s; MacBook Air approve p50 9.4 s and 498 engine-timeout errors | same |
| Deterministic coverage of real main-agent commands: 12.9% | #996 |
| `auto-approve/` is 22,920 of 65,007 daemon source lines; its tests 34,766 of 91,924 | `wc -l` |
| 116 of 154 non-release commits since 2026-08-01 touched it | `git log` |
| Security bugs from acting as a second judge: #536 (P0), #1060, #1063, #1001, #997, #1014 | issues |

The owner already relies on first-party approval: Claude `autoMode` plus `permissions.deny`, Codex `approvals_reviewer = "auto_review"`.
Claude auto mode is the starting mode since 2.1.283 on supported models, so on Claude the permission residue is small; **AskUserQuestion and plan approval become the main Claude interactions**, which is why D6 is ranked high.

## 4. What is deleted, what stays

**Delete** (several atomic PRs after a superseding ADR): LLM evaluation core (~8,400 lines), engine and provider plumbing (~2,900), `remi model` (~1,160), deterministic matching (~7,800), the LLM half of `auto-approve-gate.ts`, the tracker's eval buffer and arbiter, `[auto_approve]` LLM keys and their 33 environment variables, ~33,000 test lines; about 40 open issues close as moot.
remi stops depending on yooz-engine (no 2.4 GB first-run download, #834; port 19924 freed).

**Keep:** hook server and config, hook event normalization, hold-the-hook as a transport (ADR 0002), the gate's non-LLM half (renamed to a permission relay), question store, push, answer path, turn-complete push, transports, hub, PTY.
Also keep `subagent-alert.ts` (164 lines, informational, the only visibility path for silently handled subagent work) and the latency and coverage telemetry used to measure this pivot.

**Add:** a one-shot `remi migrate-permissions` that prints a user's remi allow list as Claude `permissions` JSON, and a boot warning for leftover `[auto_approve]` keys.
**Audit:** the surviving tests. The pinned tracker test that encoded "the gate always pushes" shows some tests still carry the deleted layer's assumptions.

## 5. Phase-0 findings (bugs)

| Finding | Status |
|---|---|
| Default install (auto-approve off): binary main-agent prompts never reached the phone | Fixed by #1121 (push on render), then superseded by #1126 (PR #1143): binary prompts are held and pushed at hook time, answered through the hook; verified live |
| Claude fullscreen default (users since 2026-05-06) vs remi's inline assumption; owner's `"tui": "default"` masks it | Fixed in #1124 (PR #1133): the Claude child gets `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` unless the user set a non-empty value |
| Hub resume runs Claude inside the hub process (`cli.ts:1694`, no `serveMode` guard; corroborated by the advisor) | Fixed in #1124 (PR #1133): the hub refuses resume (`UNSUPPORTED`) and never runs Claude; spawning a child daemon instead is #1129 |
| ExitPlanMode labels in `hooks/tool-question.ts` have drifted from current Claude docs | Fixed in #1127: the labels are deleted; ExitPlanMode is held and answered with a structured `updatedInput` by meaning (section 6) |
| New sessions go to the first-connected socket; no machine object; socket per session | Open: section 9 |

## 6. Claude Code: hooks, `agents --json`, transcript

| Today from PTY parsing | Replacement | Confidence |
|---|---|---|
| Prompt on screen | `claude agents --json`: `status: "waiting"`, `waitingFor: "permission prompt" \| "sandbox request" \| "dialog open"` (documented; 0.21 s). Not the `Notification` hook, which fires ~6 s later | Medium-high |
| Prompts with no hook | `Elicitation` hook for MCP forms; sandbox network, trust and model prompts become a "needs you at the terminal" card | Medium |
| AskUserQuestion keystroke driver | Shipped in #1127: a held `PermissionRequest` (not `PreToolUse`, so Claude's dialog stays visible) returning `allow` + `updatedInput: {questions, answers}`; the driver is deleted | High, verified live (spike E3, #1127 run) |
| ExitPlanMode digit order | Shipped in #1127: a held `PermissionRequest` returning `allow` + `updatedInput` (the input echoed; a bare `allow` is ignored) + a session `setMode`, or `deny` with a message | High, verified live (spike E4, #1127 run) |
| Status, errors, turns | `UserPromptSubmit`, `PreToolUse`, `PostToolUse(Failure)`, `Stop.last_assistant_message`, `StopFailure`, transcript `promptId` | High |
| No hook server | Pass hooks with `claude --settings '<json>'` instead of writing `.claude/settings.local.json` | Medium |
| Answering Claude's native dialog | A held `PermissionRequest` hook's later `allow`/`deny` resolves the dialog on screen (verified live 2026-10-02); first answer wins | High |

Not recorded in the transcript: that a prompt was shown, which option was picked, or what is pending.
The Agent SDK and its ACP adapter stay ruled out: Anthropic forbids third-party apps on the Agent SDK from offering claude.ai login.

## 7. Codex and OpenCode

### Codex: the app-server, not hooks

- **The "tucked-in" questions** are `request_user_input_async`: the model gets `{"accepted": true}` at once, the question prints as an ordinary message, and the form stays collapsed (`? N question(s) · ⇧← to answer`); unanswered questions vanish at turn end. The owner's own rollouts show 97 async questions and 35 replies. Subagent approvals are similarly hidden behind `/subagents`. No hook and no server request exists for async questions.
- **Hooks are the wrong channel for decisions:** command handlers only (no HTTP), a trust hash per hook, no hook for questions or elicitation, and `PermissionRequest` runs **before** Guardian auto-review, so it fires for things Guardian would approve.
- **The app-server is the right channel:** every client subscribed to a thread receives the same server requests (exec, file, permissions approvals; `requestUserInput`; elicitation), the first answer wins, and all subscribers receive `serverRequest/resolved`, which closes the TUI's overlay. remi attaches through the shared daemon socket with `thread/resume {excludeTurns: true}`; subagent threads subscribe automatically. Async questions can be answered with `turn/steer` or `turn/start` carrying the reply wrapper (unverified live). Guardian denials can be retried with `thread/approveGuardianDeniedAction`.
- **Constraint:** any `-c` override, most `--enable/--disable`, `--profile`, `--strict-config` or `--dangerously-bypass-hook-trust` makes the TUI run its own embedded server remi cannot reach. remi spawns `codex --no-alt-screen` with no overrides; anything remi needs goes through `config.toml` or the environment.
- **Chat view:** rollout JSONL under `~/.codex/sessions/`, paginated, typed items. Approvals and questions are not written there.

### OpenCode: the HTTP server (deferred, recipe ready)

`opencode serve` with a remi-generated `OPENCODE_SERVER_PASSWORD` (without it any local process can answer permissions), `opencode attach` in the PTY before the first prompt, `permission.asked` / `question.asked` over Server-Sent Events, HTTP replies (first reply wins; the second gets 404; `permission.replied` dismisses the TUI), re-list pending after every reconnect (no event replay).
Defaults are permissive (`"*": "allow"`), so remi should offer an "ask on bash/edit" preset through `OPENCODE_PERMISSION`, which also covers subagents.
Two reply surfaces exist (a v1 route and a v2 `/api/session/:id/permission/:requestID/reply` route); confirm which the installed version serves before building on it.
OpenCode accepts any OpenAI-compatible endpoint, so it is the home for large local models.

## 8. The cross-harness model

One object for every "the agent needs you" moment:

```
Decision {
  id, harness, harnessSessionId, agentId?,
  kind: permission | question | plan | sandbox | trust,
  options[], optionsAreFallback,
  localRender: harness | remi | none,
  answerPath: structured | keystroke | none,
  resolvedBy: terminal | phone | lockscreen | harness | timeout
}
```

Invariants: the first answer wins everywhere; remi never answers by guess; for Codex and OpenCode the harness is the arbiter of record; remi's hold is only for Claude; decisions never come from transcripts (chat does).

| Harness | Learn it exists | Show locally | Answer from phone |
|---|---|---|---|
| Claude | `PermissionRequest` hook (held) | Claude's own dialog, immediately (D3a) | Hook response |
| Codex | App-server server request; async questions from `item/completed` | Codex's own overlay (inline mode) | JSON-RPC response; `turn/steer` for async questions |
| OpenCode | `permission.asked` / `question.asked` | OpenCode's own prompt via `attach` | `POST` reply |

## 9. Relay: rebuild on the right unit

Today's relay is a WebRTC signaling server repurposed as a transport: one room per process (hub and every child), codes printed only to logs, rooms that expire after 5 minutes and close both peers, no ping handling (idle connections reaped in ~60 s), E2E built daemon-side only and engaged only with an authenticator that a default install never has, no client half, raw PTY bytes forwarded that the phone discards, lock-screen answers that kill a live encrypted peer, and no end-to-end test.
Target shape:

1. One long-lived room per **machine**, owned by the hub; children run `--no-relay`; the hub proxies session-targeted frames to children over loopback, authenticated with the capability token (#869).
2. Identity and keys always on for the relay; keys exchanged at QR pairing; trust-on-first-use gated by the pairing secret.
3. Every frame AES-GCM; the Worker sees routing and ciphertext only; raw PTY never relayed (also the cost fix: Durable Object wall-clock is the cost driver).
4. **Push privacy:** push carries a room id and an opaque question id; the body is encrypted under the pairing key and decrypted in a Notification Service Extension, or fetched over the E2E channel. Required for a "sovereign" brand.
5. Lock-screen and Watch answers go through the relay (#612, #875), fixing D6's dropped answers off-network.
6. A real end-to-end test: real Durable Object, real daemon adapter, real client, session alive past 5 minutes, Worker sees only ciphertext.

Before building: spend a day reading Paseo's relay (Apache-2.0, license-compatible); adopt its framing if it is a generic E2E pipe, which also gives interoperable self-hosting.
Tailscale and SSH stay documented as the zero-server path.

## 10. Sequencing (next ~6 weeks)

1. **Week 1:** land and live-verify the hotfix in both Claude renderers; set `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1`; fix hub resume; live spike of held hooks, AskUserQuestion and ExitPlanMode (done 2026-10-02, results on #1126).
2. **Weeks 2-3:** superseding ADR, then atomic deletion PRs; migration printer; boot warning; test audit; close the moot issues with one linked comment. Implement held-hook answers for permissions (Phase 3) and for AskUserQuestion and ExitPlanMode (Phase 4).
3. **Weeks 3-4:** harness seam with Claude as the only implementation (zero behavior change); the `Decision` object; `harness` + `harnessSessionId` with a compatibility shim; `create_session_request` gains `harness` and `args`.
4. **Weeks 4-5:** Codex via the app-server, after a live spike of first-answer-wins and overlay dismissal. Done when a Codex approval reaches the phone, the phone's allow runs the command, and the TUI overlay closes.
5. **Weeks 5-6:** relay rebuild, minimum viable: hub endpoint, per-machine room, always-on E2E, push privacy, no raw PTY. QR polish and `remi attach --code` later.

Deferred past week 6: OpenCode, the SwiftUI rewrite, Android, voice.
Protocol freeze before SwiftUI: harness-neutral session identity, the `Decision` object, a machine object, relay framing.

## 11. Metrics and kill criteria

Measure weekly on the owner's own use: hook-to-card p50/p95; cards shown vs prompts rendered (target 100% of main-agent prompts); answers applied vs sent; relay session uptime (target over 1 hour without a reap); commits touching `auto-approve/` (target 0 after week 3); open-issue delta.

- If after phases 1-2 hook-to-card p95 exceeds 3 s or more than 1% of answers drop, stop adding harnesses and fix reliability.
- If Codex needs any TUI parsing, stop and use the app-server only.
- If the relay is not always-on E2E after two focused weeks, ship SSH and Tailscale with the single-port hub and revisit.

## 12. Positioning and license

Positioning statements and claims to avoid are in the competitive review.

License (D8): open core.
The daemon, CLI and shared protocol become OSI open source under Apache-2.0 (decided: patent grant, same as Paseo; OpenCode uses MIT); the native Mac app, mobile app and hosted relay stay PolyForm Shield.
Consequences to handle:

- The open protocol means anyone can self-host a relay or write a client; that is a selling point, not a leak, as long as the first-class apps and the hosted relay are better.
- The package boundary must match the license boundary: `packages/daemon` and `packages/shared` open; `packages/web` (today's mobile client) and `packages/signaling` (the relay) PolyForm. Per-package `LICENSE` files work in one repo; a repo split is cleaner later.
- `AGENTS_master.md` says public Yooz repos use PolyForm Shield; it needs an exception for remi's core. `CONTRIBUTING.md` (contributions under PolyForm, DCO) needs a per-package statement.
- Copyright is clean: every code commit is the owner's or the release bot's; the only outside contribution is a README edit (PR #568), which can be rewritten or re-licensed with a one-line ask.
- Relicensing to Apache-2.0 cannot be revoked for the versions published under it; decide before the first tagged release that carries it.

## 13. Unverified

- Settled by the 2026-10-02 spike (#1126): a held hook does NOT suppress the native dialog; `waitingFor` reads "permission prompt" during a held hook; AskUserQuestion answers through both `PreToolUse` and `PermissionRequest` `updatedInput`; ExitPlanMode needs `updatedInput` plus `setMode`, with option 1's mode model-dependent.
- Still open: whether `PermissionRequest` fires in auto mode for actions the classifier then approves; subagent prompt rendering under a held hook; whether echoing an "always" suggestion persists the rule.
- Codex: first-answer-wins and overlay dismissal live; `turn/steer` answering async questions; the exact override list that forces an embedded server.
- OpenCode: which reply route the installed version serves; TUI behavior when a request is aborted.
- remi under API-key, Bedrock or gateway auth.
