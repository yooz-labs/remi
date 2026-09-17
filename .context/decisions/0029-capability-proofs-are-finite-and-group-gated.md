# ADR 0029: Capability proofs are finite and group-gated

**Status:** accepted
**Date:** 2026-09-17
**Owner:** Yahya

## Context

The live 0.7.11 corpus contains benign operations that are still sent to the
local model because their shell spelling is outside the existing prefix table:
quoted loop values, a bounded import-search pipeline, and an exact Python
`uv.lock` inspection. The model can often describe these as read-only, but a
model explanation is not proof that an interpreter or remote client lacks a
write, egress, subprocess, credential, or persistence capability.

The opposite failure is more serious: a broad command-name allowlist can hide
an option or subcommand that changes the effect. GitHub's `sub-issue` extension
illustrates the boundary: `list` reads remote issue relationships, while
`add`, `remove`, and `reprioritize` mutate them. Unknown extension actions must
not inherit the read classification.

## Decision

Add a deterministic capability-proof fallback after the existing permission
group matcher. The fallback can return a match only when:

1. the complete command is proved by the finite read-only grammar;
2. every non-neutral proof leaf has a registered effect profile;
3. every profile's requested approval group is enabled; and
4. the existing read-side vetoes still accept the original command.

The shared effect registry records filesystem/network/remote/process effects
and the group that may cover the proof. A profile with no approval group, an
unknown leaf, an unknown GitHub action, malformed shell, or incomplete proof
fails closed.

Phase 2 admits only these new bounded shapes:

- the exact quoted-heredoc Python `tomllib` lock-inspection template;
- the exact single-quoted `awk` field projection, including the observed
  `-F:` form;
- a finite read-only `find` expression with no delete, exec, or file-output
  predicate;
- output-only `gh issue`/`gh api` reads and `gh sub-issue list` with bounded
  arguments; and
- existing finite Git/read leaves when they occur in proof-qualified
  compounds.

Arbitrary Python, arbitrary `awk`, unknown `find` predicates, remote mutations,
and unrecognized GitHub extension actions remain outside deterministic
approval. `gh sub-issue` mutation and unknown actions are high-risk in the
risk classifier, while `list` remains a moderate remote read.

## Consequences

The measured benign corpus can avoid unnecessary model calls when the relevant
read group is enabled, without allowing semantic model text to grant access.
The group configuration remains the authorization choice: a proof does not
silently add `read-only`, `vcs-read`, or `gh-read` to a session. False
negatives remain expected for command shapes not yet backed by a complete
proof, and those operations continue to the model/human path.

## Alternatives considered

- **Let the semantic assessor approve read-only intent:** rejected; the Phase 1
  assessor is advisory and cannot establish capability absence for arbitrary
  code.
- **Add every observed command to a prefix list:** rejected; this recreates
  the option/subcommand bypasses that motivated the parser and does not model
  interpreters.
- **Treat every `gh sub-issue` action as a read:** rejected; the extension has
  explicit relationship mutations and future actions are not known safe.
- **Add arbitrary Python with a denylist:** rejected; a denylist cannot close
  an interpreter's full filesystem, subprocess, and network surface.

## Receipts

- `.context/plan-semantic-intent-approval.md` — Phase 2 corpus, hypotheses, and
  verification categories.
- `packages/daemon/src/auto-approve/read-only-proof.ts` — finite command
  grammar and bounded interpreter/remote adapters.
- `packages/daemon/src/auto-approve/operation-effects.ts` — shared effect and
  approval-group registry.
- `packages/daemon/src/auto-approve/permission-groups.ts` — group-gated proof
  fallback and `gh sub-issue list` veto path.
- `packages/daemon/src/auto-approve/risk-bands.ts` — mutation and unknown-action
  classification.
- Focused proof, group, risk, and registry tests — positive corpus plus
  mutation, interpreter, shell-expansion, and group-isolation controls.
