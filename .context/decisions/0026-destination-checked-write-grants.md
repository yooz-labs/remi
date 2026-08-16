# ADR 0026: Write grants for decidable shell shapes, checked by destination

**Status:** accepted
**Date:** 2026-08-15
**Owner:** epic #1057 Phase 2 (#996, #1041, #1060)

## Context

Deterministic group coverage was measured at 12.9% of real asked-remi Bash
traffic (#996), with 63% of the misses being redirection and heredoc shapes
that `hasShellControl` refuses wholesale — the #536 fix, reaffirmed by ADR
0010's Decision ("any segment carrying shell control ... is refused even when
a prefix matches"). At `trusted`, 58% of Bash escalations were file writes
against a config that already approves file writes through the `Write`/`Edit`
tools (#1041): `cat > notes.md` escalated to a phone while `Write(notes.md)`
approved at 0ms. The 4B model then justified many of these escalations with
factually wrong category claims (#972), because commands that should never
have reached it did.

The constraint that shaped everything here: this repo's allow path produced
three P0s in one month (#536, #1031, #1034), every one from logic that tried
to understand a command more cleverly than a literal match. #1041 states the
boundary: cover only shapes whose write destination is DECIDABLE at the shell
layer; never classify interpreter code.

## Decision

The write groups gain coverage for three decidable shapes, each proven by its
destination and vetoed by ADR 0018's axes; everything else is refused exactly
as before, and `hasShellControl`, `splitCompoundParts`, and `maskQuotedSpans`
are byte-for-byte untouched:

1. **Redirect-to-file** (extends the `scratch` precedent): a pre-pass
   (`sanitizeCommandForRedirectGrants`) deletes a `path`-kind redirect clause
   before matching when its cwd-resolved target is proven allowed — under a
   scratch root (`scratch` active, the pre-existing rule), or, with `fs-write`
   active, a relative path that cannot ascend out of the starting directory
   (`RelativeCwd`: starts in-tree, composes only relative non-ascending `cd`s,
   collapses to sticky `null` on any absolute/`~`/`$VAR`/unreliable/dash-reset
   `cd`). In both grants the resolved target must additionally clear
   `isSensitiveWritePath` — which the scratch carve-out had silently omitted
   (#1060: `cat a > /tmp/.env` approved at 0ms; fixed here first, as a
   narrowing). `opaque` targets are never deleted (#1000); `discard`/`fd-dup`
   were always permitted. The head command still needs its own coverage —
   deleting a clause grants nothing by itself.
2. **Heredoc excision** (`exciseHeredocsForGroups`): `<< WORD` operator and
   body are excised before compound splitting IF recognition fully succeeds —
   plain `[A-Za-z0-9_]+` delimiter, single heredoc per line, terminator found,
   and (for an unquoted delimiter, whose body the shell expands) no `$(`,
   backtick, or `<(` in the body. Any failure leaves the command byte-for-byte
   intact, preserving the previous accidental-escalation behavior. The body is
   inert stdin data; safety rests on a pinned invariant: **no interpreter is
   in any group's command list**, so `bash <<EOF` / `python3 - <<'PY'` remain
   uncovered after excision by construction. Adding an interpreter to a group
   would silently void this — the test suite pins it.
3. **`sed -i`** as an `fs-write` prefix behind a page-sized script-shape
   allowlist: every script token must be exactly `s<D>…<D>…<D>[gIp0-9]*` or
   `y<D>…<D>…<D>` with no `;` — refusing sed's `w`/`W` (arbitrary file write),
   GNU `s///e` (execute), `r`/`R`, addresses, and braces. `-f`/`--file` is
   refused by the flag axis; the `-i` backup suffix gets its own
   `[A-Za-z0-9._-]*` check (a GNU backup suffix containing `/` redirects the
   backup write). File destinations ride the existing `writeGroupVeto`
   destination axis.

The grants run in the GROUP path only. The user-allow path
(`pattern-matcher.ts`) keeps today's behavior: a user allow entry still fails
on redirects and heredoc bodies. Asymmetry is deliberate — groups carry
curated veto profiles the allow path does not.

## Consequences

- The redirection (50%) and heredoc (13%) miss buckets from #996 become
  coverable; `cat > notes.md <<'EOF'` compositions approve at 0ms when the
  destination proves out. Measured deltas live in
  `.context/approval-rate-baseline-2026-08.md`'s successor runs.
- ADR 0010's Decision line is amended by this ADR: shell control is refused
  *unless a destination-checked grant proved the specific clause*, and the
  enforcement point moves one step earlier (clause deletion) without touching
  the veto itself.
- New standing obligations: (a) never add an interpreter to a group command
  list (voids the heredoc invariant); (b) any new grant must check
  `isSensitiveWritePath` on the RESOLVED target — #1060 is the receipt for
  what omitting it costs; (c) the single-walk rule holds — one cwd walk feeds
  all grants, because a second walk that disagrees is a bypass (#1000).
- Known residuals, verified fail-closed: GNU's attached-suffix spelling
  `sed -i.bak …` matches no prefix (prefix matching requires `sed -i` + space)
  and still escalates; on BSD/macOS sed, `-i` consumes the next token as a
  suffix, so a GNU-read command may parse differently under BSD — the
  divergent reading errors or writes an odd backup name, never a sensitive
  write or execution. Both stay documented rather than solved.

## Alternatives considered

- **Lift the shell-control veto for covered heads:** rejected — the veto is
  the #536 fix; the whole point is proving the clause, not trusting the head.
- **Classify interpreter heredoc bodies (Python AST allowlist):** rejected per
  #1041's own analysis — an incomplete classifier grants arbitrary code
  execution while reporting `fs-write`.
- **Hotfix #1060 to develop separately:** offered; owner chose in-phase
  (scratch-tree-only blast radius).
- **Descope `sed -i`:** kept as the standing fallback if the shape rule ever
  needs to grow past a page; owner chose to include it at this size.

## Receipts

#996 (measurement), #1041 (the decidable-shapes boundary), #1060 (the gap
this fixes first), #536/#1031/#1034 (why cleverness is rationed), #1000 (the
opaque/single-walk rules), #1047 (dash reset), ADR 0010, ADR 0018. Probes and
adversarial cases: `permission-groups.test.ts` blocks tagged #1060/#1041 and
the heredoc/sed describe blocks.
