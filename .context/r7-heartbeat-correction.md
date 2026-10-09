# R7 heartbeat correction

Production fix: `526cd28b95d7a2b7a0c5b75ec616e04f1eb1fc96`.
Fixture admission correction: `253ed58c4b185c75609e586f4f79b226a6272bd0`.
Pins: `44bbf56a` and `5a4cec10`.

## Original failure and cause

Linux R7 run `37903082054`, source `9ae5c5bf`, passed the wire/authority controls
but its unchanged 61-minute test lost the original client after about 91 seconds.
Two actual session-list probes and the early held-hook denial had succeeded.
The new silent 93-second hub/child/workerd/shipping-client control independently
fails at the original close on both local runtimes. The separate child-socket
pin fails waiting for its Pong. Both initial controls report 0 passed / 2 failed
(Bun 1.4.2: 91.72 s; Bun 1.3.11: 91.68 s).

The relay client forwarded the machine's Ping without the direct transport's
auto-Pong. Hub special reads bypass `Connection.handleMessage`, so they did not
reset its existing missed-Pong counter. Child Pings were forwarded too, but a
sessionless remote Pong reaches the machine, not the originating child socket.
These are distinct liveness loops. The 60-second list probes can keep a child
alive, which is why the independent silent control is required.

The client now auto-Pongs after authenticated receive and its existing lifetime
checks, through the existing bounded encrypted send; the original Ping callback
is preserved. The child proxy consumes a verified Ping after its existing
authority, registry-generation and exact-socket checks, replying on that socket.
A local reply failure closes the child without retry. No timer, crypto format,
authority rule, acknowledgement contract or long-soak criterion changes.

## Focused evidence

The five-file fixed controls pass on both runtimes: 20 passed / 0 failed,
335 assertions (1.4.2: 114.08 s; 1.3.11: 114.18 s). They include the silent
93-second interval, exact client and child `Pong.pingId`, unverified-child
refusal, authority/generation/closed-proxy refusal, existing delivered/uncertain
answer outcomes, real encryption retirement and owned fixture cleanup.
The exact client correlation observer records real decrypted input at the
installed hub `Connection` and immediately calls its original method with
unchanged text; it substitutes neither the crypto nor heartbeat logic.
That correlation pin fails on the old source on both runtimes (0.843/0.853 s).

Six causal families fail runtime assertions on each Bun version (12 failures):
omit client reply; wrong client Ping ID; omit child reply; wrong child Ping ID;
omit child authority check; omit child registry-generation check.
All three private source hashes are restored. Final fast controls pass 6/6
with 30 assertions on each runtime. Two independent read-only reviews found no
remaining findings after adding the exact client ID and child-generation pins.

Generic Linux CI run `37903082004` separately failed before its identity-change
assertion: `ownedRelayOffer`'s fixed 150 ms sleep ended before actual admission.
The fixture now drains the source hub's stderr and waits for its exact
`Relay control admitted` line plus its existing HTTP health check, within the
existing startup deadline. The fixed controls include that original test and
actual assertion/timeout cleanup. No pair-operation retry is introduced.

Receipts: `/private/tmp/remi-r7-heartbeat-pin-634llepn/` and
`/private/tmp/remi-r7-heartbeat-gates-vjh17xem/` (`results.json`, `mutations.json`,
`restoration.json`, original and fixed logs). Root/web-test/R3 TypeScript,
explicit changed-source formatting, spelling and diff checks pass.

## Integration and native continuation

Fresh complete suites on both runtimes and the original 61-minute Linux CI
soak are separate final-head gates; this receipt does not claim their outcome.
The native branch also ignores foreground Ping on direct and relay paths,
source-traced rather than measured. Existing PR #1330 should add its guarded
reply and an idle source control, then retarget its historical backend receipt
pins after #1331 lands. The cold notification-answer deadline is not a
foreground-longevity receipt. Signed/device/deployment acceptance stays separate.
