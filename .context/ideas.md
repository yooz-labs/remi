# Remi Design Ideas

## Purpose
Capture high-level concepts, design decisions, and architectural ideas for the Claude Code monitor.

---

## Core Concepts

### Project Vision
**Goal:** "My agent needs me. Yes or No." - The simplest, fastest way to respond to Claude Code from anywhere.

**Key Principles:**
1. **Local-first** - Code never leaves your machine
2. **Graceful degradation** - Always show something useful, even if parsing fails
3. **Fast iteration** - Web-first development for rapid prototyping
4. **Cross-platform** - Same experience on iOS, Android, web, desktop

### Mental Model
Think of Remi as "WhatsApp for your terminal agent":
- Each Claude session = a contact/chat
- Agent output = incoming messages
- Questions = messages needing reply
- Your responses = outgoing messages

---

## Architecture Ideas

### System Design
**Concept:** Two-component architecture with daemon and clients

**Components:**
- **Remi Daemon:** Local Bun process that spawns and monitors Claude Code
- **Remi Client:** Web/mobile app that connects via WebSocket

**Data Flow:**
1. User runs `remi claude "task"` or daemon wraps existing claude command
2. Daemon spawns Claude in PTY, captures all output
3. Output parsed into AgentEvents (messages, questions, status)
4. Events broadcast to all connected clients via WebSocket
5. Client displays as chat, user taps response
6. Response sent via WebSocket, daemon writes to PTY

**Trade-offs:**
- Pro: Simple, no server needed
- Pro: Privacy by default
- Pro: Fast (localhost only)
- Con: Requires daemon running on dev machine
- Con: Same-network only (no remote access)

### Alternative: tmux Integration Mode
**Concept:** Attach to existing Claude sessions running in tmux

**When useful:**
- Monitoring long-running sessions started elsewhere
- Don't want to change workflow (still run `claude` directly)

**Implementation:**
- Daemon discovers tmux sessions with Claude running
- Attaches to session PTY for reading
- Sends input via tmux send-keys

**Trade-offs:**
- Pro: Zero workflow change
- Con: More complex (tmux dependency)
- Con: Harder to test

**Decision:** Start with direct PTY spawn; add tmux mode later.

---

## Feature Ideas

### Feature: Chat Interface
**Concept:** WhatsApp-style message list with agent output
**User Value:** Familiar interface, easy to scan
**Implementation:**
- Messages scroll up
- Questions highlighted
- Status badges (thinking, executing)
- Timestamps
**Complexity:** Medium
**Priority:** Must-have (Phase 3)

### Feature: Quick Response Buttons
**Concept:** Yes/No/option buttons for common questions
**User Value:** One-tap response without typing
**Implementation:**
- Detect question type from Claude output
- Show appropriate buttons (Y/N, numbered options, free text)
- Send response on tap
**Complexity:** Medium
**Priority:** Must-have (Phase 3)

