# Handoff — 2026-07-10

State of the world after the 0.6.20 release day. Decisions live in
`.context/decisions/` (ADRs 0001-0008); this file is the working snapshot.

## Where things stand

- **v0.6.20 is latest everywhere**: npm @latest, Homebrew tap, GitHub
  release binaries. v0.6.19 (hub release) and v0.6.20 both published
  2026-07-09/10; the npm 12 sigstore regression is pinned away (ADR 0007).
- **TestFlight build 6 (v0.1.0)** uploaded for BOTH macOS and iOS
  2026-07-10, internal testing. Carries 0.6.20 code: hub setup onboarding
  (#773) and live system-theme following (#778).
- **Epics #648 (hub) and #658 (TestFlight) are CLOSED.** The macOS app is
  attach-only by design (ADR 0005).
- **Issue sweep 2026-07-10**: 53 merged-PR-referencing open issues
  code-verified; 22 closed with evidence comments, 31 confirmed open with
  fresh file:line statements of what remains (see the closing/triage
  comments on each issue).

## User-side verification pending

- Restart any long-running daemons so they pick up >= 0.6.19-dev.15 code
  (older ones eat multi-agent questions; brew now has 0.6.20).
- TestFlight build 6, both platforms: flip system light/dark with the app
  open — UI and status bar should follow without relaunch (#778).
- macOS app: with no hub running, the window should show the new setup
  panel; "Check Again" after `remi start` should connect within a second.
- #665 on-device checklist (Watch / cold-launch lock-screen answers) is the
  only thing keeping that issue open.

## Prioritized backlog

### Important — real bugs first

| Issue | What remains |
|---|---|
| #375 P0 | Ctrl+Z fg-loop; root cause known (suspend-handler stdin listener never re-attached) |
| #536 P0 | Default allow-list substring-matches Bash ("rm -rf Readme" auto-approves) |
| #535 P0 | Loopback WS: no Origin check, no per-message auth; blocks #747 |
| #534 P0 | Remainder: daemon_error message, dying-gasp push, FSWatcher .on('error') sweep (transcript-watcher.ts:190,239 unguarded) |
| #538 P1 | General terminal-answered question pruning (only AUQ subset done; stale-answer PTY injection still possible) |
| #612 P1 | relayAnswerViaSignaling has ZERO callers — connection-independent answer path unwired |
| #741 | New push paths skip refreshDeviceTokens (removed tokens still pushed) |
| #705 | Two message-wipe sites bypass the resync survivor stash (web) |

### Low-hanging fruit — small, safe, scoped

- #497 docs-only remainder (AGENTS.md section on sync decisions + groups) —
  closes #497 AND epic #494
- #562 delete vestigial [terminal] config keys
- #742 fix hook-types.ts comment citing disavowed cc-ref (ADR 0006)
- #700 remove dead shadow mode from TranscriptBinder
- #473 Telegram bot.start unhandled promise + sibling nit
- #369 symmetric non-loopback auth-challenge test (test-only)
- #207 wire the detach notice to the active client (protocol already exists)
- #598 re-verify ExitPlanMode option order against 0.6.20-era Claude Code
- #395 / #704 / #707 / #709 / #769 — contained one-file hardening fixes
- #659 recommend closing as stale (Xcode Cloud checklist; ADR 0008 path won)

### Blocked / gated / by-design open

- #747 blocked on #535. #603 epic waits on #612/#620. #548/#647 epics close
  as subs land. #470 = HookRouter tracker. #598 recurring by design.
- #665 waits on the on-device checklist (user).
- CI flakes #528/#532/#725/#772 — tripped three times today on doc/version
  PRs; #772 (cross-suite port contention) is the one worth fixing soon.

### Feature backlog (when wanted)

#447 new-session host picker; #643 editable session names + resume-by-name;
#234 iOS image attach; #233 iOS keyboard shortcuts; #276/#575 Live
Activities + background (research kept in
`.context/native-ios-live-activities-guide.md`); #540/#541 auto-approve UX;
#546 yooz-engine AA provider; #552/#555 permission packs / strict JSON
(research summarized in #552); #620 GPU semaphore; #756 subagent-policy
design (ADR 0004 tail); #69 relay attach; #735 held-question terminal cue;
#729 log-hygiene remainder; #371 update banner; #253 settings toggle; #298
(check overlap with shipped #591 before working); #176 subagent summaries;
#17/#106/#108/#109 old umbrellas — retriage before touching.

## Context-directory map (post-prune, 2026-07-10)

- `decisions/` — ADRs 0001-0008 + template. New decisions go here.
- `handoff.md` — this file.
- `plan.md` — pointer stub to this handoff.
- `notification-and-session-flow.md` — flow diagram referenced by AGENTS.md;
  PARTIALLY STALE (pre-Model B in places); refresh against ADR 0002 before
  trusting details.
- `auq-tui-interaction-model.md` — current AUQ TUI ground truth (#654/#661/#675).
- `native-ios-live-activities-guide.md` — research for open #276/#575.
- `ideas.md`, `research.md`, `scratch_history.md` — standard slots; historical.
- Deleted 2026-07-10 (content captured in ADRs/issues): epic docs for
  #494/#571/#603/#624/#648, refactor-453 trilogy, robustness proposal,
  platform-review-2026-06-09 (lives in #534-#547), cc-architecture-reference
  (cc-ref disavowed), lockscreen relay specs, streaming-messages plan,
  cleanup-audit, message-routing-trace, aa-investigation-findings.json,
  plan-773/648, live-testing-handoff.
