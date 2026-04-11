# Message Routing Trace: App -> Daemon -> PTY

**Date:** 2026-03-29
**Context:** Tracing the full path of user messages from mobile/web app to Claude Code PTY session.

## Overview

When a user sends a message from the Remi app, it must travel:
```
App (React) -> WebSocket -> Daemon -> Session Registry -> PTY -> Claude Code stdin
```

The critical gate is the **session registry lookup**: if the connection isn't properly attached to a session, the message is silently dropped.

---

## 1. Web/Mobile Client Side

**Entry point:** `packages/web/src/components/InputArea.tsx`

- User types message, `handleSend()` fires
- Creates `UIMessage` with `state: 'sending'`
- Calls `effectiveSendInput(activeSessionId, content)`
- Creates protocol message via `createUserInput(sessionId, content)`

**Message structure:**
```typescript
{
  type: 'user_input',
  id: UUID,            // unique message ID
  timestamp: string,   // ISO
  sessionId: UUID,     // target session
  content: string,     // user text
  raw: false           // web client sends structured, not raw bytes
}
```

Sent via WebSocket using `clientRef.send()`.

---

## 2. Daemon Receives Message

**Path:** `WebSocketServer` -> `Connection.handleMessage()` -> `Connection.handleUserInput()`

1. WebSocket server deserializes the message
2. `Connection` routes by `type` field in switch statement
3. `handleUserInput()` checks connection state, sends ACK
4. Fires `events.onUserInput(sessionId, content, raw)`

**Adapter chain adds connectionId:**
- `WebSocketServer` -> `WebSocketAdapter` -> `cli.ts`
- Final call: `onUserInput(connectionId, sessionId, content, raw)`

**Key files:**
- `packages/daemon/src/server/connection.ts` (lines 380-395)
- `packages/daemon/src/server/websocket-server.ts` (lines 294-295)
- `packages/daemon/src/adapters/websocket-adapter.ts` (lines 112-113)

---

## 3. Session Registry Lookup (THE CRITICAL GATE)

**File:** `packages/daemon/src/cli.ts` (lines 1955-1973)

```typescript
onUserInput: async (connectionId, _sessionId, content, raw) => {
  const session = sessionRegistry.getSessionForConnection(connectionId);
  if (session) {
    if (raw) {
      session.pty.write(content);      // Raw terminal input
    } else {
      await session.pty.submitInput(content);  // Structured input + Enter
    }
  } else {
    log(`No session found for connection ${connectionId}`);  // SILENT DROP
  }
}
```

**SessionRegistry lookup** (`session-registry.ts` lines 199-204):
```typescript
getSessionForConnection(connectionId: UUID): ManagedSession | undefined {
  if (this.session !== null &&
      this.session.activeConnectionId === connectionId) {
    return this.session;
  }
  return undefined;
}
```

**Requirement:** `session.activeConnectionId === connectionId` must be true.

---

## 4. Connection Attachment: When the Mapping Gets Created

This happens during the **hello handshake** in `cli.ts` `onConnect` handler (lines 1850-1944):

```typescript
// Only if NOT query mode:
const isQueryMode = metadata.platformData?.['mode'] === 'query';
if (!isQueryMode) {
  const result = sessionRegistry.attachConnection(primarySessionId, connectionId);
  if (result.success) {
    sendToConnection(connectionId, createHelloAck(...));
  }
}
```

**SessionRegistry.attachConnection()** (lines 220-276):
```typescript
if (this.session.activeConnectionId !== null) {
  return { success: false, error: 'Session already has active connection' };
}
// *** MAKE THE MAPPING ***
this.session.activeConnectionId = connectionId;
return { success: true, replayMessages: [...] };
```

**Mapping persists until:**
1. `detachConnection(connectionId)` is called (on disconnect)
2. Session is closed or orphan timeout expires

---

## 5. PTY Write: Final Destination

**File:** `packages/daemon/src/pty-session.ts` (lines 189-202)

```typescript
async submitInput(text: string): Promise<void> {
  if (this.state !== 'running' || !this.process?.terminal) {
    throw new Error(`Cannot write to session in state: ${this.state}`);
  }
  this.process.terminal.write(text);
  await new Promise((resolve) => setTimeout(resolve, 50));
  this.process.terminal.write('\r');  // Send Enter
}
```

