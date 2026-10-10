"""Compare actual execution instructions separately from workflow routing (#1359)."""

import copy
import json
import os
import subprocess
from pathlib import Path

import yaml


class UniqueLoader(yaml.BaseLoader):
    pass


def mapping(loader, node):
    result = {}
    for key, value in node.value:
        key = loader.construct_object(key)
        if key in result:
            raise ValueError("duplicate YAML key")
        result[key] = loader.construct_object(value)
    return result


UniqueLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, mapping)


def load(text):
    value = yaml.load(text, Loader=UniqueLoader)
    if not isinstance(value, dict) or not isinstance(value.get("jobs"), dict):
        raise ValueError("missing workflow jobs")
    return value


def execution(value):
    result = copy.deepcopy(value)
    for key in ("name", "on", "concurrency"):
        result.pop(key, None)
    result["jobs"].pop("scope", None)
    for job in result["jobs"].values():
        for key in ("if", "needs"):
            job.pop(key, None)
        steps = []
        for original in job["steps"]:
            step = dict(original)
            step.pop("if", None)
            # Only the exact inert reporting step is routing, never an arbitrary named command.
            if step.get("name") == "Report scoped skip" and set(step) == {"name", "run"}:
                if step["run"] in {
                    f'echo "{label} skipped; no relevant inputs changed." >> "$GITHUB_STEP_SUMMARY"'
                    for label in ("lint", "typecheck", "test", "macOS build")
                } or step["run"] == 'echo "Relay gate skipped; no relay inputs changed." >> "$GITHUB_STEP_SUMMARY"':
                    continue
            steps.append(step)
        job["steps"] = steps
    return result


def changed_gates(path, before, after):
    left, right = execution(load(before)), execution(load(after))
    if left == right:
        return set()
    if {key: value for key, value in left.items() if key != "jobs"} != {
            key: value for key, value in right.items() if key != "jobs"}:
        raise ValueError("global execution configuration changed")
    if left["jobs"].keys() != right["jobs"].keys():
        raise ValueError("unknown execution job added or removed")
    changed = {key for key in left["jobs"] if left["jobs"][key] != right["jobs"][key]}
    if path.endswith("relay-r7.yml"):
        if changed != {"local-relay"}:
            raise ValueError("unknown R7 execution job")
        return {"relay"}
    if path.endswith("ci.yml"):
        selected = set()
        for job in changed:
            if job == "test":
                selected.add("test")
            elif job == "lint":
                selected.add("lint")
            elif job == "typecheck":
                selected.update(("root", "web", "signaling", "integration", "notices"))
            elif job not in {"spelling", "e2e", "auto-release", "release-guard", "sync-develop"}:
                raise ValueError("unknown CI execution job")
            else:
                selected.update(("lint", "root", "notices", "test"))
        return selected
    if path.endswith("macos-app.yml"):
        return {"macos"}
    return {"lint", "root", "notices", "test"}


