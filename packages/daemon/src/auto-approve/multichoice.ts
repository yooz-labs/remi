/**
 * Multi-choice permission detector and prompt builder (#399).
 *
 * A `PermissionRequest` is "multi-choice" when its `permission_suggestions`
 * lists pickable UI options that the binary approve/deny path cannot
 * express. Classification considers only STRING entries — object entries
 * (e.g. `{type:"addRules",...}`, `{type:"addDirectories",...}`,
 * `{type:"setMode",...}`) are rule-suggestion metadata Claude Code attaches
 * to a standard Yes/Yes-always/No prompt and are NOT pickable options.
 * The classifier walks three rules:
 *
 * 1. Tool name. `ExitPlanMode` is always multi-choice: the user's intent
 *    (continue planning, accept plan, accept and stop asking) cannot be
 *    derived from tool input, so the LLM should never auto-pick.
 * 2. String-label count > 3: a custom plugin tool with 4+ string choices
 *    cannot be expressed in the approve/deny mapping at all.
 * 3. String-label shape: any 2- or 3-label set whose labels are not all
 *    yes/no-shaped (matching the daemon's existing `isYes`/`isNo`
 *    heuristic at `hook-event-bridge.ts:240-241`) is multi-choice.
 *
 * Edit's real `["Yes", "Always", "No"]` shape is correctly classified as
 * binary because every label is yes-shaped or no-shaped under the same
 * heuristic the hook bridge already uses for option metadata. A
 * `[{type:"addRules",...}]` payload is binary because it carries zero
 * string labels — the UI prompt is the default Yes/Yes-always/No.
 */

import type { ChatMessage } from './llm-client.ts';

/**
 * Tools that always route through multi-choice handling regardless of
 * `permission_suggestions` shape. Add tools here when their prompts
 * encode user-intent the auto-approve LLM cannot infer (planning,
 * direction, scope decisions).
 */
const ALWAYS_MULTI_CHOICE_TOOLS: ReadonlySet<string> = new Set(['ExitPlanMode']);

/**
 * True when a label reads as a yes/no answer, mirroring the heuristic
 * `hook-event-bridge.ts` uses to set `isYes`/`isNo` flags on options.
 * Tolerates the `Allow`/`Always`/`Deny`/`Reject` synonyms that real
 * Claude Code tools emit (Edit's `["Yes", "Always", "No"]` is the
 * common case).
 */
function isBinaryShapedLabel(label: string): boolean {
  const lower = label.toLowerCase().trim();
  if (lower.startsWith('yes')) return true;
  if (lower.startsWith('no')) return true;
  return lower === 'allow' || lower === 'always' || lower === 'deny' || lower === 'reject';
}

/**
 * Returns true when the permission cannot be answered by the binary
 * approve/deny path. Handles the three cases listed in the module doc.
 *
 * `permissionSuggestions` may be undefined (default 3-set substitutes)
 * or a mixed array of strings (pickable UI labels) and objects (typed
 * rule-suggestion metadata such as `{type:"addRules",...}`). Only the
 * STRING entries are pickable; object entries co-exist with the standard
 * Yes/Yes-always/No prompt and must not flip the classification to
 * multi-choice.
 */
export function isMultiChoicePermission(
  toolName: string,
  permissionSuggestions: readonly unknown[] | null | undefined,
): boolean {
  if (ALWAYS_MULTI_CHOICE_TOOLS.has(toolName)) return true;
  if (!permissionSuggestions || permissionSuggestions.length === 0) return false;
  const stringLabels = permissionSuggestions.filter(
    (s): s is string => typeof s === 'string' && s.trim().length > 0,
  );
  // Object-only payload (rule-suggestion metadata, no pickable labels):
  // UI shows the default Yes/Yes-always/No, so this is binary.
  if (stringLabels.length === 0) return false;
  if (stringLabels.length > 3) return true;
  // 2- or 3-label lists: binary only when every label is yes/no-shaped.
  return !stringLabels.every(isBinaryShapedLabel);
}

