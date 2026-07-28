# Remi Research Notes

## Purpose
Track technical solutions, approaches, and references discovered during development.

---

## Research: Transcript-Based Content & Session Discovery
**Date:** 2026-01-24
**Context:** Terminal parsing has fundamental limitations (cursor positioning, ANSI artifacts). Claude Code stores clean structured transcripts at `~/.claude/projects/<project-path>/<session-id>.jsonl`.

### Key Discovery: Claude Code Transcript Format

Claude Code stores complete conversation history as `.jsonl` files:
- Path: `~/.claude/projects/<mangled-project-path>/<session-id>.jsonl`
- Each line is a JSON object with `type` field
- Types: `user`, `assistant`, `tool_result`, `file-history-snapshot`
- Message content is CLEAN text (no ANSI, no terminal artifacts)

**Example assistant message in transcript:**
```json
{
  "type": "assistant",
  "message": {
    "role": "assistant",
    "content": [
      {"type": "text", "text": "I'll help with the landing page..."},
      {"type": "tool_use", "name": "Write", "input": {...}}
    ]
  }
}
```

### Architecture: Hybrid PTY + Transcript

**The Problem:**
- PTY output is real-time but garbled (cursor movements, ANSI, wizard UI)
- Transcript is clean but only available after Claude finishes its turn

**The Solution: Two-phase message delivery**

```
Phase 1: STREAMING (PTY)
  - Detect status changes (thinking, writing, idle)
  - Detect questions (need immediate user response)
  - Show "Claude is working..." indicator
  - Don't try to render message content

Phase 2: FINALIZED (Transcript)
  - When Claude's turn completes (idle detected OR Stop hook fires)
  - Read new entries from the .jsonl transcript
  - Parse clean text + tool_use blocks
  - Map to our message/bullet structure
  - Display final clean messages
```

### Message ID Mapping

Our system's message IDs should map to Claude Code's `messageId` in transcripts:

```
Remi Message (UUID) ←→ Transcript Entry (messageId)
  └─ Bullet 1       ←→ content[0] (text block)
  └─ Bullet 2       ←→ content[1] (tool_use block)
  └─ Bullet 3       ←→ content[2] (text block after tool)
```

Each `content` block in the transcript becomes a bullet in our system.
Tool use blocks become collapsible tool indicators.

### Session Discovery Design

**Concept:** Replace `claude` with `remi` command. The daemon manages Claude Code sessions.

**CLI Commands:**
```bash
remi start [--dir <path>]     # Create new Claude session (like running claude)
remi discover                 # List all active sessions
remi attach <session-id>      # Attach to an existing session
remi list                     # List all sessions (active + history)
```

**Discovery Sources:**
1. Daemon registry (sessions spawned by remi)
2. Transcript scan (sessions from direct `claude` usage)
3. Process detection (running claude processes)

**Session Metadata for Discovery:**
```typescript
interface DiscoverableSession {
  sessionId: string;
  projectPath: string;          // Working directory
  status: 'active' | 'idle' | 'orphaned' | 'completed';
  lastActivity: Timestamp;      // Last transcript modification
  messageCount: number;         // Total messages in transcript
  model?: string;               // From SessionStart hook data
  lastMessage?: string;         // Preview of last message (truncated)
  source: 'daemon' | 'external';  // How session was started
}
```

**WebSocket Protocol for Discovery:**
```typescript
// Client -> Server
{ type: 'discover_sessions' }

// Server -> Client
{
  type: 'sessions_list',
  sessions: DiscoverableSession[]
}

// Client -> Server (attach to existing)
{ type: 'attach_session', sessionId: string }

// Server -> Client (replay history from transcript)
{
  type: 'session_history',
  sessionId: string,
  messages: StructuredMessage[]  // Parsed from .jsonl
}
```

### Transcript File Watcher

To detect when Claude finishes a turn:
1. Watch the `.jsonl` file with `fs.watch()`
2. On change, read new lines (track file offset)
3. Parse new entries and emit message events
4. Much cleaner than terminal parsing!

