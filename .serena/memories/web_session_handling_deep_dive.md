# Remi Web App Session Handling - Comprehensive Deep Dive

## Overview
The Remi web app provides a React-based interface for monitoring and interacting with Claude Code sessions. Session handling spans:
1. **Session Discovery & Listing** - discovering sessions from daemon and transcripts
2. **Session UI Display** - session lists, session cards, switchers
3. **Session Selection & Switching** - active session tracking
4. **Recent Projects** - quick-start from recent directories
5. **Session Persistence** - localStorage state management

---

## 1. SESSION DISCOVERY & LISTING

### Protocol Messages
**SessionListRequestMessage** (in `packages/shared/src/protocol.ts`)
```typescript
export interface SessionListRequestMessage {
  readonly type: 'session_list_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly includeExternal?: boolean; // Include transcript sessions
}
```

**SessionListResponseMessage**
```typescript
export interface SessionListResponseMessage {
  readonly type: 'session_list_response';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly sessions: readonly DiscoverableSession[];
  readonly requestId: UUID;
}
```

### Daemon Side (cli.ts, line 1783)
Handler: `onSessionListRequest`

Process:
1. Get daemon-managed sessions: `sessionRegistry.listSessions()`
2. If `includeExternal=true`: add transcript-discovered sessions
3. Send `session_list_response` with all sessions

```typescript
onSessionListRequest: (connectionId, requestId, includeExternal) => {
  const daemonSessions = sessionRegistry.listSessions();
  let allSessions = [...daemonSessions];
  
  if (includeExternal) {
    const managedIds = new Set(sessionRegistry.getActiveSessionIds());
    const externalSessions = transcriptDiscovery.discoverSessions(managedIds);
    allSessions = [...daemonSessions, ...externalSessions];
  }
  
  sendToConnection(connectionId, createSessionListResponse(allSessions, requestId));
};
```

### DiscoverableSession Fields
(From shared types)
- `sessionId` - UUID
- `status` - 'active' | 'idle'
- `projectPath` - working directory
- `lastActivity` - ISO timestamp
- `messageCount` - total messages in session
- `lastMessage` - preview of last message
- `canAttach` - boolean (session has no active connection)
- `source` - 'daemon' | 'transcript'

### Web App Side (App.tsx, line 384)
Handler: `session_list_response`

Mapping to UISession:
```typescript
case 'session_list_response': {
  const discovered: UISession[] = message.sessions.map((ds) => ({
    id: ds.sessionId as UUID,
    name: ds.name || ds.projectPath.split('/').pop() || 'Session',
    createdAt: ds.lastActivity,
    lastActiveAt: ds.lastActivity,
    status: mapSessionStatus(ds.status),           // 'active' -> 'executing', 'idle' -> 'idle'
    connectionStatus: ds.canAttach ? 'connected' : 'disconnected',
    unreadCount: 0,
    cwd: ds.projectPath,
    preview: ds.lastMessage || `${ds.messageCount} messages`,
    source: ds.source,
  }));

  setSessions((prev) => {
    // Merge: keep existing, add new from discovery
    const existingIds = new Set(prev.map((s) => s.id));
    const newSessions = discovered.filter((s) => !existingIds.has(s.id));
    return [...prev, ...newSessions];
  });
};
```

---

## 2. SESSION UI COMPONENTS

### SessionList (components/session/SessionList.tsx)
Main sidebar component showing all sessions.

**Props:**
```typescript
interface SessionListProps {
  readonly sessions: readonly UISession[];
  readonly activeSessionId: UUID | null;
  readonly onSelectSession: (id: UUID) => void;
  readonly onNewSession?: (directory?: string) => void;
  readonly onConnect?: () => void;
  readonly onSettings?: () => void;
  readonly recentDirectories?: readonly RecentDirectory[];
}
```

**Features:**
- Empty state with "Connect to daemon" button
- SessionCard list (maps each session)
- RecentProjects component
- Floating "New session" button

### SessionCard (components/session/SessionCard.tsx)
Individual session display in the list.

