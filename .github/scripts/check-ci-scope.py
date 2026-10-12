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
STAGING_SOURCE, STAGING_INPUTS = module["STAGING_SOURCE"], module["STAGING_INPUTS"]
STAGING_EXPORTS = module["STAGING_EXPORTS"]
STAGING_TEXT = "".join(f"export const {name} = 'owned';\n" for name in sorted(STAGING_EXPORTS))
# Actual immutable pre-relocation Git blobs remain available after adapters replace originals.
ACCOUNTING_ORIGINAL_CONTENT = {
    path: subprocess.check_output(["git", "cat-file", "blob", blob], stderr=subprocess.PIPE).decode()
    for path, blob in module["ACCOUNTING_ORIGINALS"].items()
}
ACCOUNTING_PROOF = "scripts/tunnel-storage-proof/"
ACCOUNTING_DAEMON = "packages/daemon/src/tunnel/"
ACCOUNTING_FULL_BASE = "f22bf6e360a16a8c3ae7c1ae0fe9a49eea612ab7"
ACCOUNTING_COLLISION_BLOBS = {
    "packages/native/RemiKit/Sources/RemiKit/Transport/RelayChannelBroker.swift": "41fbabaef6a051bde704610c36bf144ac8a7ca21",
    "packages/signaling/src/connection-room.ts": "da13ef5fe90c5e452eb29dc039eca1b2afbe1eb7",
    "packages/signaling/tests/e2e/limits.e2e.test.ts": "2f4e404747aac4d1409bb2882cd23731ae5f38ce",
}
ACCOUNTING_COLLISION_CONTENT = {
    path: subprocess.check_output(["git", "cat-file", "blob", blob], stderr=subprocess.PIPE).decode()
    for path, blob in ACCOUNTING_COLLISION_BLOBS.items()
}
ACCOUNTING_HEAD_CONTENT = {}
old = ACCOUNTING_ORIGINAL_CONTENT[ACCOUNTING_PROOF + "reservations.ts"]
ACCOUNTING_HEAD_CONTENT[ACCOUNTING_DAEMON + "reservations.ts"] = old.replace(
    "// #1170 standalone budget candidate.", "// #1170 internal reservation accounting.", 1
).replace("../../packages/daemon/src/storage/", "../storage/").replace(
    "from './recovery';", "from './recovery-error';", 1
)
old = ACCOUNTING_ORIGINAL_CONTENT[ACCOUNTING_PROOF + "journal-schema.ts"]
ACCOUNTING_HEAD_CONTENT[ACCOUNTING_DAEMON + "journal-schema.ts"] = old.replace(
    "// #1443 standalone journal accounting;", "// #1443/#1170 internal journal accounting;", 1
)
old = ACCOUNTING_ORIGINAL_CONTENT[ACCOUNTING_PROOF + "recovery.ts"]
error = old[old.index("export class RecoveryError"):old.index("function refuse()")]
ACCOUNTING_HEAD_CONTENT[ACCOUNTING_DAEMON + "recovery-error.ts"] = error
ACCOUNTING_HEAD_CONTENT[ACCOUNTING_PROOF + "recovery.ts"] = old.replace(error, "", 1).replace(
    "import * as fs from 'node:fs';\n", "import * as fs from 'node:fs';\n" +
    "import { RecoveryError } from '../../packages/daemon/src/tunnel/recovery-error';\n", 1
).replace("export type RecoveryOps", "export { RecoveryError };\n\nexport type RecoveryOps", 1)
ACCOUNTING_HEAD_CONTENT[ACCOUNTING_PROOF + "settlement-mutations.py"] = ACCOUNTING_ORIGINAL_CONTENT[
    ACCOUNTING_PROOF + "settlement-mutations.py"
].replace(ACCOUNTING_PROOF + "reservations.ts", ACCOUNTING_DAEMON + "reservations.ts").replace(
    ACCOUNTING_PROOF + "journal-schema.ts", ACCOUNTING_DAEMON + "journal-schema.ts"
)
ACCOUNTING_HEAD_CONTENT["scripts/tunnel-storage-proof/reservations.ts"] = """// #1170 proof adapter for the sole internal accounting implementation.
export {
  CLEANUP_BLOCKING_DEBT,
  ReservationError,
  Reservations,
} from '../../packages/daemon/src/tunnel/reservations';
"""
ACCOUNTING_HEAD_CONTENT["scripts/tunnel-storage-proof/journal-schema.ts"] = """// #1443/#1170 proof adapter; identifiers carry no transfer authority.
export {
  type JournalBinding,
  type JournalLease,
  MARKER_ALLOWANCE,
  type MarkerKind,
  type MarkerWitness,
  sameLease,
  sameWitnesses,
  validBinding,
  validWitnesses,
} from '../../packages/daemon/src/tunnel/journal-schema';
"""
ACCOUNTING_HEAD_CONTENT["packages/daemon/tests/tunnel/reservations-adoption.test.ts"] = """import { expect, test } from 'bun:test';
import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import * as proofSchema from '../../../../scripts/tunnel-storage-proof/journal-schema';
import { RecoveryError as ProofRecoveryError } from '../../../../scripts/tunnel-storage-proof/recovery';
import * as proofReservations from '../../../../scripts/tunnel-storage-proof/reservations';
import * as schema from '../../src/tunnel/journal-schema';
import { RecoveryError } from '../../src/tunnel/recovery-error';
import {
  CLEANUP_BLOCKING_DEBT,
  ReservationError,
  Reservations,
} from '../../src/tunnel/reservations';

test('proof adapters share daemon constructors and actual durable reservation accounting', () => {
  expect(proofReservations.Reservations).toBe(Reservations);
  expect(proofReservations.ReservationError).toBe(ReservationError);
  expect(proofReservations.CLEANUP_BLOCKING_DEBT).toBe(CLEANUP_BLOCKING_DEBT);
  expect(ProofRecoveryError).toBe(RecoveryError);
  expect(new ProofRecoveryError('busy')).toBeInstanceOf(RecoveryError);
  expect(new RecoveryError('unavailable')).toBeInstanceOf(ProofRecoveryError);
  expect(new ProofRecoveryError('busy').message).toBe('recovery busy');
  expect(proofSchema.MARKER_ALLOWANCE).toBe(schema.MARKER_ALLOWANCE);
  for (const name of ['sameLease', 'sameWitnesses', 'validBinding', 'validWitnesses'] as const)
    expect(proofSchema[name]).toBe(schema[name]);

  const root = fs.mkdtempSync(path.join(tmpdir(), 'remi-reservations-adoption-'));
  try {
    const home = path.join(root, 'home');
    const scratch = path.join(root, 'scratch');
    const metadata = path.join(root, 'metadata');
    fs.mkdirSync(scratch, { mode: 0o700 });
    fs.mkdirSync(metadata, { mode: 0o700 });
    const identity = (directory: string) => {
      const stat = fs.statSync(directory, { bigint: true });
      return `${stat.dev}:${stat.ino}`;
    };
    const owner = {
      device: randomBytes(32).toString('hex'),
      session: randomUUID(),
      hub: randomBytes(16).toString('hex'),
    };
    const store = Reservations.create(home);
    const lease = store.reserveJournal(owner, 1, identity(scratch), identity(metadata));
    const { id, ...binding } = lease;
    expect(schema.validBinding(binding, 'active')).toBe(true);
    expect(proofSchema.sameLease(binding, lease)).toBe(true);
    expect(id).toMatch(/^[a-f0-9]{32}$/);
    store.reserve(owner, 1);
    expect(() => store.reserve(owner, 1)).toThrow(ReservationError);
    try {
      store.reserve(owner, 1);
    } catch (error) {
      expect(error).toBeInstanceOf(proofReservations.ReservationError);
      expect((error as ReservationError).code).toBe('busy');
    }
    const reopened = new proofReservations.Reservations(home);
    expect(reopened.inspect().map((record) => record.charge)).toEqual([16384, 4096]);
    expect(fs.statSync(path.join(home, 'reservations.json')).mode & 0o777).toBe(0o600);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
"""
for accounting_path, accounting_text in ACCOUNTING_HEAD_CONTENT.items():
    accounting_blob = subprocess.check_output(["git", "hash-object", "--stdin"],
                                              input=accounting_text.encode(), stderr=subprocess.PIPE).decode().strip()
    assert accounting_blob == module["ACCOUNTING_HEAD"][accounting_path], accounting_path
