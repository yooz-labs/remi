/**
 * Multi-choice permission detector and prompt builder (#399).
 *
 * A `PermissionRequest` is "multi-choice" when its `permission_suggestions`
 * cannot be answered by the binary approve/deny path. We classify by:
 *
 * 1. Tool name. `ExitPlanMode` is always multi-choice: the user's intent
 *    (continue planning, accept plan, accept and stop asking) cannot be
 *    derived from tool input, so the LLM should never auto-pick.
 * 2. Option count > 3: a custom plugin tool with 4+ choices cannot be
 *    expressed in the approve/deny mapping at all.
 * 3. Label shape: any 2- or 3-option set whose labels are not all
 *    yes/no-shaped (matching the daemon's existing `isYes`/`isNo`
 *    heuristic at `hook-event-bridge.ts:240-241`) is multi-choice.
 *
 * Edit's real `["Yes", "Always", "No"]` shape is correctly classified as
 * binary because every label is yes-shaped or no-shaped under the same
 * heuristic the hook bridge already uses for option metadata.
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
 * or an array. Non-string entries cause the prompt to be classified as
 * multi-choice so the safe path (escalate or LLM with index validation)
 * runs instead of crashing on `.toLowerCase()`.
 */
export function isMultiChoicePermission(
  toolName: string,
  permissionSuggestions: readonly unknown[] | null | undefined,
): boolean {
  if (ALWAYS_MULTI_CHOICE_TOOLS.has(toolName)) return true;
  if (!permissionSuggestions || permissionSuggestions.length === 0) return false;
  if (permissionSuggestions.length > 3) return true;
  // 2- or 3-option lists: binary only when every label is yes/no-shaped.
  // Non-string entries fail the typeof check and route to multi-choice.
  return !permissionSuggestions.every(
    (label) => typeof label === 'string' && isBinaryShapedLabel(label),
  );
}

const MULTI_CHOICE_SYSTEM_PROMPT = `You are a permission evaluator for Claude Code, an AI coding assistant running inside Remi (a remote monitoring tool).

Claude Code is asking the user to PICK ONE option from a numbered list. Your job is to choose the most appropriate option, OR escalate to the user when you cannot decide confidently.

CRITICAL RULES:
1. Read EVERY option carefully before deciding. Do not assume option 1 is always correct.
2. When the choice involves direction, planning, scope, or strategic intent, ALWAYS escalate. Only the user knows the intent.
3. Pick only when one option is clearly the routine, low-risk, expected default for the tool/input combination shown.
4. When in doubt, escalate. It is better to ask the user than to commit to the wrong option.
5. Indices are 1-based and must point to one of the listed options.

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
  const decisionStr = String(obj.decision ?? '').toLowerCase();
  const reasoning = String(obj.reasoning ?? '');

  if (decisionStr === 'escalate') {
    return { decision: 'escalate', reasoning };
  }
  if (decisionStr === 'pick') {
    const idx = Number(obj.index);
    if (Number.isInteger(idx) && idx >= 1 && idx <= optionCount) {
      return { decision: 'pick', index: idx, reasoning };
    }
    return {
      decision: 'escalate',
      reasoning: `LLM picked out-of-range index ${obj.index} for ${optionCount} options; ${reasoning}`,
    };
  }

  // Well-formed JSON object with the wrong decision string. Distinct from
  // a JSON parse failure so log triage can tell the two apart.
  return {
    decision: 'escalate',
    reasoning: `Invalid multi-choice decision "${decisionStr}"; expected "pick" or "escalate"`,
  };
}
