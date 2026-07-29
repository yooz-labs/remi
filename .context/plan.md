# Plan

Current state, priorities, and the full backlog map live in
[handoff.md](handoff.md) (updated 2026-07-28).
Standing architecture decisions live in [decisions/](decisions/) as ADRs.
Historical journals live in [archive/](archive/).

## Where things stand (2026-07-28, end of day)

**Shipped today, all merged to `develop` (0.7.4-dev):** the security floor
(#536 allow/deny asymmetry, #535 origin policy), #543 relay encryption
*daemon side only, see below*, #872 macOS Ed25519 identity, #875 sealed
lock-screen answers, #869 part 1 (capability token). Public docs refreshed to
0.7.3 and live at `docs.yooz.live`; `remi.yooz.live` live. TestFlight build 10
uploaded for macOS and iOS.

**Open, in priority order:**

1. **#881 — the relay path is non-functional end to end.** #543 shipped the
   daemon half of the key exchange and no client half
   (`useConnectionManager.ts:213` never passes `relayKex`), so permanent-code
   mode rejects every real client and rotating-code mode refuses to send.
   *Latent, not live*: code-pairing is unreachable in the UI (`App.tsx` never
   passes `onConnectCode`, `mode: 'relay'` is never assigned). Fix it **with**
   whatever re-enables code-pairing, not before.
2. **#880 — `auth.enabled = "auto"` resolves to `false` on every bind**,
   including `0.0.0.0`. Documented, deliberately not fixed: changing the default
   alters how running daemons accept connections and is the owner's call. Gates
   #873, and makes #869/#875/#543 inert on a default install since each hangs
   off an authenticator that does not exist when auth is off.
3. **#883 — protocol-message fan-out**: 13 non-test files per message type, and
   a missed consumer fails silently.

**Two epics under exploration** (Fable architects, running as of 2026-07-28):

- *Hook contract + question lifecycle + real-time state.* Map Claude Code's hook
  contract as a durable artifact, rebuild the question lifecycle on it, then
  exploit it for thinking/tool-activity/subagent state. Subsumes
  [plan-eval-quality-and-question-lifecycle.md](plan-eval-quality-and-question-lifecycle.md),
  which carries the measured baseline: 309 escalations, ~92% LLM verdicts, top
  causes `rm -rf <build artifact>` (~48) and project file edits (~49).
- *Module contracts* (#883). Derived from seams that measurably hurt, never
  designed speculatively; every contract point needs a **two-sided** conformance
  test. Boundary: the first epic owns the lifecycle state machine, this one owns
  the declare/dispatch mechanism.

**Standing constraint from today:** transport encryption is scoped to the relay
only (ADR 0009). Direct, LAN, Tailscale, VPN and SSH-tunnel connections carry no
relay crypto and should not gain any.
