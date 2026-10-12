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
| Exact Swift-owned `secure-push-fixture.ts` helper | Spelling + Biome | Skip unless a nonnative reference exists |
| `docs/PROVISIONING.md` executable bootstrap fixture | Spelling + full coverage | Skip |
| Owned tunnel proof scripts | Spelling; TS/JS/JSON also Biome | Skip |
| Web TS source/tests | Web source/tests and relay integration type checks, full coverage | Run |
| Daemon/shared/Worker inputs | All existing gates | Run |
| Exact wrapper suspend test/PTY fixture producers | All normal gates | Skip without external references |
| Exact CI coverage threshold shell reader test | All normal gates | Skip without external references |
| Exact existing HookServer unit test modification | All normal gates | Skip with reviewed reference provenance |
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

Only `packages/native/RemiKit/Tests/Integration/secure-push-fixture.ts` has a native
TypeScript exemption: `NativeSecureSourceIntegrationTests.swift` launches it for
the Swift suite. It still selects Biome. A fixed-string basename scan at both base
and head covers daemon/shared/signaling/web/macos packages, root tests/scripts
and GitHub workflow/action directories (excluding the classifier and these docs);
any reference or scan failure selects full gates. Unknown native TS neighbors
remain full-gate inputs. Native acceptance stays separate.

The exact `packages/daemon/tests/cli/wrapper-suspend.test.ts` and
`packages/daemon/tests/cli/fixtures/wrapper-suspend-pty.py` producers retain every
normal package/type/lint/test/notice/Mac gate while skipping only relay. A fixed
`wrapper-suspend` scan at both base and head covers all packages (including native),
root tests/scripts and GitHub workflows/actions/scripts, excluding these two producer
paths and the exact classifier/corpus self-tools. Their expected test-to-fixture reference does not select relay; any other
reference or scan error restores all gates. Source, package, unknown neighbor or
renamed producer changes remain conservative. This is not a generic test exemption.
Literal scans may match comments/data and cannot discover computed references.

`packages/daemon/tests/ci-coverage-threshold.test.ts` has its own exact exemption:
this consumer exercises the existing CI shell body and still selects every normal
test/type/lint/notice/Mac gate. Only relay skips. Both-endpoint basename scans cover
all packages, root tests/scripts and GitHub workflows/actions/scripts, excluding
only the test itself and the exact classifier/corpus self-tools. Any other
reference or scan error restores all gates. Source changes and unknown neighbors
or renamed tests remain conservative; this is separate from the wrapper producers.

Only modifications of `packages/daemon/tests/hooks/hook-server.test.ts` may skip
relay; this test is outside the R7 workflow's actual test list. Every normal
test/type/lint/notice/Mac gate remains selected. The producer must exist as a blob
at both endpoints, and its actual merge-base-to-head name-status comparison must
contain exactly one `M` entry for that path. Independent additions on divergent
branches, type changes, unavailable/malformed status data, deletions, renames, unknown neighbors and mixed
runtime inputs retain full gates; this rule never clears relay selected earlier.
Both-endpoint `hook-server.test` scans cover all packages (including native), root
tests/scripts and GitHub workflows/actions/scripts, excluding only the producer
and the exact classifier/corpus self-tools. Whole files are scanned.
Both complete Git trees in these directories must contain only regular file
blobs: tracked symlinks and submodules restore all gates because `git grep` can
omit their literal targets. This tree-mode check has no path exclusions, and
unavailable or malformed tree metadata also restores all gates.

Two existing commentary references have reviewed immutable provenance:

| Path under `packages/daemon/tests/hooks/` | Git blob | Exact occurrence |
| --- | --- | --- |
| `fixtures/build-hook-corpus.ts` | `7568a1b1da3e696a169b2197d0aaf3c46d8bd75f` | Line 96, commentary on test contamination |
| `hook-diag-provenance-worker.ts` | `2f070d8de7da9247e8dc153f211dad76732b5d33` | Line 10, comparison with its own HTTP POST |

