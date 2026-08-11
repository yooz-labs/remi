/**
 * ADR 0023: `artifact-clean` — deletion approves only when every target is
 * PROVABLY derived state.
 *
 * The adversarial corpus below is part of the deliverable, not documentation
 * (ADR 0023): #959 needed four review rounds and found eleven bypasses, three
 * of them in code written to fix the previous round. Every negative entry
 * asserts the verdict the design requires — null, i.e. fall through to the
 * LLM, where deletion still escalates at every level — and every positive
 * control asserts the 0ms approval the group exists to grant, including the
 * three measured misses that motivated it (each ~3.5s of LLM time before).
 *
 * No mocks (repo rule): `matchGroups` is a pure function over
 * (toolName, toolInput), so none are needed.
 */

import { describe, expect, test } from 'bun:test';
import { groupsForLevel } from '../../src/auto-approve/levels.ts';
import { matchGroups, matchGroupsBroad } from '../../src/auto-approve/permission-groups.ts';

const GROUP = ['artifact-clean'];

/** Match a Bash command; defaults to the group under test, alone. */
function bash(command: string, groups: readonly string[] = GROUP): string | null {
  return matchGroups('Bash', { command }, groups);
}

describe('positive controls: the three measured misses approve', () => {
  // The cold-replay population (ADR 0023 receipts): covering exactly these
  // three takes the owner's real escalation replay from 17/21 to 20/21.
  test('rm -rf dist', () => {
    expect(bash('rm -rf dist')).toBe('artifact-clean:rm');
  });

  test('rm -rf node_modules && bun install', () => {
    expect(bash('rm -rf node_modules && bun install')).toBe('artifact-clean:rm');
  });

  test('git worktree remove --force ../remi-1031', () => {
    expect(bash('git worktree remove --force ../remi-1031')).toBe(
      'artifact-clean:git worktree remove',
    );
  });
});

describe('positive controls: ordinary artifact cleanup', () => {
  const cases: Array<[string, string]> = [
    ['rm -rf node_modules', 'artifact-clean:rm'],
    ['rm -rf packages/web/dist', 'artifact-clean:rm'],
    ['rm -rf dist coverage', 'artifact-clean:rm'],
    ['rm -rf ./dist', 'artifact-clean:rm'],
    ['rm -rf "dist"', 'artifact-clean:rm'],
    // Deleting UNDER an artifact dir is as proved as deleting the dir.
    ['rm -rf dist/assets', 'artifact-clean:rm'],
    ['rm -rf __pycache__', 'artifact-clean:rm'],
    ['rm -rf .venv', 'artifact-clean:rm'],
    ['rm -rf target/debug', 'artifact-clean:rm'],
    // A discard redirect is permitted by hasShellControl and must not be
    // mistaken for a positional target.
    ['rm -rf coverage 2>/dev/null', 'artifact-clean:rm'],
    // Earned by the cd-redirect fix: stripping redirects before tokenizing the
    // cd means a real descent with a real redirect is now provable.
    ['cd sub 2>/dev/null && rm -rf dist', 'artifact-clean:rm'],
    // Exact long spellings are on the allowlist.
    ['rm --recursive --force dist', 'artifact-clean:rm'],
    ['rmdir build', 'artifact-clean:rmdir'],
    ['rmdir -p out/nested', 'artifact-clean:rmdir'],
    // A plain relative-descendant cd does not poison.
    ['cd packages/web && rm -rf dist', 'artifact-clean:rm'],
    ['bun install', 'artifact-clean:bun install'],
    ['bun install --frozen-lockfile', 'artifact-clean:bun install'],
    ['git worktree remove ../engine-epic-v0.6.0', 'artifact-clean:git worktree remove'],
    ['git worktree remove -f ../wt', 'artifact-clean:git worktree remove'],
  ];
  for (const [cmd, expected] of cases) {
    test(JSON.stringify(cmd), () => expect(bash(cmd)).toBe(expected));
  }

  test('the declared residual: a SOURCE dir genuinely named build is deletable', () => {
    // ADR 0023 accepts this: the name list is a convention, not a guarantee.
    // Bounded honestly — tracked contents come back via `git checkout --
    // build` (rm does not touch shared history); untracked contents are
    // lost, the same residual the owner accepted for worktree --force. A
    // DECLARED residual, not a bug: do not "fix" it here.
    expect(bash('rm -rf build')).toBe('artifact-clean:rm');
  });
});

