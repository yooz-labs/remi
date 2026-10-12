"""Classify the complete PR diff; every unclassified input runs all gates (#1359)."""

import argparse
import hashlib
import io
import json
import os
import re
import runpy
import subprocess
from pathlib import Path

GATES = ("lint", "root", "web", "signaling", "integration", "notices", "test", "relay", "macos")
BUILD_SCRIPTS = {
    "build:darwin-arm64", "build:darwin-x64", "build:linux-arm64",
    "build:linux-x64", "build:all",
}
PROOFS = ("scripts/tunnel-storage-proof/", "scripts/tunnel-decoder-proof/")
NATIVE_SECURE_FIXTURE = "packages/native/RemiKit/Tests/Integration/secure-push-fixture.ts"
WRAPPER_SUSPEND_INPUTS = (
    "packages/daemon/tests/cli/wrapper-suspend.test.ts",
    "packages/daemon/tests/cli/fixtures/wrapper-suspend-pty.py",
)
CI_COVERAGE_READER = "packages/daemon/tests/ci-coverage-threshold.test.ts"
HOOK_SERVER_TEST = "packages/daemon/tests/hooks/hook-server.test.ts"
# Reviewed commentary only; the whole blob and complete scan must still match (#1359).
HOOK_TEST_COMMENTS = {
    "packages/daemon/tests/hooks/fixtures/build-hook-corpus.ts": (
        "7568a1b1da3e696a169b2197d0aaf3c46d8bd75f", 96,
        " * unsafe to treat as pure Claude Code traffic. `hook-server.test.ts` and",
    ),
    "packages/daemon/tests/hooks/hook-diag-provenance-worker.ts": (
        "2f070d8de7da9247e8dc153f211dad76732b5d33", 10,
        " * at it exactly like `hook-server.test.ts` does, and exits; the parent test",
    ),
}
# Dormant codec ownership is exact; registering/exporting it restores R7 (#1170).
STAGING_SOURCE = "packages/shared/src/image-staging.ts"
STAGING_INPUTS = {
    STAGING_SOURCE, "packages/shared/tests/image-staging.test.ts",
    *(f"packages/shared/tests/fixtures/image-staging/{name}" for name in
      ("generate.ts", "vectors.json", "fixture.png", "fixture.jpg", "README.md")),
    *(f"scripts/tunnel-decoder-proof/{name}" for name in
      ("staging-codec-probe.ts", "staging-codec-matrix.py", "staging-codec-mutations.py")),
}
STAGING_EXPORTS = {
    "IMAGE_STAGING_CAPABILITY", "IMAGE_STAGING_LIMITS", "IMAGE_STAGING_REFUSAL_CODES",
    "ImageStagingRefusalCode", "ImageStagingMediaType", "ImageStagingOperation",
    "ImageStagingBinding", "ImageUploadBegin", "ImageUploadAccepted", "ImageUploadChunk",
    "ImageUploadChunkAck", "ImageUploadComplete", "ImageUploadResult", "ImageUploadCancel",
    "ImageUploadCancelResult", "ImageUploadRefused", "ImageStagingMessage",
    "decodeImageStagingFrame", "encodeImageStagingFrame",
}
STAGING_TOKENS = STAGING_EXPORTS | {"image-staging", "image_upload_", "image_staging"}
STAGING_EXECUTABLE_DOC = "docs/PROVISIONING.md"
STAGING_SURFACES = ("packages", "tests", "scripts", ".github", STAGING_EXECUTABLE_DOC)
STAGING_BINARY = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".ico", ".pdf", ".woff", ".woff2"}


