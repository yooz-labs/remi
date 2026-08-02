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
 * - `rm -rf /`, `rm -rf /etc`, `rm -rf /usr`, `rm -rf /System` need
 *   argument-level precision — "is the flag set both recursive AND force, and
 *   does the target argument name this exact path (or a subpath of it)?" —
 *   which no fixed literal can express, because `rm` accepts the same two
 *   flags in more shapes than one string can enumerate: `-rf`, `-fr`, `-r -f`
 *   (either order, separate tokens), `--recursive --force` (either order,
 *   long form), and combined getopt-style clusters (`-rvf`, `-fvr`, any
 *   other ordering with other short flags mixed in). These four rules share
 *   `matchesRmWithTarget`: it finds every `rm` invocation in the command
 *   (word-bounded, so `confirm -rf /` and `rmdir -rf /` do not count),
 *   collects the run of flag-shaped tokens that follow (which is also what
 *   sweeps up `--no-preserve-root` without a special case for it — it is
 *   just another flag token in the run, contributing to neither recursive
 *   nor force, and simply not interrupting the scan), and checks the first
 *   non-flag token against a target predicate. The root predicate
 *   (`isRootTarget`) requires the target to equal `/` or `/` immediately
 *   followed only by `*`, `;`, `&`, `|`, `)`, or end-of-string —
 *   deliberately NOT a closing quote, which is what keeps `echo "rm -rf /"
 *   >> notes.txt` (a mention, not an invocation) from matching: the quote in
 *   the source string glues onto the whitespace-delimited target token
 *   (`/"`), and `isRootTarget` rejects that shape. The directory predicates
 *   (`isDirTarget`) require the target to equal the directory or continue
 *   into a subpath (`/etc`, `/etc/passwd`) but not a same-prefixed sibling
 *   (`/etcetera-backup`).
 * - `sudo rm` and `chmod 777` stay simple regexes over the raw command text
 *   (word-bounded `\bsudo\s+rm\b`, prefix-bounded `\bchmod\s+777`) rather
 *   than flag-aware parsing: `sudo rm` is intentionally broad regardless of
 *   flags (any sudo-elevated `rm` at all, not just recursive-force ones), and
 *   `chmod 777`'s only prefix collision is a longer octal mode (`chmod
 *   7777`), which is equally or more permissive — over-matching there catches
 *   something worse, not something unrelated, so there is nothing to anchor.
 *   Both still needed the whitespace fix below.
 * - Every rule tolerates repeated whitespace (`\s+` instead of a literal
 *   single space) wherever the ORIGINAL literal had one, so `sudo  rm`
 *   (double space) and `rm  -rf  /` still match. This was not cosmetic:
 *   `develop` requires exactly one literal space in `matchSubstringPattern`'s
 *   plain `.includes()` check, so two spaces anywhere in a pattern is itself
 *   an existing bypass, independent of flag order.
 *
 * ## What this round (#985 follow-up) additionally closed, and what it does not
 *
 * A second probe against this same list, after the initial #985 fix, found
 * FOUR shapes that still fell through on the FIXED-LITERAL version of this
 * list (i.e. the version that shipped with the anchored-but-still-literal
 * `rm -rf /` / `rm -rf /etc` / `rm -rf /usr` / `rm -rf /System` / `sudo rm`
 * entries, before this comment's rules existed): `rm -fr /` (flags reversed),
 * `rm -r -f /` (flags split into separate tokens), `rm --recursive --force /`
 * (long form), and `sudo  rm -rf /var` (double space). In every one of these,
 * the MISS was a false NEGATIVE on this list specifically — for
 * `enforceDenyFloor` that meant the model's `deny` fell through to `escalate`
 * rather than standing as a floored deny (per this module's own doc on
 * `enforceDenyFloor`, an escalate is "strictly better than the deny it
 * replaces in both directions", so this was never a silent-approval hole);
 * for `enforceAuthorityBoundary` it meant no downgrade from THIS guard, but
 * `authority-counterfactual.ts`'s `RISKY_SHAPES` already includes `'rm '`,
 * `'rm -'`, and `'sudo'` (`authority-counterfactual.ts:81-146`, verified by
 * reading the array), so an authority-present approve of any of these four
 * shapes still tripped the independent #954 counterfactual regardless. The
 * bug was this list being internally inconsistent — the SAME catastrophic
 * operation floored under one spelling and merely escalated under another —
 * not a path to a silent approve. Fixed here by generalizing to flag-aware
 * matching instead of adding more literals.
 *
 * This is still NOT a shell parser, and deliberately stops short of being
 * one. `matchesRmWithTarget` reasons about whitespace-delimited TOKENS in the
 * raw command text — it does not interpret quoting, variable expansion
 * (`$VAR`, `${VAR}`), command substitution (`` `cmd` ``, `$(cmd)`), or
 * backslash escapes. A command that hides its target behind any of those
 * (`rm -rf "$ROOT"`, `` rm -rf `echo /` ``) will not match. That is
 * acceptable and intentional: this list is explicitly "a second, narrower
 * denylist: defense in depth on top of the prompt instruction, not a
 * replacement for it" (see above) — the LLM path and the
 * authority-counterfactual re-check both sit behind it and do not depend on
 * this list's syntactic coverage. Chasing full shell semantics here would
 * turn a "small, code-owned, auditable" list into an unbounded parser, which
 * is exactly the kind of scope the exfiltration bullet was already kept out
 * for.
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

/**
 * Finds every `rm` invocation in `command` (word-bounded via `\b`, so
 * `confirm -rf /` and `rmdir -rf /` are not invocations of `rm`), captures
 * the run of flag-shaped tokens immediately following it (group 1: each
 * repetition is whitespace + 1-2 dashes + letters/hyphens, which is also
 * what sweeps up `--no-preserve-root` for free), then captures the next
 * whitespace-delimited token as the target (group 2). Global, so a compound
 * command gets every `rm` checked, not just the first.
 */
const RM_INVOCATION_RE = /\brm((?:\s+-{1,2}[A-Za-z-]+)*)\s+(\S+)/g;

/**
 * True if the flag run captured by `RM_INVOCATION_RE` supplies BOTH
 * recursive and force, in any of `rm`'s accepted shapes: separate short
 * flags (`-r -f` or `-f -r`), a combined getopt-style cluster in either
 * order and mixed with other letters (`-rf`, `-fr`, `-rvf`, `-fvr`), or long
 * flags in either order (`--recursive --force` / `--force --recursive`).
 * Heuristic over flag TEXT, not real option parsing — see the module doc's
 * "not a parser" note for why that line is deliberate.
 */
function suppliesRecursiveAndForce(flags: string): boolean {
  let hasRecursive = false;
  let hasForce = false;
  for (const token of flags.trim().split(/\s+/).filter(Boolean)) {
    if (token.startsWith('--')) {
      if (token === '--recursive') hasRecursive = true;
      if (token === '--force') hasForce = true;
      continue;
    }
    // Single-dash cluster: getopt-style, so any letter in it counts,
    // regardless of position or what else rides along (-rvf, -fvr, -v, ...).
    if (token.includes('r')) hasRecursive = true;
    if (token.includes('f')) hasForce = true;
  }
  return hasRecursive && hasForce;
}

/**
 * True if some `rm` invocation in `command` supplies both recursive and
 * force AND its target satisfies `isTarget`. Shared by the root and
 * directory rules below; only the target predicate differs between them.
 */
function matchesRmWithTarget(command: string, isTarget: (target: string) => boolean): boolean {
  for (const match of command.matchAll(RM_INVOCATION_RE)) {
    const flags = match[1] ?? '';
    const target = match[2] ?? '';
    if (suppliesRecursiveAndForce(flags) && isTarget(target)) return true;
  }
  return false;
}

/**
 * True if `target` is exactly the root path, optionally immediately followed
 * by nothing but `*`, `;`, `&`, `|`, or `)` — i.e. root and only root, not a
 * subpath (`/tmp`, rejected: the char after `/` is a letter) and not a
 * quote-attached mention (`/"`, from `echo "rm -rf /"` — the closing quote
 * glues onto this whitespace-delimited token — rejected: `"` is not in the
 * allowed set).
 */
