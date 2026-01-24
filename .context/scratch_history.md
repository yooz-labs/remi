# Remi Scratch History

## Purpose
Document failed attempts, dead ends, and lessons learned during development.

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