# One reviewed accounting relocation only, not future dormant daemon edits (#1170).
ACCOUNTING_ORIGINALS = {
    "scripts/tunnel-storage-proof/journal-schema.ts": "53b28599c90c3ed31433293b7d600939c9db9bbe",
    "scripts/tunnel-storage-proof/journal-settlement.ts": "2d662ff7de2779abf9e0903ba98c1f5dedbd4200",
    "scripts/tunnel-storage-proof/recovery-probe.ts": "f310d3d29628572a27ce3ecba4088a11de6e699b",
    "scripts/tunnel-storage-proof/recovery.ts": "a68854f97a72610171ce86ce4b016398cd6d8e2b",
    "scripts/tunnel-storage-proof/reservation-probe.ts": "6b5fed29e5575fb4da1efd1c05e539dfa45c23bf",
    "scripts/tunnel-storage-proof/reservations.ts": "d47d41995742cbc20f993005b4f002c3f6a0898f",
    "scripts/tunnel-storage-proof/reserved-copy-probe.ts": "7f37292c530cbaebdf19b2540303d70ac000dafa",
    "scripts/tunnel-storage-proof/reserved-copy.ts": "7dc52af2c8146d8bac3ab0f127818456f1248954",
    "scripts/tunnel-storage-proof/settlement-fixture.ts": "0fd828d6765a85743f82090aa9042cfd2fc2bc7d",
    "scripts/tunnel-storage-proof/settlement-mutations.py": "66288af72b9522b04d7fd846e97789b4307b2e7b",
    "scripts/tunnel-storage-proof/settlement-probe.ts": "eca0b3d2cc2cb17c5f26b21c8bbc412983948764",
    "scripts/tunnel-storage-proof/storage-approval-child.ts": "5c101f45514ae284e1a08ab6bf5e138281cf6e52",
    "scripts/tunnel-storage-proof/storage-approval-probe.ts": "803c290594d7d7db47428bdb0182fe6695355066",
}
ACCOUNTING_HEAD = {
    "packages/daemon/src/tunnel/reservations.ts": "4cc18f1200a5f15276cdc0a14377c0985e9d5d7d",
    "packages/daemon/src/tunnel/journal-schema.ts": "bbabfa4bbcdd60eee532839750b945615dba09e4",
    "packages/daemon/src/tunnel/recovery-error.ts": "6855b1b94ede69f9ee85cd6219c813e8f9d0729d",
    "scripts/tunnel-storage-proof/reservations.ts": "57cb869399e9da0173e8cd8ae11a8b9f8348229a",
    "scripts/tunnel-storage-proof/journal-schema.ts": "58eb6eb4e197887c88599bbde71c179c95fe0637",
    "scripts/tunnel-storage-proof/recovery.ts": "266b9db3cdfc1de295c2a7190277da6c11a9e5ff",
    "scripts/tunnel-storage-proof/settlement-mutations.py": "a245d6c57204405ae871b59f8022ec96d646b0d4",
    "packages/daemon/tests/tunnel/reservations-adoption.test.ts": "d811bdecf69236b37a7abe840fe7507a147c1e24",
}
ACCOUNTING_TEST = "packages/daemon/tests/tunnel/reservations-adoption.test.ts"
ACCOUNTING_IDENTIFIERS = {
    "CLEANUP_BLOCKING_DEBT", "ReservationError", "Reservations", "MarkerKind", "MarkerWitness",
    "JournalBinding", "JournalLease", "MARKER_ALLOWANCE", "validWitnesses", "validBinding",
    "sameLease", "sameWitnesses", "RecoveryError",
}
ACCOUNTING_REFERENCES = re.compile(
    r"(?<![\w$])(?:" + "|".join(sorted(ACCOUNTING_IDENTIFIERS)) + r")(?![\w$])|"
    r"(?<![\w$])[\w@./-]*/(?:reservations|journal-schema|recovery-error)"
    r"(?:\.[cm]?[jt]s)?(?![\w$./-])|"
    r"\b(?:from\s*|import\s*(?:\(\s*)?|require\s*\(\s*)"
    r"['\"](?:reservations|journal-schema|recovery-error)(?:\.[cm]?[jt]s)?['\"]"
)


