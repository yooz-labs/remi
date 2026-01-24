# Streaming Messages: Progressive Enhancement via PTY + Transcript

## Overview

**Feature:** Combine PTY-streamed bullets with transcript-derived authoritative content
**Branch:** `feature/streaming-messages`
**Goal:** Client sees output immediately (PTY streaming), then content is refined once the transcript entry is written

### Problem Statement

Currently, Remi has two independent sources of Claude Code output:

1. **PTY OutputProcessor** - Real-time terminal output, parsed into bullets. Fast but rough (contains terminal artifacts, possibly incomplete parsing, truncated by terminal width).
2. **TranscriptWatcher** - Reads Claude Code's JSONL transcript file. Clean, authoritative content, but arrives with a delay (written after the API response completes).

These two sources are disconnected. The PTY stream goes to clients in real-time; the transcript is logged but not used for client updates.

### Solution: Progressive Enhancement Pattern

```
Time ───────────────────────────────────────────────────────────────>

PTY stream:   [bullet1] [bullet2] [bullet3]  (rough, real-time)
                                                 |
Transcript:                                      v entry written
                                          [clean text content]
                                                 |
Client sees:  [bullet1] [bullet2] [bullet3]      v
              ────── replaced by ──────> [clean, structured content]
```

---

## Architecture

### Current Data Flow

```
PTY -> OutputProcessor -> MessageAPI -> StructuredAgentOutput -> Client
                                         (bullets)

TranscriptWatcher -> onAssistantMessage -> console.log (unused)
```

### Proposed Data Flow

```
PTY -> OutputProcessor -> MessageAPI -> StructuredAgentOutput -> Client
                                         (streaming phase)        |
                                                                   |
TranscriptWatcher -> StreamingCoordinator ─────────────────────    |
                        |                                          |
                        v                                          v
              MessageRefinement -> message_refine protocol -> Client
                  (replaces bullets with transcript content)
```

### New Component: StreamingCoordinator

The `StreamingCoordinator` sits between the TranscriptWatcher and MessageAPI. It:
1. Tracks which PTY message is currently "in progress" (actively streaming)
2. When a transcript assistant entry arrives, correlates it with the active/recent PTY message
3. Emits a "refine" event that replaces the rough PTY content with clean transcript content
4. Re-structures the refined content through BulletEngine for consistent bullet IDs

---

## Detailed Design

### Phase Detection: How to Know a Message is "Complete"

A PTY message is considered complete when one of these occurs:

1. **Transcript entry appears** - An `AssistantEntry` is written to the JSONL file. This is the primary signal. The entry contains the full, clean text of the response.

2. **Status changes to "idle" or "waiting"** - OutputProcessor detects Claude has stopped outputting. This is a secondary signal; the transcript entry is more reliable.

3. **New agent message boundary detected** - OutputProcessor sees a new `agent` boundary marker, meaning the previous message is done.

4. **Question detected** - A question indicates the current response is complete and Claude is waiting for input.

**Primary mechanism:** The TranscriptWatcher's `onAssistantMessage` event is the authoritative signal that a complete response is available.

### Correlation: Matching PTY Messages to Transcript Entries

