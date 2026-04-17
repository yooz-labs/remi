# Notification and Session Flow Architecture

Last updated: 2026-04-12 (verified against real logs and deployments)

## 1. Question Detection (Daemon Side)

Two sources detect questions from Claude Code:

```
Claude Code
  |
  |-- Hook Events (preferred, when hooks available)
  |     |
  |     |-- PermissionRequest hook
  |     |     (tool_name, tool_input, permission_suggestions?)
  |     |
  |     |-- Notification hook (permission_prompt type)
  |     |     (message with numbered options: "1) Yes\n2) Yes, always\n3) No")
  |     |
  |     v
  |   HookEventBridge (hook-event-bridge.ts)
  |     - Merges PermissionRequest + Notification into one Question
  |     - Calls: messageApi.handleQuestion(question)
  |
  |-- PTY Output Parsing (fallback, when hooks NOT available)
        |
        OutputProcessor (output-processor.ts)
          - Only fires onQuestion when !hookServer
          - Calls: messageApi.handleQuestion(question)
```

### HookEventBridge Merge Logic (PREVIOUS - fixed in PR #302)

```
PermissionRequest fires
  |
  +-- Has permission_suggestions (>= 2)?
  |     YES -> Emit immediately with multi-choice options
  |            Set lastImmediatePermissionAt = now
  |            (Later Notification suppressed via 2s dedup window)
  |
  |     NO  -> Start merge timer (1500ms)
  |            Save as pendingPermission
  |                |
  |                +-- Notification arrives BEFORE timer?
  |                |     -> Cancel timer
  |                |     -> Merge: PermissionRequest text + Notification options
  |                |     -> Emit merged question (CORRECT)
  |                |
  |                +-- Timer fires BEFORE Notification?
  |                      -> Emit Yes/No fallback (promptText has no numbered options)
  |                      -> Set lastFallbackPermissionAt = now
  |                      -> Clear pendingPermission
  |                      |
  |                      +-- Notification arrives within 3s of fallback?
  |                      |     -> SUPPRESSED (dedup window)
  |                      |     -> Options are LOST
  |                      |
  |                      +-- Notification arrives after 3s?
  |                            -> Emits as standalone question
  |                            -> DUPLICATE (different ID from fallback)
```

