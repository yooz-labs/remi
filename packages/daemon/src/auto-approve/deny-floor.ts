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
 *
 * ## Boundary-aware matching (#985)
 *
 * Every entry used to be checked with `matchSubstringPattern`, an unanchored
 * substring search. That is correct for the user's own `deny` list and for
 * `subagent_alert` (ADR 0010: both are user-authored and small, so
 * over-matching is the safe failure mode) and wrong here: `rm -rf /` is a
 * literal prefix of every absolute path (`rm -rf /tmp/uep.bak`, `rm -rf
 * /Users/.../dist` both matched), and `| sh` / `| bash` are literal prefixes
 * of `| shasum`, `| shellcheck`, `| shuf`, `| bashate`. Measured against real
 * commands (#985): every one of those left a model `deny` standing SILENTLY —
 * no card, no chance for the user to say otherwise, exactly the failure mode
 * `enforceDenyFloor` exists to close.
 *
 * `matchSubstringPattern` itself is NOT changed by this fix. It stays exactly
 * right for `deny` and `subagent_alert`. This list is a different animal:
 * fixed, code-owned, and small enough to afford real precision, so the
 * boundary logic below is local to it instead of widening (and so weakening)
 * the shared matcher.
 *
 * Per-entry call, since not every pattern needs the same treatment:
 *
 * - `rm -rf /` needs argument-level precision — "does the path stop at `/`?"
 *   — which a trailing-word-boundary check cannot express (a path does not
 *   stop being non-word characters right after a leading `/`; `/tmp` starts
 *   with a word character immediately). It gets a dedicated regex that
 *   requires the `/` to be followed by whitespace, `*`, one of `;&|)`, or
 *   end-of-string — deliberately NOT a closing quote, which is what keeps
 *   `echo "rm -rf /" >> notes.txt` (a mention, not an invocation) from
 *   matching. Also accepts an optional `--no-preserve-root` between the flags
 *   and the path, since that is the one variant explicitly meant to defeat
 *   `rm`'s own root guard.
 * - `sudo rm`, `rm -rf /etc`, `rm -rf /usr`, `rm -rf /System` get a
 *   trailing-word-boundary check (the character right after the pattern must
 *   not continue an identifier). The collision this closes is a REAL name
 *   that happens to start with the pattern — `/etcetera-backup`, `sudo
 *   rmdir` — not a quoted mention; that refinement was only built and tested
 *   for the two patterns #985 actually measured with real false positives.
 *   Rejecting the collision is the safe direction on both sides it feeds:
 *   `enforceDenyFloor` trades a silent deny for an escalate (never a loss),
 *   and `enforceAuthorityBoundary` trades a downgrade for leaving an approve
 *   in place on an operation that was never one of these directories anyway.
 * - `chmod 777` is left as a plain substring, on purpose: its only prefix
 *   collision is a longer octal mode (`chmod 7777`, `chmod 7770`), and a
 *   leading `7` only ever ADDS setuid/setgid/sticky bits on top of the same
 *   `rwxrwxrwx` — over-matching here catches something equally or more
 *   permissive, not something unrelated, so there is nothing to anchor
 *   against.
 *
 * ## The direction change this causes
 *
 * `enforceDenyFloor` gets STRICTER: fewer model denies wrongly qualify as
 * "the floor already covers this", so more of them correctly escalate to the
 * user instead of standing silently. This is the fix and the safe direction.
 *
 * `enforceAuthorityBoundary` gets LOOSER on the newly-excluded false
 * positives (an authority-present `approve` of `rm -rf /tmp/x` no longer gets
 * downgraded to `escalate` by THIS guard) — but that is not the only backstop
 * for that case. `authority-counterfactual.ts`'s `RISKY_SHAPES` list includes
 * both `'rm '` and `'rm -'` (`authority-counterfactual.ts:83-84`, confirmed
 * by reading the array directly, not inferred from a comment — see AGENTS.md
 * "Verify before you describe"), so any authority-present `approve` of an
 * `rm`-shaped command still trips the independent #954 counterfactual
 * re-check regardless of whether it also matches this list. This change only
 * stops the two guards double-covering `rm -rf /tmp/x`; a dedicated mechanism
 * already owns that case.
 */
interface CatastrophicRule {
  readonly label: string;
  readonly test: (command: string) => boolean;
}

/** Escapes regex metacharacters so a literal string can be dropped into a
 *  dynamically built pattern. None of today's labels need it (no `.`, `+`,
 *  `(`, etc.), but a boundary helper that silently mis-escapes a future entry
 *  is worse than one extra function call. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * True if `needle` occurs in `command` and that occurrence is not
 * immediately followed by an identifier character (letter, digit,
 * underscore) — i.e. `needle` is not merely a prefix of a longer word. Scans
 * every occurrence via the regex engine's own backtracking rather than just
 * the first `indexOf` hit, so an early false hit inside a longer word cannot
 * hide a real, boundary-satisfying occurrence later in the same command.
 */
function hasTrailingWordBoundary(command: string, needle: string): boolean {
  return new RegExp(`${escapeRegExp(needle)}(?![A-Za-z0-9_])`).test(command);
}

/**
 * `rm -rf /` scoped to the root argument itself: the path must end at `/`,
 * not merely start with it. Allows an optional `--no-preserve-root` between
 * the flags and the path. The boundary after `/` deliberately excludes
 * closing-quote characters — see the module doc for why that is what rejects
 * a quoted mention rather than an invocation.
 */
const ROOT_RM_RE = /\brm\s+-rf\s+(?:--no-preserve-root\s+)?\/(?:[\s*;&|)]|$)/;

