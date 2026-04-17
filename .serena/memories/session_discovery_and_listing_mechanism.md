# Remi Session Discovery and Listing Mechanism

## Overview
Remi implements a **single-daemon-per-web-session model** where:
1. The web app connects to **one daemon at a time** via WebSocket
2. That daemon can have **multiple sessions** (in daemon mode) or **one primary session** (in wrapper mode)
3. Each daemon reports its own sessions via the `session_list_response` protocol message
4. The CLI (`remi ls`, `remi attach`) supports discovery across multiple daemons, but the web app does not (yet)

---

## How `remi ls` Works (CLI)

The CLI has three discovery paths:

### 1. Local Multi-Port Discovery (Default)
```bash
remi ls
```
1. Reads live sessions registry at `~/.remi/live-sessions/`
2. Queries each unique port in parallel
3. Aggregates results
4. Renders local format (no host column)

**Function:** `runMultiPortLs()` in `packages/daemon/src/cli/ls-client.ts`

### 2. Network-Wide Discovery
```bash
remi ls --network
```
1. Query all local ports (from registry)
2. Run mDNS discovery for services named `_remi._tcp.local` (Bonjour)
3. Run VPN discovery (Tailscale, WireGuard)
4. Deduplicate hosts by IP
5. Query all daemons on each host in parallel
6. Render network format (includes host column, attach hints)

**Functions:**
- `runNetworkLs()` - orchestrator
- `discoverDaemons()` (mdns-browser.ts) - mDNS discovery
- `discoverVpnPeers()` (vpn-discovery.ts) - VPN peer discovery
- `fetchSessions()` - WebSocket query to daemon

### 3. Direct Host/Port Connection
```bash
remi ls --host 192.168.1.5 --port 18766
```
1. Single WebSocket connection to specified host:port
2. Send `hello`, then `session_list_request`
3. Render results (local format)

**Functions:** `runLsClient()` -> `fetchSessions()`

---

## Protocol Messages for Session Listing

### Request (Client to Daemon)
```typescript
interface SessionListRequestMessage {
  type: 'session_list_request';
  id: UUID;
  timestamp: Timestamp;
  includeExternal?: boolean;  // Include external transcript sessions
}
```

**Created via:** `createSessionListRequest(includeExternal)`

### Response (Daemon to Client)
```typescript
interface SessionListResponseMessage {
  type: 'session_list_response';
  id: UUID;
  timestamp: Timestamp;
  sessions: readonly DiscoverableSession[];  // Array of discoverable sessions
  requestId: UUID;  // ID of the request this responds to
}
```

**Created via:** `createSessionListResponse(sessions, requestId)`

---

## Session Discovery on Daemon Side

### Handler Chain (cli.ts)
```typescript
onSessionListRequest: (connectionId: UUID, requestId: UUID, includeExternal: boolean) => {
  // 1. Get all daemon-managed sessions
  const daemonSessions = sessionRegistry.listSessions();
  
  // 2. If requested, also discover external sessions from transcripts
  let allSessions = [...daemonSessions];
  if (includeExternal) {
    const managedIds = new Set(sessionRegistry.getActiveSessionIds());
    const externalSessions = transcriptDiscovery.discoverSessions(managedIds);
    allSessions = [...daemonSessions, ...externalSessions];
  }
  
  // 3. Send response
  sendToConnection(connectionId, createSessionListResponse(allSessions, requestId));
}
```

### Event Flow
1. Connection receives `session_list_request` message
2. connection.ts calls `onSessionListRequest` handler
3. websocket-server.ts bridges to adapter events
4. cli.ts handles the event and queries:
   - `sessionRegistry.listSessions()` - daemon-managed sessions
   - `transcriptDiscovery.discoverSessions()` - transcript files

---

## DiscoverableSession Structure

