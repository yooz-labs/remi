# Remi Session and Connection Architecture - Deep Dive

## Overview
Remi manages Claude Code sessions with a clear separation between **session lifecycle** (independent of connections) and **connection management** (clients attaching/detaching from sessions).

---

## 1. SESSION REGISTRY (session-registry.ts)

### Key Concepts
- **Sessions survive connection drops** via orphan timeout mechanism
- **Orphaned state**: When the LAST attached connection detaches, non-locally-owned sessions enter orphan state for 5 minutes (default), then timeout/cleanup
- **Locally-owned sessions** (wrapper mode): Never timeout while connected or locally owned, remain alive indefinitely until PTY exits
- **Any number of attached connections per session** (#795, replacing the old exclusive-lock design): every non-query connection that attaches can read AND write immediately — there is no more single "active" connection, no FIFO queue, and no same-device/fingerprint reclaim. Concurrent-write safety instead comes from a write-serialization queue inside `PTYSession` (see below), not from exclusivity.

### ManagedSession State
```
sessionId             - Unique session ID (UUID)
name                  - Human-readable name (e.g., "hostname:dirname/branch")
createdAt             - When session was created
workingDirectory      - Working directory for Claude Code

PTY & MessageAPI      - References to running PTY and message processor
lastActivityAt        - Timestamp of last message/status change

attachedConnections   - Set<UUID> of currently attached connection IDs (empty if none) (#795)
lastDisconnectedAt    - When the session last had ZERO attached connections (null while any are attached)
orphanTimeoutId       - Timeout handle for cleanup on orphan timeout

messageHistory[]      - Messages for replay (capped at 1000)
lastDeliveredIndex    - Index of last delivered message
currentStatus         - Agent status (idle, running, etc.)
currentQuestions      - Map of pending questions (multiple can be in flight: main + subagent)

locallyOwned          - TRUE for wrapper mode sessions (NEVER timeout)
```

### Session Lifecycle

#### Creation
1. `sessionRegistry.createSessionId()` generates new UUID
2. `registerSession(sessionId, pty, messageApi, locallyOwned)` stores session with:
   - `attachedConnections = new Set()` (no one attached yet)
   - `lastDisconnectedAt = null` (not orphaned)
   - `orphanTimeoutId = null` (no timeout)
   - `locallyOwned = false` (daemon mode) or `true` (wrapper mode)

#### Connection Attach
- `attachConnection(sessionId, connectionId)` called when client connects
- **No exclusivity (#795)**: always succeeds when the session exists — the connection is added to `attachedConnections`, regardless of how many others are already attached
- On success:
  - `connectionId` added to `attachedConnections`
  - `lastDisconnectedAt = null`
  - Clears orphan timeout if resuming
  - Marks all history as delivered
  - Returns `replayMessages` (history since last delivery)
  - `isResume` is true only when the session had ZERO attached connections before this attach — a second connection joining an already-attached session is NOT a resume

#### Detach (Connection closes)
- `detachConnection(connectionId)` called when client disconnects
- Removes `connectionId` from `attachedConnections`
- If OTHER connections remain attached: nothing else happens — the session stays live, no orphan timeout, no `onSessionOrphaned` (#795)
- Only once `attachedConnections` becomes EMPTY:
  - Sets `lastDisconnectedAt = now()`
  - **For non-locally-owned, non-persistent sessions**: Starts orphan timeout → cleanup after 5 min
  - **For locally-owned sessions** (wrapper) or persistent/explicitly-detached sessions: No timeout, stays alive indefinitely

#### Cleanup
- `closeSession(sessionId, reason)` removes session from registry
- Closes PTY (unless reason is 'pty_exit')
- Reason: 'timeout', 'pty_exit', or 'forced'

### Multi-Attach Behavior
**Current behavior (#795)**: any number of connections can be attached to a session at once. Every attached (non-query) connection can read AND write immediately — there is no exclusive lock, no queue, and no rejection on a second/third/... attach.

```typescript
// attachConnection always succeeds when the session exists; no capacity check.
session.attachedConnections.add(connectionId);
```

Concurrent-write safety is NOT enforced here — it comes from `PTYSession`'s own write-serialization queue (a promise chain every `write()`/`submitInput()` call enqueues onto), so two connections submitting input at the same time can never interleave each other's bytes.

### PTY Write Serialization (pty-session.ts, #795)
- `submitInput(text)` writes `text`, waits ~50ms, then writes a trailing CR — a multi-step sequence. Without serialization, two concurrent submits from different attached connections could interleave (one's text landing inside another's 50ms gap), corrupting both. This exact race is why an earlier attempt at removing the lock (`390898b`) was reverted (`588afde`).
- Every write-ish call (`write()`, `submitInput()`) now enqueues onto a private `writeChain: Promise<void>` so only one write sequence is ever in flight per session; a failed write doesn't poison the chain for the next one.
- `resize()` is NOT part of this queue — it is last-writer-wins: any attached connection's `terminal_resize` is applied immediately, no negotiation between attached clients' terminal sizes.
- `raw_pty_output` fans out to every attached connection (`cli/handlers/pty-message-fanout.ts`), not just one.

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

### Multi-Attach Behavior (#795)

When a second client attaches:

1. **Connection established** → sends `hello` with session ID
2. **Daemon receives hello** → calls `onConnect` event handler
3. **Check primary session**: `wrapperMode && primarySessionId`
   - Always attaches (non-query connections only) — no capacity check
4. **Result**: BOTH clients are attached and can read/write immediately; `hello_ack.attachState` is `'attached'` for each of them (never `'queued'` from a current daemon — that value is only sent for interop with an OLDER daemon that still enforces exclusivity)

### Attach Sequence
1. Client connects WebSocket
2. Optional: auth handshake if auth enabled
3. Client sends `hello(clientId, version, resumeSessionId)`
4. Server:
   - `attachConnection()` → adds `connectionId` to `attachedConnections` (always succeeds when the session exists)
   - Sends `hello_ack` with session ID and `replayCount`
5. Client receives `replay_batch` with message history
6. Client enters raw terminal mode (if CLI attach)
7. Client sends raw PTY bytes to server
8. Server forwards `raw_pty_output` to EVERY connection in `session.attachedConnections`, not a single one

### Session Resume After Everyone Detaches
1. Last attached client detaches (WebSocket closes) → `attachedConnections` becomes empty
2. `lastDisconnectedAt = now()`, orphan timeout starts
3. Client reconnects with same `resumeSessionId`
4. `canResume(sessionId)` just checks the session still exists → TRUE
5. `attachConnection(resumeSessionId, newConnectionId)` succeeds, `isResume = true` (attachedConnections was empty)
6. Replay messages sent to restore state

### Example: Concurrent Attach (replaces the old exclusive-lock example)
```
Client 1 attaches    → attachedConnections = {A}, isResume = false
Client 2 attaches    → attachedConnections = {A, B}, isResume = false (NOT a resume -- A is still here)
Client 1 and 2 can both submit input; PTYSession's write queue serializes the actual bytes
Client 1 detaches    → attachedConnections = {B} -- session stays live, no orphan timeout, no onSessionOrphaned
Client 2 detaches    → attachedConnections = {} -- NOW lastDisconnectedAt is set, orphan timeout starts
Client 3 attaches    → attachedConnections = {C}, isResume = true (was empty)
```

---

## 5. SESSION STATE DIAGRAM

```
Created:
  attachedConnections = {} (empty set)
  lastDisconnectedAt = null
  orphanTimeoutId = null
  
    ↓
    
Client A Attaches:
  attachedConnections = {A}
  lastDisconnectedAt = null
  orphanTimeoutId = null
  (no lock -- just membership in the set)
  
    ↓
    
Client B Also Attaches (#795 -- this is new, not a rejection):
  attachedConnections = {A, B}
  Both A and B can read AND write; PTYSession's write queue
  serializes concurrent submits so their bytes never interleave
  
    ↓
    
Client A Detaches (B still attached):
  attachedConnections = {B}
  Nothing else happens -- session stays live, NO orphan timeout,
  NO onSessionOrphaned (only fires when the set becomes empty)
  
    ↓
    
Client B Detaches (now the LAST one):
  attachedConnections = {} (empty)
  lastDisconnectedAt = now()
  onSessionOrphaned fires
  
  ├─ If locallyOwned, persistent, or explicitly detached: no timeout (stays alive)
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
  
If A Client Re-attaches (attachedConnections was empty):
  attachedConnections = {newConnectionId}
  lastDisconnectedAt = null
  orphanTimeoutId = null (cleared)
  isResume = true (attachedConnections WAS empty before this attach)
```

---

## 6. KEY FINDINGS

### Session Uniqueness
- Session ID = Connection ID for new sessions (set in hello)
- Same session ID can have multiple connections over time (via resume), AND multiple connections at once (#795)
- Any number of connections can be attached simultaneously -- no exclusive lock

### Multi-Attach (#795, replacing the old "Multi-Attach Prevention")
- `attachConnection()` always succeeds when the session exists — no capacity check, no rejection
- Every attached connection can read and write immediately, at the same time as every other one
- No FIFO queue, no "queued/read-only" state, no same-device/fingerprint reclaim (the old #662/#671 machinery was deleted outright, not just bypassed)
- Concurrent-write safety comes from `PTYSession`'s write-serialization queue (see PTY WRITE SERIALIZATION above), not from exclusivity

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
- **Session**: PTY process, message history, attached-connections tracking
- Sessions persist after all connections close (orphan timeout)
- Connections don't persist after detach
- many:1 mapping for concurrently attached connections (#795), AND many:1 for resume lifetime over time
