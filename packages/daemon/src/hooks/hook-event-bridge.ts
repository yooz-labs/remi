/**
 * Bridges Claude Code hook events to Remi's status/question system.
 *
 * Maps hook events to the same AgentStatus and Question types that
 * the OutputProcessor previously produced from terminal parsing.
 * This is the hook-based replacement for terminal output parsing.
 *
 * Permission question flow (verified from real hook logs 2026-04-12, updated
 * #718 for structured suggestions observed 2026-07-06):
 *   - PermissionRequest fires with tool_name, tool_input, and optionally
 *     permission_suggestions. This is either a legacy plain-string label set
 *     (e.g. ["Yes","Always","No"] for Edit) OR, since ~Claude Code 2.0.54, a
 *     STRUCTURED array of typed entries (`addRules`, `addDirectories`,
 *     `setMode`, ...) — see `optionsFromSuggestions` for how each shape maps
 *     to a variable-count option set (never a fixed 3). With NO usable
 *     suggestions of either shape, the honest Yes/No 2-set substitutes.
 *   - Notification(permission_prompt) fires shortly after with a plain-text
 *     message like "Claude needs your permission to use Bash" (no numbered
 *     options; those appear only in the terminal UI) — always the Yes/No
 *     fallback, since this event never carries permission_suggestions.
 *   - Both events forward their question to onQuestion. The push gate is
 *     QuestionPresenceTracker (cli.ts wiring): hook events stash the
 *     metadata; PTY confirms presence and fires the push. If both events
 *     arrive before PTY (typical), the second simply replaces the first
 *     in the tracker — Claude only renders one prompt at a time.
 */

