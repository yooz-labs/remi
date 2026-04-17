# Remi Scratch History

## Purpose
Document failed attempts, dead ends, and lessons learned during development.

---

## CRITICAL: wss:// vs https:// — APNS push silently broken (fixed v0.4.22-dev.12)

**Symptom:** Push notifications never arrived. Daemon logged `Push notification failed: TypeError [ERR_INVALID_ARG_VALUE]: protocol must be http:, https: or s3:` on every attempt. Went unnoticed because the error was caught and logged but not surfaced to the user.

**Root cause:** The signaling URL is stored and passed as `wss://remi-signaling.yooz.workers.dev` (WebSocket protocol). `sendPushTrigger` passed it directly to `new URL(baseUrl).origin`, which preserves the `wss://` scheme. The resulting fetch URL was `wss://remi-signaling.yooz.workers.dev/push` — an invalid HTTP URL.

**Fix:** Normalize at the top of any function that makes HTTP calls using a signaling URL:
```typescript
const baseUrl = rawUrl.replace(/^wss:\/\//i, 'https://').replace(/^ws:\/\//i, 'http://');
```

**Rule:** The signaling URL is a WebSocket URL. Any code making HTTP calls to the signaling server MUST normalize the protocol first. Never assume the caller passes the right scheme.

---

## CRITICAL: WebCrypto ECDSA sign() returns raw r||s, NOT DER (fixed v0.4.22-dev.12)

**Symptom:** APNS returned `403 InvalidProviderToken` on every push attempt. JWT was being generated and sent but Apple rejected it.

**Root cause:** `crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, ...)` returns a **64-byte raw r||s signature** (IEEE P1363 format). The code assumed it returned DER-encoded output and applied a DER→raw conversion, corrupting the already-valid signature.

**Fix:** Use the signature bytes directly — no conversion needed:
```typescript
const encodedSignature = base64UrlEncode(new Uint8Array(signature));
```

**Rule:** Never apply DER conversion to WebCrypto ECDSA output. This applies to Bun AND Cloudflare Workers — both return raw 64-byte IEEE P1363 format per the W3C spec. DER output is a Node.js `crypto` (not SubtleCrypto) behavior.

---

## APNS TooManyProviderTokenUpdates (429) — JWT not cached (fixed v0.4.23-dev.3)

**Symptom:** Push notifications arriving only intermittently. Daemon log showed:
```
Push notification failed: Error: Push trigger failed: 502 {"success":false,"error":"APNS 429: {\"reason\":\"TooManyProviderTokenUpdates\"}"}
```

**Root cause:** `createApnsJwt()` in `packages/signaling/src/apns.ts` generated a fresh JWT on every single push request (`iat = Date.now()`). Apple rate-limits provider token updates to once per 20 minutes per key. Under normal Claude Code usage (frequent permission prompts), the limit is hit within minutes.

