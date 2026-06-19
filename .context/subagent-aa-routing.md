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

## The fix (implemented)

The drop is in the DRIVE-mode binder's `admits` (`transcript-binder.ts`), the
default path. A parallel/team subagent (or one with an empty `00000000` id)
fails the `session_id === currentBoundId` check and falls to the marker
head-read (`incomingReclaimsViaMarker`), which FAILED in give because the
transcript content/marker was not yet readable (binding still settling).

`admits` now adds a file-free ownership check BEFORE the marker read: a SUBAGENT
event (`agent_id` present) whose `transcript_path` equals the transcript we are
bound to (`lastTranscriptPath`) is admitted. The path comes from the hook event,
so no file content is read — robust to the marker-read delay that broke give. A
sibling daemon's subagent carries the SIBLING's transcript path, so it stays
foreign and cross-session isolation (#451) is preserved. Gated on `agent_id`, so
a real foreign MAIN event still requires the marker (no over-admit).

Also: `hook-bridge-setup.ts:1203` now LOGS every PermissionRequest it drops to
`passthrough` (tagged `agent=subagent|main`), so any future drop is diagnosable
instead of silent.

### Tests (real binder, NO MOCKS, no interactive repro)

`transcript-binder.test.ts` -> `#593 subagent admits`:
- subagent with a DIFFERENT session_id sharing our bound transcript -> admitted
- subagent with an empty/zero session_id sharing our bound transcript -> admitted
- sibling subagent (foreign transcript, different port marker) -> NOT admitted
- foreign NON-subagent event with our (unmarked) path -> NOT admitted (the gate)
- main agent (matching id) -> admitted (unchanged)

## Notes / not done

- Legacy NON-drive `filterBySession` (binder disabled, not the default) has the
  same latent strict-id gap; left as-is — drive mode is the default and the
  legacy path is being removed (#470).
- Did NOT reintroduce a PTY-inject -> AA fallback for subagents: #496 removed it
  (the daemon cannot tell whose prompt is on the PTY for parallel subagents); a
  PTY fallback could only eval-and-deny, which does not help auto-APPROVE. The
  fix belongs in the routing, which is where it landed.

## Repro

Spawn several parallel research subagents doing WebFetch to non-allowlisted
domains, especially right after session start / a daemon restart. Watch for the
new `PermissionRequest NOT admitted` lines with `agent=subagent`.