# Copied approved fixture edits applied only to actual immutable original Git blobs.
SOAK_FIXTURE_EDITS = {
    "tests/integration/relay-r3-drain.test.ts": [
        (184, 184, "\n\ntype DrainPeer = {\n  ws: WebSocket;\n  channel: import('@remi/shared').relayV2.Channel;\n  receiveTail: Promise<void>;\n  ending?: Promise<void>;\n};\n\n/** Observe real wrapper enqueue and transport completion; crypto still judges BYE. */\nfunction queuedHostBye(running: Awaited<ReturnType<typeof resumed>>) {\n  const peers = (running.relay as unknown as { peers: Map<string, DrainPeer> }).peers;\n  const peer = [...peers.values()][0];\n  if (!peer) throw new Error('ready peer missing');\n  const onmessage = peer.ws.onmessage;\n  const onclose = peer.ws.onclose;\n  if (!onmessage || !onclose) throw new Error('host wrapper handler missing');\n  let queued = 0;\n  let resolve!: () => void;\n  const enqueued = new Promise<void>((done) => {\n    resolve = done;\n  });\n  let closeObserved!: () => void;\n  const closed = new Promise<void>((done) => {\n    closeObserved = done;\n  });\n  let ending: Promise<void> | undefined;\n  const observeMessage = (event: MessageEvent) => {\n    const before = peer.receiveTail;\n    onmessage.call(peer.ws, event);\n    if (event.data instanceof ArrayBuffer && peer.receiveTail !== before && ++queued === 2)\n      resolve();\n  };\n  const observeClose = (event: CloseEvent) => {\n    onclose.call(peer.ws, event);\n    ending = peer.ending;\n    if (!ending) throw new Error('actual host transport ending promise missing');\n    closeObserved();\n  };\n  peer.ws.onmessage = observeMessage;\n  peer.ws.onclose = observeClose;\n  return {\n    peer,\n    enqueued,\n    closed,\n    get ending() {\n      if (!ending) throw new Error('actual host close not observed');\n      return ending;\n    },\n    restore() {\n      if (peer.ws.onmessage === observeMessage) peer.ws.onmessage = onmessage;\n      if (peer.ws.onclose === observeClose) peer.ws.onclose = onclose;\n    },\n  };\n}"),
        (619, 619, 'let observation: ReturnType<typeof queuedHostBye> | undefined;\n  '),
        (624, 624, '\n    observation = queuedHostBye(running);'),
        (778, 778, 'await observation.enqueued;\n    '),
        (800, 800, ';\n    await observation.closed'),
        (839, 935, ''),
        (956, 958, 'observatio'),
        (960, 962, ''),
        (963, 969, 'nding'),
        (1113, 1113, '();\n    observation?.restore'),
        (1385, 1387, 'obs'),
        (1389, 1390, 'vation'),
        (1393, 1393, 'queuedHostBye'),
        (1394, 1399, ''),
        (1406, 1486, ''),
        (1487, 1523, ''),
        (1533, 1599, '{'),
        (1605, 1606, '} = observat'),
        (1607, 1610, 'o'),
        (1611, 1614, ''),
        (2306, 2306, 'await observation.enqueued;\n    '),
        (2328, 2328, ';\n    await observation.closed'),
        (2367, 2392, ''),
        (2413, 2415, 'observatio'),
        (2417, 2419, ''),
        (2420, 2426, 'nding'),
        (2603, 2603, 'observation.restore();\n    '),
    ],
    "packages/signaling/tests/e2e/push.e2e.test.ts": [
        (1707, 1707, '\n  '),
        (1753, 1753, '\n '),
        (1770, 1770, ',\n  pinPushAudience = true,\n'),
        (3507, 3509, 'pinP'),
        (3510, 3510, 'shAudienc'),
        (15877, 15877, '\n    '),
        (15928, 15928, ',\n    undefined,\n    false,\n  '),
        (17101, 17101, '\n      '),
        (17148, 17148, ',\n      undefined,\n      false,\n    '),
        (17563, 17563, '\n    '),
        (17617, 17617, ',\n    undefined,\n    false,\n  '),
        (37742, 37742, '\n    '),
        (37744, 37744, '  '),
        (37781, 37781, '  '),
        (37798, 37798, '  '),
        (37821, 37821, '  '),
        (37822, 37822, ',\n    undefined,\n    false,\n  '),
    ],
}
SOAK_ORIGINAL_CONTENT = {
    path: subprocess.check_output(["git", "cat-file", "blob", blobs[0]], stderr=subprocess.PIPE).decode()
    for path, blobs in module["SOAK_FIXTURES"].items()
}
SOAK_FINAL_CONTENT = {}
for fixture_path, fixture_edits in SOAK_FIXTURE_EDITS.items():
    fixture_text = SOAK_ORIGINAL_CONTENT[fixture_path]
    for begin, end, replacement in reversed(fixture_edits):
        fixture_text = fixture_text[:begin] + replacement + fixture_text[end:]
    fixture_blob = subprocess.check_output(["git", "hash-object", "--stdin"],
                                           input=fixture_text.encode(), stderr=subprocess.PIPE).decode().strip()
    assert fixture_blob == module["SOAK_FIXTURES"][fixture_path][1], fixture_path
    SOAK_FINAL_CONTENT[fixture_path] = fixture_text