/**
 * The 40-entry adversarial corpus (ADR 0023). Expected verdict for every
 * entry: null — fall through to the LLM, where deletion escalates at every
 * level. Grouped by the veto that must catch each; the second column names
 * it, so a future red test says WHICH proof obligation broke.
 */
const ADVERSARIAL: ReadonlyArray<[string, string]> = [
  // --- target grammar: the name proof (14)
  ['rm -rf src', 'no artifact-named segment'],
  ['rm -rf Dist', 'exact-case only: Dist is not dist on case-sensitive filesystems'],
  ['rm -rf dist/../src', 'dot-dot resolves BEFORE the name scan: this names src'],
  ['rm -rf ../dist', 'ascending target'],
  ['rm -rf node_modules/../../etc', 'still ascends after resolution'],
  ['rm -rf /Users/me/project/dist', 'absolute target'],
  ['rm -rf ~/dist', 'home-rooted target'],
  ['rm -rf $HOME/dist', 'variable expansion'],
  ['rm -rf dist/', 'trailing slash traverses a symlinked dir target on some platforms'],
  ['rm -rf dist src', 'EVERY target must prove, not just one'],
  ['rm -rf dist*', 'glob'],
  ['rm -rf {dist,build}', 'brace expansion'],
  // The two entries above do NOT pin the expansion guard, which the ADR 0023
  // adversarial pass caught by mutation: delete `*` or `{}` from
  // ARTIFACT_EXPANSION_RE and both stay GREEN, because `dist*` and
  // `{dist,build}` are refused by the EXACT-NAME check anyway — neither is an
  // artifact name. A corpus entry named for a guard it does not exercise is
  // the ADR 0011 row-5 anti-pattern. These three do exercise it: each carries
  // a real artifact segment, so the name check passes and only the expansion
  // guard stands between them and an approval.
  ['rm -rf */dist', 'glob in a PARENT segment: the name check passes on `dist`'],
  ['rm -rf dist/*', 'glob in a CHILD segment: same'],
  ['rm -rf {a,b}/dist', 'brace in a parent segment: same'],
  ['rm -rf dist/.env', 'sensitive basename under an artifact dir: the deny axis wins'],
  // A quoted `>` inside a target used to TRUNCATE the token the proof saw:
  // `rewriteRedirectClauses` is quote-blind and runs on raw text, so
  // `isProvedArtifactTarget` only ever got `dist` and the `..` segments were
  // invisible. Executed against a real filesystem, it deleted a sibling above
  // the cwd. An earlier ADR draft called this a bounded junk-name residual;
  // the PR review showed it reaches source and, with enough `..`, anywhere.
  ["rm -rf 'dist>x/../../src'", 'quoted > truncated the token: this names ../../src'],
  ["rm -rf 'coverage>x/../..'", 'same, ascending out of the tree'],
  ["rm -rf 'node_modules>x/../../../../Documents'", 'same, reaching $HOME/Documents'],
  ["rm -rf 'dist<x/../../src'", 'input redirect, same truncation shape'],
  ['rm -rf', 'no target, no proof'],
  // --- flag axis: exact allowlist (5)
  ['rm --no-preserve-root -rf dist', 'long flag outside the exact allowlist'],
  ['rm --recur dist', 'GNU abbreviation of --recursive: outside the EXACT-spelling set'],
  ['rm --force=yes dist', 'a value-carrying spelling is not the exact token'],
  ['rm -rfd dist', 'unknown short flag inside a cluster'],
  ['rmdir --ignore-fail-on-non-empty build', 'rmdir long flag outside the allowlist'],
  // --- shell structure (6)
  ['rm -rf $(pwd)/dist', 'command substitution'],
  ['rm -rf dist > deleted.txt', 'redirect to a real file'],
  ['rm -rf dist; rm -rf /etc/cron.d', 'every compound segment must be covered'],
  ['rm -rf dist\nrm -rf ~/Documents', 'an unquoted newline is a separator'],
  ['sudo rm -rf dist', 'wrappers are not covered prefixes'],
  ['VERBOSE=1 rm -rf dist', 'assignment prefixes are never peeled'],
  // --- cd poison (7)
  ['cd /etc && rm -rf dist', 'absolute cd: dist now names /etc/dist'],
  ['cd .. && rm -rf node_modules', 'ascending cd'],
  ['cd ~ && rm -rf .venv', 'home cd'],
  ['cd $TMPDIR && rm -rf build', 'expansion cd (scratch may prove this; THIS group must not)'],
  ['cd - && rm -rf dist', 'cd -: the previous directory is unknowable statically'],
  ['cd && rm -rf dist', 'bare cd goes to $HOME'],
  // The independent adversarial pass's one confirmed bypass (#1047). `cd`
  // reads a leading-dash token as OPTIONS, so these are an option with NO
  // operand -- and a bare `cd` goes to $HOME. Verified in bash on darwin: each
  // lands in /Users/<user>. Only the exact `-` was rejected, so `cd -P` read as
  // plain relative descent and `cd -P && rm -rf .venv` deleted ~/.venv at 0ms.
  ['cd -P && rm -rf dist', 'cd -P is an option with no operand: goes to $HOME'],
  ['cd -L && rm -rf node_modules', 'cd -L likewise'],
  ['cd -- && rm -rf .venv', 'cd -- likewise: end-of-options, no operand'],
  ['cd -LP && rm -rf dist', 'a combined option cluster, still no operand'],
  [
    'cd -P && cd projectX && rm -rf node_modules',
    'the worst case: a second PLAIN cd descends normally from $HOME, reaching any project',
  ],
  // The SECOND PR-review round: the same worst case, one spelling over. The
  // #1047 fix rejected a leading dash, but `shellWords('cd ..>/dev/null')`
  // glues the operand to the redirect, so the token is neither `..` nor
  // `../…` and no poison was set. Real bash ascends, and the segment is
  // idempotent — N of them climb N levels, reaching ~/.venv. Every one of
  // these is a TOKEN-BOUNDARY variation; the entries above are all
  // TOKEN-SHAPE variations, which is exactly why none of them caught it.
  ['cd ..>/dev/null && rm -rf dist', 'redirect glued to the operand hides the ascent'],
  ['cd ..>&1 && rm -rf dist', 'fd-dup spelling of the same'],
  ['cd ..>>/dev/null && rm -rf dist', 'append spelling'],
  ['cd ..&>/dev/null && rm -rf dist', '&> is not even modelled by rewriteRedirectClauses'],
  ['cd "..">/dev/null && rm -rf dist', 'quoted operand, same glue'],
  [
    'cd ..>/dev/null && cd ..>/dev/null && cd ..>/dev/null && rm -rf .venv',
    'idempotent: three of them climb three levels, to ~/.venv',
  ],
  ['if true; then cd /etc; fi\nrm -rf dist', 'a grammar-wrapped cd runs zero or more times'],
  // --- git worktree remove structure (5)
  ['git worktree remove --force --force ../wt', 'a second --force overrides a LOCK'],
  ['git worktree remove .', 'the current worktree'],
  ['git worktree remove ../a ../b', 'exactly one positional'],
  ['git worktree remove --force', 'a force with no target'],
  ['git worktree remove -C .. wt', 'unmodeled flag'],
  // --- bun install / git clean (3)
  ['bun install left-pad', 'a positional makes it bun add in disguise'],
  ['bun install --force', 'outside the lockfile-faithful shape'],
  ['git clean -xfd', 'git clean is excluded in every form: untracked is not derived'],
];

