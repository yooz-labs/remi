# Private direct-address ATS correction (#1583)

The signed physical iPhone 15 Pro Max, on iOS 27.0.1 and native 0.2.0 (15),
recorded `NSURLErrorDomain -1022` after retrying this Mac's numeric Tailscale
address. The OS rejected the WebSocket before device authentication.
The app's generic authentication/protocol error did not describe that failure.
The scoped Console capture was paused after collecting the error.

The application plists had no ATS exception for numeric private addresses.
Apple documents IP/CIDR exception domains on iOS 17 and macOS 14 onward:
[NSExceptionDomains](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsexceptiondomains).
The supported native OS minimums are newer than those versions.

## Scope and policy

Reuse the existing direct WS transport and signed device authentication.
[ADR 0009](decisions/0009-transport-encryption-scope.md) permits the existing
monitor path on owner-managed networks/tunnels; this does not enable new
link/download features whose separate acceptance requires HTTPS/WSS.

Both app bundles permit insecure HTTP loads only for these numeric addresses:

- RFC1918 LAN: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`.
- Tailscale IPv4 range: `100.64.0.0/10`.
- Loopback: `127.0.0.0/8` and `::1`.
- IPv6 unique-local addresses, including Tailscale: `fc00::/7`.

No global arbitrary-load/local-network exception or public-address exception
is added. No TLS version, certificate validation, identity pin, authorization,
layer lock or deadline changes. Extensions keep their existing ATS policy.
LAN WS remains unencrypted by Remi; Tailscale supplies its own transport privacy.
ATS -1022 is an explicit terminal policy error and cannot trigger fallback.

## Verification and release gates

The new metadata control fails on both original app plists.
Require it to pass on the changed source and actual exported app metadata,
with the exact exception allowlist and no broader ATS keys.
Run the Swift package, Mac build/tests and generic iPhone Simulator build.
Keep the focused review separate from completed route-component reviews.

A Mac Foundation bundle probe opened numeric Tailscale and MagicDNS sockets
without an exception. That probe does not reproduce signed iPhone enforcement
and is not accepted as the physical fix proof.
Native 0.2.0 (16) must pass the original signed phone numeric-address failure
after TestFlight distribution; until then the physical fix is unverified.
No provider input, owner-session restart or implicit relay enrollment is needed.

The frozen CLI 0.8.1 promotion remains at its reviewed commit.
Do not merge this branch into develop until that promotion has landed.
Parent #1571 remains open for the remaining physical route acceptance.
