# Plan: the profiles epic (2026-11)

Lead: Claude Opus, 2026-11-14.
Status: proposed; the owner approves this plan, its defaults and its merge authority before the first tick.
Pack: `.context/profiles-epic-2026-11/` on branch `chore/profiles-epic-plan` (worktree `/Volumes/S1/worktrees/remi/profiles-epic-plan`), never on `develop`.

## Summary: what this plan decides, and what the lead is least sure about

**Decided.**
The approved part of epic #1157 runs as one serial daemon lane (#1748, #1749, #1750, #1751, in that order) and one serial native lane (#1788 to #1791), plus a docs lane in `yooz-docs`.
Each daemon phase is split into pull requests (PRs) a single worker can finish and a four-lens panel can review: phase 1 is three steps (P1C Codex characterization, P1A profile model and commands, P1B launches follow the profile); phases 2 to 4 are outlined as nine more implementation steps and three docs steps.
Only phase 1's cards are complete; every later card is an outline the lead completes at the checkpoint before it, because each phase's file layout depends on how the one before it lands.
An owner checkpoint closes every daemon phase (CP1 to CP4), opens every app slice (CPA1 to CPA4), and one more (CP5) stands before phase 5.
Phase 5, 5B, 6 and Apps 5 are parked board rows that nothing can dispatch (ADR 0049 D9; phase 5 only after #1752 passes and the owner says go).
Phase 5A (#1752) is owner-run; agents only prepare the capture (P5A-PREP).
Slots, not waves: the daemon lane shares `cli.ts`, the profile module, the hub create path and the protocol files from step to step, and the native lane shares RemiKit and the one simulator.
Defaults for Parity, Slots and Budget are copied from the land-branches-2026-11 board as the owner amended them on 2026-11-13 (section 6).

**Least sure about.**

1. The `authMethod` value of a real claude.ai login. The lead read it as `"claude.ai"` from the code embedded in the installed Claude Code 2.1.325 binary, not from a run with a login (nobody runs one; ADR 0049 G12). The same code shows that the status prints identity fields in three shapes (a claude.ai sign-in adds `email`, `orgId`, `orgName`, `subscriptionType` and `planTier`; an `api_key` with the `/login managed key` source adds `email`, `orgId` and `orgName`; a gateway provider adds `email`), so the status parser is a privacy boundary, not a convenience. The owner gate OG-P1 confirms the value; a mismatch is a fix card.
2. Whether Codex keeps keyring logins apart per `CODEX_HOME`, and Codex's default credential store on macOS. P1C answers this from Codex's source at the installed version's tag; if the default store is the keyring and entries are not separated, Codex profiles need the owner's call J11.
3. That phase 1 alone is safe to release. P1B points a profile session daemon's own transcript discovery and download protection at its profile, but the status line in profile sessions, the hub's multi-profile transcript discovery (what a client's chat view reads) and download protection of inactive adopted directories inside a project (downloads are project-relative, ADR 0045; default profile directories sit under the protected remi home) arrive in phase 2 (P2A). The lead recommends no release that has phase 1 without P2A (J3).
4. The outline cards. They name files and gates verified on `develop` `c9e13967`, but phases 1 and 2 will move code under them; the checkpoint lead must re-verify every path before completing a card.

## 0. How the manager uses this plan

### 0.1 Start prompt

```text
You are the manager of yooz-labs/remi profiles-epic-2026-11.
Run one tick of the runbook at /Volumes/S1/worktrees/remi/profiles-epic-plan/.context/profiles-epic-2026-11/runbook.md, exactly as written, using the project:manager-loop skill.
The state is the board beside it: /Volumes/S1/worktrees/remi/profiles-epic-plan/.context/profiles-epic-2026-11/board.md.
Read lead.md beside it before anything else.
Your manager id is mba-claude-sonnet, the same on every tick.
Do not write product code.
Do not change the plan, a card, a gate, the parity, or a budget limit.
When the runbook says to stop or to ask, or does not cover what you see, record it on the board, ask the owner with a structured question, and stop that thread of work.
```

Run it in Claude Code, from the main checkout's session, as `/loop ` followed by the prompt, with no interval.
The pack and the board live on branch `chore/profiles-epic-plan`, never on `develop` (runbook section 1).

### 0.2 Tick

The tick is the skill's, with this project's handlers in [runbook.md](runbook.md).
The intermittent lead and its continuity file [lead.md](lead.md) are described there (runbook section 9).

### 0.3 Precedence

The owner's later instructions override this plan and are logged with `decide ... --by owner`.
The repository's `AGENTS.md` and `packages/native/AGENTS.md` override this plan, with three explicit exceptions:

1. **Never rebase a pushed branch.** `packages/native/AGENTS.md` says "Rebase on `develop` at least daily"; here the branch's worker merges `origin/develop` into the branch instead and never force-pushes.
2. **Native gate wrapper.** Native gates run under the shared Xcode lock (`lockf -k -t 7200 /Volumes/S1/yooz/remi/locks/xcode.lock ...`), which `packages/native/AGENTS.md` does not mention.
3. **Pushes to `develop`.** AGENTS.md says never push directly to `develop`; the owner allowed the manager and the lead to do so on 2026-11-13. This plan proposes that authority (section 0.4) and uses it for nothing: every change lands through a PR.

ADR 0049 (accepted direction), the owner's answers in ADR 0051 (Q1 to Q11, draft PR #1785) and the bodies of #1748 to #1752 and #1788 to #1791 are final; a card never reopens them.

### 0.4 Merge authority (proposed; the owner approves it with the plan)

The owner stated on 2026-11-13 that the manager and the lead, never workers, may: file issues; open, edit and close PRs; push to `develop`; upload to TestFlight (each upload needs the owner's go and a build number above the real current one); delete done branches and worktrees.
Never `main`, never a force-push; the owner merges `develop` into `main` and decides releases.
Proposed for this plan, within that authority:

- The manager merges a step PR into `develop` with `gh pr merge N --merge --match-head-commit SHA` (a merge commit; never `--squash`, never `--delete-branch`), only when the merge gate (runbook section 10) passes.
- The manager merges a large review-fix PR into its step PR's head branch only, after the same gate (land-branches Q15, carried over).
- The manager merges PR #1785 (ADR 0051, docs only) only after the owner approves it (step D51; J5).
- A DOCS step is done when merge gate items 1, 2 and 4 hold for its draft docs PR and its docs review is resolved; the PR stays a draft (runbook section 8, "Docs lane"), so no checkpoint waits on a release. The docs PR merges only in runbook section 10, "Release docs", after the owner says the remi release that ships its feature is published and the REL-DOCS recheck passes (the owner merges it by default, because a yooz-docs merge publishes the public site; J2).
- Never merged by the manager: anything into `main`; a `yooz-docs` PR, which deploys a public site on merge (the manager hands the owner the exact merge command; J2); a PR that relaxes a gate's assertion (to the lead); a step whose owner gate is open (P4A until the latency measurement, J7).
- Not used by this plan: direct pushes to `develop`; TestFlight uploads unless an owner checkpoint asks for one (CPA steps), with the owner's go and a build number above the real current one.

`develop` pushes trigger `auto-bump-dev.yml` (a version bump commit) and `close-on-develop.yml` (closes issues named by a closing word in any pushed commit).
Never hand-edit versions; never add `[skip ci]` to a PR head.

### 0.5 Question classes that may take a default

None, with one possible exception decided by the owner at CP0: if the owner answers J1b with option 2, a refused `spend` within the ceiling (twice a row's limit, at most two consecutive days over) is pre-authorized to proceed with `--over`, logged each time (runbook section 5); `Advisor consults` and `Fable consults` are never in that class.
Every other owner question waits for an answer; silence is never an answer.

### 0.6 Routing

| Role | Tier | Model |
| --- | --- | --- |
| Manager | worker | Claude Sonnet (`sonnet`), id `mba-claude-sonnet` |
| Lead (intermittent) and escalation advisor | lead | Claude Opus (`opus`), xhigh |
| Implementers | worker / worker-hard | Codex `gpt-6-luna` max / `gpt-6.1-terra` xhigh by default; Claude Sonnet high and Opus xhigh on the Claude slots (owner, 2026-11-13) |
| Reviewers | reviewer | Claude Sonnet xhigh (owner's global rule) |

No frontier trigger is listed: the frontier tier (Fable, Codex Astra) is used only when the owner asks.

## 1. Inputs, verified on `develop` `c9e13967` (0.8.3-dev.43, 2026-11-14)

The brief said the worktree is on the 0.9.0 line; it is not yet: PR #1787 ("start the 0.9.0 line") is open, and `develop` is `0.8.3-dev.43`.
Nothing in this plan depends on the version.

- Issues read with `gh issue view`: #1157 (parent), #1748 to #1752, #1788 to #1791 (bodies hold the owner's decisions and acceptance checkboxes, including the documentation gate and the unknown-value item for Claude Code profiles without Claude credentials).
- `.context/decisions/0049-account-switching.md`, `.context/account-switching-epic.md`, `.context/issue-1595-backend-plan.md` ("Profile contract and wrapper settings"), on `develop`.
- ADR 0051 and `.context/account-switching-apps-epic.md` on branch `docs/issue-1784-account-profiles-apps` (draft PR #1785 at its head on 2026-11-14), not on `develop`.
- Code facts each card cites (paths and lines at `c9e13967`):
  - nothing reads a profile: `CLAUDE_CONFIG_DIR` and `CODEX_HOME` are read only for download protection (`packages/daemon/src/cli.ts:1538-1539`) and the Codex socket (`harness/codex/codex-socket.ts:91-93`);
  - the agent's PTY environment is `process.env` plus the session's `env`, minus remi's secrets (`pty/pty-session.ts:211-218`, `pty/child-env.ts:21-35`);
  - a hub child copies the hub's environment (`cli/daemon-manager.ts:619-633`);
  - Claude paths are hardcoded (`transcript/transcript-discovery.ts:29`, `cli/statusline-installer.ts:81`), and the session daemon builds one `TranscriptDiscovery` at module load (`cli.ts:1171`);
  - config tables are validated one by one and merged by `deepMerge`, which drops keys it does not know (`config/config.ts:325-360, 392-450`); nothing writes `config.toml` except `initConfigFile` (`config/config.ts:918-921`);
  - subcommands are a fixed list in `cli/arg-parser.ts:13-41`, verbs in `SUBCOMMANDS_WITH_ARG_LIST` (`:63-66`);
  - a stored session already carries an optional `harness` (`session/session-store.ts:43-62`);
  - the child-environment guard test fails on any secret-named literal (`SECRET|TOKEN|PASSPHRASE|PASSWORD|PRIVATE_KEY`) not in `REMI_SECRET_ENV` or its exemption list (`packages/daemon/tests/pty-child-env-secrets.test.ts:108-138`);
  - the base capability list is `['workspaces']` (`cli/capabilities.ts:18`), documented in `PROTOCOL_CAPABILITIES` (`packages/shared/src/protocol-version.ts:41-56`); golden fixtures are generated (`packages/shared/tests/fixtures/protocol/generate.ts`);
  - the Worker's legacy `/push` does not validate `kind` (`packages/signaling/src/index.ts:85-98`) and the sealed kind is inside the seal (`packages/shared/src/relay/push.ts:38-55`), so a new push kind needs no Worker change;
  - test helpers exist for black-box launches: `packages/daemon/tests/helpers/fake-agent-clis.ts`, `packages/daemon/tests/helpers/fake-app-server.ts`, `packages/daemon/tests/integration/hub-test-utils.ts` (its session-daemon helper `spawnDaemon` reserves a random port from 45000 to 49999; `findTestPort` hands out the lowest free port from 19200), `packages/daemon/tests/integration/launch-characterization.test.ts`.
- Installed CLIs on 2026-11-14: Claude Code 2.1.325, codex-cli 0.167.0.

## 2. Steps

Board order is dispatch priority.
Tiers map to models through the board's Parity table.
Needs tokens: `xcode` (native gates under the Xcode lock), `simulator` (the one simulator; a visible run needs the owner's announced consent), `docs` (a `yooz-docs` worktree).
"Rule" steps have no card: the manager or the owner acts as the runbook says.

| ID | Card | Goal | Tier | Depends | Timebox | Acceptance gate (literal) |
| --- | --- | --- | --- | --- | --- | --- |
| CP0 | rule | the owner approves this plan, its defaults and merge authority, and answers J1a to J18 | owner | - | - | one `decide` line per answer and `CP0: plan approved ...`, recorded by the lead or owner before the first tick (runbook section 2) |
| P1A | [P1A](cards/P1A-profile-model-and-commands.md) | profile config, resolver, effective-login check, warnings and `remi profile ls\|add\|show\|login`; launches unchanged | worker-hard | CP0 | 1.5d | `bun test packages/daemon/tests/profiles` passes; every item of the card's Acceptance |
| P1C | [P1C](cards/P1C-codex-credential-characterization.md) | Codex credential variables, default store and keyring separation, from source and placeholder-only runs | worker | CP0 | 4h | the note exists with a source line per answer; `typos` clean |
| P1B | [P1B](cards/P1B-launches-follow-profile.md) | every launch path runs under the resolved profile, with the scrub, the pre-launch check, the record, the sidecar and resume | worker-hard | P1A, P1C | 2d | `bun test packages/daemon/tests/profiles packages/daemon/tests/integration/profile-launch.test.ts` passes; every item of the card's Acceptance |
| DOCS-P1 | [DOCS-P1](cards/DOCS-P1-profile-guide.md) | `guides/profiles.md` and `commands/profile.md` from the built `develop` tip, in a draft docs PR | worker | P1B | 6h | `bun run build` in the docs worktree passes; every command block has its recorded run; done = verified and reviewed draft PR, not merged (runbook section 8) |
| OG-P1 | rule | owner: two profiles, two accounts, 24 hours, `default` unchanged | owner | P1B | - | [owner-gates.md](owner-gates.md) OG-P1 recorded by the owner |
| CP1 | rule | owner checkpoint after phase 1; lead completes the phase 2 cards | lead | P1B, DOCS-P1 | - | a `decide` line starting `CP1:` and the owner's go |
| D51 | rule | PR #1785 (ADR 0051) merged into `develop` after the owner approves | - | - | - | the owner's approval recorded; merge gate (docs PR) |
| P5A-PREP | [P5A-PREP](cards/P5A-PREP-capture-config.md) | the opt-in capture procedure and redaction steps for #1752, so the owner can capture when a limit is hit (completed at CP0: a limit can come before CP1) | worker | CP0 | 4h | the procedure has a row per #1752 question; every command found in the build's help; `typos` clean |
| P2A | outline | profile paths: multi-profile transcript discovery, status line per profile, download protection of every profile directory | worker-hard | CP1 | 1.5d | completed at CP1 |
| P2B | outline | `session_profiles`: remote visibility and selectability, the picker request, `create_session_request.profile`, `profile` on entries | worker-hard | P2A, D51 | 2d | completed at CP1 |
| P2C | outline | `profile_status`: status, Check, settings, guides; `remi profile rename\|remove` | worker-hard | P2B | 2d | completed at CP1 |
| P2D | outline | web client: badge, picker, filter chip, Profiles section; Telegram label | worker | P2C | 1.5d | completed at CP1 |
| DOCS-P2 | outline | the guide and command reference updated for phase 2 | worker | P2D | 6h | completed at CP1 |
| OG-P2 | rule | owner: a phone-started session in a mapped folder lands in the right profile | owner | P2D | - | owner-gates.md OG-P2 |
| CP2 | rule | owner checkpoint after phase 2; lead completes the phase 3 and Apps 1 cards | lead | P2D, DOCS-P2 | - | `decide` line `CP2:` and the owner's go |
| CPA1 | rule | owner go for Apps 1 (#1788) | lead | CP2 | - | `decide` line `CPA1:` |
| A1 | outline | Apps 1: badge, picker, filter, read-only list (iPhone, iPad, Mac) | worker-hard | CPA1 | 2d | completed at CPA1 |
| P3A | outline | usage observations: Claude status-line windows, Codex rate limits, the account fingerprint, the per-profile snapshot | worker-hard | CP2 | 2d | completed at CP2 |
| P3B | outline | `profile_usage` with Refresh, `limitWait`, the `usage_warning` push kind and its one text builder | worker-hard | P3A | 2d | completed at CP2 |
| P3C | outline | web usage panel with Refresh and the warning switch | worker | P3B | 1d | completed at CP2 |
| DOCS-P3 | outline | the guide's usage section | worker | P3C | 4h | completed at CP2 |
| OG-P3 | rule | owner: the panel agrees with `/usage` and `/status` within one turn | owner | P3C | - | owner-gates.md OG-P3 |
| CP3 | rule | owner checkpoint after phase 3; lead completes the phase 4 cards | lead | P3C, DOCS-P3 | - | `decide` line `CP3:` |
| CPA2 | rule | owner go for Apps 2 (#1789) | lead | A1 | - | `decide` line `CPA2:` |
| A2 | outline | Apps 2: profile manager with sign-in, Check, settings and guides | worker-hard | CPA2 | 2d | completed at CPA2 |
| CPA3 | rule | owner go for Apps 3 (#1790) | lead | CP3, A2 | - | `decide` line `CPA3:` |
| A3 | outline | Apps 3: usage, Refresh, the warning, the limit wait | worker-hard | CPA3 | 2d | completed at CPA3 |
| P4A | outline | compaction on request (Claude `PostCompact`, Codex `thread/compact/start`) behind `session_compaction` | worker-hard | CP3 | 1.5d | completed at CP3 |
| P4B | outline | the deterministic handoff brief behind `handoff_brief` | worker-hard | P4A | 1d | completed at CP3 |
| DOCS-P4 | outline | the guide's compaction and brief section | worker | P4B | 4h | completed at CP3 |
| OG-P4 | rule | owner: one real `/compact` per harness; the stopped-remi latency check | owner | P4A | - | owner-gates.md OG-P4 |
| CP4 | rule | owner checkpoint after phase 4 | lead | P4B, DOCS-P4 | - | `decide` line `CP4:` |
| CPA4 | rule | owner go for Apps 4 (#1791) | lead | CP4, A3 | - | `decide` line `CPA4:` |
| A4 | outline | Apps 4: Compact now and Handoff brief (iPhone, iPad, Mac, web) | worker | CPA4 | 1.5d | completed at CPA4 |
| OG-5A | rule | owner-run characterization of the usage-limit state (#1752), opportunistic | owner | P5A-PREP | - | #1752's acceptance, recorded by the owner |
| CP5 | rule | owner checkpoint: go or no-go for phase 5 | lead | OG-5A | - | `decide` line `CP5:`; a go starts a new plan |
| P5 | parked | confirmed continuation (not filed) | - | CP5 | - | not dispatchable |
| P5B | parked | resume-under-another-account characterization (not filed) | - | CP5 | - | not dispatchable |
| P6 | parked | opt-in automatic continuation (not approved to start, ADR 0049 D9) | - | P5 | - | not dispatchable |
| A5 | parked | Apps 5: confirmed continuation (not filed) | - | P5 | - | not dispatchable |
| REL-DOCS | rule | at each release that ships a phase: recheck the docs against the release build, then merge the docs PR | worker | - | 2h | runbook section 10, "Release docs" |

Board states at start: CP0 and D51 `owner`; P1A, P1C and P5A-PREP `todo` behind CP0 (checked on a scratch copy after the fix round: once CP0 is `done`, `status` places P1A on `codex-terra` as `gpt-6.1-terra` xhigh, and P1C and P5A-PREP on `codex-luna` as `gpt-6-luna` max); P1B and DOCS-P1 `todo` behind their dependencies; every outline `outline`; every rule step `blocked` with its trigger in Next; P5, P5B, P6 and A5 `blocked` with Next starting "parked".

### Dependency and lane graph

```text
daemon lane (codex-terra)   P1A ─┐
                 (luna)     P1C ─┴─ P1B ── CP1 ── P2A ── P2B ── P2C ── P2D ── CP2 ── P3A ── P3B ── P3C ── CP3 ── P4A ── P4B ── CP4
docs lane (luna, docs)                 └ DOCS-P1        (D51 before P2A)        └ DOCS-P2          └ DOCS-P3          └ DOCS-P4
owner gates                            └ OG-P1                                 └ OG-P2            └ OG-P3            └ OG-P4
native lane (xcode, simulator)                                      CP2 ── CPA1 ── A1 ── CPA2 ── A2 ── CPA3(+CP3) ── A3 ── CPA4(+CP4) ── A4
5A                                     CP0 ── P5A-PREP ── OG-5A (owner, whenever a limit is hit) ── CP5 ── parked: P5, P5B, P6, A5
```

The native lane runs beside the daemon lane from CP2 on: A1 beside P3A, A2 beside P3B or P4A.
That is the only intended parallelism besides P1A, P1C and P5A-PREP at the start and the docs lane.

### Slot and collision rules

Full table in [queue.md](queue.md); the rules that shape the graph:

1. Every daemon step touches the profile module (`packages/daemon/src/profiles/`), `cli.ts`, or both: daemon steps run one at a time, by `Depends`.
2. Protocol steps (P2B, P2C, P3B, P4A, P4B) share `packages/shared/src/protocol.ts`, `protocol-version.ts`, `packages/daemon/src/cli/capabilities.ts` and the fixture builders: strictly serial, each merges `origin/develop` and regenerates fixtures before its gates.
3. Native slices share RemiKit, `Rows.swift`, `BoardTile.swift`, the Xcode lock and the one simulator: strictly serial (A1, A2, A3, A4), never in a wave.
4. Web steps (P2D, P3C, the web part of A4) share `packages/web/src/components/settings/` and the session list: serial by `Depends`.
5. A native slice may run beside a daemon step; if the daemon step changes a fixture the slice decodes, the slice merges `origin/develop` and reruns `FixtureConformanceTests` before its merge gate.
6. Docs steps touch only `yooz-docs` and run beside anything; they share one docs branch (`docs/remi-profiles`) and run one at a time.

## 3. Review policy

Every PR follows `project:pr-review-toolkit`'s `review-convergence.md`: round 1, an optional delta round 2, never a third; every finding fixed or rejected with a reason, none deferred (owner's global rule: no technical debt carried forward).
Reviewers are Claude Sonnet xhigh; the advisor is Claude Opus.

| Step | Round 1 lenses ([RV-panel](cards/RV-panel.md)) | Notes |
| --- | --- | --- |
| P1A, P1B, P2A, P2B, P2C, P3A, P3B, P4A, P4B | `contract`, `verification`, `maintainability`, `privacy` | `privacy` traces every path by which a credential, email, account id, local path or environment value could reach a log, file, frame, push or client (ADR 0049 D10, ADR 0051 A13) |
| P2D, P3C, A1, A2, A3, A4 | `contract`, `verification`, `maintainability` | A3 adds `privacy` (sealed push codec, push text) |
| P1C, DOCS-*, D51 | `docs` | DOCS: each command block checked against its recorded run |

Finding outcomes: every finding starts as `fix`; the implementer may propose `reject` (one-sentence reason) or `issue` (only for code the PR did not touch); proposed rejects of a round go to one advisor consult, recorded with `decide` and on the PR.
A contested finding on a credential, privacy, authorization or data-integrity path goes to the advisor before any fix.
Every reviewer reports `omitted_findings`; a reviewer silent at 20 minutes is dispatched again once, then the advisor performs that lens; a report is never skipped.

## 4. Checkpoints and owner gates

Checkpoints: [checkpoints.md](checkpoints.md).
Each daemon phase ends with an owner checkpoint (CP1 to CP4); each app slice starts after an owner checkpoint (CPA1 to CPA4); CP5 stands before phase 5.
At a checkpoint the lead completes the outline cards it lists, re-verifies their paths on the current `develop`, and records a decision line starting with the checkpoint id (for example `CP1:`); the owner gives the go.

Owner gates: [owner-gates.md](owner-gates.md), with exact procedures.
They need real accounts, a physical phone, TestFlight or a real usage limit, so no agent runs them: OG-P1, OG-P2, OG-P3, OG-P4, OG-5A, each app slice's signed-device recheck where its issue names one, and every TestFlight upload.
Anything under `packages/signaling/` needs the owner's redeploy; no planned step touches it (section 1), and a card that would stops.

## 5. Risks

Pre-registered in [risks.md](risks.md); the top three: the unobserved `authMethod` value (R1), the email in a claude.ai status (R2), and phase 1 released alone (R3).

## 6. Capacity, Parity, Slots and Budget (proposed defaults)

Copied from the land-branches-2026-11 board (`/Volumes/S1/worktrees/remi/land-branches-plan/.context/land-branches-2026-11/board.md`, 2026-11-14) as the owner amended them in that loop's log on 2026-11-13:

- Parity: copied verbatim (worker Sonnet high / `gpt-6-luna` max; worker-hard Opus xhigh / `gpt-6.1-terra` xhigh; lead Opus xhigh / `gpt-6.1-sol` xhigh; frontier Fable / `gpt-6-astra`, owner-requested only; reviewer Sonnet xhigh).
- Slots: `codex-terra` 1 (worker-hard), `codex-luna` 2 (worker), `claude-sonnet` 2 (worker; the owner made Claude Sonnet an implementer slot on 2026-11-13, and reviewers are extra to it), `claude-opus` 1 (lead, worker-hard; the owner's "1 Claude Opus worker"), `claude-fable` 1 (frontier; unused unless the owner asks).
  Codex is first in Slots order, so `status` places a step on Codex before Claude.
  The owner reset the Codex quota on 2026-11-14; both platforms are available.
- Codex sandbox: `workspace-write` with the plan's writable roots, and `danger-full-access` in a clean worktree for native cards and for any card a sandbox denial blocked (land-branches Q10 and Q18, carried over; runbook section 5).
- Budget: the board carries the land-branches rows and limits (Agents today 30, Codex Luna today 8, Codex Terra today 4, Claude Sonnet today 16, Claude Opus today 4, Advisor consults 8, Fable consults 1, Agents this wave unused).
  Every agent dispatch spends `Agents today` and its platform row: implementers, fix rounds, DV, reviewers, delta reviewers, lead wakes and advisor consults; lead wakes and advisor consults also spend `Advisor consults` (runbook section 5).
  What happens at a limit is J1b, the owner's call (both reviewers found that the first draft's "a refused `spend` is repeated with `--over`, never a reason to stop" contradicted the skill and section 0.5, and left the budget decorative):
  - option 1 (recommended): the owner sets the limits from the projection below (about 12 implementer and fix dispatches a day plus their reviewers; for example Agents today 40, Codex Luna today 12, Codex Terra today 8, Claude Sonnet today 24, Claude Opus today 8) and the skill's rule holds: at a limit the manager stops dispatching on that row and asks;
  - option 2: section 0.5 lists "budget overrun within the ceiling" as a pre-authorized class, valid only after a `decide ... --by owner` line recording J1b option 2; each use is `MB spend ... --over` plus `MB log BOARD "over: ITEM n/limit"`; the ceiling is twice a row's limit or the third consecutive day with any row over, where the manager stops and asks; `Advisor consults` and `Fable consults` never take `--over`.
  Either way, `Advisor consults` (8 for the whole plan, copied) is too small now that lead wakes spend it: nine checkpoint wakes (CP1 to CP5, CPA1 to CPA4) plus escalations; the lead recommends 20.
  This matches the owner's 2026-11-13 practice in land-branches ("no daily budgets; slots limit work") only under option 2, and even then with a ceiling.

Projection: about 30 dispatchable steps; at about one implementer, four reviewers, one delta reviewer, one fix round and one DV per step, about 240 agent dispatches over the plan.
The pace is bounded by the 61-minute `local-relay` soak on every daemon PR, the owner checkpoints, and the native lane's serialized Xcode and simulator use; estimate three to four weeks to CP4 if the owner answers each checkpoint within a day.

## 7. Open judgment calls for the owner

Each has the lead's recommendation; the cards follow the recommendation, and a different answer makes the lead correct the card before dispatch (runbook section 11).
J1 is split into J1a and J1b, J2's recommendation is now "no", and J13 to J18 were added after the pack review (Appendix A); all are answered at CP0 and recorded as runbook section 2 says, except J16 (by CP2) and J17 (by CP1).

| ID | Question | Recommendation |
| --- | --- | --- |
| J1a | Accept the Parity, Slots and Codex sandbox defaults of section 6 (copies of the land-branches values as amended on 2026-11-13)? | Yes |
| J1b | Budgets at a limit: (1) you set limits from the projection (for example Agents today 40, Codex Luna 12, Codex Terra 8, Claude Sonnet 24, Claude Opus 8) and "stop and ask" holds; (2) `--over` is a pre-authorized class within a ceiling of twice a limit or two consecutive days over, logged each time, never for `Advisor consults` or `Fable consults` | (1): the budget then means something, and the slots already bound concurrency; choose (2) if you want land-branches' "slots only" practice, with a ceiling. In both, raise `Advisor consults` from 8 to 20 (lead wakes now spend it) |
| J2 | Accept the merge authority of section 0.4; and may the manager also merge the `yooz-docs` profiles PR after your release go? (a) No: REL-DOCS ends with the exact `gh pr merge N --repo yooz-labs/yooz-docs --merge --match-head-commit SHA` handed to you; (b) yes, the manager merges after the REL-DOCS recheck | (a) No: a yooz-docs merge publishes the public site (Cloudflare Pages), and the skill keeps deploying repositories with the owner; D51 (a `develop` merge) stays with the manager |
| J3 | Release grouping: may a release ship phase 1 (P1A, P1B) without P2A? | No: ship phase 1 only together with P2A (the status line in profile sessions, the hub's multi-profile transcript discovery and download protection of inactive adopted directories inside a project), preferably with all of phase 2; and no release containing phase 1 before OG-P1 passed (risk R1). REL-DOCS runs only for a release that matches this answer (runbook section 8) |
| J4 | Docs paths: `docs/tools/remi/guides/profiles.md` and `docs/tools/remi/commands/profile.md` (the issues' paths), or under the newer `setup/` folder of yooz-docs PR #25? | Keep the issues' paths, so no issue body changes |
| J5 | Merge PR #1785 (ADR 0051) into `develop` and set its status to Accepted before the phase 2 cards are completed? | Yes, at or before CP1 |
| J6 | May phase 2 start after CP1 while OG-P1's 24-hour check is still running? | Yes; a failed OG-P1 becomes a fix card ahead of the next daemon step |
| J7 | P4A: does its merge wait for your stopped-remi latency measurement (#1751), or may it merge with `PostCompact` not registered by default? | Wait: one PR, registered by default, merged after your measurement |
| J8 | Run phase 4 beside phase 3 after CP2? | No: serial (shared protocol files and review load) |
| J9 | Resume protection against an older remi that rewrites `sessions.json` and drops the profile: a sidecar `session-profiles.json` read at resume (fail closed), or the Codex-style older-writer gate only? | The sidecar (P1B settles it this way) |
| J10 | Visual gate of each app slice: a manager-run simulator session on this Mac with your announced consent per slice (proven method, fixture hub above 18790), or another method? | Manager-run, with your consent per slice |
| J11 | If P1C finds that Codex's default store on macOS is the keyring and keyring entries are not separated per `CODEX_HOME`: may `remi profile add` write `cli_auth_credentials_store = "file"` into the new profile's own Codex `config.toml`? | Yes, only under all four conditions: (1) only into a new, empty directory remi created for that profile, never an adopted one; (2) the file is created exclusively (`O_EXCL`), never over an existing file; (3) P1A's gate on Codex sign-in stays until the line is present; (4) the guide says that `file` keeps a plaintext `auth.json` (mode 0600) under the remi home and that `remi profile remove` leaves it behind. Otherwise Codex profiles are refused with the copyable setting |
| J12 | The claude.ai status prints `subscriptionType` and `planTier` (read from the 2.1.325 binary, not run): record in an ADR 0049 amendment at CP1 that these fields exist, as a possible later replacement for the self-declared "individual subscription" (Q6)? | Yes, record only that the fields exist; phase 1 parses neither field, and OG-P1 does not record the owner's value, because the board and log are pushed to a public repository |
| J13 | Claude argument and sign-in guards (pack review D8, D13): (a) P1A refuses `--settings`, `--managed-settings` and `--setting-sources` in a Claude profile's `args` (they can inject an `apiKeyHelper` or `env` and bypass the effective-login check) and `remi profile login` passes `--claudeai` explicitly for a subscription profile (and prints one warning line before a Console sign-in for an `api_key` profile); (b) allow those flags and rely on the check | (a): fail closed, like the Codex `-p` and `-c` refusals; P1A follows (a) |
| J14 | A `[profiles]` error (pack review D9): (a) fail closed for the whole configuration, which stops every remi process including a LaunchAgent hub, and document it; (b) reserve the later phases' key names now and keep (a) otherwise; (c) a `[profiles]` error disables profiles only (configured-profile launches refused with the error, `remi profile` prints it, the built-in default and every other table keep working), plus (b)'s reserved names accepted and ignored with a notice | (c): profiles fail closed without taking the hub down, and a configuration written for a later phase does not break an earlier binary; P1A follows (c) |
| J15 | An `expects` other than `subscription` or `api_key` (pack review D10; ADR 0051 A8 needs one for P2C's test): (a) P1A's loader accepts any safe token now, the check returns `unknown (not_checked)` and launches refuse it with "not supported in this build", and profile `env` refuses every `PROFILE_CREDENTIAL_ENV` name (provider selectors included) until A8's phase; (b) P1A refuses unknown values and P2C's scope gains the loader change | (a), decided before P1A starts; P1A follows (a) |
| J16 | The `usage_warning` collapse key `usage-warning-<profile id>-<window id>` (pack review D16) is delivery metadata the Worker and Apple see even on the sealed path: (a) use a keyed hash of the profile id made on the machine; (b) keep the id and state the exposure in DOCS-P3 and A3's footnote | (a); answer by CP2 (P3B and A3 are completed there) |
| J17 | Permission rule texts in `profile_settings_response` (pack review D17) often contain local paths: (a) apply the `args` path replacement to rule texts and add a planted rule-text path to the marker scan; (b) keep them verbatim as #1749 words them | (a); answer by CP1 (P2C is completed there); if you see (a) as changing your approved shape, say so |
| J18 | One manager id on two boards (pack review E30): the land-branches board also uses `mba-claude-sonnet`, and budgets and slots are per board, so two loops at once would double Codex concurrency: (a) run one loop at a time (the land-branches board stays `paused`, as it is now); (b) give this board a distinct id and halve the Slots Max on both boards | (a) |

## 8. Later work, not in this plan

Phase 5 (confirmed continuation) is unfiled and starts only after #1752 passes and the owner says go (CP5); it would get its own plan.
Phase 5B and Apps 5 follow it; phase 6 may not start (ADR 0049 D9).
#1157 phase 5 `profile-settings` (per-profile remi settings beyond `[prompts]`) and OpenCode are in no filed phase; the apps show "Per-profile remi settings are planned (#1157) and not built".

## Appendix A: pack review

Required before the first tick: an executability reviewer (worker tier) and a design reviewer (lead tier), each a fresh agent, every finding with a disposition here.
Status: not run yet; this pack was written by the lead alone on 2026-11-14.
`manager_board.py card` passes on every complete card (P1A, P1C, P1B, DOCS-P1, REL-DOCS, DV, RV-panel, RV-delta, RB) and refuses every outline card, and `manager_board.py check` passes on the board.

| ID | Finding (short) | Disposition |
| --- | --- | --- |
| - | (pending the two reviews) | - |

## Appendix B: facts the lead could not verify

- The `authMethod`, `subscriptionType` and email fields of a real claude.ai `claude auth status --json`: read from the code embedded in `/Users/yahya/.local/share/claude/versions/2.1.325` (the object built with `authMethod:I` and, when `I==="claude.ai"`, `email`, `orgId`, `orgName`, `subscriptionType`, `storedClaudeAiLogin`, `planTier`), not observed.
- Codex's default `cli_auth_credentials_store`, keyring separation per `CODEX_HOME`, the credential variables Codex reads, and what `codex login status` prints with a login (P1C).
- Claude Code's managed-settings path on macOS (P1A verifies it from the settings documentation).
- Whether a Claude session started with a fresh `CLAUDE_CONFIG_DIR` under a remi hub child keeps the PTY behaviors remi relies on (trust prompt, hooks in the project's `.claude/settings.local.json`); P1B's integration test uses a fake `claude`, so OG-P1 is the first real check.
- The Docusaurus anchor slugs the apps will link to (DOCS-P1 fixes the headings; the URL base is confirmed at CPA1).
- The yooz-docs default branch is `main` (seen in `gh pr list`); whether docs PRs need anything beyond `bun run build` to pass its checks.
