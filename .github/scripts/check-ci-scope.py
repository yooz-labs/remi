"""Exercise the shipping classifier with actual owned git histories, not mocked diffs."""

import json
import os
import runpy
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml

SCRIPT = Path(__file__).with_name("ci-scope.py").resolve()
module = runpy.run_path(str(SCRIPT))
classify, gates = module["classify"], set(module["GATES"])
ROOT_PACKAGE = {"version": "0.7.17-dev.1", "scripts": {"test": "bun test",
                "build:darwin-arm64": "bun build --target=bun-darwin-arm64",
                "build:darwin-x64": "bun build --target=bun-darwin-x64"},
                "devDependencies": {"typescript": "5.7.0"}}
WEB = {"web", "integration", "test", "relay"}
METADATA = {"lint", "root", "notices", "test"}
NATIVE_FIXTURE = "packages/native/RemiKit/Tests/Integration/secure-push-fixture.ts"
WRAPPER_INPUTS = module["WRAPPER_SUSPEND_INPUTS"]
WRAPPER_GATES = gates - {"relay"}
COVERAGE_READER = module["CI_COVERAGE_READER"]
HOOK_SERVER_TEST = module["HOOK_SERVER_TEST"]
HOOK_COMMENT_SOURCE = {path: Path(path).read_text() for path in module["HOOK_TEST_COMMENTS"]}
WORKFLOWS = {path.name: path.read_text() for path in Path(".github/workflows").glob("*.yml")}
ACTION = Path(".github/actions/ci-scope/action.yml").read_text()
WORKFLOW_TOOLS = runpy.run_path(str(SCRIPT.with_name("workflow-scope.py")))
WORKFLOW_TOOLS["validate_action"](yaml.load(ACTION, Loader=WORKFLOW_TOOLS["UniqueLoader"]))


def git(*args):
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null",
                                   "-c", "commit.gpgsign=false", *args],
                                  stderr=subprocess.PIPE).decode().strip()


def write(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value)


def commit():
    git("add", "-A")
    git("commit", "-qm", "scope control")
    return git("rev-parse", "HEAD")


def selected(result):
    assert all(isinstance(result[key], bool) for key in gates), result
    assert result["typecheck"] == any(result[key] for key in
                                      ("root", "web", "signaling", "integration", "notices"))
    return {key for key in gates if result[key]}


original = Path.cwd()
# An inherited GIT_DIR/GIT_WORK_TREE must never redirect owned controls to a real repo.
inherited_git = {key: value for key, value in os.environ.items() if key.startswith("GIT_")}
for key in inherited_git:
    del os.environ[key]
