/**
 * AutoApproveGate — owns the PermissionRequest control plane for a session.
 *
 * Epic #453 phase 1: extracted verbatim from `cli/session-phases/hook-bridge-setup.ts`
 * (concern 3 of that file's three braided concerns). It is the third member of the
 * QuestionPipeline boundary, alongside `NotificationDispatcher` and the already-
 * standalone `QuestionPresenceTracker`.
 *
 * Given a PermissionRequest hook event, `resolvePermission` returns a synchronous
 * decision (#496) that Claude honors in the hook response — it either:
 *   - returns 'allow'/'deny' from the auto-approve LLM verdict (NO PTY inject), or
 *   - escalates the prompt to the user and returns 'passthrough' (normal Question flow), or
 *   - default-denies a subagent prompt the user cannot answer via 'deny' (no hang, no PTY), or
 *   - on a primary 'escalate', consults an optional `escalate_model` second opinion
 *     (#522) before bothering the user.
 * The PTY inject path now survives only for multi-choice picks, which the response
 * cannot express.
 *
 * The two outward couplings the hook bridge used directly are injected as callbacks
 * so the gate has no back-reference to the bridge or the hook router:
 *   - `isInSubagentContext()` wraps `HookEventBridge.isInSubagentContext()`
 *   - `escalate(input)` wraps `handlers.onPermissionRequest?.(input)`
 * Both are read LIVE at each branch (never captured): the LLM eval is async, so the
 * subagent/Task context can open or close between the hook firing and the
 * `.then()`/`.catch()` running. Capturing would TOCTOU.
 */

import type { UUID } from '@remi/shared';

import type { QuestionPresenceTracker } from '../api/question-presence-tracker.ts';
import { log, logError } from '../cli/logger.ts';
import type { PermissionDecision, PermissionRequestHookInput } from '../hooks/index.ts';
import type { SessionRegistry } from '../session/index.ts';
import type { AutoApproveResult } from './types.ts';

/**
 * Minimal seam the gate consumes. The real `AutoApproveService` satisfies it
 * structurally; tests inject a real object literal returning real
 * `AutoApproveResult` values, so the gate's branching is exercised without a
 * mocking framework or a live LLM.
 */
export interface AutoApproveEvaluator {
  /**
   * Evaluate a permission request. MUST NOT throw — return an `escalate` result
   * instead so the gate's decision path is deterministic. A rejected Promise is
   * tolerated (the gate's `.catch` treats it identically to `escalate`), but a
   * synchronous throw would escape into the hook dispatch loop.
   */
  evaluate(
    toolName: string,
    toolInput: Record<string, unknown>,
    tag?: string,
    permissionSuggestions?: readonly unknown[],
    modelOverride?: string,
  ): Promise<AutoApproveResult>;
  /** Abort any in-flight `evaluate`. Returns true if an abort was issued, false
   *  if nothing was in flight (idempotent). */
  cancel(reason: string): boolean;
}

export interface AutoApproveGateDeps {
  /** null => no auto-approve configured; the no-AA escalate/default-deny path runs. */
  service: AutoApproveEvaluator | null;
  sessionRegistry: SessionRegistry;
  tracker: QuestionPresenceTracker;
  /** Wraps `HookEventBridge.isInSubagentContext()`. Read live per branch (async TOCTOU). */
  isInSubagentContext: () => boolean;
  /** Escalate to the user (wraps `handlers.onPermissionRequest`). The gate wraps
   *  every call in a try/catch, so an implementation that throws is logged and
   *  absorbed rather than propagated; implementations should still prefer to
   *  handle their own errors. */
  escalate: (input: PermissionRequestHookInput) => void;
  /** Called right before the LLM eval starts, so the tracker can BUFFER the PTY
   *  prompt until the verdict (don't push an auto-approved permission). #484. */
  onEvalStart?: () => void;
  /** Called when the verdict is escalate (the user must answer), so the tracker
   *  releases the buffered PTY prompt. #484. */
  onEscalate?: () => void;
  /** Called when the permission was auto-approved/denied silently (inject
   *  succeeded; the user never sees it). Drives the terminal "done" cue. #513. */
  onHandled?: () => void;
  /** Called when the eval ended without a verdict (cancelled — the user already
   *  advanced past the prompt). Drives the terminal cue back to idle. #513. */
  onCancelled?: () => void;
  /** Second-opinion model consulted on a primary 'escalate' in main context
   *  (#522). Empty/absent => no second opinion (escalate straight to the user). */
  escalateModel?: string;
}

