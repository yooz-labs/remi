/**
 * Auto-approve strictness levels (#963, phase 3 of #956).
 *
 * A level is a named preset over the deterministic permission groups. It
 * exists because the permissive half of a policy could previously only be
 * expressed as PROSE to a 4B model, and prose does not hold.
 *
 * Measured on one machine over 796 evaluations: the 244 deterministic
 * approvals were honored exactly, every time, at 0ms. Of the 226 escalations,
 * **35 explicitly cite the user's own `instructions` and escalate anyway**
 * ("While the user guidance mentions approving writes... requires user
 * judgment") and **57 are plain writes**, against a config whose prose
 * approves writes outright. `prompt-builder.ts` already hoists that guidance
 * above the defaults, labels it MANDATORY, and repeats it at the end for
 * recency — each with a comment naming the failure that motivated it. It
 * still does not hold. That is the ceiling of the approach, not a bug in this
 * instance of it.
 *
 * So the levels are group membership, which is enforced, rather than
 * adjectives in a prompt, which is asked.
 *
 * `instructions` keeps working and keeps its prompt placement. What changes is
 * that it stops being load-bearing: it becomes the exception layer for
 * project-specific carve-outs the groups cannot encode ("escalate anything
 * touching packages/signaling"), which is what prose is actually good at.
 */

/** The three strictness levels, loosest last. */
export const AUTO_APPROVE_LEVELS = ['strict', 'balanced', 'trusted'] as const;

export type AutoApproveLevel = (typeof AUTO_APPROVE_LEVELS)[number];

/**
 * The shipped default.
 *
 * `strict` reproduces the behavior every existing install already has, so
 * upgrading to a version with levels changes nothing until the user opts up.
 *
 * `trusted` was proposed as the default and deliberately NOT taken in this
 * change. Phase 2 (#959) needed four adversarial review rounds to close eleven
 * bypasses in the write groups, three of which were found in code written to
 * fix the previous round. Making those groups default-on in the same change
 * that introduces the switch would bundle "does the mechanism work" together
 * with "is this policy right" — and separating those two questions is exactly
 * what each of the last three phases kept proving matters.
 *
 * Flipping the default is a one-line change and its own PR, after the
 * mechanism has run on a real machine.
 */
export const DEFAULT_AUTO_APPROVE_LEVEL: AutoApproveLevel = 'strict';

/**
 * Group membership per level, loosest last. Each level is a superset of the
 * one before it, which is a property worth preserving: it makes "raise the
 * level" mean unambiguously "approve more", and it is asserted by test.
 *
 * Deliberately absent from EVERY level:
 *
 * - `net-read` — cut from #959 after five of eleven bypasses turned out to be
 *   curl's (#961). Re-adding it means a policy derived from `man curl` rather
 *   than remembered.
 * - `git push`, remote mutation, arbitrary install scripts — not groups at
 *   all, at any strictness (#956). Blanket `rm` and blanket `--force` are
 *   not either; what ADR 0023 gates into `trusted` is narrower:
 *   `artifact-clean` approves a deletion only when EVERY target is provably
 *   derived state (exact-named artifact directories, structural `git
 *   worktree remove`, bare lockfile-faithful `bun install`), extending the
 *   destination-proof exception `scratch` already shipped at `balanced`.
 *   Deletion that reaches the LLM still escalates at every level.
 */
const LEVEL_GROUPS: Readonly<Record<AutoApproveLevel, readonly string[]>> = {
  // Exactly today's shipped `approve_groups` default. Asserted against
  // `config.ts`'s own default by test, so the two cannot drift apart.
  strict: ['read-only', 'vcs-read', 'build-test'],
  // Adds file writes (57 of 226 measured escalations, the single largest
  // cohort, and the one the user's own config already tried to approve) and
  // `scratch` (destination-confined: write/delete/redirect anywhere under
  // /tmp, /private/tmp, or $TMPDIR — see permission-groups.ts's `scratch`
  // section).
  balanced: ['read-only', 'vcs-read', 'build-test', 'fs-write', 'scratch'],
  // Adds local git mutation (add/commit/checkout/switch/merge/stash/worktree).
  // NOT `git push` — that stays an escalation at every level.
  // Also adds `artifact-clean` (ADR 0023): proved-derived deletion. The
  // measured misses it exists for — `rm -rf dist`, `rm -rf node_modules &&
  // bun install`, `git worktree remove --force ../remi-1031` — each burned
  // ~3.5s of LLM time reaching an escalation a human then overrode. Trusted
  // ONLY: the measurement is one machine running `trusted`, and ADR 0016's
  // precedent is to ship narrow and widen in a deliberate one-line follow-up.
  trusted: [
    'read-only',
    'vcs-read',
    'build-test',
    'fs-write',
    'scratch',
    'vcs-write',
    'artifact-clean',
  ],
};

/** True if `value` names a level. */
export function isAutoApproveLevel(value: unknown): value is AutoApproveLevel {
  return typeof value === 'string' && (AUTO_APPROVE_LEVELS as readonly string[]).includes(value);
}

/**
 * The groups a level approves. Pure, so the policy can be tested without
 * constructing a config or a daemon.
 */
export function groupsForLevel(level: AutoApproveLevel): readonly string[] {
  return LEVEL_GROUPS[level];
}

/** Where a resolved group list came from, for logging and `remi config`. */
export interface ResolvedGroups {
  readonly groups: readonly string[];
  /**
   * `'level'` when the preset supplied the list, `'explicit'` when the user's
   * own `approve_groups` did.
   */
  readonly source: 'level' | 'explicit';
  readonly level: AutoApproveLevel;
}

/**
 * Resolve the effective approve-group list.
 *
 * An explicit `approve_groups` OVERRIDES the level rather than merging with
 * it. Two reasons: a union can only ever widen, so a user who narrowed their
 * list would silently have it widened back by a level they never set; and a
 * user who wrote an explicit list meant that list. The caller logs which won,
 * so the effective policy is never a guess.
 *
 * `explicitGroups` is "what the user actually wrote", which the config loader
 * must distinguish from "what the default filled in" — passing the defaulted
 * value here would make every install look explicit and the level would never
 * apply to anyone.
 */
export function resolveApproveGroups(
  level: AutoApproveLevel,
  explicitGroups: readonly string[] | undefined,
): ResolvedGroups {
  if (explicitGroups !== undefined) {
    return { groups: explicitGroups, source: 'explicit', level };
  }
  return { groups: groupsForLevel(level), source: 'level', level };
}
