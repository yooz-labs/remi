# Remi Session and Connection Architecture - Deep Dive

## Overview
Remi manages Claude Code sessions with a clear separation between **session lifecycle** (independent of connections) and **connection management** (clients attaching/detaching from sessions).

---

## 1. SESSION REGISTRY (session-registry.ts)

### Key Concepts
- **Sessions survive connection drops** via orphan timeout mechanism
- **Orphaned state**: When a connection detaches, non-locally-owned sessions enter orphan state for 5 minutes (default), then timeout/cleanup
- **Locally-owned sessions** (wrapper mode): Never timeout while connected or locally owned, remain alive indefinitely until PTY exits
- **One active connection per session**: Only one client can have an attached connection at any time

### ManagedSession State
```
sessionId             - Unique session ID (UUID)
name                  - Human-readable name (e.g., "hostname:dirname/branch")
createdAt             - When session was created
workingDirectory      - Working directory for Claude Code

PTY & MessageAPI      - References to running PTY and message processor
lastActivityAt        - Timestamp of last message/status change

activeConnectionId    - Current attached connection ID (null if none)
lastDisconnectedAt    - When last connection detached (null if connected)
orphanTimeoutId       - Timeout handle for cleanup on orphan timeout

messageHistory[]      - Messages for replay (capped at 1000)
lastDeliveredIndex    - Index of last delivered message
currentStatus         - Agent status (idle, running, etc.)
currentQuestion       - Current pending question (if any)

locallyOwned          - TRUE for wrapper mode sessions (NEVER timeout)
```

### Session Lifecycle

#### Creation
1. `sessionRegistry.createSessionId()` generates new UUID
2. `registerSession(sessionId, pty, messageApi, locallyOwned)` stores session with:
   - `activeConnectionId = null` (no one attached yet)
   - `lastDisconnectedAt = null` (not orphaned)
   - `orphanTimeoutId = null` (no timeout)
   - `locallyOwned = false` (daemon mode) or `true` (wrapper mode)

#### Connection Attach
- `attachConnection(sessionId, connectionId)` called when client connects
- **Exclusive Lock**: Returns error if `activeConnectionId !== null` (session already has client!)
- On success:
  - `activeConnectionId = connectionId`
  - `lastDisconnectedAt = null`
  - Clears orphan timeout if resuming
  - Marks all history as delivered
  - Returns `replayMessages` (history since last delivery)

#### Detach (Connection closes)
- `detachConnection(connectionId)` called when client disconnects
- Sets `activeConnectionId = null`
- Sets `lastDisconnectedAt = now()`
- **For non-locally-owned sessions**: Starts orphan timeout → cleanup after 5 min
- **For locally-owned sessions** (wrapper): No timeout, stays alive indefinitely

#### Cleanup
- `closeSession(sessionId, reason)` removes session from registry
- Closes PTY (unless reason is 'pty_exit')
- Reason: 'timeout', 'pty_exit', or 'forced'

### Multi-Attach Behavior
**Current behavior**: Session rejects second attach attempt with error "Session already has active connection"

```typescript
if (session.activeConnectionId !== null) {
  return {
    success: false,
    error: 'Session already has active connection',
  };
}
```

This enforces **exclusive connection ownership**. Second client must wait for first to detach.

---

## 2. CONNECTION CLASS (connection.ts)

### Connection State Machine
```
Without auth:
  connecting -> connected -> disconnected

With auth enabled:
  authenticating -> connecting -> connected -> disconnected
```

### Key Properties
```
id                    - Connection UUID
state                 - Current connection state
sessionId             - Session ID assigned from hello message
directory             - Working directory (null if not specified)
resumeSessionId       - Session to resume (null if creating new)

ws                    - WebSocket reference
messageTracker        - Deduplication tracker (message ID tracking)
pingTimer             - Keep-alive ping interval
connectionTimer       - Timeout for auth/hello phase
```

### Connection Lifecycle

