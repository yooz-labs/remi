# PR CI scope (#1359)

CI and Relay R7 always start on PRs to develop/main. A shared Python classifier
reads the complete merge-base-to-head git diff, with deleted paths and both sides
of renames. The existing check names remain present: unrelated steps report a
successful scoped skip. A successful classifier selects full gates for missing history/event data or
unknown inputs. Tool/setup/validator failure fast-fails the stable checks and
blocks merge without starting runtime work. Missing or invalid mandatory outputs
fail the action before a scope job can succeed. Main pushes and manual R7 runs
always select their existing full gates.

| Inputs | Ordinary gates | R7 |
| --- | --- | --- |
| Docs, native Swift/Xcode files, web CSS/assets | Spelling; native JSON also Biome | Skip |
| `docs/PROVISIONING.md` executable bootstrap fixture | Spelling + full coverage | Skip |
| Owned tunnel proof scripts | Spelling; TS/JS/JSON also Biome | Skip |
| Web TS source/tests | Web source/tests and relay integration type checks, full coverage | Run |
| Daemon/shared/Worker inputs | All existing gates | Run |
| Root version or host build-target declarations only | Biome, root type check, notices, full coverage | Skip |
| Named release/admin/macOS workflows, distribution scripts, npm metadata | Biome, root type check, notices, full coverage | Skip |
| CI routing/classifier/workflow validation changes | Spelling + actual diff corpus/YAML/actionlint | Skip |
| Normal CI execution changes | Affected Lint/Type Check/Test commands + workflow validation | Skip unless toolchain/global inputs change |
| R7 commands/actions/env/pin/runner/timeout/test-list changes | Workflow validation | Run |
| Dependencies, toolchain/global config, unknown input or unavailable comparison | All existing gates | Run |

Root package exemptions compare parsed JSON objects. Only `version` and named
host build-target script declarations are removed from the comparison; a changed
dependency, unrelated script or unknown field selects R7. The historical Darwin
x64 declaration is recognized to allow its removal, not to add Intel acceptance.
Biome already excludes packages/web; web-only changes do not install it to check
an ignored directory. Web TS retains conservative R7 coverage until a verified
dependency trace supports a narrower classification.

The proof exemption also scans source/test files at the PR head and target base for consumers;
any reference to either proof directory, or an unavailable scan, runs all gates.
Moving a candidate into a live caller cannot preserve its standalone exemption.
Files with Bun test/spec names under docs, npm metadata or proof directories also
run full gates, because suite discovery does not require an explicit import.
CSS exemptions cover web source, not tests.
Proof lint selection includes TS/TSX/MTS/CTS, JS/JSX/MJS/CJS and JSON/JSONC files.

`docs/PROVISIONING.md` is an explicit Markdown exception: the existing
`packages/daemon/tests/integration/key-provisioning.test.ts` reads its actual
shell/cloud-init blocks, compares them and executes the shell script. Changes,
deletion or rename therefore select the full Bun suite. Ordinary Markdown keeps
its exemption; comments referring to a document do not establish a consumer.

When Test is selected it still runs the entire existing suite once, with its
global 60% line threshold. R7 still uses the same actual wire controls and one
uninterrupted 61-minute attachment. Scope summaries identify selections; they
are not receipts that a skipped runtime gate passed.

Concurrency is per workflow and PR number. A newer PR head cancels only its
superseded run. Main push and manual runs have unique groups, preserving release
and explicit measurement work. Existing workflow triggers already avoid
feature-branch push/PR duplication. Release, tag and publication job bodies are
unchanged. The macOS check uses the same scope decision to skip routing-only
changes while retaining its actual build/test steps for affected inputs.

## Owner correction: validate routing changes with their own checks

CI classifier/action/workflow configuration changes run the actual git-diff
corpus and workflow validator, rather than unrelated Bun runtime tests or R7.
Parsed YAML execution comparisons include job commands/actions, runner, timeout,
environment and global inputs. Only validated routing fields in CI/R7/macOS and
their exact scoped gate jobs, the self-validation scope job and exact inert
scoped-report steps are excluded. Publication/admin jobs retain their `if`/`needs`
and step conditions as execution inputs; release/admin workflows also retain
their triggers and concurrency. Auto-release/release-guard/sync prerequisites
are explicitly validated. Unknown jobs/fields, malformed YAML or missing comparison data
select full gates. Normal CI execution changes select the affected gate; R7
execution changes select R7. Main push/manual R7 remain full.

Both workflows and the macOS scope execute pinned PyYAML 6.0.3, checksum-verified
actionlint 1.7.12, YAML contract checks and the real diff corpus in actual CI.
Validation checks stable names, gate conditions and selected command preservation.
The complete coverage/threshold/wire/soak bodies match SHA-256 contracts captured
from the original d2e90a89 workflow source, so comment-only marker no-ops are refused.
The full composite action order/commands/IDs/environment/output maps/pins also
match a reviewed canonical contract. The independent corpus validates this action
wiring before its scenarios, so deleting the standalone validator step fails too. Validator/tool changes execute these tools as
well as the classifier controls. No runtime result is inferred from a scope skip.

The owner cancelled R7 run 38040382125 at f2703da1. Test run 38040382107 also has an
incomplete/cancelled result; its cause is not attributed to the owner. Neither
is recorded as passed. The previous landing guard was stopped before this scope
policy revision.

Run `uv run --with pyyaml==6.0.3 python .github/scripts/check-ci-scope.py` for real temporary-git controls,
or `python3 .github/scripts/ci-scope.py --base <sha> --head <sha>` for a complete
existing PR diff. The controls run before classification in both workflows.

## Actual setup failure and corrected failure routing

At 259f66af, the actual Ubuntu corpus lacked ACTIONLINT in its environment, even
though the pinned binary had installed successfully. Scope failures accidentally
activated the previous runtime fallback. The owned runs were cancelled and remain
failed/cancelled evidence. The control step now receives the explicit installed
binary path, verified with PATH excluding globally installed actionlint.

Every stable gate begins with the actual `Fail unvalidated scope` shell step;
a scope failure exits 1 before any runtime command. Runtime steps require scope
success. An action step validates every mandatory output as explicit true/false.
The corpus executes the actual failure shell and output-validator subprocesses,
while dedicated YAML checks enforce every runtime condition. Valid unknown input
classification still selects full relevant runtime checks.
