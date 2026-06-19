# Subagent permissions bypass auto-approve (#593)

## Symptom

In a session with parallel research subagents (project "give"), subagent
permission prompts (mostly WebFetch) appear but auto-approve never evaluates
them — no "evaluating" status, no auto-approve/escalate. The MAIN agent's
permissions evaluate normally. Another session forwarded 99 subagent
PermissionRequests fine, so it is intermittent / session-specific.

## Where it breaks (traced)

AA is hook-driven (Model B / #571). The path is:

`hook-server` (`PermissionRequest` -> `permissionResolver`) ->
`hook-bridge-setup.ts` `setPermissionResolver` callback (~1198) ->
`driveBinder.admits(input)` / `filterBySession(input)` (~1203) ->
`autoApproveGate.resolvePermission` (logs `Subagent PermissionRequest forwarded`).

The give session had **0** forwarded logs + **0** subagent AA evals for the
WebFetch burst, while the main-agent Skill permission evaluated. So subagent
PermissionRequests are **rejected at the `admits`/`filterBySession` gate (1203)
and return `passthrough`** — they never reach the gate. That drop was **silent**
(no log at 1203), which is why the cause was invisible.

## Root-cause hypotheses (to confirm with the new diagnostic)

1. **Session-id mismatch for parallel/async subagents.** `filterBySession`
   admits only when `input.session_id === claudeSessionId`. Sync subagents share
   the main session_id (admitted); a parallel/background subagent may carry its
   OWN session_id (or empty `00000000`, which we saw dropped) -> rejected as
   foreign. The give subagents were many parallel research agents.
2. **Startup / binding window.** During a hook-server port change + a
   transcript-binding timeout + self-heal, `driveBinder.currentBoundId` can be
   null or stale, or a lingering sibling registry entry makes `hasSiblingInDir()`
   true -> the fail-safe rejects events until the binding settles.

The main-agent Skill worked because it arrived after binding settled and carries
the main session_id; the subagent perms did not (different id and/or window).

## This PR (safe, certain): fail-loud diagnostic

`hook-bridge-setup.ts:1203` now LOGS every PermissionRequest it rejects to
`passthrough`, tagging `agent=subagent|main` and the incoming session_id. The
next occurrence will show exactly why a subagent permission was dropped
(`incoming=<subagent-id>` != bound id, or during the unbound window), turning an
invisible silent drop into a diagnosable line. No behavior change.

## Deferred (needs a confirmed repro; binder is high blast-radius)

The targeted fix depends on which hypothesis the diagnostic confirms:
- If session-id mismatch: admit a SUBAGENT PermissionRequest (agent_id present)
  when it owns the bound transcript (`input.transcript_path` is the MAIN
  transcript per #499 phase 3), even if `session_id` differs — rather than the
  strict `session_id === claudeSessionId` equality.
- If startup window: ensure the binding is adopted before the resolver admits,
  and/or buffer PermissionRequests briefly until `currentBoundId` is set.

Do NOT reintroduce a PTY-inject -> AA fallback for subagents: #496 removed it
because the daemon cannot tell whose prompt is on the PTY for parallel subagents
(the leak). Any PTY fallback would have to be eval-and-deny-only (no inject),
which does not help auto-APPROVE. The fix belongs in the routing, not the PTY.

## Repro

Spawn several parallel research subagents doing WebFetch to non-allowlisted
domains, especially right after session start / a daemon restart. Watch for the
new `PermissionRequest NOT admitted` lines with `agent=subagent`.
