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

The Store owns `MachineRecoveryCoordinator`. Initial configured routes keep
their normal connection path; a saved pinned route's reachability failure
retires its generations and hands subsequent candidates to bounded recovery.
A configured authentication or approval stop still stops that attempt.
Path changes, foreground activation and explicit Retry start new episodes,
subject to the global cooldown. A healthy route stays active while only a
strictly preferred layer is probed; a healthy same-layer route is not replaced.

Each `MachineRecoveryProbe` owns a real connection outside active Store maps.
Its `recoveryProbe` policy performs exactly one direct or relay socket attempt,
including authentication refusals and orderly relay endings. It keeps the
five-second opening, 30-second authentication and five-second post-auth Hello
limits for direct connections. Relay requires an existing exact pinned
enrollment and the channel broker; one-shot notification contention is reported
as busy, and a retired candidate cannot resume outside the recovery budget.
Recovery never uses the background mode that skips application Hello.

Before promotion the candidate must authenticate the saved full key and derived
machine ID and return session-less Hello. Older configured hubs can omit the
optional machine descriptor; their authenticated full key still has to derive
the saved ID. A bounded 128-callback bridge fences overflow synchronously, and a
separate producer fence revokes admission if the candidate socket fails while
the MainActor awaits transport admission. The final synchronous Store commit
rechecks profile lifetime, policy revision, lifecycle epoch and current healthy
layer before retiring old root/child generations and installing the same socket.

Promotion makes held answer and resume outcomes uncertain, leaves an explicit
notice for other pending operations, and requests fresh sessions. No answer,
Cancel, chat, resume or create operation is replayed. Discovered routes have a
separate four-route memory cap and never enter persisted route profiles; alias,
full pin, enrollment and navigation identity are retained. iPhone background
suspension stops browsing, monitoring and probes before invalidating callbacks;
Mac monitoring follows its existing foreground-service lifecycle. Notification
answer actions do not start discovery. Both settings surfaces show active and
attempted layers separately, including recovery refusal and exhaustion messages.

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

The integrated controls also use hostile owned Bonjour peers that copy a saved
fingerprint but present another full key, refuse authentication with approval,
queue or store errors, claim a session Hello, overflow callbacks or close during
admission. The candidate socket is real; those controls explicitly identify
their post-verification healthy Store fixture rather than claiming real relay
acceptance. A separate source-hub control proves real discovery, authenticated
same-socket Store promotion, unchanged durable routes and fresh session state.

An additional opt-in control requires explicitly selected existing owned LAN
and Tailscale interface addresses. It establishes a real saved full-key source
hub connection over Tailscale, publishes a hostile Local service with its copied
short fingerprint, checks that Local is refused without changing that healthy
connection object or generation, then requests and receives a fresh correlated
session list on the original socket. It does not configure or administer a VPN:

```sh
PATH=/private/tmp/remi-1570-tools:/usr/bin:/bin \
REMI_OWNED_RECOVERY_NETWORK_TEST=1 \
REMI_RECOVERY_LOCAL=<owned-existing-lan-address> \
REMI_RECOVERY_TAIL=<owned-existing-tailscale-address> \
swift test --package-path packages/native/RemiKit --jobs 2 \
  --filter MachineRecoveryIntegrationTests.realHealthyTailscaleSourceSurvivesWrongKeyLocalDiscovery
```

Unsigned native builds, rendered UI, signed Mac/iPhone permission behavior,
physical device network transitions and TestFlight acceptance remain separate
gates. Discovery requires a compatible advertising hub on a reachable local
network and supplies no VPN.
