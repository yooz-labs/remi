# R5 daemon push context

The implementation work for #1200 is approved. These bounds describe the new
local context implementation; they do not establish complete caller integration
or native/deployed acceptance.

The context class assigns a fresh system-random 32-byte instance at `begin`.
Its CLI caller must invoke this before constructing the message API or harness;
that caller integration is still pending at this checkpoint. Closing or replacing that
runtime invalidates every captured context. The process admits at most 64
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
Identical events retain their object, nonce and expiry. Dismissals are absorbing
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

Question meaning is bounded to 64 KiB per context. Push title/body are bounded in
UTF8 bytes. Store and transport checks still independently enforce current
authorization, enrollment and subscription at the actual network invocation.
There is no claim that a request already invoked can be undone by later
revocation, or that APNs acceptance proves device delivery.
