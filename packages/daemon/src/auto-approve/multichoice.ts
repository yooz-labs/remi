/**
 * Multi-choice permission detector and prompt builder (#399).
 *
 * A `PermissionRequest` is "multi-choice" when its `permission_suggestions`
 * cannot be answered by the binary approve/deny path:
 *
 * - More than 3 options (e.g. a custom plugin tool with 4+ choices).
 * - Exactly 3 options that are NOT the daemon's standard Yes / Yes-always
 *   / No trio (e.g. ExitPlanMode's "Approve plan" / "Approve and stay in
 *   plan mode" / "Reject plan" or any per-tool variant).
 * - Exactly 2 options that are NOT a clean Yes / No pair (e.g. a tool
 *   asking the user to pick between two non-binary alternatives).
 *
 * Standard 2-option [Yes, No] and standard 3-option [Yes, Yes-always, No]
 * are treated as binary, since approve/deny maps cleanly to option 1 / N.
 */

import { DEFAULT_PERMISSION_LABELS } from '@remi/shared';
import type { ChatMessage } from './llm-client.ts';

function normalize(label: string): string {
  return label.toLowerCase().trim();
}

function isStandardThreeSet(labels: readonly string[]): boolean {
  if (labels.length !== 3) return false;
  const expected = DEFAULT_PERMISSION_LABELS.map(normalize);
  return labels[0] === expected[0] && labels[1] === expected[1] && labels[2] === expected[2];
}

function isStandardYesNoPair(labels: readonly string[]): boolean {
  if (labels.length !== 2) return false;
  return labels[0] === 'yes' && labels[1] === 'no';
}

/**
 * Returns true when `permission_suggestions` represents a multi-choice
 * prompt the binary approve/deny mapping cannot handle.
 *
 * Returns false when suggestions are absent or undefined: that case
 * means "no suggestions, daemon will substitute the default 3-set",
 * which is binary.
 */
export function isMultiChoicePermission(
  permissionSuggestions: readonly string[] | null | undefined,
): boolean {
  if (!permissionSuggestions || permissionSuggestions.length === 0) return false;
  if (permissionSuggestions.length > 3) return true;
  const labels = permissionSuggestions.map(normalize);
  if (isStandardThreeSet(labels)) return false;
  if (isStandardYesNoPair(labels)) return false;
  return true;
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
 * (1-based index within `optionCount`) or escalate. Out-of-range or
 * malformed responses fall through to escalate so a confused LLM
 * cannot pick option 0 / option 99 / option NaN.
 */
export function parseMultiChoiceDecision(
  raw: string,
  optionCount: number,
):
  | { decision: 'pick'; index: number; reasoning: string }
  | { decision: 'escalate'; reasoning: string } {
  let parseErr: unknown = null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed === 'object' && parsed !== null) {
      const decisionStr = String(parsed.decision ?? '').toLowerCase();
      const reasoning = String(parsed.reasoning ?? '');
      if (decisionStr === 'escalate') {
        return { decision: 'escalate', reasoning };
      }
      if (decisionStr === 'pick') {
        const idx = Number(parsed.index);
        if (Number.isInteger(idx) && idx >= 1 && idx <= optionCount) {
          return { decision: 'pick', index: idx, reasoning };
        }
        return {
          decision: 'escalate',
          reasoning: `LLM picked out-of-range index ${parsed.index} for ${optionCount} options; ${reasoning}`,
        };
      }
    }
  } catch (err) {
    parseErr = err;
  }
  const errHint = parseErr ? ` [${(parseErr as Error).name}: ${(parseErr as Error).message}]` : '';
  return {
    decision: 'escalate',
    reasoning: `Unparsable multi-choice response: ${raw.slice(0, 100)}${errHint}`,
  };
}