/** `| sh` / `| bash`, where the pipe must lead directly (only whitespace
 *  between) into the interpreter name and the name must end there — so
 *  `| shasum`, `| shellcheck`, `| shuf`, and `| bashate` do not match. */
const PIPE_SH_RE = /\|\s*sh\b/;
const PIPE_BASH_RE = /\|\s*bash\b/;

const CATASTROPHIC_RULES: readonly CatastrophicRule[] = [
  { label: 'rm -rf /', test: (command) => ROOT_RM_RE.test(command) },
  { label: 'sudo rm', test: (command) => hasTrailingWordBoundary(command, 'sudo rm') },
  { label: 'rm -rf /etc', test: (command) => hasTrailingWordBoundary(command, 'rm -rf /etc') },
  { label: 'rm -rf /usr', test: (command) => hasTrailingWordBoundary(command, 'rm -rf /usr') },
  {
    label: 'rm -rf /System',
    test: (command) => hasTrailingWordBoundary(command, 'rm -rf /System'),
  },
  { label: '| sh', test: (command) => PIPE_SH_RE.test(command) },
  { label: '| bash', test: (command) => PIPE_BASH_RE.test(command) },
  { label: 'chmod 777', test: (command) => command.includes('chmod 777') },
];

/** Bare tool-name equality for non-Bash tools, mirroring
 *  `matchSubstringPattern`'s documented non-Bash behavior. None of the labels
 *  above are shaped like a Claude Code tool name (all lowercase and/or
 *  space-containing), so this is always null in practice; delegating instead
 *  of hardcoding that keeps this function honest if a future label ever
 *  changed shape. */
const CATASTROPHIC_LABELS: readonly string[] = CATASTROPHIC_RULES.map((rule) => rule.label);

/** True if this tool call matches a hardcoded catastrophic pattern. Exported
 *  for tests; `enforceAuthorityBoundary` and `enforceDenyFloor` are the real
 *  call sites. */
export function matchesCatastrophicPattern(
  toolName: string,
  toolInput: Record<string, unknown>,
): string | null {
  if (toolName !== 'Bash') {
    return matchSubstringPattern(toolName, toolInput, CATASTROPHIC_LABELS);
  }
  const command = typeof toolInput['command'] === 'string' ? toolInput['command'] : '';
  if (!command) return null;
  for (const rule of CATASTROPHIC_RULES) {
    if (rule.test(command)) return rule.label;
  }
  return null;
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
