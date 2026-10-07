/**
 * Multi-choice and design-question permission detectors (#399, #572).
 *
 * Since #1125 (ADR 0030) these only classify how an escalation is relayed:
 * a binary prompt's hook is held for the phone's answer (#1126), anything
 * these detectors flag is answered 'passthrough' and pushed immediately
 * (`AutoApproveGate.holdKindFor`). AskUserQuestion and ExitPlanMode never
 * reach them: the gate holds both by name first and answers them with a
 * structured `updatedInput` (#1127). The LLM
 * multi-choice prompt builder that used to live here was deleted with the
 * evaluator.
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
 *    derived from tool input. (It is also matched by `isDesignQuestion`
 *    through `ALWAYS_ESCALATE_TOOLS`.)
 * 2. String-label count > 3: a custom plugin tool with 4+ string choices
 *    cannot be expressed in the approve/deny mapping at all.
 * 3. String-label shape: any 2- or 3-label set whose labels are not all
 *    yes/no-shaped (matching the daemon's existing `isYes`/`isNo`
 *    heuristic in `hook-event-bridge.ts`) is multi-choice. A single
 *    non-binary string label is treated as multi-choice and routed to
 *    escalate (no meaningful pick from a 1-item menu).
 *
 * Edit's real `["Yes", "Always", "No"]` shape is correctly classified as
 * binary because every label is yes-shaped or no-shaped under the same
 * heuristic the hook bridge already uses for option metadata. A
 * `[{type:"addRules",...}]` payload is binary because it carries zero
 * string labels — the UI prompt is the default Yes/Yes-always/No.
 */

/**
 * Tools whose invocation is, by definition, a request for the user's intent
 * (#572): `AskUserQuestion` (Claude explicitly solicited the user) and
 * `ExitPlanMode` (plan-mode accept / keep-planning is a direction decision).
 * `isDesignQuestion` classifies them as design questions. Since #1127 the
 * gate holds both by name before it asks, so this set no longer changes
 * their routing; it stays the allowlist layer of `isDesignQuestion`. Was the
 * configurable `auto_approve.always_escalate_tools` default until #1125
 * removed the `[auto_approve]` table; now internal.
 */
export const ALWAYS_ESCALATE_TOOLS: ReadonlySet<string> = new Set([
  'AskUserQuestion',
  'ExitPlanMode',
]);

/**
 * Tools that always route through multi-choice handling regardless of
 * `permission_suggestions` shape: their prompts encode user intent
 * (planning, direction, scope decisions), never a plain allow/deny.
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
  // 1-label edge case: only valid as binary if the single label is
  // yes/no-shaped (a lone "Yes"). Anything else (e.g. ["Continue"])
  // has no meaningful binary mapping and routes to multi-choice so
  // the safe escalate path runs.
  // 2- or 3-label lists: binary only when every label is yes/no-shaped.
  return !stringLabels.every(isBinaryShapedLabel);
}

/**
 * Keys under which a tool carries a user-facing question in its `tool_input`.
 * Deliberately narrow — only structured question fields, never a Bash command
 * string — so a `Bash` command ending in "?" is not mistaken for a question.
 */
const QUESTION_INPUT_FIELDS: readonly string[] = ['question', 'questions'];

function isNonEmptyString(v: unknown): boolean {
  return typeof v === 'string' && v.trim().length > 0;
}

/**
 * A question-bearing value: a non-empty string, or a non-empty array whose
 * elements are question strings or `{question: string}` objects (the real
 * AskUserQuestion shape). A bare array of numbers / null / `{}` is NOT a
 * question, so a custom tool with an unrelated field named `questions` is not
 * wrongly escalated.
 */
function isQuestionLike(v: unknown): boolean {
  if (isNonEmptyString(v)) return true;
  if (Array.isArray(v)) {
    return v.some(
      (item) =>
        isNonEmptyString(item) ||
        (item !== null &&
          typeof item === 'object' &&
          isNonEmptyString((item as { question?: unknown }).question)),
    );
  }
  return false;
}

function hasQuestionField(toolInput: Record<string, unknown> | null | undefined): boolean {
  if (!toolInput) return false;
  return QUESTION_INPUT_FIELDS.some((key) => isQuestionLike(toolInput[key]));
}

/**
 * True when a permission is a design / plan-mode / long-form question, not a
 * plain allow/deny (#572), so its card is pushed immediately rather than on
 * its render. Two layers:
 *
 * 1. Tool-name allowlist (`alwaysEscalateTools`, `ALWAYS_ESCALATE_TOOLS` in
 *    production): definitionally user-intent tools. Immune to tool_input
 *    shape drift.
 * 2. Free-text heuristic: a tool that structurally carries a question field
 *    (see `QUESTION_INPUT_FIELDS`) whose suggestions are not all yes/no-shaped
 *    is a long-form question with no binary mapping. Catches MCP / custom tools
 *    that mimic AskUserQuestion without being on the allowlist.
 */
export function isDesignQuestion(
  toolName: string,
  toolInput: Record<string, unknown> | null | undefined,
  permissionSuggestions: readonly unknown[] | null | undefined,
  alwaysEscalateTools: ReadonlySet<string>,
): boolean {
  if (alwaysEscalateTools.has(toolName)) return true;
  if (!hasQuestionField(toolInput)) return false;
  const stringLabels = Array.isArray(permissionSuggestions)
    ? permissionSuggestions.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
    : [];
  // A question with no binary-shaped suggestions has no approve/deny mapping —
  // the user must select or type a long-form answer.
  return stringLabels.length === 0 || !stringLabels.every(isBinaryShapedLabel);
}
