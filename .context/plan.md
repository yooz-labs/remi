# Remote Connectivity via WebRTC - Implementation Plan

## Issue: #10 (feature/issue-10-remote-connectivity)

## Current State
- Signaling server code complete in packages/signaling/ (Cloudflare Worker + Durable Objects)
- ConnectionRoom handles register/join/offer/answer/ice-candidate
- Code generator creates AXBY-1234 format codes
- Web client has ConnectModal with "Remote (Code)" tab but it's a stub
- NO WebRTC code exists anywhere in the codebase
- NO STUN/TURN configuration

## Architecture (Relay-First)
```
Daemon                    Signaling Server              Web Client
  |                       (Cloudflare Worker)               |
  |--- WS: register -------->|                              |
  |<-- WS: registered (code) |                              |
  |                           |                              |
  |                           |<---- WS: join (code) --------|
  |                           |----> WS: peer-connected ---->|
  |<-- WS: peer-connected ---|                              |
  |                           |                              |
  |--- WS: remi msg -------->|----> WS: remi msg ---------->|
  |<-- WS: remi msg ---------|<---- WS: remi msg -----------|
  |                           |                              |
  |    (Remi protocol messages relayed through signaling)   |
```

## Key Decision: Relay-First, WebRTC Later
Instead of WebRTC immediately (complex, Bun N-API compatibility uncertain for
node-datachannel), use the signaling server as a message relay:
- Works immediately with existing WebSocket code
- No native dependencies needed
- Signaling server already handles message forwarding
- Can upgrade to WebRTC P2P later as optimization
- Cloudflare Workers have low latency globally

## Implementation Phases

### Phase 1: Deploy Signaling Server
- Deploy packages/signaling/ to Cloudflare (yooz account)
- Verify: POST /register, GET /health
- Update wrangler.toml with production config
- **Blocker**: Need Wrangler access to yooz account

### Phase 2: Extend Signaling for Relay Mode
**Modify: `packages/signaling/src/connection-room.ts`**
- Add 'relay' message type to SignalingMessage union
- Forward relay messages between host and client (same as signaling)
- This allows Remi protocol messages to flow through the signaling WS

**Modify: `packages/signaling/src/types.ts`**
- Add RelayMessage type: `{ type: 'relay', payload: string }`

### Phase 3: Daemon Side - Signaling Client
**Create: `packages/daemon/src/remote/signaling-client.ts`**
- Connect to signaling server via WebSocket
- Send 'register' message, receive code
- Display code in CLI output
- Forward incoming relay messages to daemon's event system

**Create: `packages/daemon/src/remote/relay-adapter.ts`**
- Implements ConnectionAdapter interface
- Bridges signaling client to daemon's adapter registry
- Translates relay messages to/from protocol messages

**Modify: `packages/daemon/src/cli.ts`**
- Add `--signaling-url` flag (default: production signaling server URL)
- Add `--remote` flag to enable remote connectivity
- Register relay adapter alongside WebSocket adapter

### Phase 4: Web Client Side
**Modify: `packages/web/src/App.tsx`**
- Implement handleConnectCode (currently console.warn stub)
- Create signaling WebSocket connection on code entry
- Send 'join' message with code
- Bridge relay messages to existing message handler

**Create: `packages/web/src/lib/signaling-client.ts`**
- WebSocket client for signaling server
- Handles join flow and relay message forwarding

**Modify: `packages/web/src/components/session/ConnectModal.tsx`**
- Wire code input to signaling client

### Phase 5: WebRTC Upgrade (Future)
- Add WebRTC DataChannel on web client (browser-native API)
- Research node-datachannel Bun compatibility for daemon side
- Upgrade from relay to P2P when both peers support it
- Keep relay as fallback for symmetric NAT

## Files Summary
| File | Action |
|------|--------|
| `packages/signaling/src/connection-room.ts` | Modify (relay support) |
| `packages/signaling/src/types.ts` | Modify (relay message type) |
| `packages/signaling/wrangler.toml` | Modify (deploy config) |
| `packages/daemon/src/remote/signaling-client.ts` | Create |
| `packages/daemon/src/remote/relay-adapter.ts` | Create |
| `packages/daemon/src/cli.ts` | Modify (--signaling-url, --remote) |
| `packages/web/src/App.tsx` | Modify (handleConnectCode) |
| `packages/web/src/lib/signaling-client.ts` | Create |
| `packages/web/src/components/session/ConnectModal.tsx` | Modify |

## Testing
- Deploy signaling server, test with curl
- Start daemon with --remote --signaling-url, verify code displayed
- Enter code in web client, verify connection via relay
- Send messages both directions
- Test disconnect/reconnect
- Test with daemon and client on different networks
