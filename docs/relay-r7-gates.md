# R7 local gate and rollout boundaries

This is a runnable local gate, not a receipt that it passed.
Record the immutable source head, runtime versions, complete logs and exit status for each run.
The separate [Relay R7 workflow](../.github/workflows/relay-r7.yml) runs existing controls and the opt-in soak on Bun 1.3.11 with an esbuild Worker bundle.
It has an 80-minute job budget; the ordinary 25-minute test job still skips the soak.
No Cloudflare account, deployed Worker, Apple credential, Apple APNs endpoint or model turn is used.

## Reuse and run

The soak reuses `ownedRelayOffer`, `ownedRelayChild` and their existing cleanup in `packages/web/tests/helpers/relay-hub.ts`.
They start local workerd, the source CLI hub and a real source child daemon with `/bin/cat` as its PTY program.
The child inherits a private home and a stripped environment.
This proves the daemon session and relay path; it does not prove a real Claude or Codex process remains healthy for an hour.
The client is the shipping `RelayMachineChannel` and `RelayRequests`, not the signaling suite's fake endpoint wrapper.

From a fresh checkout with a frozen-lockfile install:

```sh
REMI_RELAY_R7_SOAK=1 E2E_BUNDLER=esbuild bun test --timeout 4500000 packages/web/tests/relay-r7-soak.test.ts
```

For an unattended local run, use a detached job script with `nohup`, a stable log and explicit success/failure markers.
Record the launched PID and source head immediately; monitor the log and actual exit status.
Handle SIGINT/SIGTERM through normal test shutdown and the fixture cleanup.
Never SIGKILL the Bun test process: it can orphan workerd.
The reused helper closes owned sockets, disposes Miniflare, verifies daemon/PTY ownership before signaling, and retains private state if cleanup fails.
Run one measurement job at a time.
An interrupted soak starts again from a fresh attachment; elapsed time across reconnects cannot satisfy this gate.

## What the new test asserts

- The same attached session, source child daemon PID, PTY PID and single-use client stay live for at least 3,660,000 monotonic milliseconds (61 minutes).
- A fresh session-list request gets its exact correlated semantic response within ten seconds every minute, and still lists that child. The hub aggregation itself has a five-second bound.
- A real held `PermissionRequest` at both ends yields an encrypted card, a No answer through `RelayRequests`, a correlated delivered result and an actual deny HTTP response.
- Natural DO reconstruction occurs while the sockets remain open. The test reads boot ids and zero clock skew; it never advances time, runs an alarm or seeds storage.
- Nonempty captured binary frames and current storage contain none of the generated private command or pairing-secret sentinels.
- Any transport close, client error, child exit, lost correlation or replacement fails the run.

The tap is in-memory and resets on each DO boot.
The receipt therefore labels sampled frame/byte counts as observed lower bounds, not total traffic or billable requests.
Local boot ids demonstrate Miniflare/workerd reconstruction, not Cloudflare's production hibernation threshold.

## Carried gates: existing tests, not new implementations

The workflow runs these existing suites before the longevity test.
Their presence is coverage inventory; a passing receipt must name the exact run and head.

| Contract | Existing actual implementation coverage |
| --- | --- |
| Admission transcript/role/room, weak keys, stranger join and atomic ticket burn | `packages/signaling/tests/e2e/room-protocol.e2e.test.ts`, `client-admission.e2e.test.ts`; the concurrent-ticket test admits exactly one actual socket |
| Admission-proof/ticket replay, host displacement, revocation and plaintext exclusion | `relay.e2e.test.ts`, `room-protocol.e2e.test.ts`, plus real daemon `tests/integration/relay-r3.test.ts` and `relay-r3-revoke.test.ts` |
| Captured encrypted DATA replay through the real Worker and source HubRelay | New `tests/integration/relay-r7-replay.test.ts`: one actual pong, exact accepted ciphertext replay, failure close and no second response |
| MAX_FRAME and MAX_FRAME+1, per-address/device/room caps | `packages/signaling/tests/e2e/limits.e2e.test.ts` |
| Durable local approval before READY, production RNG, bounded handshakes and pairing expiry | `tests/integration/relay-r3.test.ts`, `relay-r3-offers.test.ts`, `relay-r3-qr.test.ts` and `relay-r3-boundaries.test.ts` |
| BYE, close draining, local send refusal and silent-peer grace | `tests/integration/relay-r3-orderly-close.test.ts`, `relay-r3-drain.test.ts`, `relay-r3-transport-close.test.ts`; `packages/web/tests/relay-machine-channel.test.ts` |
| Authority replacement and revocation, including an unreadable store | `tests/integration/relay-r3-authority-fault.test.ts`, `relay-r3-outbound-revoke.test.ts`, `relay-r3-child-generation.test.ts` |
| Real child held answer and exact delivery correlation | `packages/web/tests/relay-client-outcomes.test.ts` |
| Sealed push binding, durable nonce replay and revocation across awaits | `packages/signaling/tests/e2e/push.e2e.test.ts` (owned local APNs receiver, not Apple); `tests/integration/relay-r6-ingress.test.ts` for the source signed-answer route |

The existing Worker test named “older than an hour” advances a test clock and uses library endpoint wrappers.
It guards against TTL reaping; it does not replace this wall-clock source-hub/client/session run.
The new DATA-frame replay test fills a different gap from admission-proof/ticket replay and Channel counter unit tests.
It carries R3's measured Bun 1.3.11 immediate-close defect (#1225): a missing reason or reset is accepted only with the source hub's failure-close log and the matching actual Worker close record.
Other runtimes and uncorroborated close variants fail; this does not change the protocol's constant failure code/reason or the existing runtime exception.
The existing R3 production half-open, confirmation and offer clock probes remain opt-in; their commands are in [the daemon runbook](relay-daemon-v2.md).

## Local landing, default-on and owner gates

The channel can land opt-in with the relay default still off.
That is separate from closing R7 or enabling it by default: [plan section6](../.context/relay-rebuild-plan-2026-10.md#6-decision-gates) requires CI real-DO evidence, an unreaped session over an hour, replay/displacement/stranger refusal, ciphertext exclusion, real iPhone pairing and real-device NSE push decryption.
Push privacy may ship separately from the channel when entitlement/TestFlight work slips (gate4).
[The roadmap](../.context/plan.md) additionally lists signed-device and deployed-Worker acceptance for R7 closure.

The owner still supplies deployed-runtime engine checks, deployed Worker behavior, signed iPhone/NSE and Watch acceptance, and actual Cloudflare cost observations.
See [the deploy runbook](relay-worker-deploy-runbook.md#measurements-to-take-nothing-here-is-measured) for hibernation, alarm, limiter and billing measurements.
Local request/frame/byte counts can inform an explicitly labeled estimate; they are not measured Cloudflare charges.
Legacy plaintext `/push` retirement follows the runbook's separate release-cycle and old-client criteria, not deletion of the already-retired `/answer/<code>` route.
No default or owner gate is weakened by this local test.
