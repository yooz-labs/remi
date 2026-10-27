# Plan: paired-device notification delivery (follow-up to #1667)

## Context

The owner's requirement is that a paired, registered device with notification permission receives agent questions regardless of the foreground connection, with a concise summary and short meaningful choices. Full requests and option descriptions remain available inside Remi.

Five load-bearing facts were checked against source and live diagnostics on 2026-10-26:

1. `MachineStore.enableRelayNotifications` and `registerRelayToken` require `endpoint.relayPin`; a direct-paired machine cannot register native secure pushes. `SecurePushStore.captureAuthority` requires both current authorization and relay enrollment. OS notification permission alone therefore does not establish a working push subscription.
2. `cli.ts` creates `SecurePushService` only with relay configuration, a signing identity and a push secret. The running host logs contain the explicit missing-secret refusal. A freshly opened terminal does not necessarily have the hub's provider credential.
3. `NotificationDispatcher.computeDelivery` suppresses non-held question pushes for any attached client. #1674 removes that gate without changing subscription validity, device preferences, deduplication, token pruning or authorization.
4. The native NSE copies the signed capsule body directly. The Foundation Models summarizer is used by local alerts only. #1674 bounds previews for questions that already require the app and preserves the complete ask supporting a one-tap permission.
5. `RemiPushStore.verifyAction` checks displayed text and category against the reopened signed capsule. `NativePushActionPolicy` supports only verified Yes/No and session-rule Yes/Always/No shapes. The full-detail guard deliberately excludes truncated commands and plans. At initial diagnosis the default lease was 24 hours; the approved #1679 change sets a 30-day default while preserving durable expiry markers. Registration lifetime and authorization remain separate policies.

Local diagnostics are not signed-phone or Watch acceptance. This work does not treat an APNs 2xx response as proof of handset delivery.

## What already exists to reuse

- `SecurePushStore`, `SecurePushContexts`, `SecurePushService` and `SecurePushTransport`: current grants, epochs, revocation, per-device preferences, sealing, prepared requests and finite delivery outcomes.
- `HubRelay`, `RelayDeviceStore`, the existing encrypted v2 handshake and `secure_push_register_request`: enrollment, device authentication and encrypted registration transport.
- `NativeRelayNotifications`, `RemiPushStore`, the native NSE and the native answer ledger: pinned machine trust, recipient keys, notification verification, replay protection and signed one-shot answers.
- `RemiPushPresentation`, `QuestionNotificationSummarizer` and `LocalQuestionNotificationPlan`: notification importance, grouping and existing local presentation.
- #1673/#1675: live status consumption and selected-history recovery. #1674: attached-client delivery and concise app-review previews. Do not reimplement those changes.

## Approach

Make notification subscription a property of a paired host and device identity, independent of the foreground Local/Tailscale/Relay route. Preserve the machine's saved route lock, key pin, alias and existing grants.

Use the existing encrypted v2 channel for token registration and background answers. Add a notification-only enrollment scope, anchored in the host key already authenticated by direct pairing. Its allowed operations are secure registration/unregistration and a currently valid signed notification answer. It must not grant remote session browsing, chat, session creation, terminal, file or raw PTY access. Existing full relay enrollments remain full enrollments; enabling notifications must not silently create a full foreground relay route. This is preferred to inventing another crypto protocol or sending APNs tokens over an unencrypted direct socket.

Advertise the host's notification service and readiness through a reviewed optional capability/descriptor contract. An authenticated direct client can request notification-only enrollment for its existing key, then complete the existing encrypted handshake for registration. OS permission plus completed pairing initiates registration automatically; per-host/device settings can mute or disable it. Show registering, enabled, needs host setup, denied, expired and failed states instead of treating permission as delivery readiness. A missing provider credential is an explicit host setup problem. Sessions should use the hub-owned notification service rather than requiring every terminal to inherit a deployment secret; the local submission path must require actual loopback capability and bind the event to the verified child runtime.

