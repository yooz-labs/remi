/**
 * Bridges Claude Code hook events to Remi's status/question system.
 *
 * Maps hook events to the same AgentStatus and Question types that
 * the OutputProcessor previously produced from terminal parsing.
 * This is the hook-based replacement for terminal output parsing.
 *
 * Permission question flow (verified from real hook logs 2026-04-12, updated
 * #718 for structured suggestions observed 2026-07-06; #890/Q5 2026-07-29):
 *   - PermissionRequest fires with tool_name, tool_input, and optionally
 *     permission_suggestions. This is either a legacy plain-string label set
 *     (e.g. ["Yes","Always","No"] for Edit) OR, since ~Claude Code 2.0.54, a
 *     STRUCTURED array of typed entries (`addRules`, `addDirectories`,
 *     `setMode`, ...) — see `optionsFromSuggestions` for how each shape maps
 *     to options (by meaning since #1126: Yes, the offerable standing grants,
 *     No). With nothing offerable, the honest Yes/No 2-set substitutes. This
 *     is the ONLY event that forwards a Question to `onQuestion` for a
 *     permission prompt (see `handlePermissionRequest`).
 *   - Notification(permission_prompt) fires shortly after with a plain-text
 *     message like "Claude needs your permission to use Bash" (no numbered
 *     options; those appear only in the terminal UI). It no longer
 *     synthesizes a second `Question` (#890, Q5: the
 *     `tracker.recordPendingHook` stash it fed was a stash-only safety net,
 *     immediately superseded whenever paired with the richer
 *     PermissionRequest above, and a capture corpus — 4244 events / 5
 *     sessions / one day — found 68/68 pairs, 0 unpaired; see
 *     `handleNotification` for the full argument and the residual-failure-
 *     mode analysis). It still flips status to `'waiting'`.
 */

import { DEFAULT_PERMISSION_LABELS, generateId } from '@remi/shared';
import type { AgentStatus, Question, QuestionOption, UUID } from '@remi/shared';
import type { QuestionRegistrationOutcome } from '../api/message-api.ts';
import { isMultiChoicePermission } from '../auto-approve/multichoice.ts';
import type { HookServerEvents } from './hook-server.ts';
import type {
  ElicitationHookInput,
  NotificationHookInput,
  PermissionRequestHookInput,
  PostToolUseFailureHookInput,
  PostToolUseHookInput,
  PreToolUseHookInput,
  SessionEndHookInput,
  StopFailureHookInput,
  StopHookInput,
  SubagentStartHookInput,
  SubagentStopHookInput,
} from './hook-types.ts';
import { SubagentContextTracker } from './subagent-context-tracker.ts';
import { extractToolQuestion } from './tool-question.ts';
import { summarizeToolInput } from './tool-summary.ts';

