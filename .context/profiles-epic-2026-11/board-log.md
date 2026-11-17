# Profiles epic (#1157): phases 1 to 4, 5A, Apps 1 to 4: log

<!--
Append-only history for the board beside this file.
Written by `manager_board.py log` and `decide`; never rewrite or delete a row.
The manager reads the newest rows through `status`, never the whole file.
-->

## Decisions

| Time | Decision | By | Reason |
|---|---|---|---|
| 2026-11-14T18:23-08:00 | CP0: J1a answered: yes, Parity, Slots and Codex sandbox defaults of plan section 6 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J1b answered: option 1 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J1b limits set by owner 2026-11-14 (go to 100 total): Agents today 100, Codex Luna 24, Codex Terra 16, Claude Sonnet 44, Claude Opus 16, Advisor consults 20 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J2 answered: (b) the manager merges the yooz-docs profiles PR only after the REL-DOCS recheck, the owner's explicit release go on the board and the release being published; never another yooz-docs PR; owner's informed choice against the recommendation (public site publish) | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J3 answered: no release with phase 1 without P2A, and none before OG-P1 passes | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J4 answered: keep docs/tools/remi/guides/profiles.md and commands/profile.md | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J5 answered: yes, merge PR 1785 and mark ADR 0051 Accepted at or before CP1 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J6 answered: yes, phase 2 may start while OG-P1 runs | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J7 answered: the manager (or a worker it dispatches) may make the stopped-remi latency measurement itself, on a test hub under a temporary REMI_HOME, never the real hub; a real account need keeps it an owner gate | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J8 answered: serial, phase 4 after phase 3 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J9 answered: sidecar session-profiles.json, fail closed | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J10 answered: manager-run visual gate with the owner's announced consent per slice | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J11 answered: yes, only under the four conditions of plan section 7 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J12 answered: yes, record only that the fields exist; keep owner values off the public board | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J13 answered: (a) refuse the three Claude settings flags and pass --claudeai explicitly | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J14 answered: (c) a [profiles] error disables profiles only | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J15 answered: (a) loader accepts an unknown safe-token expects, check returns unknown, launch refused | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J18 answered: (a) one loop at a time; the land-branches board stays paused | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J16 deferred to CP2 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: J17 deferred to CP1 | owner |  |
| 2026-11-14T18:23-08:00 | CP0: plan approved with the answers above | owner |  |
| 2026-11-17T04:10-08:00 | CP0: J19 answered: (a) hosted full suite plus local focused tests; DV runs the profile tests and the test folders the merged PR touched under env -i with a canonical TMPDIR; DV-1 failures are not a baseline | owner |  |

## Log