The challenge is matching a PTY-streamed message (which has a Remi-generated UUID) with a transcript entry (which has Claude Code's own UUID and structured content).

**Strategy: Temporal + Content Correlation**

Since Claude Code writes transcript entries sequentially after each response:
1. Maintain an ordered list of active/recent PTY message IDs
2. When a new `AssistantEntry` arrives, match it to the most recent unrefined PTY message
3. Use content similarity as a validation check (first 50 chars of text content vs first PTY bullet)

**Correlation state machine per session:**

```
States:
  - IDLE: No active streaming message
  - STREAMING: PTY is actively outputting (currentMessageId set)
  - AWAITING_TRANSCRIPT: PTY message finalized, waiting for transcript entry
  - REFINING: Transcript entry matched, sending refinement to client

Transitions:
  IDLE -> STREAMING: OutputProcessor emits onMessage
  STREAMING -> STREAMING: OutputProcessor emits onMessageUpdate
  STREAMING -> AWAITING_TRANSCRIPT: OutputProcessor finalizes message (boundary/flush)
  AWAITING_TRANSCRIPT -> REFINING: TranscriptWatcher emits onAssistantMessage
  REFINING -> IDLE: Refinement sent to client
  STREAMING -> REFINING: TranscriptWatcher emits while still streaming (fast response)
```

### Protocol Changes

#### New Message Type: `message_refine`

```typescript
/** Refinement of a previously-streamed message with authoritative content */
export interface MessageRefineMessage {
  readonly type: 'message_refine';
  readonly id: UUID;
  readonly timestamp: Timestamp;
  /** The original message ID being refined */
  readonly originalMessageId: UUID;
  /** The refined structured message (replaces the original) */
  readonly message: StructuredMessage;
  /** Source of the refined content */
  readonly source: 'transcript';
  /** UUID of the transcript entry this came from */
  readonly transcriptEntryId?: string;
  /** Whether this completely replaces the streamed content */
  readonly isComplete: boolean;
}
```

**Why a new message type (vs reusing `structured_agent_output` with `isUpdate: true`)?**
- Semantic clarity: clients know this is a refinement, not a progressive update
- Can handle differently in UI (e.g., smooth transition vs append)
- Carries metadata about the source (transcript UUID)
- `isComplete` flag tells client whether to expect more refinements

#### Updated ProtocolMessage Union

Add `MessageRefineMessage` to the `ProtocolMessage` discriminated union in `protocol.ts`.

#### Factory Function

```typescript
export function createMessageRefine(
  originalMessageId: UUID,
  message: StructuredMessage,
  transcriptEntryId?: string,
): MessageRefineMessage;
```

### Content Extraction from Transcript

The `AssistantEntry` contains structured content blocks:
- `TextBlock` - The actual response text
- `ThinkingBlock` - Internal reasoning (skip)
- `ToolUseBlock` - Tool invocations (include as metadata)
- `ToolResultBlock` - Tool results (skip for main content)

**Extraction logic:**
1. Filter to `TextBlock` entries only (for the main message content)
2. Join text blocks with newlines
3. Run through BulletEngine to get structured bullets
4. For tool use blocks, annotate the message with tool metadata

### Handling Tool Use Messages

Claude Code responses often interleave text and tool use:
```
[text] -> [tool_use: Read] -> [tool_result] -> [text] -> [tool_use: Edit] -> ...
```

Each of these appears as separate PTY messages (each tool gets its own message boundary marker). The transcript entry contains ALL of them in one entry.

**Strategy:**
- During streaming, each tool invocation is a separate PTY message (current behavior)
- On refinement, map the transcript's text blocks to the most recent text-only PTY message
- Tool-use PTY messages are NOT refined (they are ephemeral status indicators)
- Only the final text output of the assistant is refined

**Refinement targets:**
- Only refine PTY messages where `message.tool === undefined` (pure text output)
- Skip refining tool execution status messages (Read, Bash, Edit, etc.)
- If the transcript has multiple text blocks, the last text block corresponds to the last text-only PTY message

### Multi-turn Correlation

A single Claude Code response can produce multiple PTY messages (due to tool interleaving):
```
PTY messages:  [text1] [Bash(...)] [text2] [Read(...)] [text3]
Transcript:    One AssistantEntry with content blocks for all of the above
```

**Strategy:**
- Track a "response group" -- all PTY messages between user inputs
- When transcript entry arrives, refine only the text-only messages in the group
- Each text block in the transcript corresponds to a text-only PTY message (in order)

### Edge Cases

#### 1. Long Messages (Multiple Text Blocks)

If a response has multiple text blocks separated by tool use:
- Match text blocks to PTY messages by order
- If count mismatch, refine only what matches and leave the rest

#### 2. Thinking Blocks

- Thinking content appears in the transcript but NOT in PTY output (filtered)
- Skip thinking blocks entirely during refinement

#### 3. Fast Responses (Transcript Before PTY Finishes)

- Unlikely but possible if transcript polling catches up fast
- If transcript arrives while still STREAMING, wait for PTY to finalize first
- Use a small delay (100ms) after last PTY update before applying refinement

#### 4. No Transcript Available

- If transcript file not found or watcher fails, gracefully degrade
- PTY messages remain as-is (current behavior)
- No refinement, no errors; just log a warning

#### 5. Empty Transcript Text

- If all content blocks are tool_use/thinking (no text blocks), skip refinement
- The PTY messages stand as the authoritative content

#### 6. Session Resume

- On resume, replay messages should use their already-refined state
- Refinement only applies to live streaming, not replayed history

#### 7. Streamed Content is Better Than Transcript

- In rare cases, PTY might capture content the transcript misses (unlikely)
- Always prefer transcript content when available; it is the source of truth

#### 8. Bullet ID Stability

When refining, bullet IDs may change because the content is different:
- The refined message gets new bullet IDs starting from where the original started
- Use `updateStructuredMessage` pattern from BulletEngine
- Client should treat `message_refine` as a full replacement, re-rendering the message

---

## Implementation Plan

### Step 1: Add `message_refine` Protocol Message

**Files:**
- `packages/shared/src/protocol.ts` - Add type, factory function, update union
- `packages/shared/src/types.ts` - No changes needed (reuses StructuredMessage)

**Tasks:**
- [ ] Define `MessageRefineMessage` interface
- [ ] Add to `ProtocolMessage` union type
- [ ] Add to `validTypes` array in `isValidMessage`
- [ ] Create `createMessageRefine` factory function
- [ ] Export from shared package

### Step 2: Create StreamingCoordinator

**Files:**
- `packages/daemon/src/streaming/streaming-coordinator.ts` (new)
- `packages/daemon/src/streaming/index.ts` (new)

**Tasks:**
- [ ] Define `StreamingCoordinatorConfig` interface
- [ ] Define `StreamingCoordinatorEvents` interface (onRefine callback)
- [ ] Define correlation state machine (IDLE/STREAMING/AWAITING_TRANSCRIPT/REFINING)
- [ ] Implement `handlePTYMessage(messageId, isNew)` method
- [ ] Implement `handlePTYMessageUpdate(messageId)` method
- [ ] Implement `handlePTYMessageFinalized(messageId)` method
- [ ] Implement `handleTranscriptEntry(entry: AssistantEntry)` method
- [ ] Implement content extraction (text blocks only)
- [ ] Implement temporal correlation logic
- [ ] Implement response group tracking (PTY messages between user inputs)
- [ ] Add content similarity validation
- [ ] Handle edge case: transcript arrives before PTY finishes
- [ ] Handle edge case: no text blocks in transcript

### Step 3: Integrate StreamingCoordinator into CLI

**Files:**
- `packages/daemon/src/cli.ts` - Wire coordinator between TranscriptWatcher and MessageAPI

**Tasks:**
- [ ] Create StreamingCoordinator per session (alongside MessageAPI)
- [ ] Connect OutputProcessor events to coordinator (onMessage, onMessageUpdate, onMessageFinalized)
- [ ] Connect TranscriptWatcher onAssistantMessage to coordinator
- [ ] Connect coordinator's onRefine event to send `message_refine` to client
- [ ] Ensure refinement messages are recorded in session history for replay

### Step 4: Update Client Protocol Handling

**Files:**
- `packages/app/src/` - Client-side handling (if app exists)

**Tasks:**
- [ ] Handle `message_refine` message type in protocol handler
- [ ] Replace existing message content with refined content
- [ ] Re-render message with new bullets
- [ ] Smooth visual transition (optional, can be follow-up)

### Step 5: Testing

**Tasks:**
- [ ] Test StreamingCoordinator state machine transitions
- [ ] Test content extraction from AssistantEntry
- [ ] Test temporal correlation (matching PTY message to transcript)
- [ ] Test multi-tool-use response handling
- [ ] Test edge case: fast response (transcript before PTY done)
- [ ] Test edge case: no transcript available (graceful degradation)
- [ ] Test bullet ID stability across refinement
- [ ] Integration test: full flow from PTY output to client refinement

---

## File Structure After Implementation

```
packages/daemon/src/
  streaming/
    index.ts                    # Exports
    streaming-coordinator.ts    # StreamingCoordinator class
  api/
    message-api.ts              # (unchanged)
    bullet-content-registry.ts  # (unchanged)
  parser/
    output-processor.ts         # (unchanged)
    ...
  transcript/
    transcript-watcher.ts       # (unchanged)
    ...
  cli.ts                        # Updated: wires coordinator
```

---

## Success Criteria

1. Client receives PTY-streamed bullets in real-time (no regression in latency)
2. Within ~2 seconds of Claude Code finishing a response, client receives a `message_refine` with clean transcript content
3. Refined content has proper bullet structure (consistent with BulletEngine output)
4. Tool-execution messages (Read, Bash, Edit, etc.) are NOT refined (they remain as-is)
5. If transcript is unavailable, system degrades gracefully (PTY-only, current behavior)
6. Session resume replays refined messages correctly
7. No duplicate content shown to client during refinement transition

---

## Open Questions

1. **Should refinement be opt-in?** Could add a `streaming.refineFromTranscript` config option. Default: enabled.

2. **How to handle very long responses?** A single AssistantEntry might map to 10+ PTY messages. Refine all text-only ones, or just the last?

3. **Should we send a "refining" status?** Client could show a subtle indicator while waiting for transcript. Probably not worth the complexity for MVP.

4. **What about sidechains?** Transcript entries have `isSidechain` flag. These are branched explorations. For now, skip sidechain entries for refinement.

5. **Latency budget:** TranscriptWatcher polls every 1-2 seconds. Is this fast enough? Could reduce to 500ms for the first few seconds after PTY message finalization.

---

## Dependencies

- No new external packages required
- Uses existing BulletEngine for re-structuring refined content
- Uses existing TranscriptWatcher infrastructure
- Uses existing MessageAPI pattern for bullet tracking

---

## Risks

| Risk | Severity | Mitigation |
|------|----------|------------|
| Transcript file written late (> 5s) | Low | Timeout after 10s, skip refinement |
| Content mismatch (PTY vs transcript) | Low | Validate with similarity check; skip if too different |
| Bullet ID confusion on client | Medium | Client treats refine as full replacement |
| Race condition: multiple rapid responses | Medium | Queue refinements, process sequentially |
| Transcript format changes | Low | Graceful degradation; log and skip |
