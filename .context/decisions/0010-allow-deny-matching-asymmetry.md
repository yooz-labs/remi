# ADR 0010: Allow matching is precise, deny matching is broad

**Status:** accepted
**Date:** 2026-07-28
**Owner:** Yahya

## Context

Auto-approve short-circuits the LLM with two user-supplied pattern lists. Until
#536 both used the same rule: substring containment against the Bash command
string. That symmetry looked clean and was a P0 security hole.

With the shipped default `allow = ["Read", "Glob", "Grep"]`, the substring rule
meant the literal command `cat secrets | sh` was **approved**, because the
characters `Read` were never required to mean the Read tool — any command
containing an allow string matched. Verified by running the matcher, not
inferred.

The fix forces a choice, because the two lists have opposite failure directions.
An allow rule that matches too much silently grants permission. A deny rule that
matches too little silently withholds a block. Symmetric matching cannot be
correct for both.

## Decision

**Allow and deny deliberately do not match the same way.**

Allow is precise. A Bash command is split on `; && || |`, and every segment must
either match one of the user's prefixes or be a neutral no-op (`cd`, `pwd`,
`echo`, `true`, `:`). Any segment carrying shell control (backticks, `$()`,
redirects, `-exec` and its family) is refused even when a prefix matches --
except that, in the GROUP path only, ADR 0026's destination-checked grants may
delete a specific redirect clause or heredoc whose target was positively
proven before matching runs; the veto itself is unchanged and still refuses
whatever no grant proved. An
entry shaped like a tool name (`Read`, `mcp__*`) matches that **tool** and never
a Bash command containing the word.

Deny stays a broad substring match, and so does `subagent_alert`. A rule whose
purpose is to stop something should over-reach rather than under-reach.

## Consequences

Easier: an allow list now means what a reader thinks it means, and the
catastrophic direction (over-granting) is structurally hard to reach.

Harder: allow patterns are stricter than users expect coming from substring
semantics, so `allow = ["git"]` no longer covers `git status`. The config
validator warns on tool-name-shaped entries and on patterns short enough to
match broadly, which is the mitigation.

New obligation, and the reason this ADR exists: **the asymmetry will look like
an inconsistency to a future reader and invite a "cleanup" that restores
symmetry.** Any change making deny precise, or allow substring-based, reopens
#536. The exec-primitive veto has a specific subtlety worth preserving — it
fires unless the user's own matched entry already spells the primitive out, so
`allow = ["find . -delete"]` still works while `allow = ["find ."]` does not
silently cover `-delete`.

## Alternatives considered

- **Make both precise.** Rejected. A deny list that under-matches is a block the
  user believes they have and does not. Precision is the wrong bias for a
  stop rule.
- **Make both substring.** This was the status quo and the P0.
- **One list with per-entry mode flags.** Rejected. It pushes a security-critical
  choice onto the user at the moment they are least likely to reason about it,
  and the safe default per list is already known.

## Receipts

- `packages/daemon/src/auto-approve/pattern-matcher.ts` — `matchAllowPattern`,
  `matchSubstringPattern`, `looksLikeToolName`
- `packages/daemon/src/auto-approve/shell-safety.ts` — `splitCompound`,
  `hasShellControl`, `hasExecPrimitive`, `NEUTRAL_PREFIXES`, `matchCoveredCommand`
- #536 (the P0), PR #868 (fix), PR #882 (five stale "substring" descriptions
  corrected, including the user-facing `remi --help` string)