import { DEFAULT_PERMISSION_LABELS, generateId } from '@remi/shared';
import type { AgentStatus, Question, QuestionOption, UUID } from '@remi/shared';
import type { HookServerEvents } from './hook-server.ts';
import type {
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  SessionStartHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from './hook-types.ts';
import { SubagentContextTracker } from './subagent-context-tracker.ts';
import { extractToolQuestion } from './tool-question.ts';

export interface HookBridgeEvents {
  onStatusChange: (status: AgentStatus, context?: string) => void;
  onQuestion: (question: Question) => void;
  onSessionInfo: (claudeSessionId: string, transcriptPath: string) => void;
}

/** Honest Yes/No fallback options (#718): used when a PermissionRequest
 *  carries NO usable `permission_suggestions` (none at all, or every entry
 *  filtered out). Labels are imported from `@remi/shared` so the web
 *  client's question-merge guard recognises them as the bland fallback
 *  (#396). Replaces the old fabricated Yes / Yes-always / No 3-set — the
 *  daemon has no `permission_suggestions` entry to echo back for an
 *  "always" choice here, so pretending one exists was dishonest (#718). */
const DEFAULT_PERMISSION_OPTIONS: readonly QuestionOption[] = [
  {
    label: DEFAULT_PERMISSION_LABELS[0],
    value: '1',
    isRecommended: true,
    isYes: true,
    isNo: false,
  },
  {
    label: DEFAULT_PERMISSION_LABELS[1],
    value: '2',
    isRecommended: false,
    isYes: false,
    isNo: true,
  },
];

/** Maximum options a permission card can show (iOS push-category/action
 *  budget: `selectPushCategory` maps 2/3/4 options to REMI_YN/REMI_YNA/
 *  REMI_MULTI; nothing beyond 4 has a category). Yes and No are always
 *  present, so at most `MAX_PERMISSION_OPTIONS - 2` suggestion-derived
 *  middle options are kept. */
const MAX_PERMISSION_OPTIONS = 4;

/** Approximate cap (characters) for a suggestion-derived option label
 *  before truncation, so a long shell command or rule list can't blow out
 *  the push notification body / iOS action button. */
const SUGGESTION_LABEL_MAX = 80;

function truncateLabel(label: string): string {
  return label.length > SUGGESTION_LABEL_MAX
    ? `${label.slice(0, SUGGESTION_LABEL_MAX - 3)}...`
    : label;
}

/**
 * Build the label for ONE usable structured `permission_suggestions` entry
 * (#718), or null when the entry is not a "yes"-shaped suggestion this card
 * can safely render as a one-tap option: a deny/ask-behavior `addRules`, a
 * `removeRules` / `replaceRules` / `removeDirectories` (these narrow or
 * reset permissions — never a "yes" variant), or a `type` Claude Code has
 * not documented yet (ground truth: code.claude.com/docs/en/hooks).
 */
function labelForStructuredSuggestion(entry: Record<string, unknown>): string | null {
  const type = entry['type'];
  if (type === 'addRules') {
    if (entry['behavior'] !== 'allow') return null;
    const rules = Array.isArray(entry['rules']) ? entry['rules'] : [];
    const parts = rules
      .map((rule): string | undefined => {
        if (typeof rule !== 'object' || rule === null) return undefined;
        const ruleContent = (rule as Record<string, unknown>)['ruleContent'];
        const toolName = (rule as Record<string, unknown>)['toolName'];
        if (typeof ruleContent === 'string' && ruleContent.length > 0) return ruleContent;
        return typeof toolName === 'string' && toolName.length > 0 ? toolName : undefined;
      })
      .filter((s): s is string => s !== undefined);
    if (parts.length === 0) return null;
    const suffix = entry['destination'] === 'session' ? ' (this session)' : '';
    return truncateLabel(`Yes, always allow: ${parts.join(', ')}${suffix}`);
  }
  if (type === 'addDirectories') {
    const directories = Array.isArray(entry['directories'])
      ? entry['directories'].filter((d): d is string => typeof d === 'string' && d.length > 0)
      : [];
    if (directories.length === 0) return null;
    return truncateLabel(`Yes, allow directory ${directories.join(', ')}`);
  }
  if (type === 'setMode') {
    const mode = entry['mode'];
    if (typeof mode !== 'string' || mode.length === 0) return null;
    return truncateLabel(`Yes, switch to ${mode} mode`);
  }
  return null;
}

/** Result of {@link optionsFromSuggestions}: the options to render, and
 *  whether they are the honest fallback rather than a real derived set. */
export interface PermissionOptionsResult {
  readonly options: QuestionOption[];
  /** True when `options` is the {@link DEFAULT_PERMISSION_OPTIONS} fallback
   *  (#718): no usable suggestion contributed a middle option. Threaded onto
   *  the emitted `Question` so the tracker's merge policy never lets this
   *  bare fallback overwrite a concrete PTY-parsed set of options. */
  readonly isFallback: boolean;
}

/**
 * Build options from a PermissionRequest's `permission_suggestions` (#718).
 * Two shapes:
 *   - Legacy: >= 2 plain string labels (e.g. Edit's `["Yes","Always","No"]`)
 *     map directly to options, unchanged since #574.
 *   - Structured (Claude Code >= ~2.0.54): each USABLE entry (`addRules`
 *     with `behavior:"allow"`, `addDirectories`, `setMode`) becomes ONE
 *     middle option between a plain [Yes] and [No]; entries this card
 *     cannot safely render as a one-tap "yes" are skipped (see
 *     {@link labelForStructuredSuggestion}). Capped at
 *     {@link MAX_PERMISSION_OPTIONS} total — the first usable suggestions
 *     are kept, the rest dropped with a warning.
 * With NO usable suggestions of either shape, the honest Yes/No fallback
 * substitutes (`isFallback: true`) instead of a fabricated 3-set.
 * Exported so the mapping is unit-testable independent of the bridge.
 */
export function optionsFromSuggestions(suggestions: unknown): PermissionOptionsResult {
  const stringSuggestions = Array.isArray(suggestions)
    ? suggestions.filter((s): s is string => typeof s === 'string' && s.length > 0)
    : [];
  if (stringSuggestions.length >= 2) {
    const options = stringSuggestions.map((suggestion, idx) => {
      const lower = suggestion.toLowerCase();
      const isYes = lower.startsWith('yes') || lower === 'allow' || lower === 'always';
      const isNo = lower.startsWith('no') || lower === 'deny' || lower === 'reject';
      return { label: suggestion, value: String(idx + 1), isRecommended: idx === 0, isYes, isNo };
    });
    return { options, isFallback: false };
  }

  const entries = Array.isArray(suggestions) ? suggestions : [];
  const middleLabels: string[] = [];
  const suggestionIndices: number[] = [];
  entries.forEach((entry, idx) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return;
    const label = labelForStructuredSuggestion(entry as Record<string, unknown>);
    if (label === null) {
      console.debug(
        `[HookEventBridge] Skipping unusable permission_suggestions[${idx}] (type=${String((entry as Record<string, unknown>)['type'])})`,
      );
      return;
    }
    middleLabels.push(label);
    suggestionIndices.push(idx);
  });

  if (middleLabels.length === 0) {
    return { options: [...DEFAULT_PERMISSION_OPTIONS], isFallback: true };
  }

  const maxMiddle = MAX_PERMISSION_OPTIONS - 2; // Yes + No are always present
  if (middleLabels.length > maxMiddle) {
    console.warn(
      `[HookEventBridge] ${middleLabels.length} usable permission_suggestions exceed the ${MAX_PERMISSION_OPTIONS}-option card budget; keeping the first ${maxMiddle}, dropping ${middleLabels.length - maxMiddle}`,
    );
  }
  const keptLabels = middleLabels.slice(0, maxMiddle);
  const keptIndices = suggestionIndices.slice(0, maxMiddle);

  let value = 1;
  const options: QuestionOption[] = [
    { label: 'Yes', value: String(value++), isRecommended: true, isYes: true, isNo: false },
    ...keptLabels.map((label, i) => ({
      label,
      value: String(value++),
      isRecommended: false,
      isYes: true,
      isNo: false,
      suggestionIndex: keptIndices[i],
    })),
    { label: 'No', value: String(value++), isRecommended: false, isYes: false, isNo: true },
  ];
  return { options, isFallback: false };
}

