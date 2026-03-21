# Remi Network Discovery & `ls` Command Implementation

## Overview
The Remi project has three distinct paths for discovering and listing Claude Code sessions:

1. **`remi ls`** - Local session discovery via live registry
2. **`remi ls --network`** - Network-wide discovery via mDNS + VPN peers
3. **`remi ls --host <host[:port]>`** - Direct connection to specific daemon
4. **`remi attach --host <host>`** - Similar resolution pattern for attachment

## Architecture Diagram

```
┌────────────────────────────────────────────────────────────────────┐
│                    CLI Entry (packages/daemon/src/cli.ts)           │
│  Parses flags: --network, --host, --port                            │
└────────────────────┬─────────────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┬──────────────────┐
        │                         │                  │
        ▼                         ▼                  ▼
   cliNetwork=true          cliHost set      no flags (default)
        │                         │                  │
        ▼                         ▼                  ▼
  runNetworkLs()            runLsClient()    runMultiPortLs()
        │                         │                  │
        └────────────────────┬────┴──────────────────┘
                             │
                             ▼
                    fetchSessions(host, port)
                    (packages/daemon/src/cli/ls-client.ts)
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
              performAuthHandshake  (session_list_response)
              (if auth_challenge)
```

## Detailed Implementation

### 1. CLI Flag Parsing (cli.ts, lines ~365-437)

**Flag Variables:**
- `cliNetwork` (boolean) - Enable network discovery mode
- `cliHost` (string | undefined) - Target host for direct connection
- `cliPort` (number | undefined) - Target port (default: 18765)
- `cliNoMdns` (boolean) - Disable mDNS advertising (daemon-side)

**Flag Handling:**
```
--network     → cliNetwork = true
--host HOST   → cliHost = HOST (next arg consumed)
--port PORT   → cliPort = PORT (next arg consumed)
--local       → cliBindHost = 'localhost', cliNoMdns = true
--no-mdns     → cliNoMdns = true (daemon: disables mDNS publishing)
```

### 2. Three Execution Paths for `remi ls` (cli.ts, lines 767-801)

#### Path A: Network Discovery (`cliNetwork === true`)
```typescript
if (cliNetwork) {
  await runNetworkLs({
    localPort: explicitPort ?? DEFAULT_BASE_PORT,
    localPorts: liveSessionsRegistry.getLivePorts()
  });
}
```

**Flow:**
1. Query all local daemon ports from live registry
2. Run mDNS discovery (Bonjour/mDNS)
3. Run VPN discovery (Tailscale, WireGuard)
4. Filter out self (hostname + local addresses)
5. Deduplicate hosts discovered via both mDNS and VPN
6. Query remote daemons in parallel
7. Render combined results

**Key Function:** `runNetworkLs()` (ls-client.ts, lines 191-328)

#### Path B: Direct Host/Port Connection (`explicitPort || cliHost`)
```typescript
} else if (explicitPort || cliHost) {
  await runLsClient({
    host: cliHost ?? 'localhost',
    port: explicitPort ?? DEFAULT_BASE_PORT
  });
}
```

**Flow:**
1. Single WebSocket connection to specified host:port
2. Send hello, then session_list_request
3. Await session_list_response
4. Render local format

**Key Function:** `runLsClient()` (ls-client.ts, lines 50-53)

#### Path C: Local Multi-Port Discovery (Default)
```typescript
} else {
  await runMultiPortLs({
    registry: liveSessionsRegistry
  });
}
```

**Flow:**
1. Read live sessions registry (tracks all active daemon ports)
2. Query each unique port in parallel
3. Aggregate results
4. Render local format

**Key Function:** `runMultiPortLs()` (ls-client.ts, lines 461-502)

### 3. WebSocket Connection & Session Fetching

**Function:** `fetchSessions(host, port, timeout)` (ls-client.ts, lines 55-165)