Each session returned has:
```typescript
interface DiscoverableSession {
  sessionId: string;              // UUID (daemon) or Claude Code ID (transcript)
  name?: string;                  // e.g., "hostname/project/branch"
  projectPath: string;            // Working directory
  status: 'active' | 'idle' | 'orphaned' | 'completed';
  createdAt?: Timestamp;
  lastActivity: Timestamp;        // Last message time
  messageCount: number;
  model?: string;                 // AI model (if known)
  lastMessage?: string;           // Preview (truncated)
  source: 'daemon' | 'transcript'; // Discovery source
  canAttach: boolean;             // Can attach to session
  canResume: boolean;             // Can resume via --resume
}
```

---

## Web App Session Listing

### Current Architecture
The web app displays sessions from a **single connected daemon**:

1. **Connect Phase:**
   - User provides daemon URL or connection code
   - Web app connects WebSocket to `directUrl` or via signaling server
   - Auth handshake (if daemon requires it)
   - Send `hello` message

2. **Session List Request:**
   - Web app calls `requestSessionList(includeExternal)` from hook
   - Hook sends `session_list_request` via WebSocket
   - Daemon responds with `session_list_response`

3. **UI Mapping:**
   - `DiscoverableSession` → `UISession` mapping in App.tsx (lines 378-395)
   - UISession includes:
     ```typescript
     interface UISession {
       id: UUID;
       name: string;
       createdAt: Timestamp;
       lastActiveAt: Timestamp;
       status: AgentStatus;
       connectionStatus: ConnectionStatus;
       unreadCount: number;
       cwd?: string;
       preview?: string;
       source?: 'daemon' | 'transcript';
       isLoadingTranscript?: boolean;
       questionPending?: boolean;
       canResume?: boolean;
     }
     ```
   - **Note:** `UISession` does NOT contain host/daemon information

4. **SessionList Component:**
   - Displays list of sessions from single daemon
   - No multi-daemon display
   - Comment says: "Displays the daemon's session (one session per daemon)"

---

## Host vs Daemon Concept

### In CLI (`remi` command)
- **Host:** Physical machine (IP address or hostname)
- **Daemon:** Remi service running on a port on that host
- **One host can have multiple daemons** (ports 18765-18774 in wrapper mode)
- CLI discovers and queries all daemons on a host

### In Web App (current)
- **No host concept** - web app connects to single daemon
- SessionList doesn't show which host/daemon sessions come from
- Would need architecture change for multi-daemon web UI

---

## Port Allocation Strategy

### Wrapper Mode (Default)
- Auto-selects available port from range 18765-18774 (10 ports max)
- Checks live sessions registry to avoid collisions
- Checks PID liveness (cleans stale entries)
- Retries up to 3 times on EADDRINUSE race

### Daemon Mode (`--daemon`)
- Uses explicit port or single fixed port
- No auto-selection

### Live Sessions Registry
File-based registry at `~/.remi/live-sessions/<sessionId>.json`:
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

CLI reads this to discover all running daemons on localhost.

---

## Discovery Methods Comparison

| Method | Scope | Web App Support | CLI Support |
|--------|-------|-----------------|-------------|
| Live Registry (`~/.remi/live-sessions/`) | Localhost only | No | Yes (default `remi ls`) |
| Direct URL/Port | Single daemon | Yes (via connection modal) | Yes (`--host`, `--port`) |
| mDNS (`_remi._tcp.local`) | LAN + VPN | No | Yes (`--network`) |
| VPN Peers (Tailscale/WireGuard) | VPN network | No | Yes (`--network`) |

---

## Multi-Daemon Support

### CLI: Full Multi-Daemon Support
- `remi ls` queries all local daemons
- `remi ls --network` discovers all daemons on network
- `remi attach hostname:sessionid` resolves hostname via mDNS/VPN, queries all ports
- `remi kill --network` discovers and queries remote daemons