# Exact reviewed short-suite fixture transitions; the 61-minute body stays unchanged.
SOAK_FIXTURES = {
    "tests/integration/relay-r3-drain.test.ts": ("c0747830bac50fed23d96c057df3dc68f98078ea", "917d6178be63d0b7428c8228366a359b429342a1"),
    "packages/signaling/tests/e2e/push.e2e.test.ts": ("8619bb6b4c833708590061046338183a636aa652", "71b2cb846cca049e8f0a87ccb86d50d07fb89847"),
}
SOAK_FIXTURE_TOKENS = ("relay-r3-drain", "push.e2e")
SOAK_TRACE = {
    "packages/web/tests/relay-r7-soak.test.ts": "62563dd6a34518982397ca0cfb0c8f99a387b412",
    "packages/web/tests/helpers/relay-hub.ts": "c7cbf893b5cc3365952da29bed6403b32cda0d52",
    "packages/signaling/tests/e2e/harness.ts": "df152a92fd95d8dcfd5176e79c3110aa7b500628",
    "packages/signaling/tests/e2e/test-entry.ts": "be546df77024a1e7e3a32023ac53e5175627f526",
    "packages/signaling/tests/e2e/endpoints.ts": "95efbb070e2cae88b306fa9ea1aa50207e95b7e9",
    "packages/web/src/lib/relay-machine-channel.ts": "ea1ca3127869e3d82cd85967a2f953bea6d31a25",
    "packages/web/src/lib/relay-requests.ts": "118751c5c072a51bfcd921cf68696e1d425209c0",
    "packages/shared/src/index.ts": "8dc617a1964b84e6920fefb63af3531f58ffc62c",
    "bunfig.toml": "3cdd70fa50576ab11b0ca1d8faeac951c3786196",
    "packages/daemon/tests/debug/test-harness-marker.ts": "e0e598b09ea569730495b91e42a485e0541fafd2",
    "packages/daemon/tests/unset-remi-home.ts": "5183f291018ec6e71d63708c35edcaddc926eb09",
    "packages/daemon/tests/session/port-test-helpers.ts": "5505b2f8ab4556e86d36b32e13c28f85009db7d7",
    "packages/daemon/src/session/port-utils.ts": "c9a8af94b6b7d7a31e85688276e6566a41eb4f14",
    "packages/signaling/wrangler.toml": "f898c79be3ea9b76aa772b34c066f8a0e0e08374",
}
SOAK_VERSION_TRACE = {'packages/daemon/src/cli.ts': '978dd5a92b65a75644c678d286639ddbfc4a604fa88663397b8a5de75b43986f', 'package.json': '1e9ae2a08a0baf363838c236363a3810df477ef378c8e78d7385509acda4148d'}


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
CI_TOOLS = {
    ".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py",
    ".github/scripts/workflow-scope.py", ".github/actions/ci-scope/action.yml",
    ".github/scripts/workflow-contracts.json",
    ".github/scripts/check-scope-output.py",
    ".github/ci-scope.md",
}


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)


def all_gates(reason):
    return {**dict.fromkeys(GATES, True), "typecheck": True, "relay_soak": True, "reason": reason}


def hook_test_references_reviewed(base, head):
    try:
        for ref in (base, head):
            tree = git("ls-tree", "-r", "-z", ref, "--", "packages", "tests", "scripts",
                       ".github/workflows", ".github/actions", ".github/scripts")
            if not tree or not tree.endswith(b"\0"):
                return False
            for entry in tree[:-1].split(b"\0"):
                header, separator, path = entry.partition(b"\t")
                if not separator or not re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}", header):
                    return False
                if any(part in (b"", b".", b"..") for part in path.split(b"/")) or any(
                        byte < 32 or byte == 127 for byte in path):
                    return False
            # An added/deleted/renamed producer is not the reviewed modification case.
            if git("cat-file", "-t", f"{ref}:{HOOK_SERVER_TEST}").strip() != b"blob":
                return False
            expected = []
            for path, (blob, line, text) in HOOK_TEST_COMMENTS.items():
                if git("rev-parse", f"{ref}:{path}").decode().strip() != blob:
                    return False
                expected.append(f"{ref}:{path}:{line}:{text}")
            consumers = subprocess.run(
                ["git", "grep", "-n", "-F", "-e", "hook-server.test", ref, "--",
                 "packages", "tests", "scripts", ".github/workflows", ".github/actions", ".github/scripts",
                 f":(exclude){HOOK_SERVER_TEST}", ":(exclude).github/scripts/ci-scope.py",
                 ":(exclude).github/scripts/check-ci-scope.py"],
                capture_output=True, check=False,
            )
            # Scan whole known files too: only their single exact comment lines are permitted.
            if consumers.returncode != 0 or sorted(consumers.stdout.decode().splitlines()) != sorted(expected):
                return False
        return True
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError):
        return False


