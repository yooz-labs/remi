# ADR 0023: Deletion approves only when the target is provably derived — amending #956's blanket rule

**Status:** proposed
**Date:** 2026-08-10
**Owner:** Yahya

## Context

#956's standing rule is that deletion escalates at EVERY level, including
`trusted`: "deletion is where escalation earns its cost." It is pinned in
three places — the `perLevel` narrowing in `prompt-builder.ts:110-115` (file
creation/modification move to APPROVE at `balanced`; "deletion never does"),
the tests `'deletion escalates at every level'` and `'at balanced and
trusted, deletion is the ONLY file operation left escalating'`
(`prompt-levels.test.ts:85-115`), and the curated-group comments that keep
`rm`/`rmdir` out of `fs-write` (`permission-groups.ts:564-567`,
`levels.ts:60-64`).

Measured on the owner's live daemon (2026-08-10), the blanket rule is now the
single largest cost center of the whole mechanism:

- 134 escalate vs 129 approve overall (51% escalation); 123 of the 134 were
  Bash.
- A cold replay of the real escalation population through the live engine
  scored 17/21 (81%) approve. Three of the four misses were exactly this
  rule: `rm -rf dist` (3418ms → escalate), `rm -rf node_modules && bun
  install` (3493ms), `git worktree remove --force ../remi-1031` (3721ms).
  Each is ~3.5s of GPU time plus a human interruption spent on a deletion
  that is regenerable by a command the repo already runs.
- Target: ≥95% approval on that population with zero unsafe approvals.
  Covering the three named misses reaches 20/21 (95.2%); the fourth miss is
  not a deletion and is deliberately not chased.

The blanket rule also already has one shipped exception, which is the
precedent this ADR generalizes: the `scratch` group
(`permission-groups.ts:99-140`) deterministically approves `rm`/`rmdir`
whose every target provably resolves under a scratch root, at `balanced`
(`levels.ts:75`). So "deletion escalates at every level" has, since #994,
really meant "deletion escalates unless the destination is PROVED disposable
by lexical reasoning." This ADR extends that proof from "under `/tmp`" to
"at or under a directory whose exact name proclaims derived state."

## Decision

**A new curated group (working name `artifact-clean`), gated into `trusted`
only, deterministically approves deletions whose targets are PROVABLY
derived state — and nothing else. The prompt-side rule is untouched:
deletion still escalates on every path that reaches the LLM, at every
level.** The amendment lives entirely in the deterministic layer, which is
where ADR 0016 says policy belongs.

The group covers four command shapes, each with its own veto profile
(ADR 0018: a mutating group supplies its own vetoes or it does not ship):

1. `rm` / `rmdir` where EVERY non-flag token, after `shellWords`
   tokenization and `resolveDotDot` resolution, is a relative path that
   does not ascend, contains no expansion the shell would rewrite
   (`$`, glob, brace, leading `~`), has some exact-case path segment on a
   fixed ARTIFACT_DIR_NAMES list (`node_modules`, `dist`, `build`, `out`,
   `target`, `coverage`, `__pycache__`, `.venv`, ...), and does not hit
   `isSensitiveWritePath`. Flags are allowlisted (`-r -R -f -v` and exact
   long spellings only).
2. `git worktree remove` with at most one `--force`/`-f`, no other flags, no
   `-C`/`--git-dir`, one positional target that is not `.`. Its safety rests
   on a RUNTIME veto: git itself refuses any path that is not a registered
   linked worktree of this repository, refuses the main worktree always, and
   requires a second `--force` for a locked one — which this group never
   supplies. Committed work survives in the shared object store by
   construction; only the worktree's uncommitted files are at stake, which
   is the owner's explicit "disposable worktree" call.
3. Bare `bun install` (zero positional arguments, flag allowlist of
   `--frozen-lockfile` only): a lockfile-faithful reinstall of dependencies
   already vetted, whose lockfile and `package.json` no write group can
   touch (`BUILD_SURFACE`, `sensitive-paths.ts:141-164`). This is what makes
   the measured compound `rm -rf node_modules && bun install` fully covered.
   `bun install <pkg>` is `bun add` and stays an escalation.
4. `/tmp` / `$TMPDIR` deletion is NOT re-implemented — `scratch` already
   covers it (`permission-groups.ts:140`, `levels.ts:75`).

A `cd` anywhere in the compound whose target is not a plain relative
descendant (absolute, `~`, `$`, ascending, bare `cd`, `cd -`, or
grammar-wrapped) poisons every later segment for this group — computed by a
scratch-style indexed pre-walk, never un-poisoned. Git-ignored status is
NOT consulted: it is I/O in a pure layer, TOCTOU-racy, the wrong axis
(ignored means unversioned, which includes `.env` and irreplaceable data,
not "disposable") — and above all, `.gitignore` is on no sensitive list, so
`fs-write` at `balanced`/`trusted` can auto-approve writing `src` into it,
turning "git-ignored ⇒ deletable" into a two-step self-widening loop, the
exact privilege-escalation shape `sensitive-paths.ts`'s module doc exists to
close.

