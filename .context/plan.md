# Remi Development Plan

## Current State (January 2025)

The daemon is feature-complete for single-session monitoring:
- PTY management, session registry, transcript discovery
- Two-phase message delivery (PTY status streaming + transcript content)
- Bullet structuring with truncation and on-demand expansion
- WebSocket server with protocol messaging
- Telegram adapter (forum-based sessions)
- Session discovery (daemon-managed + filesystem transcript scanning)

The web frontend has a working chat UI with:
- Session list, chat view, message bubbles with delivery states
- WebSocket connection (manual URL entry)
- Quick response buttons (yes/no, numbered, permissions)
- Bullet expansion for truncated content
- Light/dark theme via CSS variables (prefers-color-scheme)
- Responsive layout (mobile drawer + desktop sidebar)

**Missing from frontend:** `transcript_content` handling, `session_list_request/response`, multi-machine support, auto-discovery, settings panel.

**Missing from Telegram:** Session discovery commands, transcript content rendering, multi-session awareness.

---

## Two Independent Development Tracks

### Track 1: Web App - Machine Layer & Discovery
### Track 2: Telegram Adapter - API Feature Parity

These are independent and can be developed in separate sessions.

---

# Track 1: Web App Improvements

## Goal
Transform the web app from "manual single-connection" to "auto-discovering multi-machine monitor" with proper transcript content display.

## Architecture Changes

### Machine Concept
```
Machine {
  id: string              // Derived from hostname or user-defined
  name: string            // Display name
  host: string            // WebSocket URL (ws://host:port/ws)
  status: 'online' | 'offline' | 'connecting'
  sessions: UISession[]   // Sessions under this machine
  lastSeen: Timestamp
}
```

Free tier: 1 machine. Paid tier: multiple machines.
For now, implement the multi-machine UI but default to single machine (no paywall logic yet).

### Data Flow
```
App Start
  -> Load saved machines from localStorage
  -> Connect to each machine's WebSocket
  -> Send session_list_request (includeExternal: true)
  -> Receive session_list_response
  -> Populate session list grouped by machine
  -> Auto-attach to active sessions (receive transcript_content)
```

---

## Implementation Steps

### Step 1: Protocol Message Handling

**File: `packages/web/src/hooks/useWebSocket.ts`**

Add support for:
- Sending `session_list_request` after connection established
- Handling `session_list_response` (populate sessions)
- Handling `transcript_content` (primary content delivery)

```typescript
// New methods on hook return:
requestSessionList(includeExternal?: boolean): void
onSessionList?: (sessions: DiscoverableSession[]) => void
onTranscriptContent?: (message: TranscriptContentMessage) => void
```

**File: `packages/web/src/lib/websocket-client.ts`**

Add message type handling in the deserialize switch for new message types.

### Step 2: Transcript Content → UI Messages

**File: `packages/web/src/App.tsx`**

Handle `transcript_content` messages:
- Map `entryUuid` to message identity (for dedup/updates)
- Convert structured bullets from transcript to UIBullet format
- Support `role: 'user' | 'assistant'` mapping to sender
- Show model, tool usage, token stats as metadata

```typescript
case 'transcript_content':
  const existing = messages.find(m => m.entryUuid === msg.entryUuid);
  if (existing) {
    // Update existing message (re-structuring)
    updateMessage(existing.id, msg);
  } else {
    // New message from transcript
    addMessage(createUIMessageFromTranscript(msg));
  }
  break;
```

### Step 3: Session Discovery Integration

**File: `packages/web/src/App.tsx`**

After `hello_ack`, send `session_list_request`:
- Populate session list from response
- Mark daemon sessions as attachable
- Mark transcript sessions as read-only (historical)
- Show session status indicators (active/idle/completed)

**New types in `packages/web/src/types/index.ts`:**
```typescript
interface UISession {
  // ... existing fields ...
  source: 'daemon' | 'transcript'
  canAttach: boolean
  projectPath: string
  model?: string
  messageCount?: number
}
```

### Step 4: Machine Layer

**New file: `packages/web/src/hooks/useMachines.ts`**