```typescript
class TranscriptWatcher {
  private offset: number = 0;

  watch(transcriptPath: string, onNewEntry: (entry: TranscriptEntry) => void) {
    fs.watch(transcriptPath, () => {
      const content = fs.readFileSync(transcriptPath, 'utf8');
      const newContent = content.slice(this.offset);
      this.offset = content.length;

      for (const line of newContent.split('\n')) {
        if (line.trim()) {
          const entry = JSON.parse(line);
          onNewEntry(entry);
        }
      }
    });
  }
}
```

### Claude Code Hooks Integration

Use hooks to get structured events without PTY parsing:

```json
{
  "hooks": {
    "Notification": [{
      "matcher": "permission_prompt|idle_prompt",
      "hooks": [{
        "type": "command",
        "command": "curl -s http://localhost:18765/hook"
      }]
    }],
    "Stop": [{
      "hooks": [{
        "type": "command",
        "command": "curl -s http://localhost:18765/hook/stop"
      }]
    }]
  }
}
```

This gives us:
- `permission_prompt` -> Question detected (need user input)
- `idle_prompt` -> Claude waiting 60+ seconds
- `Stop` -> Claude finished its turn (read transcript now!)

### Next Steps

1. Add `listSessions()` to SessionRegistry
2. Add `discover_sessions` protocol message
3. Implement TranscriptWatcher class
4. Add transcript parsing for clean message content
5. Integrate hooks for Stop/Notification events
6. Create `remi` CLI wrapper command

---

## Research: Cross-Platform Frameworks
**Date:** 2026-01-09
**Context:** Evaluating best approach for building cross-platform Claude Code monitor

### Explored Solutions:

#### 1. Capacitor (Ionic)
- **Description:** Native runtime that wraps web apps for iOS/Android with native plugin access
- **Pros:**
  - Web-first development (90% in browser)
  - Standard React/Vue/vanilla JS
  - Native plugins for notifications, storage
  - Hot reload during development
  - True cross-platform (iOS, Android, PWA)
- **Cons:**
  - No desktop without Electron wrapper
  - WebView performance not quite native
  - SSR not supported (static export only)
