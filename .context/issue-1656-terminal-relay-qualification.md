# Plan: encrypted terminal transport qualification (#1656)

Part of #1595; depends on #1655, with native adoption tracked in #1641.
This phase adds an owned transport probe only. It does not enable a production
relay route or capability, change the eight public terminal shapes, or select
a new private child protocol.

The current sender resolves `Channel.send` after `io.emit`; HubRelay's emitter
only calls `ws.send`. Neither proves host TLS/ciphertext disposal. The Worker
limits one frame but exposes no measured slow-client buffering ceiling. A maximum
65,536-byte terminal unit becomes a 65,561-byte encrypted frame, within its
existing 524,313-byte limit. These are size facts, not disposal guarantees.

Reuse the actual direct service/model/view/native receipt, strict terminal codec,
relay handshake/Channel and workerd Worker harness. The source native pane,
controller and store remain available for later caller integration.

The first probe uses an actual signed-WSS source-service hop and local plaintext
WebSocket Worker hops carrying encrypted payloads. Hold the original real model
frame while a separate enrolled client is stopped, after send completion and
after an incorrect encrypted pong. Verify the exact decrypted unit/hash and
strict codec, plus an ordered matching encrypted ping/pong, before permitting
the original native receipt to release it. Generic encrypted ping/pong must
continue while the projection receipt is withheld. A deliberately premature
release must fail the same ownership oracle. Join every owned process and Worker
and verify zero actual PTY input. Run both pinned Mac Bun versions.

This probe is necessary-only: no production HubRelay/proxy authority,
TLS-to-Worker disposal, complete child/hub 4 MiB measurement, native caller, UI,
signed device or deployed runtime is qualified by it. All production terminal
guards stay in place. Failures remain failures; no timeout or allowance changes.

Before runtime adoption, a concrete private admission/version/reservation plan
must be approved. One real ledger view must cover the child projection, hub
plaintext/AEAD/ciphertext/native copies and bounded metadata. Optional terminal
receipt pressure must quarantine the affected capture ownership without closing
a healthy chat/approval channel; ordinary authority/crypto/child-owner loss
retains existing retirement rules. Generic send completion, Worker ACK and
plaintext buffering zero cannot substitute for disposal.

Keep 4 MiB/model, eight models, 32 MiB/home, 240x60, 32 KiB text, 64 KiB
frame/parser queue, eight operations, 1/2/4/8 views, 500 ms reads and five-minute
leases. Full adoption still needs all six compiled combined-memory/slow-peer/
held-No controls and a qualified production caller before `terminal_view`.

One read-only architect was used and retired; no C2 third review. No credentials,
personal hub, provider, deployment or owner hardware is needed for this probe.
Refresh this branch from actual develop after #1655 merges before a B4 PR merges.

## Probe result and review budget

The first complete source probe passes on both Mac Bun pins. The deliberately
premature native release fails the same ownership oracle on both pins; every
owned client, source PTY and Worker joins cleanup. The initial probe omitted the
Worker's existing client `open` notice and failed; that attempt remains failed.
The correction consumes that existing notice without modifying Worker behavior.

Before the test-only phase PR, record the exact four-run receipt, add its source
file to the TypeScript scope, and verify all changed inputs. Use one fresh single
reviewer for this small probe PR, per `.rules/code_review.md`; worst case is two
unique B4q agents including the retired architect, with no implementation team.
This is a new PR review, not a third review of #1655. One delta round is allowed
only for substantial fixes, and no third round.
