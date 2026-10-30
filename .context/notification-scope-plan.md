# Notification-only host admission (#1678, phase 1 of #1677)

Approved architecture, 2026-10-26: reuse the encrypted v2 transport for notification registration and signed answers without granting full relay access. The owner selected rolling renewal during authenticated activity, followed by explicit Continue/Revoke after 30 days inactive. This phase does not implement lifetime, advertise capability or add a production enrollment caller.

## Verified constraints and reuse

Older `RelayDeviceStore` readers ignore unknown row fields and admit every row in `relay_devices.json` that has a current direct grant. Therefore a scope field in that file cannot safely represent a notification-only device. Store notification enrollments in `notification_devices.json`, bounded to 64 rows, with an authorization epoch captured from the existing direct grant and a distinct enrollment epoch. Existing full enrollment files remain unchanged. The legacy push activation latch is set before writing any notification enrollment so no old daemon can restore plaintext delivery.

Reuse the existing identity store lock, restricted atomic writes and `SecurePushStore` subscription epoch checks. A current full relay enrollment supersedes notification-only authority and invalidates the previously captured notification epoch, so an open channel cannot acquire broader scope through a storage change. Revoking/regranting the same key does not revive its previous notification enrollment.

## Host boundary

The Worker enrollment set can include either scope. Scope is captured by the host after the encrypted handshake authenticates the enrolled key. Notification-only application ingress allows secure push registration/unregistration, valid signed native answers and ping/pong; every other family, including future registered families, closes before application ACK or effect. The ordinary native-answer verifier and child proof/effect path remain authoritative. Notification peers receive no machine broadcasts or incidental child output. Current grant/enrollment generations are rechecked by the existing effect boundary.

## Files and gates

New storage and scoped-device modules; existing secure subscription store and host relay admission/routing; the real HubRelay/Worker fixture and new real file/crypto/channel tests. Verify old relay readers see no new full enrollment, grant replacement/revocation, invalid storage, full-scope upgrade retirement, allowed register/unregister and refusal of Hello/session discovery/chat/answers/session creation/transcript/terminal families. Run related secure subscription, native answer and full relay controls, typecheck, lint, spelling and hosted R7 checks. One fresh security review, then at most a substantial-fix delta. No live host or app is changed by these tests.