Claude Code reads from stdin and processes the input.

---

## 6. Wrapper Mode vs Daemon Mode

Both modes create PTY sessions. The difference is in behavior flags:

| Property | Wrapper Mode | Daemon Mode |
|----------|-------------|-------------|
| `passThrough` | `true` (terminal-attached) | `false` (server-only) |
| `locallyOwned` | `true` | `false` |
| Orphan timeout | None (stays alive) | 5 minutes |
| PTY output | Passes through to terminal | All access via WebSocket |
| Session lifecycle | Lives with terminal | Kills if no connections |

**Both modes DO have a PTY session** -- daemon mode creates it at `cli.ts` line 2722 via `createNewSession()`.

---

## 7. Answer vs User Input

Both use the same connection lookup, different message types:

| Type | Created by | Handler | Use case |
|------|-----------|---------|----------|
| `user_input` | `createUserInput()` | `handleUserInput()` | Free-form text |
| `answer` | `createAnswer()` | `handleAnswer()` | Response to a question |

Both ultimately call `sessionRegistry.getSessionForConnection(connectionId)` and then `session.pty.submitInput()`.

---

## 8. Failure Points (Where Messages Get Silently Dropped)

### Failure 1: Connection Never Attached
- Client sent `hello` in **query mode** -> `attachConnection()` never called
- Client can send messages but they all hit "No session found"

### Failure 2: Session Already Busy (Exclusive Lock)
- Connection A is attached (`activeConnectionId = "A"`)
- Connection B arrives, `attachConnection()` returns failure
- B's messages all dropped; B gets `SESSION_BUSY` error on attach

### Failure 3: Session Orphaned/Timeout (Daemon Mode Only)
- Connection disconnects -> `detachConnection()` called
- If `locallyOwned = false`, 5-minute orphan timer starts
- Timer expires -> session closed -> all future messages dropped

### Failure 4: Disconnect/Reconnect Race
- Client disconnects briefly (network blip)
- `detachConnection()` fires, clears `activeConnectionId`
- Client reconnects with **new connectionId**
- If reconnect hello + attach completes before next message, OK
- If message arrives before re-attach, it's dropped

### Failure 5: Standalone `remi start` Without PTY
- When `remi start` is run, it spawns a **child process** (`spawn(..., { detached: true })`)
- The child process runs `remi --daemon` which creates the PTY
- The parent process exits immediately
- If someone starts remi manually (e.g., `bun run ... start`), the foreground process has no PTY

---

## 9. Debugging

### Key log line to search for:
```
No session found for connection [connectionId]
```

### Checklist when messages aren't arriving:
1. Is the daemon running? (`ps aux | grep remi`)
2. Is it in wrapper mode or daemon mode?
3. Did the client receive `hello_ack` (not an error)?
4. Was the client in query mode? (check `platformData.mode`)
5. Is another client already attached? (exclusive lock)
6. Has the session been orphaned? (daemon mode, 5-min timeout)
7. Check daemon logs: `~/.remi/daemon.log`

### No test coverage
As of 2026-03-29, there are **no integration tests** covering the `user_input` -> session registry -> PTY write path. This is the most critical path in the product and needs test coverage (see issue #178 or equivalent).

---

## 10. Complete Flow Diagram

```
User taps Send in app
       |
       v
createUserInput(sessionId, content)
       |
       v
WebSocket.send(JSON.stringify(message))
       |
       v
Daemon: WebSocketServer receives frame
       |
       v
Connection.handleMessage() -> switch on type
       |
       v
Connection.handleUserInput()
  - Check state === 'connected'
  - Send ACK (delivered) back to client
  - Fire events.onUserInput(sessionId, content, raw)
       |
       v
WebSocketAdapter bridges -> cli.ts sharedEvents.onUserInput
       |
       v
cli.ts: sessionRegistry.getSessionForConnection(connectionId)
       |
       +--- FOUND (activeConnectionId matches) ---+
       |                                           |
       v                                           v
  "No session found"                    session.pty.submitInput(content)
  (message dropped,                           |
   only logged)                               v
                                    PTY.terminal.write(content + '\r')
                                              |
                                              v
                                    Claude Code reads from stdin
                                              |
                                              v
                                    Command executes
```
