# Architecture decisions

Standing decisions for remi, as ADRs. **Read the relevant one before changing
behavior it covers.** Several exist specifically because the decision looks like
an inconsistency worth "cleaning up", and the cleanup would reopen a security
hole or a bug that took a long time to find.

Each ADR carries its **evidence**, not just its conclusion — the measurement, the
issue number, the verified behavior. A decision recorded without its evidence is
what [ADR 0011](0011-verify-before-you-describe.md) exists to prevent.

New ADR: copy [`0000-template.md`](0000-template.md), take the next number, and
add a row below.

## Index

| ADR | Decision |
|---|---|
| [0001](0001-transcript-path-source-of-truth.md) | Transcript path is the session source of truth |
| [0002](0002-model-b-hold-the-hook-notifications.md) | Hold-the-hook notification model |
| [0003](0003-synchronous-permission-decisions.md) | Synchronous permission decisions |
| [0004](0004-pty-as-arbiter-subagent-questions.md) | PTY is the arbiter for subagent questions |
| [0005](0005-hub-and-attach-only-clients.md) | Hub mode and attach-only clients |
| [0006](0006-cc-ref-disavowed.md) | `cc-ref` is not ground truth for Claude Code |
| [0007](0007-release-automation-and-pins.md) | Release automation and toolchain pins |
| [0008](0008-testflight-local-upload.md) | TestFlight uploads are local, not Xcode Cloud |
| [0009](0009-transport-encryption-scope.md) | Encryption is scoped to the relay; direct connections carry none |
| [0010](0010-allow-deny-matching-asymmetry.md) | Allow matching is precise, deny is broad — on purpose |
| [0011](0011-verify-before-you-describe.md) | Security descriptions must be verified against code |
| [0012](0012-protocol-message-registry.md) | Protocol message registry is the single source of truth |
| [0013](0013-total-dispatch-handle-or-ignore.md) | Every protocol consumer declares handle-or-ignore, total over the registry |
| [0014](0014-two-sided-conformance-tests.md) | Contract tests must construct both shipping endpoints |
| [0015](0015-authority-bounded-by-counterfactual.md) | Authority may resolve ambiguity, never decide — amended 2026-08-02: graded authorization may decide, but text alone cannot grade above `implicit` |
| [0016](0016-strictness-levels-are-groups-not-prose.md) | Strictness is level-gated group membership, never prose to the model |
| [0017](0017-deny-floor-enforced-in-code.md) | A model-produced deny is silent, so it is floored in code |
| [0018](0018-write-group-safety-is-three-independent-vetoes.md) | A write-approving group needs three independent vetoes |
| [0019](0019-push-kind-mutability-asymmetry.md) | Push kinds are named on the wire; muting them is asymmetric |
| [0020](0020-client-status-cue-totality.md) | A client status cue must be total over its gate's end paths |
| [0021](0021-registration-outcome-not-requery.md) | Question registration outcome flows from the call, not a re-query |

## By area

Most work touches one of these clusters, and the ADRs in a cluster constrain
each other — reading one without its siblings is how a "fix" reopens the case
another one closed.

- **Permission decisions / auto-approve:** 0003, 0010, 0015, 0016, 0017, 0018
- **Questions + notifications:** 0002, 0004, 0019, 0020, 0021
- **Protocol + contracts:** 0012, 0013, 0014, 0006
- **Sessions + transport:** 0001, 0005, 0009
- **Process:** 0007, 0008, 0011
