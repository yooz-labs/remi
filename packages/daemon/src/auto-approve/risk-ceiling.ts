/**
 * The RISK CEILING, in code (#976).
 *
 * `prompt-builder.ts` states two rules the model routinely does not follow.
 * #953 closed the first one — "deny is rare" — with `enforceDenyFloor`
 * (`deny-floor.ts`): runs AFTER the model, blind to its reasoning, only ever
 * moves `deny -> escalate`. This module is that guard's mirror image, closing
 * the SECOND rule, which until now had zero enforcement behind it either:
 *
 * > remote mutations, pushes, package installs and destructive operations
 * > must escalate, never approve, unless the user's own config says otherwise.
 *
 * | guard | trigger | action |
 * |---|---|---|
 * | `enforceDenyFloor` (#953) | model said **deny**, matches no catastrophic pattern | -> escalate |
 * | `enforceRiskCeiling` (this module, #976) | model said **approve**, `classifyRisk` band is **high** or **critical** | -> escalate |
 *
 * Both only ever move toward escalate. Neither can be argued out of it by
 * confident model reasoning, because neither is given the reasoning to argue
 * with.
 *
 * ## The measurement that motivates it
 *
 * #954, live engine, shipped 4B model, `rm -rf ./build` held constant, only
 * the authority text varying, five runs each: the verdict went `deny` with no
 * authority text to **`approve` x5** on nothing stronger than "please clean
 * out the build directory, it is stale." `rm -rf ./build` is a
 * `classifyRisk` `high` band (`isDestructiveLocalOp`, risk-bands.ts) — exactly
 * the shape this module now catches directly, instead of only when authority
 * text is what tipped it.
 *
 * `classifyRisk` (`risk-bands.ts`, #976 step 2) is what makes this
 * enforceable in code rather than left as a prompt sentence: it is a pure,
 * deterministic classifier that was previously computed but never consulted
 * by any guard. This module is its first production caller.
 *
 * ## A gap wider than the one #954's authority story suggests
 *
 * `enforceAuthorityBoundary` (`authority.ts`) only runs when authority text is
 * PRESENT (`auto-approve-service.ts` guards it with
 * `authorityPresent && result.decision === 'approve'`), and the #954
 * counterfactual (`authority-counterfactual.ts`'s `shouldCounterfactual`)
 * requires the same precondition — its own body returns `false` immediately
 * when `!authorityPresent`. Verified by reading both call sites, not inferred:
 * neither guard's condition can be reached without authority text in the
 * prompt.
 *
 * That means a model `approve` of a catastrophic OR merely high-risk
 * operation reached with NO authority text at all — no conversation
 * encouragement, no `instructions` field, just the model deciding on its
 * own — was previously unguarded by anything: not `enforceDenyFloor` (only
 * ever sees `deny`), not `enforceAuthorityBoundary` or the counterfactual
 * (both gated on `authorityPresent`). This is a broader gap than "the
 * catastrophic list only fires when authority is present" — it is "nothing
 * fires when authority is absent", for the whole `high`/`critical` surface,
 * not only the eight `matchesCatastrophicPattern` substrings. This module
 * closes it unconditionally, because `classifyRisk` is a property of the
 * OPERATION, not of whether the prompt happened to carry authority text.
 *
 * In practice the gap is narrower than it sounds for the `critical` slice
 * specifically: `resolveAuthority` (`authority.ts`) falls back to the
 * transcript whenever the live store is empty, so a block is present on
 * essentially every real evaluation (ADR 0015 says the same about its own
 * "gate on authority present" alternative, and rejects it for that reason).
 * An authority-free catastrophic approve is therefore an edge case in
 * practice, not the common path — but this module does not rely on that to
 * hold; it checks the operation, not the prompt shape.
 *
 * ## Why this cannot weaken a user's explicit approval
 *
 * Config `allow` / `approve_groups` matches never reach here: they
 * short-circuit in `AutoApproveService.evaluate` and return before the LLM is
 * ever called (`auto-approve-service.ts` ~lines 706-721, checked before the
 * deny/allow/group block even finishes — this function's caller sits well
 * after that return). This guard applies to MODEL-produced approvals only,
 * which is the entire population the "must escalate unless config says
 * otherwise" rule constrains. A user who wants a high-risk operation
 * auto-approved still says so deterministically, in `allow` or
 * `approve_groups`, and this guard cannot see or touch that path.
 *
 * ## The behavior change, stated plainly (do not bury this)
 *
 * Prose `instructions` in `config.toml` reach the model and can influence its
 * verdict, and this ceiling now overrides that influence for `high`/`critical`
 * operations: **prose can no longer approve a high-risk operation. Only
 * deterministic `allow` / `approve_groups` still can.** This is a deliberate
 * narrowing, not a side effect:
 *
 * - ADR 0016 already demoted `instructions` from "policy" to "the exception
 *   layer prose is actually good at" — narrow project-specific carve-outs, not
 *   the base grant/deny surface — precisely because prose was measured not to
 *   hold as policy (35 of 226 escalations in that measurement explicitly cited
 *   the user's own `instructions` and escalated anyway).
 * - This module is the other half of that same finding applied to the
 *   opposite failure direction: prose that DOES move the model, on an
 *   operation `classifyRisk` puts at `high` or `critical`, is now capped
 *   rather than trusted, the same way ADR 0015's amendment caps what
 *   conversation text can grade authorization to (never above `implicit`,
 *   never `explicit`/`scoped`).
 *
 * ## Never produces `deny`; only ever touches `approve`
 *
 * Only ever inspects `decision === 'approve'`; every other decision — `deny`,
 * `escalate`, and (structurally, since the caller gates on `!useMultiChoice`)
 * `pick` — passes through untouched. Blind to the model's reasoning text by
 * design: `enforceRiskCeiling` does not accept a reasoning parameter at all,
 * so it cannot be swayed by a confidently-worded justification the way the
 * verdict it is re-checking already was.
 */

import { classifyRisk, riskBandAtLeast } from './risk-bands.ts';
import type { RiskBand } from './risk-bands.ts';

export interface RiskCeilingResult {
  readonly decision: 'approve' | 'deny' | 'escalate';
  /** True when this call downgraded an `approve` to an `escalate`. */
  readonly overridden: boolean;
  /** The risk band that justified the downgrade. Present only when `overridden`. */
  readonly band?: Exclude<RiskBand, 'low'>;
}

/**
 * The risk ceiling (#976). Called AFTER the LLM has produced its verdict and
 * — like `enforceDenyFloor` and `enforceAuthorityBoundary` — with no access to
 * the model's reasoning, so a confidently-worded justification cannot buy an
 * approve that `classifyRisk` does not independently support.
 *
 * Only ever moves `approve -> escalate`, and only when `classifyRisk` puts the
 * operation at `high` or `critical`. Never touches `deny` (a different
 * guard's job) or `escalate`/`pick`, and never produces an `approve` or
 * `deny` of its own.
 *
 * Applies to BINARY evaluations only. Multi-choice (`pick`) never yields an
 * `approve`, and the caller does not route it here (mirrors
 * `enforceDenyFloor`'s scope note).
 */
export function enforceRiskCeiling(
  toolName: string,
  toolInput: Record<string, unknown>,
  decision: 'approve' | 'deny' | 'escalate',
): RiskCeilingResult {
  if (decision !== 'approve') {
    return { decision, overridden: false };
  }
  const band = classifyRisk(toolName, toolInput);
  if (!riskBandAtLeast(band, 'high')) {
    return { decision, overridden: false };
  }
  return { decision: 'escalate', overridden: true, band };
}