def validate():
    root = Path.cwd()
    directory = root / ".github/workflows"
    files = sorted([*directory.glob("*.yml"), *directory.glob("*.yaml")])
    workflows = {file.name: load(file.read_text()) for file in files}
    ci, relay = workflows["ci.yml"], workflows["relay-r7.yml"]
    assert relay["jobs"]["local-relay"].get("name", "local-relay") == "local-relay"
    assert workflows["macos-app.yml"]["jobs"]["build-test"]["name"] == "Build and Test (macOS)"
    assert ci["on"] == {"push": {"branches": ["main"]}, "pull_request": {"branches": ["main", "develop"]}}
    assert relay["on"] == {"workflow_dispatch": "", "pull_request": {"branches": ["main", "develop"]}}
    mac = workflows["macos-app.yml"]
    assert mac["on"] == {"pull_request": {"paths": ["packages/macos/**",
        "packages/web/src/lib/native-*.ts", "packages/web/tests/browser/*native-provider-harness.ts",
        "scripts/stage-macos-web.sh", ".github/workflows/macos-app.yml"]}}
    for workflow in (ci, relay, mac):
        assert workflow["concurrency"] == {
            "group": "${{ github.workflow }}-${{ github.event.pull_request.number || github.run_id }}",
            "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
        }
    names = {"spelling": "Spelling", "lint": "Lint", "typecheck": "Type Check", "test": "Test"}
    for key, name in names.items():
        assert ci["jobs"][key]["name"] == name, key
    for workflow, job_name, flag in ((ci, "lint", "lint"), (ci, "typecheck", "typecheck"),
                                    (ci, "test", "test"), (relay, "local-relay", "relay"),
                                    (workflows["macos-app.yml"], "build-test", "macos")):
        job = workflow["jobs"][job_name]
        assert job["needs"] == ["scope"] and job["if"] == "${{ !cancelled() }}"
        for step in job["steps"]:
            condition = step.get("if", "")
            if step.get("name") == "Report scoped skip":
                assert condition == f"needs.scope.result == 'success' && needs.scope.outputs.{flag} == 'false'"
            else:
                step_flag = flag
                if job_name == "typecheck":
                    step_flag = {"bun run typecheck": "root", "bun run typecheck:web": "web",
                        "bun run typecheck:web-tests": "web", "bun run typecheck:signaling": "signaling",
                        "node_modules/.bin/tsc -p tests/integration/tsconfig.relay-r3.json": "integration",
                        "bun scripts/third-party-notices.ts --check": "notices"}.get(step.get("run"), flag)
                expected = f"needs.scope.result != 'success' || needs.scope.outputs.{step_flag} != 'false'"
                if step.get("uses") == "actions/upload-artifact@v4":
                    expected = f"always() && ({expected})"
                assert condition == expected, (job_name, step)
        scope = workflow["jobs"]["scope"]
        assert set(scope) == {"name", "runs-on", "permissions", "outputs", "steps"}
        assert scope["permissions"] == {"contents": "read"}
        assert scope["runs-on"] == "ubuntu-latest"
        output_keys = {"lint", "typecheck", "root", "web", "signaling", "integration", "notices", "test"} if workflow is ci else {flag}
        assert scope["outputs"] == {key: f"${{{{ steps.scope.outputs.{key} }}}}" for key in output_keys}
        assert scope["steps"] == [
            {"uses": "actions/checkout@v5", "with": {"fetch-depth": "0"}},
            {"uses": "./.github/actions/ci-scope", "id": "scope"},
        ]
    test_runs = [step.get("run", "") for step in ci["jobs"]["test"]["steps"]]
    assert any("bun test --coverage --coverage-reporter=text --coverage-reporter=lcov" in run for run in test_runs)
    assert any('"$COVERAGE < 60"' in run and 'exit 1' in run for run in test_runs)
    for command in ("bun run typecheck", "bun run typecheck:web", "bun run typecheck:web-tests",
                    "bun run typecheck:signaling", "node_modules/.bin/tsc -p tests/integration/tsconfig.relay-r3.json",
                    "bun scripts/third-party-notices.ts --check"):
        assert command in [step.get("run") for step in ci["jobs"]["typecheck"]["steps"]]
    assert "bunx biome check ." in [step.get("run") for step in ci["jobs"]["lint"]["steps"]]
    soak = [step for step in relay["jobs"]["local-relay"]["steps"] if "61 actual minutes" in step.get("name", "")]
    assert len(soak) == 1 and soak[0]["env"]["REMI_RELAY_R7_SOAK"] == "1"
    assert "bun test --timeout 4500000 packages/web/tests/relay-r7-soak.test.ts" in soak[0]["run"]
    assert int(relay["jobs"]["local-relay"]["timeout-minutes"]) >= 62
    wire = next(step["run"] for step in relay["jobs"]["local-relay"]["steps"]
                if step.get("name") == "Existing actual wire and authority controls")
    assert all(part in wire for part in ("bun test packages/signaling/tests/e2e",
        "packages/web/tests/relay-machine-channel.test.ts", "packages/web/tests/relay-client-outcomes.test.ts",
        "tests/integration/relay-r3*.test.ts", "tests/integration/relay-r6-ingress.test.ts",
        "tests/integration/relay-r7*.test.ts"))
    action = yaml.load((root / ".github/actions/ci-scope/action.yml").read_text(), Loader=UniqueLoader)
    assert action["runs"]["using"] == "composite"
    assert set(action["outputs"]) == {"lint", "typecheck", "root", "web", "signaling", "integration", "notices", "test", "relay", "macos"}
    for key, value in action["outputs"].items():
        assert value["value"] == f"${{{{ steps.scope.outputs.{key} }}}}"
    assert action["runs"]["steps"][0] == {
        "uses": "astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e",
        "with": {"version": "0.12.23", "enable-cache": "false"},
    }
    setup = next(step["run"] for step in action["runs"]["steps"]
                 if step.get("name") == "Install pinned workflow validation tools")
    assert all(pin in setup for pin in ("PyYAML==6.0.3", "actionlint_1.7.12_linux_amd64.tar.gz",
        "8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8"))
    for step in action["runs"]["steps"][1:]:
        subprocess.run(["bash", "-n"], input=step["run"], text=True, check=True)
    proc = subprocess.run([os.environ.get("ACTIONLINT", "actionlint"), "-format", "{{json .}}",
                           *map(str, files)], capture_output=True, text=True)
    findings = json.loads(proc.stdout or "[]")
    allowed = [{"kind": item["kind"], "message": item["message"], "filepath": item["filepath"]}
               for item in findings]
    assert all(item["kind"] == "if-cond" and 'constant expression "false"' in item["message"]
               and item["filepath"].endswith("ci.yml") for item in allowed), findings
    assert len(allowed) <= 1, findings
    assert proc.returncode == 0 or (proc.returncode == 1 and len(allowed) == 1), proc.stderr
    print(json.dumps({"workflow_yaml_and_contracts": "pass", "actionlint_new_diagnostics": 0,
                      "existing_disabled_e2e_warning": len(allowed)}))


if __name__ == "__main__":
    validate()