**Shows:**
- Status dot (color/animation based on connection + agent status)
- Session name
- Last active timestamp (relative time)
- Preview text or status message
- Working directory (cwd)
- Unread count badge (9+ clamped)

**Status Dot Logic:**
1. Connection status takes priority:
   - `error` -> red
   - `disconnected` -> gray
   - `connecting/reconnecting` -> yellow (pulsing)
2. Then agent status when connected:
   - `thinking/executing` -> blue (pulsing)
   - `waiting` -> yellow
   - `idle` -> gray

### SessionSwitcher (components/chat/SessionSwitcher.tsx)
Slide-out drawer showing all sessions with quick-switch capability.

**Features:**
- Drawer animation (slide from left)
- Session count badge
- Summary bar: unread count + pending questions count
- Per-session info:
  - Status dot (same logic as SessionCard)
  - Session name
  - Last active time
  - Preview text
  - Question pending indicator (warning badge)
  - Unread count badge (clamped to 99+)
- Active session highlighted with blue left border

**Key Detail:** `totalUnread` and `totalQuestions` computed at render time:
```typescript
const totalUnread = sessions.reduce((sum, s) => sum + s.unreadCount, 0);
const totalQuestions = sessions.filter((s) => s.questionPending).length;
```

### RecentProjects (components/session/RecentProjects.tsx)
Shows recently-used project directories for quick-start.

**Input:**
```typescript
interface RecentProjectsProps {
  readonly directories: readonly RecentDirectory[];
  readonly onStartSession: (directory: string) => void;
}
```

**Features:**
- Shows top 5 directories (expands to show more)
- Per-directory display:
  - Folder icon
  - Display name (basename)
  - Age (e.g., "3m ago")
  - Session count
  - Play button (hidden until hover)
- "Show N more" toggle
- Custom directory input at bottom (Enter key or Start button)

---

## 3. SESSION PERSISTENCE & STATE MANAGEMENT

### App.tsx Session State
```typescript
// State
const [sessions, setSessions] = useState<UISession[]>([]);
const [activeSessionId, setActiveSessionId] = useState<UUID | null>(null);
const [showSessionSwitcher, setShowSessionSwitcher] = useState(false);
const [recentDirectories, setRecentDirectories] = useState<readonly RecentDirectory[]>([]);

// Refs
const activeSessionIdRef = useRef<UUID | null>(null);
const loadedTranscriptsRef = useRef<Set<string>>(new Set());
```

### localStorage Keys
```typescript
const LOCALSTORAGE_URL_KEY = 'remi-last-url';        // Last daemon URL
const LOCALSTORAGE_SESSION_KEY = 'remi-last-session'; // Last active session ID
const LOCALSTORAGE_SETTINGS_KEY = 'remi-settings';    // User settings (theme, font, etc.)
```

### Session Restoration on App Load
(App.tsx)
```typescript
// Restore session ID from localStorage for reconnect after page reload
const [storedSessionId] = useState<UUID | null>(() => {
  try {
    const stored = localStorage.getItem(LOCALSTORAGE_SESSION_KEY);
    return stored ? (JSON.parse(stored) as UUID) : null;
  } catch {
    return null;
  }
});
```

This is read once on mount to set `activeSessionId`.

### updateSessionActivity Function (App.tsx, line 86)
Updates a session's state when activity occurs:
```typescript
function updateSessionActivity(
  sessions: UISession[],
  sessionId: UUID,
  activeId: UUID | null,
  preview?: string,
): UISession[] {
  return sessions.map((s) =>
    s.id === sessionId
      ? {
          ...s,
          lastActiveAt: new Date().toISOString(),
          questionPending: false,  // Clear pending question indicator
          unreadCount: s.id === activeId ? s.unreadCount : s.unreadCount + 1,  // Increment if not active
          preview: preview?.slice(0, 80) || s.preview,  // Update preview
        }
      : s,
  );
}
```

---

## 4. RECENT DIRECTORIES / SESSION HISTORY

