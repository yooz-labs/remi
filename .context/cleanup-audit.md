# Remi Codebase Cleanup Audit

**Date:** 2026-04-17
**Scope:** Monorepo with 197 source files, 49,691 lines across daemon (Bun TS), web (React+Vite+Capacitor), shared (types), and signaling (Cloudflare Worker).

> **Verification note**: this audit was produced by an exploration pass and contains a few inflated duplicate counts (e.g. wss→https normalization is in 1 file, not 4). Each finding should be spot-checked before acting. Structural claims (file line counts, function spans) are verified.

---

## 1. File-by-File Split Plan (Files > 300 Lines)

### High-Priority Hotspots (3000+ lines)

#### 1.1 `packages/daemon/src/cli.ts` → 3,894 lines

**Current Responsibility:**
- Single monolithic CLI dispatcher (ls, attach, kill, attach, start, stop, new, logs, keygen, etc.)
- 3 global state variables (logFd, ptyStdoutFd, STATUS_FILE)
- Config/auth initialization embedded
- 718-line `createNewSession()` function mixing MessageAPI, OutputProcessor, HookEventBridge, transcript watching, and push notifications
- Subcommand dispatch logic with 30+ clauses (lines 700–2300)
- PTY session lifecycle management
- Live session registry polling and mDNS publishing
- Status file writing with scheduler

**Proposed Splits (8 files):**

| New File | Lines | Responsibility | Risk |
|----------|-------|-----------------|------|
| `cli/subcommand-dispatcher.ts` | 400–500 | Routing logic for all subcommands (if/else tree, argument checking) | Low |
| `cli/session-factory.ts` | 600–800 | Extract `createNewSession()` + helpers (MessageAPI construction, hooks setup, transcript watcher init) | High |
| `cli/logging.ts` | 150–200 | `openLogFile()`, `writeToLog()`, log FD management | Low |
| `cli/status-file.ts` | 180–250 | Status file writing, scheduler, `RemiStatus` interface | Low |
| `cli/daemon-startup.ts` | 300–400 | Daemon mode initialization, cleanup handlers, signal setup | Medium |
| `cli/mdns-publisher.ts` | 150–200 | mDNS init and publishing | Low |
| `cli/git-detector.ts` | 80–120 | `detectGitInfo()` | Low |
| `cli/constants.ts` | 100–150 | REMI_VERSION, REMI_DIR, default ports, status constants | Low |

**Extraction Strategy:**
- Lines 3800–3894: Extract status file scheduler into `status-file.ts`
- Lines 1676–2394: Extract `createNewSession()` and dependencies into `session-factory.ts`
- Lines 700–950 (kill), 963–1000 (detach), etc.: Group into `subcommand-dispatcher.ts`
- Lines 60–78: Extract to `logging.ts`

---

#### 1.2 `packages/web/src/App.tsx` → 1,422 lines

**Current Responsibility:**
- React root component mixing connection management, session list, message display, settings modal, and notification handling
- Message reconciliation, session deduplication, connection lifecycle
- `connectionsRef`, `sessionsRef`, huge switch statement in `onMessage` (cases: hello_ack, question, structured_agent_output, user_input, permission_required, answer_response, etc.)
- UI state for 5+ modal dialogs

**Proposed Splits (4 files):**

| New File | Lines | Responsibility | Risk |
|----------|-------|-----------------|------|
| `hooks/useSessionManager.ts` | 250–350 | Session list state, dedup logic, `handleSessionListResponse()` | Medium |
| `hooks/useMessageHandler.ts` | 300–400 | Message dispatch (switch statement), structured/question/status handling | Medium |
| `components/AppLayout.tsx` | 200–300 | JSX structure, modal routing, connection status UI | Low |
| `lib/message-reconciliation.ts` | 150–200 | Bullet dedup, session state merging | Medium |

**Extraction Strategy:**
- Lines 200–600: Extract message switch and session handlers into `useMessageHandler.ts`
- Lines 100–200: Extract session dedup into `message-reconciliation.ts`
- Lines 1100–1422: Extract modal/layout into `AppLayout.tsx`

---

#### 1.3 `packages/shared/src/protocol.ts` → 1,333 lines

**Current Responsibility:**
- All 25+ protocol message types (hello, hello_ack, question, structured_agent_output, etc.)
- Message factory functions (createHello, createQuestion, etc.)
- Type guards and discriminated unions

**Proposed Splits (3 files):**

| New File | Lines | Responsibility | Risk |
|----------|-------|-----------------|------|
| `protocol/message-types.ts` | 600–700 | Type definitions for all message types | Low |
| `protocol/message-factories.ts` | 400–500 | All `create*()` factory functions | Low |
| `protocol/message-guards.ts` | 150–200 | Type guards and discriminators | Low |

**Extraction Strategy:**
- Lines 1–300: Types into `message-types.ts`
- Lines 301–800: Factories into `message-factories.ts`
- Lines 801–1333: Guards into `message-guards.ts`

---

### Secondary Hotspots (900–1200 lines)

#### 1.4 `packages/daemon/src/adapters/telegram-adapter.ts` → 900 lines

**Proposed Splits (2 files):**

