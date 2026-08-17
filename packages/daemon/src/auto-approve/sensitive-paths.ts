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
 * ## Code-execution surfaces, not just secrets
 *
 * `.git/hooks/pre-commit` runs on the next commit. With `vcs-write` enabled,
 * that commit is itself auto-approved — so a write to `.git/` followed by a
 * `git commit` is arbitrary code execution assembled from two individually
 * approved steps.
 *
 * Review of #960 found the same shape reached three other ways, and the third
 * is the reason `BUILD_SURFACE` exists below:
 *
 * - `~/.gitconfig` sets `core.hooksPath` to any directory, or defines a
 *   `[alias] commit = "!curl … | sh"`. Same outcome as writing `.git/hooks`,
 *   via a file that is not under `.git/` at all. `shell-safety.ts` already
 *   vetoes the ephemeral `git -c core.hooksPath=…` form, so the risk was
 *   understood; the persistent file achieving the same thing was missed.
 * - **`package.json` needs NO second opt-in.** `bun run typecheck` is a
 *   `build-test` prefix, and `build-test` is on by DEFAULT. So `fs-write`
 *   alone lets an auto-approved edit to `package.json`'s `scripts` inject a
 *   payload that an already-auto-approved build command then executes. Every
 *   file whose contents a default-enabled group will EXECUTE is therefore a
 *   code-execution surface, not ordinary project data.
 * - `.github/workflows/` executes on push, off this machine entirely.
 *
 * The general rule this encodes: a write group must not be able to write
 * anything that any enabled group later runs.
 *
 * ## Case-insensitivity is not optional here
 *
 * macOS's default filesystem is case-insensitive-but-preserving, and macOS is
 * the primary target. `/ETC/hosts` and `~/.REMI/config.toml` resolve to the
 * same inodes as their lowercase spellings, so a case-sensitive check is not
 * a stylistic nit — it is a complete bypass of every rule in this file. All
 * matching below is done on a lowercased path (#960 review).
 */

import { shellWords } from './shell-safety.ts';

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
  '/system',
  '/library',
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
  // CI definitions: they execute on push, on a machine this guard cannot see.
  '.github',
  '.gitlab-ci.yml',
  // Editor/tooling autorun surfaces.
  '.vscode',
  '.idea',
];

/**
 * Files whose CONTENTS an already-enabled group will execute (#960 review).
 *
 * Distinct in kind from the secrets above: none of these is confidential, and
 * writing one is an ordinary development act. They are here because
 * `build-test` ships ENABLED BY DEFAULT and runs `bun test`, `bun run
 * typecheck`, `pytest`, `biome check` — every one of which reads its
 * behaviour out of a file on this list. An auto-approved write to any of them
 * turns the next auto-approved build command into arbitrary code execution,
 * with no second group needing to be opted into.
 *
 * This is the cost of a write group coexisting with an execute group, and it
 * is paid here rather than by hoping the two are never enabled together.
 */
