"""Classify the complete PR diff; every unclassified input runs all gates (#1359)."""

import argparse
import json
import os
import re
import subprocess
from pathlib import Path

GATES = ("lint", "root", "web", "signaling", "integration", "notices", "test", "relay")
BUILD_SCRIPTS = {
    "build:darwin-arm64", "build:darwin-x64", "build:linux-arm64",
    "build:linux-x64", "build:all",
}
PROOFS = ("scripts/tunnel-storage-proof/", "scripts/tunnel-decoder-proof/")
LINT_EXTENSIONS = (".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".jsonc")
RELEASE_SCRIPTS = {
    "scripts/install.sh", "scripts/publish-npm.sh", "scripts/update-homebrew.sh",
    "scripts/bump-version.sh", "scripts/testflight-ios.sh", "scripts/testflight-macos.sh",
    "scripts/sync-app-version.mjs", "scripts/stage-macos-web.sh",
}
NON_RELAY_WORKFLOWS = {
    ".github/workflows/release.yml", ".github/workflows/auto-bump-dev.yml",
    ".github/workflows/close-on-develop.yml", ".github/workflows/macos-app.yml",
    ".github/scripts/close-on-develop.ts",
}


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)


def all_gates(reason):
    return {**dict.fromkeys(GATES, True), "typecheck": True, "reason": reason}


def package_transport_unchanged(base, head):
    # Compare parsed objects, never matching diff text. Unknown/new fields trigger R7.
    def transport_input(ref):
        value = json.loads(git("show", f"{ref}:package.json"))
        if not isinstance(value, dict) or not isinstance(value.get("scripts"), dict):
            raise ValueError("invalid package metadata")
        value.pop("version", None)
        for key in BUILD_SCRIPTS:
            value["scripts"].pop(key, None)
        return value
    return transport_input(base) == transport_input(head)


def classify(base, head):
    if not all(re.fullmatch(r"[0-9a-f]{40}", ref or "") for ref in (base, head)):
        return all_gates("Missing or invalid PR commit IDs")
    try:
        merge_base = git("merge-base", base, head).decode().strip()
        # --no-renames keeps both old and new paths; deletions must retain their gates.
        paths = git("diff", "--no-ext-diff", "--no-renames", "--name-only", "-z",
                    merge_base, head, "--").decode().split("\0")[:-1]
        if not paths:
            return all_gates("Empty diff; scope cannot justify skipping")
        gates = dict.fromkeys(GATES, False)
        for path in paths:
            # Bun discovers tests even in documentation, metadata and standalone proof dirs.
            if path.startswith(("docs/", "npm/", *PROOFS)) and re.search(
                    r"[._](test|spec)\.[cm]?[jt]sx?$", path):
                return all_gates("Discovered Bun test changed; running all gates")
            elif path == "package.json":
                gates.update(lint=True, root=True, notices=True, test=True)
                if not package_transport_unchanged(merge_base, head):
                    return all_gates("Root package runtime, dependency or script inputs changed")
            elif path.startswith(("packages/daemon/", "packages/shared/", "packages/signaling/")):
                # Cross-package conformance tests import both endpoints: retain all TS gates.
                gates.update(dict.fromkeys(GATES, True))
            elif path.startswith("packages/web/"):
                if (path.startswith("packages/web/src/") and path.endswith(".css")) or (
                        path.startswith("packages/web/src/assets/")
                        and path.endswith((".svg", ".png", ".jpg", ".webp", ".woff2"))):
                    continue
                # Root Biome excludes all of packages/web; its config changes run all gates.
                gates.update(web=True, integration=True, test=True, relay=True)
                if path.endswith("package.json") or "tsconfig" in path or "bunfig" in path:
                    return all_gates("Web dependency or tool configuration changed")
            elif path.startswith("packages/native/"):
                # Swift/Xcode acceptance is separate; JSON is still covered by root Biome.
                if not path.endswith((".swift", ".plist", ".pbxproj", ".xcscheme", ".entitlements",
                                      ".xcworkspacedata", ".xcsettings", ".json", ".png", ".md",
                                      ".resolved")):
                    return all_gates("Unknown native input; running all gates")
                gates["lint"] |= path.endswith(".json")
            elif path.startswith("packages/macos/"):
                gates.update(lint=True, root=True, web=True, integration=True, test=True)
            elif path.startswith(PROOFS):
                # The exemption belongs only to standalone proofs. A new source/test
                # consumer must not leave later proof edits outside runtime coverage.
                consumers = subprocess.run(
                    ["git", "grep", "-q", "-e", "tunnel-storage-proof", "-e",
                     "tunnel-decoder-proof", base, head, "--", "packages", "tests"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                )
                if consumers.returncode != 1:
                    return all_gates("Proof consumer found or scan unavailable; running all gates")
                gates["lint"] |= path.endswith(LINT_EXTENSIONS)
            elif path in RELEASE_SCRIPTS or path in NON_RELAY_WORKFLOWS or path.startswith("npm/"):
                gates.update(lint=True, root=True, notices=True, test=True)
            elif path.startswith("tests/"):
                gates.update(dict.fromkeys(GATES, True))
            elif path == "docs/PROVISIONING.md":
                # key-provisioning.test.ts extracts and executes its bootstrap shell script.
                # Markdown here is an actual test fixture, not documentation-only input.
                gates["test"] = True
            elif path == "docs/relay-r7-gates.md":
                gates["relay"] = True
            elif path.startswith((".github/", ".rules/")):
                return all_gates("Gate workflow or configuration changed")
            elif path.startswith("docs/") or path.endswith(".md") or path == "CHANGELOG":
                continue
            elif path == "_typos.toml":
                continue
            else:
                return all_gates("Unknown path or global/gate configuration changed")
        return {**gates, "typecheck": any(gates[key] for key in
                ("root", "web", "signaling", "integration", "notices")),
                "reason": f"Classified complete PR diff ({len(paths)} paths)"}
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError):
        return all_gates("Diff or package metadata unavailable; running all gates")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head")
    args = parser.parse_args()
    if args.base is not None or args.head is not None:
        result = classify(args.base, args.head)
    elif os.environ.get("GITHUB_EVENT_NAME") != "pull_request":
        result = all_gates("Main push or manual run retains full gates")
    else:
        try:
            event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text())
            result = classify(event["pull_request"]["base"]["sha"],
                              event["pull_request"]["head"]["sha"])
        except (OSError, ValueError, KeyError, TypeError):
            result = all_gates("PR event unavailable; running all gates")
    print(json.dumps(result, sort_keys=True))
    if output := os.environ.get("GITHUB_OUTPUT"):
        with open(output, "a") as stream:
            for key, value in result.items():
                if isinstance(value, bool):
                    stream.write(f"{key}={str(value).lower()}\n")
    if summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(summary, "a") as stream:
            stream.write(f"### CI scope\n\n{result['reason']}\n\n")
            stream.write("| Gate | Selected |\n| --- | --- |\n")
            for key in GATES:
                stream.write(f"| {key} | {'Run' if result[key] else 'Scoped skip'} |\n")


if __name__ == "__main__":
    main()