```typescript
interface Machine {
  id: string
  name: string
  url: string              // WebSocket URL
  status: 'online' | 'offline' | 'connecting'
  sessions: UISession[]
  error?: string
}

function useMachines(): {
  machines: Machine[]
  addMachine(name: string, url: string): void
  removeMachine(id: string): void
  connectAll(): void
}
```

- Manages multiple WebSocket connections (one per machine)
- Stores machine configs in localStorage
- Auto-reconnects on disconnect
- Aggregates sessions from all machines

### Step 5: UI Changes

**Session List (`SessionList.tsx`):**
- Group sessions by machine (collapsible sections)
- Machine header: name + status dot (green/red/yellow)
- Show "Add Machine" button (opens settings or inline form)
- For single machine, skip grouping header

**Session Card (`SessionCard.tsx`):**
- Show `source` badge (daemon vs transcript)
- Show model name if available
- Show message count
- Dim completed/transcript sessions

**Settings Panel (new: `packages/web/src/components/settings/SettingsPanel.tsx`):**
- Machine management (add/remove/edit URL)
- Theme preference (system/light/dark)
- Connection settings (reconnect interval, ping interval)
- About section (version, links)

**App Layout:**
- Add settings gear icon in header
- Settings panel slides in from right (or modal)

### Step 6: Theme Improvements

**File: `packages/web/src/index.css`**

Current implementation already has `@media (prefers-color-scheme: light)` block.
Add manual override:

```css
[data-theme="light"] { /* light variables */ }
[data-theme="dark"] { /* dark variables */ }
/* Default: follow system */
```

Store preference in localStorage. Apply `data-theme` attribute on `<html>`.

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/web/src/hooks/useWebSocket.ts` | Modify | Add transcript_content, session_list handling |
| `packages/web/src/hooks/useMachines.ts` | Create | Multi-machine connection management |
| `packages/web/src/lib/websocket-client.ts` | Modify | Handle new message types |
| `packages/web/src/App.tsx` | Modify | Transcript content handling, machine integration |
| `packages/web/src/types/index.ts` | Modify | Add Machine type, extend UISession |
| `packages/web/src/components/session/SessionList.tsx` | Modify | Machine grouping, discovery display |
| `packages/web/src/components/session/SessionCard.tsx` | Modify | Source badge, model, message count |
| `packages/web/src/components/settings/SettingsPanel.tsx` | Create | Machine management, theme, settings |
| `packages/web/src/index.css` | Modify | Theme override support |
| `packages/web/src/components/layout/AppLayout.tsx` | Modify | Settings button, panel integration |

---

## Verification

1. Start daemon: `bun run daemon -- --directory ~/some-project`
2. Open web app: `bun run dev` (packages/web)
3. Add machine (localhost:18765)
4. Verify session list populates automatically
5. Start a Claude session; verify transcript_content messages render
6. Verify bullet expansion still works
7. Toggle theme (system/light/dark)
8. Disconnect daemon; verify machine shows offline
9. Reconnect; verify sessions repopulate

---

# Track 2: Telegram Adapter Improvements

## Goal
Update the Telegram adapter to use session discovery and transcript content, matching the daemon's newer API capabilities.

## Current State

The Telegram adapter:
- Creates sessions via `/start [directory]` (spawns new PTY)
- Renders `agent_output` messages (PTY-sourced, raw text)
- Handles questions with inline keyboard buttons
- Uses forum topics for session isolation

**Missing:**
- Cannot list/discover existing sessions
- Cannot attach to already-running sessions
- Does not render `transcript_content` (structured messages)
- No way to browse sessions across machines

## Implementation Steps

### Step 1: Session Discovery Commands

**File: `packages/daemon/src/adapters/telegram-adapter.ts`**

New commands:

| Command | Action |
|---------|--------|
| `/sessions` | List all discoverable sessions (daemon + transcript) |
| `/attach <id>` | Attach to an existing daemon session |
| `/detach` | Detach from current session (keep session alive) |

**`/sessions` rendering:**
```
Active Sessions:
  1. remi (active, 5 min ago)
     Model: claude-opus-4-5-20251101 | 23 messages
  2. yooz-website (idle, 30 min ago)
     Model: claude-sonnet-4-20250514 | 8 messages

