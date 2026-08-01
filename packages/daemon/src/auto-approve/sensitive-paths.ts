/**
 * Destinations a write-side permission group must never cover (#959).
 *
 * Curated READ groups never needed this. Reading `/etc/hosts` is harmless, so
 * `read-only`'s safety rests entirely on the command being a read — the path
 * it reads is irrelevant. A WRITE group inverts that: `cp x /etc/hosts`,
 * `touch /etc/cron.d/evil` and `tee ~/.ssh/authorized_keys` all satisfy a
 * perfectly ordinary `fs-write` prefix, and the prefix is the only thing the
 * matcher would otherwise look at.
 *
 * So a write group needs a second axis — WHAT it writes, not just HOW — and
 * this module is that axis. It is deliberately a denylist of destinations
 * rather than an allowlist of safe ones: an allowlist would have to enumerate
 * every project directory a user might work in, which is unbounded, while the
 * set of destinations that are never a routine edit is small and stable.
 *
 * Same caveat as every other denylist in this module (`NON_HUMAN_WRAPPER_
 * PREFIXES`, `CATASTROPHIC_PATTERNS`): it is defense in depth on a group that
 * is already prefix-curated, not a complete model of "dangerous path". A
 * destination that slips past this still has to be reached by a curated write
 * prefix carrying no shell control and no exec primitive.
 *
 * ## The self-reference case
 *
 * `~/.remi` and `~/.claude` are on the list for a reason distinct from the
 * others. They are not sensitive because of what they contain; they are
 * sensitive because they configure THIS mechanism. `~/.remi/config.toml`
 * holds `[auto_approve]` — its `allow` list, its `approve_groups`, its
 * `instructions`. A write group that covers it lets an auto-approved edit
 * widen what is auto-approved next, which is a privilege-escalation loop
 * rather than an ordinary risky write. `~/.claude/settings.json` is the same
 * shape one level up: it holds the permission rules Claude Code itself
 * enforces before remi ever sees a `PermissionRequest`.
 *
 * A write group must be unable to open that loop, and closing it belongs in
 * the same change that opens the group.
 *
 * ## `.git/` is code execution, not data
 *
 * `.git/hooks/pre-commit` runs on the next commit. With `vcs-write` enabled,
 * that commit is itself auto-approved — so a write to `.git/` followed by a
 * `git commit` is arbitrary code execution assembled from two individually
 * approved steps. Refusing `.git/` writes is what keeps the two groups from
 * composing into something neither one grants.
 */

/**
 * Absolute system trees. Prefix-matched against a normalised path, so
 * `/etc` catches `/etc/hosts` but not a project file named `/tmp/etcetera`.
 */
const SYSTEM_TREES: readonly string[] = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/var',
  '/opt',
  '/System',
  '/Library',
  '/private/etc',
  '/private/var',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
];

/**
 * Path SEGMENTS that make a destination sensitive wherever they appear, so a
 * relative path (`../../.ssh/config`) or an unexpanded `~` is caught the same
 * as an absolute one. Matched against `/`-delimited segments, never as bare
 * substrings — a project directory legitimately named `environment` must not
 * trip the `.env` entry.
 */
const SENSITIVE_SEGMENTS: readonly string[] = [
  // Credentials and keys.
  '.ssh',
  '.aws',
  '.gnupg',
  '.gpg',
  '.docker',
  '.kube',
  '.netrc',
  '.npmrc',
  '.pypirc',
  // Config governing this very mechanism -- see the module doc.
  '.remi',
  '.claude',
  // Git internals: writing a hook here is code execution on the next commit.
  '.git',
];

/**
 * Basenames that are sensitive regardless of directory. `.env` in a project
 * root is as much a secret as one in `$HOME`.
 */
const SENSITIVE_BASENAMES: readonly string[] = [
  '.env',
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials',
  'authorized_keys',
  'known_hosts',
  '.htpasswd',
];

/** `.env.local`, `.env.production`, ... are the same secret with a suffix. */
const SENSITIVE_BASENAME_PREFIXES: readonly string[] = ['.env.'];

/**
 * True if `candidate` names a destination no write-side group may cover.
 *
 * Accepts a raw path as it appeared in a command or a tool input — quoting,
 * `~`, and `.`/`..` segments are handled here rather than by the caller, since
 * every caller would otherwise have to remember to.
 */
export function isSensitiveWritePath(candidate: string): boolean {
  const raw = candidate.trim().replace(/^['"]|['"]$/g, '');
  if (raw === '') return false;

  // `~` and `$HOME` both denote the home directory; neither is expanded by the
  // time a hook payload reaches us, so treat them as a home-rooted path rather
  // than as a literal directory name.
  const homeRooted = raw.replace(/^~(?=\/|$)/, '/HOME').replace(/^\$HOME(?=\/|$)/, '/HOME');
  const normalised = homeRooted.replace(/\/+/g, '/');

  for (const tree of SYSTEM_TREES) {
    if (normalised === tree || normalised.startsWith(`${tree}/`)) return true;
  }

  const segments = normalised.split('/').filter((s) => s !== '' && s !== '.');
  for (const segment of segments) {
    if (SENSITIVE_SEGMENTS.includes(segment)) return true;
  }

  const basename = segments.at(-1);
  if (basename !== undefined) {
    if (SENSITIVE_BASENAMES.includes(basename)) return true;
    for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
      if (basename.startsWith(prefix)) return true;
    }
  }

  return false;
}

/**
 * True if any token in a Bash segment names a sensitive destination.
 *
 * Every token is checked, not just the ones that look like a destination:
 * telling an argument from a destination means knowing each command's flag
 * grammar (`tee -a FILE`, `cp SRC... DST`, `mv -t DIR SRC`), and getting that
 * wrong fails OPEN. Checking all tokens can only fail closed — the cost is
 * that `grep /etc/hosts` would also be refused by a write group, which is
 * correct anyway since a write group has no business covering it.
 */
export function segmentTouchesSensitivePath(segment: string): boolean {
  for (const token of segment.split(/\s+/)) {
    if (token === '') continue;
    // Strip a leading `--flag=` so `--output=/etc/x` is seen as `/etc/x`.
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    if (isSensitiveWritePath(value)) return true;
  }
  return false;
}
