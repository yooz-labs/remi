/**
 * The DENY FLOOR, in code (#953).
 *
 * `prompt-builder.ts` states two rules about `deny`, and until this module
 * only ONE of them had any enforcement behind it:
 *
 * 1. Authority text must never talk the model INTO approving a catastrophic
 *    operation. Enforced by `enforceAuthorityBoundary` (`authority.ts`), which
 *    downgrades `approve -> escalate`.
 * 2. **"DENY IS RARE: deny ONLY operations in the DENY FLOOR... For anything
 *    else you would not approve -- remote mutations, pushes, writes, unknown
 *    commands -- ESCALATE, never deny. Escalating lets the user answer;
 *    denying blocks them."** Enforced by nothing at all. The config `deny`
 *    list defaults to `[]`, so the model's verdict was taken at face value.
 *
 * Rule 2 matters more than it reads, because a `deny` is SILENT. It returns
 * `'deny'` to the hook (`auto-approve-gate.ts`) and pushes no question card,
 * so the user is never asked and never learns the operation was attempted.
 * An over-eager deny is therefore not "merely conservative" — it removes the
 * human from a decision that was explicitly routed to them.
 *
 * Measured on the shipped 4B model with this repo's own prompt, 16 cases:
 * **10 of 12 escalate-expected operations returned `deny`** (`rm -rf ./build`,
 * `git push --force origin main`, `DROP TABLE`, `ssh`, `curl -X DELETE`,
 * `find -delete`, ...), while all four controls were correct. The model is not
 * confused about the rule — on `rm -rf ./build` it reasoned "while not in the
 * strict DENY FLOOR" and denied anyway. A prompt instruction the model
 * restates and then does not follow is not enforcement.
 *
 * `enforceDenyFloor` closes that, mirroring the shape of the existing
 * authority guard: it runs AFTER the model decides, is blind to the model's
 * reasoning, and only ever moves in the safe direction (`deny -> escalate`).
 * It never produces a `deny` and never touches `approve`.
 *
 * ## Why this cannot weaken a user's explicit deny
 *
 * Config `deny` / `deny_groups` matches never reach here: they short-circuit
 * in `AutoApproveService.evaluate` and return before the LLM is called. This
 * guard applies to MODEL-produced denies only, which is the whole population
 * of denies that the "deny is rare" rule was written to constrain.
 */

import { matchSubstringPattern } from './pattern-matcher.ts';

/**
 * Catastrophic-operation patterns, mirroring the DENY FLOOR bullets in
 * `prompt-builder.ts`'s SYSTEM_PROMPT_BODY. Independent of user config: the
 * `deny`/`deny_groups` lists default to EMPTY (`config.ts`), so without this,
 * "the DENY FLOOR" is enforced ONLY by asking the LLM nicely — exactly the
 * mechanism a poisoned authority block could try to talk around. This list
 * covers only the crisply substring-matchable subset (the exfiltration bullet
 * needs real judgment and is deliberately NOT here) — a second, narrower
 * denylist: defense in depth on top of the prompt instruction, not a
 * replacement for it.
 *
 * Lived in `authority.ts` until #953. Moved here for the same reason #936
 * moved `isWrappedNonHumanText` out: the DENY FLOOR is not an authority
 * concern, and two guards now share this list — one for each direction across
 * it. `authority.ts` re-exports the matcher so existing consumers are
 * unaffected.
 *
 * NOTE the asymmetry this creates, and keep it in mind before widening the
 * list: adding an entry makes `enforceAuthorityBoundary` STRICTER (more
 * approves downgraded) but makes `enforceDenyFloor` LOOSER (more denies left
 * standing, so fewer questions reach the user). An entry belongs here only if
 * it is genuinely catastrophic — something that should be refused outright
 * rather than asked about.
 */
const CATASTROPHIC_PATTERNS: readonly string[] = [
  'rm -rf /',
  'sudo rm',
  'rm -rf /etc',
  'rm -rf /usr',
  'rm -rf /System',
  '| sh',
  '| bash',
  'chmod 777',
];

/** True if this tool call matches a hardcoded catastrophic pattern. Exported
 *  for tests; `enforceAuthorityBoundary` and `enforceDenyFloor` are the real
 *  call sites. */
export function matchesCatastrophicPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  return matchSubstringPattern(toolName, toolInput, CATASTROPHIC_PATTERNS);
}

export interface DenyFloorResult {
  readonly decision: 'approve' | 'deny' | 'escalate';
  /** True when this call downgraded a `deny` to an `escalate`. */
  readonly overridden: boolean;
  /** The catastrophic pattern that justified LEAVING the deny in place. */
  readonly matchedPattern?: string;
}

/**
 * The "deny is rare" rule, in code (#953). Called AFTER the LLM has produced
 * its verdict and — like `enforceAuthorityBoundary` — with no access to the
 * model's reasoning, so a confidently-worded justification cannot buy a deny
 * that the pattern list does not support.
 *
 * Only ever moves `deny -> escalate`, and only when the operation matches NO
 * catastrophic pattern. Never touches `approve` (a different guard's job) and
 * never produces a `deny` itself.
 *
 * The escalate it produces is strictly better than the deny it replaces in
 * both directions: the operation still does not run unattended, and the user
 * now gets a card they can answer instead of a block they never see.
 *
 * Applies to BINARY evaluations only. Multi-choice (`pick`) never yields a
 * `deny`, and the caller does not route it here.
 */
export function enforceDenyFloor(
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: 'approve' | 'deny' | 'escalate',
): DenyFloorResult {
  if (decision !== 'deny') {
    return { decision, overridden: false };
  }
  const matched = matchesCatastrophicPattern(toolName, toolInput);
  if (matched !== null) {
    return { decision, overridden: false, matchedPattern: matched };
  }
  return { decision: 'escalate', overridden: true };
}

/**
 * Cap on the reason text echoed to Claude. The model's own `reasoning` can run
 * long, and this rides in a hook response Claude Code parses on the blocking
 * path — bounded beats verbose.
 */
const DENY_MESSAGE_REASON_MAX = 300;

/**
 * Build the `message` for a deny that Claude will actually read (#976).
 *
 * A bare `'deny'` tells Claude only that it was refused, so its options are to
 * guess or to give up. The official hooks reference defines
 * `decision.message` as "For `deny` only: tells Claude why the permission was
 * denied" — model-directed — and leaves the turn running unless `interrupt` is
 * set, so a reason is actionable.
 *
 * Two exits are offered deliberately, in this order:
 *
 *   1. a different approach — often there is a safer equivalent, and taking it
 *      costs the user nothing;
 *   2. asking the user to authorize explicitly.
 *
 * A message that said only "ask the user" would push Claude to interrupt even
 * when a safe alternative existed. The second exit also closes the #976 loop:
 * the user's answer arrives via `UserPromptSubmit` as genuine EXPLICIT
 * authorization from a channel text cannot forge, which is the only way to get
 * above `implicit` under the ADR 0015 amendment.
 *
 * Deliberately does NOT claim Claude will ask. The docs guarantee only that it
 * is not stopped and has been told why; what it does next is its own choice.
 */
export function buildDenyMessage(reasoning?: string): string {
  const trimmed = (reasoning ?? '').trim();
  const reason =
    trimmed.length > DENY_MESSAGE_REASON_MAX
      ? `${trimmed.slice(0, DENY_MESSAGE_REASON_MAX)}…`
      : trimmed;
  const why = reason ? ` Reason: ${reason}` : '';
  return `Remi's auto-approve did not have authorization to approve this operation.${why} Either use a different approach that does not require it, or ask the user to authorize this explicitly before retrying.`;
}
