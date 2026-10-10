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
