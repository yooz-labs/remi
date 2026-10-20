# Native app parity

Verified against production callers on 2026-10-11. This describes what ships in the
native targets now, not planned behavior.

| Capability | Capacitor client | Native iPhone | Native Mac | Remaining work |
|---|---|---|---|---|
| Direct WebSocket and reconnect | Yes | Yes | Yes | Direct transport is not encrypted by Remi; keep the pairing warning. |
| First-run machine onboarding | Yes | Yes | Yes | Each shipping client presents an explicit empty-machine action. Native routes that action through its real add-machine flow rather than a preview-only destination. |
| Ed25519 identity and local approval | Yes | Yes | Yes | Real-hub approval integration test passes. |
| `remi pair` QR onboarding | No | Yes | No | iPhone scans in-app, validates every shared ADR 0037 vector, pins the full daemon key, and sends the nonce in the signed challenge response; terminal approval remains mandatory. |
| Multiple machines and session daemons | Yes | Yes | Yes | Native apps persist machine/session scope. Machine identity remains `host:port` until protocol #1234. |
| Session list and transcript history | Yes | Yes | Yes | Native renders text and tool-only transcript entries. |
| Pending cards and cross-client dismissal | Yes | Yes | Yes | Native decodes the frozen decision object, renders unknown kinds generically, removes resolved notifications immediately, and briefly names a known resolution source. |
| Binary and standing-option answers | Yes | Yes | Yes | Answers use wire values; session grants are labeled. |
| AskUserQuestion structured selections | Yes | Yes | Yes | Native supports option and validated free-text answers for single-select subquestions. |
| Plan approval and terminal-only cards | Yes | Yes | Yes | Terminal-only cards never offer answer controls. |
| Typed chat with prompt guard | Yes | Yes | Yes | Native apps present daemon errors in dismissible banners. |
| Create session | Yes | Yes | Yes | Native apps support recent repositories, new worktrees, advertised harnesses, optional model selection, and legacy fallback. |
| Add/persist direct machines | Yes | Yes | Yes | Native apps can forget endpoints without stopping their remote sessions. Discovery is not inferred on loopback. |
| Local card notifications | Yes | Yes | Yes | Native apps notify once for new cards and remove resolved notifications. iPhone Preferences and Mac Settings request system permission from an explicit action; both explain denied access and link back to system settings. |
| Remote push / lock-screen answers | Yes | Yes — hardware verified | Implemented — acceptance open | The signed iPhone path has physical lock-screen Yes and Watch-mirrored No evidence in #1242. Mac source registration and action handling ship, but two-machine signed-Mac acceptance remains open. |
| Kill/resume session | Yes | Yes | Yes | Native apps terminate daemon-owned sessions with confirmation and offer Resume for resumable stored sessions. A child response follows the returned port and opens after its authenticated hello; same-daemon responses open immediately (#1309). |
| Subagent conversation picker | Yes | Yes | Yes | Native apps expose active and finished subagents as read-only conversations. |
| Haptics and notification preferences | Yes | Yes | N/A | iPhone preferences control local question alerts, sounds, and answer feedback. |
| Relay connection | No shipped client path | Yes — hardware verified | Implemented — acceptance open | Native relay v2 pairing, authenticated channels, secure push registration, and signed answers ship. Deployed-provider and remaining recovery/polish gates stay tracked by #1242. |
| Diff, files, terminal view | Web has terminal-era surfaces | No | No | Out of scope X5 (#1245). |

The Capacitor app should not be retired yet. Native relay and background-answer source
paths ship, but #1242 still owns signed Mac, recovery, and remaining hardware acceptance;
deeper files, diffs, and terminal surfaces remain X5 work.

## X3/X4 caller evidence

- iPhone first run: `RemiPhoneApp` creates `PhoneLiveRootView`, whose `HomeScreen`
  resolves zero persisted machines to `FirstRunScreen`; its Add machine action opens
  the same `PairingScreen` sheet whose callback reaches `MachineStore.addMachine`.
- Mac first run: `RemiMacApp` creates `MacLiveRootView`, which presents
  `MacFirstRunView` for an empty `MachineStore` and opens the production add-machine
  sheet through its callback.
- Notification permission: `PhonePreferencesSheet` calls
  `PhoneNotificationCoordinator.requestAuthorization`; `MacPreferencesView` calls
  `MacNotificationPermission.request`. Neither app treats permission as machine
  authorization, and Mac no longer requests it from the invisible question monitor.
- Relay lifecycle: both app delegates forward APNs registration, secure default taps,
  secure actions, and dismissals to `NativeRelayNotifications`; both live roots expose
  relay notification enablement and present verified notification content from their
  production `MachineStore`. `NativeSecureSourceIntegrationTests` exercises native
  pairing, registration, capsule opening, and signed answer delivery against the actual
  TypeScript fixture. This source/fixture evidence is not a substitute for the remaining
  signed-Mac and deployed recovery checks in #1242.
- Recovery: both live roots pass retry actions to `MachineStore.retryApproval` and
  `MachineStore.retryConnection`; relay states that require a fresh token do not offer
  a direct retry that would imply the expired pairing can recover itself.
