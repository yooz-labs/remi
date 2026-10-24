# ADR 0048: Versioned accounting for the complete terminal stack

**Status:** accepted budget decision; implementation under qualification
**Date:** 2026-10-23
**Owner:** Yahya

## Context

The primitive and its internal ownership path qualified within1MiB under ADR0046.
The signed service adds original-grant, view/controller and native-send state.
Its original1MiB matrix failed on Linux ARM64/Bun1.3.11 at1,199,295 bytes.
A later twelve-profile diagnostic retained the same oracle: eleven fit, while
that Latin-1 profile retained1,198,091 bytes. None of those failures is regraded.
After reviewing the concrete tradeoff, the owner selected4MB in this session;
we acknowledged4MiB/model with the existing32MiB home cap, hence eight models.

## Decision

Qualify the complete terminal model/service/view/controller/native-pending stack
at4MiB per model, with at most eight model reservations and32MiB per Remi home.
The primitive's independent1MiB qualification and unchanged emulator remain.
Keep240x60 geometry,32KiB text,64KiB frames/parser queue,eight parser operations,
1/2/4/8 view quotas,500ms read spacing,five-minute leases and all registered
native/TLS/fixture allowances. Input stays in chat and approval controls.

Persist accounting version2 with an exact policy(models,modelBytes,homeBytes)
in the existing private namespace and ledger. Count and aggregate-byte checks
both precede admission. The old version1 reader must reject version2; no parallel
ledger, phantom model or uncounted control pool may bypass old charges.

A policy transition uses the existing interprocess lock and namespace checks.
Only a strictly valid version1 ledger that is empty, or whose every row belongs
to this host and a process proved dead by ESRCH, may transition atomically.
Live, foreign-host, unknown-signal and reused-PID rows remain unchanged.
Malformed, missing, incomplete or unknown-policy state never resets itself.

## Consequences

The maximum number of captured models falls from32to8. Additional agent sessions
can continue with optional terminal capture unavailable; their output, chat and
approvals must keep working. An old live reservation can delay new terminal
admission until it releases or its owner is proved dead. Old reader/writer
compatibility is tested with the actual archived component and real processes.

This decision approves a qualification target, not service adoption. Fresh
source/static/real-lease controls, all six compiled cells, maximum ingress/refusal
and parser/native state, two-owner/eight-view home accounting, held-No load and
causal negatives remain required. The fixed-delta review and final-head hosted
checks/actual relay soak still gate merge. B4 encrypted routing and a qualified
real caller precede capability advertisement. Rendered/signed/deployed/provider
acceptance remains separate. Finite retained state is not an OS/RSS ceiling.

## Alternatives considered

- Retain1MiB: the actual service gate failed; measurement-layout, dependency,
  view-count, initial-screen and runtime-packaging diagnostics did not fix it.
- Qualify1.25MiB with25models: proposed to preserve the home cap, not adopted;
  the owner selected4MiB instead.
- Raise the home cap or lower geometry/text/frame bounds: not approved.

## Receipts

- [ADR0046](0046-bounded-read-only-terminal-screen.md), its original failed and
  accepted primitive/ownership reports.
- [Service source and recorded failure](../../docs/terminal-view-service.md),
  PR1655 and the source/lease receipt. The old1MiB failure remains in history.
- The session decision and exact source/binary/owned artifacts are retained in
  the task's private owner-four-mib-decision.json and APPROVED-FOUR-MIB-PLAN.md.