const BUILD_SURFACE: readonly string[] = [
  'package.json',
  'package-lock.json',
  'bun.lock',
  'bun.lockb',
  'pnpm-lock.yaml',
  'yarn.lock',
  'tsconfig.json',
  'biome.json',
  'biome.jsonc',
  'makefile',
  'justfile',
  'pyproject.toml',
  'uv.lock',
  'setup.py',
  'conftest.py',
  'cargo.toml',
  'dockerfile',
  'lefthook.yml',
  'lefthook.yaml',
  '.pre-commit-config.yaml',
  'vitest.config.ts',
  'vitest.config.js',
  'jest.config.js',
  'jest.config.ts',
  'webpack.config.js',
  'webpack.config.ts',
  'rollup.config.js',
  'rollup.config.ts',
  'babel.config.js',
  '.babelrc',
  'vite.config.js',
  'vite.config.ts',
  'bunfig.toml',
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
  // `core.hooksPath` and `[alias] x = "!sh -c …"` make this file a code-
  // execution surface reached without touching `.git/` at all (#960 review).
  '.gitconfig',
  '.gitmodules',
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
  // Strip quote and escape characters ANYWHERE, not just at the ends (#960
  // second review). The Bash path now hands this already-tokenized words, so
  // it should never see a quote — but `/et"c"/hosts` returning false while
  // naming `/etc/hosts` is too sharp an edge to leave on a predicate other
  // code may call directly. Removing these can only make the check match
  // MORE, so it cannot open a hole; a filename genuinely containing a quote
  // gets an unnecessary escalation, which is the safe direction.
  const raw = candidate.trim().replace(/['"\\]/g, '');
  if (raw === '') return false;

  // LOWERCASED before anything else. macOS's default filesystem is
  // case-insensitive, so `/ETC/hosts` and `/etc/hosts` are the same file; a
  // case-sensitive comparison here bypasses every rule below (#960 review).
  // Every comparison list in this module is authored in lowercase to match.
  const lowered = raw.toLowerCase();

  // `~` and `$HOME` both denote the home directory; neither is expanded by the
  // time a hook payload reaches us, so treat them as a home-rooted path rather
  // than as a literal directory name.
  const homeRooted = lowered.replace(/^~(?=\/|$)/, '/home').replace(/^\$home(?=\/|$)/, '/home');
  const collapsed = homeRooted.replace(/\/+/g, '/');

  // Resolve `..` BEFORE the system-tree prefix check. Without this,
  // `/Users/x/project/../../../etc/hosts` fails every `startsWith('/etc')`
  // test while naming exactly that file (#960 review). The segment scan below
  // was already traversal-robust because it inspects each segment
  // individually; the prefix axis was not.
  const resolved = resolveDotDot(collapsed);

  for (const tree of SYSTEM_TREES) {
    if (resolved === tree || resolved.startsWith(`${tree}/`)) return true;
  }

  // A relative path that still ascends after resolution cannot be prefix-
  // matched against an absolute system tree, which is how
  // `../../../etc/hosts` slipped through (#960 review). Strip the leading
  // ascent and test what it lands ON.
  //
  // NOT a blanket refusal of `..`: `git worktree add ../x` and `cp a ../sibling`
  // are ordinary, and refusing every ascending path would escalate them for no
  // reason. Only the destination matters.
  if (resolved === '..' || resolved.startsWith('../')) {
    const landing = resolved.replace(/^(\.\.\/)+/, '');
    const firstSegment = landing.split('/')[0] ?? '';
    for (const tree of SYSTEM_TREES) {
      if (firstSegment === tree.slice(1)) return true;
    }
  }

  const segments = resolved.split('/').filter((s) => s !== '' && s !== '.');
  for (const segment of segments) {
    if (SENSITIVE_SEGMENTS.includes(segment)) return true;
  }

  const basename = segments.at(-1);
  if (basename !== undefined) {
    if (SENSITIVE_BASENAMES.includes(basename)) return true;
    if (BUILD_SURFACE.includes(basename)) return true;
    for (const prefix of SENSITIVE_BASENAME_PREFIXES) {
      if (basename.startsWith(prefix)) return true;
    }
  }

  return false;
}

/**
 * Collapse `.` and `..` segments lexically, preserving whether the path was
 * absolute. Purely textual — it does not resolve symlinks, and cannot: a
 * symlink whose target is `/etc` is invisible to any string-level check. See
 * the "defense in depth" caveat in the module doc.
 *
 * Exported for reuse by `permission-groups.ts`'s `scratch` group, which needs
 * the identical `..`/`.` collapse to tell `/tmp/../etc` apart from a genuine
 * `/tmp` subpath before checking which root a target lands under — the same
 * ordering requirement documented above ("resolve `..` BEFORE the prefix
 * check"), so it is reused rather than re-derived.
 */
export function resolveDotDot(path: string): string {
  const absolute = path.startsWith('/');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = out.at(-1);
      if (last !== undefined && last !== '..') out.pop();
      else if (!absolute) out.push('..');
      // An absolute path cannot rise above `/`, matching the kernel.
      continue;
    }
    out.push(segment);
  }
  return `${absolute ? '/' : ''}${out.join('/')}`;
}

