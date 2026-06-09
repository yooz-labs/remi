/**
 * AutoApproveGate — owns the PermissionRequest control plane for a session.
 *
 * Epic #453 phase 1: extracted verbatim from `cli/session-phases/hook-bridge-setup.ts`
 * (concern 3 of that file's three braided concerns). It is the third member of the
 * QuestionPipeline boundary, alongside `NotificationDispatcher` and the already-
 * standalone `QuestionPresenceTracker`.
 *
 * Given a PermissionRequest hook event, it either:
 *   - runs the auto-approve LLM eval and injects "1" (approve) / "3" (deny) /
 *     a 1-based pick index into the PTY, or
 *   - escalates the prompt to the user (the normal Question flow), or
 *   - default-denies a subagent prompt the user cannot answer (to avoid hanging it).
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
import type { PermissionRequestHookInput } from '../hooks/index.ts';
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
   * Handle a PermissionRequest hook event: auto-approve eval + inject, or escalate.
   * Caller is responsible for session filtering (the bridge runs initFromHookEvent
   * + filterBySession before delegating here).
   */
  handlePermissionRequest(input: PermissionRequestHookInput): void {
    const { service, isInSubagentContext } = this.deps;

    // Phase 4 (#419): subagent PermissionRequest events are forwarded (not dropped).
    // The PTY-presence model treats "what's on screen" as truth: a hot-switched
    // subagent view that renders a permission prompt IS user-answerable, and
    // dropping the hook here would lose the rich tool/option metadata.
    if (this.isSubagentEvent(input)) {
      log(
        `[Hooks] Subagent PermissionRequest forwarded: agent=${input.agent_id?.slice(0, 8)} type=${input.agent_type} tool=${input.tool_name}`,
      );
    }

    // Auto-approve gate: evaluate before creating a Question object.
    if (service) {
      // Open the buffer window: a PTY prompt that renders during the eval is
      // held (not pushed) until we know the verdict. #484. The terminal cue
      // (#513) rides this signal but must never throw into the dispatch loop.
      this.safeCue('onEvalStart', this.deps.onEvalStart);
      // Pass the raw suggestions array; AutoApproveService does its own strict-string
      // filtering before feeding the LLM. We forward the raw shape (rather than
      // coercing) so the multi-choice classifier can see "non-string entry" and route
      // through escalate instead of crashing on a future permission_suggestions schema
      // change.
      service
        .evaluate(
          input.tool_name,
          input.tool_input,
          this.sessionTag,
          input.permission_suggestions as readonly unknown[] | undefined,
        )
        .then(async (result) => {
          if (result.decision === 'cancelled') {
            // User already advanced past the prompt. Do not inject, do not escalate.
            // Drop the pending hook record so its stale option labels cannot merge
            // onto the next unrelated PTY prompt (e.g. user typed /compact, no
            // PreToolUse fires).
            this.deps.tracker.clearPending();
            this.safeCue('onCancelled', this.deps.onCancelled);
            log(`[AutoApprove ${this.sessionTag}] Decision dropped: ${result.reasoning}`);
            return;
          }
          if (result.decision === 'approve') {
            // inject success -> auto-handled (close the buffer; user never sees
            // it); inject failure -> escalate (which releases the buffer). #484.
            if (await this.inject(input, '1', 'approved')) this.markHandled();
            else this.escalateToUser(input);
            return;
          }
          if (result.decision === 'deny') {
            if (await this.inject(input, '3', 'denied')) this.markHandled();
            else this.escalateToUser(input);
            return;
          }
          if (result.decision === 'pick' && result.pickIndex !== undefined) {
            // Multi-choice pick (#399): inject the 1-based index Claude Code expects.
            // parseMultiChoiceDecision already validated the index against options
            // length, so out-of-range values cannot reach this branch.
            if (
              await this.inject(
                input,
                String(result.pickIndex),
                `multichoice-pick-${result.pickIndex}`,
              )
            ) {
              this.markHandled();
            } else {
              this.escalateToUser(input);
            }
            return;
          }
          // escalate: in a subagent context, default-deny to avoid hanging the
          // subagent (the user could not answer it anyway). Bypass the subagent PTY
          // gate because the alternative is letting it hang forever; typing '3' into
          // the parent PTY is the lesser evil. The approve/deny/pick branches above
          // use the gate because they have a fallback (escalateToUser); this does not.
          if (isInSubagentContext()) {
            log(
              `[AutoApprove ${this.sessionTag}] Subagent context; escalate->deny to prevent hang`,
            );
            await this.inject(input, '3', 'subagent-escalate-default-deny', true);
            this.markHandled(); // close the buffer window (#484)
            return;
          }
          this.escalateToUser(input);
        })
        .catch(async (err) => {
          // Last line of defense; must not leave an unhandled rejection.
          try {
            logError(`[AutoApprove ${this.sessionTag}] Unexpected error:`, err);
            if (isInSubagentContext()) {
              await this.inject(input, '3', 'subagent-error-default-deny', true);
              this.markHandled(); // close the buffer window (#484)
              return;
            }
            this.escalateToUser(input);
          } catch (inner) {
            logError(`[AutoApprove ${this.sessionTag}] catch handler threw:`, inner);
          }
        });
      return;
    }

    // No auto-approve. In a subagent context, still must not hang the subagent:
    // default-deny rather than emit a question the user can't answer.
    if (isInSubagentContext()) {
      log(`[${this.sessionTag}] Subagent context without auto-approve; default-deny`);
      this.inject(input, '3', 'subagent-no-aa-default-deny', true).catch((err) => {
        logError(`[${this.sessionTag}] Failed to inject default-deny:`, err);
      });
      return;
    }

    this.escalateToUser(input);
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
   * `value` is a 1-based numeric option index serialised as a string. Most
   * permissions only need '1' (approve) or '3' (deny); multi-choice picks can land
   * any index in the prompt's option range (#399).
   *
   * PTY-presence gate (subagent-only): a background subagent emits PermissionRequest
   * hooks for its own tool calls, but its prompts never render on the main PTY — only
   * a hot-switched subagent view does. Without this gate, auto-approve would type
   * "1"/"3" into the MAIN AGENT's input every time a background subagent asked.
   * `bypassSubagentPtyGate` is set by the default-deny paths, whose alternative is
   * hanging the subagent indefinitely.
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
      sessionRegistry.updateStatus(this.sessionId, value === '1' ? 'executing' : 'thinking');
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