export class HookEventBridge {
  private readonly sessionId: UUID;
  private readonly events: HookBridgeEvents;
  /** Tracks active Task tool_use_ids — secondary safety net for subagent
   *  filtering (primary is agent_id check in cli.ts hook listeners). */
  private readonly subagentContext = new SubagentContextTracker();

  constructor(sessionId: UUID, events: HookBridgeEvents) {
    this.sessionId = sessionId;
    this.events = events;
  }

  /** True when the main agent is inside a *synchronous* Task tool call
   *  (subagent running and bracketed by PreToolUse(Task)/PostToolUse(Task)
   *  on the main session). Callers use this to short-circuit auto-approve
   *  during team work.
   *
   *  Async / background-spawned subagents (TaskCreate, TeamCreate) and
   *  team members emit hook events with `agent_id` set but do NOT bracket
   *  their lifetime with a PreToolUse on the main session — so this
   *  method returns `false` even when such a subagent is active. The
   *  primary filter for those is `agent_id` (handled at the
   *  hook-bridge-setup listener layer). This method is defense in depth
   *  for the synchronous case where `agent_id` is absent. */
  isInSubagentContext(): boolean {
    return this.subagentContext.isInSubagentContext();
  }

  /**
   * Pop the tracker for a PostToolUse that `hook-bridge-setup.ts` drops for
   * being subagent-tagged (`agent_id` present) BEFORE it would reach
   * `handlePostToolUse` (#710). Claude Code may stamp the SPAWNED agent's own
   * `agent_id` on the Task/Agent completion PostToolUse that closes the exact
   * tool_use_id the untagged PreToolUse tracked when the Task started; without
   * this call the use_id is never popped, `isInSubagentContext()` sticks true
   * forever, and the gate default-denies every later MAIN-agent
   * PermissionRequest. Safe for a genuine subagent-internal PostToolUse too:
   * its use_ids were never tracked (subagent PreToolUse events are dropped
   * without tracking), so popping them is a no-op.
   */
  noteSubagentToolEnd(toolName: string, toolUseId: string | undefined): void {
    this.subagentContext.onPostToolUse(toolName, toolUseId);
  }