describe('the adversarial corpus: 58 refusals (ADR 0023)', () => {
  test('the corpus is the full 58 entries', () => {
    // 40 from the design's own corpus; 8 added by the independent adversarial
    // pass ADR 0023 requires before merge: 5 for the `cd -<option>` family
    // (#1047) and 3 that actually pin the expansion guard the two shipped
    // glob/brace entries only appeared to.
    expect(ADVERSARIAL.length).toBe(58);
  });

  for (const [cmd, why] of ADVERSARIAL) {
    test(`${JSON.stringify(cmd)} — ${why}`, () => {
      expect(bash(cmd)).toBeNull();
    });
  }
});

describe('level integration: trusted only', () => {
  const TRUSTED = groupsForLevel('trusted');
  const BALANCED = groupsForLevel('balanced');

  test('artifact-clean is gated into trusted only', () => {
    expect(groupsForLevel('trusted')).toContain('artifact-clean');
    expect(groupsForLevel('balanced')).not.toContain('artifact-clean');
    expect(groupsForLevel('strict')).not.toContain('artifact-clean');
  });

  test('at trusted, rm -rf dist approves although scratch also lists rm', () => {
    // `rm` has TWO owners at trusted: scratch (destination proof) and
    // artifact-clean (name proof). First-registrant-only dispatch would let
    // scratch eat the prefix and veto (dist is not under a scratch root) —
    // the matcher must try every owner's proof.
    expect(matchGroups('Bash', { command: 'rm -rf dist' }, TRUSTED)).toBe('artifact-clean:rm');
  });

  test('at trusted, scratch still proves what it always proved', () => {
    expect(matchGroups('Bash', { command: 'rm -rf /tmp/junk' }, TRUSTED)).toBe('scratch:rm');
    expect(matchGroups('Bash', { command: 'cd /private/tmp/work && rm -rf output' }, TRUSTED)).toBe(
      'scratch:rm',
    );
  });

  test('a corpus refusal for THIS group may still be proved by scratch at trusted', () => {
    // `cd $TMPDIR` poisons artifact-clean (expansion cd), but scratch's own
    // cwd tracking recognizes $TMPDIR and proves `build` lands under it.
    // Same command, two independent proofs, one suffices — by design
    // (ADR 0023 point 4: /tmp deletion is scratch's, not re-implemented).
    expect(matchGroups('Bash', { command: 'cd $TMPDIR && rm -rf build' }, TRUSTED)).toBe(
      'scratch:rm',
    );
  });

  test('at balanced, artifact deletion still escalates', () => {
    expect(matchGroups('Bash', { command: 'rm -rf dist' }, BALANCED)).toBeNull();
    expect(
      matchGroups('Bash', { command: 'git worktree remove --force ../wt' }, BALANCED),
    ).toBeNull();
    expect(matchGroups('Bash', { command: 'bun install' }, BALANCED)).toBeNull();
  });

  test('at trusted, unproved deletion still escalates', () => {
    expect(matchGroups('Bash', { command: 'rm -rf src' }, TRUSTED)).toBeNull();
    expect(matchGroups('Bash', { command: 'rm -rf ~/Documents' }, TRUSTED)).toBeNull();
    expect(matchGroups('Bash', { command: 'git clean -xfd' }, TRUSTED)).toBeNull();
  });
});