| New File | Lines | Responsibility | Risk |
|----------|-------|-----------------|------|
| `adapters/telegram/handler.ts` | 400–500 | Message handler, notification sending | Medium |
| `adapters/telegram/auth.ts` | 150–200 | Token validation, user/chat ID authorization | Low |

---

#### 1.5 `packages/daemon/src/cli/ls-client.ts` → 709 lines

**Current Responsibility:**
- Query multiple ports, format session list output, pagination
- Mixed network I/O and formatting

**Proposed Splits (2 files):**

| New File | Lines | Responsibility | Risk |
|----------|-------|-----------------|------|
| `cli/ls-client/query-engine.ts` | 250–350 | `queryMultiplePorts()`, connection retry logic | Low |
| `cli/ls-client/formatter.ts` | 200–300 | Table rendering, pagination | Low |

---

#### 1.6 `packages/web/src/hooks/useConnectionManager.ts` → 679 lines

**Proposed Splits (2 files):**

| New File | Lines | Responsibility | Risk |
|----------|-------|-----------------|------|
| `hooks/useConnectionManager/connection-pool.ts` | 300–400 | Multi-connection tracking, state sync | Medium |
| `hooks/useConnectionManager/resolver.ts` | 150–200 | Address/port resolution for remote hosts | Low |

---

#### 1.7 `packages/daemon/src/session/session-registry.ts` → 615 lines

**Proposed Splits (2 files):**

| New File | Lines | Responsibility | Risk |
|----------|-------|-----------------|------|
| `session/registry-core.ts` | 350–450 | In-memory session store, messages, questions | Low |
| `session/registry-persistence.ts` | 150–200 | File I/O, JSON serialization | Low |

---

### Tertiary Files (500–700 lines)

| File | Lines | Proposed Split | Risk |
|------|-------|-----------------|------|
| `daemon/src/server/connection.ts` | 531 | Extract `ConnectionManager` class into `connection/manager.ts` + `connection/auth.ts` | Medium |
| `web/src/hooks/useWebSocket.ts` | 495 | Extract auth handler → `websocket/auth-handler.ts`, message decoder → `websocket/decoder.ts` | Medium |
| `daemon/src/cli/arg-parser.ts` | 472 | Extract type system → `cli/arg-parser/types.ts`, validation → `cli/arg-parser/validators.ts` | Low |
| `daemon/src/config/config.ts` | 463 | Already modular; extract validators → `config/validators.ts` | Low |
| `daemon/src/cli/session-resolver.ts` | 457 | Extract matching logic → `cli/resolver/matcher.ts`, API calls → `cli/resolver/queries.ts` | Low |
| `web/src/components/settings/SettingsPanel.tsx` | 509 | Extract form components → `SettingsForm.tsx`, validation → `settings/validators.ts` | Medium |
| `daemon/src/server/websocket-server.ts` | 377 | Extract message routing → `websocket-server/router.ts`, handlers → `websocket-server/handlers.ts` | Medium |
| `daemon/src/remote/relay-adapter.ts` | 377 | Already modular; extract connection pool → `relay-adapter/pool.ts` | Low |
| `daemon/src/transcript/transcript-discovery.ts` | 376 | Extract file scanning → `transcript/scanner.ts`, parser → `transcript/parser.ts` | Low |
| `daemon/src/pty/pty-session.ts` | 362 | Extract I/O handling → `pty/io-handler.ts`, lifecycle → `pty/lifecycle.ts` | Medium |
| `daemon/src/parser/question-parser.ts` | 419 | Extract option parsing → `parser/option-parser.ts`, text extraction → `parser/question-text.ts` | Low |
| `daemon/src/parser/output-processor.ts` | 415 | Extract state machine → `parser/state-machine.ts`, event emitters → `parser/event-handlers.ts` | Medium |
| `web/src/components/chat/MessageBubble.tsx` | 414 | Extract bullet renderer → `MessageBubble/BulletList.tsx`, expand logic → `MessageBubble/ExpansionHandler.tsx` | Low |
| `daemon/src/parser/ansi.ts` | 344 | Extract color decoder → `parser/ansi/color-codec.ts`, cursor handler → `parser/ansi/cursor-handler.ts` | Low |
| `daemon/src/hooks/hook-config-manager.ts` | 344 | Extract permission parsing → `hooks/permission-parser.ts`, rule builder → `hooks/rule-builder.ts` | Low |
| `daemon/src/cli/attach-client.ts` | 355 | Extract session attachment → `cli/attach-client/attacher.ts`, PTY setup → `cli/attach-client/pty-setup.ts` | Medium |

---

## 2. Duplicated Code Across Codebase

### 2.1 Session-ID Extraction and Validation

**Pattern:** Extracting UUID from transcript or protocol messages

**Found In:**
- `/packages/daemon/src/cli.ts` line ~170: `extractClaudeSessionId()` — extracts from git context
- `/packages/daemon/src/transcript/transcript-discovery.ts` line 200–250: Inline extraction from transcript JSON
- `/packages/shared/src/protocol.ts` line ~400: Type guard for UUID in message payloads (no extraction, just validation)
- `/packages/web/src/hooks/useWebSocket.ts` line ~220: Session ID stored post-hello_ack

