# ADR 0048: Versioned accounting for the complete terminal stack

**Status:** accepted budget; source, lease and compiled qualification recorded; merge gates in PR #1655
**Date:** 2026-10-23
**Owner:** Yahya

## Context

The primitive and its internal ownership path qualified within 1 MiB under ADR 0046.
The signed service adds original-grant, view/controller and native-send state.
Its original 1 MiB matrix failed on Linux ARM64/Bun 1.3.11 at 1,199,295 bytes.
A later twelve-profile diagnostic retained the same oracle: eleven fit, while
that Latin-1 profile retained 1,198,091 bytes. None of those failures is regraded.
After reviewing the concrete tradeoff, the owner selected 4 MB in this session;
we acknowledged 4 MiB/model with the existing 32 MiB home cap, hence eight models.

## Decision

Qualify the complete terminal model/service/view/controller/native-pending stack
at 4 MiB per model, with at most eight model reservations and 32 MiB per Remi home.
The primitive's independent 1 MiB qualification and unchanged emulator remain.
Keep 240x60 geometry, 32 KiB text, 64 KiB frames/parser queue, eight parser operations,
1/2/4/8 view quotas, 500 ms read spacing, five-minute leases and all registered
native/TLS/fixture allowances. Input stays in chat and approval controls.

Persist accounting version 2 with an exact policy (models, modelBytes, homeBytes)
in the existing private namespace and ledger. Count and aggregate-byte checks
both precede admission. The old version 1 reader must reject version 2; no parallel
ledger, phantom model or uncounted control pool may bypass old charges.

A policy transition uses the existing interprocess lock and namespace checks.
Only a strictly valid version 1 ledger that is empty, or whose every row belongs
to this host and a process proved dead by ESRCH, may transition atomically.
Live, foreign-host, unknown-signal and reused-PID rows remain unchanged.
Malformed, missing, incomplete or unknown-policy state never resets itself.

## Consequences

The maximum number of captured models falls from 32 to 8. Additional agent sessions
can continue with optional terminal capture unavailable; their output, chat and
approvals must keep working. An old live reservation can delay new terminal
admission until it releases or its owner is proved dead. Old reader/writer
compatibility is tested with the actual archived component and real processes.

The [expanded receipt](../../docs/terminal-view-service-expanded-qualification.json)
records passing source/static/real-lease controls and six compiled resource/quota
and held-No cells, including maximum ingress/refusal, parser/native state,
two-owner/eight-view accounting and causal negatives. Original failed campaigns
remain preserved, including an intermittent fixture failure whose precise cause
is unconfirmed. The fixed-delta review is complete without Critical/Important
findings. Final-head hosted checks and the actual required relay soak gate merge. B4 encrypted routing and a qualified
real caller precede capability advertisement. Rendered/signed/deployed/provider
acceptance remains separate. Finite retained state is not an OS/RSS ceiling.

## Alternatives considered

- Retain 1 MiB: the actual service gate failed; measurement-layout, dependency,
  view-count, initial-screen and runtime-packaging diagnostics did not fix it.
- Qualify 1.25 MiB with 25 models: proposed to preserve the home cap, not adopted;
  the owner selected 4 MiB instead.
- Raise the home cap or lower geometry/text/frame bounds: not approved.

## Receipts

- [ADR 0046](0046-bounded-read-only-terminal-screen.md), its original failed and
  accepted primitive/ownership reports.
- [Service source and recorded failure](../../docs/terminal-view-service.md),
  PR #1655 and the source/lease receipt. The old1MiB failure remains in history.
- The session decision and exact source/binary/owned artifacts are retained in
  the task's private owner-four-mib-decision.json and APPROVED-FOUR-MIB-PLAN.md.