`git clean` is excluded in every form. Its population is UNTRACKED files,
and untracked ≠ derived: a file the agent created five minutes ago is
untracked source. The `-X` (ignored-only) form is lexically identifiable but
is defeated by the same `.gitignore` write above. `git clean -xfd ~` in a
dotfiles home repo is catastrophic. It stays an escalation, always.

## Consequences

Easier: the three measured misses approve at 0ms with no model and no human;
the escalation population drops to operations that genuinely need judgment.
The rule becomes checkable the way every other group is — pure functions
over `(toolName, toolInput)`, testable without a daemon (ADR 0016).

Harder, and accepted: the artifact-name list buys residual risk on names
that are conventions, not guarantees. A SOURCE directory legitimately named
`build/` or `coverage/` is deletable at `trusted`. Bounded honestly: if its
contents are tracked, `git checkout -- <path>` restores them (shared history
is untouched by `rm`); if untracked, they are lost — the same residual the
owner accepted for worktree `--force`. Symlinks stay invisible to every
lexical check here, exactly as `scratch` documents
(`permission-groups.ts:130-136`); the one lexically visible trigger
(trailing `/` on a target, which makes `rm -rf link/` traverse the link
target on some platforms) is vetoed.

New obligations, and the reason this ADR exists:

- **The name list is an allow surface and will attract additions.** An entry
  qualifies only if the exact name proclaims derived state AND a command the
  repo already runs regenerates it. `vendor` (often tracked), `tmp`
  (proclaims temporariness but regenerates nothing), and any suffix/glob
  form (`*.egg-info`) do not clear the bar.
- **Name matching is exact-case while `sensitive-paths.ts` lowercases, and
  that asymmetry is deliberate** (ADR 0010 applied to names): the deny check
  lowercases to widen; an allow check that lowercased would treat `Dist` as
  `dist` on case-sensitive Linux, where they are different directories.
  "Cleaning up" the inconsistency reopens a hole.
- **The prompt half of #956's rule stays true and pinned.** The tests at
  `prompt-levels.test.ts:85-115` keep passing untouched; their comments (and
  `permission-groups.ts:564-567`, `levels.ts:60-64`, the
  `prompt-builder.ts:112` "deletion never does" line) must be amended in the
  same change to cite this ADR, per ADR 0011 rule 3 — `levels.ts:63`'s
  "`rm` ... not groups at all, at any strictness" becomes false the moment
  this merges.
- **#1024 makes this group a silent subagent grant**: a subagent's
  `rm -rf dist` at `trusted` now answers the hook with no render and no
  card. The visibility path is `auto_approve.subagent_alert` (an `rm` entry
  there alerts without blocking), and the ADR records that this was chosen,
  not overlooked.
- **The adversarial corpus is part of the deliverable, not documentation.**
  #959 needed four review rounds and found eleven bypasses, three in code
  written to fix the previous round (ADR 0018). The corpus ships as a pinned
  test (`artifact-clean.test.ts`), and at least one independent adversarial
  pass happens before merge.

## Adversarial pass, 2026-08-11 (the obligation above, discharged)

Three independent adversaries, given distinct lenses (lexical/tokenization,
destination/state, integration/composition) and required to EXECUTE every
candidate through `matchGroups` rather than reason about it.

**One confirmed bypass, and it was the group's worst case.**
`cdTargetIsPlainDescendant` rejected the exact string `'-'` as a non-descendant
`cd` target. But `cd` reads ANY leading-dash token as OPTIONS, so `cd -P`,
`cd -L`, `cd --` and `cd -LP` are an option with **no operand** — and a `cd`
with no operand goes to `$HOME`. Verified in bash on darwin 25.6: all four land
in `/Users/<user>`.

So `cd -P && rm -rf .venv` read as plain relative descent, approved at 0ms, and
deleted the user's `~/.venv`. Worse, a SECOND plain `cd` descends normally from
there, so `cd -P && cd <anyproject> && rm -rf node_modules` reached any project
under `$HOME` — no card, and under #1024 a silent subagent grant. The
one-directional poison model is what converted the blind spot into an approval
rather than an escalation.

Fixed by rejecting any leading dash, which costs nothing: a directory named
`-foo` cannot be reached by `cd -foo` in bash either. Five entries added to the
corpus (now 45), mutation-verified.