  /**
   * Reset the subagent-context tracker (#710). Called by the auto-approve gate
   * when a MAIN-tagged PermissionRequest (agent_id absent) observes
   * `isInSubagentContext()` stuck true — proof the tracker leaked rather than
   * a real subagent prompt — so the gate can recover instead of silently
   * denying the main agent forever.
   */
  resetSubagentContext(): void {
    this.subagentContext.reset();
  }

  /** Returns HookServerEvents handlers wired to this bridge */
  hookHandlers(): Partial<HookServerEvents> {
    return {
      onPreToolUse: (input) => this.handlePreToolUse(input),
      onPostToolUse: (input) => this.handlePostToolUse(input),
      onNotification: (input) => this.handleNotification(input),
      onStop: (input) => this.handleStop(input),
      onSessionStart: (input) => this.handleSessionStart(input),
      onPermissionRequest: (input) => this.handlePermissionRequest(input),
      onPostToolUseFailure: (input) => this.handlePostToolUseFailure(input),
      onSubagentStart: (input) => this.handleSubagentStart(input),
      onSubagentStop: (input) => this.handleSubagentStop(input),
      onStopFailure: (input) => this.handleStopFailure(input),
      onSessionEnd: (input) => this.handleSessionEnd(input),
    };
  }

  handlePreToolUse(input: PreToolUseHookInput): void {
    this.subagentContext.onPreToolUse(input.tool_name, input.tool_use_id);
    this.events.onStatusChange('executing', input.tool_name);
  }

  handlePostToolUse(input: PostToolUseHookInput): void {
    this.subagentContext.onPostToolUse(input.tool_name, input.tool_use_id);
    this.events.onStatusChange('thinking');
  }

  handleNotification(input: NotificationHookInput): void {
    if (input.notification_type === 'permission_prompt') {
      // Phase 4 (#419): the subagentContext drop previously sat here.
      // It was redundant defense: cli.ts hook-bridge-setup already
      // forwards subagent events (phase 4 removed the agent_id gate)
      // and the tracker handles presence by PTY confirmation. Keep
      // SubagentContextTracker for the auto-approve default-deny path
      // (still consumed via hookBridge.isInSubagentContext()).
      //
      // Forward the question — push semantics live in the tracker
      // (cli.ts wiring). A trailing Notification arriving after
      // PermissionRequest replaces the pending record, which is fine
      // (Claude renders one prompt at a time).
      const question: Question = {
        id: generateId(),
        text: input.message || 'Allow this action?',
        options: [...DEFAULT_PERMISSION_OPTIONS],
        allowsFreeText: false,
        isAnswered: false,
        agentId: input.agent_id,
        // Generic fallback: the tracker must let a richer PermissionRequest
        // for the same agent win over this text/options (#574).
        source: 'notification',
        // #718: this generic Notification never carries permission_suggestions
        // at all, so it is always the honest Yes/No fallback — never let it
        // overwrite a PTY-parsed question's own options in the tracker merge.
        optionsAreFallback: true,
      };
      this.events.onQuestion(question);
      this.events.onStatusChange('waiting');
    } else if (input.notification_type === 'idle_prompt') {
      this.events.onStatusChange('idle');
    } else {
      // Intentionally unhandled notification types:
      // - 'auth_success': informational only, no status change needed
      // - 'elicitation_dialog': not yet supported by Remi
      // #624 review: log (not silent) so an unsupported prompt — e.g. an MCP
      // elicitation dialog Claude is blocking on — leaves a trace instead of
      // looking identical to an idle session. Tracked as a follow-up.
      if (input.notification_type === 'elicitation_dialog') {
        console.debug(
          '[Bridge] elicitation_dialog notification received but not yet supported; ignoring',
        );
      }
    }
  }

