# ADR 0018: A write-approving group needs three independent vetoes, not one

**Status:** accepted
**Date:** 2026-08-01
**Owner:** Yahya

## Context

ADR 0010 established that curated group/allow matching is precise: a Bash
command is split into compound segments, each segment must word-boundary
prefix-match a curated entry, and a blanket veto rejects shell control and
unambiguous mutation flags. That design's safety rested on one invariant,
stated in `permission-groups.ts`: "none of those tokens legitimately appears
in a curated **read** command." A read group's safety therefore came entirely
from the command being a read — the destination and exact flags did not
matter, because reading `/etc/hosts` is harmless.

`fs-write` and `vcs-write` (#959, phase 2 of #956) break that invariant on
purpose — the whole point is to approve commands that mutate. The single
blanket veto that protected every prior group cannot protect these, because a
write group's own curated prefixes (`cp`, `touch`, `tee`, `mkdir`, `git add`)
are legitimate carriers of exactly the flags and destinations that make a
write dangerous. Phase 2 needed four adversarial review rounds to close eleven
bypasses in this code, three of which were introduced by the fix for the
previous round. Representative, all measured as live 0ms auto-approvals before
being closed:

- **Raw-text matching cannot see real argv.** `curl -"o" out.txt url`,
  `curl -sS"o" out.txt url`, `curl --o\utput out.txt url`,
  `cp evil /et"c"/cron.d/task`, `tee ~/."remi"/config.toml`, and
  `git checkout "."` all auto-approved, because every veto was a regex over
  the raw command string and getopt semantics (bundled short flags, attached
  values, quoting, backslash escapes) are not expressible that way. The same
  flaw was live on the pre-existing READ groups too (`git diff --"output"=f`,
  `biome check --"write"`, `sed -n -"i" x`), shipped enabled by default, and
  found only while re-auditing this code for the write-group fix.
- **A denylist of dangerous flags fails open.** `mkdir -m 777 shared` (world-
  writable directory) had no policy at all through two review rounds, because
  nobody had thought `-m` on `mkdir` was worth listing. `curl -XPOST`,
  `curl -sSfLo out.txt`, `cp -rf src existing.txt`, and
  `git checkout -qf develop` all bypassed a first-draft denylist because short
  options bundle and attach values with no separator — "the flag appears as
  its own token" is not how a real command line is written.
- **The command shape can be safe while the destination is not.**
  `cp x /etc/hosts`, `touch /etc/cron.d/evil`, and
  `tee ~/.ssh/authorized_keys` all satisfy an ordinary `fs-write` prefix; the
  prefix says nothing about where the write lands. Worse, a write to
  `~/.remi/config.toml` (this mechanism's own config) or
  `~/.claude/settings.json` lets an auto-approved edit widen what is
  auto-approved next — privilege escalation, not an ordinary risky write — and
  a write to `.git/hooks/`, `.gitconfig` (`core.hooksPath`, a `commit` alias
  running `curl | sh`), or `package.json`'s `scripts` (already-default
  `build-test` will execute it) is code execution assembled from two
  individually-ordinary approved steps.

## Decision

**A write-approving permission group is safe only when three independent axes
are each covered, and none substitutes for another:**

1. **Tokenize before matching.** `shell-safety.ts`'s `shellWords` performs
   real quote/escape/getopt-aware word splitting, and every veto in the write
   path runs against the reconstructed word list, not the raw segment string.
   Read-group vetoes were retrofitted to check the tokenized form too — in
   *addition* to the original raw-text check, since normalization can only add
   a veto, never remove one a prior version already caught.
2. **Allowlist safe short flags per command family; do not denylist dangerous
   ones.** `write-flag-safety.ts`'s `FLAG_POLICIES` name the letters that are
   known-safe for `mkdir`/`touch`/`tee`/`cp`/`mv`/`git`; any short-option
   cluster containing anything else vetoes the segment, and long options match
   in both prefix directions so an abbreviation and an extension of a
   dangerous flag are both caught. The cost is accepted false negatives
   (`git add -n`, harmless, escalates because `n` is not on the safe list) —
   the deliberate direction, because a missed escalation costs a question and
   a missed veto costs a command that ran.
3. **Veto the destination independently of the command.** `sensitive-paths.ts`
   refuses a write whose target is this mechanism's own config
   (`~/.remi`, `~/.claude`), or a code-execution surface
   (`.git/`, `.gitconfig`, `package.json` scripts, `.github/workflows/`),
   regardless of which curated prefix or flag policy the rest of the command
   satisfied.

Every write group supplies `segmentVeto` and, where it lists a mutating tool,
`toolVeto` (`permission-groups.ts`); an omitted veto is not a stricter
default, it is the READ profile, which vetoes every write prefix by
construction — so a write group cannot ship without one. A test walks every
`BUILTIN_GROUPS` write prefix and asserts a flag policy exists for it, because
the comment asserting that invariant was already false once (`mkdir`/`touch`/
`tee` had no policy through two review rounds) before the test existed to
catch it.

## Consequences

Easier: the three axes are independently testable and independently
extensible. Adding a new write prefix is a change with a checklist — a flag
policy, a shell-control/exec-primitive veto (inherited from `shell-safety.ts`
for free), a destination check where relevant — rather than "add a string to
an array and hope."

Harder: every one of the three layers costs real coverage on the safe side.
The flag allowlist escalates flags nobody wrote maliciously (`git add -n`);
the destination denylist is explicitly not a complete model of "dangerous
path," only a curated, stable set of destinations that are never a routine
project edit; and tokenization adds a parsing surface (`shellWords`) that is
itself now load-bearing security code, not a formatting nicety.

**New obligation, and the reason this ADR exists.** Each of the three layers
looks, in isolation, like it could be simplified into one of the others by
someone who has not seen the bypass list above:

- Collapsing the flag *allowlist* into a *denylist* "to keep the list short."
  This was the first draft and it is what produced `curl -XPOST`,
  `cp -rf src existing.txt`, and `mkdir -m 777 shared` sailing through — an
  open set of dangerous letters fails open by definition; the allowlist is the
  fix, not a stylistic choice.
- Trusting the raw-text veto and treating the tokenized re-check in
  `readSegmentVeto` as redundant, because both currently return the same
  verdict on today's inputs. They do not test the same thing: the raw check
  catches nothing that survives quoting or escaping, which is exactly the six
  bypasses above. Removing either half reopens one of them.
- Treating the destination axis as covered by the command-shape vetoes because
  "the flag policy already blocks dangerous flags." A perfectly ordinary
  `cp source dest` — no dangerous flag, no shell control — is how
  `~/.ssh/authorized_keys` gets overwritten; only `sensitive-paths.ts` looks at
  *where*, and nothing else in this file does.

## Alternatives considered

- **One shared veto profile for read and write groups.** This was the
  pre-#959 design and cannot work: the invariant it depends on ("no read
  command needs these tokens") is false the moment a group is meant to
  mutate.
- **A single "is this command safe" classifier instead of three composed
  checks.** Rejected: a monolithic check re-derives all three axes internally
  anyway, just without names, and the four review rounds this design went
  through happened precisely because bypasses hid at the seams between
  unnamed concerns. Naming the axes is what let each round target a specific,
  falsifiable claim ("is every write prefix covered by a flag policy?") rather
  than re-auditing the whole function by eye.
- **Re-derive `net-read`'s curl/`gh api` policy instead of cutting it.**
  Rejected for now (#961): curl alone produced 5 of the first 10 bypasses,
  has roughly two hundred flags, and only 28 of 226 measured escalations were
  curl — the cost of getting an allowlist right did not clear the bar of "one
  tap avoided." Tracked as a fresh derivation against curl's actual
  documentation, not attempted from memory a second time.

## Receipts

- `packages/daemon/src/auto-approve/shell-safety.ts` — `shellWords`,
  `matchCoveredCommand`, `hasShellControl`, `hasExecPrimitive`
- `packages/daemon/src/auto-approve/write-flag-safety.ts` — `FLAG_POLICIES`,
  `hasUnsafeWriteFlag`
- `packages/daemon/src/auto-approve/sensitive-paths.ts` —
  `isSensitiveWritePath`, `segmentTouchesSensitivePath`, `BUILD_SURFACE`
- `packages/daemon/src/auto-approve/permission-groups.ts` — `BUILTIN_GROUPS`
  (`fs-write`, `vcs-write`), `PermissionGroup.segmentVeto`/`toolVeto`,
  `WRITE_GROUP_POSITIONAL_VETOES`
- `packages/daemon/src/auto-approve/levels.ts:38-45` — the "four adversarial
  review rounds... eleven bypasses, three... found in code written to fix the
  previous round" figure cited above
- `packages/daemon/tests/auto-approve/permission-groups.test.ts` — "every
  write prefix is covered by a flag policy" (#959 final pass)
- `packages/daemon/tests/auto-approve/shell-safety-per-segment-veto.test.ts`,
  `sensitive-paths.test.ts`
- #956 (write-groups epic), #957 (per-segment veto), #959 (fs-write/vcs-write,
  four review rounds), #960 (the PR — quote/escape removal, digit-flag scan
  fix, mkdir/touch/tee flag policies), #961 (net-read cut), ADR 0010 (the
  read-side precision invariant this ADR's groups can no longer rely on)
