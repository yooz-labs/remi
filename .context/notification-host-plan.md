# Host notification registration and delivery (#1679)

Depends on the reviewed notification-only scope in #1682. This local phase branch includes that dependency while its hosted R7 gate runs; its PR will show only this phase after the dependency merges. The owner approved the architecture and selected automatic renewal during active authenticated use with Continue/Revoke after 30 days inactive.

## Contract

Add `notification_host_request`/`notification_host_response`, capability `notifications`, and golden fixtures. The request has only an action (`status`, `enable`, `continue`, `revoke`) plus its envelope; it never accepts an identity selector or APNs token. Derive the device from the currently authenticated direct Connection. Responses distinguish registration required, active, renewal required, revoked, host setup required, unsupported and storage/authority failure. A configured host returns its WSS relay origin, already anchored to the machine key authenticated by the direct socket, plus effective expiry. A capability-only peer or another adapter cannot enroll a device.

`enable` idempotently enrolls only the current grant for notification scope and obtains Worker edge acknowledgement before reporting registration-ready. Token registration then uses the existing encrypted v2 channel. No plaintext direct token transport, new crypto primitive, foreground route change or implicit full-relay enrollment is added. Explicit host relay/network disablement remains authoritative; unavailable host push configuration is shown as setup required.

## Lifetime

Add a read-only secure subscription state query. Active direct app use renews only a still-current subscription; expiry markers are never cleared by reconnect/renew. An expired subscription returns renewal required. Continue permits a fresh encrypted registration; notification-only registration explicitly distinguishes consent to renew an expired epoch. Preserve older full-relay registration behavior and all key floors. Default lease becomes 30 days for new default configuration; explicit host lease overrides remain visible and respected.

## Hub-owned provider credential

Session daemons prepare and sign/seal their own event through the existing context/transport guards. When their process has no provider credential, use an owned capability-proved loopback submission to the configured hub. The hub checks its own machine/provider origin, current recipient authority/subscription, and a current registered child pid/port/runtime generation before invoking the provider. It never receives or forwards unsealed question content, never accepts an arbitrary destination URL, and never exposes its bearer secret to the child process or agent. No automatic retry of uncertain acceptance. Missing setup and lost hub are explicit non-delivery outcomes.

## Verification and limits

Use strict shared codec fixtures, real identity/notification/subscription stores and real authenticated direct/relay/HTTP controls. Negative cases: capability-only and unauthenticated enrollment; caller identity fields; grant/connection change across awaits; missing provider/Worker edge; expired automatic enable; stale Continue; revocation; alternate destination/machine/recipient; dead or replaced child runtime; lost provider response. No capability is advertised before the connected host path is available. Run relevant suite, typechecks/lint, security review and hosted gates. Native UI, signed APNs, extension decryption and Watch are later acceptance layers.