  handleStop(input: StopHookInput): void {
    // When stop_hook_active is true, the stop hook is intercepting and the
    // session is NOT actually stopping; it remains active.
    if (!input.stop_hook_active) {
      this.events.onStatusChange('idle');
      // Agent turn is done; clear any orphaned subagent tracking so a dropped
      // PostToolUse(Task) can't permanently block the user's permission prompts.
      this.subagentContext.reset();
    }
  }

  handleSessionStart(input: SessionStartHookInput): void {
    if (!input.session_id || !input.transcript_path) {
      console.warn(
        `[HookEventBridge] SessionStart missing required fields: session_id=${input.session_id}, transcript_path=${input.transcript_path}`,
      );
      return;
    }
    // Reset tracker for a fresh session (also covers daemon restart mid-Task).
    this.subagentContext.reset();
    this.events.onSessionInfo(input.session_id, input.transcript_path);
  }

  /**
   * Build + emit the escalation Question for a PermissionRequest and return its
   * id (#573). The id lets the auto-approve gate HOLD the binary hook keyed by
   * this question, so the user's answer resolves the hook via the response
   * (Model B) instead of a PTY inject. Always returns an id today.
   */
  handlePermissionRequest(input: PermissionRequestHookInput, summary?: string): UUID {
    // Phase 4 (#419): the subagentContext drop previously sat here.
    // After phase 3 wired in the QuestionPresenceTracker, push semantics
    // are presence-gated regardless of subagent context — a subagent
    // prompt that does not render on the user's PTY does not push, and
    // one that does is genuinely answerable. The tracker handles both
    // cases; this method now only builds the question payload.
    const toolName = input.tool_name || 'unknown tool';

    // Question-bearing tools (AskUserQuestion, ExitPlanMode) carry the real
    // question + option labels in tool_input; surface those instead of the
    // generic "Allow <tool>" + Yes / Yes, always / No (#597). The options are
    // picks (1-based value, never isYes/isNo) so a user answer releases the held
    // hook and submits the matching digit to Claude's native numbered prompt.
    const toolQuestion = extractToolQuestion(toolName, input.tool_input);

    let promptText: string;
    let options: QuestionOption[];
    let optionsAreFallback = false;
    if (toolQuestion) {
      // Already phrased as a question, so no "Allow" prefix. A subagent prompt
      // still names the agent so the user knows WHO is asking.
      promptText = input.agent_type
        ? `${input.agent_type} · ${toolQuestion.text}`
        : toolQuestion.text;
      options = toolQuestion.options;
    } else {
      const inputSummary = this.summarizeToolInput(toolName, input.tool_input);
      // The action carries the command/path/pattern context (#497).
      const action = inputSummary ? `${toolName}: ${inputSummary}` : toolName;
      // A subagent prompt names the agent, e.g.
      // "code-reviewer · Bash: git push origin main" vs "Allow Bash: ...".
      promptText = input.agent_type ? `${input.agent_type} · ${action}` : `Allow ${action}`;
      const built = optionsFromSuggestions(input.permission_suggestions);
      options = built.options;
      optionsAreFallback = built.isFallback;
    }

    const questionId = generateId();
    this.events.onQuestion({
      id: questionId,
      text: promptText,
      options,
      allowsFreeText: false,
      isAnswered: false,
      agentId: input.agent_id,
      // Rich source: carries tool + command + agent context. The tracker
      // keeps this over a trailing generic notification for the same agent (#574).
      source: 'permission_request',
      // #718: lets the tracker's merge policy keep a PTY-parsed question's own
      // options instead of overwriting them with this bare fallback set.
      ...(optionsAreFallback ? { optionsAreFallback: true } : {}),
      // #626: surface the full AskUserQuestion structure (all sub-questions with
      // headers, descriptions, multiSelect) so the client can render it properly.
      // text/options above still mirror questions[0] for back-compat.
      ...(toolQuestion?.kind === 'multi_question' && toolQuestion.questions
        ? {
            kind: 'multi_question' as const,
            questions: toolQuestion.questions,
            ...(toolQuestion.submitLabel ? { submitLabel: toolQuestion.submitLabel } : {}),
          }
        : {}),
      // #628: the auto-approve LLM's lock-screen one-liner for a generic escalation
      // (e.g. "Force-push to main?"). AskUserQuestion carries authored content, so a
      // summary is only threaded for non-AUQ permission escalations.
      ...(summary ? { summary } : {}),
    });
    this.events.onStatusChange('waiting');
    return questionId;
  }