**The same defect was live in shipped code, and the adversary got that half
wrong.** It reported `scratch`'s `advanceScratchCwd` as failing safe here.
Checking rather than accepting that showed it does not: `-P` fell through to
`resolveScratchTarget` and was tracked as a SUBDIRECTORY NAME, so the tracked
cwd became `<scratch>/-P` — still under the root — while bash had left for
`$HOME`. `cd /tmp/work && cd -P && rm -rf out` approved at 0ms and deleted
`~/out`, reachable at `balanced` and above. Filed as **#1047** and fixed in the
same change, since one root cause split across two commits would ship a fix for
the new code while leaving the shipped one open.

That two independent authors encoded "the weird `cd` forms" as the single
literal `-` is the finding under the finding: the check wanted to be "is this
token an OPTION", not "is it one specific option".

Verified non-findings worth recording, so a later reader does not re-derive
them: the deny axis holds on top of the name proof (`dist/.env`, `dist/.git`
refuse); no lexical ascent escapes (`../dist`, `dist/../src` refuse, because
`resolveDotDot` pops the artifact ancestor before any `..` can escape past it);
and `git worktree remove`'s flag handling is tight (`-C`, `--git-dir`,
`--force=`, a second `--force` all fail closed), though its safety still rests
entirely on git's runtime refusal, exactly as the Decision states.

## Alternatives considered

- **Widen the prompt instead ("at trusted, approve artifact deletion").**
  Loses on ADR 0016's own measurement: 35 of 226 escalations cited the
  user's prose and escalated anyway; and ADR 0017's mirror — 10 of 12
  escalate-expected operations denied against explicit instructions.
  Prose is not obeyed at the rate group membership is, and a model verdict
  costs the ~3.5s this exists to eliminate.
- **Add `rm` to `fs-write` behind `writeGroupVeto`.** Loses on polarity:
  `fs-write`'s destination axis is a DENYlist ("not a known-bad path"), which
  is the right shape for writes and fails open for deletion — `rm -rf src`
  touches nothing sensitive. Deletion needs positive proof, an ALLOWLIST of
  destination shapes, which is `scratch`'s shape, not `fs-write`'s.
- **Consult git-ignored status.** The trap, rejected above: impure, racy,
  wrong axis, and self-widening via an `fs-write`-approvable `.gitignore`.
- **Gate into `balanced`.** The measurement is one machine running
  `trusted`. `balanced` gets no evidence, and ADR 0016's precedent is to
  ship the mechanism narrow and widen in a deliberate one-line follow-up.
- **Cover `git clean -fdX` (ignored-only).** Rejected: defeated by the
  `.gitignore` write; fixing THAT means adding `.gitignore` to the sensitive
  lists, which breaks a routine edit every project makes. Not worth it for a
  form absent from the measured population.
- **A user-extensible artifact-name config key.** Deferred, not rejected: it
  reopens ADR 0016's "policy as user text" surface and none of the measured
  misses need it.

## Receipts

- Live daemon measurement 2026-08-10: 134/263 escalate (51%), 123 Bash;
  cold replay 17/21 approve; misses `rm -rf dist` 3418ms,
  `rm -rf node_modules && bun install` 3493ms,
  `git worktree remove --force ../remi-1031` 3721ms. Target ≥95%, zero
  unsafe approvals.
- `packages/daemon/src/auto-approve/permission-groups.ts:99-140` (`scratch`:
  the shipped destination-proof deletion precedent), `:140`
  (`SCRATCH_COMMANDS` includes `rm`), `:564-567` (`rm` kept out of
  `fs-write`, #956), `:587-592` (`git worktree remove` excluded from
  `vcs-write`)
- `packages/daemon/src/auto-approve/levels.ts:66-79` (`LEVEL_GROUPS`; the
  gate point), `:60-64` (the comment this ADR falsifies)
- `packages/daemon/src/auto-approve/prompt-builder.ts:93-125`
  (`ESCALATE_ENTRIES` `perLevel`; untouched by this ADR)
- `packages/daemon/tests/auto-approve/prompt-levels.test.ts:85-115` (the
  pins; untouched, comments amended)
- `packages/daemon/src/auto-approve/sensitive-paths.ts:196-261, 275-290`
  (`isSensitiveWritePath`, `resolveDotDot` — reused),
  `shell-safety.ts:548-569, 659-710, 740-854` (`hasShellControl`,
  `matchCoveredCommand` + indexed vetoes, `shellWords` — reused),
  `write-flag-safety.ts:55-153` (`FlagPolicy` pattern — extended)
- ADR 0010 (allow precise / deny broad), ADR 0016 (levels are groups, not
  prose), ADR 0017 (10-of-12 deny measurement), ADR 0018 (three vetoes;
  eleven bypasses), #956 (the amended rule), #959/#960 (write groups),
  #994 (`scratch`), #1024 (subagent hook-time approves), #1031/#1034
  (quote/ANSI-C splitter fixes this design inherits)