#### 1. WebSocket Handshake
- Starts in `connecting` state
- If authenticator configured: becomes `authenticating` state, sends challenge
- Default timeout: 10 seconds (auth: 60 seconds)

#### 2. Authentication Phase (if enabled)
- Daemon sends `auth_challenge`
- Client sends `auth_response`
- On success: transitions to `connecting` (waiting for hello)
- On failure: closes connection

#### 3. Hello Exchange
- Client sends `hello` with optional `resumeSessionId`
- `sessionId = connection.id` (connection ID is the session ID)
- Server responds with `hello_ack` containing session ID
- Transitions to `connected` state
- Starts ping timer (30-second intervals)

#### 4. Active Session
- Receives user input, answers, requests, etc.
- All messages checked for duplicates via `messageTracker`
- Sessions can be idle (connected but not running)

#### 5. Disconnection
- WebSocket closes → `handleClose()` → `cleanup()`
- Triggers `onDisconnect` event
- Connection unlinks from session via `detachConnection()`

### Message Handling
- **Valid only in connected state**: user_input, answer, bullet_expand_request, terminal_resize
- **Allowed before connected**: session_list_request, transcript_load_request, create_session_request, ping
- **Deduplication**: Same message ID within dedup window is acknowledged but not processed

---

## 3. DAEMON VS WRAPPER MODE

### Port Allocation (SessionRegistryFile)
Each wrapper process writes a JSON entry to `~/.remi/live-sessions/<session-id>.json`:
```json
{
  "sessionId": "uuid",
  "pid": 12345,
  "wsPort": 18765,
  "hookPort": 18865,
  "projectPath": "/path/to/project",
  "name": "project-name",
  "startedAt": "2026-03-20T..."
}
```

**Port Range**: Default 18765-18774 (10 ports)
- **Daemon mode** (--daemon): Uses explicit port or single port
- **Wrapper mode**: Auto-selects available port from range
  - `findAvailablePort()` checks live entries to avoid conflicts
  - Checks PID liveness (stale entries auto-cleaned)
  - Max 3 retry attempts on EADDRINUSE race

### Daemon Mode (`--daemon`)
1. **No auto-session**: Waits for client `create_session_request`
2. **Headless**: No local PTY attached, no terminal I/O
3. **Multi-session**: Single daemon can host multiple sessions (different connections)
4. **Port**: Explicit or single fixed port
5. **Startup**:
   - Starts WebSocket server on specified port
   - Advertises via mDNS (if not localhost)
   - Ready to accept connections

```typescript
if (!wrapperMode) {
  sendToConnection(connectionId, createHelloAck('1.0.0', '' as UUID));
  log(`Connection ${connectionId} accepted in daemon mode (no auto-session)`);
}
```

### Wrapper Mode (Default)
1. **Auto-create primary session**: Creates PTY immediately on startup
2. **One session per process**: Local terminal + remote clients all share ONE session
3. **Pass-through terminal**: Local terminal I/O flows through PTY directly
4. **Port auto-selection**: Finds available port from range, retries on collision
5. **Locally owned**: Primary session marked `locallyOwned = true` (no orphan timeout)
6. **Detach support**: Ctrl+B d detaches local terminal, keeps PTY alive
7. **Startup**:
   - Auto-selects port from 18765-18774
   - Creates primary session with `locallyOwned = true`
   - Starts hook server (Claude Code event detection)
   - Spawns Claude Code PTY with pass-through enabled
   - Writes session file to live-sessions dir
   - When client connects → auto-attach to primary session

```typescript
if (wrapperMode && primarySessionId && !resumeSessionId) {
  const result = sessionRegistry.attachConnection(primarySessionId, connectionId);
  if (result.success) {
    sendToConnection(connectionId, createHelloAck(...));
    // Client auto-attached to primary session
  }
}
```

---

## 4. ATTACH FLOW (attach-client.ts)

### Multi-Attach Behavior

When a second client tries to attach:

