/**
 * Shell-segment primitives shared by the permission-group matcher and the
 * user allow-list matcher (#494, #536).
 *
 * Both need the same question answered: "is EVERY part of this compound
 * command covered by something the user opted into?" Answering it by
 * substring search cannot work, because a substring says nothing about the
 * parts of the command it did not match — `git status; rm -rf ~` contains
 * "git status" and is not a `git status`.
 *
 * These functions were factored out of permission-groups.ts unchanged; the
 * group matcher layers its own curated-read vetoes on top via the
 * `extraVeto` hook of `matchCoveredCommand`.
 */

/** Benign segments that may appear in a compound command without needing coverage. */
export const NEUTRAL_PREFIXES: readonly string[] = ['cd', 'pwd', 'true', 'echo', ':'];

/**
 * Split a command into compound segments on `&&`, `||`, `;`, `|`, and newlines
 * (`\n`/`\r` — the shell treats an unquoted newline as a command separator,
 * exactly like `;`), respecting single/double quotes (best-effort).
 * Backgrounding `&` is left in the segment for the shell-control veto to catch.
 */
export function splitCompound(command: string): string[] {
  const segments: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    const next = command[i + 1];
    if (quote !== null) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      current += c;
      continue;
    }
    // Unquoted newline / carriage return == a command separator. Without this,
    // `git log \ngit push` is one segment that prefix-matches `git log` and the
    // injected `git push` is never examined (shell-injection bypass).
    if (c === ';' || c === '\n' || c === '\r') {
      segments.push(current);
      current = '';
      continue;
    }
    if (c === '&' && next === '&') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === '|' && next === '|') {
      segments.push(current);
      current = '';
      i++;
      continue;
    }
    if (c === '|') {
      segments.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  segments.push(current);
  return segments;
}

/** True if the segment carries shell control that could escape the matched prefix. */
export function hasShellControl(segment: string): boolean {
  // Command / process substitution.
  if (segment.includes('$(') || segment.includes('`') || segment.includes('<(')) {
    return true;
  }
  // Backgrounding / control operator: a lone `&` anywhere that is not part of
  // `&&` (already split out), an fd-dup (`2>&1`, `>&2`), nor an `&>` redirect
  // (caught as redirection below). Catches `cmd &`, `cmd & other`, `a&b`.
  if (/(^|[^&>])&(?![&>0-9])/.test(segment)) {
    return true;
  }
  // Output redirection to anything other than /dev/null or an fd dup (2>&1).
  const redirs = segment.match(/\d*>>?\s*&?\S+/g);
  if (redirs) {
    for (const r of redirs) {
      const target = r.replace(/^\d*>>?\s*/, '');
      if (target !== '/dev/null' && !/^&\d+$/.test(target)) {
        return true;
      }
    }
  }
  return false;
}

/** Word-boundary prefix match: `seg === p` or `seg` starts with `p + ' '`. */
export function matchPrefix(segment: string, prefixes: readonly string[]): string | null {
  let best: string | null = null;
  for (const p of prefixes) {
    if (segment === p || segment.startsWith(`${p} `)) {
      // Prefer the longest (most specific) match for clearer logging.
      if (best === null || p.length > best.length) best = p;
    }
  }
  return best;
}

/**
 * Flags that turn a command into a DIFFERENT command.
 *
 * These are not mutation flags, and the distinction is the whole point. A user
 * who allows `biome check --fix` means the write; a user who allows `find` does
 * not mean `find . -exec rm -rf {} +`. `-exec` does not make `find` write, it
 * makes `find` run something else, so approving it approves an argument the
 * user never saw. That is the #536 bug one level down, at the argument list
 * instead of the tool name, and it is why this veto applies to the user allow
 * path even though the mutation-flag veto deliberately does not.
 *
 * Long options only, or short ones that no read form of any command uses.
 * Overloaded short flags (`-e`, `-c`, `-i`) live in the family-scoped list
 * below, because vetoing them globally would break `grep -e` and friends.
 */
const EXEC_PRIMITIVE_TOKEN =
  /(^|\s)(-exec|-execdir|-ok|-okdir|-delete|-fprintf|-fprint|-fprint0|-fls|--to-command|--use-compress-program|--rmt-command|--rsh-command|--checkpoint-action|--preload|--require|--eval|--exec)(\s|=|$)/;

/**
 * Command families whose read form is flipped to code execution by a flag that
 * is harmless elsewhere, so the veto has to know which command it is looking at.
 */
