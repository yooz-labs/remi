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
 * Decide whether a Bash command is fully covered by the given prefixes.
 * Returns the (most specific) matched prefix, or null to fall through.
 *
 * A command is covered only when EVERY compound segment is either neutral
 * (cd/pwd/echo/...) or matches a prefix, none carries shell control, and at
 * least one segment actually matched a prefix (a command of only neutral
 * segments has not matched anything).
 *
 * @param extraVeto Optional per-segment veto layered on top of the shell-control
 *   check. The group matcher passes its curated-read vetoes here; the user
 *   allow list passes nothing, because a user may legitimately allow a write.
 */
export function matchCoveredCommand(
  command: string,
  prefixes: readonly string[],
  extraVeto?: (segment: string) => boolean,
): string | null {
  const segments = splitCompound(command);
  let matched: string | null = null;
  for (const raw of segments) {
    const seg = raw.trim();
    if (seg === '') continue;
    if (hasShellControl(seg)) return null;
    if (extraVeto?.(seg)) return null;
    if (matchPrefix(seg, NEUTRAL_PREFIXES) !== null) continue;
    const hit = matchPrefix(seg, prefixes);
    if (hit === null) return null;
    if (matched === null) matched = hit;
  }
  return matched;
}