**BUG (fixed in PR #302)**: Two failure modes:
1. Timer fires first -> Yes/No fallback emitted -> Notification suppressed -> options LOST -> always Yes/No
2. Timer fires first -> Notification arrives late (>3s) -> BOTH questions emitted -> duplicate

## 2. Question Dispatch (Daemon Side)

```
messageApi.handleQuestion(question)
  |
  v
onQuestion callback (cli.ts:1666)
  |
  +-- Send WebSocket 'question' message to all connected clients
  |     (sendAndRecord)
  |
  +-- Send APNS push notification to ALL registered device tokens
        (sendPushTrigger -> signaling server -> APNS)
        Includes: category, opt_0..opt_N answer values
```

Dedup is handled at the HookEventBridge level (5s window per instance).
The bridge ensures only one question is emitted per permission prompt.

## 3. Client Receives Question

### Path A: WebSocket (in-app)

```
WebSocket 'question' message
  |
  v
App.tsx handleMessage case 'question' (line 344)
  |
  +-- Dedup check: q.id === lastQuestionIdRef.current?
  |     (FAILS for HookEventBridge duplicates because each has different generateId())
  |
  +-- Map to UIQuestion (determines type: yes_no, multi_option, numbered)
  |
  +-- setQuestions(map with sessionId -> UIQuestion)
  |
  +-- NO local notification (line 399: "Push (APNS) is the notification channel")
```

### Path B: APNS Push (lock screen / notification center)

```
APNS push notification
  |
  +-- App in BACKGROUND/SUSPENDED:
  |     iOS displays notification
  |     If category set + registered -> action buttons on long-press
  |     Categories: REMI_YN (Yes/No), REMI_YNA (Yes/Yes always/No), REMI_MULTI (4 options)
  |     Titles are HARDCODED in AppDelegate.swift (can't be dynamic per-notification)
  |
  +-- App in FOREGROUND:
        pushNotificationReceived fires
        PR #301: if suppressForegroundPush (WebSocket connected) -> skip
        Otherwise: re-create as local notification with actionTypeId
```

### Path C: Notification Action Button Tap

```
User taps action button on notification (lock screen or notification center)
  |
  +-- Push notification -> pushNotificationActionPerformed
  |     action.actionId = "OPT_0" / "OPT_1" etc.
  |     (Capacitor native: PushNotificationsHandler.swift maps
  |      response.actionIdentifier -> data["actionId"])
  |
  +-- Local notification -> localNotificationActionPerformed (PR #301)
  |     Same actionId extraction logic
  |
  v
Dispatch CustomEvent 'push-notification-answer'
  |
  v
App.tsx listener (line 854)
  - Finds connection for session
  - Sends createAnswer() via WebSocket
  - If not connected, tries to reconnect first
```

## 4. Session Identity and Restart

### Session Creation

```
remi daemon starts (or wraps Claude Code)
  |
  v
sessionId = generateId() (UUID)
  |
  v
Client connects -> hello_ack { sessionId, isResume }
  |
  v
Client stores sessionId, adds to sessions list
```

### Session Restart (Same Port, New Transcript)

```
Claude Code exits and restarts in same directory
  |
  v
New JSONL transcript file created (new UUID in filename)
  |
  v
Daemon creates new session entry with new sessionId
  |
  v
Sends hello_ack with NEW sessionId to connected clients
  |
  v
Client receives hello_ack (App.tsx:158)
  |
  +-- BEFORE PR #300:
  |     - Updates sessions list (removes old, adds new)
  |     - Stores new sessionId in localStorage
  |     - BUT: activeSessionId stays on OLD value
  |     - BUT: old messages stay in state
  |     - Result: sessionMessages filter shows OLD history
  |
  +-- AFTER PR #300:
        - Updates sessions list
        - Detects sessionId changed on same connectionId
        - Switches activeSessionId to new session
        - Clears old messages and questions
        - Result: clean slate for new session
```

## 5. Summary of Current Bugs and Fix Status

| Bug | Root Cause | Location | Fix Status |
|-----|-----------|----------|------------|
| Duplicate questions | HookEventBridge emits 2 questions with different IDs | daemon/hooks/hook-event-bridge.ts | FIXED (PR #302) |
| Always Yes/No | Timer fallback promptText has no numbered options | daemon/hooks/hook-event-bridge.ts | FIXED (PR #302) |
| No dedup on push | cli.ts onQuestion sends push for every call | daemon/cli.ts onQuestion | FIXED (PR #302, bridge-level dedup) |
| APNS buttons not showing | Signaling not deployed with category | signaling/src/index.ts | NOT DEPLOYED (deploy failed, last deploy Apr 10, category added Apr 12) |
| Session restart old history | hello_ack doesn't switch activeSessionId | web/src/App.tsx | FIXED (PR #300) |
| Foreground push duplicate | Push re-created as local when connected | web/src/lib/notifications.ts | PR #301 (low priority, APNS is the channel) |

## Real Log Evidence (from ~/.remi/)

### Duplicate questions (remi.log)
```
Question detected: Allow Bash: ssh hallu "cat > ~/git/eventformer/neu...  <- PermissionRequest path
Push notification sent for session 6d77b8c2...
Question detected: Allow Bash: ssh hallu "cat > ~/git/eventformer/neu...  <- Notification path
Push notification sent for session 6d77b8c2...
```
Same question text, but TWO "Question detected" entries, TWO push notifications.

### Standalone Notifications without PermissionRequest (remi.log)
```
Question detected: Claude needs your permission to use Bash...  <- standalone Notification
Push notification sent for session 6d77b8c2...
```
Different text from PermissionRequest path ("Claude needs..." vs "Allow Bash: ...").

### Hook event data (hook-debug.log)
```
PermissionRequest: tool=Bash, suggestions=undefined   <- no suggestions for Bash
PermissionRequest: tool=Edit, suggestions=["Yes","Always","No"]  <- Edit has suggestions
Notification(permission_prompt): message="Claude needs your permission to use Bash"  <- no numbered options
```

### Signaling deployment
Last deployed: 2026-04-10T22:36 UTC (before category support added on Apr 12).
Category support code exists in repo but is NOT live on worker.

## 6. Root Cause Confirmed from Real Logs

From `/Users/yahya/.remi/hook-debug.log` (2026-04-09):

**Bash permission (most common)**:
```
PermissionRequest: tool=Bash, suggestions=undefined
Notification(permission_prompt): message="Claude needs your permission to use Bash"
```
- No suggestions -> enters merge-wait path
- Notification message has NO numbered options (just descriptive text)
- `parseNumberedOptions` returns null -> falls back to Yes/No
- Result: ALWAYS Yes/No for Bash

**Edit permission (works correctly)**:
```
PermissionRequest: tool=Edit, suggestions=["Yes","Always","No"]
```
- Has 3 suggestions -> immediate emit with correct 3 options
- Subsequent Notification suppressed

**Key insight**: The Notification hook from Claude Code NEVER contains numbered
options (no "1) Yes\n2) Always\n3) No"). The entire merge-window approach of
"parse options from Notification message" is fundamentally broken.

Claude Code ALWAYS presents these options for tool permissions:
- Yes (allow this once)
- Yes, always (allow this tool for the session)  
- No (deny)

The numbered option text appears only in the TERMINAL UI, not in hook events.

## 7. Proposed Fix (Simplified)

### Approach: Always emit standard 3-option set for permissions

Drop the merge window entirely. For ALL PermissionRequest events:
1. If suggestions provided: use them (already works for Edit)
2. If no suggestions: emit immediately with default ["Yes", "Yes, always", "No"]
3. Suppress subsequent Notification for this permission (dedup window)

For standalone Notifications (no preceding PermissionRequest):
- Also emit with default ["Yes", "Yes, always", "No"] (don't parse message)

### Changes Made (PR #302)

**hook-event-bridge.ts:**
- Removed merge timer, pendingPermission, buildMergedQuestion, parseNumberedOptions import
- PermissionRequest: always emits immediately (suggestions or default 3-option set)
- Notification after recent emit: suppressed (5s dedup window with debug logging)

**cli.ts:**
- No dedup at this layer; bridge-level dedup is sufficient
- Avoids cross-session suppression issues from module-scoped state

### Why This Is Safe
- Claude Code permission prompts always offer Yes/Yes always/No
- The Notification message never has parseable options anyway
- Eliminates all timing-dependent behavior
- Eliminates duplicate questions (single emit point per bridge instance)