The owner approved notification-only enrollment after pairing and OS permission, then selected automatic renewal during authenticated active use with an explicit Continue/Revoke choice after 30 days inactive. Push does not require a foreground socket. Disablement, host/device removal, token invalidation, key change and authorization revocation stop delivery. Retain epoch/version floors and durable expiry markers; only a fresh explicitly consented registration replaces an expired epoch. The earlier indefinite-persistence proposal is superseded by this policy (#1677).

Presentation is separate from authority. Target a body of at most 160 characters and action titles of at most 32. Use exact known meanings such as Allow once and Deny for a fully represented, verified binary permission. Preserve actual option values and signed content identity. A generated or truncated summary must never support a new one-tap allow or standing grant. Requests whose meaning does not fit get Review request, opening the full current card. Short generic choices require a reviewed signed category/answer contract; do not infer them from option position or ask a model to invent their meanings. Plans and multi-question forms open the app. Optional on-device model summaries always have a bounded deterministic fallback and never alter answers.

## Files

Expected backend changes:

- `packages/shared/src/protocol.ts`, protocol capability/fixture definitions, and the relay v2 payload schemas: the reviewed notification descriptor, scoped enrollment request/result and any signed review-action shape.
- `packages/daemon/src/remote/hub-relay.ts`, `relay-device-store.ts`, `native-answer-ledger.ts`, and enrollment storage: notification-only admission and operation allowlist.
- `packages/daemon/src/notifications/secure-push-store.ts`, `secure-push-contexts.ts`, `secure-push-service.ts`, and `cli.ts`: active renewal/inactive consent, host readiness and capability-proved child delivery through the hub.

Expected native changes:

- `RemiKit/Protocol/WireMessages.swift`, `Store/MachineStore.swift` and `Notifications/NativeRelayNotifications.swift`: route-independent notification intent, registration and lifecycle.
- `RemiPush/RemiPushStore.swift`, `RemiPushActions.swift`, `RemiPushServiceExtension.swift`, and native trust storage: notification-only transport trust and verified presentation.
- Both notification coordinators and existing notification settings panels: visible per-host delivery state and concise actions.

Keep changes in independently reviewable PRs: enrollment contract, host delivery/lifetime, native registration, then presentation and device acceptance. No new third-party dependencies.

## Decision gate

Do not ship the new registration capability unless all of these pass:

- Direct-paired Local-only and Tailscale-only profiles register a secure recipient without changing foreground routes or adding full relay authority.
- Notification-only peers cannot browse, chat, create sessions, use files or terminals, or access raw PTY. Existing relay clients retain their current behavior.
- A manually launched Claude or Codex session can deliver through the configured hub without exposing its provider secret to the session command or shell.
- Permission, per-device preferences, current grants, token/key generation, content digest, runtime identity and revocation remain enforced at their current effect boundaries. Every attempted answer has at most one effect and no automatic replay.
- With foreground apps suspended, a fresh and a long-idle registration deliver a controlled question on both signed native apps; an answered question loses its notification action. Host removal, revoked authorization, invalid token and stale signed answers fail closed.
- Informative notifications fit the body/title budgets. A shortened/generated display never enables an allow that the original full-detail guard rejected.
- Required local and hosted checks pass, followed by a signed iPhone and paired Watch witness. Provider acceptance, extension decryption and physical delivery have separate receipts.

If a gate fails, retain the previous capability advertisement and explicit disabled/setup-needed state. Do not enable plaintext fallback, silently expand relay scope or claim delivery.

## Prerequisites (user actions)

The owner provides or configures the existing Worker push secret through the host's protected setup path; no secret should be pasted into chat. Signing/TestFlight distribution and physical iPhone/Watch checks remain owner-controlled. The remote host needs an existing trusted management connection for any configuration changes; no SSH host-key warning is bypassed.

## Agent budget

One lead implements phases sequentially; at most one fresh reviewer per PR, up to four reviewers total. No account-backed model turns, live permission answers, production deployment or app publication are part of automated diagnostics.

## Approved decisions

- Enable notification-only relay enrollment automatically after completed host pairing and OS notification permission, without adding a foreground relay route.
- Renew automatically during authenticated active use, ask Continue/Revoke after 30 days inactive, and never silently revive an expired epoch.
- Keep one-tap allow limited to a fully represented verified request; long/complex requests get a short Review request action. Do not turn a summary into permission to execute unseen details.
- Keep the provider credential on the hub and add a capability-proved local child submission path, rather than distributing that credential to every new terminal.

## Verification

Use existing golden protocol fixtures and actual source hub/native integration fixtures. Add controls for scoped-method refusal, stale enrollment/token/key epochs, host credential absence, hub loss, foreground backgrounding, reconnect and route locks. Run daemon/shared/signaling tests, typechecks and lint, plus RemiKit and unsigned native builds. Review crypto/auth scope changes before merge. Measure signed APNs acceptance, extension opening, displayed copy/actions, answer/dismissal and Watch mirroring separately on owner devices. No live release, installed daemon replacement or signed publication occurs until its concrete reviewed artifact is approved.