1. **Connection established** → sends `hello` with session ID
2. **Daemon receives hello** → calls `onConnect` event handler
3. **Check primary session**: `wrapperMode && primarySessionId`
   - If primary session has `activeConnectionId !== null`: attach fails
   - Returns "Session already has active connection" error
4. **Result**: Client receives error and must wait for first client to detach

### Attach Sequence
1. Client connects WebSocket
2. Optional: auth handshake if auth enabled
3. Client sends `hello(clientId, version, resumeSessionId)`
4. Server:
   - If resuming: calls `canResume(resumeSessionId)` → checks `activeConnectionId === null`
   - If successful: calls `attachConnection()` → sets `activeConnectionId = connectionId`
   - Sends `hello_ack` with session ID and `replayCount`
5. Client receives `replay_batch` with message history
6. Client enters raw terminal mode (if CLI attach)
7. Client sends raw PTY bytes to server
8. Server forwards to `session.activeConnectionId`

### Session Resume After Detach
1. Client detaches (WebSocket closes)
2. `detachConnection(connectionId)` → `activeConnectionId = null`
3. Client reconnects with same `resumeSessionId`
4. `canResume(sessionId)` checks if `activeConnectionId === null` → TRUE
5. `attachConnection(resumeSessionId, newConnectionId)` succeeds
6. Replay messages sent to restore state

### Example: Re-attach Same Session
```
Client 1 attaches    → Connection A, activeConnectionId = A
Client 1 detaches    → activeConnectionId = null, orphan timeout started
Client 1 re-attaches → canResume(sessionId) = true
                     → attachConnection succeeds, Connection B, activeConnectionId = B
Client 2 tries attach → canResume(sessionId) = false (because activeConnectionId = B)
                      → attach fails with "Session already has active connection"
```

---

## 5. SESSION STATE DIAGRAM

```
Created:
  activeConnectionId = null
  lastDisconnectedAt = null
  orphanTimeoutId = null
  
    ↓
    
Client Attaches:
  activeConnectionId = connectionId
  lastDisconnectedAt = null
  orphanTimeoutId = null
  (exclusive lock established)
  
    ↓
    
Client Detaches:
  activeConnectionId = null
  lastDisconnectedAt = now()
  
  ├─ If locallyOwned: no timeout (stays alive)
  └─ If not: orphanTimeoutId = setTimeout(5 min)
  
    ↓
    
If Orphan Timeout Expires:
  closeSession('timeout')
  (removed from registry)
  
OR
  
If PTY Exits:
  closeSession('pty_exit')
  (removed from registry)
  
OR
  
If Client Re-attaches:
  activeConnectionId = newConnectionId
  lastDisconnectedAt = null
  orphanTimeoutId = null (cleared)
  (exclusive lock re-established)
```

---

## 6. KEY FINDINGS

### Session Uniqueness
- Session ID = Connection ID for new sessions (set in hello)
- Same session ID can have multiple connections over time (via resume)
- But only ONE active connection at any time (exclusive lock)

### Multi-Attach Prevention
- `attachConnection()` checks `activeConnectionId !== null`
- Returns error if already attached
- Second client must wait for first to detach
- No queue or multi-client support

### Port Selection
- **Wrapper mode**: Auto-selects from 18765-18774 (10 ports max)
- **Daemon mode**: Single explicit/fixed port
- **File-based registry**: `~/.remi/live-sessions/<sessionId>.json`
- **PID liveness checks**: Stale entries auto-cleaned

### Locally-Owned Sessions
- Marked in `registerSession(locallyOwned = true/false)`
- In wrapper mode: primary session is `locallyOwned = true`
- In daemon mode: sessions are `locallyOwned = false` (default)
- Locally-owned: **NO orphan timeout**, survives indefinitely until PTY exit
- Non-locally-owned: **5-minute timeout** after detach

### Connection vs Session
- **Connection**: WebSocket transport, state machine, message handling
- **Session**: PTY process, message history, active connection tracking
- Sessions persist after connection closes (orphan timeout)
- Connections don't persist after detach
- 1:1 mapping for active connections; many:1 for resume lifetime