export interface HookBridgeEvents {
  /**
   * `agentId` is the hook event's own `agent_id` (#1140): set when the event
   * came from a background subagent or teammate, absent for the main agent.
   * The status pipeline maps every PreToolUse/PostToolUse/SubagentStart to a
   * status, so without it a subagent's tool call looked like the main agent
   * moving on, and the tracker cleared the menu the main dialog still shows.
   */
  onStatusChange: (status: AgentStatus, context?: string, agentId?: string) => void;
  /**
   * Returns the `QuestionRegistrationOutcome` (#888 criterion iii) when the
   * implementation routed `question` through `MessageAPI.handleQuestion` --
   * the ordinary direct-emit path every question source but
   * 'permission_request' takes. A 'permission_request' question is instead
   * stashed via `QuestionPresenceTracker.recordPendingHook` (no
   * `handleQuestion` call happens at hook time; that question is not
   * registered until a later PTY render pairs with it), so implementations
   * return `undefined` for that branch. `handleElicitation`'s caller
   * (`hook-bridge-setup.ts`'s `Elicitation` listener) consumes this directly
   * instead of re-querying `SessionRegistry` after the fact (#925 gate).
   * `| undefined` (not `| void` -- this codebase's lint config forbids `void`
   * inside a union) covers every implementation that does not care about the
   * outcome (`handlePermissionRequest`, `handleStopFailure`, and every test
   * double that only collects emitted questions).
   */
  onQuestion: (question: Question) => QuestionRegistrationOutcome | undefined;
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
 *  budget: every category has at most 4 actions, and `selectPushCategory`
 *  gives nothing beyond 4 a category). Yes and No are always
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
 * Disambiguate duplicate labels after truncation (#718 review). Two
 * suggestions that share their first ~80 characters (e.g. two long `Bash`
 * commands with the same prefix) would otherwise truncate to the IDENTICAL
 * label. That is not just cosmetic: the lock-screen relay posts back the
 * option's LABEL, and `resolveOption` (input-events.ts) matches an incoming
 * answer by label before falling back to value, so a duplicate label would
 * let the answer resolve to the WRONG option — echoing a different
 * `permission_suggestions` entry (`suggestionIndex`) than the one the user
 * actually picked. Appends " (2)", " (3)", ... to the 2nd+ occurrence of a
 * duplicate, re-truncating the base so the total still fits the cap.
 */
function disambiguateLabels(labels: readonly string[]): string[] {
  const seenCounts = new Map<string, number>();
  return labels.map((label) => {
    const occurrence = (seenCounts.get(label) ?? 0) + 1;
    seenCounts.set(label, occurrence);
    if (occurrence === 1) return label;
    const suffix = ` (${occurrence})`;
    const maxBaseLength = SUGGESTION_LABEL_MAX - suffix.length;
    const base = label.length > maxBaseLength ? label.slice(0, maxBaseLength) : label;
    return `${base}${suffix}`;
  });
}

/**
 * The standing grant a structured `permission_suggestions` entry offers on a
 * held card, and the `updatedPermissions` entry a phone answer sends back for
 * it (#1126). Options are built by MEANING, never by position: Claude's
 * dialog does not render one option per suggestion (#1134), so a
 * suggestion's index says nothing about the screen.
 *
 * Only two kinds are offered, both verified live (Claude Code 2.1.287, #1126
 * spike F4), and every echo is forced to `destination: "session"` (lead
 * decision): a phone tap must never write a settings file.
 *   - `setMode`: the mode change takes effect for this session (Claude
 *     suggests it with `destination: "session"` already).
 *   - `addRules` with `behavior: "allow"`: Claude suggests `localSettings`,
 *     which would write the rule into the project's settings file; the echo
 *     grants it for this session, and the label says so.
 * Never `addDirectories` (its echo did not stop the repeat prompt in F4), a
 * deny or ask `addRules`, the narrowing types (`removeRules`,
 * `replaceRules`, `removeDirectories`), or a type Claude Code has not
 * documented. Returns null for those.
 */
export function standingGrantFor(entry: unknown): {
  readonly label: string;
  readonly kind: 'addRules' | 'setMode';
  readonly echo: Record<string, unknown>;
} | null {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  if (e['type'] === 'setMode') {
    const mode = e['mode'];
    if (typeof mode !== 'string' || mode.length === 0) return null;
    return {
      label: truncateLabel(`Yes, and switch to ${mode} mode`),
      kind: 'setMode',
      echo: { ...e, destination: 'session' },
    };
  }
  if (e['type'] === 'addRules') {
    if (e['behavior'] !== 'allow') return null;
    const rules = Array.isArray(e['rules']) ? e['rules'] : [];
    const parts = rules
      .map((rule): string | undefined => {
        if (typeof rule !== 'object' || rule === null) return undefined;
        const ruleContent = (rule as Record<string, unknown>)['ruleContent'];
        const toolName = (rule as Record<string, unknown>)['toolName'];
        if (typeof ruleContent === 'string' && ruleContent.length > 0) return ruleContent;
        return typeof toolName === 'string' && toolName.length > 0 ? toolName : undefined;
      })
      .filter((p): p is string => p !== undefined);
    if (parts.length === 0) return null;
    // Truncate the rule text, never the scope: the label must keep saying
    // "for this session" however long the command is. Four characters stay
    // free so `disambiguateLabels` can append " (2)" without cutting it.
    const suffix = ' for this session';
    const prefix = 'Yes, allow ';
    const room = SUGGESTION_LABEL_MAX - prefix.length - suffix.length - 4;
    const joined = parts.join(', ');
    const shown = joined.length > room ? `${joined.slice(0, room - 3)}...` : joined;
    return {
      label: `${prefix}${shown}${suffix}`,
      kind: 'addRules',
      echo: { ...e, destination: 'session' },
    };
  }
  return null;
}

/** Result of {@link optionsFromSuggestions}: the options to render, and
 *  whether they are the honest fallback rather than a real derived set. */
export interface PermissionOptionsResult {
  readonly options: QuestionOption[];
  /** True when `options` is the {@link DEFAULT_PERMISSION_OPTIONS} fallback
   *  (#718): no usable suggestion contributed a middle option. Threaded onto
   *  the emitted `Question` as `optionsAreFallback` for the dedup and client
   *  guards that treat it as the bland default. */
  readonly isFallback: boolean;
}

/**
 * Build a permission card's options from a PermissionRequest's
 * `permission_suggestions`.
 *
 * Two shapes:
 *   - A multi-choice string-label set (`isMultiChoicePermission`: more than
 *     three labels, or labels that are not all yes/no-shaped) maps label by
 *     label to picks, unchanged since #574. Such a card is pushed by id and
 *     answered through the PTY, like AskUserQuestion (Phase 4 work).
 *   - Everything else is a binary prompt, answered through the held hook
 *     (#1126): [Yes] + one standing option per offerable suggestion
 *     ({@link standingGrantFor}) + [No], built by meaning so each option maps
 *     to a hook response, not to a digit on Claude's screen. Capped at
 *     {@link MAX_PERMISSION_OPTIONS}: the first offerable suggestions are
 *     kept. A legacy all-binary string set (Edit's `["Yes","Always","No"]`)
 *     lands here too: its "Always" names no suggestion to echo, so it is not
 *     offered. With no offerable suggestion, the honest Yes/No fallback
 *     (`isFallback: true`).
 * Exported so the mapping is unit-testable independent of the bridge.
 */
export function optionsFromSuggestions(suggestions: unknown): PermissionOptionsResult {
  const entries = Array.isArray(suggestions) ? suggestions : [];
  const stringSuggestions = entries.filter(
    (s): s is string => typeof s === 'string' && s.length > 0,
  );
  if (stringSuggestions.length >= 2 && isMultiChoicePermission('', entries)) {
    const options = stringSuggestions.map((suggestion, idx) => {
      const lower = suggestion.toLowerCase();
      const isYes = lower.startsWith('yes') || lower === 'allow' || lower === 'always';
      const isNo = lower.startsWith('no') || lower === 'deny' || lower === 'reject';
      return { label: suggestion, value: String(idx + 1), isRecommended: idx === 0, isYes, isNo };
    });
    return { options, isFallback: false };
  }

  const standing: { label: string; suggestionIndex: number; kind: 'addRules' | 'setMode' }[] = [];
  entries.forEach((entry, idx) => {
    if (typeof entry !== 'object' || entry === null) return;
    const grant = standingGrantFor(entry);
    if (grant === null) {
      console.debug(
        `[HookEventBridge] Not offering permission_suggestions[${idx}] (type=${String((entry as Record<string, unknown>)['type'])})`,
      );
      return;
    }
    standing.push({ label: grant.label, suggestionIndex: idx, kind: grant.kind });
  });

  if (standing.length === 0) {
    return { options: [...DEFAULT_PERMISSION_OPTIONS], isFallback: true };
  }

  const maxMiddle = MAX_PERMISSION_OPTIONS - 2; // Yes + No are always present
  if (standing.length > maxMiddle) {
    console.warn(
      `[HookEventBridge] ${standing.length} offerable permission_suggestions exceed the ${MAX_PERMISSION_OPTIONS}-option card budget; keeping the first ${maxMiddle}`,
    );
  }
  const kept = standing.slice(0, maxMiddle);
  // Two suggestions can truncate to the same label; the answer path matches
  // an incoming answer by label, so labels must stay distinct (#718 review).
  const keptLabels = disambiguateLabels(kept.map((k) => k.label));

  let value = 1;
  const options: QuestionOption[] = [
    { label: 'Yes', value: String(value++), isRecommended: true, isYes: true, isNo: false },
    ...kept.map((k, i) => ({
      label: keptLabels[i] as string,
      value: String(value++),
      isRecommended: false,
      isYes: true,
      isNo: false,
      suggestionIndex: k.suggestionIndex,
      standingGrant: k.kind,
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
    this.events.onStatusChange('executing', input.tool_name, input.agent_id);
  }

  handlePostToolUse(input: PostToolUseHookInput): void {
    this.subagentContext.onPostToolUse(input.tool_name, input.tool_use_id);
    this.events.onStatusChange('thinking', undefined, input.agent_id);
  }

  handleNotification(input: NotificationHookInput): void {
    if (input.notification_type === 'permission_prompt') {
      // #925/#890 (Q5): the `source: 'notification'` Question synthesis that
      // used to live here was DELETED after the capture gate closed it out.
      // `hook-bridge-setup.ts`'s `onQuestion` callback routed BOTH
      // 'permission_request' and 'notification' sources to
      // `tracker.recordPendingHook`, which only STASHES (no push of its own —
      // verified by reading the method body: it touches only `this.pending`,
      // never the push sink). The stash existed purely as a safety net for
      // the case where this Notification arrives with NO paired
      // PermissionRequest for the same prompt; a paired PermissionRequest's
      // OWN richer stash is never evicted by a later Notification
      // (`recordPendingHook`'s "richer wins" rule), so in the paired case
      // this stash was always dead weight, immediately superseded.
      //
      // Capture data (`~/.remi/hook-diag.jsonl`, re-verified for this PR):
      // 4244 events / 5 sessions / one working day (2026-07-29, ~11h span) —
      // 68 permission_prompt Notifications, 68 paired with a PermissionRequest
      // by `prompt_id`, 0 UNPAIRED. 171 PermissionRequests (73 subagent-
      // tagged) across Bash/Monitor/AskUserQuestion/Skill/WebFetch/three
      // mcp__claude-in-chrome__* tools — the workflow coverage the capture
      // gate needed. Still only one day on one machine; stated here as a
      // caveat, not resolved by this change.
      //
      // Residual failure mode (argued, not assumed): if a permission_prompt
      // Notification ever DOES arrive unpaired, two sub-cases:
      //   - the prompt never renders on the PTY either -> no observable
      //     effect before OR after this change (the pre-existing stash was
      //     never pushed on its own regardless).
      //   - the prompt DOES render -> `QuestionPresenceTracker.consumeAndMerge`
      //     finds no stashed hookRecord for it and falls through to the bare
      //     PTY-parsed question (`source: 'pty'`) via the SAME orphan-PTY
      //     fallback every other genuinely hook-less prompt already uses
      //     (subagent native prompts, #712) — not "nothing", and arguably
      //     RICHER than the deleted synthesis's generic "Claude needs your
      //     permission to use Bash" text would have contributed pre-#887's
      //     "hook text wins" merge rule.
      // `onStatusChange('waiting')` below is deliberately KEPT (not deleted
      // with the Question): idempotent in the paired case (PermissionRequest
      // already set 'waiting' moments earlier, per this file's own module
      // doc), and it remains the only wait-signal at all for the theoretical
      // unpaired case above.
      this.events.onStatusChange('waiting', undefined, input.agent_id);
    } else if (input.notification_type === 'idle_prompt') {
      this.events.onStatusChange('idle', undefined, input.agent_id);
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
      this.events.onStatusChange('idle', undefined, input.agent_id);
      // Agent turn is done; clear any orphaned subagent tracking so a dropped
      // PostToolUse(Task) can't permanently block the user's permission prompts.
      this.subagentContext.reset();
    }
  }

  /**
   * Build + emit the escalation Question for a PermissionRequest and return its
   * id (#573). The id lets the permission gate push the question and track
   * its signature for external resolution. Always returns an id today.
   */
  handlePermissionRequest(input: PermissionRequestHookInput): UUID {
    // Phase 4 (#419): the subagentContext drop previously sat here.
    // After phase 3 wired in the QuestionPresenceTracker, push semantics
    // are presence-gated regardless of subagent context — a subagent
    // prompt that does not render on the user's PTY does not push, and
    // one that does is genuinely answerable. The tracker handles both
    // cases; this method now only builds the question payload.
    const question = this.buildPermissionQuestion(input);
    this.events.onQuestion(question);
    this.events.onStatusChange('waiting', undefined, input.agent_id);
    return question.id;
  }

  /**
   * Build the rich Question payload for a PermissionRequest WITHOUT firing the
   * onQuestion/onStatusChange side effects. Used by `handlePermissionRequest`
   * (escalation: push + register) and by the gate's #751 PTY-arbiter parking
   * (`QuestionPresenceTracker.parkAwaitingPTY`), where the question must only
   * surface if Claude's native prompt actually renders on the PTY.
   */
  buildPermissionQuestion(input: PermissionRequestHookInput): Question {
    const toolName = input.tool_name || 'unknown tool';

    // Question-bearing tools (AskUserQuestion, ExitPlanMode) carry the real
    // question + option labels in tool_input; surface those instead of the
    // generic "Allow <tool>" + whatever optionsFromSuggestions derives (or the
    // honest Yes/No 2-set, #718; #597). The options are picks (1-based value,
    // never isYes/isNo) so a user answer submits the matching digit to
    // Claude's native numbered prompt.
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
      const inputSummary = summarizeToolInput(toolName, input.tool_input);
      // The action carries the command/path/pattern context (#497).
      const action = inputSummary ? `${toolName}: ${inputSummary}` : toolName;
      // A subagent prompt names the agent, e.g.
      // "code-reviewer · Bash: git push origin main" vs "Allow Bash: ...".
      promptText = input.agent_type ? `${input.agent_type} · ${action}` : `Allow ${action}`;
      const built = optionsFromSuggestions(input.permission_suggestions);
      options = built.options;
      optionsAreFallback = built.isFallback;
    }

    return {
      id: generateId(),
      text: promptText,
      options,
      allowsFreeText: false,
      isAnswered: false,
      agentId: input.agent_id,
      // #887: same-turn correlation key, see `Question.promptId`.
      promptId: input.prompt_id,
      // Rich source: carries tool + command + agent context. The tracker
      // keeps this over a trailing generic notification for the same agent (#574).
      source: 'permission_request',
      // #718: marks the bare fallback set for the dedup and client guards
      // (`question-dedup.ts`, the web `question-merge.ts`). The tracker's
      // merge no longer needs it: since #1134 a PTY parse's options always
      // replace this question's, fallback or not.
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
    };
  }

  handlePostToolUseFailure(input: PostToolUseFailureHookInput): void {
    this.events.onStatusChange(
      'executing',
      `${input.tool_name} failed: ${input.error}`,
      input.agent_id,
    );
  }

  handleSubagentStart(input: SubagentStartHookInput): void {
    this.events.onStatusChange('executing', `subagent:${input.agent_type}`, input.agent_id);
  }

  handleSubagentStop(input: SubagentStopHookInput): void {
    this.events.onStatusChange('thinking', undefined, input.agent_id);
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
      // #887: same-turn correlation key, see `Question.promptId`.
      promptId: input.prompt_id,
    };
    this.events.onQuestion(question);
    this.events.onStatusChange('waiting', undefined, input.agent_id);
  }

  /**
   * Build + emit the answerable card for an MCP `Elicitation` dialog (#889,
   * Q4). Previously this arrived only as a PTY orphan: the dedicated
   * `Elicitation` hook was never registered (so it never fired at all), and
   * the generic `Notification(elicitation_dialog)` variant that DID fire was
   * logged and ignored (see `handleNotification` above).
   *
   * Deliberately observe-only: no fixed Accept/Decline/Cancel options are
   * fabricated. Claude Code's own TUI is already rendering SOME interactive
   * prompt for the dialog (that is what makes it a "PTY orphan" today, not a
   * silent hang), and this codebase has no live capture of what that prompt's
   * own on-screen convention is (numbered choice? y/n? something else? — see
   * `docs/claude-code-hook-contract.md` "What's pending"). Fabricating
   * Accept/Decline options here would type a GUESSED literal string onto the
   * PTY via the generic answer path (`input-events.ts`'s
   * `resolveOption(...)?.value ?? answer`), which is worse than the orphan
   * this is fixing if the guess is wrong. Instead: `options: []` +
   * `allowsFreeText: true` — already a supported, tested shape
   * (`question-parser.ts` uses it for PTY-detected free-text prompts, and
   * `QuestionCard.tsx` already renders a free-text row for zero options) — so
   * the card surfaces the dialog's own text and lets the user type whatever
   * they would have typed sitting at the terminal, submitted verbatim
   * (`ptyInput = resolveOption(...)?.value ?? answer` falls through to the
   * raw answer when no option matches).
   *
   * Returns the created Question's id so `hook-bridge-setup.ts` can correlate
   * a later `ElicitationResult` (matched by `elicitation_id`, an exact key
   * both events carry) to resolve this exact card — the same "don't leave a
   * pending card with no resolution signal" shape as `PermissionDenied`.
   * Also returns the `QuestionRegistrationOutcome` `onQuestion` reported for
   * this exact call (#888 criterion iii), so the caller can tell whether the
   * card actually registered WITHOUT a separate `SessionRegistry` re-query
   * (`rememberElicitation`'s "was not registered" guard, `hook-bridge-setup.ts`).
   */
  handleElicitation(input: ElicitationHookInput): {
    questionId: UUID;
    outcome: QuestionRegistrationOutcome | undefined;
  } {
    const question: Question = {
      id: generateId(),
      text: input.message
        ? `${input.mcp_server_name}: ${input.message}`
        : `${input.mcp_server_name} is requesting input`,
      options: [],
      allowsFreeText: true,
      isAnswered: false,
      agentId: input.agent_id,
      // #887: same-turn correlation key, see `Question.promptId`.
      promptId: input.prompt_id,
      // #889: NOT 'permission_request'/'notification' -- the onQuestion
      // callback in hook-bridge-setup.ts only stashes those two sources via
      // the PTY-arbiter tracker; every other source (this one included)
      // direct-emits, same as a source-less StopFailure card.
      source: 'elicitation',
    };
    const outcome = this.events.onQuestion(question);
    this.events.onStatusChange('waiting', undefined, input.agent_id);
    return { questionId: question.id, outcome };
  }

  handleSessionEnd(input: SessionEndHookInput): void {
    this.subagentContext.reset();
    this.events.onStatusChange('idle', undefined, input.agent_id);
  }
}
