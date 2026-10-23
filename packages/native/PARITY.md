# Native app parity

Verified against production callers on 2026-10-23. This describes what ships in the
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
| Cross-machine Inbox | No | Yes | Yes | Mac sidebar Inbox entry with a count badge lists waiting cards from every machine; answers go through `MachineStore.answer(machineID:...)`; Open conversation switches machine and session by qualified key. |
| Conversation loading state | No | Yes | Yes | Mac shows the shared `RemiConversationPlaceholder` (loading, loading more, empty) and hides transcript-only toolbar items until there is something to navigate. |
| Machine problem rows and recovery notes | No | Yes | Yes | Mac sidebar uses `RemiMachineStripPresentation` (problem rows, unique labels for same-named machines, accessibility labels) and `RemiMachineRecoveryState` copy. The recovery actions stay in the sessions column. |
| Menu bar commands | N/A | N/A | Yes | Go menu (Inbox, Next and Previous Needs You, Previous and Next Session, Previous and Next Machine, Reconnect) and Find in Conversation. |
| Window state restoration | No | Partial | Partial | Mac restores column layout and per-session unsent drafts per window with scene storage; machine and session selection already persisted. The Inbox view itself is not restored. |
| Diff, files, terminal view | Web has terminal-era surfaces | No | No | Out of scope X5 (#1245). |

The Capacitor app should not be retired yet. Native relay and background-answer source
paths ship, but #1242 still owns signed Mac, recovery, and remaining hardware acceptance;
deeper files, diffs, and terminal surfaces remain X5 work.

## X3/X4 caller evidence

- iPhone first run: `RemiPhoneApp` creates `PhoneLiveRootView`, whose `InboxScreen`
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

## Mac window parity (#1628)

What ships in `packages/native/Mac` and the shared `RemiUI` rules behind it:

- Loading: `MacSessionDetail` resolves `RemiConversationPlaceholder` from
  `MachineStore.isLoadingTranscript(machineID:sessionID:)`, as `SessionScreen` does.
- Inbox: `MacLiveRootView` lists an Inbox row above the machines (badge from
  `RemiInboxPresentation.waitingCount`). Selecting it shows `MacInboxColumn` in the middle
  column; the machine and session selection are kept and return when a machine is chosen.
- Sidebar: `MacMachineProblemRows` and `MacMachineSidebarRow` take their copy and labels from
  `RemiMachineStripPresentation` and `RemiMachineRecoveryState`. The machine switcher menu
  announces the selected machine.
- Commands: `MacCommands` publishes the Go menu and Find in Conversation. Enable and disable
  rules are `RemiMacCommandAvailability` and `RemiNeedsYouJump`, covered by
  `RemiMacCommandRulesTests`. Shortcuts moved from the toolbar buttons to the menu
  (Next Needs You, Previous and Next Session, Previous and Next Machine, Find); the buttons stay.
  The jump to the next needs-you session works across machines.
- Restoration: `@SceneStorage` holds the column layout (`RemiMacColumnLayout.storageValue`) and
  the unsent drafts (`RemiSessionDrafts`, at most 16 drafts of 4,000 characters, keyed by
  machine and session).

What does not ship or is not verified:

- No window of the Mac app was launched for this change. It builds unsigned, and the rules are
  unit tested; the layout, badge, menu enablement and restoration have not been seen running.
- Scene storage is not encrypted storage. Drafts are typed chat text kept on this Mac only
  until the window's state is discarded.
- A search text or filter in the session list can hide the session a Next Needs You jump
  selects; the list then reselects its first visible session.
- The Inbox view is not restored on relaunch (only machine, session, columns and drafts).
- Machine recovery actions (retry, approval commands) remain in the sessions column; the
  sidebar only names the state.
- The `remi pair` QR flow is still iPhone only.