The corpus builder reads diagnostic JSONL, writes the redacted corpus and exports
filters used by its own test. The provenance worker imports the source HookServer
and is spawned by `hook-diag-provenance.test.ts`; neither consumes the exempt
test. Each endpoint must retain both exact Git blobs and exactly the single
matching complete comment line in each. Any changed/missing blob, extra, moved or
modified occurrence, other reference or scan failure restores all gates. This
allows reviewed comments without a whole-file exclusion or generic comment
stripping. Literal scans cannot establish the absence of computed references.

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

## Dormant image staging codec (#1170)

Only the exact `STAGING_INPUTS` paths in `ci-scope.py` qualify: the shared
`image-staging.ts` module, its test, the generator/vectors/PNG/JPEG/README fixtures,
and the three named standalone staging codec proof adapters. They select every
ordinary lint/type/test/notice/Mac gate. Only R7 skips while the codec is dormant.
This is not a shared-package or proof-directory exemption.

The classifier checks actual merge-base-to-head A/M status and regular blob modes.
An addition must be absent at both merge-base and target base; a modification
must already exist at both. Missing source, deletions, renames, type changes or
unexpected exports restore all gates. The source's 19 reviewed public identifiers
must match `STAGING_EXPORTS`; adding an API requires reviewing this policy too.

Both target-base and head trees are scanned across packages, root tests/scripts
and all GitHub CI source/config surfaces, plus the exact executable fixture
`docs/PROVISIONING.md`. Only the exact producers and the exact
classifier/corpus self-tools may reference the module basename, public identifiers,
`image_staging` or `image_upload_` wire family. Whole text blobs are decoded as
strict UTF8; malformed text, NULs, unavailable objects or malformed tree metadata
restore all gates. Markdown prose and known binary assets are excluded from text
scans; the provisioning fixture remains scanned. Tracked symlinks/submodules and
secret file names fail closed before reads.
An old consumer removed by this PR still selects R7, as does a new consumer,
registry/export/helper/config change or any mixed runtime input. No prior gate
selection is cleared. Literal scans cannot discover deliberately computed names;
source ownership and future runtime integration still require review.

## Exact reservation accounting relocation (#1170)

A separate one-time rule owns three new daemon internals under `src/tunnel`
(`reservations.ts`, `journal-schema.ts`, `recovery-error.ts`), the two existing
proof adapters, the exact error import/re-export in proof `recovery.ts`, and the
five target-path changes in `settlement-mutations.py`. The exact optional new
`packages/daemon/tests/tunnel/reservations-adoption.test.ts` retains ordinary
coverage and verifies real filesystem accounting plus constructor/adapter identity.
Every ordinary gate is selected; only dormant relocation R7 work skips.

`ACCOUNTING_ORIGINALS` pins all 13 actual pre-relocation proof consumer blobs at
both target base and merge-base. `ACCOUNTING_HEAD` pins the seven mechanically
transformed files and optional test. Required files must make their exact A/M
transition as regular blobs; adapters have explicit exports and the error has
one constructor. These pins include implementation bodies, imports, exports,
comments and mutation strings. Unknown bodies, missing files, D/R/T transitions,
symlinks/submodules and future edits restore all gates.

Both endpoint trees receive the same strict text/mode/read checks and source
surfaces as the staging scan. Exact old/new module specifiers and all 13 public
identifiers are scanned outside the immutable known proof consumers and reviewed
producers/test. Identifier boundaries avoid unrelated `clientReservations` matches.
Unrecognized consumers, changed known consumers, unavailable objects, malformed
UTF8/NULs, errors and mixed runtime inputs restore relay. No previous selection
is cleared. This rule does not exempt a directory or permit future arbitrary
dormant edits; literal scans cannot prove the absence of computed references.
The existing staging export vocabulary and both-endpoint predicate are unchanged.

Module references require a slash-bearing path prefix or a quoted bare name in
explicit import/from/require syntax. Ordinary lowercase `reservations` comments,
JSON keys and counter properties are not module references. The corpus retains
the three actual native/Worker collision blobs and tests the complete published
repository tree with only the eight reviewed relocation entries replaced. This
full-tree control uses published ancestor objects and works before adoption;
it does not require unpublished source commits or new files in the caller tree.

## Short R7 fixture controls and the unchanged long soak