### SessionHistoryRequestMessage (protocol.ts)
```typescript
export interface SessionHistoryRequestMessage {
  readonly type: 'session_history_request';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  readonly limit?: number;
}
```

### RecentDirectory Type (protocol.ts)
```typescript
export interface RecentDirectory {
  readonly directory: string;        // Absolute path
  readonly lastUsed: Timestamp;      // ISO timestamp
  readonly sessionCount: number;     // Number of sessions in this directory
  readonly displayName: string;      // basename(directory)
}
```

### Daemon Side (cli.ts, line 1958)
Handler: `onSessionHistoryRequest`

Process:
```typescript
onSessionHistoryRequest: (connectionId, requestId, limit) => {
  const clampedLimit = Math.max(1, limit ?? 20);
  const directories = getRecentDirectories(sessionStore, clampedLimit);
  sendToConnection(connectionId, createSessionHistoryResponse(directories, requestId));
};
```

Implementation (line 1572):
```typescript
function getRecentDirectories(store: SessionStore, limit: number): RecentDirectory[] {
  const sessions = store.list();
  const dirMap = new Map<string, { count: number; lastUsed: string }>();

  // Aggregate sessions by directory
  for (const s of sessions) {
    const dir = s.projectPath;
    const existing = dirMap.get(dir);
    if (existing) {
      existing.count++;
      if (s.startedAt > existing.lastUsed) {
        existing.lastUsed = s.startedAt;
      }
    } else {
      dirMap.set(dir, { count: 1, lastUsed: s.startedAt });
    }
  }

  // Sort by last used (newest first), limit results
  const entries = Array.from(dirMap.entries())
    .map(([directory, { count, lastUsed }]) => ({
      directory,
      lastUsed,
      sessionCount: count,
      displayName: path.basename(directory),
    }))
    .sort((a, b) => (a.lastUsed > b.lastUsed ? -1 : 1))
    .slice(0, limit);

  return entries;
}
```

**Key:** Aggregates all session records from SessionStore, groups by directory, keeps newest timestamp per directory.

### Web App Side (App.tsx, line 408)
Handler: `session_history_response`

```typescript
case 'session_history_response': {
  setRecentDirectories([...message.directories]);
  break;
}
```

These are then passed to `RecentProjects` component via props.

---

## 5. SESSION SELECTION & SWITCHING

### handleSelectSession (App.tsx)
```typescript
const handleSelectSession = useCallback((sessionId: UUID) => {
  setActiveSessionId(sessionId);
  setShowSessionSwitcher(false);  // Close switcher
  localStorage.setItem(LOCALSTORAGE_SESSION_KEY, JSON.stringify(sessionId));
  // Load messages for this session
}, []);
```

### handleOpenSessions
Opens the SessionSwitcher drawer:
```typescript
const handleOpenSessions = useCallback(
  () => setShowSessionSwitcher(true),
  []
);

const handleCloseSessionSwitcher = useCallback(
  () => setShowSessionSwitcher(false),
  []
);
```

### handleBack
Returns from chat view to session list (mobile):
```typescript
const handleBack = useCallback(() => {
  setActiveSessionId(null);
}, []);
```

---

## 6. NEW SESSION CREATION

### handleConnectCode / handleConnectDirect
Initiate connections to daemon.

### handleNewSession (implied from props)
Triggers `onNewSession` callback which:
1. Sends `create_session_request` to daemon
2. Daemon creates new PTY session
3. Web app receives `create_session_response` with new `sessionId`
4. New session is auto-attached and loaded

### Session Creation Flow
```
Client: createCreateSessionRequest(directory)
  ↓
Daemon: onCreateSessionRequest handler (line 1864)
  - Resolves directory
  - Creates sessionId: sessionRegistry.createSessionId()
  - Spawns PTY: createNewSession()
  - Registers session: sessionRegistry.registerSession()
  - Attaches connection: sessionRegistry.attachConnection()
  - Sends createCreateSessionResponse(success, sessionId)
  ↓
Client: case 'create_session_response'
  - If success: add new session to state
  - Attach to new session
  - Load messages
```

---

## 7. MESSAGE DELIVERY & UPDATES