def staging_is_dormant(base, head, merge_base, paths):
    try:
        trees = {}
        for ref in dict.fromkeys((base, head, merge_base)):
            raw = git("ls-tree", "-r", "-z", ref, "--", *STAGING_SURFACES)
            if not raw or not raw.endswith(b"\0"):
                return False
            tree = {}
            for entry in raw[:-1].split(b"\0"):
                header, separator, name = entry.partition(b"\t")
                if not separator or not re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}", header):
                    return False
                path = name.decode()
                if any(part in ("", ".", "..") for part in path.split("/")) or any(
                        ord(char) < 32 or ord(char) == 127 for char in path):
                    return False
                tree[path] = header.split()[-1].decode()
            trees[ref] = tree
        for path in set(paths) & STAGING_INPUTS:
            status = git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z",
                         merge_base, head, "--", path)
            kind = "M" if path in trees[merge_base] and path in trees[base] else "A"
            if (path not in trees[head] or (kind == "A" and
                    (path in trees[merge_base] or path in trees[base])) or
                    status != f"{kind}\0{path}\0".encode()):
                return False
        if STAGING_SOURCE not in trees[head]:
            return False
        for ref in (base, head):
            tree = trees[ref]
            source = tree.get(STAGING_SOURCE)
            if source:
                text = git("cat-file", "blob", source).decode()
                if "\0" in text:
                    return False
                declarations = re.findall(r"^[ \t]*export\s+(?:const|type|interface|function)\s+(\w+)",
                                          text, re.MULTILINE)
                if set(declarations) != STAGING_EXPORTS or len(declarations) != len(STAGING_EXPORTS):
                    return False
                if len(re.findall(r"^[ \t]*export\b", text, re.MULTILINE)) != len(declarations):
                    return False
            scan = {}
            for path, blob in tree.items():
                name = Path(path).name
                if (name.startswith(".env") or Path(path).suffix.lower() in {".pem", ".key", ".p12"}
                        or name in {"credentials", "secrets.json"}):
                    return False
                if path in STAGING_INPUTS or path in {
                        ".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py"}:
                    continue
                if path == STAGING_EXECUTABLE_DOC or Path(path).suffix.lower() not in {".md", *STAGING_BINARY}:
                    scan[path] = blob
            # Batch reads validate complete text, even a malformed file with no token match.
            data = subprocess.check_output(["git", "cat-file", "--batch"],
                                           input="".join(f"{blob}\n" for blob in scan.values()).encode(),
                                           stderr=subprocess.PIPE)
            stream = io.BytesIO(data)
            for blob in scan.values():
                header = stream.readline().decode().split()
                if len(header) != 3 or header[:2] != [blob, "blob"] or not header[2].isdigit():
                    return False
                content = stream.read(int(header[2]))
                if len(content) != int(header[2]) or stream.read(1) != b"\n":
                    return False
                text = content.decode()
                if "\0" in text or any(token in text for token in STAGING_TOKENS):
                    return False
            if stream.read():
                return False
        return True
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError):
        return False


