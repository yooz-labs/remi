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

const WORKTREE_PATHS_PIPELINE =
  "git worktree list --porcelain | grep '^worktree' | tail -n +2 | awk '{print $2}'";

const UV_LOCK_INSPECTION = String.raw`python3 - <<'PY'
import tomllib
d = tomllib.load(open('uv.lock','rb'))
pkgs = {p['name']: p for p in d['package']}
for n in ['sqlalchemy','pybids','frozendict','wrapt','greenlet','psutil']:
    p = pkgs.get(n)
    if not p: continue
    print('==', n, p.get('version'))
    for x in p.get('dependencies',[]):
        print('   ', x)
PY`;

const IMPORT_SEARCH_LOOP = String.raw`for p in "import bids" "from bids" "import neo" "import mne" "import sklearn" "import matplotlib" "import h5py" "import sympy"; do
echo "=== $p ==="
grep -rn "^\s*$p" --include="*.py" src/eegprep | grep -v "/eeglab/" | awk -F: '{print $1}' | sort -u | head -8
grep -rc "^\s*$p" --include="*.py" -r src/eegprep 2>/dev/null | grep -v ":0" | grep -v "/eeglab/" | wc -l
done`;

describe('Phase 2 capability proof (#1094)', () => {
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

  test('proves the real worktree path pipeline with awk field projection', () => {
    expect(proveCompoundReadOnly(WORKTREE_PATHS_PIPELINE)).toEqual({
      status: 'proved',
      leaves: [
        { name: 'git:worktree-list' },
        { name: 'grep' },
        { name: 'tail' },
        { name: 'awk:print-field' },
      ],
    });
  });

  test('proves the original worktree inventory with awk field projection', () => {
    const original = WORKTREE_INVENTORY.replace(
      'for wt in $(git worktree list --porcelain)',
      "for wt in $(git worktree list --porcelain | grep '^worktree' | tail -n +2 | awk '{print $2}')",
    );
    expect(proveCompoundReadOnly(original)).toEqual({
      status: 'proved',
      leaves: [
        { name: 'git:worktree-list' },
        { name: 'grep' },
        { name: 'tail' },
        { name: 'awk:print-field' },
        { name: 'git:rev-parse-abbrev-ref' },
        { name: 'git:branch-contains' },
        { name: 'git:ls-remote-heads' },
        { name: 'git:status' },
        { name: 'git:rev-list-count' },
        { name: 'echo' },
      ],
    });
  });

  test('accepts only single-quoted awk field projections', () => {
    for (const command of ["awk '{print $0}'", "awk '{ print $2 }'", "awk '{\tprint\t$12\t}'"]) {
      expect(proveCompoundReadOnly(command)).toEqual({
        status: 'proved',
        leaves: [{ name: 'awk:print-field' }],
      });
    }
  });

  test('keeps awk projection output typed as text', () => {
    expect(
      proveCompoundReadOnly(
        'for ref in $(awk \'{print $2}\'); do git branch -r --contains "$ref"; done',
      ),
    ).toEqual({
      status: 'rejected',
      reason: 'unsafe-git-form',
    });
  });

  test('rejects broader awk forms as interpreters', () => {
    for (const command of [
      "awk -f program '{print $2}'",
      "awk -v n=2 '{print $n}'",
      'awk "{print $2}"',
      "awk '{print $2; print $3}'",
      "awk '$1 {print $2}'",
      'awk \'{system("id") }\'',
      "awk '{getline line; print line}'",
      'awk \'{printf "%s", $2}\'',
      'awk \'{print $2 | "cat"}\'',
      'awk \'{print $2 > "/tmp/out"}\'',
      "awk '{print $2}' input.txt",
      "awk '{print $2}' '{print $3}'",
    ]) {
      expect(proveCompoundReadOnly(command)).toEqual({
        status: 'rejected',
        reason: 'interpreter',
      });
    }
  });

  test('proves the exact bounded uv.lock Python inspection from the live corpus', () => {
    expect(proveCompoundReadOnly(UV_LOCK_INSPECTION)).toEqual({
      status: 'proved',
      leaves: [{ name: 'python:lock-inspection' }],
    });
  });

  test('proves the live import-search loop, including its bounded awk projection', () => {
    expect(proveCompoundReadOnly(IMPORT_SEARCH_LOOP)).toEqual({
      status: 'proved',
      leaves: [
        { name: 'echo' },
        { name: 'grep' },
        { name: 'grep' },
        { name: 'awk:print-field' },
        { name: 'sort' },
        { name: 'head' },
        { name: 'grep' },
        { name: 'grep' },
        { name: 'grep' },
        { name: 'wc' },
      ],
    });
  });

  test('rejects arbitrary or shell-expanding Python even when it looks read-only', () => {
    for (const command of [
      UV_LOCK_INSPECTION.replace("<<'PY'", '<<PY'),
      UV_LOCK_INSPECTION.replace('import tomllib', 'import os\nimport tomllib'),
      UV_LOCK_INSPECTION.replace("open('uv.lock','rb')", "open('uv.lock','w')"),
      UV_LOCK_INSPECTION.replace("print('   ', x)", "os.system('whoami')\n        print('   ', x)"),
      'python3 -c "print(open(\'uv.lock\').read())"',
    ]) {
      expect(proveCompoundReadOnly(command).status).toBe('rejected');
    }
  });

  test('proves bounded find reads and rejects its write/exec predicates', () => {
    for (const command of [
      'find . -type f -name "*.py" -print',
      'find src -maxdepth 3 -type f -readable',
      'find . -not -path "./.git/*" -type f -print0',
    ]) {
      expect(proveCompoundReadOnly(command)).toEqual({
        status: 'proved',
        leaves: [{ name: 'find' }],
      });
    }
    for (const command of [
      'find . -name "*.py" -delete',
      'find . -exec cat {} \\;',
      'find . -execdir sh -c "cat {}" \\;',
      'find . -fprint /tmp/list',
      'find . -printf "%p\\n"',
    ]) {
      expect(proveCompoundReadOnly(command).status).toBe('rejected');
    }
  });

  test('proves output-only GitHub reads and rejects sub-issue mutations', () => {
    for (const command of [
      'gh issue list --state open --limit 50',
      'gh issue view 1092 --comments',
      "gh api 'repos/{owner}/{repo}/issues' --jq '.[].number'",
      'gh sub-issue list 1092',
      'gh --repo yooz-labs/remi sub-issue list 1092',
      'gh --hostname github.com api /repos/o/r/issues',
      'gh --hostname=GITHUB.COM api /repos/o/r/issues',
    ]) {
      expect(proveCompoundReadOnly(command).status).toBe('proved');
    }
    for (const command of [
      'gh sub-issue add 1092 --sub-issue-number 1093',
      'gh sub-issue remove 1092 --sub-issue-number 1093',
      'gh sub-issue reprioritize 1092 --sub-issue-number 1093 --after 1094',
      'gh sub-issue unknown 1092',
      'gh api /repos/o/r/issues?state=*',
      'gh api -X POST /repos/o/r/issues',
      'gh --hostname evil.example api /repos/o/r/issues',
      'gh --hostname=evil.example issue list',
    ]) {
      expect(proveCompoundReadOnly(command).status).toBe('rejected');
    }
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
      'sort --compress-program=sh file',
      'rg --pre=sh pattern .',
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
    expect(proveCompoundReadOnly('BASH_XTRACEFD=9; git status')).toEqual({
      status: 'rejected',
      reason: 'sensitive-assignment',
    });
    for (const variable of ['GH_HOST', 'GH_TOKEN', 'GITHUB_TOKEN', 'PAGER']) {
      expect(proveCompoundReadOnly(`${variable}=untrusted; gh api /repos/o/r/issues`).status).toBe(
        'rejected',
      );
    }
    expect(proveCompoundReadOnly('env PATH=/tmp/evil git status').status).toBe('rejected');
    expect(proveCompoundReadOnly('echo "$(rm -rf /)"').status).toBe('rejected');
    expect(proveCompoundReadOnly('do for f in $(rm -rf /); do echo "$f"; done').status).toBe(
      'rejected',
    );
    expect(proveCompoundReadOnly('do export FOO=bar; git status').status).toBe('rejected');
    expect(proveCompoundReadOnly('FOO=bar; git status --short').status).toBe('rejected');
    for (const command of [
      'sort "$FLAGS" input',
      'sort *',
      'tree "$FLAGS" .',
      'tail "$FLAGS" file',
      'rg "$FLAGS" .',
      'find . -name "$PRED"',
      'find . -name *.py',
      'flags=$(echo "-o /tmp/out"); sort "$flags" input',
    ]) {
      expect(proveCompoundReadOnly(command).status).toBe('rejected');
    }
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
      'for f in $(echo `git status)`; do echo "$f"; done',
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