export class AutoApproveGate {
  private readonly sessionTag: string;

  constructor(
    private readonly deps: AutoApproveGateDeps,
    private readonly sessionId: UUID,
  ) {
    this.sessionTag = sessionId.slice(0, 8);
  }

  /**
   * Cancel any in-flight auto-approve LLM eval. The bridge calls this on hook events
   * that unambiguously confirm Claude advanced past a prompt (PreToolUse / PostToolUse /
   * Stop / SessionEnd): the user already answered, and a stale LLM result would inject
   * into the wrong PTY position or emit a phantom question.
   *
   * Deliberately NOT called on Notification events: idle_prompt can fire while a
   * permission eval is still legitimately in flight, and auth_success /
   * elicitation_dialog don't carry "user answered" semantics either. No-op when no
   * service is configured.
   */
  cancelStale(reason: string): void {
    if (this.deps.service === null) return;
    if (this.deps.service.cancel(reason)) {
      log(`[AutoApprove] Cancelled stale LLM eval: ${reason}`);
    }
  }

  /**
   * Resolve a PermissionRequest to a synchronous decision (#496). Claude BLOCKS
   * on the hook response, so this returns the verdict INSTEAD of injecting it:
   *   - approve -> 'allow', deny -> 'deny' (Claude proceeds; NO PTY inject).
   *   - escalate (main) -> escalateToUser + 'passthrough' (Claude renders the
   *     prompt; the user answers).
   *   - escalate / no-service in a SUBAGENT context -> 'deny' via the hook
   *     response. This is the core fix: the old PTY-inject default-deny couldn't
   *     tell whose prompt was on the PTY for parallel subagents and leaked; the
   *     synchronous deny needs no PTY at all.
   *   - pick (multi-choice) -> inject the index + 'passthrough' (the hook
   *     response can't express "pick option N"; keep the PTY for this rare case).
   *   - cancelled -> 'passthrough' (the user already advanced).
   */
  async resolvePermission(input: PermissionRequestHookInput): Promise<PermissionDecision> {
    const { service, isInSubagentContext } = this.deps;

    if (this.isSubagentEvent(input)) {
      log(
        `[Hooks] Subagent PermissionRequest forwarded: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
    }

    // No auto-approve: subagent default-denies via the response (no PTY, no
    // leak); main escalates to the user.
    if (!service) {
      if (isInSubagentContext()) {
        log(`[${this.sessionTag}] Subagent context without auto-approve; default-deny`);
        return 'deny';
      }
      this.escalateToUser(input);
      return 'passthrough';
    }

    // Open the buffer/cue window (#484/#513). With synchronous decisions Claude
    // does not render the prompt during the eval, so the buffer rarely holds a
    // PTY prompt now; the cue lifecycle still rides these signals.
    this.safeCue('onEvalStart', this.deps.onEvalStart);

    let result: AutoApproveResult;
    try {
      // Raw suggestions: the service does its own strict-string filtering; we
      // forward the raw shape so the multi-choice classifier can route a
      // non-string entry through escalate instead of crashing.
      result = await service.evaluate(
        input.tool_name,
        input.tool_input,
        this.sessionTag,
        input.permission_suggestions as readonly unknown[] | undefined,
      );
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] Unexpected error:`, err);
      if (isInSubagentContext()) {
        this.markHandled();
        return 'deny';
      }
      this.escalateToUser(input);
      return 'passthrough';
    }

    if (result.decision === 'cancelled') {
      // The user already advanced past the prompt. Drop the pending hook record
      // so its stale option labels cannot merge onto the next PTY prompt.
      this.deps.tracker.clearPending();
      this.safeCue('onCancelled', this.deps.onCancelled);
      log(`[AutoApprove ${this.sessionTag}] Decision dropped: ${result.reasoning}`);
      return 'passthrough';
    }
    if (result.decision === 'approve') {
      this.markHandled();
      return 'allow';
    }
    if (result.decision === 'deny') {
      this.markHandled();
      return 'deny';
    }
    if (result.decision === 'pick') {
      // Multi-choice pick (#399): the response can't express it, so render the
      // prompt (passthrough) and inject the 1-based index into the PTY. The
      // index was validated against options length upstream. The discriminated
      // union guarantees pickIndex, but guard defensively: a malformed result
      // must escalate, not silently fall through to the subagent-deny below.
      if (result.pickIndex === undefined) {
        logError(`[AutoApprove ${this.sessionTag}] pick result missing pickIndex; escalating`);
        this.escalateToUser(input);
        return 'passthrough';
      }
      if (
        await this.inject(input, String(result.pickIndex), `multichoice-pick-${result.pickIndex}`)
      ) {
        this.markHandled();
      } else {
        this.escalateToUser(input);
      }
      return 'passthrough';
    }
    // escalate: a subagent prompt the user cannot answer is default-denied via
    // the response (no hang, no PTY).
    if (isInSubagentContext()) {
      if (!this.isSubagentEvent(input)) {
        // A MAIN-agent event reaching here means the subagent-context tracker
        // leaked (a PostToolUse(Task) was dropped). Surface it loudly — otherwise
        // the main session silently denies every permission.
        logError(
          `[AutoApprove ${this.sessionTag}] isInSubagentContext() true for a MAIN-agent PermissionRequest (tool=${input.tool_name}); denying. Possible subagent-context tracker leak.`,
        );
      }
      log(`[AutoApprove ${this.sessionTag}] Subagent context; escalate->deny to prevent hang`);
      this.markHandled();
      return 'deny';
    }
    // Second opinion (#522): the fast model would escalate, but a heavier
    // escalate_model may resolve it (honoring a broad approve policy) before we
    // bother the user. Its latency only hits would-escalate cases. Main context
    // only; never re-escalates into a third call.
    const escalateModel = this.deps.escalateModel;
    if (escalateModel) {
      let second: AutoApproveResult;
      try {
        second = await service.evaluate(
          input.tool_name,
          input.tool_input,
          this.sessionTag,
          input.permission_suggestions as readonly unknown[] | undefined,
          escalateModel,
        );
      } catch (err) {
        logError(`[AutoApprove ${this.sessionTag}] escalate_model second opinion threw:`, err);
        second = {
          decision: 'escalate',
          reasoning: 'second-opinion error',
          durationMs: 0,
          model: escalateModel,
        };
      }
      if (second.decision === 'approve') {
        log(`[AutoApprove ${this.sessionTag}] escalate_model (${escalateModel}) approved`);
        this.markHandled();
        return 'allow';
      }
      if (second.decision === 'deny') {
        log(`[AutoApprove ${this.sessionTag}] escalate_model (${escalateModel}) denied`);
        this.markHandled();
        return 'deny';
      }
      if (second.decision === 'cancelled') {
        // Claude already advanced (cancelStale fired during the slower second
        // eval). Mirror the primary cancelled path — do NOT escalate a phantom.
        this.deps.tracker.clearPending();
        this.safeCue('onCancelled', this.deps.onCancelled);
        log(`[AutoApprove ${this.sessionTag}] Second-opinion cancelled: ${second.reasoning}`);
        return 'passthrough';
      }
      // second opinion still unsure (escalate/pick) -> ask the user.
    }
    this.escalateToUser(input);
    return 'passthrough';
  }

