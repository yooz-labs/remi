import { describe, expect, test } from 'bun:test';
import { proveCompoundReadOnly } from '../../src/auto-approve/read-only-proof.ts';

const WORKTREE_INVENTORY = `for wt in $(git worktree list --porcelain)
do b=$(git -C "$wt" rev-parse --abbrev-ref HEAD)
merged=$(git branch -r --contains "$b")
remote=$(git ls-remote --heads origin "$b")
dirty=$(git -C "$wt" status --porcelain)
ahead=$(git rev-list --count origin/dev.."$b")
echo "$b | merged_into_dev_or_main=$merged | on_remote=$remote | dirty=$dirty | ahead_of_dev=$ahead | $wt"
done`;

const BRANCH_INVENTORY = `for b in fix/adr-0064-on004212-basis fix/issue-1386-default-branch fix/dev-email-allowlist feature/issue-1336-docs-central-rule feature/issue-1406-epic-anonymous-deposit feature/issue-1374-fleet-annex-policy feature/issue-1159-import-normalize fix/issue-1392-key-registration docs/changelog-0103 feature/issue-1338-phase0-orcid-docs-gate fix/issue-1344-live-tier-guard
do n=$(git log "$b" --not --remotes --oneline 2>/dev/null | wc -l | tr -d ' ')
echo "$b -> unpushed commits: $n"
done`;

describe('Phase 3 compound read-only proof (#1082)', () => {
  test('proves the safe Git/worktree inventory loop', () => {
    const result = proveCompoundReadOnly(WORKTREE_INVENTORY);
    expect(result.status).toBe('proved');
    if (result.status === 'proved') {
      expect(result.leaves.map((leaf) => leaf.name)).toEqual([
        'git:worktree-list',
        'git:rev-parse-abbrev-ref',
        'git:branch-contains',
        'git:ls-remote-heads',
        'git:status',
        'git:rev-list-count',
        'echo',
      ]);
    }
  });

  test('proves the branch inventory loop, including a safe discard redirect', () => {
    expect(proveCompoundReadOnly(BRANCH_INVENTORY)).toEqual({
      status: 'proved',
      leaves: [{ name: 'git:log-remotes' }, { name: 'wc' }, { name: 'tr' }, { name: 'echo' }],
    });
  });

  test('proves a safe non-interpreter rewrite of the worktree pipeline', () => {
    const safeRewrite = `for wt in $(git worktree list --porcelain | grep '^worktree' | cut -d ' ' -f 2 | tail -n +2)
do git -C "$wt" status --porcelain
done`;
    expect(proveCompoundReadOnly(safeRewrite).status).toBe('proved');
  });

  test('rejects the original worktree inventory interpreter', () => {
    const original = `${WORKTREE_INVENTORY.replace(
      'for wt in $(git worktree list --porcelain)',
      "for wt in $(git worktree list --porcelain | grep '^worktree' | tail -n +2 | awk '{print $2}')",
    )}`;
    expect(proveCompoundReadOnly(original)).toEqual({
      status: 'rejected',
      reason: 'interpreter',
    });
  });

  test('rejects mutating or unknown leaves inside a read-looking loop', () => {
    for (const command of [
      'for f in a b; do git push origin main; done',
      'for f in a b; do rm -rf "$f"; done',
      'for f in a b; do timeout 5 git status; done',
      'for f in a b; do sh -c "git status"; done',
      'for f in a b; do find . -exec cat {} \\;; done',
      'git log main --not --remotes --oneline --exec="rm -rf /"',
      'git -C "$wt" -c core.hooksPath=/tmp/evil status --porcelain',
      'git worktree prune',
    ]) {
      expect(proveCompoundReadOnly(command).status).toBe('rejected');
    }
  });

  test('rejects real redirects, sensitive assignments, and substitution in argv', () => {
    expect(proveCompoundReadOnly('n=$(git status) > /tmp/result')).toEqual({
      status: 'rejected',
      reason: 'unsafe-redirect',
    });
    expect(proveCompoundReadOnly('PATH=/tmp/evil; git status')).toEqual({
      status: 'rejected',
      reason: 'sensitive-assignment',
    });
    expect(proveCompoundReadOnly('env PATH=/tmp/evil git status').status).toBe('rejected');
    expect(proveCompoundReadOnly('echo "$(rm -rf /)"').status).toBe('rejected');
    expect(proveCompoundReadOnly('do for f in $(rm -rf /); do echo "$f"; done').status).toBe(
      'rejected',
    );
    expect(proveCompoundReadOnly('do export FOO=bar; git status').status).toBe('rejected');
  });

  test('rejects unsupported shell controls and malformed nesting', () => {
    for (const command of [
      'git status > /tmp/out',
      'git status < /tmp/input',
      'git status &',
      'git status; $(git push origin main)',
      'for f in $(git status; rm -rf /); do echo "$f"; done',
      'for f in $(git status; do echo x; done',
      'for f in `git status`; do echo "$f"; done',
    ]) {
      expect(proveCompoundReadOnly(command).status).toBe('rejected');
    }
  });

  test('enforces bounded recursion and script size', () => {
    let nested = 'echo value';
    for (let i = 0; i < 8; i++) nested = `value=$( ${nested} )`;
    expect(proveCompoundReadOnly(nested)).toEqual({
      status: 'rejected',
      reason: 'recursion-limit',
    });
    expect(proveCompoundReadOnly(`echo ${'x'.repeat(8_200)}`)).toEqual({
      status: 'rejected',
      reason: 'command-too-long',
    });
  });
});