def accounting_relocation_is_dormant(base, head, merge_base, paths):
    try:
        trees = {}
        for ref in dict.fromkeys((base, head, merge_base)):
            raw = git("ls-tree", "-r", "-z", ref, "--", *STAGING_SURFACES)
            if not raw or not raw.endswith(b"\0"):
                return False
            tree = {}
            for entry in raw[:-1].split(b"\0"):
                header, separator, name = entry.partition(b"\t")
                if not separator or not re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}", header):
                    return False
                path = name.decode()
                if any(part in ("", ".", "..") for part in path.split("/")) or any(
                        ord(char) < 32 or ord(char) == 127 for char in path):
                    return False
                tree[path] = header.split()[-1].decode()
            trees[ref] = tree
        for ref in (base, merge_base):
            if any(trees[ref].get(path) != blob for path, blob in ACCOUNTING_ORIGINALS.items()):
                return False
        required = set(ACCOUNTING_HEAD) - {ACCOUNTING_TEST}
        if not required <= set(paths):
            return False
        if any(ACCOUNTING_TEST in trees[ref] for ref in (base, merge_base)):
            return False
        for path, blob in ACCOUNTING_HEAD.items():
            if path == ACCOUNTING_TEST and path not in paths:
                if path in trees[head]:
                    return False
                continue
            if trees[head].get(path) != blob:
                return False
            kind = "M" if path in ACCOUNTING_ORIGINALS else "A"
            if kind == "A" and any(path in trees[ref] for ref in (base, merge_base)):
                return False
            status = git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z",
                         merge_base, head, "--", path)
            if status != f"{kind}\0{path}\0".encode():
                return False
        # Immutable proof consumers cannot acquire extra execution while remaining excluded.
        for path, blob in ACCOUNTING_ORIGINALS.items():
            if path not in ACCOUNTING_HEAD and trees[head].get(path) != blob:
                return False
        for ref in (base, head):
            scan = {}
            for path, blob in trees[ref].items():
                name = Path(path).name
                if (name.startswith(".env") or Path(path).suffix.lower() in {".pem", ".key", ".p12"}
                        or name in {"credentials", "secrets.json"}):
                    return False
                if path in ACCOUNTING_ORIGINALS or path in ACCOUNTING_HEAD or path in {
                        ".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py"}:
                    continue
                if path == STAGING_EXECUTABLE_DOC or Path(path).suffix.lower() not in {".md", *STAGING_BINARY}:
                    scan[path] = blob
            data = subprocess.check_output(["git", "cat-file", "--batch"],
                                           input="".join(f"{blob}\n" for blob in scan.values()).encode(),
                                           stderr=subprocess.PIPE)
            stream = io.BytesIO(data)
            for blob in scan.values():
                header = stream.readline().decode().split()
                if len(header) != 3 or header[:2] != [blob, "blob"] or not header[2].isdigit():
                    return False
                content = stream.read(int(header[2]))
                if len(content) != int(header[2]) or stream.read(1) != b"\n":
                    return False
                text = content.decode()
                if "\0" in text or ACCOUNTING_REFERENCES.search(text):
                    return False
            if stream.read():
                return False
        return True
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError):
        return False


def ordinary_soak_doc(path):
    return path not in {"docs/PROVISIONING.md", "docs/relay-r7-gates.md"} and (
        path.endswith(".md") or path == "CHANGELOG")


def soak_versions_reviewed(tree):
    package = tree.get("package.json")
    cli = tree.get("packages/daemon/src/cli.ts")
    if not package or not cli or package[0] != "100644" or cli[0] != "100644":
        return False
    package_data = git("cat-file", "blob", package[1])
    metadata = json.loads(package_data)
    if not isinstance(metadata, dict) or not isinstance(metadata.get("version"), str):
        return False
    version = metadata["version"]
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+(?:-dev\.[0-9]+)?", version):
        return False
    cli_data = git("cat-file", "blob", cli[1])
    cli_pattern = rb"(?m)^( +return ')([^'\n]+)('; // REMI_COMPILED_VERSION)$"
    values = re.findall(cli_pattern, cli_data)
    if len(values) != 2 or any(value[1] != version.encode() for value in values):
        return False
    package_pattern = rb'(?m)^(  "version": ")([^"\n]+)(",)$'
    values = re.findall(package_pattern, package_data)
    if len(values) != 1 or values[0][1] != version.encode():
        return False
    normalized = {
        "packages/daemon/src/cli.ts": re.sub(cli_pattern, rb"\1<VERSION>\3", cli_data),
        "package.json": re.sub(package_pattern, rb"\1<VERSION>\3", package_data),
    }
    return all(hashlib.sha256(data).hexdigest() == SOAK_VERSION_TRACE[path]
               for path, data in normalized.items())


