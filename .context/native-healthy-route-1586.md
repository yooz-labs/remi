# Healthy locked-route warning (#1586)

The owner verified Tailscale only persists and reconnects on signed iPhone
0.2.0 (17), but the same machine reports that no Tailscale address is configured.
The actual phone previously authenticated over 100.79.39.98:18765 with its
existing key and rendered its session list. No new address or grant is needed.

An owned source hub on this Mac's existing Tailscale interface reproduces the
exact message through the real native Store and recovery coordinator. The new
`realHealthyLockedTailscaleDoesNotReportItsAddressMissing` test first fails with
two issues: a healthy locked profile remains a recovery target, and foreground
recovery publishes the same missing-address warning. This uses a temporary
Remi home, ephemeral source hub port and generated test identity, never the
owner's hub, sessions or credentials. The first test draft had a nested Swift
macro compilation error; that log is preserved separately from the executable
red control and is not evidence of the behavior.

`MachineRecoveryTarget.permits` correctly prevents replacing a healthy route
with one of equal or lower priority. `MachineStore.recoveryTargets` nevertheless
included healthy Tailscale-only and Relay-only profiles. Local discovery is
correctly disabled under those locks, so the coordinator interpreted its empty
improvement queue as a missing configured layer.

The correction excludes a healthy locked profile from improvement recovery,
ignores late non-success progress once its current state no longer needs
recovery, and clears old recovery progress when that configured route connects.
Disconnected profiles remain eligible; Automatic on healthy Tailscale or Relay
still searches permitted higher-priority layers. Authentication, identity pins,
layer locks, operation retirement, deadlines and retry budgets are unchanged.

The original owned source-hub regression passes after the correction, alongside
the existing real healthy Tailscale/hostile Local discovery control. The latter
confirms Automatic still searches Local without replacing the healthy route
with an untrusted peer. Targeted controls: 15 tests passed. Required full
Swift/Mac/iPhone gates and physical signed-build confirmation remain separate.

Build 18 supersedes consumed build 17 while keeping marketing version 0.2.0.
The owner-confirmed exempt encryption metadata remains embedded and must be
verified in the archive and exported IPA. Crypto and dependencies are unchanged;
this state correction does not require another browser declaration.

The release evidence is under `native-healthy-route-1586/` in the existing
2026-10-19 TestFlight/backend artifact bundle. The intuitive route-control and
complete automatic-transition acceptance requirements remain tracked in #1571;
this narrow warning fix does not claim those checks are finished.