/**
 * Join `relParts` onto `base`, collapsing `.`/`..` lexically, and refusing to
 * pop below `floorLen` segments — the scratch-root boundary a target may never
 * be navigated above. Returns null on an attempted escape.
 *
 * Lives here (not in `permission-groups.ts`) so the ONE absolute-scratch
 * classifier below is shared by BOTH the `scratch` group (which composes it
 * with `cd`-tracked relative offsets) and `risk-bands.ts`'s ceiling carve-out
 * (which needs only the pure, cwd-free absolute case). `permission-groups.ts`
 * imports `risk-bands.ts` already, so risk-bands cannot import back from it —
 * this module, which both import and which imports neither, is the one place a
 * shared predicate can live without a cycle.
 */
export function joinScratchSegments(
  base: readonly string[],
  floorLen: number,
  relParts: readonly string[],
): string[] | null {
  const segs = [...base];
  for (const part of relParts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (segs.length <= floorLen) return null;
      segs.pop();
    } else {
      segs.push(part);
    }
  }
  return segs;
}

/**
 * Classify an ABSOLUTE-shaped token (`/tmp/...`, `/private/tmp/...`,
 * `$TMPDIR/...`, `${TMPDIR}/...`) into its scratch-root segments and the length
 * of the root itself, or null if it is not one of those four shapes. `..`/`.`
 * are resolved via `resolveDotDot` BEFORE the root check runs, the same
 * ordering that function documents and for the same reason: `/tmp/../etc`
 * fails every `startsWith('/tmp')` test only AFTER resolution, not before.
 *
 * Any `$`/`~` beyond the recognised `$TMPDIR` marker refuses the token (#1061):
 * an unresolved shell expansion mid-path (`$TMPDIR/$FOO`, `/tmp/$FOO`) is not a
 * path this pure check can prove stays under a scratch root.
 */
export function classifyScratchAbsolute(
  token: string,
): { segments: string[]; rootLen: number } | null {
  for (const marker of ['$TMPDIR', '${TMPDIR}']) {
    if (token === marker || token.startsWith(`${marker}/`)) {
      const rest = token.slice(marker.length).replace(/^\//, '');
      if (rest.includes('$') || rest.includes('~')) return null;
      const extra = rest === '' ? [] : rest.split('/');
      const segs = joinScratchSegments(['$TMPDIR'], 1, extra);
      return segs === null ? null : { segments: segs, rootLen: 1 };
    }
  }
  if (token.startsWith('/')) {
    if (token.includes('$') || token.includes('~')) return null;
    const resolved = resolveDotDot(token);
    const segs = resolved.split('/').filter((s) => s !== '');
    if (segs[0] === 'tmp') return { segments: segs, rootLen: 1 };
    if (segs[0] === 'private' && segs[1] === 'tmp') return { segments: segs, rootLen: 2 };
    return null;
  }
  return null;
}

/**
 * True if `token` is an ABSOLUTE path that resolves STRICTLY under a scratch
 * root (deeper than the root itself) — the pure, cwd-free half of
 * `permission-groups.ts`'s `isStrictlyUnderScratchRoot`. Strict, not
 * root-or-equal: `/tmp` and `/private/tmp` themselves are the roots, so
 * deleting them (`rm -rf /tmp`) does NOT qualify. A relative token, a
 * non-scratch absolute path (`/etc/...`, `~/...`, `$HOME/...`), or a `..`
 * escape (`/tmp/../etc`) all return false.
 *
 * This is the SAME classifier the `scratch` permission group uses for absolute
 * targets; `risk-bands.ts` consumes it so the ceiling cannot treat a deletion
 * as high-risk that `scratch` would already approve deterministically (#1071).
 */
export function isAbsoluteScratchTarget(token: string): boolean {
  const resolved = classifyScratchAbsolute(token);
  return resolved !== null && resolved.segments.length > resolved.rootLen;
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
  for (const token of shellWords(segment)) {
    if (token === '') continue;
    // Strip a leading `--flag=` so `--output=/etc/x` is seen as `/etc/x`.
    const value = token.includes('=') ? token.slice(token.indexOf('=') + 1) : token;
    if (isSensitiveWritePath(value)) return true;
  }
  return false;
}