### Web App: No Multi-Daemon Support (Yet)
- Connects to one daemon at a time
- SessionList doesn't show daemon/host info
- Would require:
  1. Add `host` to UISession or new "DaemonInfo" concept
  2. Support multiple concurrent WebSocket connections (one per daemon)
  3. Aggregate sessions across daemons
  4. Enhance SessionList UI to show daemon/host grouping
  5. Update ConnectModal to support multi-daemon discovery

---

## Key Implementation Files

### Discovery (CLI)
- `packages/daemon/src/cli/ls-client.ts` - ls/network discovery
- `packages/daemon/src/mdns/mdns-browser.ts` - mDNS discovery
- `packages/daemon/src/mdns/vpn-discovery.ts` - Tailscale/WireGuard discovery
- `packages/daemon/src/session/session-registry-file.ts` - Live registry

### Protocol
- `packages/shared/src/protocol.ts` - SessionListRequestMessage, SessionListResponseMessage
- `packages/shared/src/types.ts` - DiscoverableSession

### Daemon
- `packages/daemon/src/server/connection.ts` - ConnectionEvents.onSessionListRequest
- `packages/daemon/src/server/websocket-server.ts` - ServerEvents.onSessionListRequest
- `packages/daemon/src/cli.ts` - sharedEvents.onSessionListRequest handler

### Web App
- `packages/web/src/hooks/useWebSocket.ts` - requestSessionList()
- `packages/web/src/App.tsx` - session_list_response handler (lines 378-395)
- `packages/web/src/components/session/SessionList.tsx` - UI display
- `packages/web/src/types/index.ts` - UISession interface
- `packages/web/src/lib/websocket-client.ts` - WebSocket transport

---

## Session Lifecycle (Related to Discovery)

### Creation
- Daemon: `sessionRegistry.registerSession(sessionId, pty, messageApi, locallyOwned)`
- Wrapper: Auto-creates primary session on startup
- CLI: `--create-session-request` message type

### Discoverable State
- Daemon sessions: `sessionRegistry.listSessions()` returns all registered sessions
- Transcript sessions: `transcriptDiscovery.discoverSessions()` scans `~/.remi/sessions/` for `.jsonl` files

### Orphan Timeout
- Non-locally-owned sessions: 5 minutes after detach
- Locally-owned sessions: Never timeout (wrapper mode primary session)
- On timeout: `closeSession('timeout')` removes from registry

### Session Resumption
- `canResume: true` for non-locally-owned, completed sessions with transcript
- Resume via `claude code --resume <sessionId>`
- Connection exclusive: Only one client can attach at a time

---

## Error Handling in Discovery

### Expected Errors (Dimmed in CLI Output)
- ECONNREFUSED - daemon not running on port
- ENOTFOUND - hostname resolution failed
- Session already has active connection - multi-attach on exclusive session

### Auth-Related
- auth_challenge - daemon requires authentication
- auth_result with error - identity rejected or invalid signature
- Timeout: 10 seconds for auth handshake

### Network-Related
- mDNS discovery timeout: 3 seconds
- VPN peer discovery timeout: 2 seconds per probe
- Fetch timeout: 5000ms (ls), 3000ms (attach name resolution)

---

## Inconsistencies & Duplicate Logic

1. **VPN Discovery:**
   - Runs in both `runNetworkLs()` and `attach` command
   - Different timeout configs (3000ms vs 2000ms)
   - Same filtering logic duplicated

2. **Port Resolution:**
   - `runNetworkLs()`: Uses `liveSessionsRegistry.getLivePorts()`
   - `attach`: Manual loop, different error handling

3. **Session Querying:**
   - `runNetworkLs()`: Filters local, queries all
   - `attach`: Manual port loop, different error messages
   - `runLsClient()`: Single port, simple flow

4. **Error Classification:**
   - `runNetworkLs()`: Dims "expected" errors with ANSI codes
   - `attach`: No dimming, different messages

5. **Name vs ID Resolution:**
   - `attach`: Inline multi-fallback stages
   - `kill`: Similar but separate implementation