describe('owner fallback: a shared prefix is judged by every owner', () => {
  test('scratch coverage no longer shrinks when fs-write is requested alongside', () => {
    // With scratch ALONE this always approved. Before the multi-owner map,
    // requesting fs-write alongside flipped it to an escalation, because
    // fs-write registered `cp` first and its flag veto (--force) ended the
    // match — adding a group could REMOVE approvals. Approving is the
    // designed reading: the destination proof confines the blast radius to
    // the scratch root, and the matcher is now monotone in its group list.
    const cmd = 'cd /tmp/s && cp --force a b';
    expect(matchGroups('Bash', { command: cmd }, ['scratch'])).toBe('scratch:cp');
    expect(matchGroups('Bash', { command: cmd }, ['fs-write', 'scratch'])).toBe('scratch:cp');
  });
});

/**
 * Found by the ADR 0023 adversarial pass, and it is this branch's own
 * regression rather than a pre-existing one. `matchGroups` was rewritten from
 * first-registrant-wins to a UNION over every owning group, which fixed a real
 * non-monotonicity — but the union is disjunctive over VETOES too. For the
 * five prefixes owned by both `fs-write` and `scratch` (cp/mv/mkdir/touch/tee),
 * `scratch`'s laxer proof discarded `fs-write`'s sensitive-destination veto,
 * which `scratchTargetVeto` never had. Measured develop -> branch at BALANCED,
 * a level ADR 0023 does not claim to touch:
 *
 *     cp /tmp/a /tmp/.env         develop: escalate -> was: scratch:cp @ 0ms
 *     mv /tmp/a /tmp/id_rsa       develop: escalate -> was: scratch:mv
 *     cp /tmp/a /tmp/.git/config  develop: escalate -> was: scratch:cp
 *
 * It also falsified a shipped claim in config.ts ("the write groups refuse
 * sensitive destinations regardless of prefix ... credentials (.env, id_rsa)").
 *
 * Per group, not once, so that adding a mutating group and forgetting
 * `MUTATING_GROUPS` fails here rather than shipping.
 */