**Protocol:**
1. Connect: `ws://host:port/ws`
2. On open: Send `createHello(clientId, version)`
3. Server responds with `hello_ack`
4. Send `createSessionListRequest(false)` (false = don't create session)
5. Wait for `session_list_response` or `auth_challenge`
6. If `auth_challenge`: Run `performAuthHandshake()` then retry steps 2-5
7. Close connection on error or success

**Error Handling:**
- Catches connection errors (ECONNREFUSED, timeout)
- Ignores expected errors after session list received (SESSION_CREATE_FAILED, etc.)
- Timeout: 5000ms default

### 4. Authentication Flow (auth-helper.ts, lines 37-142)

**Trigger:** Daemon sends `auth_challenge` message after `hello`

**Flow:**
1. Load identity from `~/.remi/identity.json`
2. Auto-generate if missing (first use)
3. If encrypted: unlock using `REMI_PASSPHRASE` env var
4. Sign challenge with private key
5. Send `auth_response` (public key + signature + fingerprint)
6. Wait for `auth_result` (success/failure)
7. Timeout: 10 seconds

**Auth Enable/Disable (cli.ts, lines 1365-1380):**
```
Auto-enabled: binding to 0.0.0.0 (network accessible)
Auto-disabled: binding to localhost (127.0.0.1 only)
Explicit override: --auth or --no-auth flags
```

### 5. Network Discovery Mechanisms

#### mDNS Discovery (mdns-browser.ts, lines 22-63)

**Service Type:** `_remi._tcp.local`
**TXT Records:**
- `version` - Remi version
- `auth` - 'true'/'false' (auth enabled)
- `hostname` - OS hostname
- `fingerprint` (optional) - Daemon's public key fingerprint

**Discovery:**
1. Create Bonjour instance
2. Browse for `_remi._tcp` services
3. Collect all found services (3s default timeout)
4. Extract IPv4 addresses (fallback to IPv6)
5. Return list of DiscoveredDaemon objects

**Used By:** `runNetworkLs()` and `attach` with hostname resolution

#### VPN Peer Discovery (vpn-discovery.ts, lines 46-89)

**Supported VPNs:**
- Tailscale: `tailscale status --json`
- WireGuard: `wg show all dump`
- NOT supported: ZeroTier (CLI doesn't expose VPN IPs)

**Tailscale Flow (lines 188-221):**
1. Find `tailscale` binary (PATH or fallback path)
2. Run `tailscale status --json`
3. Filter peers: Online=true, not iOS/Android
4. Extract IPv4 (preferred) or first Tailscale IP
5. Hostname from DNSName or HostName field

**WireGuard Flow (lines 231-272):**
1. Find `wg` binary (PATH or fallback paths)
2. Run `wg show all dump`
3. Parse tab-separated output (8-9 fields per peer)
4. Filter: recent handshake (< 5 minutes old)
5. Extract first allowed IP, strip CIDR notation

**Deduplication:** By IP address, prefers Tailscale > WireGuard

**Port Probing:** For each peer, try base port ± portRange (default: 18765-18774)

### 6. Attach Command Resolution (cli.ts, lines 860-1200)

**Pattern Matching (lines 868-881):**

1. **Remote Format** (`host:port/session-id`):
   - Last colon before first slash
   - Port between colon and slash (numeric)
   - Parse with `parseRemoteTarget()`

2. **Host:Port Format** (no slash):
   - Regex: `(.+):(\d+)$`
   - Port > 1024 (avoid session name confusion)
   - Auto-fetch sessions, pick attachable or most recent

3. **Session Name/ID:**
   - Check live registry (fast, local)
   - Query all local ports (registry + default)
   - Prefix matching (name or ID)

4. **Hostname Resolution:**
   - Extract hostname from session name (before first `:`)
   - Run mDNS + VPN discovery in parallel
   - Try mDNS first, fallback to VPN
   - Query all ports on resolved host

**Session Resolution Order:**
1. Live registry (name/ID) - no network
2. Query all local ports - local network only
3. Session store (backward compat) - no network
4. mDNS + VPN discovery - full network

**Duplicate/Inconsistent Logic Areas:**
- **Port resolution:** Both `attach` and `ls --network` rediscover VPN peers
- **Session querying:** `attach` manually queries ports, `ls --network` uses shared logic
- **Name resolution:** `attach` has inline code, `ls --host` uses single-port logic
- **Error handling:** Different messages in different paths
- **Timeout handling:** Different timeouts (3000ms for attach name resolution, 5000ms for ls)

## Key Data Structures

### DiscoverableSession (from @remi/shared)
```typescript
interface DiscoverableSession {
  sessionId: UUID;
  projectPath: string;
  status: 'active' | 'idle' | 'completed';
  lastActivity: Timestamp;
  messageCount?: number;
  model?: string;
  lastMessage?: string;
  source?: 'live' | 'transcript' | 'daemon';
  canAttach?: boolean;
  name?: string;
  createdAt?: Timestamp;
}
```

### DiscoveredDaemon (mdns-browser.ts)
```typescript
interface DiscoveredDaemon {
  name: string;        // mDNS service name
  host: string;        // IP to connect to
  port: number;
  version: string;
  authEnabled: boolean;
  fingerprint?: string;
  hostname: string;    // OS hostname
}
```

### VpnPeer (vpn-discovery.ts)
```typescript
interface VpnPeer {
  hostname: string;
  ip: string;          // VPN IP address
  os: string;
  provider: 'tailscale' | 'wireguard';
}
```

## Constants & Defaults

- **Default Port:** 18765 (DEFAULT_BASE_PORT)
- **Port Range:** 10 ports (18765-18774) for VPN probing
- **mDNS Service Type:** `_remi._tcp.local`
- **Fetch Timeout:** 5000ms
- **mDNS Browse Timeout:** 3000ms
- **VPN Probe Timeout:** 2000ms per probe
- **Auth Handshake Timeout:** 10000ms
- **Hostname Resolution (attach):** 3000ms mDNS, 2000ms VPN

## Flow Variants

### `remi ls`
1. Query live registry for local ports
2. Query each port in parallel
3. Render results (local format, no host column)

### `remi ls --network`
1. Query all local ports
2. mDNS discover + VPN discover (parallel)
3. Query remote daemons (parallel)
4. Render results (network format, host column, attach hints)

### `remi ls --host 192.168.1.5`
1. Single WebSocket to `192.168.1.5:18765`
2. Render results (local format)

### `remi ls --host 192.168.1.5 --port 18766`
1. Single WebSocket to `192.168.1.5:18766`
2. Render results (local format)

### `remi attach session-name`
1. Check live registry
2. Query all local ports
3. Check session store
4. If not found locally, extract hostname from name
5. mDNS + VPN discovery for hostname
6. Query all ports on resolved host
7. Connect and attach

### `remi attach 192.168.1.5:18765/session-name`
1. Parse remote format
2. Single WebSocket to `192.168.1.5:18765`
3. Resolve session by name
4. Attach

### `remi attach 192.168.1.5:18765`
1. Parse host:port (no session ID)
2. Fetch sessions from `192.168.1.5:18765`
3. Auto-pick attachable or most recent
4. Attach

## Inconsistencies & Duplicate Logic

### 1. VPN Discovery
- Runs in both `runNetworkLs()` and `attach` command
- Same discovery logic duplicated
- Different timeout configurations (3000ms vs 2000ms)
- No shared function; each implements filtering

### 2. Port Resolution
- `runNetworkLs()`: Uses `liveSessionsRegistry.getLivePorts()`
- `attach`: Uses `cliPort || cliHost ? [port] : getLivePorts()`
- Logic slightly different in condition order

### 3. Session Querying
- `runNetworkLs()`: Filters local daemons, then queries all
- `attach`: Manual loop through `portsToQuery`, different error messages
- `runLsClient()`: Single port, simple flow
- `runMultiPortLs()`: All ports from registry, shared rendering

### 4. Error Handling
- `runNetworkLs()`: Dims expected errors with `\x1b[2m` (dimmed)
- `attach`: No dimming, different messages
- Different classification of "expected" errors
- Inconsistent logging prefixes (`[ls]` vs `[attach]`)

### 5. Timeout Configurations
- Fetch timeout: 5000ms (ls), 3000ms (attach name resolution)
- mDNS timeout: 3000ms (ls), 3000ms (attach)
- VPN probe timeout: 2000ms (both)

### 6. Deduplication
- `runNetworkLs()`: Tracks via `discoveredHosts` Set
- `attach`: Deduplication inline within `allHostPorts` Set
- VPN result filtering: Different logic paths

### 7. Session Name vs ID Resolution
- `attach`: Inline resolution with multiple fallback stages
- `kill`: Similar but separate implementation in kill-client.ts
- `ls`: No name resolution (not needed, just lists)

## Files Involved

### Core CLI
- `packages/daemon/src/cli.ts` (2500+ lines, main entry)

### Client Operations
- `packages/daemon/src/cli/ls-client.ts` - runLsClient, runNetworkLs, runMultiPortLs, fetchSessions
- `packages/daemon/src/cli/kill-client.ts` - runKillClient
- `packages/daemon/src/cli/auth-helper.ts` - performAuthHandshake
- `packages/daemon/src/cli/detach-scanner.ts` - DetachScanner

### Discovery
- `packages/daemon/src/mdns/mdns-browser.ts` - discoverDaemons
- `packages/daemon/src/mdns/mdns-publisher.ts` - MdnsPublisher
- `packages/daemon/src/mdns/vpn-discovery.ts` - discoverVpnPeers, getAllVpnPeers, getTailscalePeers, getWireGuardPeers
- `packages/daemon/src/mdns/constants.ts` - MDNS_SERVICE_TYPE

### Session Management
- `packages/daemon/src/session/session-registry-file.ts` - Live sessions registry
- `packages/daemon/src/transcript/transcript-discovery.ts` - TranscriptDiscovery
- `packages/daemon/src/transcript/transcript-watcher.ts` - TranscriptWatcher

### Shared Protocol
- `packages/shared/src/protocol.ts` - Message types
- `packages/shared/src/types.ts` - DiscoverableSession, etc.

## Testing
- `packages/daemon/tests/cli/ls-client.test.ts` - Tests for ls client operations
- `packages/daemon/tests/mdns/*` - mDNS tests (if present)