  handlePostToolUseFailure(input: PostToolUseFailureHookInput): void {
    this.events.onStatusChange('executing', `${input.tool_name} failed: ${input.error}`);
  }

  handleSubagentStart(input: SubagentStartHookInput): void {
    this.events.onStatusChange('executing', `subagent:${input.agent_type}`);
  }

  handleSubagentStop(_input: SubagentStopHookInput): void {
    this.events.onStatusChange('thinking');
  }

  handleStopFailure(input: StopFailureHookInput): void {
    // Stop failed: agent may be in an unknown state. Reset subagent tracking
    // so orphaned Task IDs don't permanently block user permissions.
    this.subagentContext.reset();
    // Emit a question so the user is notified of the stop failure
    const question: Question = {
      id: generateId(),
      text: `Session stop failed (${input.error_type}). Retry?`,
      options: [
        { label: 'Yes', value: 'y', isRecommended: true, isYes: true, isNo: false },
        { label: 'No', value: 'n', isRecommended: false, isYes: false, isNo: true },
      ],
      allowsFreeText: false,
      isAnswered: false,
      agentId: input.agent_id,
    };
    this.events.onQuestion(question);
    this.events.onStatusChange('waiting');
  }

  handleSessionEnd(_input: SessionEndHookInput): void {
    this.subagentContext.reset();
    this.events.onStatusChange('idle');
  }

  /** Extract a short summary from tool input for the question prompt. */
  private summarizeToolInput(toolName: string, toolInput: Record<string, unknown>): string | null {
    if (!toolInput || typeof toolInput !== 'object') return null;
    const lower = toolName.toLowerCase();

    const get = (key: string): unknown => toolInput[key];

    // Bash: show the command
    if (lower === 'bash' || lower === 'terminal') {
      const cmd = get('command') ?? get('cmd');
      if (typeof cmd === 'string') {
        return cmd.length > 120 ? `${cmd.slice(0, 117)}...` : cmd;
      }
    }

    // Read/Write/Edit: show the file path
    if (lower === 'read' || lower === 'write' || lower === 'edit') {
      const path = get('file_path') ?? get('path');
      if (typeof path === 'string') return path;
    }

    // Glob/Grep: show the pattern
    if (lower === 'glob' || lower === 'grep') {
      const pattern = get('pattern') ?? get('glob');
      if (typeof pattern === 'string') return pattern;
    }

    // WebFetch: show the URL
    if (lower.includes('fetch') || lower.includes('web')) {
      const url = get('url');
      if (typeof url === 'string') return url;
    }

    // Generic: try common field names
    for (const key of ['command', 'file_path', 'path', 'url', 'description']) {
      const val = get(key);
      if (typeof val === 'string' && val.length > 0) {
        return val.length > 120 ? `${val.slice(0, 117)}...` : val;
      }
    }

    return null;
  }
}
