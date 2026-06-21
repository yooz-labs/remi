# Phase 2 (#573) — implementation spec: hold the hook (Model B) + cancel + slow-eval push

Worktree: `../notif-phase2-hold-cancel` (branch `feature/issue-573-phase2-hold-cancel`, off epic incl. Phase 1).
Grounded in reads of: auto-approve-gate.ts, hook-server.ts, input-events.ts, hook-config-manager.ts.

## Key facts (verified in code)

- `hook-server.ts:214-224` already `await`s `permissionResolver(input)` and serialises the result. **Holding = the gate returns a promise that stays pending.** No hook-server change.
- `auto-approve-gate.ts:resolvePermission` returns `Promise<PermissionDecision>` (`'allow'|'deny'|'passthrough'`). Escalate paths currently do `escalateToUser(input); return 'passthrough'`.
- `escalateToUser` (gate:359) calls `deps.escalate(input)` (void) then `safeCue('onEscalate')` in `finally` (releases the #484 buffer). Order matters: escalate() stashes the hook record BEFORE onEscalate.
- `input-events.ts:onAnswer` (120-174): looks up `active = sessionRegistry.getQuestion(sessionId, questionId)`; if stale → STALE_ANSWER; else `session.pty.submitInput(answer)` + `removeQuestion`. The `active` Question carries `options` (with isYes/isNo) for answer→decision mapping.
- Hook timeout: `hook-config-manager.ts` `hookTimeoutFor(event)` / `desiredTimeout`; PermissionRequest is the long one. Raise to a configurable human-paced value.

## Scope decision (needs user): A+C now, B follow-up?

- **Part A (hold) + Part C (cancel)** are a coherent, shippable unit: the headline Model-B win (binary escalations answered via the hook response; eval cancelled on answer). Delivery still rides the existing WebSocket answer path; the connection-independent relay is Phase 4.
- **Part B (slow-eval fallback push)** requires an eval/timer RACE restructure of `resolvePermission` (push + start hold mid-eval if it runs >60s, then reconcile the late verdict: approve→resolve allow, escalate→keep holding). Higher risk; cleaner as its own focused PR with its own tests.
- Recommendation: ship A+C as #573, carve B into a follow-up (sub-issue or second commit). Avoids cramming a race rewrite.

## Part A — hold the hook (binary, main context)

1. **Hold-vs-passthrough branch.** Binary = `!isMultiChoicePermission(tool, suggestions) && !isDesignQuestion(tool, toolInput, suggestions, alwaysEscalateTools)`. Pass `alwaysEscalateTools: ReadonlySet<string>` into `AutoApproveGateDeps` (from `config.auto_approve.always_escalate_tools`). Only binary main-context escalations HOLD; multi-choice/design escalations keep `passthrough` (their pick delivery is Phase 4 relay→PTY).
2. **`escalate` dep returns the question id.** Change `escalate: (input) => void` → `=> UUID | undefined`; `HookEventBridge.handlePermissionRequest` returns the `Question.id` it created (it already builds the Question + emits onQuestion). Wrapper in hook-bridge-setup returns it.
3. **`escalateAndHold(input): Promise<PermissionDecision>`** on the gate: `const qid = deps.escalate(input)` (stash record + push) → `safeCue('onEscalate')` (release buffer) → if `!qid || holdMs<=0` return `'passthrough'` (today's behavior, e.g. push failed) → else `new Promise(resolve => { timer = setTimeout(()=>{ pendingHolds.delete(qid); resolve('passthrough') /*fail-open → native prompt*/ }, holdMs); pendingHolds.set(qid,{resolve,timer}); })`. Use it at the binary main-context escalate sites (primary escalate, escalate_model-unsure, LLM-error main, no-service main). Keep `escalateToUser` (void/passthrough) for subagent inject-fail + pick-missing.
4. **`resolveHeld(questionId, decision: 'allow'|'deny'): boolean`** on the gate: look up pendingHolds; if absent return false; else clearTimeout + delete + `markHandled()` + `hold.resolve(decision)` + return true.
5. **Cleanup:** `cancelStale` (Stop/SessionEnd) also resolves all pendingHolds with `'passthrough'` + clears timers (defensive; a blocked hook can't normally co-occur with Stop). `pendingHolds` is per-gate (per-session) so multi-session is isolated.
6. **Config:** `auto_approve.hold_timeout` (seconds; large human-paced default, e.g. 1800; 0 disables hold → passthrough as today). Wire to `hookTimeoutFor('PermissionRequest')` (the registered hook timeout must be >= hold_timeout) AND to the gate's holdMs.

## Part C — cancel on answer + resolve held hook

- Expose from `setupHookBridge` a per-session handle `{ cancelStale, resolveHeld }` (or the gate). Register per-session (sessionRegistry or a Map in cli.ts) so `onAnswer` reaches the RIGHT session's gate.
- `onAnswer` (input-events.ts), after the stale guard: map the chosen option → `allow`/`deny` via the `active` Question's option isYes/isNo (find option by value). Then `const resolved = gate.resolveHeld(questionId, decision)`. If `resolved` → skip `submitInput` (Claude is blocked on the hook, not rendering), still `removeQuestion`. If not resolved → existing `submitInput` path (multi-choice pick / non-AA). Also call `gate.cancelStale('user-answered')` to abort any still-running eval + drain queue.
- Add `InputHandlerDeps.resolveHeldPermission?(sessionId, questionId, decision): boolean` and `cancelAutoApprove?(sessionId, reason): void` (session-keyed), wired in cli.ts from the per-session gate handle.

## Tests (NO MOCKS)

Real loopback HookServer (mirror serialize.test.ts gated-server pattern) + real gate:
- Binary escalate → POST /hooks response is WITHHELD until `resolveHeld` called → then `{decision:{behavior:'allow'}}` / deny.
- Multi-choice/design escalate → immediate `{}` (passthrough), no hold.
- Hold timeout → resolves `passthrough` (`{}`), pendingHolds cleaned.
- cancelStale releases holds (passthrough) + aborts eval.
- onAnswer maps Yes→allow / No→deny; resolveHeld true skips PTY submit; non-held answer still submits.
- Per-session isolation: resolving session A's hold doesn't touch B.

## Files

auto-approve-gate.ts (hold map, escalateAndHold, resolveHeld, branch, cancelStale cleanup, deps), hook-event-bridge.ts (handlePermissionRequest returns id), cli/session-phases/hook-bridge-setup.ts (escalate wrapper returns id; gate deps incl. alwaysEscalateTools + holdMs; setupHookBridge return adds handle), cli/handlers/input-events.ts (onAnswer resolveHeld + cancel; deps), cli.ts (register per-session handle; pass into createInputHandlers), hooks/hook-config-manager.ts (hold_timeout → hookTimeoutFor), auto-approve/types.ts + config/config.ts (hold_timeout config), tests.