function isRootTarget(target: string): boolean {
  return /^\/[*;&|)]*$/.test(target);
}

/**
 * True if `target` is `dir` itself or a path under it (`/etc`, `/etc/passwd`
 * both count for `dir = '/etc'`), but not a same-prefixed sibling that is a
 * DIFFERENT directory (`/etcetera-backup`, `/etc-backup` do not count).
 *
 * Fixed by #985's second review round: the original version here rejected
 * only an alnum/underscore continuation (`!/^[A-Za-z0-9_]/.test(rest)`),
 * which is the same mistake as reaching for `\b` — both treat `-` as a valid
 * boundary. `/usr-local-mine` was measured to match `/usr` under that rule:
 * `r` is a word character, `-` is not, so a word-boundary check (explicit or
 * via `\b`) fires right where a real sibling directory name continues. The
 * only correct boundary for "this path, or a path under it" is an EXACT
 * match or the immediate next character being `/` — nothing else, since any
 * other character (`-`, `.`, `_`, a letter) means the target is a
 * differently-named entry that merely shares a prefix.
 */
function isDirTarget(target: string, dir: string): boolean {
  return target === dir || target.startsWith(`${dir}/`);
}

/**
 * Command-token terminator: whitespace, or a shell control character that
 * would end this token (`;`, `&`, `|`, `)`), or end-of-string. Deliberately
 * excludes identifier characters (letters, digits, `_`, `-`), for the same
 * reason `isDirTarget` above cannot use `\b`: a hyphen is not a boundary
 * between "this exact command name" and "a different, hyphenated command
 * name that happens to share a prefix" (`sudo rm-wrapper` is not `sudo rm`;
 * `| sh-wrapper` is not `| sh`). Audited every `\b` in this file for the
 * same class of bug the `isDirTarget` fix above closed: `RM_INVOCATION_RE`'s
 * leading `\brm` and `chmod`'s leading `\bchmod` are LEADING boundaries
 * (checking what precedes the token), which `\b` handles correctly — the
 * risk is specific to a TRAILING boundary claiming "the token ends here."
 * `RM_INVOCATION_RE` has no trailing `\b` at all: it requires a literal
 * whitespace character after `rm` (via the mandatory `\s+` before the flag
 * run or the target), which already rejects `rm-wrapper` for a stronger
 * reason than any boundary check — there is no flag/target to capture
 * without real whitespace. That left exactly two trailing `\b` uses with
 * this bug: `sudo rm\b` and the two pipe-interpreter rules below, both
 * fixed to use this terminator instead.
 */