- **References:** [capacitorjs.com](https://capacitorjs.com)

#### 2. Tauri 2.0
- **Description:** Rust-based desktop app framework using system WebView
- **Pros:**
  - 2-10 MB bundle size (vs 100+ MB Electron)
  - 30-40 MB memory usage
  - Rust backend for performance
  - Mobile support in Tauri 2.0
  - Strong security model
- **Cons:**
  - Requires Rust knowledge for backend
  - WebView rendering differences across platforms
  - Newer ecosystem, less documentation
- **References:** [tauri.app](https://tauri.app)

#### 3. Electron
- **Description:** Chromium + Node.js bundled desktop apps
- **Pros:**
  - 60% market share for desktop apps
  - Mature ecosystem
  - VS Code, Discord use it
  - JavaScript throughout
- **Cons:**
  - 100+ MB bundle size
  - 200-300 MB memory usage
  - Slow startup (1-2 seconds)
  - No mobile support
- **References:** [electronjs.org](https://www.electronjs.org/)

### Decision:
**Selected:** Capacitor for mobile, web-first for desktop
**Rationale:**
- Mobile is primary use case (notifications on the go)
- Web-first enables fastest iteration with Chrome DevTools
- Can add Electron/Tauri wrapper later for desktop if needed
- Simpler than React Native; standard web tech

---

## Research: PTY (Pseudo-Terminal) Solutions
**Date:** 2026-01-09
**Context:** Need to spawn Claude Code in PTY to capture interactive output

### Explored Solutions:

#### 1. Bun Native PTY API (v1.3.5+)
- **Description:** Built-in `Bun.spawn()` with `terminal` option
- **Pros:**
  - Zero dependencies
  - Native performance
  - Clean API: `write()`, `resize()`, `setRawMode()`
  - Released December 2025
- **Cons:**
  - Only POSIX (macOS, Linux); no Windows yet
  - Very new, may have edge cases
- **References:** [Bun v1.3.5 Blog](https://bun.com/blog/bun-v1.3.5)

#### 2. @zenyr/bun-pty
- **Description:** Cross-platform PTY for Bun using Rust (portable-pty)
- **Pros:**
  - Windows support
  - ~600KB bundle (ARM64 optimized)
  - Promise-based API
  - Fork with fixes for exit codes
- **Cons:**
  - External dependency
  - Rust native module complexity
- **References:** [npm @zenyr/bun-pty](https://libraries.io/npm/@zenyr%2Fbun-pty)

#### 3. node-pty (Microsoft)
- **Description:** Industry standard Node.js PTY bindings
- **Pros:**
  - Battle-tested in VS Code
  - All platforms including Windows
  - Extensive documentation
- **Cons:**
  - Node.js focused, not Bun-optimized
  - C++ native module
- **References:** [github.com/microsoft/node-pty](https://github.com/microsoft/node-pty)

### Decision:
**Selected:** Bun native PTY as primary, @zenyr/bun-pty for Windows fallback
**Rationale:**
- Native solution = zero dependencies for primary platforms
- Windows can be added later with fallback
- Bun's API is clean and modern

### Implementation Notes:
```typescript
// Bun native PTY example
const proc = Bun.spawn(["claude"], {
  terminal: {
    columns: 80,
    rows: 24,
    onData: (data) => {
      // Handle terminal output
      console.log(data);
    },
  },
});

// Write to terminal
proc.terminal.write("y\n");

// Resize
proc.terminal.resize(120, 40);
```

---

## Research: Terminal Emulator for Web
**Date:** 2026-01-09
**Context:** Need to properly parse ANSI escape sequences from Claude Code output

### Explored Solutions:

#### 1. xterm.js
- **Description:** Industry-standard terminal emulator for web
- **Pros:**
  - Used by VS Code, Hyper, and many others
  - Full VT100/ANSI support
  - Active development
  - Rich addon ecosystem (@xterm/addon-attach for WebSocket)
- **Cons:**
  - 500KB+ bundle if all addons included
  - WebGL renderer complexity
- **References:** [xtermjs.org](https://xtermjs.org)

#### 2. Custom ANSI Parser
- **Description:** Write regex-based parser for escape sequences
- **Pros:**
  - Minimal bundle size
  - Full control
- **Cons:**
  - Error-prone
  - Many edge cases in VT100 spec
  - Reinventing the wheel
- **References:** N/A

### Decision:
**Selected:** xterm.js with @xterm/addon-attach
**Rationale:**
- Production-proven in VS Code
- WebSocket addon perfect for our use case
- Not worth reinventing terminal parsing

### Implementation Notes:
```typescript
import { Terminal } from 'xterm';
import { AttachAddon } from '@xterm/addon-attach';

const terminal = new Terminal();
const ws = new WebSocket('ws://localhost:8765');
const attachAddon = new AttachAddon(ws);
terminal.loadAddon(attachAddon);
terminal.open(document.getElementById('terminal'));
```

---

## Research: Embedded Transport (WebRTC)
**Date:** 2026-01-09
**Context:** How to provide secure remote access WITHOUT requiring external apps

### Problem with External Dependencies
Requiring users to install Tailscale/VPN before using our app creates friction.
Users want: install Remi, open app, connect. Done.

### Explored Solutions:

#### 1. WebRTC DataChannel (Selected)
- **Description:** Browser-native P2P encrypted data channel
- **Pros:**
  - Built into ALL browsers and mobile platforms
  - DTLS encryption (automatic, same strength as TLS)
  - NAT traversal via ICE (STUN for discovery, TURN for relay)
  - P2P when possible = no server sees your data
  - Zero external dependencies
- **Cons:**
  - Need signaling server for initial connection
  - TURN relay needed for ~10% of connections (symmetric NAT)
- **References:** [MDN WebRTC API](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API)

#### 2. libp2p
- **Description:** Modular P2P networking stack (used by Ethereum, IPFS)
- **Pros:**
  - Supports WebRTC + QUIC + WebSocket
  - Mature, battle-tested
  - Mesh networking capabilities
- **Cons:**
  - More complex than needed for 1:1 connection
  - Larger bundle size
- **References:** [libp2p.io](https://libp2p.io)

#### 3. QUIC
- **Description:** UDP-based transport with built-in encryption
- **Pros:**
  - TLS 1.3 built-in
  - 0-RTT connection resumption
  - Better than TCP for mobile
- **Cons:**
  - Not universally supported in browsers yet
  - More complex server setup
- **References:** [chromium.org/quic](https://www.chromium.org/quic/)

### Decision:
**Selected:** WebRTC DataChannel
**Rationale:**
- Zero external apps needed
- Built into every browser and mobile platform
- DTLS provides same security as TLS
- NAT traversal is automatic
- P2P when possible (symmetric NAT gets TURN relay)

### NAT Traversal Strategy:
1. Use free public STUN servers (Google, Twilio) for IP discovery
2. Self-host coturn for TURN relay (or use Twilio TURN)
3. ICE handles fallback automatically

```typescript
const config = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'turn:turn.remi.app', username: '...', credential: '...' }
  ]
};
```

---

## Research: Reliable Messaging Protocol
**Date:** 2026-01-09
**Context:** Need WhatsApp-like message delivery guarantees

### Requirements (from user):
1. **Delivery acknowledgments** - Know when message arrived
2. **No silent drops** - Queue if offline, retry on failure
3. **Message editing** - Agent updates messages as it works
4. **Timestamps** - Full audit trail
5. **Deduplication** - No duplicate messages

### Reference: Lab Streaming Layer (secureLSL)
From our biomedical streaming project:
- Timestamps on every sample
- Nonce-based ordering and deduplication
- 64-packet sliding window for replay prevention
- Unanimous security model

### Reference: WhatsApp/XMPP Patterns
- **XEP-0184:** Message Delivery Receipts standard
- Single checkmark = sent to server
- Double checkmark = delivered to device
- Blue checkmarks = read by user

### Message Protocol Design:

```typescript
// Message states (like WhatsApp)
type MessageState = 'sending' | 'sent' | 'delivered' | 'read';

interface Message {
  id: string;              // UUID for deduplication
  sessionId: string;       // Claude session
  type: 'agent' | 'user';
  content: string;
  timestamp: Date;
  state: MessageState;

  // Editing support
  editedAt?: Date;
  isEditing?: boolean;     // Agent still working

  // Agent context
  tool?: string;           // "Reading file.txt"
}

interface Acknowledgment {
  messageId: string;
  state: 'delivered' | 'read';
  timestamp: Date;
}
```

### Message Flow:
1. Create message with `state: sending`
2. Send via WebRTC DataChannel
3. Update to `state: sent` when channel confirms
4. Recipient sends `Acknowledgment{state: delivered}`
5. Update to `state: delivered`
6. When displayed, recipient sends `Acknowledgment{state: read}`
7. Update to `state: read`

### Message Editing Flow:
```
Agent creates: "Thinking..."           [isEditing: true]
Agent edits:   "Reading index.ts..."   [isEditing: true]
Agent edits:   "Found issues..."       [isEditing: true]
Agent final:   "Done! See details"     [isEditing: false]
```

Each edit:
- Same message `id`
- New `content`
- Updated `editedAt`
- UI shows "edited" indicator

### Deduplication:
- Message ID is UUID generated by sender
- Receiver tracks seen IDs (LRU cache, 1000 items)
- Duplicate = already seen ID → ignore, still send ACK

### Offline Handling:
- Messages queued locally when disconnected
- Queue persisted to localStorage/SQLite
- Retry on reconnection
- Show "sending" state until acknowledged

---

## Research: Fallback Transport Options
**Date:** 2026-01-09
**Context:** For advanced users who prefer traditional methods

### SSH Tunnel (Always Works)
```bash
ssh -L 8765:localhost:8765 user@server
# Then connect to ws://localhost:8765
```
- Works through any firewall
- Uses existing SSH keys
- No WebRTC needed (direct WebSocket)

### Tailscale (If Already Installed)
```bash
# If user already has Tailscale, they can use it
# Access via tailnet IP: ws://100.x.x.x:8765
```
- Zero-config if already set up
- WireGuard encryption

### Local Network
```bash
# Same WiFi
# Access: ws://192.168.x.x:8765
```
- Direct WebSocket, no tunneling
- Trusted network only

### Decision:
1. **Direct connection first** - For SSH/Tailscale/VPN/local users
2. **Signaling + WebRTC** - For users without direct path
3. **TURN relay** - Fallback for symmetric NAT

---

## Research: Signaling Infrastructure
**Date:** 2026-01-09
**Context:** Need lightweight signaling for WebRTC SDP exchange

### Requirements:
- Forward SDP offers/answers (~2KB each)
- No data transfer (just signaling)
- Globally distributed (low latency)
- Cheap/free

### Cloudflare Workers (Selected)

**Why Cloudflare Workers:**
- Free tier: 100,000 requests/day
- Globally distributed (300+ edge locations)
- Stateless (use Durable Objects if needed)
- WebSocket support
- Zero cold start

**Implementation sketch:**
```typescript
// Cloudflare Worker
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/register') {
      // Daemon registers, gets code
      const code = generateCode();  // AXBY-1234
      await env.CODES.put(code, '', { expirationTtl: 3600 });
      return upgradeToWebSocket(request, code);
    }

    if (url.pathname === '/connect') {
      // Phone connects with code
      const code = url.searchParams.get('code');
      return forwardToRegisteredDaemon(code);
    }
  }
};
```

**State management options:**
- **KV**: Simple key-value, eventually consistent
- **Durable Objects**: Strongly consistent, WebSocket coordination
- **R2**: If we need to store anything (we don't)

### Alternative: Cloudflare Durable Objects

For WebSocket coordination between phone and daemon:
```typescript
export class SignalingRoom {
  async fetch(request) {
    const ws = new WebSocketPair();
    this.connections.push(ws[1]);
    // Forward messages between daemon and phone
    return new Response(null, { status: 101, webSocket: ws[0] });
  }
}
```

### Cost Estimate

| Usage | Free Tier | Paid |
|-------|-----------|------|
| Workers requests | 100K/day | $0.50/million |
| Durable Objects | 1M requests/mo | $0.15/million |
| KV reads | 100K/day | $0.50/million |

For a single user with ~100 connections/day: **Free**
For 1000 users: Still mostly free tier

### Decision:
**Selected:** Cloudflare Workers with Durable Objects
**Rationale:**
- Free for our scale
- WebSocket support for real-time signaling
- Globally distributed
- No server to maintain

---

## Research: Happy Coder Architecture
**Date:** 2026-01-09
**Context:** Understanding competitor architecture to differentiate Remi

### Architecture Analysis:

**Components:**
1. `happy-cli` - Desktop wrapper for Claude Code
2. `happy-server` - Encrypted relay server
3. `happy-coder` - Mobile/web client

**Communication Flow:**
1. CLI wraps Claude Code execution
2. Encrypts output and uploads to relay server (object storage)
3. Mobile client polls/receives encrypted blobs
4. Decrypts and displays
5. User input encrypted and sent back

**Strengths:**
- End-to-end encryption
- Works across networks (not just local)
- Multiple devices can connect

**Weaknesses:**
- Relay dependency (205 GitHub issues, many infrastructure-related)
- Port conflicts common issue
- More complex architecture
- Privacy depends on trusting relay server

### Remi Differentiation:
1. **No relay** - Direct localhost WebSocket
2. **Simpler** - Two components instead of three
3. **Faster** - No encryption/decryption overhead
4. **Privacy** - Code never leaves machine
5. **Reliability** - No server outages possible

---

## Research: Real-Time Communication
**Date:** 2026-01-09
**Context:** Best way to stream terminal output to mobile/web clients

### Explored Solutions:

#### 1. WebSocket
- **Description:** Full-duplex TCP-based protocol
- **Pros:**
  - Low latency
  - Bidirectional
  - Standard browser API
  - Bun has native WebSocket server
- **Cons:**
  - Requires connection management
  - Need reconnection logic
- **References:** [MDN WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API)

#### 2. Socket.IO
- **Description:** WebSocket with fallbacks and features
- **Pros:**
  - Auto-reconnection
  - Rooms/namespaces
  - Fallback to long-polling
- **Cons:**
  - Overkill for local-only use
  - Extra dependency
- **References:** [socket.io](https://socket.io)

#### 3. Server-Sent Events (SSE)
- **Description:** HTTP-based server-to-client streaming
- **Pros:**
  - Simple
  - HTTP/1.1 compatible
- **Cons:**
  - One-directional only (need separate POST for input)
  - Not ideal for bidirectional terminal
- **References:** [MDN SSE](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)

### Decision:
**Selected:** Plain WebSocket
**Rationale:**
- Bidirectional needed for terminal I/O
- Bun's native WebSocket server is performant
- Socket.IO features not needed for local-only

### Implementation Notes:
```typescript
// Bun WebSocket server
Bun.serve({
  port: 8765,
  fetch(req, server) {
    if (server.upgrade(req)) return;
    return new Response("Upgrade failed", { status: 500 });
  },
  websocket: {
    open(ws) { /* client connected */ },
    message(ws, message) { /* handle input */ },
    close(ws) { /* client disconnected */ },
  },
});
```

---

## References & Resources

### Documentation
- [Bun PTY API](https://bun.com/blog/bun-v1.3.5) - Native terminal support
- [Capacitor Docs](https://capacitorjs.com/docs) - Cross-platform runtime
- [xterm.js Docs](https://xtermjs.org/docs/) - Terminal emulator API
- [WebSocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) - Browser standard

### Code Examples
- [Happy Coder](https://github.com/slopus/happy) - Competitor implementation
- [WebTerminal](https://github.com/zpgu/WebTerminal) - xterm.js + WebSocket example
- [pyxtermjs](https://pypi.org/project/pyxtermjs/) - Python xterm.js server

### Related Projects
- [ccusage](https://github.com/ryoppippi/ccusage) - Claude Code usage analyzer
- [opencode-pty](https://github.com/shekohex/opencode-pty) - PTY plugin for OpenCode
- [Muxer](../muxer) - Original Swift iOS implementation

---

## Technical Decisions Log

### Decision: Bun over Node.js
**Date:** 2026-01-09
**Options Considered:**
- Node.js: Mature, universal, but no native PTY
- Deno: Modern, but less ecosystem
- Bun: Native PTY, fast, TypeScript-first
**Choice:** Bun
**Reasoning:** Native PTY API is killer feature; TypeScript support without build step

### Decision: Capacitor over React Native
**Date:** 2026-01-09
**Options Considered:**
- React Native: True native UI, but complex build
- Capacitor: WebView-based, but simpler development
- Flutter: Cross-platform, but different language (Dart)
**Choice:** Capacitor
**Reasoning:** Web-first iteration speed; can develop in browser with hot reload

### Decision: Embedded WebRTC over External Dependencies
**Date:** 2026-01-09
**Options Considered:**
- External VPN (Tailscale): Requires separate app install
- WebRTC DataChannel: Built into browsers, zero friction
- Custom relay: Must maintain server
- SSH tunnel: Advanced users only
**Choice:** WebRTC DataChannel as primary, SSH/Tailscale as fallback
**Reasoning:**
- Zero friction: no external app to install
- DTLS encryption automatic (same strength as TLS)
- NAT traversal built-in (STUN/TURN)
- P2P when possible, relay only if needed
- Fallback to SSH/Tailscale for advanced users

### Decision: WhatsApp-Style Messaging Protocol
**Date:** 2026-01-09
**Options Considered:**
- Raw WebSocket streaming: Simple but no guarantees
- XMPP (XEP-0184): Standard but complex
- Custom protocol: Tailored to our needs
**Choice:** Custom protocol inspired by WhatsApp/XMPP
**Reasoning:**
- Message states (sending → sent → delivered → read)
- Message editing (agent updates progressively)
- Acknowledgments (guaranteed delivery)
- Timestamps and deduplication
- Inspired by secureLSL patterns

---

## Research: Voice Integration - Hands-Free Claude Code Monitoring
**Date:** 2026-01-24
**Updated:** 2026-01-24 (corrected direction: pure Swift, no Python, no VAD)
**Context:** Adding TTS + STT to Remi for hands-free conversation with Claude Code sessions. User hears Claude's responses read aloud, replies verbally.
**Priority:** After chat UI is functional (voice is a layer on top of working chat)

### Corrected Direction

Key corrections from initial research:
1. **No Python** - Pure Swift/MLX-Swift for both STT and TTS (same foundation)
2. **No VAD** - Always-listening STT (VAD causes lost words at speech boundaries)
3. **No subprocess management** - Everything runs in-process on Apple Silicon
4. **Kokoro for TTS** - Lightweight, fast, already supported in mlx-audio-swift
5. **Mac first, iPhone immediate next** - Same Swift code for both

### Components

| Layer | Component | Status | Notes |
|-------|-----------|--------|-------|
| STT | YoozSTTEngine (Swift, MLX-Swift) | Production ready | Always-on, continuous stream, <200ms latency |
| TTS | mlx-audio-swift + Kokoro | Needs integration | Lightweight, MIT, fast enough for real-time |

### Architecture (Pure Swift)

```
Remi Capacitor App
├── React UI - chat interface + voice toggle + speaking indicator
├── Native Plugin: VoiceManager (Swift)
│   ├── STT: YoozSTTEngine (continuous stream, always listening)
│   │   └── No VAD gating; model outputs nothing on silence
│   └── TTS: mlx-audio-swift (Kokoro model)
│       └── In-process, no subprocess
└── Daemon (WebSocket) - existing transcript bridge
```

### Conversation Flow (Always-Listening)

```
STT runs continuously (always listening)
  -> YoozSTTEngine outputs text when speech detected
  -> Text sent to Remi daemon via WebSocket
  -> Daemon forwards to Claude Code PTY
  -> Claude responds (detected via transcript bridge)
  -> Response text sent to client
  -> Smart TTS filtering (skip code blocks, summarize long output)
  -> Kokoro generates audio (in-process)
  -> Audio playback (cancelable on new user speech)
```

### Smart TTS Filtering

1. Read agent text messages (not tool calls, not thinking blocks)
2. For code blocks >3 lines: say "code block with N lines" instead
3. Read questions/prompts immediately (higher priority)
4. Interrupt TTS when new user speech detected by STT
5. Skip messages already displayed if user is actively reading screen

### Why No VAD

VAD-gated STT (start recording on voice, stop on silence) loses words:
- First syllable often clipped before VAD triggers
- Trailing words lost if pause is too short
- Creates unnatural interaction timing

Always-listening STT avoids this entirely. The model handles silence naturally
(outputs nothing). Latency is lower since there's no VAD activation delay.

### Implementation Phases

**Phase 1: Chat UI (prerequisite)**
- Working message list, status indicators, question/answer flow
- Session picker, input area
- This must come FIRST; voice is a layer on top

**Phase 2: Mac Voice MVP**
- Capacitor native plugin (VoiceManager)
- Integrate YoozSTTEngine as Swift framework (always-on)
- Integrate mlx-audio-swift Kokoro for TTS
- Wire: voice toggle -> STT stream -> daemon -> response -> TTS -> playback

**Phase 3: iPhone Voice**
- Same Swift code, same frameworks
- Kokoro is lightweight enough for iPhone memory
- YoozSTTEngine supports iOS 17+

**Phase 4: Upgrade TTS (optional)**
- Add Qwen3-TTS support to mlx-audio-swift (or contribute upstream)
- Better voice quality, multi-language, voice cloning
- 4-bit quantization for iPhone (0.6B at ~300MB)

### Dependencies

| Package | Purpose | License |
|---------|---------|---------|
| YoozSTTEngine | STT inference (Swift, MLX-Swift) | Proprietary (yooz) |
| mlx-audio-swift | TTS inference (Swift, Kokoro) | MIT |
| Kokoro model weights | TTS model | MIT |

### Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| mlx-audio-swift maturity (41 stars) | Medium | Kokoro path is stable; contribute fixes upstream |
| Kokoro voice quality vs Qwen3-TTS | Low | Acceptable for MVP; upgrade path exists |
| iPhone memory (Kokoro) | Low | Kokoro is lightweight |
| Latency budget (STT+TTS) | Low | All in-process, all local; target <500ms |
| No SPM in mlx-audio-swift | Medium | Xcode project integration; may need to fork/add SPM |
