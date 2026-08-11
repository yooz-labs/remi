/**
 * Per-agent-type policy resolution (ADR 0025).
 *
 * `AutoApproveService` holds ONE base policy but serves every agent in the
 * session. This resolves "what policy applies to THIS request" from the base
 * plus an optional `[auto_approve.agents.<type>]` section.
 *
 * Pure and separate from the service for the usual reason this repo keeps
 * doing it: the merge asymmetry below is a security contract, and a contract
 * that can only be tested by standing up a whole service is a contract that
 * gets tested loosely.
 */

import { isKnownGroup, knownGroupNames } from './permission-groups.ts';
import type { AgentPolicyOverride } from './types.ts';

/** The four deterministic lists, resolved for one request. */
export interface ResolvedPolicy {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly approveGroups: readonly string[];
  readonly denyGroups: readonly string[];
}

/**
 * Resolve the policy for `agentType`.
 *
 * `agentType` is undefined for a main-context request, and for any subagent
 * whose hook did not carry one — both correctly fall through to the base.
 * An agent type with no section also falls through, which is why a TYPO in a
 * section name silently does nothing (ADR 0025 records this: there is no
 * registry of agent types to validate against).
 *
 * THE ASYMMETRY IS THE POINT:
 *
 * - deny / deny_groups UNION. A per-agent section must never weaken a
 *   machine-wide prohibition. Adding a section can only ever add denies, so a
 *   reader can trust that `deny` in the base holds for every agent no matter
 *   what any section says.
 * - allow / approve_groups REPLACE when present. Per-role scoping is the whole
 *   feature; merging additively would make a section able only to widen, and
 *   the motivating case is "give this role LESS".
 *
 * `present` means the key exists, not that it is non-empty: `allow = []` in a
 * section is a deliberate "this agent gets no allow patterns", and treating it
 * as absent would silently restore the base's — turning an explicit narrowing
 * into a widening, which is the one direction this must never fail.
 */
export function resolvePolicy(
  base: ResolvedPolicy,
  agents: Readonly<Record<string, AgentPolicyOverride>>,
  agentType: string | undefined,
): ResolvedPolicy {
  if (agentType === undefined || agentType.length === 0) return base;
  const override = agents[agentType];
  if (override === undefined) return base;
  return {
    allow: override.allow ?? base.allow,
    approveGroups: override.approve_groups ?? base.approveGroups,
    deny: union(base.deny, override.deny),
    denyGroups: union(base.denyGroups, override.deny_groups),
  };
}

/** Order-preserving union. Base entries keep their positions so a deny's
 *  reported pattern does not shuffle depending on which agent asked. */
function union(base: readonly string[], extra: readonly string[] | undefined): readonly string[] {
  if (extra === undefined || extra.length === 0) return base;
  const seen = new Set(base);
  const merged = [...base];
  for (const e of extra) {
    if (!seen.has(e)) {
      seen.add(e);
      merged.push(e);
    }
  }
  return merged;
}

/**
 * Validate the `agents` table shape, throwing with an actionable message.
 *
 * Mirrors `validateAutoApprove`'s style: a malformed policy table must fail
 * loudly at load rather than silently resolve to "no overrides", which would
 * present as the agent quietly running under the base policy — the exact
 * class of silent-degradation this epic keeps producing.
 */
export function validateAgents(value: unknown, configPath: string): void {
  if (value === undefined) return;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(
      `Invalid auto_approve.agents in ${configPath}: must be a table keyed by agent type. Example:\n  [auto_approve.agents.Explore]\n  approve_groups = ["read-only", "net-read"]`,
    );
  }
  for (const [agentType, section] of Object.entries(value as Record<string, unknown>)) {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      throw new Error(
        `Invalid auto_approve.agents.${agentType} in ${configPath}: must be a table. Example:\n  [auto_approve.agents.${agentType}]\n  approve_groups = ["read-only", "net-read"]`,
      );
    }
    for (const key of ['allow', 'deny', 'approve_groups', 'deny_groups'] as const) {
      const v = (section as Record<string, unknown>)[key];
      if (v === undefined) continue;
      if (!Array.isArray(v) || v.some((e) => typeof e !== 'string')) {
        throw new Error(
          `Invalid auto_approve.agents.${agentType}.${key} in ${configPath}: must be an array of strings, got ${JSON.stringify(v)}.`,
        );
      }
    }
    // Group NAMES are checkable and must be checked, unlike agent names (no
    // registry exists for those -- ADR 0025 records that). Skipping this was
    // worse than a no-op: because `approve_groups` REPLACES, a typo does not
    // merely fail to grant the group, it drops the agent's inherited base
    // grants too. `approve_groups = ["net-reed"]` silently leaves that agent
    // with less than the base, and the user-visible result is the 240s queue
    // stall this feature exists to remove. The base path already warns for the
    // same typo one section up, so the asymmetry was indefensible.
    //
    // WARN, not throw, matching the base. A throw reaches `cli.ts`'s exit(1),
    // and under the `--install` LaunchAgent (`KeepAlive.SuccessfulExit=false`)
    // that is a crash-restart loop over a one-character typo.
    for (const key of ['approve_groups', 'deny_groups'] as const) {
      const groups = (section as Record<string, unknown>)[key];
      if (!Array.isArray(groups)) continue;
      for (const g of groups) {
        if (typeof g === 'string' && !isKnownGroup(g)) {
          console.warn(
            `[AutoApprove] Warning: unknown permission group "${g}" in auto_approve.agents.${agentType}.${key} (${configPath}); ignored. Known groups: ${knownGroupNames().join(', ')}.`,
          );
        }
      }
    }
    for (const key of Object.keys(section as Record<string, unknown>)) {
      if (!['allow', 'deny', 'approve_groups', 'deny_groups'].includes(key)) {
        // Loud, not ignored. A misspelled `approve_group` would otherwise leave
        // the agent on the base policy while the config file plainly appears to
        // grant something -- a doc/behaviour mismatch of exactly the kind
        // ADR 0011 exists to stop shipping.
        throw new Error(
          `Unknown key auto_approve.agents.${agentType}.${key} in ${configPath}. Valid keys: allow, deny, approve_groups, deny_groups.`,
        );
      }
    }
  }
}