const COMMAND_TOKEN_END = '[\\s;&|)]|$';

/** `sudo rm`, `| sh`, `| bash` — the pipe/prefix must lead directly (only
 *  whitespace between) into the command name, and the name must end at a
 *  real command-token boundary — so `sudo rmdir`, `sudo rm-wrapper`,
 *  `| shasum`, `| shellcheck`, `| shuf`, `| bashate`, and `| sh-wrapper` do
 *  not match. */
const SUDO_RM_RE = new RegExp(`\\bsudo\\s+rm(?=${COMMAND_TOKEN_END})`);
const PIPE_SH_RE = new RegExp(`\\|\\s*sh(?=${COMMAND_TOKEN_END})`);
const PIPE_BASH_RE = new RegExp(`\\|\\s*bash(?=${COMMAND_TOKEN_END})`);

const CATASTROPHIC_RULES: readonly CatastrophicRule[] = [
  { label: 'rm -rf /', test: (command) => matchesRmWithTarget(command, isRootTarget) },
  { label: 'sudo rm', test: (command) => SUDO_RM_RE.test(command) },
  {
    label: 'rm -rf /etc',
    test: (command) => matchesRmWithTarget(command, (target) => isDirTarget(target, '/etc')),
  },
  {
    label: 'rm -rf /usr',
    test: (command) => matchesRmWithTarget(command, (target) => isDirTarget(target, '/usr')),
  },
  {
    label: 'rm -rf /System',
    test: (command) => matchesRmWithTarget(command, (target) => isDirTarget(target, '/System')),
  },
  { label: '| sh', test: (command) => PIPE_SH_RE.test(command) },
  { label: '| bash', test: (command) => PIPE_BASH_RE.test(command) },
  { label: 'chmod 777', test: (command) => /\bchmod\s+777/.test(command) },
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
