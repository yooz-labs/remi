# Encrypted terminal prefix probe (#1656)

This test-only phase of #1595 establishes a necessary ownership control before
production relay integration. It does not enable terminal relay support.
The [receipt](terminal-relay-prefix-qualification.json) records the exact probe
hash and six source runs on Mac Bun 1.3.11 and 1.4.2.

The probe constructs the real signed direct terminal service, actual output PTY,
model, ledger view and native TLS receipt peer. It forwards a real normalized
snapshot through the existing relay v2 handshake and Channel, source Worker in
local workerd, and a separate enrolled Bun client process. The protocol endpoints
use the existing test harness; they do not construct production HubRelay or
ChildProxy. Worker-facing connections are local plaintext WebSockets carrying
encrypted relay payloads. The source-service connection uses verified WSS.

Legal trailing JSON whitespace fills the actual snapshot unit to 65,536 bytes.
The strict codec accepts that unit, whose encrypted frame measures 65,561 bytes.
The client checks the exact plaintext hash and snapshot shape after decryption.
No terminal text is written to the probe's result files.

The same real model remains borrowed:

1. While the separate client is actually stopped with SIGSTOP, after Channel.send
   resolves. The probe verifies the owned PID's stopped state.
2. After the client resumes, decrypts the snapshot and sends a wrong encrypted
   pong behind it.
3. While another ordinary encrypted ping/pong completes on the same channel.
4. After the matching ordered encrypted pong, until the original source-service
   native receipt is explicitly confirmed.

The matching encrypted pong is a necessary transport-prefix witness, not UI
receipt or a qualification of all native TLS disposal. The original source
native receipt releases its actual model/view ownership, after which a new real
borrow succeeds. No replacement release callback is used.

Both positive runs pass. Deliberately confirming the source native receipt at
Channel.send completion fails the same borrowed-model assertion on both pins.
The first review found unbounded probe shutdown waits. The corrected probe bounds
client socket close at one second, normal client exit at two seconds, then TERM
and KILL/join at one second each. On both pins a real stopped client that ignores
TERM fails at the intended normal-exit deadline, is killed and joined, and still
publishes its failure receipt after source/Worker cleanup. This is a cleanup
negative, not a successful transport run. No second review was needed for this
narrow correction; the driver qualified it.

All six runs join the owned client, source PTY and local Worker. The fixture
asserts zero actual PTY input and actual PTY process exit. The initial probe
omitted the Worker's existing client `open` notice; that attempt failed and is
retained separately. Consuming that existing notice fixed the probe sequencing;
no Worker behavior changed.

Run from the repository with an owned canonical HOME/TMPDIR, dependencies already
installed, and either pinned Bun binary:

```sh
E2E_BUNDLER=esbuild bun --no-env-file scripts/terminal-relay-progress-proof.ts \
  --run /private/tmp/remi-terminal-relay-positive
```

Add `--premature` or `--stall-shutdown` with a separate result directory for the expected nonzero
negative control. Inspect `result.json`; a nonzero exit alone does not establish
that the intended assertion failed. This manual probe is outside automatic Bun
test discovery and is included in the root TypeScript check.

Remaining production gates include original relay actor/grant/enrollment and
child-generation authority, private admission/version negotiation, bounded
metadata and native ciphertext disposal, complete combined child/hub accounting
under the existing 4 MiB/model and 32 MiB/home policy, all six compiled resource
and held-No cells, terminal-only pressure containment, and a real production
caller. Native, signed-device and deployed acceptance remain separate.
All existing terminal relay guards and capability restrictions stay in place.