**Fix (PR #293):** Module-level JWT cache in `apns.ts` keyed by `keyId`. Reuse cached token if `< 3000s` (50 min) old; regenerate otherwise. Cloudflare Worker module scope persists within isolate lifetime so the cache survives across requests on the same worker instance.

**Rule:** APNS JWTs MUST be cached and reused. Never generate a new JWT per push request.

---

## Duplicate question messages in UI — merge window too narrow (fixed v0.4.23-dev.3)

**Symptom:** Two separate question entries appear in the chat UI for a single Claude Code permission prompt. One shows the generic tool context ("Allow Bash: `<cmd>`"), the other shows the actual numbered options.

**Root cause:** Two independent code paths in `HookEventBridge` can each emit a question:
1. `handlePermissionRequest` — fires when `PermissionRequest` hook arrives. If `permission_suggestions.length < 2`, sets a pending merge + starts a 200ms timer. On timer expiry, emits a fallback Yes/No question.
2. `handleNotification(permission_prompt)` — fires when the follow-up Notification arrives with full options text.

With a 200ms merge window, the Notification frequently arrived after the timer fired. The fallback question emitted at T=200ms, then the Notification arrived at T=250ms with no suppression guard, emitting a second question.

**Fix (PR #296):**
- Widened merge window from 200ms → 1500ms (covers the real-world gap between PermissionRequest and Notification)
- Added `lastFallbackPermissionAt` timestamp: after fallback fires, suppress any incoming `permission_prompt` Notification within `mergeWindowMs * 2` (3000ms)

**Architecture note:** Question emission paths in the daemon:
| Path | File | Guard |
|------|------|-------|
| PermissionRequest immediate (≥2 suggestions) | hook-event-bridge.ts:164 | Sets `lastImmediatePermissionAt`, 2s dedup |
| PermissionRequest fallback timer | hook-event-bridge.ts:181 | Sets `lastFallbackPermissionAt`, 3s dedup |
| Notification merged (pendingPermission exists) | hook-event-bridge.ts:92 | Clears timer, nulls pending |
| Notification standalone | hook-event-bridge.ts:105 | Checked against both timestamps |
| PTY output parsing | output-processor.ts | Disabled when `hookServer` active (`if (!hookServer)`) |
| TranscriptMessageBridge | transcript-message-bridge.ts | Never emits questions (text content only) |

**Known residual gap:** Device tokens are in-memory per daemon process. If a daemon restarts, it has no token until the app reconnects. Questions fired in the ~2-10s before app reconnection produce no push. Fix: persist tokens to `~/.remi/device-tokens.json`.

**Rule:** The merge window must be wide enough to cover the real Claude Code event gap (~200-500ms under normal conditions, longer under load). Always add a post-fallback suppression window to catch late-arriving Notifications.

---

## Lessons from Muxer (Swift iOS) Development

### Lesson: Terminal Parsing is Hard
**Date:** 2026-01-09 (from Muxer experience)
**Context:** Building Claude Code output parser

**Key Insights:**
1. ANSI escape codes are complex; don't reinvent the wheel
2. Claude output format can change; always have fallback
3. Deduplication is critical (screen refreshes cause duplicates)
4. tmux status bar creates noise; filter it out

**Applied to Remi:**
- Use xterm.js instead of custom parser
- Implement graceful degradation chain
- Port Muxer's deduplication logic

### Lesson: PTY I/O Race Conditions
**Date:** 2026-01-09 (from Muxer testing)
**Context:** Sending input to Claude via tmux

**Issue:** Sending text and newline separately caused race conditions.

**Root Cause:** PTY buffer could flush between writes.

**Solution (from Muxer):**
```swift
// Send text + newline as single write
channel.write(text + "\n")  // Works
// NOT: write(text); write("\n")  // Race condition
```

**Applied to Remi:**
- Bundle input text with newline in single write
- Use Bun's `terminal.write(text + "\n")`

---

## Common Pitfalls to Avoid

### Pitfall: Over-Engineering the Parser
**Symptoms:** Spending days on edge cases before basic flow works
**Solution:** Start simple, add patterns as needed

### Pitfall: Testing Against Stale Output
**Symptoms:** Parser works on samples but fails on live output
**Solution:** Always test with real Claude Code session

### Pitfall: Ignoring Mobile Constraints
**Symptoms:** Works in browser, breaks on iOS
**Solution:** Test on real device early and often

---

## Tools/Libraries to Avoid

### Tool: Custom ANSI Parser
**Why Avoided:** Too many edge cases, reinventing the wheel
**Use Instead:** xterm.js (production-proven)

### Tool: Socket.IO for Local-Only
**Why Avoided:** Overkill, unnecessary dependency
**Use Instead:** Plain WebSocket (Bun native)

### Tool: Electron for Mobile-First
**Why Avoided:** Desktop-only, 100MB+ bundle
**Use Instead:** Capacitor (cross-platform, mobile-first)

---

## Debugging Checklist

When things don't work, check:
- [ ] Is the WebSocket connected? (check network tab)
- [ ] Is the PTY spawning? (check daemon logs)
- [ ] Is output being received? (add logging to onData)
- [ ] Is parsing failing silently? (check for try/catch swallowing errors)
- [ ] Is deduplication too aggressive? (temporarily disable)
- [ ] Is the question pattern matching? (log raw output before parsing)

---

## Patterns to Remember

### Pattern: Graceful Degradation
```
Structured Parse → Clean Text → Raw Output → Never Crash
```

### Pattern: Single Write for Terminal Input
```
terminal.write(text + "\n")  // Correct
terminal.write(text); terminal.write("\n")  // Race condition
```

### Pattern: Hash-Based Deduplication
```typescript
const hash = hashContent(text);
if (seenHashes.has(hash)) return; // skip duplicate
seenHashes.add(hash);
```

---

## Future Investigation Needed

1. **Bun PTY stability:** Monitor for edge cases in v1.3.5
2. **Capacitor WebSocket in background:** Test on iOS with app backgrounded
3. **Question detection accuracy:** Track false positives/negatives
