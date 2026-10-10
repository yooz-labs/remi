# PR CI scope (#1359)

CI and Relay R7 always start on PRs to develop/main. A shared Python classifier
reads the complete merge-base-to-head git diff, with deleted paths and both sides
of renames. The existing check names remain present: unrelated steps report a
successful scoped skip. Missing history/event data, unknown paths, classifier
failure or missing output selects full gates. Main pushes and manual R7 runs
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
| Dependencies, toolchain/global config, gate workflows/classifier, unknown input | All existing gates | Run |

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
unchanged.

Run `python3 .github/scripts/check-ci-scope.py` for real temporary-git controls,
or `python3 .github/scripts/ci-scope.py --base <sha> --head <sha>` for a complete
existing PR diff. The controls run before classification in both workflows.