| Time | Event |
|---|---|
| 2026-11-14T18:24-08:00 | First tick: setup done (verify worktree profiles-develop-verify at 095ef7cc), DV-1 dispatched (agent a713ea0097c9bc9a8, Sonnet); no implementation card before DV green; stat metadata saved |
| 2026-11-14T18:24-08:00 | D51: owner approved the ADR (2026-11-14, J5 yes); docs reviewer RV-D51 dispatched on PR 1785 head abd584fe; merge gate after its report |
| 2026-11-14T18:29-08:00 | D51 docs review (RV-D51) reported 0 Critical, 0 Important, 2 Moderate, 2 Minor on PR 1785 abd584fe; all four accepted; fix worker FX-D51 dispatched; PR body 'Q11 open' fixed by manager |
| 2026-11-14T18:31-08:00 | D51 fix round 1 verified (commits 2a5faeee, c66e77ae: all 4 findings fixed, scope 3 docs files); develop merged into branch (9cf3669c) to satisfy ancestry; waiting for hosted checks on the new head, then merge gate and gh pr ready + merge |
| 2026-11-14T18:42-08:00 | DV-1 on develop 095ef7cc: all TypeScript gates and swift test (1093) green; local full 'bun test packages/daemon' RED (178 fail, 31 errors: recovery unavailable, Owned listener unavailable, /var vs /private/var, git not found in PATH) while hosted CI on the same tree (PR 1787 head 96956f5f, Test worker 0-2) is green. Card gate cannot be met locally; manager does not change gates: no implementation dispatched; lead woken for a diagnosis (gate or environment) |
| 2026-11-14T18:50-08:00 | D51: PR 1785 merged into develop (head 9cf3669c, all checks green, scan [], develop ancestor); ADR status Accepted edit is a separate small docs PR at CP1 (J5) |
| 2026-11-14T18:52-08:00 | Lead diagnosis c0dde393: DV-1 red is the Mac environment (TMPDIR /var symlink gives 116 of 178 failures; 31 local Worker timeouts unexplained, Node 26 / Bun 1.4.4 vs CI); same 178+31 recorded on b4aa770a in land-branches; owner question J19 (a/b/c) asked; no dispatch until answered; scratch left: worktree profiles-dv-diag and /private/tmp/remi-dv-diag-canon (owner removes) |
| 2026-11-17T04:10-08:00 | 2026-11-17 04:10: owner answered J19 (a) (asked 2026-11-14); lead to apply runbook section 11 J19 card edits; release PR 1792 macOS App job is cancelled by its own concurrency group (workflow says not a required gate); two reruns also cancelled |
| 2026-11-17T04:14-08:00 | Dispatch 2026-11-17 04:25: P1A (terra), P1C and P5A-PREP (luna) on develop fbd2841d; deviation: each launch adds one writable root /private/tmp/remi-canon-STEP for the J19 canonical TMPDIR command (never /private/tmp or claude-501) |
| 2026-11-17T04:14-08:00 | Threads: P1A 01a1e96e-0347-7163 (pid 41394), P1C 01a1e96e-0347-7d53 (pid 41398), P5A-PREP 01a1e96e-0347-7010 (pid 41402); rollouts show the right cwd; evidence A/<step>/r1; stat before-metadata saved in artifacts/stat-before-first-dispatch.txt |
| 2026-11-17T04:14-08:00 | budget reset (daily): Agents today was 8 |
| 2026-11-17T04:14-08:00 | budget reset (daily): Codex Luna today was 2 |
| 2026-11-17T04:14-08:00 | budget reset (daily): Codex Terra today was 1 |
| 2026-11-17T04:14-08:00 | budget reset (daily): Claude Sonnet today was 3 |
| 2026-11-17T04:14-08:00 | budget reset (daily): Claude Opus today was 2 |
| 2026-11-17T04:15-08:00 | Owner request 2026-11-17: CI optimization. Issue 1793 filed; analysis-only agent CI-1 (Opus, worktree ci-optimization, branch docs/issue-1793-ci-optimization) writes .context/ci-optimization-2026-11.md; no workflow changes until the owner approves the proposal (coverage trade-offs are the owner's) |
| 2026-11-17T04:19-08:00 | Owner merged release PR 1792 (2026-11-17 12:12Z); main CI running (strip, tag v0.9.0, publish, sync develop). Owner request: pair v2 default on develop: issue 1794, worker PAIRV2-1 (Sonnet) branch feature/issue-1794-pair-qr-v2-default worktree pair-qr-v2 |
| 2026-11-17T04:22-08:00 | P1A-1 (Codex Terra) stopped at ~10 min without commit or PR: asked how to isolate the real 'claude auth status' characterization (acceptance 4) from machine-level managed settings and credential helpers; worktree profiles-p1a holds uncommitted partial work (cli.ts, arg-parser, help, config, tests); report-details.md in evidence. Lead woken for a card decision; then redispatch with the continuation line |
| 2026-11-17T04:24-08:00 | Lead commit 35d2f3ed (option b: isolation preflight, opt-in env var for acceptance 4) verified card ready; P1A continuation P1A-2 dispatched on the kept partial worktree (prompt prepends the continuation line) |
| 2026-11-17T04:24-08:00 | PAIRV2-1 reported: PR 1795 (head 1e44c020, base develop fbd2841d, scope 9 files all in card Scope, 262 changed lines); hosted CI running (needs the 61-min soak as the daemon is touched); reviewers RV-PAIR-A and RV-PAIR-B dispatched; merge only after reviews resolved, checks green on the final head, closing scan |
| 2026-11-17T04:26-08:00 | P1C-1 (Codex Luna) stopped at the stop condition: Codex 0.167.0 source also defines CODEX_API_KEY (precedence over other auth, read in CLI MCP and plugin paths, not by 'codex login status'); source answers Q2: default store is file on macOS and Linux; Q3: keyring is separated per canonical CODEX_HOME (service 'Codex Auth', account cli\|first 16 hex of SHA-256 of the canonical home path); Q4 and Q5 not assessed; worktree clean, no PR. Lead woken to decide the scrub scope and the P1C continuation |
| 2026-11-17T04:28-08:00 | PR 1795 round-1 reviews: A (contract/verification) 1 Important 1 Moderate 1 Minor; B (maintainability/docs) 1 Important 3 Minor; all 8 accepted (virtual-interface candidates leak ahead of Tailscale; pair-hub test misses the v2 path; README overclaim that build 11 reads the v2 default; invented ADR rationale; DIRECT-TLS stale; help wording; fallback record test); fix round sent to the worker; then I verify the fix commits (no third round) |
| 2026-11-17T04:28-08:00 | Lead commit 38a66ed8 verified (P1A/P1B/P1C cards ready; CODEX_API_KEY added to scrub scope; J11 moot: default store file and keyring separated per CODEX_HOME; P1B refuses two profiles sharing a directory); P1C continuation P1C-2 dispatched |
| 2026-11-17T04:34-08:00 | P1A-2 stopped again (no commit/PR, edits uncommitted in profiles-p1a): ambiguity stop (profile env could override CLAUDE_CONFIG_DIR/CODEX_HOME after the configured dir, so the check could validate a different directory; P1B's env builder affected) and the opt-in characterization skipped because Bun.which('claude') is null under the canonical PATH (claude lives in ~/.local/bin). Mutation/revert checks done (5 mutations fail their tests). Lead woken. Owner go for TestFlight 2026-11-17: build 25 is highest, iPhone 26, Mac 27; prep PR 1797 |
| 2026-11-17T04:35-08:00 | P5A-1 reported PR 1796 head fd8b1df5 (one file .context/profiles-5a-capture.md, develop unchanged fbd2841d, real-state stat: only ~/.claude.json mtime changed (owner's own sessions, logged not acted on), no closing words); docs reviewer RV-P5A dispatched |
| 2026-11-17T04:36-08:00 | Lead commit 14a7e82b verified (env cannot set CLAUDE_CONFIG_DIR/CODEX_HOME/HOME/XDG_CONFIG_HOME; builder sets configured dirs after env; REMI_CLAUDE_CHARACTERIZATION_BIN for the characterization; revert-index.md); P1A-3 dispatched |
| 2026-11-17T04:36-08:00 | P1A-3 dispatched 05:12 (tracked pid 93020, Codex Terra); a duplicate untracked launch of the same run (pid 92422, started by me by mistake) ran ~25 s and was killed; the worktree status is intact, events file may hold interleaved early lines; P1C-2 still running (pid 66654); P5A review RV-P5A running |
