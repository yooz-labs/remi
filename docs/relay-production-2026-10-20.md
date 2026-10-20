# Production relay v2 deployment: 2026-10-20

The owner explicitly approved replacing v1, applying migration v4 and configuring
the shared push bearer on the Worker and this Mac's hub. This records that
deployment and its bounded checks; #1202's full R7 acceptance remains open.

## What is deployed

- Worker: `https://remi-signaling.yooz.workers.dev`.
- Source: `e72012e6f8aa67c300b9bdf478653d8936f80c56`.
- Previous version: `560bfe27-1d35-44bf-bb3d-1af8d356ea48`, migration v3.
- New version: `8110ead2-d14c-4343-b408-3cbd9146d135`, migration v4.
- Both `ConnectionRoom` and `GlobalLimiter` bindings are present. Existing
  variables and the three APNS secrets were preserved. `APNS_BUNDLE_ID` is
  `live.yooz.remi`; `PUSH_AUDIENCE` is the exact canonical HTTPS origin above.
- A new `PUSH_SECRET` was configured through stdin and loaded into this Mac's
  hub. Its value is excluded from logs and receipts. It is stored in an
  owner-only file under `~/.remi/release-secrets/`; the local
  `~/.remi/start-relay-hub` launcher reads it without a command-line literal.
- The old configured `signaling_url` ended in `/connect`; the new CLI refused
  startup with migration guidance. The owner config was backed up and that
  setting changed to `wss://remi-signaling.yooz.workers.dev`. The restarted real
  source hub reported `Relay control admitted`. Existing session daemons were
  left running; old senders still need the new bearer before they can push.

The migration cannot be reversed by rolling code back. Old connection-code
routes are removed. Legacy `/push` remains enabled by default and requires the
bearer; its retirement criteria in the runbook have not been satisfied. Relay
remains opt-in for the released CLI.

## What passed

- The committed deployed-runtime engine check passed all **39 required checks**.
  Its temporary Worker was deleted after the report was saved.
- Before deployment, signaling typecheck and 780 signaling/shared relay tests
  passed on Bun 1.4.3. The esbuild Worker E2E suite passed 179 tests on the pinned
  Bun 1.3.11. The actual Wrangler production bundle dry run passed.
- Seven live checks passed: health 200; retired `/connect` 404; v2 host route
  without upgrade 426; v2 push without bearer 401; authenticated empty v2 push
  400 `MALFORMED`; legacy push without bearer 401; WebSocket upgrade returning
  a valid 32-byte admission nonce. These checks sent no APNS notification.
- Thirteen checks with controlled protocol peers passed against production:
  host admission, stranger refusal, enrollment, enrolled-client admission,
  authenticated pipe opening, bidirectional opaque ciphertext forwarding,
  endpoint decryption of the returned test bytes, edge ping/pong, revocation,
  both active socket closures and refusal after revocation. The synthetic
  AES-GCM payload and test peers do not establish the full relay v2 handshake
  through a shipping client. The test enrollment was revoked and sockets closed;
  no test private keys were persisted.

Full logs and JSON receipts are retained under
`/Volumes/S1/yooz/remi/artifacts/2026-10-19-testflight-backend/relay-production/`
and `relay-live-readonly/` next to it.

## What remains unverified

This does not establish a real TestFlight phone's production APNS delivery,
Notification Service Extension decryption, background/Watch answers, all signed
device recovery and revocation cases, the deployed one-hour R7 session,
hibernation thresholds, alarm precision, limit tuning or production cost. Those
remain separate gates; the source CI soak is a local-runtime regression gate.
