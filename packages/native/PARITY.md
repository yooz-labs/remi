# Native app parity

Verified against `packages/web/src` on 2026-10-07. This describes what ships in the
native targets now, not planned behavior.

| Capability | Capacitor client | Native iPhone | Native Mac | Remaining work |
|---|---|---|---|---|
| Direct WebSocket and reconnect | Yes | Yes | Yes | Direct transport is not encrypted by Remi; keep the pairing warning. |
| Ed25519 identity and local approval | Yes | Yes | Yes | Real-hub approval integration test passes. |
| Multiple machines and session daemons | Yes | Yes | Yes | iPhone groups sessions by machine and persists its machine scope. Machine identity remains `host:port` until protocol #1234. |
| Session list and transcript history | Yes | Yes | Yes | Native renders text and tool-only transcript entries. |
| Pending cards and cross-client dismissal | Yes | Yes | Yes | Native reconciles `question_resolved` and `question_snapshot`. |
| Binary and standing-option answers | Yes | Yes | Yes | Answers use wire values; session grants are labeled. |
| AskUserQuestion structured selections | Yes | Yes | Yes | Native supports option and validated free-text answers for single-select subquestions. |
| Plan approval and terminal-only cards | Yes | Yes | Yes | Terminal-only cards never offer answer controls. |
| Typed chat with prompt guard | Yes | Yes | Yes | iPhone presents daemon errors in a dismissible banner; Mac error presentation remains. |
| Create session | Yes | Yes | Yes | iPhone supports recent repositories, new worktrees, and legacy fallback. |
| Add/persist direct machines | Yes | Yes | Yes | Discovery is not inferred on loopback. |
| Local card notifications | Yes | Yes | Menu bar | iPhone foreground banner and dismissal are implemented. |
| Remote push / lock-screen answers | Yes | No | No | Deliberately blocked on X2 (#1242) and owner signing. |
| Kill/resume session | Yes | Kill only | No | iPhone can terminate daemon-owned sessions with confirmation. Hub resume remains unsupported (#1129), so native does not offer a misleading resume action. |
| Subagent conversation picker | Yes | Yes | No | iPhone exposes active and finished subagents as read-only conversations; Mac support remains. |
| Haptics and notification preferences | Yes | No | N/A | Native preferences remain. |
| Relay connection | No shipped client path | No | No | Out of scope until relay v2 (#1242). |
| Diff, files, terminal view | Web has terminal-era surfaces | No | No | Out of scope X5 (#1245). |

The Capacitor app should not be retired yet. The blocking parity items are structured
free text, error presentation, kill/resume, subagent views, preferences/haptics, and the
secure-push work intentionally waiting on X2.
