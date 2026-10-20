# Native local discovery and recovery (#1575)

The local discovery component returns memory-only, untrusted numeric addresses
for saved profiles with a validated full machine key and a policy that permits
Local. An advertisement cannot enroll a device, replace a pin or establish
machine identity. Older publishers remain usable through configured routes.

`LocalMachineDiscovery` browses `_remi._tcp` in `local.` with TXT records and
peer-to-peer disabled. It shortlists the saved key's canonical 16-character
fingerprint, `auth=true` and `role=hub`, then resolves the actual service tuple
with `NetService` on the main run loop. It reads sockaddr address bytes, validates
their family, exact length and port, and rejects loopback, unspecified,
multicast and link-local addresses. TXT hostnames and display names never become
connection addresses. Candidate endpoints carry the saved full pin onward.

The component has one eight-second browser, at most 32 retained matching
services, two simultaneous three-second resolvers and four numeric candidates
per profile. Cancellation retires the sweep epoch before stopping its browser
and resolvers. Removed services remove their queued candidates; reappearing
services resolve again. Addresses are not persisted.

`MachineNetworkPathMonitor` emits path changes as triggers. A satisfied path
does not establish hub reachability or Tailscale availability.
`MachineRecoverySchedule` and `MachineRecoveryProbeBudget` define the recovery
limits: 750 ms debounce, 30-second cooldown, at most three sweeps per episode,
15/60-second retry delays subject to the cooldown, a 180-second sweep deadline,
eight starts per sweep, two concurrent probes and one per profile. These value
objects do not install connections or replay operations.

Both app plists declare `_remi._tcp`; the Mac plist supplies a local-network
purpose string and the existing iPhone purpose remains in its build settings.
The entitlements do not add a server or multicast entitlement. Bonjour denial
uses the DNS policy-denied error documented in Apple's
[TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy).
An agent never accepts the operating system's permission prompt.

## Source publisher interoperability

The source publisher now defaults to a bounded instance name containing its
role and port. Explicit `name` values retain their existing behavior. This
prevents same-host hubs and session daemons from choosing the same instance
name: the installed `bonjour-service` stops publication on a name conflict,
even though the CLI has already logged that advertising started.

The publisher also supplies a validated `.local` SRV target, removing trailing
dots and appending `.local` only when absent. The library still generates its
A/AAAA records from real interfaces. Its previous bare `os.hostname()` target
could be browsed by its own browser but timed out in Apple's `NetService`.
Bind and TLS suppression are unchanged.

The owned source control captured one name collision before the instance-name
change. After that change, it observed separate hub/session service tuples but
the bare SRV target still produced `NSNetServicesErrorCode=-72007`, domain 10,
and no resolved address. With the `.local` target, the same real source hub and
inert source session coexist, the native shortlist excludes the session, and a
connection authenticates the saved full key, verifies session-less Hello and
requests the session list. The fixture uses a fresh restricted home, a public
client grant and controlled inert CLI, then releases and stops only its own
processes.

## Reproduce the independent controls

Use the repository's pinned Bun 1.3.11 on parent and child PATH:

```sh
PATH=/private/tmp/remi-1570-tools:/usr/bin:/bin \
REMI_LOCAL_DISCOVERY_TEST=1 REMI_LOCAL_DISCOVERY_SOURCE_TEST=1 \
swift test --package-path packages/native/RemiKit --jobs 2
bun test packages/daemon/tests/mdns
bun run typecheck
bun x --no-install biome check .
```

The real Bonjour controls cover hub/session/auth/fingerprint filtering,
disappearance/reappearance with a changed port, 40 advertisements bounded to
32 services and four candidates, resolver concurrency, cancellation and path
monitor lifecycle. Sockaddr controls cover malformed lengths/families/ports,
IPv4/IPv6 exclusions and mapped IPv4 normalization. Schedule controls cover
debounce, cooldown across path epochs, exhaustion and nonrefundable probe leases.

At this independent-component checkpoint, Store-owned probing, same-socket
promotion and app lifecycle integration are still awaiting phase 2's admission
seam. These controls do not prove that integration, rendered UI, signed Mac or
iPhone permission behavior, physical network transitions or TestFlight
acceptance. Discovery requires a compatible advertising hub on a reachable
local network and supplies no VPN.