describe('the sensitive-destination axis survives the owner union', () => {
  const BALANCED = groupsForLevel('balanced');
  const TRUSTED_ALL = groupsForLevel('trusted');

  const sensitive: Array<[string, string]> = [
    ['cp /tmp/a /tmp/.env', 'a credential basename, inside a scratch root'],
    ['mv /tmp/a /tmp/id_rsa', 'a private key'],
    ['tee /tmp/bun.lock', 'a build-surface lockfile'],
    ['cp /tmp/a /tmp/.git/config', 'git config: core.hooksPath is a code-exec pivot'],
    ['mv /tmp/pkg /tmp/package.json', 'build surface'],
  ];

  for (const [cmd, why] of sensitive) {
    test(`${JSON.stringify(cmd)} escalates at balanced — ${why}`, () => {
      expect(bash(cmd, BALANCED)).toBeNull();
    });
    test(`${JSON.stringify(cmd)} escalates at trusted too`, () => {
      expect(bash(cmd, TRUSTED_ALL)).toBeNull();
    });
  }

  test('an ordinary scratch write is untouched — the fix costs no coverage', () => {
    expect(bash('cp /tmp/a /tmp/b', BALANCED)).not.toBeNull();
    expect(bash('rm -rf /tmp/junk', BALANCED)).not.toBeNull();
  });

  test('READING a sensitive path is still allowed: the axis is write-side only', () => {
    // A first cut applied the axis to every owner, not just the mutating ones,
    // and broke `jq .version package.json` plus two /dev/null redirect cases.
    // Reading a sensitive path is exactly what `read-only` exists to allow.
    expect(bash('jq .version package.json', BALANCED)).not.toBeNull();
  });
});

describe('deny stays broad (ADR 0010)', () => {
  test('artifact-clean in deny_groups blocks any rm anywhere in a compound', () => {
    expect(matchGroupsBroad('Bash', { command: 'echo hi && rm -rf dist' }, GROUP)).toBe(
      'artifact-clean:rm',
    );
  });
});