### Session Update Flow
As messages arrive from daemon:
1. **Per-message:** `updateSessionActivity()` bumps `lastActiveAt`, updates preview, increments unread count (if not active session)
2. **On question:** Sets `questionPending: true`
3. **On new message:** Sets `preview` to last output

### Unread Count Logic
- Incremented for each message on sessions that are NOT active
- Reset when switching to that session (via activity update)
- Also cleared when status updates occur

---

## 8. EXISTING SESSION-RELATED FEATURES

### What's Already Implemented
1. **Session Discovery** - list daemon + transcript sessions
2. **Session Selection** - switch between sessions (single active)
3. **Session Persistence** - last session ID to localStorage
4. **Session Status Display** - connection + agent status dots
5. **Session Preview** - last message preview per session
6. **Recent Projects** - quick-start from history
7. **Unread Count Tracking** - per-session message counts
8. **Question Pending Indicator** - marks session with pending question
9. **Session Metadata** - name, cwd, last activity, message count
10. **Multi-Source Sessions** - daemon + transcript sources in same list

### Session Limitations / Gaps
1. **No Session Grouping** - all sessions in flat list (no workspaces/projects)
2. **No Session Filtering/Search** - no way to filter sessions by name/path
3. **No Session Sorting Options** - fixed sort (discovery order)
4. **No Custom Session Labeling** - can't rename or tag sessions
5. **No Session Archiving** - no hide/delete from list
6. **No Session Sharing** - can't share session state between devices (except via transcript)
7. **No Session Sync** - no cross-device session sync
8. **No Favorites/Pinning** - can't pin frequently-used sessions to top
9. **No Session Statistics** - no time spent, message count history
10. **No Session Export** - no bulk export of session history
11. **No Multi-Tab Session Persistence** - localStorage only, single browser
12. **No Session Collaboration** - no real-time multi-user session viewing (except Telegram adapter)
13. **No Session Snapshot/Checkpoint** - can't save session state at a point in time
14. **No Session Diff** - can't compare session states across time
15. **No Session Restoration UI** - resuming sessions is automatic, no explicit UI

---

## 9. DATA FLOW DIAGRAM

```
┌─────────────────┐
│  Web App State  │
│  - sessions[]   │
│  - activeId     │
│  - messages[]   │
│  - recent[]     │
└────────┬────────┘
         │
         ├─ SessionList (displays sessions)
         │  └─ SessionCard (per session)
         │  └─ RecentProjects (quick-start)
         │
         ├─ SessionSwitcher (drawer)
         │  └─ Per-session buttons
         │
         └─ ChatView (active session)
            └─ MessageList
            └─ InputArea

Protocol:
  ┌──────────────────────────────────────┐
  │ session_list_request                 │
  │ session_history_request              │
  │ create_session_request               │
  └──────────────────────────────────────┘
           │                 ↑
           ↓                 │
  ┌──────────────────────────────────────┐
  │ Daemon (SessionRegistry + Stores)    │
  │ - listSessions()                     │
  │ - getRecentDirectories()             │
  │ - createSession()                    │
  └──────────────────────────────────────┘
           │
           └─ session_list_response
             session_history_response
             create_session_response
```

---

## 10. FILES INVOLVED

### Web App
- **App.tsx** - Main app state, message handling, session logic
- **SessionList.tsx** - Session list component
- **SessionCard.tsx** - Individual session card
- **SessionSwitcher.tsx** - Session drawer switcher
- **RecentProjects.tsx** - Recent directories component
- **types/index.ts** - UISession, UIMessage, etc. types
- **hooks/useWebSocket.ts** - WebSocket connection management

### Daemon
- **cli.ts** - Main event handlers, session requests
- **session/session-registry.ts** - Session lifecycle management
- **server/websocket-server.ts** - WebSocket server
- **server/connection.ts** - Connection state machine

### Shared
- **protocol.ts** - SessionListRequest/Response, SessionHistoryRequest/Response, etc.
- **types.ts** - DiscoverableSession, RecentDirectory types