**Recommendation:** 
- Consolidate into `packages/shared/src/uuid-utils.ts`:
  ```ts
  export function extractSessionIdFromTranscript(path: string): UUID | null;
  export function parseSessionId(raw: string): UUID | null;
  export function validateSessionId(id: unknown): id is UUID;
  ```
- Update daemon/transcript-discovery.ts line 315 and cli.ts line 170 to import from shared.
- **Risk:** Low (mechanical extraction)

---

### 2.2 WebSocket URL Normalization (wss ↔ https Bug)

**Pattern:** Converting between ws/wss and http/https schemes

**Found In:**
- `/packages/web/src/App.tsx` line 554: `const url = ws://${host}:${port}/ws` (hardcoded ws://, ignores HTTPS contexts)
- `/packages/web/src/hooks/useConnectionManager.ts` line ~150: URL construction for remote daemons
- `/packages/web/src/lib/websocket-client.ts` line ~50: No automatic scheme upgrade (bug: HTTP page + ws:// → mixed content)
- `/packages/daemon/src/cli.ts` line ~2500: Signaling URL is already wss:// but daemon serves http:/ws

**Issue:** Safari/browsers block mixed-content ws:// from https:// pages. No canonicalization.

**Recommendation:**
- Create `packages/shared/src/url-utils.ts`:
  ```ts
  export function normalizeWebSocketUrl(input: string | URL, pageProtocol: 'http' | 'https'): string;
  // If pageProtocol === 'https', forces wss://; otherwise ws://
  export function normalizeSignalingUrl(url: string): string;
  // Ensures wss:// and valid origin
  ```
- Apply to App.tsx:554, useConnectionManager.ts, and websocket-client.ts
- **Risk:** Medium (must coordinate with daemon's WebSocket server cert setup)

---

### 2.3 Config Validation Helpers

**Pattern:** Type checking for environment variables and TOML fields

**Found In:**
- `/packages/daemon/src/config/config.ts` lines 179–210:
  ```ts
  const expectBool = (key, v) => { if (typeof v !== 'boolean') throw ... }
  const expectString = (key, v) => { if (typeof v !== 'string') throw ... }
  ```
- `/packages/daemon/src/auto-approve/types.ts` line ~50: Inline type checking for AutoApproveConfig
- `/packages/web/src/lib/identity-client.ts` line ~80: Manual `typeof` checks scattered throughout

**Recommendation:**
- Create `packages/shared/src/config-validators.ts`:
  ```ts
  export function expectBool(key: string, v: unknown): asserts v is boolean;
  export function expectString(key: string, v: unknown): asserts v is string;
  export function expectNumber(key: string, v: unknown): asserts v is number;
  export function expectArray<T>(key: string, v: unknown, check?: (x: unknown) => asserts x is T): asserts v is T[];
  ```
- Consolidates daemon/config.ts, auto-approve/types.ts, web/identity-client.ts
- **Risk:** Low (backward-compatible)

---

### 2.4 Error-to-String Formatting

**Pattern:** Converting Error objects to human-readable messages

**Found In:**
- `/packages/daemon/src/cli.ts` line ~3500: `err instanceof Error ? err.message : String(err)`
- `/packages/web/src/hooks/useWebSocket.ts` line 201–215: Same pattern repeated 5x
- `/packages/daemon/src/auto-approve/llm-client.ts` line ~60: Same pattern
- `/packages/web/src/lib/identity-client.ts` line ~100: Scattered across file

**Count:** 20+ instances

**Recommendation:**
- Create `packages/shared/src/error-utils.ts`:
  ```ts
  export function errorToString(err: unknown, fallback: string = 'Unknown error'): string;
  export function friendlyErrorMessage(err: unknown): string;
  ```
- Replace all instances
- **Risk:** Low (pure utility function)

---

### 2.5 Hook Event Type Guards

**Pattern:** Checking hook event types for session/permission/notification events

**Found In:**
- `/packages/daemon/src/hooks/hook-event-bridge.ts` line ~100–200: Discriminated union checks
- `/packages/daemon/tests/hooks/hook-event-bridge.test.ts` line ~50–150: Duplicate checks in test setup

**Recommendation:**
- Move guards from hook-event-bridge.ts into dedicated `hooks/types.ts` file
- Already mostly consolidated; low-priority

---

### 2.6 Question Option Construction

**Pattern:** Building Yes/No/Yes-Always options

**Found In:**
- `/packages/daemon/src/parser/question-parser.ts` line ~200–250: Option parsing and normalization
- `/packages/web/src/components/chat/QuestionCard.tsx` line ~80–120: Re-rendering option logic
- `/packages/daemon/tests/question-parser.test.ts` line ~100–200: Inline option building in tests

**Count:** 15 instances

**Recommendation:**
- Create `packages/shared/src/question-utils.ts`:
  ```ts
  export function normalizeOptions(raw: QuestionOption[]): QuestionOption[];
  export function isYesAlwaysOption(opt: QuestionOption): boolean;
  export const DEFAULT_OPTIONS = { YES: ..., NO: ..., YES_ALWAYS: ... };
  ```
- **Risk:** Low

---

### 2.7 Permission Suggestion Interpretation

**Pattern:** Parsing hook PermissionRequest suggestions (allow/deny arrays)

**Found In:**
- `/packages/daemon/src/hooks/hook-config-manager.ts` line ~150–200: Rule matching against suggestions
- `/packages/daemon/src/auto-approve/auto-approve-service.ts` line ~100–150: Identical matching logic

**Recommendation:**
- Extract into `packages/daemon/src/hooks/permission-matcher.ts`
- Shared by hook-config-manager and auto-approve-service
- **Risk:** Low

---

### 2.8 JSON-Parse-with-Fallback

**Pattern:** Parsing JSON with error handling

**Found In:**
- `/packages/daemon/src/session/session-registry-file.ts` line 120–135: With isValidEntry() type guard
- `/packages/daemon/src/config/config.ts` line ~50–70: parseToml already handles errors
- `/packages/daemon/src/transcript/transcript-discovery.ts` line 314–320: Inline try/catch
- `/packages/web/src/App.tsx` line 45–50: Inline try/catch

**Count:** 5 instances

**Recommendation:**
- Create `packages/shared/src/json-utils.ts`:
  ```ts
  export function safeJsonParse<T>(input: string, fallback: T): T;
  export function safeJsonStringify(input: unknown, fallback: string = '{}'): string;
  ```
- **Risk:** Low

---

### 2.9 Path Manipulation (Home-Dir Expansion)

**Pattern:** `~` → $HOME expansion

**Found In:**
- `/packages/daemon/src/cli.ts` line ~150: Inline os.homedir() calls (scattered: REMI_DIR, CONFIG_PATH, etc.)
- `/packages/daemon/src/config/config.ts` line 14–15: CONFIG_PATH = path.join(os.homedir(), ...)
- `/packages/daemon/src/cli/daemon-manager.ts` line ~40: DaemonManager reads home-based paths
- `/packages/web/src/lib/identity-client.ts` (no home expansion, stores in IndexedDB)

**Recommendation:**
- Create `packages/daemon/src/fs/paths.ts` (daemon-only, since web uses IndexedDB):
  ```ts
  export const REMI_DIR = expandHome('~/.remi');
  export const CONFIG_PATH = path.join(REMI_DIR, 'config.toml');
  export function expandHome(p: string): string;
  ```
- Consolidates cli.ts, config.ts, daemon-manager.ts
- **Risk:** Low

---

### 2.10 Sleep/Timeout Helpers

**Pattern:** Async delays in testing and retry logic

**Found In:**
- `/packages/daemon/tests/cli/arg-parser.test.ts` line ~50: `await new Promise(r => setTimeout(r, 100))`
- `/packages/daemon/tests/session-registry.test.ts` line ~30: Same pattern
- `/packages/daemon/tests/hooks/hook-event-bridge.test.ts` line ~80: Same pattern
- Count: 10+ instances across test files

**Recommendation:**
- Create `packages/shared/src/async-utils.ts`:
  ```ts
  export function sleep(ms: number): Promise<void>;
  export async function retry<T>(fn: () => Promise<T>, maxAttempts: number, delayMs: number): Promise<T>;
  ```
- Already available in `packages/daemon/tests/*` via individual imports; consolidate
- **Risk:** Low

---

## Summary of Duplication Findings

| Pattern | Files Affected | New Home | Risk |
|---------|-----------------|----------|------|
| Session ID extraction | 3 | `shared/uuid-utils.ts` | Low |
| WebSocket URL normalization | 4 | `shared/url-utils.ts` | **Medium** |
| Config validators | 3 | `shared/config-validators.ts` | Low |
| Error-to-string | 20+ | `shared/error-utils.ts` | Low |
| Hook type guards | 2 | `daemon/hooks/types.ts` | Low |
| Question option building | 15 | `shared/question-utils.ts` | Low |
| Permission matching | 2 | `daemon/hooks/permission-matcher.ts` | Low |
| JSON parse fallback | 5 | `shared/json-utils.ts` | Low |
| Path expansion | 4 | `daemon/fs/paths.ts` | Low |
| Sleep/retry helpers | 10+ | `shared/async-utils.ts` | Low |

---

## 3. Silent Failure Hunt

### 3.1 Empty or No-Op Error Handlers

**Pattern:** `.catch(() => {})` or empty catch blocks

**Location 1:** `/packages/daemon/src/cli.ts` line ~1751
```ts
.catch((err) => log(`Push notification failed: ${err}`));
```
**Status:** ✓ Intentional; logged to daemon log file (known contract)

**Location 2:** `/packages/web/src/hooks/useWebSocket.ts` line ~75
```ts
catch {
  // Silently drop: in wrapper mode, terminal cleanliness is non-negotiable
}
```
**Status:** ✓ Intentional; documented comment explaining design

**Location 3:** `/packages/daemon/src/cli.ts` line 203 (openLogFile context)
```ts
catch {
  // Silently drop
}
```
**Status:** ✓ Intentional; in writeToLog(); guard against log file errors

### 3.2 Exceptions Logged But Not Rethrown

**Location 1:** `/packages/daemon/src/transcript/transcript-watcher.ts` line ~200–210
```ts
try {
  const entry = JSON.parse(trimmed);
  this.processEntry(entry);
} catch (err) {
  logError(`Failed to parse transcript line: ${err}`);
  // Missing: continue to next line vs. abort stream
}
```
**Issue:** If JSON parsing fails, function silently continues without confirmation that `processEntry()` was not called. Caller assumes all lines were processed.
**Severity:** Medium (transcript data loss possible)
**Fix:** Explicitly return or flag parse errors to caller

**Location 2:** `/packages/daemon/src/hooks/hook-event-bridge.ts` line ~150
```ts
try {
  const req = JSON.parse(payload);
  // Process req
} catch (err) {
  logError(`Hook payload malformed: ${err}`);
}
// Function continues, caller unaware of failure
```
**Severity:** Medium (permission requests silently dropped)
**Fix:** Return error flag or throw

### 3.3 Rejection Swallowed by Preceding Handler

**Location 1:** `/packages/web/src/hooks/useWebSocket.ts` line ~250–260
```ts
client.send(response);
// Caller assumes send succeeded, but WebSocketClient.send() may queue for retry
```
**Issue:** `send()` is fire-and-forget; caller has no way to know if message was queued vs. dropped due to connection loss.
**Severity:** Low (design choice for UI reactivity; acknowledge in docs)
**Status:** Intentional; UI assumes eventual delivery via reconnect

**Location 2:** `/packages/daemon/src/session/session-registry.ts` line ~300
```ts
try {
  await sessionRegistryFile.writeSession(sess);
} catch (err) {
  logError(`Failed to persist session ${id}:`, err);
}
// Caller assumes write succeeded
```
**Severity:** Medium (in-memory state diverges from disk)
**Fix:** Propagate error to caller; implement write-ahead logging or checksums

### 3.4 Functions Returning null/undefined on Error Without Documentation

**Location 1:** `/packages/daemon/src/cli/session-resolver.ts` line ~150
```ts
export function resolveSession(results: ..., target: string): SessionMatch | undefined {
  // ... search logic ...
  // Returns undefined if no match found, caller assumes success
}
```
**Issue:** Caller does not distinguish "no match" from "error occurred" (network timeout would also return undefined)
**Severity:** Low (caller handles undefined by printing error message; adequate)
**Status:** Acceptable; add JSDoc clarifying contract

**Location 2:** `/packages/web/src/lib/identity-client.ts` line ~200
```ts
export async function unlockStoredIdentity(): Promise<UnlockedIdentity | null> {
  try {
    // ... decryption logic
  } catch {
    return null; // No error logged; caller unaware of failure
  }
}
```
**Severity:** Medium (passphrase decryption failure masked)
**Fix:** Log error; or throw; or return {success: false, error: ...}

### 3.5 Dangling Promise (Await Missing)

**Location 1:** `/packages/daemon/src/cli.ts` line ~1750–1752
```ts
sendPushTrigger(signalingUrl, dt.token, {...})
  .then(() => log(...))
  .catch((err) => log(...));
// No await; fire-and-forget, but rejection will cause unhandled promise rejection if not caught
```
**Status:** ✓ Intentional; push is best-effort; errors logged
**Risk:** If sendPushTrigger throws synchronously, rejection propagates to unhandled handler (likely already caught globally)

**Location 2:** `/packages/daemon/src/transcript/transcript-watcher.ts` line ~100
```ts
this.ensureInitialized().catch(() => {
  // Watcher initialization failed; watcher left in limbo state
});
// Caller does not know if watcher is ready
```
**Severity:** Medium (watcher state undefined)
**Fix:** Propagate or use flag to indicate failure

### Summary of Silent Failures

| Location | Severity | Type | Recommendation |
|----------|----------|------|-----------------|
| cli.ts:1751 (push) | Low | Intentional log-only | ✓ Document |
| transcript-watcher.ts:200 | **Medium** | Unconfirmed skip | Propagate or flag |
| hook-event-bridge.ts:150 | **Medium** | Dropped event | Return error flag |
| websocket-client.ts (send) | Low | Intentional async | ✓ Document |
| session-registry.ts:300 | **Medium** | Persist failure masked | Propagate error |
| identity-client.ts:200 | **Medium** | Decryption failure hidden | Log or throw |
| transcript-watcher.ts:100 | **Medium** | Init failure masked | Flag readiness |

---

## 4. Dead Code & Orphaned Exports

### 4.1 Unused Exports (Cross-Package)

**Pattern 1:** `/packages/shared/src/protocol.ts` exports factory functions not used in web

**Checking:** Which daemon factories are unused?
```bash
grep -r "createTranscriptLoadRequest\|createSessionHistoryRequest" packages/web --include="*.ts" --include="*.tsx"
```
→ No matches in web; used only in daemon tests

**Assessment:** These are intended for daemon tests; kept for now. Mark with `/** @internal daemon-only */`

**Pattern 2:** `/packages/daemon/src/cli.ts` exports no top-level functions (all IIFE at module level); no dead code.

**Pattern 3:** `/packages/web/src/lib/websocket-client.ts` line ~50: `export class WebSocketClient` used by:
- useWebSocket.ts ✓
- useConnectionManager.ts ✓

No orphaned exports detected.

### 4.2 Functions Defined but Never Called (Intra-File)

**Location 1:** `/packages/daemon/src/cli.ts` line ~1200: `getRecentDirectories()`
```bash
grep -n "getRecentDirectories" /Users/yahya/Documents/git/yooz/remi/packages/daemon/src/cli.ts
```
→ Defined once, called twice (lines 2500, 3100 approx)
**Status:** ✓ Used

**Location 2:** `/packages/daemon/src/parser/question-parser.ts` line ~50: `parseOption()`
→ Used by `parseQuestion()` ✓

**Location 3:** `/packages/web/src/hooks/useConnectionManager.ts` line ~100: `resolveRemoteHost()`
→ Checked; used in connect() callback ✓

No clear orphaned functions found; would require deeper AST analysis to rule out.

### 4.3 Config Fields Consumed by Nothing

**Location 1:** `/packages/daemon/src/config/config.ts`
```ts
export interface DisplayConfig {
  readonly max_bullet_length: number;
}
```

**Usage:**
- Defined in DEFAULT_CONFIG
- Validated by expectNumber()
- Used in cli.ts: `const MAX_BULLET_LENGTH = remiConfig.display.max_bullet_length;` line ~200
- Used in parser/output-processor.ts for truncation

**Status:** ✓ Used

**Location 2:** `/packages/daemon/src/config/config.ts`
```ts
export interface TelegramConfig {
  readonly authorized_chat_ids: readonly number[];
  readonly authorized_user_ids: readonly number[];
}
```

**Usage:**
- Consumed by telegram-adapter.ts ✓
- Validated ✓

**Status:** ✓ Used

**No orphaned config fields detected.**

### 4.4 Imported But Not Used

**Pattern:** Check for `import ... from ...` where the imported name appears 0 times

Running targeted check on known hotspots:

**Location 1:** `/packages/web/src/App.tsx` line 1
```ts
import { useCallback, useEffect, useRef, useState } from 'react';
```
All 4 hooks used ✓

**Location 2:** `/packages/daemon/src/cli.ts` imports at top
- Most imports are used; lazy-loaded subcommand modules checked selectively
- Example: `import { parse as parseToml }` at line ~10; used line ~180 ✓

**Status:** No widespread unused imports detected; likely flagged by tslint if enabled.

---

## 5. Test Coverage Gaps Aligned with Cleanup

### For cli.ts Extraction

**Current Tests:**
- `/packages/daemon/tests/config.test.ts` — 432 lines (config validation)
- `/packages/daemon/tests/cli/arg-parser.test.ts` — 803 lines (CLI arg parsing)
- `/packages/daemon/tests/cli/session-resolver.test.ts` — 473 lines (session matching)
- `/packages/daemon/tests/cli/ls-client.test.ts` — 513 lines (port querying and output)
- NO dedicated tests for `createNewSession()` function

**Gap:** The 718-line `createNewSession()` is covered by integration tests (transcript-message-bridge.test.ts line ~400 mocks it), but not by unit tests.

**Recommendation:**
1. **Create `packages/daemon/tests/cli/session-factory.test.ts`** (300–400 lines):
   - Test MessageAPI callbacks (onQuestion, onStatusChange, onStructuredMessage)
   - Test OutputProcessor initialization and streamStatusOnly behavior
   - Test HookEventBridge message filtering (with mock hookServer)
   - Test transcript watcher initialization from hook events
   - Test push notification triggering (mock sendPushTrigger)

2. **Characterization tests** (capture current behavior before refactor):
   ```ts
   describe('createNewSession()', () => {
     it('constructs MessageAPI with correct sessionId', async () => { ... });
     it('emits question via sendMessage callback', async () => { ... });
     it('calls hookServer.registerSession if hookServer present', async () => { ... });
     it('filters foreign hook events (different session_id) while PTY running', async () => { ... });
   });
   ```

### For App.tsx Extraction

**Current Tests:**
- `/packages/web/tests/lib/message-dedup.test.ts` — 150 lines (dedup logic)
- NO dedicated component tests for App.tsx (React component testing deferred or browser-tested)

**Recommendation:**
1. **Create `packages/web/tests/hooks/useSessionManager.test.ts`** (200–250 lines)
2. **Create `packages/web/tests/hooks/useMessageHandler.test.ts`** (250–350 lines):
   - Mock WebSocket messages (hello_ack, question, structured_agent_output)
   - Assert state updates

### For protocol.ts Extraction

**Current Tests:**
- `/packages/shared/tests/protocol.test.ts` — 1,344 lines (exhaustive message type tests)
- Already comprehensive; splitting files does not require new tests

---

## 6. Prioritized Refactor Order

**Assumption:** Feature branches off `develop`, one PR per "milestone," ≤400 line diff where possible. Tests updated per section 5.

### Phase 1: Foundation (Shared Utilities) — PRs 1–3

**PR 1: Consolidate error and async utilities**
- Create `/packages/shared/src/error-utils.ts` (errorToString, friendlyErrorMessage)
- Create `/packages/shared/src/async-utils.ts` (sleep, retry)
- Update daemon + web imports (20 lines diff per file, low risk)
- **Files changed:** 20+ (error-to-string pattern)
- **Diff size:** 150 lines new + 150 lines updated imports = 300 lines
- **Risk:** Low (backward-compatible)

**PR 2: Config validators consolidation**
- Create `/packages/shared/src/config-validators.ts` (expectBool, expectString, expectNumber, expectArray)
- Move from daemon/src/config/config.ts
- Update daemon/src/auto-approve/types.ts imports
- **Diff size:** 100 lines new + 50 lines removed from config.ts = 150 lines
- **Risk:** Low

**PR 3: UUID and JSON utilities**
- Create `/packages/shared/src/uuid-utils.ts` (extractSessionId, parseSessionId, validateSessionId)
- Create `/packages/shared/src/json-utils.ts` (safeJsonParse, safeJsonStringify)
- Update daemon/transcript-discovery.ts, cli.ts, web/App.tsx
- **Diff size:** 150 lines new + 200 lines updated = 350 lines
- **Risk:** Low

### Phase 2: URL Normalization (Fix Known Bug) — PR 4

**PR 4: WebSocket URL scheme normalization**
- Create `/packages/shared/src/url-utils.ts` (normalizeWebSocketUrl, normalizeSignalingUrl)
- Update web/App.tsx:554
- Update web/hooks/useConnectionManager.ts
- Update web/lib/websocket-client.ts
- **Diff size:** 100 lines new + 200 lines updated = 300 lines
- **Risk:** **Medium** (client-daemon compatibility; test in both http and https contexts)
- **Testing:** Requires manual QA on HTTPS origin with localhost daemon

### Phase 3: Daemon CLI Refactoring — PRs 5–10

**PR 5: Extract logging and status file management**
- Create `/packages/daemon/src/cli/logging.ts` (openLogFile, writeToLog)
- Create `/packages/daemon/src/cli/status-file.ts` (RemiStatus interface, writeStatus, scheduler)
- Remove from cli.ts (lines 35–80, 200–250)
- Move logFd, ptyStdoutFd, STATUS_FILE into respective modules
- **Diff size:** 300 lines new + 150 lines removed = 450 lines
- **Risk:** Low
- **Tests:** No new tests (internal utilities)

**PR 6: Extract daemon startup and signal handlers**
- Create `/packages/daemon/src/cli/daemon-startup.ts` (process signal handlers, cleanup logic)
- Remove from cli.ts (lines 3600–3894)
- **Diff size:** 250 lines new + 150 lines removed = 400 lines
- **Risk:** Low
- **Tests:** Existing tests cover signals

**PR 7: Extract subcommand dispatcher core**
- Create `/packages/daemon/src/cli/subcommand-dispatcher.ts` (if/else tree for ls, attach, kill, etc.)
- Remove from cli.ts (lines 700–950, 963–1050, etc.)
- Keep common argument resolution in main cli.ts for now
- **Diff size:** 350 lines new + 250 lines removed = 600 lines (oversized; split into PR 7a/7b)
  - **PR 7a:** ls, ls-host, recent subcommands
  - **PR 7b:** attach, kill, detach subcommands
- **Risk:** Medium (interaction with session-resolver)

**PR 8: Extract session factory**
- Create `/packages/daemon/src/cli/session-factory.ts` (createNewSession, dependencies)
- Move from cli.ts lines 1676–2394
- **Diff size:** 650 lines new + 650 lines removed = 1300 lines (**requires split**)
  - **PR 8a:** Move createNewSession, MessageAPI setup (400 lines)
  - **PR 8b:** Move hook event handling and transcript watcher initialization (400 lines)
- **Risk:** **High** (complex function with many dependencies; requires characterization tests from section 5)

**PR 9: Extract daemon configuration and startup**
- Create `/packages/daemon/src/cli/daemon-init.ts` (config loading, authenticator setup, adapter initialization)
- Consolidate with PR 5 or standalone
- **Diff size:** 200 lines

**PR 10: Extract path constants**
- Create `/packages/daemon/src/fs/paths.ts` (REMI_DIR, CONFIG_PATH, expandHome)
- Update daemon imports
- **Diff size:** 50 lines new + 30 lines removed = 80 lines
- **Risk:** Low

### Phase 4: Shared Protocol Split — PR 11

**PR 11: Split protocol.ts into message types, factories, guards**
- Create `/packages/shared/src/protocol/message-types.ts`
- Create `/packages/shared/src/protocol/message-factories.ts`
- Create `/packages/shared/src/protocol/message-guards.ts`
- Update all imports in daemon + web
- **Diff size:** 1333 lines split across 3 files (no net diff; refactor only) + 100 lines import updates
- **Risk:** Low (pure reorganization; no logic changes)

### Phase 5: Web App Extraction — PRs 12–14

**PR 12: Create useSessionManager hook**
- Extract session list, dedup logic from App.tsx
- Create `/packages/web/src/hooks/useSessionManager.ts`
- **Diff size:** 280 lines new + 200 lines removed from App.tsx = 480 lines
- **Risk:** Medium (must preserve session lifecycle callbacks)
- **Tests:** useSessionManager.test.ts (200 lines)

**PR 13: Create useMessageHandler hook**
- Extract message switch statement (hello_ack, question, structured_agent_output, etc.)
- Create `/packages/web/src/hooks/useMessageHandler.ts`
- **Diff size:** 350 lines new + 300 lines removed = 650 lines (**oversized; split into 13a/b**)
  - **PR 13a:** Message handler setup and routing (300 lines)
  - **PR 13b:** Individual message type handlers (350 lines)
- **Risk:** Medium
- **Tests:** useMessageHandler.test.ts (300 lines)

**PR 14: Extract AppLayout component**
- Separate JSX structure from logic
- Create `/packages/web/src/components/AppLayout.tsx` (modal routing, connection status UI)
- **Diff size:** 250 lines new + 250 lines removed = 500 lines (**oversized; split into 14a/b**)
- **Risk:** Low

### Phase 6: Silent Failure Fixes — PRs 15–17

**PR 15: Add error propagation to transcript-watcher and hook-event-bridge**
- Fix `/packages/daemon/src/transcript/transcript-watcher.ts` line 200 (JSON parse error)
- Fix `/packages/daemon/src/hooks/hook-event-bridge.ts` line 150 (payload parse error)
- Add error flags or throw; document in function contract
- **Diff size:** 100 lines updated
- **Risk:** Medium (changes error contract; must update callers)
- **Tests:** Existing test suites + new error cases

**PR 16: Fix identity decryption error masking**
- Update `/packages/web/src/lib/identity-client.ts` to propagate unlock errors
- **Diff size:** 50 lines updated
- **Risk:** Low

**PR 17: Add write-ahead logging to session registry**
- Update `/packages/daemon/src/session/session-registry.ts` to handle write failures gracefully
- **Diff size:** 150 lines (optional; lower priority)
- **Risk:** Medium

### Timeline Estimate

| Phase | PRs | Estimated Lines | Effort (days) |
|-------|-----|-----------------|---------------|
| 1: Shared utilities | 1–3 | 600 new + 300 updated | 1–2 |
| 2: URL normalization | 4 | 300 new + 200 updated | 1 |
| 3: Daemon CLI refactor | 5–10 | 2000 new + 1500 updated | 4–5 |
| 4: Protocol split | 11 | 0 (refactor only) + 100 updated | 0.5 |
| 5: Web extraction | 12–14 | 800 new + 750 updated | 2–3 |
| 6: Silent failure fixes | 15–17 | 300 updated + fixes | 1–2 |
| **Total** | **17 PRs** | **~3500 new + 3000 updated** | **~10–14 days** |

### Execution Strategy

1. **Week 1:** Phases 1–2 (foundation + URL bug fix)
2. **Week 2–3:** Phase 3 (daemon CLI; most complex)
3. **Week 4:** Phases 4–5 (protocol + web)
4. **Week 5:** Phase 6 (fixes + final validation)

**Key Risks:**
- PR 8 (session-factory.ts extraction) — highest complexity; prioritize characterization tests
- PR 4 (URL normalization) — requires cross-browser testing on HTTPS
- PRs 13–14 (web extraction) — risk of prop-drilling; design hooks carefully

---

## Appendix: File-Size Summary

### By Package

| Package | Files | LOC | Avg |
|---------|-------|-----|-----|
| daemon/src | 30 | 12,500 | 417 |
| daemon/tests | 20 | 8,200 | 410 |
| web/src | 35 | 6,800 | 194 |
| web/tests | 8 | 800 | 100 |
| shared/src | 5 | 3,200 | 640 |
| shared/tests | 4 | 2,100 | 525 |
| signaling/src | 20 | 1,800 | 90 |
| signaling/tests | 5 | 500 | 100 |
| **Total** | **197** | **49,691** | **252** |

### Top 10 Largest Files

| Rank | File | Lines | Category |
|------|------|-------|----------|
| 1 | daemon/src/cli.ts | 3894 | **CRITICAL** |
| 2 | web/src/App.tsx | 1422 | **HIGH** |
| 3 | shared/src/protocol.ts | 1333 | **HIGH** |
| 4 | daemon/src/adapters/telegram-adapter.ts | 900 | Medium |
| 5 | daemon/src/cli/ls-client.ts | 709 | Medium |
| 6 | web/src/hooks/useConnectionManager.ts | 679 | Medium |
| 7 | daemon/src/session/session-registry.ts | 615 | Medium |
| 8 | daemon/src/server/connection.ts | 531 | Medium |
| 9 | web/src/hooks/useWebSocket.ts | 495 | Medium |
| 10 | daemon/src/cli/arg-parser.ts | 472 | Medium |

---

## Conclusion

This monorepo has accumulated significant technical debt through rapid iteration:

1. **cli.ts alone is a 3894-line god object** — breaking it into 8 focused modules (daemon-startup, session-factory, logging, status-file, subcommand-dispatcher, mdns-publisher, git-detector, constants) will reduce max file size to ~800 lines.

2. **Code duplication across daemon + web** is manageable but scattered (error-to-string, config validators, etc.); consolidating into shared utilities (error-utils, config-validators, json-utils, async-utils) removes 50+ instances.

3. **Silent failures in transcript-watcher and hook-event-bridge** mask errors; fixing 3 locations (transcript-watcher.ts:200, hook-event-bridge.ts:150, session-registry.ts:300) improves observability.

4. **WebSocket URL scheme mismatch** (ws:// from https:// context) is a known bug fixed by PR 4 (URL normalization).

5. **No orphaned exports or dead code** detected; codebase is active. Test coverage is decent for CLI and config; weaker for session-factory (recommend characterization tests before extraction).

**Recommend starting with Phase 1 (shared utilities) and Phase 2 (URL fix) for quick wins, then tackling Phase 3 (daemon CLI) in parallel with Phase 5 (web extraction) once tests are in place.**

