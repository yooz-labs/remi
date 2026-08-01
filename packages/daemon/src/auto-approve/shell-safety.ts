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

/**
 * Split a single command segment into shell WORDS, performing real quote and
 * escape removal (#960 second review).
 *
 * This exists because three separate vetoes were each written to reason about
 * raw command TEXT, each hand-rolled its own quote handling, and each got it
 * wrong in a different way. Every one of these auto-approved at 0ms:
 *
 *     curl -"o" out.txt url        -> real argv [-o] [out.txt] [url]
 *     curl -sS"o" out.txt url      -> real argv [-sSo] ...
 *     curl --o\utput out.txt url   -> real argv [--output] ...
 *     cp evil /et"c"/cron.d/task   -> real argv [...] [/etc/cron.d/task]
 *     tee ~/."remi"/config.toml    -> real argv [/Users/x/.remi/config.toml]
 *     git checkout "."             -> real argv [git] [checkout] [.]
 *
 * The shell does not see quotes as part of the word; it removes them and
 * CONCATENATES adjacent quoted, unquoted and escaped spans into one argument.
 * Any check that matches against the raw text is therefore matching a string
 * the program being run will never receive, and one embedded quote or
 * backslash defeats it. That is not a family of bugs to patch individually —
 * it is one missing primitive, so it is implemented once here and every
 * consumer runs against the result.
 *
 * Deliberately does NOT expand variables, globs, command substitution, or
 * brace expansion. Those are unknowable statically, and `hasShellControl`
 * already refuses a segment containing substitution outright — so a word
 * reaching this function cannot contain one.
 */
export function shellWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let started = false;

  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];

    if (c === undefined) break;

    if (c === '\\') {
      // Backslash escapes the next character, and the backslash itself is
      // removed. `--o\utput` is the word `--output`.
      const next = segment[i + 1];
      if (next !== undefined) {
        current += next;
        started = true;
        i++;
      }
      continue;
    }

    if (c === "'") {
      // Single quotes are fully literal: no escapes, ends at the next quote.
      started = true;
      i++;
      while (i < segment.length && segment[i] !== "'") {
        current += segment[i];
        i++;
      }
      continue;
    }

    if (c === '"') {
      // Double quotes honour backslash escapes for a small set of characters;
      // every other backslash is literal.
      started = true;
      i++;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === '\\') {
          const next = segment[i + 1];
          if (next !== undefined && ['"', '\\', '$', '`', '\n'].includes(next)) {
            current += next;
            i += 2;
            continue;
          }
        }
        current += segment[i];
        i++;
      }
      continue;
    }

    if (c === '$' && segment[i + 1] === '"') {
      // Locale/gettext quoting (`$"..."`). bash strips BOTH the `$` and the
      // quotes, so `$"--force"` is the word `--force`. Missing this case left
      // the `$` glued to the front of the token, which broke every check that
      // asks whether a word STARTS WITH `-` or EQUALS `.` — i.e. the entire
      // flag allowlist and the positional veto. `git checkout $"--force"` and
      // `mkdir $"-m" 777` were auto-approved (#960 round 3).
      //
      // Handled as double-quoted content, since that is what it is: the `$`
      // only marks it for translation.
      started = true;
      i += 2;
      while (i < segment.length && segment[i] !== '"') {
        if (segment[i] === '\\') {
          const next = segment[i + 1];
          if (next !== undefined && ['"', '\\', '$', '`', '\n'].includes(next)) {
            current += next;
            i += 2;
            continue;
          }
        }
        current += segment[i];
        i++;
      }
      continue;
    }

    if (c === '$' && segment[i + 1] === "'") {
      // ANSI-C quoting (`$'...'`). Treated as literal contents rather than
      // decoding every escape: the point here is that the QUOTES vanish, so a
      // flag hidden inside one is seen. Under-decoding an escape can only
      // produce a longer, stranger word, never a shorter safe-looking one.
      started = true;
      i += 2;
      while (i < segment.length && segment[i] !== "'") {
        if (segment[i] === '\\' && segment[i + 1] !== undefined) {
          current += segment[i + 1];
          i += 2;
          continue;
        }
        current += segment[i];
        i++;
      }
      continue;
    }

    if (/\s/.test(c)) {
      if (started) {
        words.push(current);
        current = '';
        started = false;
      }
      continue;
    }

    current += c;
    started = true;
  }

  if (started) words.push(current);
  return words;
}
