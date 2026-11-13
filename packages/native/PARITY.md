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
| Session list and transcript history | Yes | Yes | Yes | Native renders text and tool-only transcript entries; a run of 3 or more consecutive tool entries is one expandable row (the newest entry and search matches are never grouped), and a session named `<machine>:<name>` shows `<name>` (#1647). |
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
| Cross-machine Inbox | No | Yes | Built, not run | Mac sidebar Inbox entry with a count badge lists waiting cards from every machine; answers go through `MachineStore.answer(machineID:...)`; Open conversation selects the card's machine and then its session (the stored selection is a machine id plus a bare session id). |
| Conversation loading state | No | Yes | Built, not run | Mac shows the shared `RemiConversationPlaceholder` (loading, loading more, empty) and hides transcript-only toolbar items until there is something to navigate. |
| Machine problem rows and recovery notes | No | Yes | Built, not run | Mac sidebar uses `RemiMachineStripPresentation` (problem rows, unique labels for same-named machines, accessibility labels) and `RemiMachineRecoveryState` copy. The recovery actions stay in the sessions column. |
| Menu bar commands | N/A | N/A | Built, not run | Go menu (Inbox, Next and Previous Needs You, Previous and Next Session, Previous and Next Machine, Reconnect) and Find in Conversation. |
| Window state restoration | No | Partial | Partial | Mac restores column layout and per-session unsent drafts per window with scene storage; machine and session selection already persisted. The Inbox view itself is not restored. |
| Read-only terminal view | Web has terminal-era surfaces | Built, unreachable | No | The iPhone has the pane, a strict view controller, and a monochrome screen view (#1639), shown only when the machine advertises `terminal_view` and the route can carry it. No daemon advertises it yet, and the app has no secure transport for it (ADR 0047), so it cannot be used. Mac wiring is not done. |
| File download by path | Web has terminal-era surfaces | Built, unreachable | No | The iPhone has a download sheet driven by the strict state machine (#1639), shown only for `file_download` on a route that can carry it. The app has no signed direct HTTPS/WSS transport (ADR 0045), so it cannot be used. There is no directory browsing in the protocol. Mac wiring is not done. |
| Diffs | Web has terminal-era surfaces | No | No | Out of scope X5 (#1245). |

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

No window of the Mac app was launched for this change. The Mac target builds unsigned, and
the `xcodebuild test` run could not start here (pseudo terminal setup error). What is
verified is the build and the unit tests of the shared rules in `RemiUI`
(`RemiMacCommandRulesTests`, `RemiSessionDraftsTests`, `MacWorkspaceNavigationTests`,
`InboxPresentationTests`, `RemiMachineStripPresentationTests`, `MachineRecoveryStateTests`).
The rows above for the Mac Inbox, loading state, problem rows, menu commands and restoration
describe code that is wired and compiles, not behavior seen on screen.

What the code does:

- Loading: `MacSessionDetail` resolves `RemiConversationPlaceholder` from
  `MachineStore.isLoadingTranscript(machineID:sessionID:)`, as `SessionScreen` does.
- Inbox: an Inbox row sits above the machines (badge from
  `RemiInboxPresentation.waitingCount`). Selecting it shows `MacInboxColumn` in the middle
  column and gives the columns back if the window was conversation-only. Machine and session
  selection are kept and return when a machine is chosen. Selection is stored as
  `remi.mac.selected-machine` plus a bare `remi.mac.selected-session`, not as a qualified key;
  the qualified key is used when jumping between sessions.
- Sidebar: `MacMachineProblemRows` and `MacMachineSidebarRow` take copy and labels from
  `RemiMachineStripPresentation` and `RemiMachineRecoveryState`.
- Commands: the Go menu and Find in Conversation (`MacCommands`). Enable rules are
  `RemiMacCommandAvailability` and `RemiNeedsYouJump`. Next Needs You works across machines;
  Previous and Next Session follow the filtered list the sidebar shows; Reconnect is off while
  the Inbox is shown. Find in Conversation is a focused value: it is enabled only while focus
  is inside the conversation, so the session list keeps Command-F for its own search; the
  toolbar search button works regardless.
- Restoration: `@SceneStorage` holds the column layout and unsent drafts. A restored
  conversation-only layout is checked again once the machine's session list loads and falls
  back to the expanded layout if the session is gone.

Limitations found:

- Drafts can contain secrets the person typed. Scene storage is not encrypted, so they are
  stored unencrypted on this Mac. Live drafts are exact in memory; the stored copy is bounded
  (16 drafts, 4,000 characters each), written after a one-second pause or when the window
  leaves the foreground, and drafts of ended sessions or removed machines are pruned. A draft
  longer than the bound is cut only when read back after a relaunch.
- Because Find is focus-gated, it can be disabled until the person clicks into the composer
  or conversation. This focus behavior has not been seen running.
- A search text or filter in the session list can hide the session a Next Needs You jump
  selects; the list then reselects its first visible session.
- The Inbox view itself is not restored on relaunch.
- Machine recovery actions (retry, approval commands) remain in the sessions column; the
  sidebar only names the state.
- The `remi pair` QR flow is still iPhone only.