const MULTI_CHOICE_SYSTEM_PROMPT = `You are a permission evaluator for Claude Code, an AI coding assistant running inside Remi (a remote monitoring tool).

Claude Code is asking the user to PICK ONE option from a numbered list. Your job is to choose the most appropriate option, OR escalate to the user when you cannot decide confidently.

ALWAYS ESCALATE — only the user can answer these:
- Direction / planning / scope: "continue planning", "accept plan", "switch to phase 2", "narrow the scope to just X"
- Design or architecture choices: "use library A vs B", "this approach vs that approach", "store it here vs there"
- Steering or strategic intent: "should we proceed", "is this what you wanted", "ready to ship"
- Any option whose effect is irreversible or has session-wide permanence (labels mentioning "always", "permanent", "for this session", "remember this")
- Anything where two or more options are plausibly correct and the right pick depends on the user's goal

PICK an option ONLY when:
- One option is the clear routine default for this tool/input — the choice a careful developer makes on autopilot
- The action is mechanical and reversible (e.g., picking the local mirror vs the remote one for a read-only fetch)
- No option has design, scope, or directional consequences

OTHER RULES:
1. Read EVERY option carefully before deciding. Do not assume option 1 is always correct.
2. When in doubt, escalate. It is always better to ask than to commit to the wrong option.
3. Indices are 1-based and must point to one of the listed options.

Respond with JSON ONLY. No markdown, no explanation outside JSON. Two valid shapes:

{"decision": "pick", "index": 2, "reasoning": "brief explanation referencing the chosen option's label"}
{"decision": "escalate", "reasoning": "brief explanation"}`;

/**
 * Build the chat messages for multi-choice evaluation. The user message
 * lists each option on its own line with its 1-based index so the LLM
 * can refer to a specific choice.
 */
export function buildMultiChoicePrompt(
  toolName: string,
  toolInput: Record<string, unknown>,
  options: readonly string[],
  instructions?: string,
): readonly ChatMessage[] {
  const inputStr = JSON.stringify(toolInput, null, 2);
  const truncatedInput = inputStr.length > 2000 ? `${inputStr.slice(0, 1997)}...` : inputStr;
  const renderedOptions = options.map((label, idx) => `  ${idx + 1}. ${label}`).join('\n');
  const userMessage = `Tool: ${toolName}\nInput: ${truncatedInput}\n\nOptions:\n${renderedOptions}`;

  const trimmedInstructions = instructions?.trim() ?? '';
  const systemContent = trimmedInstructions
    ? `${MULTI_CHOICE_SYSTEM_PROMPT}\n\nUSER-SPECIFIC GUIDANCE (overrides/refines the defaults above):\n${trimmedInstructions}`
    : MULTI_CHOICE_SYSTEM_PROMPT;

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userMessage },
  ];
}

/**
 * Parse a multi-choice LLM response. Returns either a validated pick
 * (1-based index within `optionCount`) or escalate. Three failure modes
 * are distinguished in the reasoning so a future debugger can tell
 * "LLM returned junk" from "LLM said approve when it should have picked"
 * from "JSON parse error" without re-running the prompt.
 */
export function parseMultiChoiceDecision(
  raw: string,
  optionCount: number,
):
  | { decision: 'pick'; index: number; reasoning: string }
  | { decision: 'escalate'; reasoning: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const e = err as Error;
    return {
      decision: 'escalate',
      reasoning: `Unparsable multi-choice response (${e.name}: ${e.message}): ${raw.slice(0, 100)}`,
    };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return {
      decision: 'escalate',
      reasoning: `Multi-choice response was not a JSON object: ${raw.slice(0, 100)}`,
    };
  }

  const obj = parsed as Record<string, unknown>;
  const decisionStr = String(obj['decision'] ?? '').toLowerCase();
  const reasoning = String(obj['reasoning'] ?? '');

  if (decisionStr === 'escalate') {
    return { decision: 'escalate', reasoning };
  }
  if (decisionStr === 'pick') {
    const idx = Number(obj['index']);
    if (Number.isInteger(idx) && idx >= 1 && idx <= optionCount) {
      return { decision: 'pick', index: idx, reasoning };
    }
    return {
      decision: 'escalate',
      reasoning: `LLM picked out-of-range index ${obj['index']} for ${optionCount} options; ${reasoning}`,
    };
  }

  // Well-formed JSON object with the wrong decision string. Distinct from
  // a JSON parse failure so log triage can tell the two apart.
  return {
    decision: 'escalate',
    reasoning: `Invalid multi-choice decision "${decisionStr}"; expected "pick" or "escalate"`,
  };
}