with tempfile.TemporaryDirectory(prefix="remi-ci-scope-") as owned:
    try:
        os.chdir(owned)
        git("init", "-q")
        git("config", "user.name", "CI scope control")
        git("config", "user.email", "test@example.com")
        write("package.json", json.dumps(ROOT_PACKAGE))
        write("packages/daemon/src/relay/hub.ts", "export const initial = true;\n")
        write("docs/PROVISIONING.md", "# initial executable bootstrap fixture\n")
        write(NATIVE_FIXTURE, "export const owned = true;\n")
        write(WRAPPER_INPUTS[0], "const fixture = 'fixtures/wrapper-suspend-pty.py';\n")
        write(WRAPPER_INPUTS[1], "print('owned fixture')\n")
        write(COVERAGE_READER, "export {};\n")
        write(HOOK_SERVER_TEST, "export {};\n")
        for path, text in HOOK_COMMENT_SOURCE.items():
            write(path, text)
        for name, text in WORKFLOWS.items():
            write(f".github/workflows/{name}", text)
        write(".github/actions/ci-scope/action.yml", ACTION)
        base = commit()
        cases = [
            ("README.md", "docs\n", set()),
            ("docs/diagram.png", "owned asset", set()),
            ("docs/ordinary.md", "ordinary prose", set()),
            ("docs/admission.test.ts", "export {};", gates),
            ("docs/admission_spec.ts", "export {};", gates),
            ("npm/remi/smoke.spec.ts", "export {};", gates),
            ("docs/PROVISIONING.md", "changed executable bootstrap fixture", {"test"}),
            ("packages/native/Mac/Main.swift", "import SwiftUI\n", set()),
            ("packages/native/Mac/Assets.xcassets/Contents.json", "{}", {"lint"}),
            ("packages/native/RemiKit/Tests/Integration/relay-fixture.ts", "export {};", gates),
            (NATIVE_FIXTURE, "export const changed = true;", {"lint"}),
            ("packages/native/RemiKit/Tests/Integration/secure-push-neighbor.ts", "export {};", gates),
            (WRAPPER_INPUTS[0], "const fixture = 'fixtures/wrapper-suspend-pty.py'; export {};", WRAPPER_GATES),
            (WRAPPER_INPUTS[1], "print('changed fixture')", WRAPPER_GATES),
            ("packages/daemon/tests/cli/wrapper-suspend-neighbor.test.ts", "export {};", gates),
            (COVERAGE_READER, "export const changed = true;", WRAPPER_GATES),
            ("packages/daemon/tests/ci-coverage-threshold-neighbor.test.ts", "export {};", gates),
            (HOOK_SERVER_TEST, "export const changed = true;", WRAPPER_GATES),
            ("packages/daemon/tests/hooks/hook-server-neighbor.test.ts", "export {};", gates),
            ("scripts/tunnel-storage-proof/probe.ts", "export {};", {"lint"}),
            ("scripts/tunnel-storage-proof/probe.tsx", "export {};", {"lint"}),
            ("scripts/tunnel-storage-proof/probe.mts", "export {};", {"lint"}),
            ("scripts/tunnel-storage-proof/probe.cts", "export {};", {"lint"}),
            ("scripts/tunnel-storage-proof/probe.jsx", "export {};", {"lint"}),
            ("scripts/tunnel-storage-proof/probe.mjs", "export {};", {"lint"}),
            ("scripts/tunnel-storage-proof/probe.cjs", "export {};", {"lint"}),
            ("scripts/tunnel-storage-proof/fixture.jsonc", "{}", {"lint"}),
            ("scripts/tunnel-storage-proof/matrix.py", "print('owned proof')", set()),
            ("scripts/tunnel-storage-proof/admission.test.ts", "export {};", gates),
            ("scripts/tunnel-storage-proof/admission_spec.ts", "export {};", gates),
            ("scripts/tunnel-decoder-proof/probe.ts", "export {};", {"lint"}),
            ("packages/web/src/index.css", "body {}", set()),
            ("packages/web/tests/fixtures/sample.css", "body {}", WEB),
            ("packages/web/src/assets/icon.svg", "<svg/>", set()),
            ("packages/web/src/assets/transport.ts", "export {};", WEB),
            ("packages/web/src/components/session/SessionCard.tsx", "export {};", WEB),
            ("packages/web/tests/lib/auth.test.ts", "export {};", WEB),
            ("packages/web/package.json", "{}", gates),
            ("packages/daemon/src/relay/hub.ts", "export const changed = true;", gates),
            ("packages/daemon/src/cli.ts", "// REMI_COMPILED_VERSION\n", gates),
            ("packages/shared/src/protocol.ts", "export {};", gates),
            ("packages/shared/LICENSE", "license input", gates),
            ("npm/remi/NOTICE", "notice input", METADATA),
            ("scripts/bump-version.sh", "#!/bin/sh\n", METADATA),
            ("scripts/third-party-notices.ts", "export {};", gates),
            ("packages/signaling/wrangler.toml", "name = 'owned'", gates),
            ("tests/integration/relay-r3.test.ts", "export {};", gates),
            (".github/workflows/ci.yml", "name: owned", gates),
            (".github/workflows/relay-r7.yml", "name: owned", gates),
            (".github/workflows/release.yml", "name: owned", gates),
            (".github/workflows/new.yml", "name: owned", gates),
            (".github/workflows/macos-app.yml", "name: owned", gates),
            (".github/actions/ci-scope/action.yml", "name: owned", set()),
            (".github/scripts/ci-scope.py", "print('owned')", set()),
            (".github/scripts/workflow-scope.py", "print('owned')", set()),
            (".rules/testing.md", "owned rule", gates),
            ("bun.lock", "owned lock", gates),
            ("docs/relay-r7-gates.md", "owned gate doc", {"relay"}),
            ("new-package/source.ts", "export {};", gates),
        ]
        count = 0
        for path, content, expected in cases:
            git("reset", "--hard", base)
            git("clean", "-fdq")  # Only this newly created, owned temporary repository.
            write(path, content)
            result = classify(base, commit())
            assert selected(result) == expected, (path, expected, result)
            count += 1
        # Exact HookServer test modifications permit only the reviewed immutable comments.
        for directory in ("packages/daemon", "packages/shared", "packages/signaling", "packages/web",
                          "packages/macos", "packages/native", "tests", "scripts",
                          ".github/workflows", ".github/actions", ".github/scripts"):
            consumer = f"{directory}/consumer.ts"
            content = "import 'hook-server.test';\n"
            if directory == ".github/workflows":
                consumer = f"{directory}/consumer.yml"
                content = "name: Owned consumer\non: [push]\njobs:\n  hook:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test " + HOOK_SERVER_TEST + "\n"
            elif directory == ".github/actions":
                consumer = f"{directory}/consumer/action.yml"
                content = "name: Owned consumer\ndescription: Owned consumer\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun test " + HOOK_SERVER_TEST + "\n"
            for context in ("both", "target-base-only", "new-head"):
                git("reset", "--hard", base)
                git("clean", "-fdq")
                write(consumer, content)
                consumer_base = commit()
                if context != "both":
                    git("reset", "--hard", base)
                if context == "new-head":
                    write(consumer, content)
                write(HOOK_SERVER_TEST, "export const changed = true;")
                left = base if context == "new-head" else consumer_base
                right = commit()
                assert not module["hook_test_references_reviewed"](left, right)
                assert selected(classify(left, right)) == gates, (consumer, context)
                count += 1
        git("reset", "--hard", base)
        git("clean", "-fdq")
        write("scripts/consumer.ts", "// hook-server.test is an unknown comment\n")
        consumer_base = commit()
        Path("scripts/consumer.ts").unlink()
        write(HOOK_SERVER_TEST, "export const changed = true;")
        assert selected(classify(consumer_base, commit())) == gates
        count += 1
        for path, text in HOOK_COMMENT_SOURCE.items():
            for context in ("target-base-only", "new-head"):
                git("reset", "--hard", base)
                git("clean", "-fdq")
                write(path, text + "\nimport 'hook-server.test';\n")
                consumer_base = commit()
                if context == "target-base-only":
                    git("reset", "--hard", base)
                write(HOOK_SERVER_TEST, "export const changed = true;")
                left = consumer_base if context == "target-base-only" else base
                right = commit()
                assert not module["hook_test_references_reviewed"](left, right)
                assert selected(classify(left, right)) == gates
                count += 1
            _, _, comment = module["HOOK_TEST_COMMENTS"][path]
            for changed in (text + comment + "\n", text.replace(comment, comment + " changed"),
                            "\n" + text, text + "\n// unrelated blob change\n", None):
                git("reset", "--hard", base)
                git("clean", "-fdq")
                if changed is None:
                    Path(path).unlink()
                else:
                    write(path, changed)
                changed_base = commit()
                write(HOOK_SERVER_TEST, "export const changed = true;")
                right = commit()
                result = classify(changed_base, right)
                assert selected(result) == gates and result["reason"].startswith("Hook test reference")
                count += 1
        git("reset", "--hard", base)
        git("clean", "-fdq")
        for tool in (".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py"):
            write(tool, "# hook-server.test reference is the exact self-tool\n")
        self_base = commit()
        write(HOOK_SERVER_TEST, "export const changed = true;")
        assert selected(classify(self_base, commit())) == WRAPPER_GATES
        count += 1
        for destination in (None, "docs/moved-hook-test.md", HOOK_SERVER_TEST + ".renamed"):
            git("reset", "--hard", base)
            git("clean", "-fdq")
            if destination:
                Path(HOOK_SERVER_TEST).rename(destination)
            else:
                Path(HOOK_SERVER_TEST).unlink()
            assert selected(classify(base, commit())) == gates
            count += 1
        for rename in (False, True):
            git("reset", "--hard", base)
            git("clean", "-fdq")
            Path(HOOK_SERVER_TEST).rename(HOOK_SERVER_TEST + ".neighbor")
            absent_base = commit()
            if rename:
                Path(HOOK_SERVER_TEST + ".neighbor").rename(HOOK_SERVER_TEST)
            else:
                write(HOOK_SERVER_TEST, "export const added = true;")
            assert selected(classify(absent_base, commit())) == gates
            count += 1
        for source in ("packages/daemon/src/relay/hub.ts", "packages/daemon/src/hooks/hook-server.ts"):
            git("reset", "--hard", base)
            git("clean", "-fdq")
            write(source, "export const changed = true;")
            write(HOOK_SERVER_TEST, "export const changed = true;")
            assert selected(classify(base, commit())) == gates
            count += 1
        # Git grep silently omits symlink targets; inspect actual tracked tree modes too.
        for kind in ("symlink-file", "symlink-directory", "gitlink"):
            for context in ("target-base-only", "new-head"):
                git("reset", "--hard", base)
                git("clean", "-fdq")
                consumer = "packages/web/src/hook-alias"
                Path(consumer).parent.mkdir(parents=True, exist_ok=True)
                if kind == "gitlink":
                    git("update-index", "--add", "--cacheinfo", f"160000,{base},{consumer}")
                    git("commit", "-qm", "owned gitlink reference")
                    consumer_base = git("rev-parse", "HEAD")
                else:
                    target = "../../daemon/tests/hooks/"
                    if kind == "symlink-file":
                        target += "hook-server.test.ts"
                    Path(consumer).symlink_to(target, target_is_directory=kind == "symlink-directory")
                    consumer_base = commit()
                if context == "target-base-only":
                    git("reset", "--hard", base)
                write(HOOK_SERVER_TEST, "export const changed = true;")
                if kind == "gitlink" and context == "new-head":
                    git("add", HOOK_SERVER_TEST)
                    git("commit", "-qm", "owned producer change")
                    right = git("rev-parse", "HEAD")
                else:
                    right = commit()
                left = consumer_base if context == "target-base-only" else base
                assert not module["hook_test_references_reviewed"](left, right)
                assert selected(classify(left, right)) == gates
                count += 1
        # Malformed objects are real Git tree/commit objects, never fabricated ls-tree output.
        git("reset", "--hard", base)
        git("clean", "-fdq")
        package_tree = git("rev-parse", f"{base}:packages")
        root_bytes = subprocess.check_output(["git", "cat-file", "tree", f"{base}^{{tree}}"])
        package_bytes = subprocess.check_output(["git", "cat-file", "tree", package_tree])
        blob = bytes.fromhex(git("rev-parse", f"{base}:{HOOK_SERVER_TEST}"))
        def literal_tree(raw):
            return subprocess.check_output(["git", "hash-object", "--literally", "-w", "-t", "tree", "--stdin"],
                                           input=raw, stderr=subprocess.PIPE).decode().strip()
        for malformed in (b"100644 no-framing", b"bad-mode alias\0" + blob,
                          b"100644 \0" + blob, b"100644 alias\0" + blob[:5]):
            changed_tree = literal_tree(package_bytes + malformed)
            root_tree = literal_tree(root_bytes.replace(bytes.fromhex(package_tree), bytes.fromhex(changed_tree)))
            bad_head = git("commit-tree", root_tree, "-p", base, "-m", "owned malformed tree")
            assert not module["hook_test_references_reviewed"](base, bad_head)
            assert selected(classify(base, bad_head)) == gates
            count += 1
        git("reset", "--hard", base)
        git("clean", "-fdq")
        write(HOOK_SERVER_TEST, "export const changed = true;")
        scan_head = commit()
        git("config", "grep.threads", "not-a-number")
        try:
            result = classify(base, scan_head)
            assert selected(result) == gates and result["reason"].startswith("Hook test reference")
            count += 1
        finally:
            git("config", "--unset", "grep.threads")
        # This independent CI-shell reader retains normal gates, with its own consumer guard.
        for directory in ("packages/daemon", "packages/shared", "packages/signaling", "packages/web",
                          "packages/macos", "packages/native", "tests", "scripts",
                          ".github/workflows", ".github/actions", ".github/scripts"):
            git("reset", "--hard", base); git("clean", "-fdq")
            if directory == ".github/workflows":
                write(f"{directory}/consumer.yml", "name: Owned consumer\non: [push]\njobs:\n  coverage:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun test " + COVERAGE_READER + "\n")
            elif directory == ".github/actions":
                write(f"{directory}/consumer/action.yml", "name: Owned consumer\ndescription: Owned consumer\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun test " + COVERAGE_READER + "\n")
            else:
                write(f"{directory}/consumer.ts", "import 'ci-coverage-threshold';")
            consumer_base = commit()
            write(COVERAGE_READER, "export const changed = true;")
            result = classify(consumer_base, commit())
            assert selected(result) == gates and result["reason"].startswith("Coverage reader reference")
            count += 1
        for context in ("new-head", "target-base-only", "removed-head"):
            git("reset", "--hard", base); git("clean", "-fdq")
            write("scripts/consumer.ts", "import 'ci-coverage-threshold';")
            consumer_base = commit()
            if context != "removed-head":
                git("reset", "--hard", base)
            if context == "new-head":
                write("scripts/consumer.ts", "import 'ci-coverage-threshold';")
            elif context == "removed-head":
                Path("scripts/consumer.ts").unlink()
            write(COVERAGE_READER, "export const changed = true;")
            result = classify(base if context == "new-head" else consumer_base, commit())
            assert selected(result) == gates and result["reason"].startswith("Coverage reader reference")
            count += 1
        git("reset", "--hard", base); git("clean", "-fdq")
        for tool in (".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py"):
            write(tool, "# ci-coverage-threshold reference is the exact self-tool\n")
        self_base = commit()
        write(COVERAGE_READER, "export const changed = true;")
        assert selected(classify(self_base, commit())) == WRAPPER_GATES
        count += 1
        for destination, expected in ((None, WRAPPER_GATES), (COVERAGE_READER + ".renamed", gates)):
            git("reset", "--hard", base); git("clean", "-fdq")
            if destination:
                Path(COVERAGE_READER).rename(destination)
            else:
                Path(COVERAGE_READER).unlink()
            assert selected(classify(base, commit())) == expected
            count += 1
        git("reset", "--hard", base); git("clean", "-fdq")
        write(COVERAGE_READER, "export const changed = true;")
        write("packages/daemon/src/relay/hub.ts", "export const changed = true;")
        assert selected(classify(base, commit())) == gates
        count += 1
        git("reset", "--hard", base); git("clean", "-fdq")
        write(COVERAGE_READER, "export const changed = true;")
        scan_head = commit()
        git("config", "grep.threads", "not-a-number")
        try:
            result = classify(base, scan_head)
            assert selected(result) == gates and result["reason"].startswith("Coverage reader reference")
            count += 1
        finally:
            git("config", "--unset", "grep.threads")
        # Exact wrapper producers keep every normal gate; their self-reference is excluded.
        git("reset", "--hard", base); git("clean", "-fdq")
        write(WRAPPER_INPUTS[0], "const fixture = 'fixtures/wrapper-suspend-pty.py'; export {};")
        write(WRAPPER_INPUTS[1], "print('changed fixture')")
        write("docs/suspend-resume-check.md", "Owned wrapper check")
        assert selected(classify(base, commit())) == WRAPPER_GATES
        count += 1
        for directory in ("packages/daemon", "packages/shared", "packages/signaling", "packages/web",
                          "packages/macos", "packages/native", "tests", "scripts",
                          ".github/workflows", ".github/actions", ".github/scripts"):
            git("reset", "--hard", base); git("clean", "-fdq")
            if directory == ".github/workflows":
                write(f"{directory}/consumer.yml", "name: Owned consumer\non: [push]\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun " + WRAPPER_INPUTS[0] + "\n")
            elif directory == ".github/actions":
                write(f"{directory}/consumer/action.yml", "name: Owned consumer\ndescription: Owned consumer\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun " + WRAPPER_INPUTS[0] + "\n")
            else:
                write(f"{directory}/consumer.ts", "import 'wrapper-suspend';")
            consumer_base = commit()
            write(WRAPPER_INPUTS[1], "print('changed fixture')")
            result = classify(consumer_base, commit())
            assert selected(result) == gates and result["reason"].startswith("Wrapper test reference")
            count += 1
        for consumer in ("scripts/consumer.ts", ".github/scripts/consumer.py"):
            for context in ("new-head", "target-base-only", "removed-head"):
                git("reset", "--hard", base); git("clean", "-fdq")
                write(consumer, "# wrapper-suspend")
                consumer_base = commit()
                if context != "removed-head":
                    git("reset", "--hard", base)
                if context == "new-head":
                    write(consumer, "# wrapper-suspend")
                elif context == "removed-head":
                    Path(consumer).unlink()
                write(WRAPPER_INPUTS[1], "print('changed fixture')")
                result = classify(base if context == "new-head" else consumer_base, commit())
                assert selected(result) == gates, (consumer, context, result)
                # A changed unknown helper may select all gates before the producer;
                # an unchanged target-base-only helper must be found by the scan.
                if context == "target-base-only":
                    assert result["reason"].startswith("Wrapper test reference"), result
                count += 1
        # The exact two routing self-tools are excluded; neighboring helpers are not.
        git("reset", "--hard", base); git("clean", "-fdq")
        for tool in ("ci-scope.py", "check-ci-scope.py"):
            write(".github/scripts/" + tool, "# wrapper-suspend")
        self_base = commit()
        write(WRAPPER_INPUTS[1], "print('changed fixture')")
        assert selected(classify(self_base, commit())) == WRAPPER_GATES
        count += 1
        for producer in WRAPPER_INPUTS:
            for destination, expected in ((None, WRAPPER_GATES), (producer + ".renamed", gates)):
                git("reset", "--hard", base); git("clean", "-fdq")
                if destination:
                    Path(producer).rename(destination)
                else:
                    Path(producer).unlink()
                assert selected(classify(base, commit())) == expected
                count += 1
        git("reset", "--hard", base); git("clean", "-fdq")
        write(WRAPPER_INPUTS[1], "print('changed fixture')")
        write("packages/daemon/src/relay/hub.ts", "export const changed = true;")
        assert selected(classify(base, commit())) == gates
        count += 1
        git("reset", "--hard", base); git("clean", "-fdq")
        write(WRAPPER_INPUTS[1], "print('changed fixture')")
        scan_head = commit()
        git("config", "grep.threads", "not-a-number")
        try:
            result = classify(base, scan_head)
            assert selected(result) == gates and result["reason"].startswith("Wrapper test reference")
            count += 1
        finally:
            git("config", "--unset", "grep.threads")
        # Real references in every nonnative scan domain remove the exact-path exemption.
        for directory in ("packages/daemon", "packages/shared", "packages/signaling",
                          "packages/web", "packages/macos", "tests", "scripts",
                          ".github/workflows", ".github/actions"):
            git("reset", "--hard", base); git("clean", "-fdq")
            if directory == ".github/workflows":
                write(f"{directory}/consumer.yml", "name: Owned consumer\non: [push]\njobs:\n  fixture:\n    runs-on: ubuntu-latest\n    steps:\n      - run: bun " + NATIVE_FIXTURE + "\n")
            elif directory == ".github/actions":
                write(f"{directory}/consumer/action.yml", "name: Owned consumer\ndescription: Owned fixture consumer\nruns:\n  using: composite\n  steps:\n    - shell: bash\n      run: bun " + NATIVE_FIXTURE + "\n")
            else:
                write(f"{directory}/consumer.ts", "import 'secure-push-fixture';")
            consumer_base = commit()
            write(NATIVE_FIXTURE, "export const changed = true;")
            result = classify(consumer_base, commit())
            assert selected(result) == gates and result["reason"].startswith("Native fixture reference")
            count += 1
        for context in ("new-head", "target-base-only", "removed-head"):
            git("reset", "--hard", base); git("clean", "-fdq")
            write("scripts/consumer.ts", "import 'secure-push-fixture';")
            consumer_base = commit()
            if context != "removed-head":
                git("reset", "--hard", base)
            if context == "new-head":
                write("scripts/consumer.ts", "import 'secure-push-fixture';")
            elif context == "removed-head":
                Path("scripts/consumer.ts").unlink()
            write(NATIVE_FIXTURE, "export const changed = true;")
            result = classify(base if context == "new-head" else consumer_base, commit())
            assert selected(result) == gates and result["reason"].startswith("Native fixture reference")
            count += 1
        for destination, expected in ((None, {"lint"}), ("docs/moved-fixture.md", {"lint"}),
                                      ("packages/native/RemiKit/Tests/Integration/renamed-fixture.ts", gates)):
            git("reset", "--hard", base); git("clean", "-fdq")
            if destination:
                Path(NATIVE_FIXTURE).rename(destination)
            else:
                Path(NATIVE_FIXTURE).unlink()
            assert selected(classify(base, commit())) == expected
            count += 1
        git("reset", "--hard", base); git("clean", "-fdq")
        write(NATIVE_FIXTURE, "export const changed = true;")
        scan_head = commit()
        git("config", "grep.threads", "not-a-number")
        try:
            result = classify(base, scan_head)
            assert selected(result) == gates and result["reason"].startswith("Native fixture reference")
            count += 1
        finally:
            git("config", "--unset", "grep.threads")
        for field, expected in [("version", METADATA), ("build-targets", METADATA),
                                ("dependencies", gates), ("test-script", gates),
                                ("malformed", gates)]:
            git("reset", "--hard", base)
            git("clean", "-fdq")
            package = json.loads(json.dumps(ROOT_PACKAGE))
            if field == "version":
                package["version"] = "0.7.17-dev.2"
            elif field == "build-targets":
                del package["scripts"]["build:darwin-x64"]
                package["scripts"]["build:all"] = "bun run build:darwin-arm64"
            elif field == "dependencies":
                package["devDependencies"]["typescript"] = "6.0.0"
            elif field == "test-script":
                package["scripts"]["test"] = "bun test --changed"
            write("package.json", "{" if field == "malformed" else json.dumps(package))
            result = classify(base, commit())
            assert selected(result) == expected, (field, result)
            count += 1
        # Mutate actual workflow YAML in actual git commits: route changes versus execution.
        def workflow_case(name, mutate, expected):
            global count
            git("reset", "--hard", base); git("clean", "-fdq")
            value = WORKFLOW_TOOLS["load"](WORKFLOWS[name])
            mutate(value)
            write(f".github/workflows/{name}", yaml.safe_dump(value, sort_keys=False))
            result = classify(base, commit())
            assert selected(result) == expected, (name, expected, result)
            count += 1
        workflow_case("ci.yml", lambda w: w.update(concurrency={"group": "owned"}), set())
        workflow_case("relay-r7.yml", lambda w: w["jobs"]["local-relay"].update(needs=["scope", "owned"]), set())
        workflow_case("relay-r7.yml", lambda w: w["on"]["pull_request"].update(paths=["owned/**"]), set())
        workflow_case("relay-r7.yml", lambda w: w["jobs"]["local-relay"].update(**{"timeout-minutes": "81"}), {"relay"})
        workflow_case("relay-r7.yml", lambda w: w["jobs"]["local-relay"].update(**{"runs-on": "ubuntu-24.04"}), {"relay"})
        workflow_case("relay-r7.yml", lambda w: w["jobs"]["local-relay"]["env"].update(BUN_VERSION="1.4.2"), {"relay"})
        workflow_case("relay-r7.yml", lambda w: w["jobs"]["local-relay"]["steps"][0].update(uses="actions/checkout@v4"), {"relay"})
        workflow_case("relay-r7.yml", lambda w: next(s for s in w["jobs"]["local-relay"]["steps"] if "run" in s).update(run="true"), {"relay"})
        workflow_case("relay-r7.yml", lambda w: next(s for s in w["jobs"]["local-relay"]["steps"] if s.get("name") == "Existing actual wire and authority controls").update(run="bun test tests/integration/relay-r7*.test.ts"), {"relay"})
        workflow_case("ci.yml", lambda w: w["jobs"]["test"].update(**{"timeout-minutes": "26"}), {"test"})
        workflow_case("ci.yml", lambda w: w["jobs"]["test"].update(env={"NODE_ENV": "test"}), {"test"})
        workflow_case("ci.yml", lambda w: w["jobs"]["test"].update(**{"runs-on": "ubuntu-24.04"}), {"test"})
        workflow_case("ci.yml", lambda w: next(s for s in w["jobs"]["test"]["steps"] if s.get("name") == "Check coverage threshold").update(run="true"), {"test"})
        workflow_case("ci.yml", lambda w: next(s for s in w["jobs"]["test"]["steps"] if s.get("name") == "Check coverage threshold").update(run='if [ "$COVERAGE < 59" ]; then exit 1; fi'), {"test"})
        workflow_case("ci.yml", lambda w: next(s for s in w["jobs"]["test"]["steps"] if s.get("run") == "bun install --frozen-lockfile").update(run="bun install"), {"test"})
        workflow_case("ci.yml", lambda w: w["jobs"]["lint"].update(**{"runs-on": "ubuntu-24.04"}), {"lint"})
        workflow_case("ci.yml", lambda w: w["jobs"]["typecheck"].update(**{"runs-on": "ubuntu-24.04"}), {"root", "web", "signaling", "integration", "notices"})
        workflow_case("ci.yml", lambda w: w["env"].update(BUN_VERSION="1.4.2"), gates)
        workflow_case("ci.yml", lambda w: w["jobs"].update(unknown={"runs-on": "ubuntu-latest", "steps": [{"run": "true"}]}), gates)
        workflow_case("ci.yml", lambda w: w["jobs"]["auto-release"].update(**{"if": "true"}), METADATA)
        workflow_case("ci.yml", lambda w: w["jobs"]["auto-release"].update(needs=["spelling"]), METADATA)
        workflow_case("release.yml", lambda w: next(iter(w["jobs"].values()))["steps"][0].update(**{"if": "false"}), METADATA)
        workflow_case("release.yml", lambda w: w["on"].update(workflow_dispatch={}), METADATA)
        workflow_case("release.yml", lambda w: w["jobs"].update(test={"runs-on": "ubuntu-latest", "needs": ["build"], "steps": [{"run": "echo owned", "if": "true"}]}), METADATA)
        for target in ("job-if", "job-needs", "step-if"):
            git("reset", "--hard", base); git("clean", "-fdq")
            value = WORKFLOW_TOOLS["load"](WORKFLOWS["release.yml"])
            value["jobs"]["test"] = {"runs-on": "ubuntu-latest", "needs": ["build"],
                "if": "github.event_name == 'push'", "steps": [{"run": "echo owned", "if": "success()"}]}
            write(".github/workflows/release.yml", yaml.safe_dump(value, sort_keys=False))
            alias_base = commit()
            if target == "job-if":
                value["jobs"]["test"]["if"] = "github.event_name == 'workflow_dispatch'"
            elif target == "job-needs":
                value["jobs"]["test"]["needs"] = []
            else:
                value["jobs"]["test"]["steps"][0]["if"] = "always()"
            write(".github/workflows/release.yml", yaml.safe_dump(value, sort_keys=False))
            assert selected(classify(alias_base, commit())) == METADATA
            count += 1
        # The real validator must reject coverage removal, rather than calling a no-op covered.
        git("reset", "--hard", base); git("clean", "-fdq")
        value = WORKFLOW_TOOLS["load"](WORKFLOWS["ci.yml"])
        next(s for s in value["jobs"]["test"]["steps"] if s.get("name") == "Test with coverage")["run"] = "true"
        write(".github/workflows/ci.yml", yaml.safe_dump(value, sort_keys=False))
        try:
            WORKFLOW_TOOLS["validate"]()
        except AssertionError:
            count += 1
        else:
            raise AssertionError("workflow validator accepted a no-op coverage job")
        def routing_refusal(name, mutate):
            global count
            git("reset", "--hard", base); git("clean", "-fdq")
            value = WORKFLOW_TOOLS["load"](WORKFLOWS[name])
            mutate(value)
            write(f".github/workflows/{name}", yaml.safe_dump(value, sort_keys=False))
            commit()
            try:
                WORKFLOW_TOOLS["validate"]()
            except AssertionError:
                count += 1
            else:
                raise AssertionError("validator accepted an unrecognized routing contract")
        routing_refusal("ci.yml", lambda w: w["on"].pop("push"))
        routing_refusal("ci.yml", lambda w: w["on"]["pull_request"].update(paths=["owned/**"]))
        routing_refusal("relay-r7.yml", lambda w: w["on"].pop("workflow_dispatch"))
        routing_refusal("ci.yml", lambda w: w["concurrency"].update(**{"cancel-in-progress": "true"}))
        routing_refusal("ci.yml", lambda w: next(s for s in w["jobs"]["typecheck"]["steps"] if s.get("run") == "bun run typecheck").update(**{"if": "needs.scope.result == 'success' && needs.scope.outputs.web != 'false'"}))
        routing_refusal("ci.yml", lambda w: w["jobs"]["scope"]["permissions"].update(contents="write"))
        routing_refusal("ci.yml", lambda w: w["jobs"]["scope"]["steps"].append({"run": "true"}))
        routing_refusal("ci.yml", lambda w: w["jobs"]["scope"]["outputs"].update(test="${{ steps.scope.outputs.relay }}"))
        routing_refusal("ci.yml", lambda w: w["jobs"]["auto-release"].update(**{"if": "true"}))
        routing_refusal("ci.yml", lambda w: w["jobs"]["auto-release"].update(needs=["spelling"]))
        for filename, job, name in (("ci.yml", "test", "Test with coverage"),
                                   ("ci.yml", "test", "Check coverage threshold"),
                                   ("relay-r7.yml", "local-relay", "Existing actual wire and authority controls"),
                                   ("relay-r7.yml", "local-relay", "Same attached session for 61 actual minutes")):
            def marker_only(w):
                step = next(s for s in w["jobs"][job]["steps"] if s.get("name") == name)
                step["run"] = "true\n" + "\n".join("# " + line for line in step["run"].splitlines())
            routing_refusal(filename, marker_only)
        for change in ("drop-validator", "noop-validator", "noop-controls", "noop-classifier", "reorder", "drop-env"):
            git("reset", "--hard", base); git("clean", "-fdq")
            action = yaml.load(ACTION, Loader=WORKFLOW_TOOLS["UniqueLoader"])
            steps = action["runs"]["steps"]
            if change == "drop-validator":
                steps[:] = [s for s in steps if s.get("name") != "Validate workflow YAML and execution contracts"]
            elif change == "reorder":
                steps.reverse()
            elif change == "drop-env":
                steps[-1].pop("env")
            else:
                label = {"noop-validator": "Validate workflow YAML and execution contracts",
                         "noop-controls": "Verify classifier controls", "noop-classifier": "Classify complete diff"}[change]
                next(s for s in steps if s.get("name") == label)["run"] = "true"
            write(".github/actions/ci-scope/action.yml", yaml.safe_dump(action, sort_keys=False)); commit()
            try:
                WORKFLOW_TOOLS["validate_action"](action)
            except AssertionError:
                count += 1
            else:
                raise AssertionError("scope action bypass accepted")
        for args in (("--unknown-option",), ("-format", "{", ".github/workflows/ci.yml")):
            actual = subprocess.run([os.environ.get("ACTIONLINT", "actionlint"), *args], capture_output=True, text=True)
            try:
                WORKFLOW_TOOLS["lint_result"](actual)
            except (AssertionError, ValueError, KeyError, TypeError):
                count += 1
            else:
                raise AssertionError("actual actionlint tool/format failure accepted")
        outputs = runpy.run_path(str(SCRIPT.with_name("check-scope-output.py")))["OUTPUTS"]
        for change, expected in (("valid-false", 0), ("valid-unknown-full", 0), ("missing", 1),
                                 ("blank", 1), ("invalid", 1), ("none", 1)):
            env = {key: value for key, value in os.environ.items() if not key.startswith("CI_SCOPE_")}
            if change != "none":
                env.update({f"CI_SCOPE_{key.upper()}": "true" if change == "valid-unknown-full" else "false" for key in outputs})
            if change == "missing":
                env.pop("CI_SCOPE_RELAY")
            elif change == "blank":
                env["CI_SCOPE_TEST"] = ""
            elif change == "invalid":
                env["CI_SCOPE_MACOS"] = "True"
            result = subprocess.run([sys.executable, str(SCRIPT.with_name("check-scope-output.py"))],
                                    env=env, capture_output=True, text=True)
            assert (result.returncode == 0) == (expected == 0), (change, result)
            count += 1
        # Execute the actual stable-job failure body. Exact validated conditions keep every
        # following runtime step inactive for tool, validator or mandatory-output failure.
        for filename, names in (("ci.yml", ("lint", "typecheck", "test")),
                                ("relay-r7.yml", ("local-relay",)),
                                ("macos-app.yml", ("build-test",))):
            workflow = WORKFLOW_TOOLS["load"](WORKFLOWS[filename])
            for name in names:
                steps = workflow["jobs"][name]["steps"]
                for failure in ("tool-setup", "validator", "mandatory-outputs"):
                    assert steps[0] == WORKFLOW_TOOLS["FAIL_SCOPE"]
                    actual = subprocess.run(["bash", "-ec", steps[0]["run"]], capture_output=True, text=True)
                    assert actual.returncode == 1
                    assert all("needs.scope.result == 'success'" in step["if"] for step in steps[1:])
                    count += 1
        for destination in (None, "docs/moved.md"):
            git("reset", "--hard", base)
            git("clean", "-fdq")
            source = Path("packages/daemon/src/relay/hub.ts")
            if destination:
                Path(destination).parent.mkdir(parents=True, exist_ok=True)
                source.rename(destination)
            else:
                source.unlink()
            assert selected(classify(base, commit())) == gates
            count += 1
        for destination in (None, "docs/renamed-provisioning.md"):
            git("reset", "--hard", base)
            git("clean", "-fdq")
            source = Path("docs/PROVISIONING.md")
            if destination:
                source.rename(destination)
            else:
                source.unlink()
            assert selected(classify(base, commit())) == {"test"}
            count += 1
        git("reset", "--hard", base)
        git("clean", "-fdq")
        write("packages/daemon/src/relay/hub.ts",
              "import '../../../../scripts/tunnel-storage-proof/probe.ts';")
        consumer_base = commit()
        write("scripts/tunnel-storage-proof/probe.ts", "export {};")
        assert selected(classify(consumer_base, commit())) == gates
        count += 1
        git("reset", "--hard", base)
        git("clean", "-fdq")
        write("scripts/tunnel-storage-proof/probe.ts", "export {};")
        assert selected(classify(consumer_base, commit())) == gates
        count += 1
        git("reset", "--hard", base)
        git("clean", "-fdq")
        for index in range(350):
            write(f"docs/large-{index}.md", "owned diff control")
        write("packages/daemon/src/relay/hub.ts", "export const changed = true;")
        assert selected(classify(base, commit())) == gates
        count += 1
        for left, right in [(base, base), (None, base), ("bad-ref", base), ("f" * 40, base)]:
            assert selected(classify(left, right)) == gates
            count += 1
        for event in ("push", "workflow_dispatch", "repository_dispatch"):
            env = dict(os.environ, GITHUB_EVENT_NAME=event)
            for key in ("GITHUB_OUTPUT", "GITHUB_STEP_SUMMARY"):
                env.pop(key, None)
            result = json.loads(subprocess.check_output(["python3", str(SCRIPT)], env=env))
            assert selected(result) == gates
            count += 1
        print(json.dumps({"controls": count, "passed": count, "failed": 0,
                          "scope": "owned real git diffs and event inputs"}))
    finally:
        os.chdir(original)
        os.environ.update(inherited_git)
