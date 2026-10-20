# Native iOS Live Activities research archive

> **Archived 2026-10-08. Do not implement from this file.** The earlier guide combined historical Capacitor work, obsolete daemon states, and an intended relay answer path as though they were a verified native implementation plan. None of the native Live Activity, ActivityKit push, App Intent answer, remote APNs, or Notification Service Extension paths described there ships in `packages/native`.

Use [`packages/native/PLATFORM-KNOWLEDGE.md`](../packages/native/PLATFORM-KNOWLEDGE.md) for the current Apple-platform boundary and the root `AGENTS.md` for the current question, notification, authorization, and transport behavior. Git history retains the old implementation sketch if its design exploration is needed.

## Facts retained from the research

- A Live Activity would need a widget extension, `ActivityAttributes`, an explicit lifecycle, and owner-controlled provisioning.
- Background Live Activity updates require ActivityKit push-token registration and the live-activity APNs topic. Remi has not implemented that mode, and credential or provisioning compatibility has not been verified.
- Interactive Live Activity buttons use App Intents. A future answer intent must use the same authenticated, expiring, replay-resistant answer path as the app; there is no verified connection-independent native answer path today.
- A Notification Service Extension can alter notification content before display, but notification action titles come from registered categories and are not dynamically defined per notification.
- The old `evaluating` / `approved` lifecycle and auto-resolve language became obsolete when Remi deferred permission judgment to the harness (#1125, [ADR 0030](decisions/0030-defer-permission-judgment-to-the-harness.md)). A future activity must be designed from the protocol and daemon states that actually ship at implementation time.

## Required restart point

Before reopening this feature, trace and test:

1. the current question-created and question-resolved caller paths;
2. secure server-originated push delivery, including payload confidentiality, authentication, expiry, and replay protection;
3. owner signing, the app/widget App Group, bundle identifiers, and physical-device provisioning;
4. answer resolution on the phone, terminal, and another device under the first-answer-wins rule;
5. stale activity cleanup after disconnect, session close, expiry, and app termination.