const EXEC_SCOPED_VETOES: ReadonlyArray<{ family: RegExp; flag: RegExp }> = [
  // `git -c core.hooksPath=/tmp/evil status` and `git -c core.fsmonitor='...'`
  // run arbitrary code on an otherwise read-only git command. No read form of
  // git needs `-c`.
  { family: /^git\b/, flag: /(^|\s)-c(\s|=)/ },
  // awk's program text can call system() or pipe into a shell.
  { family: /^(g|m|n)?awk\b/, flag: /(system\s*\(|\|\s*&?\s*"?\s*(sh|bash|zsh)\b|print\s*\|)/ },
  // `rsync -e 'sh -c ...'` / `--rsh` runs the "remote shell" locally.
  { family: /^rsync\b/, flag: /(^|\s)(-e|--rsh)(\s|=)/ },
  // ssh/scp run a command on the far side, and ProxyCommand/LocalCommand run
  // one on THIS side.
  { family: /^(ssh|scp|sftp)\b/, flag: /(^|\s)-o\s*(Proxy|Local)Command/i },
];

/** True if a segment carries a code-execution primitive. */
export function hasExecPrimitive(segment: string): boolean {
  if (EXEC_PRIMITIVE_TOKEN.test(segment)) return true;
  for (const { family, flag } of EXEC_SCOPED_VETOES) {
    if (family.test(segment) && flag.test(segment)) return true;
  }
  return false;
}

/**
 * Decide whether a Bash command is fully covered by the given prefixes.
 * Returns the (most specific) matched prefix, or null to fall through.
 *
 * A command is covered only when EVERY compound segment is either neutral
 * (cd/pwd/echo/...) or matches a prefix, none carries shell control or a
 * code-execution primitive, and at least one segment actually matched a prefix
 * (a command of only neutral segments has not matched anything).
 *
 * @param extraVeto Optional per-segment veto layered on top of the shell-control
 *   and exec-primitive checks. The group matcher passes its curated-read
 *   mutation vetoes here; the user allow list passes nothing, because a user
 *   may legitimately allow a write.
 * @param vetoForMatched Optional veto for a segment that MATCHED a prefix,
 *   receiving the prefix it matched (#957). `extraVeto` cannot express this:
 *   it runs before `matchPrefix`, so it has no way to know which curated entry
 *   covered the segment, and therefore has to apply one blanket rule to every
 *   segment in the command. That is correct while every curated entry is
 *   read-only — "none of those tokens legitimately appears in a curated read
 *   command" (`permission-groups.ts`) — and wrong the moment a group is
 *   SUPPOSED to mutate, because the blanket rule vetoes it by construction.
 *   When supplied, this replaces `extraVeto` for matched segments only;
 *   NEUTRAL segments keep `extraVeto` regardless, since `cd`/`echo` carrying
 *   `--write` is suspicious no matter which group covered the rest of the
 *   command. Callers that omit it get the same RETURN VALUE as before for
 *   every input. Note the scope of that claim: `extraVeto` is no longer
 *   *called* for a segment that is neither neutral nor matches any prefix,
 *   because the no-match branch now returns first. Both shipped predicates are
 *   pure, so this is invisible today — but it is a claim about return values,
 *   not about invocation, and a side-effecting veto would notice.
 */
export function matchCoveredCommand(
  command: string,
  prefixes: readonly string[],
  extraVeto?: (segment: string) => boolean,
  vetoForMatched?: (segment: string, matchedPrefix: string) => boolean,
): string | null {
  const segments = splitCompound(command);
  let matched: string | null = null;
  for (const raw of segments) {
    const seg = raw.trim();
    if (seg === '') continue;
    if (hasShellControl(seg)) return null;
    if (matchPrefix(seg, NEUTRAL_PREFIXES) !== null) {
      // Neutral segments are vetoed before they can be waved through. Ordering
      // note: `extraVeto` used to run ahead of this neutral check for EVERY
      // segment, so moving it inside is behavior-preserving only because a
      // vetoed non-neutral segment still returns null below — via its own veto
      // if it matches, or via the no-match branch if it does not.
      if (extraVeto?.(seg)) return null;
      continue;
    }
    const hit = matchPrefix(seg, prefixes);
    if (hit === null) return null;
    const vetoed = vetoForMatched ? vetoForMatched(seg, hit) : (extraVeto?.(seg) ?? false);
    if (vetoed) return null;
    // Veto a code-execution primitive UNLESS the matched entry already carries
    // it. A prefix match requires the segment to start with the entry, so an
    // entry containing `-exec` only matches a command the user spelled out that
    // far: they saw it and approved it. An entry of just `find` did not.
    if (hasExecPrimitive(seg) && !hasExecPrimitive(hit)) return null;
    if (matched === null) matched = hit;
  }
  return matched;
}