### Feature: Push Notifications
**Concept:** Get notified when Claude asks a question, even with app closed
**User Value:** Don't miss important decisions while away
**Implementation:**
- Daemon sends push via APNs (APNS bridge built in iOS Capacitor app)
- Always-push on question (WS local notification removed)
- Push-client in daemon sends to signaling server which forwards to device
- Notification shows question text
- Actionable lock-screen replies: future (#278)
**Status:** Infrastructure built and wired. End-to-end test on physical device pending (#286).
**Complexity:** High (done)
**Priority:** MVP-blocking

### Feature: Code Diff Gallery
**Concept:** Visual timeline of file changes during session
**User Value:** Review what Claude modified at a glance
**Implementation:**
- Parse tool calls for file edits
- Capture before/after content
- Display as swipeable cards with diff highlighting
**Complexity:** High
**Priority:** Future/Pro feature (Phase 6)

### Feature: Session History
**Concept:** Browse past sessions and their outputs
**User Value:** Reference previous work, debug issues
**Implementation:**
- Store session data in SQLite
- List view with search
- Detail view with full transcript
**Complexity:** Medium
**Priority:** Nice-to-have (Phase 6)

### Feature: Multi-Session Support
**Concept:** Monitor multiple Claude sessions simultaneously
**User Value:** Work on multiple projects at once
**Implementation:**
- Session list with active indicators
- Switch between sessions
- Aggregate notifications
**Complexity:** Medium
**Priority:** Nice-to-have (Phase 6)

---

## Design Patterns

### Pattern: Graceful Degradation
**Use Case:** Claude output format changes or parsing fails
**Benefits:** App never breaks, user always sees something
**Implementation:**
1. Try structured parsing (ClaudeProvider)
2. If fails, try clean text extraction (ANSI strip)
3. If fails, show raw terminal output
4. Never crash, always render

### Pattern: Event-Based Architecture
**Use Case:** Decoupling parsing from display
**Benefits:** Clean separation of concerns, testable
**Implementation:**
```typescript
type AgentEvent =
  | { type: 'message', content: string, timestamp: Date }
  | { type: 'question', text: string, options: Option[] }
  | { type: 'status', state: 'thinking' | 'executing' | 'waiting' }
  | { type: 'raw', content: string }  // fallback
```

### Pattern: Deduplication
**Use Case:** Claude output can repeat during screen refreshes
**Benefits:** Clean message list without spam
**Implementation:**
- Hash-based tracking of seen content
- Line-based diff for incremental updates
- Similarity threshold for near-duplicates
- Skip tmux status bar lines

---

## User Experience Ideas

### Workflow: Basic Session Monitoring
**Goal:** See what Claude is doing from phone
**Steps:**
1. Start Claude on laptop: `remi claude "build feature X"`
2. Open Remi app on phone
3. See chat interface with Claude output
4. When Claude asks question, tap Yes/No
5. Continue monitoring or put phone away

**Pain Points Addressed:**
- Can't carry laptop everywhere
- Miss questions while grabbing coffee
- Terminal not visible when away from desk

### Workflow: Quick Response from Lock Screen
**Goal:** Respond to Claude without unlocking phone
**Steps:**
1. Notification appears: "Claude asks: Apply changes? [Y/n]"
2. Tap "Yes" button on notification
3. Response sent, back to lock screen

**Pain Points Addressed:**
- Slow to unlock, open app, find session
- Simple questions need simple responses

### Workflow: Review Session While Commuting
**Goal:** Catch up on what Claude did
**Steps:**
1. Open Remi on transit
2. See session summary
3. Scroll through message history
4. View code diff gallery
5. Approve pending changes

**Pain Points Addressed:**
- Downtime during commute
- Need context on agent progress

---

## Technical Explorations

### Concept: tmux-less Session Persistence
**Hypothesis:** Can persist session without tmux by keeping daemon running
**Benefits:**
- No tmux dependency
- Simpler architecture
- Works on systems without tmux
**Risks:**
- Daemon crash loses session
- More state to manage
**Experiment:** Build Phase 1 without tmux, evaluate stability

### Concept: Hybrid Parsing Strategy
**Hypothesis:** Combine regex patterns with ML for better question detection
**Benefits:**
- Handle edge cases patterns miss
- Adapt to format changes
**Risks:**
- Complexity
- Bundle size
- Latency
**Experiment:** Defer to Phase 6; regex works well in Muxer

### Concept: Local-First with Optional Relay
**Hypothesis:** Add encrypted relay for remote access without breaking local-first
**Benefits:**
- Best of both worlds
- User choice
**Risks:**
- Complexity
- Security concerns
**Experiment:** MVP is local-only; relay is Phase 5+

---

## Future Possibilities

### Long-term Vision
- Voice interface for hands-free responses
- Watch app for wrist notifications
- IDE plugin for integrated monitoring
- Team features for shared sessions
- Analytics on agent patterns

### Stretch Goals
- Natural language override: "Skip that, do X instead"
- Session templates: "Start with my usual context"
- Cross-agent support: Gemini, Codex, custom agents
- Automated responses for routine questions

### Monetization Ideas
- **Free:** 1 session, basic features
- **Pro ($4.99/mo):** Unlimited sessions, history, diff gallery
- **Team ($9.99/user/mo):** Shared sessions, analytics
- **One-time ($14.99):** All Pro features forever

---

## UI/UX Inspiration

### Apps to Study
- **WhatsApp/iMessage:** Chat list, message bubbles, quick replies
- **GitHub Mobile:** Notification handling, action buttons
- **Slack:** Thread organization, notification management
- **Linear:** Clean, minimal UI with keyboard shortcuts

### Design Principles
- Minimal chrome, maximum content
- Dark mode by default (developers prefer it)
- High contrast for readability
- Haptic feedback for responses sent
- Skeleton loading states

### Color Palette Ideas
- Dark background: `#0D1117` (GitHub dark)
- Agent messages: `#1F2937` (gray bubble)
- User messages: `#2563EB` (blue bubble)
- Questions: `#F59E0B` (amber highlight)
- Success: `#10B981` (green)
- Error: `#EF4444` (red)