Completed:
  3. yooz-notes (2h ago, 45 messages)
```

- Numbers for quick `/attach 1` shorthand
- Show status emoji: active, idle, completed
- Show model and message count from discovery metadata

### Step 2: Session Attachment

**File: `packages/daemon/src/adapters/telegram-adapter.ts`**

When user runs `/attach <id>`:
1. Look up session in SessionRegistry
2. If `canAttach: true`, call `attachConnection(sessionId, connectionId)`
3. Replay missed messages to the Telegram topic
4. Start receiving new messages
5. Update topic name to reflect attached session

If session is transcript-only (`canAttach: false`):
- Reply with "This session is completed and cannot be attached"
- Offer to show last N messages as read-only summary

### Step 3: Transcript Content Rendering

**File: `packages/daemon/src/adapters/telegram-ui.ts`**

Render `TranscriptContentMessage` to Telegram format:
- Convert structured bullets to Telegram-friendly text
- Use monospace for code blocks (``` formatting)
- Show model/tool metadata as header line
- Respect Telegram's 4096 char limit (split if needed)

```typescript
function renderTranscriptContent(msg: TranscriptContentMessage): string[] {
  const header = msg.model ? `[${msg.model}]` : '';
  const tools = msg.tools?.length ? `Tools: ${msg.tools.join(', ')}` : '';

  const bullets = msg.structured.bullets.map(b => {
    if (b.type === 'code') return `\`\`\`\n${b.content}\n\`\`\``;
    return b.content;
  });

  // Split into chunks if > 4000 chars
  return splitIntoChunks([header, tools, ...bullets].filter(Boolean).join('\n'), 4000);
}
```

### Step 4: Integration with Two-Phase Delivery

Currently the adapter receives `agent_output` (PTY-sourced). With two-phase delivery:
- Phase 1 (PTY): Only status updates and questions (streamStatusOnly)
- Phase 2 (Transcript): Full content via `transcript_content`

The adapter needs to:
1. Handle `transcript_content` in its `sendRaw()` method
2. Render it using the new `renderTranscriptContent()`
3. Continue handling questions from Phase 1

**File: `packages/daemon/src/adapters/telegram-adapter.ts`**

```typescript
// In sendRaw() switch:
case 'transcript_content':
  await this.sendTranscriptContent(binding, message);
  break;
```

### Step 5: Detach Support

Allow users to `/detach` from a session without killing it:
- Session stays alive (orphaned, 5 min timeout)
- Topic stays open for later `/attach`
- Useful when switching between sessions

---

## Files to Create/Modify

| File | Action | Description |
|------|--------|-------------|
| `packages/daemon/src/adapters/telegram-adapter.ts` | Modify | Add /sessions, /attach, /detach commands |
| `packages/daemon/src/adapters/telegram-ui.ts` | Modify | Add transcript content rendering |
| `packages/daemon/src/cli.ts` | Modify | Wire adapter events to session registry for attach |

---

## Verification

1. Start daemon with Telegram enabled: `bun run daemon -- --telegram`
2. In Telegram group, run `/sessions`
3. Verify active sessions listed with metadata
4. Run `/attach 1` to attach to existing session
5. Verify transcript content renders in topic
6. Run `/detach`; verify session stays alive
7. Start new session with `/start ~/project`
8. Verify two-phase delivery works (status + transcript content)

---

## Priority Order

For both tracks, the implementation order is:
1. Protocol message handling (foundation)
2. Content rendering (user-visible value)
3. Session discovery (navigation)
4. Machine/attachment layer (multi-session)
5. Settings/polish (UX)

---

## Product Vision Notes

- **Free tier:** 1 machine, unlimited sessions on that machine
- **Paid tier:** Multiple machines, cross-machine session view
- **No paywall logic now:** Build multi-machine UI, enforce limits later
- **Voice (Phase 3):** After both tracks work; pure Swift, always-listening STT, Kokoro TTS