  /**
   * Buffer-closing success path: the permission was auto-approved/denied
   * silently (inject succeeded), so the user never sees it. Notifies the
   * tracker (closes the #484 buffer window) AND the terminal cue (#513). Every
   * silent-handle site routes through here so neither signal can be missed.
   */
  private markHandled(): void {
    this.deps.tracker.onAutoApproveHandled();
    this.safeCue('onHandled', this.deps.onHandled);
  }

  /**
   * Invoke a COSMETIC lifecycle callback (the #513 terminal cue). The cue must
   * never affect the decision path or the #484 buffer state, so a throw is
   * logged and absorbed here rather than propagating into the .then()/.catch()
   * chain (where the outer catch would re-run the decision and could re-open an
   * already-closed buffer). Mirrors how `escalateToUser` shields `onEscalate`.
   */
  private safeCue(label: string, fn: (() => void) | undefined): void {
    if (!fn) return;
    try {
      fn();
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] ${label} cue threw (cosmetic; ignored):`, err);
    }
  }

  /** Subagent/team-member events carry a non-empty `agent_id`; main events do not. */
  private isSubagentEvent(input: PermissionRequestHookInput): boolean {
    return typeof input.agent_id === 'string' && input.agent_id.length > 0;
  }

  /**
   * Inject an answer into the PTY. Returns true on success. On failure (session
   * missing, PTY not running, submitInput throws, subagent off-screen gate trips)
   * it logs and returns false so callers can fall back to escalating.
   *
   * `value` is a 1-based numeric option index serialised as a string. Since #496
   * (synchronous decisions) approve/deny no longer inject — this is now reached
   * ONLY for a multi-choice pick, where `value` is the chosen index (#399).
   *
   * PTY-presence gate (subagent-only): a background subagent emits PermissionRequest
   * hooks for its own tool calls, but its prompts never render on the main PTY — only
   * a hot-switched subagent view does. Without this gate, auto-approve would type the
   * pick index into the MAIN AGENT's input every time a background subagent asked.
   */
  private async inject(
    input: PermissionRequestHookInput,
    value: string,
    reason: string,
    bypassSubagentPtyGate = false,
  ): Promise<boolean> {
    const { sessionRegistry, tracker, isInSubagentContext } = this.deps;
    try {
      const session = sessionRegistry.getSession(this.sessionId);
      if (!session) {
        logError(`[AutoApprove ${this.sessionTag}] Session not found; cannot inject "${value}"`);
        return false;
      }
      const inSubagentContext = this.isSubagentEvent(input) || isInSubagentContext();
      if (!bypassSubagentPtyGate && inSubagentContext && !tracker.isPromptVisibleOnPTY()) {
        log(
          `[AutoApprove ${this.sessionTag}] Subagent ${input.tool_name}: skipping inject "${value}" (${reason}); no prompt visible on main PTY (agent=${input.agent_id?.slice(0, 8) ?? 'nested'} type=${input.agent_type ?? 'n/a'})`,
        );
        return false;
      }
      await session.pty.submitInput(value);
      log(`[AutoApprove ${this.sessionTag}] Injected "${value}" into PTY (${reason})`);
      // Optimistic: the picked option will run a tool. The authoritative status
      // follows from Claude's own PreToolUse hook.
      sessionRegistry.updateStatus(this.sessionId, 'executing');
      return true;
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] inject("${value}") threw:`, err);
      return false;
    }
  }

  /**
   * Safe escalation to the user. Used when inject fails or when auto-approve is off
   * and we're in main context. Wrapped so a bridge/push failure does not leave a
   * dangling unhandled rejection in the hook handler.
   */
  private escalateToUser(input: PermissionRequestHookInput): void {
    try {
      // escalate() stashes the hook record (onPermissionRequest -> recordPendingHook)
      // FIRST, then onEscalate releases the buffered PTY prompt so the pair+push
      // finds that record. Order matters; do not reorder. #484.
      this.deps.escalate(input);
    } catch (err) {
      logError(`[AutoApprove ${this.sessionTag}] escalateToUser threw:`, err);
    } finally {
      // Release the buffer UNCONDITIONALLY: the verdict is "user must answer".
      // Even if escalate() threw (push will fail), the buffer must not stay
      // locked, or every later prompt in this session would buffer forever. #484.
      // safeCue: the wired callback releases the buffer (critical) then fires the
      // terminal cue (#513, cosmetic); a cue throw must not break the finally.
      this.safeCue('onEscalate', this.deps.onEscalate);
    }
  }
}