`relay` still selects setup, the entire existing short wire/authority suite and
artifacts. The separate mandatory `relay_soak` output defaults to `relay`; it is
not part of `GATES`, so existing staging/accounting selections stay unchanged.
Only the 61-minute step uses `relay_soak`. Its command/body hash, environment,
assertion, runner and timeout remain unchanged. An explicit report records a
scoped-out soak; it is not a receipt that the measurement passed. Manual/main
and unknown-input fallbacks retain full behavior.

Either or both exact M-only changes to `tests/integration/relay-r3-drain.test.ts`
and `packages/signaling/tests/e2e/push.e2e.test.ts` may omit only the soak. Both
original/final full blobs and regular0644 modes must match the reviewed pins.
Companions may be ordinary nonexecuting Markdown/CHANGELOG only; PROVISIONING
and R7 acceptance documentation are excluded. Every ordinary gate and the short
relay flag remain selected. Other runtime/helper/config/unknown inputs retain
both phases.

Both complete endpoint trees retain identical non-doc objects/modes outside
the changed fixtures. Reviewed direct soak entry/import/launch nodes are pinned
at both ends, and strict whole-text caller scans cover both fixture basenames.
Unavailable objects, malformed UTF8/NULs, unexpected modes/paths/provenance or
new/removed/existing callers restore the soak. Literal scans cannot discover
computed references; reviewed trace pins and conservative inputs constrain this
exception. CLI trace normalization masks only its two compiled-version return
values, both equal to the package version; package normalization masks only its
single version value. Every other byte/field stays fixed. This permits a normal
consistent upstream counter bump at both endpoints, not version companion edits
in the fixture PR.

Action outputs/env and YAML contracts require explicit true/false for both flags;
missing, blank, malformed or soak=true/relay=false values fail scope before runtime
work. Actual full-tree controls use published ancestor objects and copied approved
fixture bytes, without depending on unpublished fixture commits or files.

## Exact descriptor and journal relocations (#1170)

`COLD_RELOCATIONS` separately pins the descriptor transition A and journal
transition B. A owns the two dormant daemon descriptor/type modules, two exact
proof adapters and identity test. B owns the two dormant daemon journal modules,
two exact proof adapters, two mutation target updates and identity test. The
ordered combined A-to-B diff is also checked against the same pins. This is a
one-time transition rule, not an exemption for later edits or a directory.

Every required producer must make its exact A/M transition as a regular file
with the reviewed whole blob and mode. Both target base and merge-base retain
the pinned original producers and known consumers; the head retains their exact
reviewed successors and unchanged dependency blobs. A B-only transition requires
A's reviewed descriptor producers and test already at both bases. The combined
transition checks the pre-A originals and final A/B successors. Missing or changed
bodies, exports, imports, consumers, mutation targets, modes, additions at an
unexpected base, deletions, renames and type changes restore all gates.

Strict mode checks cover complete tracked repository trees. Whole-text scans
read every regular text input at target base and head, with the existing
Markdown/known-binary exclusions; executable provisioning remains scanned. Boundary-delimited public API names,
exact qualified paths, and literal relative or known `@remi/daemon/*` imports are
checked. Unambiguous JS Unicode/hex escapes are decoded before resolution; unresolved
relative/daemon-alias escapes remain conservative. Relative references resolve
against their containing file: the actual
Worker `./admission.ts` resolves to Worker admission, not the dormant tunnel
module. Unknown bare module references and daemon aliases with dot segments matching
a candidate name remain conservative. Import comment trivia is recognized. Generic lowercase properties and longer identifiers do not claim
these APIs. Unknown consumers, unavailable objects, malformed UTF8/NULs, secret
file names and symlinks/submodules restore all gates before exclusion.

A complete qualified B transition alone passes the existing accounting overlap
preflight; the old accounting qualification and its producer pins remain
unchanged for every other input. Pure exact relocations and ordinary Markdown
companions select every ordinary gate while `relay` and therefore `relay_soak`
remain false. Any additional runtime/helper/registry/index/config input, including
executable provisioning or R7 documentation, restores relay. No previously
selected relay work is cleared and no workflow or measurement body is changed.

