# R5 daemon push context

The implementation work for #1200 is approved. These bounds describe the local
context and its source-daemon callers. Native, signed-device and deployed
acceptance remain separate gates.

The context class assigns a fresh system-random 32-byte instance at `begin`.
The CLI invokes this before constructing the message API or harness. It finishes
the runtime before failed-creation cleanup, session disposal or shutdown awaits.
Closing or replacing that runtime invalidates every captured context. The process admits at most 64
runtimes, 2048 recipient contexts in total, and 32 distinct logical notification
slots per runtime. A slot can fan out to the secure store's 64 recipients subject
to the global bound. Capacity refuses additional work; it never evicts a live
entry. Closed-runtime entries can be removed. Other entries remain for at least
3600 + 120 seconds after their latest revision; a still-registered question
retains its original expired ceiling so an identical redraw cannot renew it.

The context binds the current registered question, complete option meanings,
recipient subscription generation, launch instance, opaque random 16-byte
collapse identifier, revision and exact codec-produced content digest. A changed
meaning invalidates the previous object immediately and advances the revision.
Identical events retain their object, nonce and expiry. An actual Claude prompt
ID or Codex turn ID distinguishes separate turn-complete occurrences within the
same collapse slot; this internal occurrence ID is absent from the wire envelope.
Dismissals are absorbing
for that slot; a resolved question must use a new question identifier if asked
again. No signature digest is reconstructed from notification JSON.

Held deadlines are floored from the harness's captured milliseconds, never
recomputed from configuration. Untimed current prompts have a finite 3600-second
ceiling. The final callback rereads the actual registry and neutral harness
validity synchronously. Structured, set-mode, deprecated grants, unsupported
categories and oversize/truncated content produce bounded information without
actions. The signed inner envelope reserves 324 bytes beyond its payload for the
fixed metadata and 64-byte signature: the codec uses 2-byte LP lengths, with a
22-byte opaque collapse identifier. Options are preserved completely or omitted
as an actionable payload; they are never shortened into a different choice.

Question meaning is bounded to 64 KiB per context. Secure title/body construction
uses the full question text and detail before checking UTF8 budgets. The held-hook
bridge retains the complete selected tool argument in detail when its display
summary was shortened. A shortened legacy preview cannot establish an actionable
secure payload. Store and transport checks still independently enforce current
authorization, enrollment and subscription at the actual network invocation.
There is no claim that a request already invoked can be undone by later
revocation, or that APNs acceptance proves device delivery.

The CLI constructs the service only with relay opt-in, an unlocked stable machine
identity and a canonical HTTPS audience. It forwards the service to question,
notice, turn, foreign-session, harness-denied and subagent senders. Plaintext
compatibility separately requires `notifications.legacy_push_enabled = true`,
a configured secret and the monotonic secure-activation eligibility check.
Fixed diagnostic outcomes preserve `uncertain`; uncertain delivery is cached and
does not generate another nonce or settle a held permission.

Local source-CLI HTTPS acceptance at immutable 775215de passed on Bun 1.4.2 and
1.3.11 through a real Worker/SQLite instance and an owned APNs receiver. It used
synthetic identities and an executable synthetic Claude, without a model. Later
meaning/occurrence corrections have their own focused tests; the earlier CLI run
does not establish their exact-head acceptance. See the caller validation record.
