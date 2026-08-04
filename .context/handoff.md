# Handoff — 2026-07-28

State of the world after the 0.7.3 release.
Decisions live in `.context/decisions/` (ADRs 0001-0008); this file is the working snapshot.
Superseded development journals moved to `.context/archive/` on this date.

## Where things stand

- **v0.7.3 is latest everywhere**: npm `@latest`, Homebrew tap, GitHub release binaries.
  `develop` is on `0.7.4-dev.1`.
  The release pipeline is fully automated now (auto-bump-dev, auto-release, sync-develop; ADR 0007),
  and 0.7.2 was the first cut that fired with no manual re-run.
- **Ollama is retired** (epic #809, shipped across 0.7.0/0.7.1).
  Local evaluation runs against the Yooz Engine helper on `127.0.0.1:19924`,
  pinned to `v0.7.8`, default model `YoozLabs/Qwen3.5-4B-qat-lean-4bit-mlx` (2.4 GB, fetched from HuggingFace).
  `provider = "ollama"` in a config now fails every command; that path is gone, not deprecated.
- **Subagent permissions are decided by the PTY** (ADR 0004, #807 then #814).
  Nothing is evaluated at hook time; a request is evaluated only if the prompt actually renders.
- **The per-session exclusive lock is gone** (#795).
  Any attached client can write; safety comes from the per-session serialized PTY write queue.
- **Field report epic #861** covers everything 0.7.2 surfaced in real use.
  #859, #860 and #856 shipped in 0.7.3; #845, #855, #834 and yooz-engine #316/#317 remain.
- **Repo cleanup 2026-07-28**: the `remi-811` worktree removed, 81 remote and 18 local branches deleted
  (all content verified present in `develop` first), leaving only `main` and `develop`.

## Verified live on this date

Running 0.7.3 from a fresh install, against a live engine:

- `remi status` correctly enumerates 5 session daemons by pid, port and name, with no hub running.
- `remi model status` reports engine 0.7.8 reachable and owned, model loaded and on disk,
  and names the engine's proofread tier separately as not used by remi.

## Prioritized backlog

### Important — real bugs first

| Issue | What remains |
|---|---|
| #536 P0 | **Re-verified live 2026-07-28.** `pattern-matcher.ts:37` substring-matches bare tool-name allow entries against Bash command strings. Under the shipped default `allow: ['Read','Glob','Grep']`, `rm -rf Readme`, `rm -rf ~/Documents/Reading` and `python Read_data.py && rm -rf /tmp/x` all approve at 0ms with no LLM eval. Any user-added Bash entry is worse: `allow: ['git status']` approves `git status; rm -rf ~`. The comment at `config.ts:220-224` claims the opposite |
| #535 P0 | **Re-verified live 2026-07-28.** `websocket-server.ts:242` calls `server.upgrade` with no Origin validation; loopback peers are auth-exempt and there is no per-message authorization. Any local process, or a website the user visits, can answer permission prompts. Blocks #747 |
| #534 P0 | Remainder only: `process-guards.ts` shipped (PR #727). Still owed: the `daemon_error` protocol message, the dying-gasp APNS push, and the FSWatcher `.on('error')` sweep (`transcript-watcher.ts:190,239` unguarded) |
| #375 P0 | Ctrl+Z fg-loop; root cause known (suspend-handler stdin listener never re-attached) |
| #538 P1 | General terminal-answered question pruning. The AUQ subset landed and #798/#799 covered the phantom-card paths; confirm what is left before working it |
| #612 P1 | `relayAnswerViaSignaling` has zero callers; the connection-independent answer path is unwired |
| #845 | Nothing reclaims superseded engine helpers in `~/.remi/engine/<tag>` (~103 MB each); `remi model restart` accumulates them faster |
| #855 | Fixed-sleep-then-positive-assertion pattern still in four test files; this shape caused the flakes that silently cancelled two releases |
| #741 | New push paths skip `refreshDeviceTokens`, so removed tokens are still pushed |
| #705 | Two message-wipe sites bypass the resync survivor stash (web) |

### Low-hanging fruit — small, safe, scoped

- #497 docs-only remainder (AGENTS.md section on sync decisions + groups), which closes #497 and epic #494
- #562 delete vestigial `[terminal]` config keys
- #742 fix `hook-types.ts` comment citing disavowed cc-ref (ADR 0006)
- #700 remove dead shadow mode from `TranscriptBinder`
- #473 Telegram `bot.start` unhandled promise + sibling nit
- #369 symmetric non-loopback auth-challenge test (test-only)
- #207 wire the detach notice to the active client (protocol already exists)
- #598 re-verify ExitPlanMode option order against current Claude Code
- #395 / #704 / #707 / #709 / #769, contained one-file hardening fixes
- #659 recommend closing as stale (Xcode Cloud checklist; the ADR 0008 path won)

### Blocked / gated / by-design open

- #747 blocked on #535.
  #603 epic waits on #612/#620.
  #548/#647/#861 epics close as their subs land.
  #470 is the HookRouter tracker.
  #598 is recurring by design.
- #665 waits on the on-device checklist (Watch and cold-launch lock-screen answers).
- #834 (first-run 2.4 GB model download) is coupled to yooz-engine #316:
  release artifacts are signed but not notarized, which is latent only because remi's `fetch()` never sets the quarantine attribute.
- CI flakes: #532 and #725 are closed; #528 and #772 remain, and #772 (cross-suite port contention) is the one worth fixing soon.

### Feature backlog (when wanted)

#447 new-session host picker;
#643 editable session names + resume-by-name;
#234 iOS image attach;
#233 iOS keyboard shortcuts;
#276/#575 Live Activities + background (research in `.context/native-ios-live-activities-guide.md`);
#540/#541 auto-approve UX;
#546 yooz-engine auto-approve provider;
#552/#555 permission packs / strict JSON;
#620 GPU semaphore;
#756 subagent-policy design (ADR 0004 tail), with #830/#831/#832 as its current children;
#69 relay attach;
#735 held-question terminal cue;
#729 log-hygiene remainder;
#371 update banner;
#253 settings toggle;
#298 (check overlap with shipped #591 first);
#176 subagent summaries;
#17/#106/#108/#109 old umbrellas, retriage before touching.

## Context-directory map (2026-07-28)

- `decisions/` — ADRs 0001-0008 + template. New decisions go here.
- `handoff.md` — this file.
- `plan.md` — pointer stub to this handoff.
- `notification-and-session-flow.md` — flow diagram referenced by AGENTS.md;
  PARTIALLY STALE (pre-Model B in places); refresh against ADR 0002 before trusting details.
- `auq-tui-interaction-model.md` — current AUQ TUI ground truth (#654/#661/#675).
- `native-ios-live-activities-guide.md` — research for open #276/#575.
- `archive/` — historical journals, with an index explaining what each is and what superseded it.
  Archived 2026-07-28: `ideas.md`, `research.md`, `scratch_history.md`.
- Deleted 2026-07-10 (content captured in ADRs/issues): epic docs for #494/#571/#603/#624/#648,
  refactor-453 trilogy, robustness proposal, platform-review-2026-06-09 (lives in #534-#547),
  cc-architecture-reference (cc-ref disavowed), lockscreen relay specs, streaming-messages plan,
  cleanup-audit, message-routing-trace, aa-investigation-findings.json, plan-773/648, live-testing-handoff.