The real full-tree corpus reconstructs reviewed candidates from published
original objects plus copied exact transforms/adapters/tests and asserts their
whole Git blob IDs. Its A, B and ordered A-to-B controls work before either
adoption commit lands. Literal scans do not prove the absence of computed
references; future runtime callers and packaging still require their own review.

The published root `.env.example` is a public sample, qualified only by its
exact reviewed regular mode/blob. It is read-validated and reference-scanned;
changed samples and other `.env*` names are refused before content reads. Known
producer/consumer blobs are also validated for availability, type, length, UTF8
and NULs before their references are excluded. The existing proof digest mutation
reader is pinned as an immutable consumer; its body and target remain unchanged.

The same exact fixture rule now also qualifies the reviewed M-only
`packages/daemon/tests/connection-auth.test.ts` transition. It waits for the
existing real authentication success/failure callbacks in its two-client test;
its keys, assertions, authentication policy and original deadline stay fixed.
Any one, pair or all three reviewed fixture transitions select ordinary gates
and the full short relay suite while omitting only the unchanged long soak.
The Connection, Authenticator and IdentityStore production blobs are additionally
pinned at both endpoints. Three existing comment-only auth-fixture references
have exact regular whole-blob and single complete-line provenance; changed,
missing or unreadable commentary or extra references restore the soak. Old
fixture reference matches remain conservative, with no general comment stripping.

When the auth fixture is changed, its token is also scanned through tracked
regular root execution/config text at both endpoints, including the exact
public `.env.example` sample. Other secret names, unreadable root inputs and root
callers restore the soak. The original two-fixture-only scan surfaces and token
matching remain unchanged.

The two exact adoption tests also carry the reviewed leading triple-slash
reference to `scripts/tunnel-storage-proof/assets.d.ts`. The single declaration
line supplies the existing native-helper asset types to root TypeScript analysis;
every runtime test byte stays identical. Only the corrected whole test blobs
qualify, including the corrected descriptor-test base pin for B. The referenced
published declaration asset is pinned unchanged as a regular read-validated known
input at both endpoints. Removed/altered references or changed/missing declaration
assets restore full runtime gates; this is not a generic type-change exemption.


## Exact native journal helper relocation (#1170)

One named helper transition retains all ordinary gates and skips relay only for
the complete seven-path move. The factory body and fixed C source remain exact;
the proof factory becomes a single explicit re-export, its declaration moves to
the daemon with an exact reference, and the new real filesystem test shares the
same factory. Existing proof probes and descriptor/journal adoption tests have
immutable whole-blob and regular-mode provenance at both endpoints.

Only the old proof `recovery-native.c` has a null head pin: its original regular
blob must exist at both bases, the head must omit it, and Git must report its
exact D transition. Every other pin keeps its existing strict A/M semantics.
Helper compositions are refused; the reviewed descriptor-plus-journal transition
remains unchanged. No directory, deletion or native-helper exemption is added.

Helper-only reference checks include the exact old and new C assets. Relative
and known daemon-alias literal imports resolve with the `.c` extension intact;
qualified launch/config strings and Unicode/hex escapes are checked too. Unknown
relative escapes, bare candidate identity escapes and qualified C string escapes
stay conservative. A same-basename
C asset elsewhere does not name this helper. Existing A/B TypeScript resolution
and whole-tree mode/read/type/length/UTF8/NUL/secret-name checks stay intact.
Daemon production source also checks exact references to the two verified factory-
calling proof probes, their two actual dispatch wrappers and the three direct
helper-calling tests. It reuses the existing literal relative/alias/suffix/escape
resolver without an import graph or generic directory rule. The existing proof
entry/probe uses remain allowed as pinned standalone inputs; both dispatch wrapper
blobs are additionally pinned unchanged and read-validated.
Literal checks cannot establish absence of computed references.

The real Git corpus reconstructs the move from published originals plus the exact
prefix, declaration split, adapter and reviewed test literal. Candidate commit
objects are unnecessary. Complete moves and ordinary prose companions qualify;
incomplete or reversed moves, changed pins, modes, status, restored old C source,
missing/malformed objects and consumers at either endpoint restore full gates.
This qualification does not activate transfer handling, client support or a
capability advertisement.