def soak_fixture_only(base, head, merge_base, paths):
    changed = set(paths) & set(SOAK_FIXTURES)
    if not changed or any(path not in changed and not ordinary_soak_doc(path) for path in paths):
        return False
    try:
        trees = {}
        for ref in dict.fromkeys((base, head, merge_base)):
            raw = git("ls-tree", "-r", "-z", ref)
            if not raw or not raw.endswith(b"\0"):
                return False
            tree = {}
            for entry in raw[:-1].split(b"\0"):
                header, separator, name = entry.partition(b"\t")
                if not separator or not re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}", header):
                    return False
                path = name.decode()
                if any(part in ("", ".", "..") for part in path.split("/")) or any(
                        ord(char) < 32 or ord(char) == 127 for char in path):
                    return False
                mode, _, blob = header.decode().split()
                if path in tree:
                    return False
                tree[path] = (mode, blob)
            trees[ref] = tree
        for ref in (base, head):
            if any(trees[ref].get(path) != ("100644", blob) for path, blob in SOAK_TRACE.items()):
                return False
            if not soak_versions_reviewed(trees[ref]):
                return False
        for path, (old, new) in SOAK_FIXTURES.items():
            for ref in (base, head):
                if trees[ref].get(path) not in {("100644", old), ("100644", new)}:
                    return False
            if path in changed:
                if any(trees[ref].get(path) != ("100644", old) for ref in (base, merge_base)):
                    return False
                if trees[head].get(path) != ("100644", new):
                    return False
                status = git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z",
                             merge_base, head, "--", path)
                if status != f"M\0{path}\0".encode():
                    return False
        # Trace wiring, helpers/config and every non-doc object/mode stay identical at both ends.
        def remaining(tree):
            return {p: value for p, value in tree.items() if p not in changed and not ordinary_soak_doc(p)}
        if remaining(trees[base]) != remaining(trees[head]):
            return False
        for ref in (base, head):
            scan = {}
            for path, (_, blob) in trees[ref].items():
                if not path.startswith((*STAGING_SURFACES, "bunfig.toml", "package.json", "tsconfig")):
                    continue
                name = Path(path).name
                if (name.startswith(".env") or Path(path).suffix.lower() in {".pem", ".key", ".p12"}
                        or name in {"credentials", "secrets.json"}):
                    return False
                if path in SOAK_FIXTURES or path in {
                        ".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py"}:
                    continue
                if not ordinary_soak_doc(path) and Path(path).suffix.lower() not in STAGING_BINARY:
                    scan[path] = blob
            data = subprocess.check_output(["git", "cat-file", "--batch"],
                                           input="".join(f"{blob}\n" for blob in scan.values()).encode(),
                                           stderr=subprocess.PIPE)
            stream = io.BytesIO(data)
            for blob in scan.values():
                header = stream.readline().decode().split()
                if len(header) != 3 or header[:2] != [blob, "blob"] or not header[2].isdigit():
                    return False
                content = stream.read(int(header[2]))
                if len(content) != int(header[2]) or stream.read(1) != b"\n":
                    return False
                text = content.decode()
                if "\0" in text or any(token in text for token in SOAK_FIXTURE_TOKENS):
                    return False
            if stream.read():
                return False
        return True
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError):
        return False


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
        if set(paths) & STAGING_INPUTS and not staging_is_dormant(base, head, merge_base, paths):
            return all_gates("Staging consumer, producer state or scan failure; running all gates")
        if set(paths) & set(ACCOUNTING_HEAD) and not accounting_relocation_is_dormant(base, head, merge_base, paths):
            return all_gates("Accounting relocation, consumer or scan failure; running all gates")
        for path in paths:
            # Bun discovers tests even in documentation, metadata and standalone proof dirs.
            if path.startswith(("docs/", "npm/", *PROOFS)) and re.search(
                    r"[._](test|spec)\.[cm]?[jt]sx?$", path):
                return all_gates("Discovered Bun test changed; running all gates")
            elif path == "package.json":
                gates.update(lint=True, root=True, notices=True, test=True)
                if not package_transport_unchanged(merge_base, head):
                    return all_gates("Root package runtime, dependency or script inputs changed")
            elif path in STAGING_INPUTS or path in ACCOUNTING_HEAD:
                gates.update(dict.fromkeys((key for key in GATES if key != "relay"), True))
            elif path == CI_COVERAGE_READER:
                consumers = subprocess.run(
                    ["git", "grep", "-F", "-q", "-e", "ci-coverage-threshold", base, head, "--",
                     "packages", "tests", "scripts", ".github/workflows", ".github/actions", ".github/scripts",
                     f":(exclude){CI_COVERAGE_READER}", ":(exclude).github/scripts/ci-scope.py",
                     ":(exclude).github/scripts/check-ci-scope.py"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                )
                if consumers.returncode != 1:
                    return all_gates("Coverage reader reference or scan failure; running all gates")
                # Only this CI shell consumer skips relay; all normal gates remain selected.
                gates.update(dict.fromkeys((key for key in GATES if key != "relay"), True))
            elif path in WRAPPER_SUSPEND_INPUTS:
                # Exact real-PTY test producers retain normal gates; no relay caller is changed.
                consumers = subprocess.run(
                    ["git", "grep", "-F", "-q", "-e", "wrapper-suspend", base, head, "--",
                     "packages", "tests", "scripts", ".github/workflows", ".github/actions",
                     ".github/scripts",
                     *(f":(exclude){producer}" for producer in WRAPPER_SUSPEND_INPUTS),
                     ":(exclude).github/scripts/ci-scope.py",
                     ":(exclude).github/scripts/check-ci-scope.py"],
                    stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                )
                if consumers.returncode != 1:
                    return all_gates("Wrapper test reference or scan failure; running all gates")
                # Never clear relay already selected by a different changed execution input.
                gates.update(dict.fromkeys((key for key in GATES if key != "relay"), True))
            elif path == HOOK_SERVER_TEST:
                # Endpoint existence is insufficient when both branches independently add it.
                status = git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z",
                             merge_base, head, "--", HOOK_SERVER_TEST)
                if status != b"M\0" + HOOK_SERVER_TEST.encode() + b"\0":
                    return all_gates("Hook test is not an exact modification; running all gates")
                if not hook_test_references_reviewed(base, head):
                    return all_gates("Hook test reference, provenance or scan failure; running all gates")
                # This exact test is outside the R7 list; preserve every normal gate and prior relay.
                gates.update(dict.fromkeys((key for key in GATES if key != "relay"), True))
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
                if path.startswith("packages/web/src/lib/native-") or (
                        path.startswith("packages/web/tests/browser/") and "native-provider-harness" in path):
                    gates["macos"] = True
                if path.endswith("package.json") or "tsconfig" in path or "bunfig" in path:
                    return all_gates("Web dependency or tool configuration changed")
            elif path.startswith("packages/native/"):
                if path == NATIVE_SECURE_FIXTURE:
                    # Only the Swift integration suite consumes this exact standalone helper.
                    # A nonnative reference at either end removes the exemption, even if removed.
                    consumers = subprocess.run(
                        ["git", "grep", "-F", "-q", "-e", "secure-push-fixture", base, head, "--",
                         "packages/daemon", "packages/shared", "packages/signaling", "packages/web",
                         "packages/macos", "tests", "scripts", ".github/workflows", ".github/actions"],
                        stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    )
                    if consumers.returncode != 1:
                        return all_gates("Native fixture reference or scan failure; running all gates")
                    gates["lint"] = True
                    continue
                # Swift/Xcode acceptance is separate; JSON is still covered by root Biome.
                if not path.endswith((".swift", ".plist", ".pbxproj", ".xcscheme", ".entitlements",
                                      ".xcworkspacedata", ".xcsettings", ".json", ".png", ".md",
                                      ".resolved")):
                    return all_gates("Unknown native input; running all gates")
                gates["lint"] |= path.endswith(".json")
            elif path.startswith("packages/macos/"):
                gates.update(lint=True, root=True, web=True, integration=True, test=True, macos=True)
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
            elif path in CI_TOOLS:
                # These execute their actual classifier/YAML/actionlint controls in the scope job.
                continue
            elif path in {".github/workflows/ci.yml", ".github/workflows/relay-r7.yml"} or (
                    path in NON_RELAY_WORKFLOWS and path.endswith(".yml")):
                try:
                    compare = runpy.run_path(str(Path(__file__).with_name("workflow-scope.py")))["changed_gates"]
                    selected = compare(path, git("show", f"{merge_base}:{path}").decode(),
                                       git("show", f"{head}:{path}").decode())
                except Exception:
                    return all_gates("Workflow comparison unavailable or unknown; running all gates")
                gates.update(dict.fromkeys(selected, True))
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
        return {**gates, "relay_soak": gates["relay"] and not soak_fixture_only(base, head, merge_base, paths), "typecheck": any(gates[key] for key in
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
            for key in (*GATES, "relay_soak"):
                stream.write(f"| {key} | {'Run' if result[key] else 'Scoped skip'} |\n")


if __name__ == "__main__":
    main()
