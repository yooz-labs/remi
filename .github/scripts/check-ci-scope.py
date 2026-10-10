"""Exercise the shipping classifier with actual owned git histories, not mocked diffs."""

import json
import os
import runpy
import subprocess
import tempfile
from pathlib import Path

SCRIPT = Path(__file__).with_name("ci-scope.py").resolve()
module = runpy.run_path(str(SCRIPT))
classify, gates = module["classify"], set(module["GATES"])
ROOT_PACKAGE = {"version": "0.7.17-dev.1", "scripts": {"test": "bun test",
                "build:darwin-arm64": "bun build --target=bun-darwin-arm64",
                "build:darwin-x64": "bun build --target=bun-darwin-x64"},
                "devDependencies": {"typescript": "5.7.0"}}
WEB = {"web", "integration", "test", "relay"}
METADATA = {"lint", "root", "notices", "test"}


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
        base = commit()
        cases = [
            ("README.md", "docs\n", set()),
            ("docs/diagram.png", "owned asset", set()),
            ("packages/native/Mac/Main.swift", "import SwiftUI\n", set()),
            ("packages/native/Mac/Assets.xcassets/Contents.json", "{}", {"lint"}),
            ("packages/native/RemiKit/Tests/Integration/relay-fixture.ts", "export {};", gates),
            ("scripts/tunnel-storage-proof/probe.ts", "export {};", {"lint"}),
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
            ("packages/shared/src/protocol.ts", "export {};", gates),
            ("packages/signaling/wrangler.toml", "name = 'owned'", gates),
            ("tests/integration/relay-r3.test.ts", "export {};", gates),
            (".github/workflows/ci.yml", "name: owned", gates),
            (".github/workflows/relay-r7.yml", "name: owned", gates),
            (".github/workflows/release.yml", "name: owned", METADATA),
            (".github/workflows/new.yml", "name: owned", gates),
            (".github/workflows/macos-app.yml", "name: owned", METADATA),
            (".github/actions/ci-scope/action.yml", "name: owned", gates),
            (".github/scripts/ci-scope.py", "print('owned')", gates),
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
        for event in ("push", "workflow_dispatch"):
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
