# Native app parity

Verified against `packages/web/src` on 2026-10-07. This describes what ships in the
native targets now, not planned behavior.

| Capability | Capacitor client | Native iPhone | Native Mac | Remaining work |
|---|---|---|---|---|
| Direct WebSocket and reconnect | Yes | Yes | Yes | Direct transport is not encrypted by Remi; keep the pairing warning. |
| Ed25519 identity and local approval | Yes | Yes | Yes | Real-hub approval integration test passes. |
| Multiple machines and session daemons | Yes | Yes | Yes | Native apps persist machine/session scope. Machine identity remains `host:port` until protocol #1234. |
| Session list and transcript history | Yes | Yes | Yes | Native renders text and tool-only transcript entries. |
| Pending cards and cross-client dismissal | Yes | Yes | Yes | Native decodes the frozen decision object, renders unknown kinds generically, removes resolved notifications immediately, and briefly names a known resolution source. |
| Binary and standing-option answers | Yes | Yes | Yes | Answers use wire values; session grants are labeled. |
| AskUserQuestion structured selections | Yes | Yes | Yes | Native supports option and validated free-text answers for single-select subquestions. |
| Plan approval and terminal-only cards | Yes | Yes | Yes | Terminal-only cards never offer answer controls. |
| Typed chat with prompt guard | Yes | Yes | Yes | Native apps present daemon errors in dismissible banners. |
| Create session | Yes | Yes | Yes | Native apps support recent repositories, new worktrees, advertised harnesses, and legacy fallback. |
| Add/persist direct machines | Yes | Yes | Yes | Native apps can forget endpoints without stopping their remote sessions. Discovery is not inferred on loopback. |
| Local card notifications | Yes | Yes | Yes | Native apps notify once for new cards and remove resolved notifications. |
| Remote push / lock-screen answers | Yes | No | No | Deliberately blocked on X2 (#1242) and owner signing. |
| Kill/resume session | Yes | Yes | Yes | Native apps terminate daemon-owned sessions with confirmation and offer Resume for resumable stored sessions. A child response follows the returned port and opens after its authenticated hello; same-daemon responses open immediately (#1309). |
| Subagent conversation picker | Yes | Yes | Yes | Native apps expose active and finished subagents as read-only conversations. |
| Haptics and notification preferences | Yes | Yes | N/A | iPhone preferences control local question alerts, sounds, and answer feedback. |
| Relay connection | No shipped client path | No | No | Out of scope until relay v2 (#1242). |
| Diff, files, terminal view | Web has terminal-era surfaces | No | No | Out of scope X5 (#1245). |

The Capacitor app should not be retired yet. Remote push and lock-screen answers remain
intentionally blocked on X2; deeper files, diffs, and terminal surfaces remain X5 work.