HOOK_COMMENT_SOURCE = {path: Path(path).read_text() for path in module["HOOK_TEST_COMMENTS"]}
WORKFLOWS = {path.name: path.read_text() for path in Path(".github/workflows").glob("*.yml")}
ACTION = Path(".github/actions/ci-scope/action.yml").read_text()
WORKFLOW_TOOLS = runpy.run_path(str(SCRIPT.with_name("workflow-scope.py")))
WORKFLOW_TOOLS["validate_action"](yaml.load(ACTION, Loader=WORKFLOW_TOOLS["UniqueLoader"]))


def git(*args, input=None):
    return subprocess.check_output(["git", "-c", "core.hooksPath=/dev/null",
                                   "-c", "commit.gpgsign=false", *args],
                                  stderr=subprocess.PIPE, input=input.encode() if input is not None else None).decode().strip()


def write(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(value)


def commit():
    git("add", "-A")
    git("commit", "-qm", "scope control")
    return git("rev-parse", "HEAD")


def selected(result):
    assert isinstance(result["relay_soak"], bool), result
    assert not result["relay_soak"] or result["relay"], result
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
        # Dormant staging producers exercise actual A/M Git states with every normal gate.
        git("reset", "--hard", base); git("clean", "-fdq")
        for producer in sorted(STAGING_INPUTS):
            write(producer, STAGING_TEXT if producer == STAGING_SOURCE else "owned standalone producer\n")
        staging_base = commit()
        assert selected(classify(base, staging_base)) == WRAPPER_GATES
        count += 1
        for producer in sorted(STAGING_INPUTS):
            git("reset", "--hard", staging_base); git("clean", "-fdq")
            write(producer, Path(producer).read_text() + "// changed\n")
            assert selected(classify(staging_base, commit())) == WRAPPER_GATES, producer
            count += 1
        for directory in ("packages/daemon", "packages/shared", "packages/signaling", "packages/web",
                          "packages/macos", "packages/native", "tests", "scripts",
                          ".github/workflows", ".github/actions", ".github/scripts"):
            for context in ("old-removed", "new", "target-base-only"):
                git("reset", "--hard", staging_base); git("clean", "-fdq")
                consumer = f"{directory}/consumer.ts"
                content = "import '../shared/src/image-staging.ts';\n"
                if directory in (".github/workflows", ".github/actions"):
                    consumer = f"{directory}/consumer.yml"
                    content = f"steps:\n  - run: bun {STAGING_SOURCE}\n"
                write(consumer, content)
                consumer_base = commit()
                if context == "old-removed":
                    Path(consumer).unlink()
                elif context == "target-base-only":
                    git("reset", "--hard", staging_base)
                write(STAGING_SOURCE, STAGING_TEXT + "// changed\n")
                left = staging_base if context == "new" else consumer_base
                assert selected(classify(left, commit())) == gates, (directory, context)
                count += 1
        for token in sorted(module["STAGING_TOKENS"]):
            git("reset", "--hard", staging_base); git("clean", "-fdq")
            # Public identifiers detect aliases and literal discriminants without an import.
            write("packages/native/consumer.swift", f"let consumer = \"{token}\"\n")
            consumer_base = commit()
            write(STAGING_SOURCE, STAGING_TEXT + "// changed\n")
            assert selected(classify(consumer_base, commit())) == gates, token
            count += 1
        for context in ("old-removed", "new"):
            git("reset", "--hard", staging_base); git("clean", "-fdq")
            write("docs/PROVISIONING.md", "```sh\nbun image-staging.ts\n```\n")
            consumer_base = commit()
            if context == "old-removed":
                write("docs/PROVISIONING.md", "removed executable consumer\n")
            write(STAGING_SOURCE, STAGING_TEXT + "// changed\n")
            assert selected(classify(staging_base if context == "new" else consumer_base, commit())) == gates
            count += 1
        for runtime in ("packages/shared/src/index.ts", "packages/shared/src/protocol.ts",
                        "packages/shared/src/relay-v2/encoding.ts", "packages/signaling/wrangler.toml",
                        "scripts/unknown-runtime.py", "packages/shared/src/image-staging-neighbor.ts"):
            git("reset", "--hard", staging_base); git("clean", "-fdq")
            write(runtime, "changed runtime input\n")
            write(STAGING_SOURCE, STAGING_TEXT + "// changed\n")
            assert selected(classify(staging_base, commit())) == gates, runtime
            count += 1
        for producer in sorted(STAGING_INPUTS):
            for operation in ("delete", "rename", "symlink"):
                git("reset", "--hard", staging_base); git("clean", "-fdq")
                source = Path(producer)
                if operation == "rename":
                    Path("docs").mkdir(exist_ok=True)
                    source.rename("docs/renamed-staging.md")
                else:
                    source.unlink()
                    if operation == "symlink":
                        source.symlink_to("unknown-target")
                assert selected(classify(staging_base, commit())) == gates, (producer, operation)
                count += 1
        for path, value in (("packages/shared/src/invalid.ts", b"\xff"),
                            ("packages/shared/src/unterminated.ts", b"\x00"),
                            ("packages/shared/credentials", b"never read")):
            git("reset", "--hard", staging_base); git("clean", "-fdq")
            target = Path(path); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(value)
            consumer_base = commit()
            write(STAGING_SOURCE, STAGING_TEXT + "// changed\n")
            assert selected(classify(consumer_base, commit())) == gates, path
            count += 1
        for value in ("export {};\n", STAGING_TEXT + "export const UnknownStagingAPI = 1;\n",
                      STAGING_TEXT + "\0", STAGING_TEXT + "export { decodeImageStagingFrame as alias };\n",
                      STAGING_TEXT + "  export const HiddenStagingAPI = 1;\n"):
            git("reset", "--hard", staging_base); git("clean", "-fdq")
            write(STAGING_SOURCE, value)
            assert selected(classify(staging_base, commit())) == gates
            count += 1
        git("reset", "--hard", base); git("clean", "-fdq")
        write(STAGING_SOURCE, STAGING_TEXT)
        divergent_head = commit()
        assert selected(classify(staging_base, divergent_head)) == gates
        count += 1
        git("reset", "--hard", staging_base); git("clean", "-fdq")
        write(STAGING_SOURCE, STAGING_TEXT + "// changed\n")
        scan_head = commit()
        # An actual missing object makes the batch reader refuse, with no mocked subprocess.
        missing_tree = git("mktree", "--missing", input="100644 blob " + "f" * 40 + "\tunreadable.ts\n")
        root_tree = git("rev-parse", f"{scan_head}^{{tree}}")
        entries = subprocess.check_output(["git", "ls-tree", root_tree]).decode()
        entries = entries.replace(git("rev-parse", f"{scan_head}:scripts"), missing_tree)
        broken_tree = git("mktree", input=entries)
        broken_head = git("commit-tree", broken_tree, "-p", scan_head, "-m", "missing scan object")
        assert not module["staging_is_dormant"](staging_base, broken_head, staging_base, [STAGING_SOURCE])
        assert selected(classify(staging_base, broken_head)) == gates
        count += 1
        assert not module["staging_is_dormant"](staging_base, "f" * 40, staging_base, [STAGING_SOURCE])
        count += 1
        git("reset", "--hard", staging_base); git("clean", "-fdq")
        write("packages/native/Guide.md", "image-staging ImageStagingMessage proposed prose\n")
        Path("packages/native/icon.png").write_bytes(b"\x89PNG\r\n\x1a\n")
        write(STAGING_SOURCE, STAGING_TEXT + "// changed\n")
        assert selected(classify(staging_base, commit())) == WRAPPER_GATES
        count += 1
        # The accounting transition uses actual immutable repository bodies, not substitute producers.
        git("reset", "--hard", base); git("clean", "-fdq")
        for path, text in ACCOUNTING_ORIGINAL_CONTENT.items():
            write(path, text)
        accounting_base = commit()
        def relocate_accounting():
            for path, text in ACCOUNTING_HEAD_CONTENT.items():
                if path != module["ACCOUNTING_TEST"]:
                    write(path, text)
        relocate_accounting()
        accounting_head = commit()
        assert selected(classify(accounting_base, accounting_head)) == WRAPPER_GATES
        count += 1
        write(module["ACCOUNTING_TEST"], ACCOUNTING_HEAD_CONTENT[module["ACCOUNTING_TEST"]])
        assert selected(classify(accounting_base, commit())) == WRAPPER_GATES
        count += 1
        for directory in ("packages/daemon", "packages/shared", "packages/signaling", "packages/web",
                          "packages/macos", "packages/native", "tests", "scripts",
                          ".github/workflows", ".github/actions", ".github/scripts"):
            for context in ("old-removed", "new", "target-base-only"):
                git("reset", "--hard", accounting_base); git("clean", "-fdq")
                consumer = f"{directory}/consumer.ts"
                content = "export { Reservations as Alias } from './tunnel/reservations';\n"
                if directory in (".github/workflows", ".github/actions"):
                    consumer = f"{directory}/consumer.yml"
                    content = "steps:\n  - run: bun packages/daemon/src/tunnel/reservations.ts\n"
                write(consumer, content)
                consumer_base = commit()
                if context == "old-removed":
                    Path(consumer).unlink()
                elif context == "target-base-only":
                    git("reset", "--hard", accounting_base)
                relocate_accounting()
                left = accounting_base if context == "new" else consumer_base
                assert selected(classify(left, commit())) == gates, (directory, context)
                count += 1
        for token in sorted(module["ACCOUNTING_IDENTIFIERS"]) + [
                "./reservations", "./journal-schema", "./recovery-error",
                "scripts/tunnel-storage-proof/reservations.ts",
                "packages/daemon/src/tunnel/journal-schema.ts"]:
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            write("packages/native/consumer.swift", f'let consumer = "{token}"\n')
            consumer_base = commit()
            relocate_accounting()
            assert selected(classify(consumer_base, commit())) == gates, token
            count += 1
        for path in module["ACCOUNTING_HEAD"]:
            if path == module["ACCOUNTING_TEST"]:
                continue
            for operation in ("changed-body", "delete", "rename", "symlink"):
                git("reset", "--hard", accounting_base); git("clean", "-fdq")
                relocate_accounting()
                source = Path(path)
                if operation == "changed-body":
                    source.write_text(source.read_text() + "// unexpected body/export\n")
                elif operation == "rename":
                    source.rename("docs/unexpected-accounting.md")
                else:
                    source.unlink()
                    if operation == "symlink":
                        source.symlink_to("unknown-target")
                assert selected(classify(accounting_base, commit())) == gates, (path, operation)
                count += 1
        for path, value in (("packages/daemon/src/tunnel/reservations.ts", "export const UnexpectedAPI = 1;\n"),
                            ("packages/daemon/src/tunnel/recovery-error.ts", "export class RecoveryError {}\n"),
                            ("scripts/tunnel-storage-proof/reservations.ts", "export * from '../../packages/daemon/src/tunnel/reservations';\n"),
                            ("scripts/tunnel-storage-proof/recovery.ts", "export class RecoveryError extends Error {}\n")):
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            relocate_accounting()
            write(path, value)
            assert selected(classify(accounting_base, commit())) == gates, path
            count += 1
        for path in ("packages/shared/src/index.ts", "packages/daemon/src/cli.ts", "bun.lock",
                     "packages/signaling/wrangler.toml", "scripts/unknown-runtime.py"):
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            relocate_accounting()
            write(path, "changed runtime dependency\n")
            assert selected(classify(accounting_base, commit())) == gates, path
            count += 1
        for path, value in (("packages/shared/src/invalid.ts", b"\xff"),
                            ("scripts/invalid.py", b"\0"), ("packages/shared/credentials", b"never read")):
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            target = Path(path); target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(value)
            consumer_base = commit()
            relocate_accounting()
            assert selected(classify(consumer_base, commit())) == gates, path
            count += 1
        for path in module["ACCOUNTING_ORIGINALS"]:
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            write(path, Path(path).read_text() + "// unreviewed original or consumer\n")
            consumer_base = commit()
            relocate_accounting()
            assert selected(classify(consumer_base, commit())) == gates, path
            count += 1
        git("reset", "--hard", accounting_base); git("clean", "-fdq")
        write("packages/signaling/src/connection-room.ts", "const clientReservations = new Map();\n")
        boundary_base = commit()
        relocate_accounting()
        assert selected(classify(boundary_base, commit())) == WRAPPER_GATES
        count += 1
        assert selected(classify(accounting_head, accounting_head)) == gates
        assert not module["accounting_relocation_is_dormant"](accounting_base, "f" * 40,
                                                            accounting_base, list(module["ACCOUNTING_HEAD"]))
        count += 2
        for value in ("export {};\n", "\0", "export { Reservations as Alias } from './other';\n"):
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            relocate_accounting()
            write(module["ACCOUNTING_TEST"], value)
            assert selected(classify(accounting_base, commit())) == gates
            count += 1
        for mode in ("preexisting-test", "changed-known-head", "post-relocation-modification"):
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            if mode == "preexisting-test":
                write(module["ACCOUNTING_TEST"], ACCOUNTING_HEAD_CONTENT[module["ACCOUNTING_TEST"]])
                consumer_base = commit()
                relocate_accounting()
            elif mode == "changed-known-head":
                consumer_base = accounting_base
                relocate_accounting()
                write("scripts/tunnel-storage-proof/recovery-probe.ts", "unreviewed known consumer\n")
            else:
                consumer_base = accounting_head
                git("reset", "--hard", consumer_base)
                source = Path("packages/daemon/src/tunnel/reservations.ts")
                source.write_text(source.read_text() + "// future edit\n")
            assert selected(classify(consumer_base, commit())) == gates, mode
            count += 1
        git("reset", "--hard", accounting_head); git("clean", "-fdq")
        script_tree = git("rev-parse", f"{accounting_head}:scripts")
        script_entries = subprocess.check_output(["git", "ls-tree", script_tree]).decode()
        missing_tree = git("mktree", "--missing", input=script_entries + "100644 blob " + "f" * 40 + "\tunreadable.ts\n")
        root_entries = subprocess.check_output(["git", "ls-tree", f"{accounting_head}^{{tree}}"]
                                              ).decode().replace(script_tree, missing_tree)
        broken_tree = git("mktree", input=root_entries)
        broken_head = git("commit-tree", broken_tree, "-p", accounting_head, "-m", "unreadable scan blob")
        assert not module["accounting_relocation_is_dormant"](accounting_base, broken_head,
                                                            accounting_base, list(module["ACCOUNTING_HEAD"]))
        assert selected(classify(accounting_base, broken_head)) == gates
        count += 1
        for path, text in ACCOUNTING_COLLISION_CONTENT.items():
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            write(path, text)
            collision_base = commit()
            relocate_accounting()
            assert selected(classify(collision_base, commit())) == WRAPPER_GATES, path
            count += 1
        for syntax in ("import 'reservations';", "import('reservations')", "require('reservations')",
                       "export {} from 'reservations';", "import 'journal-schema';", "require('recovery-error')",
                       "import '../tunnel/reservations.ts';", "export * from './journal-schema';",
                       "const old = 'scripts/tunnel-storage-proof/reservations.ts';"):
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            write("scripts/real-module-consumer.ts", syntax)
            consumer_base = commit()
            relocate_accounting()
            assert selected(classify(consumer_base, commit())) == gates, syntax
            count += 1
        for text in ('const counts = { "reservations": 1 };', 'const reservations = 1;',
                     'const count = object.reservations;', '// completed reservations do not hold a slot'):
            git("reset", "--hard", accounting_base); git("clean", "-fdq")
            write("packages/signaling/ordinary-counter.ts", text)
            counter_base = commit()
            relocate_accounting()
            assert selected(classify(counter_base, commit())) == WRAPPER_GATES, text
            count += 1
        # Preserve every unrelated published repository object/mode, including real counters.
        # Only this owned temporary index/object database is changed; no future commit is needed.
        git("fetch", "--quiet", "--no-tags", str(original), ACCOUNTING_FULL_BASE)
        git("read-tree", ACCOUNTING_FULL_BASE)
        for path, text in ACCOUNTING_HEAD_CONTENT.items():
            blob = git("hash-object", "-w", "--stdin", input=text)
            mode = "100755" if path.endswith("settlement-mutations.py") else "100644"
            git("update-index", "--add", "--cacheinfo", f"{mode},{blob},{path}")
        full_tree = git("write-tree")
        full_head = git("commit-tree", full_tree, "-p", ACCOUNTING_FULL_BASE, "-m", "actual full-tree relocation")
        assert set(git("diff", "--name-only", ACCOUNTING_FULL_BASE, full_head).splitlines()) == set(ACCOUNTING_HEAD_CONTENT)
        full_result = classify(ACCOUNTING_FULL_BASE, full_head)
        assert selected(full_result) == WRAPPER_GATES, full_result
        count += 1
        # Every soak-scope case retains the complete actual published repository tree/modes.
        soak_base = ACCOUNTING_FULL_BASE
        fixture_paths = tuple(SOAK_FINAL_CONTENT)
        def soak_tree(parent, updates=(), removals=(), source=None):
            git("read-tree", source or parent)
            for path, text, mode in updates:
                data = text.encode() if isinstance(text, str) else text
                blob = subprocess.check_output(["git", "hash-object", "-w", "--stdin"],
                                               input=data, stderr=subprocess.PIPE).decode().strip()
                git("update-index", "--add", "--cacheinfo", f"{mode},{blob},{path}")
            for path in removals:
                git("update-index", "--force-remove", "--", path)
            tree = git("write-tree", "--missing-ok")
            return git("commit-tree", tree, "-p", parent, "-m", "owned full-tree soak scope")
        def fixture_updates(paths):
            return [(p, SOAK_FINAL_CONTENT[p], "100644") for p in paths]
        combinations = ((fixture_paths[0],), (fixture_paths[1],), fixture_paths)
        for changes in combinations:
            for docs in (False, True):
                updates = fixture_updates(changes)
                if docs:
                    updates.append(("docs/owned-soak-note.md", "ordinary nonexecuting prose\n", "100644"))
                head = soak_tree(soak_base, updates)
                result = classify(soak_base, head)
                assert selected(result) == gates and not result["relay_soak"], (changes, docs, result)
                assert set(git("diff", "--name-only", soak_base, head).splitlines()) == {
                    *changes, *(["docs/owned-soak-note.md"] if docs else [])}
                count += 1
        for first, second in (fixture_paths, fixture_paths[::-1]):
            left = soak_tree(soak_base, fixture_updates((first,)))
            right = soak_tree(left, fixture_updates((second,)))
            result = classify(left, right)
            assert selected(result) == gates and not result["relay_soak"]
            count += 1
        # Reviewed entry/import/launch wiring must remain current even after an upstream edit.
        for path in module["SOAK_TRACE"]:
            body = git("show", f"{soak_base}:{path}") + "\n// unreviewed upstream trace change\n"
            left = soak_tree(soak_base, [(path, body, "100644")])
            result = classify(left, soak_tree(left, fixture_updates(fixture_paths)))
            assert selected(result) == gates and result["relay_soak"], (path, result)
            count += 1
        package_text = subprocess.check_output(["git", "show", f"{soak_base}:package.json"]).decode()
        cli_text = subprocess.check_output(["git", "show", f"{soak_base}:packages/daemon/src/cli.ts"]).decode()
        previous_version = json.loads(package_text)["version"]
        next_version = "0.7.17-dev.999"
        version_package = package_text.replace(f'"version": "{previous_version}"', f'"version": "{next_version}"', 1)
        marker = f"return '{previous_version}'; // REMI_COMPILED_VERSION"
        assert cli_text.count(marker) == 2
        version_cli = cli_text.replace(marker, f"return '{next_version}'; // REMI_COMPILED_VERSION")
        version_updates = [("package.json", version_package, "100644"),
                           ("packages/daemon/src/cli.ts", version_cli, "100644")]
        version_base = soak_tree(soak_base, version_updates)
        result = classify(version_base, soak_tree(version_base, fixture_updates(fixture_paths)))
        assert selected(result) == gates and not result["relay_soak"], result
        count += 1
        for state in ("mismatched-version", "missing-marker", "other-package-field"):
            changes = list(version_updates)
            if state == "mismatched-version":
                changes[1] = ("packages/daemon/src/cli.ts", cli_text, "100644")
            elif state == "missing-marker":
                changes[1] = ("packages/daemon/src/cli.ts", version_cli.replace("// REMI_COMPILED_VERSION", "// missing marker", 1), "100644")
            else:
                changes[0] = ("package.json", version_package.replace('"private": true', '"private": false', 1), "100644")
            left = soak_tree(soak_base, changes)
            result = classify(left, soak_tree(left, fixture_updates(fixture_paths)))
            assert selected(result) == gates and result["relay_soak"], (state, result)
            count += 1
        result = classify(soak_base, soak_tree(soak_base, [*version_updates, *fixture_updates(fixture_paths)]))
        assert selected(result) == gates and result["relay_soak"], result
        count += 1
        for producer in fixture_paths:
            for state in ("body", "delete", "rename", "symlink", "executable", "addition"):
                left = soak_base
                updates = fixture_updates((producer,))
                removals = []
                if state == "body":
                    updates = [(producer, "export const changed = true;\n", "100644")]
                elif state == "delete":
                    updates = []; removals = [producer]
                elif state == "rename":
                    updates = [("docs/moved-soak-fixture.md", SOAK_FINAL_CONTENT[producer], "100644")]
                    removals = [producer]
                elif state == "symlink":
                    updates = [(producer, "unknown-target", "120000")]
                elif state == "executable":
                    updates = [(producer, SOAK_FINAL_CONTENT[producer], "100755")]
                else:
                    left = soak_tree(soak_base, removals=(producer,))
                result = classify(left, soak_tree(left, updates, removals))
                assert selected(result) == gates and result["relay_soak"], (producer, state, result)
                count += 1
        runtime = ("packages/web/tests/relay-r7-soak.test.ts", "packages/web/tests/helpers/relay-hub.ts",
                   "packages/signaling/tests/e2e/harness.ts", "packages/signaling/tests/e2e/endpoints.ts",
                   "packages/signaling/tests/e2e/test-entry.ts", "packages/daemon/src/cli.ts",
                   "packages/shared/src/protocol.ts", "bunfig.toml", "package.json", "bun.lock",
                   "docs/PROVISIONING.md", "docs/relay-r7-gates.md", "scripts/unknown-runtime.py")
        for path in runtime:
            updates = [*fixture_updates(fixture_paths), (path, "changed runtime or measurement input\n", "100644")]
            result = classify(soak_base, soak_tree(soak_base, updates))
            assert selected(result) == gates and result["relay_soak"], (path, result)
            count += 1
        for directory in ("packages/daemon", "packages/shared", "packages/signaling", "packages/web",
                          "packages/native", "packages/macos", "tests", "scripts", ".github/scripts",
                          ".github/workflows", ".github/actions"):
            for context in ("both", "new-head", "removed", "target-base-only"):
                path = f"{directory}/soak-consumer.ts"
                relative = os.path.relpath(fixture_paths[0], Path(path).parent)
                text = f"import '{relative}';\n"
                if directory in (".github/workflows", ".github/actions"):
                    path = f"{directory}/soak-consumer.yml"
                    text = f"steps:\n  - run: bun test {fixture_paths[0]}\n"
                caller = (path, text, "100644")
                left = soak_tree(soak_base, [caller]) if context != "new-head" else soak_base
                if context == "target-base-only":
                    right = soak_tree(soak_base, fixture_updates(fixture_paths))
                else:
                    updates = fixture_updates(fixture_paths)
                    if context == "new-head":
                        updates.append(caller)
                    right = soak_tree(left, updates, (path,) if context == "removed" else ())
                result = classify(left, right)
                assert selected(result) == gates and result["relay_soak"], (directory, context, result)
                count += 1
        for path, data, mode in (("packages/shared/src/invalid.ts", b"\xff", "100644"),
                                 ("scripts/invalid.py", b"\0", "100644"),
                                 ("packages/shared/credentials", b"never read", "100644"),
                                 ("packages/shared/alias", b"unavailable", "120000")):
            left = soak_tree(soak_base, [(path, data, mode)])
            right = soak_tree(left, fixture_updates(fixture_paths))
            result = classify(left, right)
            assert selected(result) == gates and result["relay_soak"], (path, result)
            count += 1
        git("read-tree", soak_base)
        git("update-index", "--add", "--cacheinfo", "100644," + "f" * 40 + ",scripts/unreadable.ts")
        missing_tree = git("write-tree", "--missing-ok")
        missing_base = git("commit-tree", missing_tree, "-p", soak_base, "-m", "missing scan object")
        result = classify(missing_base, soak_tree(missing_base, fixture_updates(fixture_paths)))
        assert selected(result) == gates and result["relay_soak"]
        count += 1
        assert not module["soak_fixture_only"](soak_base, "f" * 40, soak_base, list(fixture_paths))
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
        # Both endpoints can have a blob while the actual merge-base diff is an addition.
        git("reset", "--hard", base)
        git("clean", "-fdq")
        Path(HOOK_SERVER_TEST).unlink()
        absent_ancestor = commit()
        write(HOOK_SERVER_TEST, "export const target = true;")
        target_base = commit()
        git("reset", "--hard", absent_ancestor)
        write(HOOK_SERVER_TEST, "export const head = true;")
        divergent_head = commit()
        assert git("merge-base", target_base, divergent_head) == absent_ancestor
        assert module["hook_test_references_reviewed"](target_base, divergent_head)
        status = subprocess.check_output(["git", "diff", "--no-ext-diff", "--no-renames",
                                          "--name-status", "-z", absent_ancestor, divergent_head,
                                          "--", HOOK_SERVER_TEST])
        assert status == b"A\0" + HOOK_SERVER_TEST.encode() + b"\0"
        result = classify(target_base, divergent_head)
        assert selected(result) == gates, ("divergent-producer-addition", result)
        count += 1
        for direction in ("regular-to-symlink", "symlink-to-regular"):
            git("reset", "--hard", base)
            git("clean", "-fdq")
            Path(HOOK_SERVER_TEST).unlink()
            Path(HOOK_SERVER_TEST).symlink_to("fixtures/build-hook-corpus.ts")
            link_head = commit()
            if direction == "regular-to-symlink":
                left, right = base, link_head
            else:
                Path(HOOK_SERVER_TEST).unlink()
                write(HOOK_SERVER_TEST, "export const changed = true;")
                left, right = link_head, commit()
            status = subprocess.check_output(["git", "diff", "--no-ext-diff", "--no-renames",
                                              "--name-status", "-z", left, right, "--", HOOK_SERVER_TEST])
            assert status == b"T\0" + HOOK_SERVER_TEST.encode() + b"\0"
            result = classify(left, right)
            assert selected(result) == gates and result["reason"].startswith("Hook test is not"), result
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
        routing_refusal("relay-r7.yml", lambda w: w["jobs"]["scope"]["outputs"].pop("relay_soak"))
        routing_refusal("relay-r7.yml", lambda w: next(s for s in w["jobs"]["local-relay"]["steps"]
                        if s.get("name") == "Same attached session for 61 actual minutes").update(
                        **{"if": "needs.scope.result == 'success' && needs.scope.outputs.relay != 'false'"}))
        routing_refusal("relay-r7.yml", lambda w: next(s for s in w["jobs"]["local-relay"]["steps"]
                        if s.get("name") == "Existing actual wire and authority controls").update(
                        **{"if": "needs.scope.result == 'success' && needs.scope.outputs.relay_soak != 'false'"}))
        routing_refusal("relay-r7.yml", lambda w: w["jobs"]["local-relay"].update(
                        steps=[s for s in w["jobs"]["local-relay"]["steps"] if s.get("name") != "Report scoped soak skip"]))
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
        for state in ("missing-soak-output", "missing-soak-env", "aliased-soak-output"):
            action = yaml.load(ACTION, Loader=WORKFLOW_TOOLS["UniqueLoader"])
            if state == "missing-soak-output":
                action["outputs"].pop("relay_soak")
            elif state == "missing-soak-env":
                action["runs"]["steps"][-1]["env"].pop("CI_SCOPE_RELAY_SOAK")
            else:
                action["outputs"]["relay_soak"]["value"] = "${{ steps.scope.outputs.relay }}"
            try:
                WORKFLOW_TOOLS["validate_action"](action)
            except AssertionError:
                count += 1
            else:
                raise AssertionError("scope action accepted invalid soak output wiring")
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
        # Exercise the real mandatory-output subprocess for the additive soak field.
        for state, expected in (("short-only", 0), ("full-relay", 0), ("missing-soak", 1),
                                ("blank-soak", 1), ("invalid-soak", 1), ("inconsistent", 1)):
            env = {key: value for key, value in os.environ.items() if not key.startswith("CI_SCOPE_")}
            env.update({f"CI_SCOPE_{key.upper()}": "false" for key in outputs})
            env["CI_SCOPE_RELAY"] = "true"
            env["CI_SCOPE_RELAY_SOAK"] = "true" if state in {"full-relay", "inconsistent"} else "false"
            if state == "missing-soak":
                env.pop("CI_SCOPE_RELAY_SOAK")
            elif state == "blank-soak":
                env["CI_SCOPE_RELAY_SOAK"] = ""
            elif state == "invalid-soak":
                env["CI_SCOPE_RELAY_SOAK"] = "False"
            elif state == "inconsistent":
                env["CI_SCOPE_RELAY"] = "false"
            result = subprocess.run([sys.executable, str(SCRIPT.with_name("check-scope-output.py"))],
                                    env=env, capture_output=True, text=True, check=False)
            assert (result.returncode == 0) == (expected == 0), (state, result)
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
            assert selected(result) == gates and result["relay_soak"]
            count += 1
        print(json.dumps({"controls": count, "passed": count, "failed": 0,
                          "scope": "owned real git diffs and event inputs"}))
    finally:
        os.chdir(original)
        os.environ.update(inherited_git)
