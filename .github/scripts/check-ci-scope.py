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

# Exact auth-completion test-slice transformation, derived from its published original.
SOAK_AUTH_PATH = "packages/daemon/tests/connection-auth.test.ts"
auth_original = SOAK_ORIGINAL_CONTENT[SOAK_AUTH_PATH]
auth_start = auth_original.index("    test('two different authenticated clients")
auth_end = auth_original.index("    test('a forged clientFingerprint", auth_start)
auth_slice = auth_original[auth_start:auth_end]
for client in ("A", "B"):
    before = f"      const conn{client} = new Connection(ws{client} as unknown as WebSocket, {{}}, {{ authenticator }});"
    after = f"""      const authenticated{client} = Promise.withResolvers<void>();
      const conn{client} = new Connection(
        ws{client} as unknown as WebSocket,
        {{
          onAuthSuccess: () => authenticated{client}.resolve(),
          onAuthFailed: (error) => authenticated{client}.reject(new Error(error)),
        }},
        {{ authenticator }},
      );"""
    assert auth_slice.count(before) == 1
    auth_slice = auth_slice.replace(before, after, 1)
    wait = "      await new Promise((r) => setTimeout(r, 100));"
    assert wait in auth_slice
    auth_slice = auth_slice.replace(wait, f"      await authenticated{client}.promise;", 1)
auth_final = auth_original[:auth_start] + auth_slice + auth_original[auth_end:]
auth_blob = subprocess.check_output(["git", "hash-object", "--stdin"], input=auth_final.encode(), stderr=subprocess.PIPE).decode().strip()
assert auth_blob == module["SOAK_FIXTURES"][SOAK_AUTH_PATH][1]
SOAK_FINAL_CONTENT[SOAK_AUTH_PATH] = auth_final

# #1480 adds only the first valid-auth test's existing success/error readiness.
readiness_start = auth_final.index("    test('transitions to connecting after valid auth_response'")
readiness_end = auth_final.index("    test('full handshake: auth -> hello -> connected'", readiness_start)
readiness_slice = auth_final[readiness_start:readiness_end]
for before, after in (
        ("      let authSuccess = false;\n", "      let authSuccess = false;\n      const authenticated = Promise.withResolvers<void>();\n"),
        ("            authSuccess = true;\n", "            authSuccess = true;\n            authenticated.resolve();\n"),
        ("          },\n        },\n        { authenticator },", "          },\n          onAuthFailed: (error) => authenticated.reject(new Error(error)),\n        },\n        { authenticator },"),
        ("      // Wait for async auth processing\n      await new Promise((r) => setTimeout(r, 100));",
         "      // Wait for the actual auth outcome, within the existing test deadline.\n      await authenticated.promise;")):
    assert readiness_slice.count(before) == 1, before
    readiness_slice = readiness_slice.replace(before, after, 1)
AUTH_READINESS_CONTENT = auth_final[:readiness_start] + readiness_slice + auth_final[readiness_end:]
readiness_blob = subprocess.check_output(["git", "hash-object", "--stdin"], input=AUTH_READINESS_CONTENT.encode(),
                                       stderr=subprocess.PIPE).decode().strip()
assert readiness_blob == module["SOAK_AUTH_READINESS"][1]
AUTH_READINESS_CI_ORIGINAL_CONTENT = {
    path: subprocess.check_output(["git", "cat-file", "blob", blob], stderr=subprocess.PIPE)
    for path, blob in module["SOAK_AUTH_READINESS_CI_ORIGINALS"].items()
}
# These are the reviewed executing inputs; reading them does not establish their trust.
# CI changes still require the full validation commands before publication.
AUTH_READINESS_CI_FINAL_CONTENT = {
    path: (SCRIPT.parents[2] / path).read_bytes() for path in module["SOAK_AUTH_READINESS_CI_ORIGINALS"]
}

# New candidate bytes are reconstructed from published originals, never unpublished commit objects.
COLD_FULL_BASE = "a0f0c8502a518aa41ef48145eef3b0cd87a1e593"
COLD_PROOF = "scripts/tunnel-storage-proof/"
COLD_DAEMON = "packages/daemon/src/tunnel/"
COLD_ORIGINAL_CONTENT = {
    path: subprocess.check_output(["git", "cat-file", "blob", pin[1]], stderr=subprocess.PIPE).decode()
    for policy in module["COLD_RELOCATIONS"].values() for path, pin in policy["original"].items()
    if (path not in module["COLD_RELOCATIONS"]["descriptor"]["head"] or path in module["COLD_RELOCATIONS"]["descriptor"]["original"])
    and path not in module["COLD_IMAGE_BINARY"]
}
COLD_CONTENT = {"descriptor": {}, "journal": {}, "native-helper": {}, "image-admission": {}}
COLD_CONTENT['descriptor']['scripts/tunnel-storage-proof/admission.ts'] = "// #1170 proof adapter: the daemon owns the sole descriptor implementation.\nexport {\n  AdmittedFile,\n  DirectoryRoot,\n  FileAdmission,\n  type OpenAt,\n} from '../../packages/daemon/src/tunnel/admission';\n"
COLD_CONTENT['descriptor']['packages/daemon/tests/tunnel/descriptors-adoption.test.ts'] = '/// <reference path="../../../../scripts/tunnel-storage-proof/assets.d.ts" />\nimport { expect, test } from \'bun:test\';\nimport * as fs from \'node:fs\';\nimport { tmpdir } from \'node:os\';\nimport * as path from \'node:path\';\nimport * as proofAdmission from \'../../../../scripts/tunnel-storage-proof/admission\';\nimport type { PrivateOps as ProofPrivateOps } from \'../../../../scripts/tunnel-storage-proof/private-copy\';\nimport { recoveryNative } from \'../../../../scripts/tunnel-storage-proof/recovery-native\';\nimport { AdmittedFile, DirectoryRoot, FileAdmission } from \'../../src/tunnel/admission\';\nimport type { PrivateOps } from \'../../src/tunnel/private-ops\';\n\ntest(\'proof descriptor adapters share daemon classes and capture a real owned root\', async () => {\n  expect(proofAdmission.DirectoryRoot).toBe(DirectoryRoot);\n  expect(proofAdmission.AdmittedFile).toBe(AdmittedFile);\n  expect(proofAdmission.FileAdmission).toBe(FileAdmission);\n  const native = await recoveryNative();\n  const proofOps: ProofPrivateOps = native.ops;\n  const ops: PrivateOps = proofOps;\n  const directory = fs.mkdtempSync(path.join(tmpdir(), \'remi-descriptors-adoption-\'));\n  fs.chmodSync(directory, 0o700);\n  let root: DirectoryRoot | null = null;\n  try {\n    root = proofAdmission.DirectoryRoot.capture(directory, ops.openAt.bind(ops));\n    expect(root).toBeInstanceOf(DirectoryRoot);\n    if (!root) throw new Error(\'actual owned root capture failed\');\n    const stat = fs.fstatSync(root.fd, { bigint: true });\n    const named = fs.statSync(directory, { bigint: true });\n    expect(stat.isDirectory()).toBe(true);\n    expect(stat.dev).toBe(named.dev);\n    expect(stat.ino).toBe(named.ino);\n    expect(root.identity).toBe(`${stat.dev}:${stat.ino}`);\n    expect(root.contains(new Set([root.identity]))).toBe(true);\n    expect(root.active).toBe(true);\n    expect(root.isCurrent()).toBe(true);\n    const fd = root.fd;\n    root.close();\n    expect(root.active).toBe(false);\n    expect(root.isCurrent()).toBe(false);\n    expect(() => fs.fstatSync(fd)).toThrow();\n    root.close();\n  } finally {\n    root?.close();\n    native.close();\n    fs.rmSync(directory, { recursive: true, force: true });\n  }\n});\n'
COLD_CONTENT['journal']['scripts/tunnel-storage-proof/recovery.ts'] = "// #1170 proof adapter: the daemon owns the sole journal implementation.\nexport {\n  RecoveryError,\n  RecoveryIntent,\n  type RecoveryOps,\n  type RecoveryStage,\n  allocatedBlocks,\n} from '../../packages/daemon/src/tunnel/recovery';\n"
COLD_CONTENT['journal']['scripts/tunnel-storage-proof/journal-settlement.ts'] = "// #1170 proof adapter: the daemon owns the sole settlement implementation.\nexport {\n  type JournalWriter,\n  SETTLEMENT_STAGES,\n  type SettlementStage,\n  beginJournal,\n  settleJournal,\n} from '../../packages/daemon/src/tunnel/journal-settlement';\n"
COLD_CONTENT['journal']['packages/daemon/tests/tunnel/journal-adoption.test.ts'] = '/// <reference path="../../../../scripts/tunnel-storage-proof/assets.d.ts" />\nimport { expect, test } from \'bun:test\';\nimport { randomBytes, randomUUID } from \'node:crypto\';\nimport * as fs from \'node:fs\';\nimport { tmpdir } from \'node:os\';\nimport * as path from \'node:path\';\nimport * as proofJournal from \'../../../../scripts/tunnel-storage-proof/journal-settlement\';\nimport * as proofRecovery from \'../../../../scripts/tunnel-storage-proof/recovery\';\nimport { recoveryNative } from \'../../../../scripts/tunnel-storage-proof/recovery-native\';\nimport { DirectoryRoot } from \'../../src/tunnel/admission\';\nimport {\n  SETTLEMENT_STAGES,\n  beginJournal,\n  settleJournal,\n} from \'../../src/tunnel/journal-settlement\';\nimport { RecoveryError, RecoveryIntent, allocatedBlocks } from \'../../src/tunnel/recovery\';\nimport { Reservations } from \'../../src/tunnel/reservations\';\n\ntest(\'proof journal adapters share daemon functions and settle an actual private journal\', async () => {\n  expect(proofJournal.beginJournal).toBe(beginJournal);\n  expect(proofJournal.settleJournal).toBe(settleJournal);\n  expect(proofJournal.SETTLEMENT_STAGES).toBe(SETTLEMENT_STAGES);\n  expect(proofRecovery.RecoveryIntent).toBe(RecoveryIntent);\n  expect(proofRecovery.allocatedBlocks).toBe(allocatedBlocks);\n  expect(proofRecovery.RecoveryError).toBe(RecoveryError);\n  expect(new proofRecovery.RecoveryError(\'busy\')).toBeInstanceOf(RecoveryError);\n  expect(new RecoveryError(\'unavailable\')).toBeInstanceOf(proofRecovery.RecoveryError);\n  const bytes = fs.readFileSync(\n    path.resolve(import.meta.dir, \'../../../../scripts/tunnel-decoder-proof/fixture.png\'),\n  );\n  const native = await recoveryNative();\n  const home = fs.mkdtempSync(path.join(tmpdir(), \'remi-journal-adoption-\'));\n  fs.chmodSync(home, 0o700);\n  let scratch: DirectoryRoot | null = null;\n  let metadata: DirectoryRoot | null = null;\n  try {\n    const scratchPath = path.join(home, \'scratch\');\n    const metadataPath = path.join(home, \'metadata\');\n    fs.mkdirSync(scratchPath, { mode: 0o700 });\n    fs.mkdirSync(metadataPath, { mode: 0o700 });\n    scratch = DirectoryRoot.capture(scratchPath, native.ops.openAt.bind(native.ops));\n    metadata = DirectoryRoot.capture(metadataPath, native.ops.openAt.bind(native.ops));\n    expect(scratch).toBeInstanceOf(DirectoryRoot);\n    expect(metadata).toBeInstanceOf(DirectoryRoot);\n    if (!scratch || !metadata) throw new Error(\'actual journal root capture failed\');\n    const store = Reservations.create(path.join(home, \'ledger\'));\n    const writer = proofJournal.beginJournal(\n      store,\n      {\n        device: randomBytes(32).toString(\'hex\'),\n        session: randomUUID(),\n        hub: randomBytes(16).toString(\'hex\'),\n      },\n      bytes.length,\n      scratch,\n      metadata,\n      native.ops,\n    );\n    writer.write(bytes.subarray(0, 32));\n    writer.write(bytes.subarray(32));\n    writer.close();\n    expect(fs.readFileSync(path.join(scratchPath, `${writer.lease.id}.artifact`))).toEqual(bytes);\n    expect(store.inspect()[0]?.state).toBe(\'active\');\n    expect(store.inspect()[0]?.charge).toBeGreaterThanOrEqual(bytes.length);\n    const intent = proofRecovery.RecoveryIntent.open(\n      scratch,\n      metadata,\n      writer.lease.id,\n      native.ops,\n    );\n    try {\n      expect(intent.cleanup()).toBe(\'cleaned\');\n      expect(intent.snapshot([\'intent\', \'owned\', \'cleaned\'])).toHaveLength(3);\n    } finally {\n      intent.close();\n    }\n    expect(proofJournal.settleJournal(store, writer.lease, scratch, metadata, native.ops)).toBe(\n      \'settled\',\n    );\n    expect(fs.readdirSync(scratchPath)).toEqual([]);\n    expect(fs.readdirSync(metadataPath)).toEqual([]);\n    expect(store.inspect()[0]?.state).toBe(\'settled\');\n    expect(store.inspect()[0]?.charge).toBe(0);\n    expect(settleJournal(store, writer.lease, scratch, metadata, native.ops)).toBe(\n      \'already_settled\',\n    );\n  } finally {\n    scratch?.close();\n    metadata?.close();\n    native.close();\n    fs.rmSync(home, { recursive: true, force: true });\n  }\n});\n'
a_content, b_content = COLD_CONTENT["descriptor"], COLD_CONTENT["journal"]
old = COLD_ORIGINAL_CONTENT[COLD_PROOF + "admission.ts"]
a_content[COLD_DAEMON + "admission.ts"] = old.replace(
    "// #1170 candidate only: real descriptors, no transfer authority or production caller.",
    "// #1170 internal descriptors; no transfer authority or runtime caller.", 1)
old = COLD_ORIGINAL_CONTENT[COLD_PROOF + "private-copy.ts"]
private_ops = old[old.index("export type PrivateOps"):old.index("export type CopyCheckpoint")]
a_content[COLD_DAEMON + "private-ops.ts"] = "import type { OpenAt } from './admission';\n\n" + private_ops
a_content[COLD_PROOF + "private-copy.ts"] = old.replace(private_ops, "export type { PrivateOps } from '../../packages/daemon/src/tunnel/private-ops';\n", 1).replace(
    "import type { AdmittedFile, DirectoryRoot, OpenAt } from './admission';",
    "import type { PrivateOps } from '../../packages/daemon/src/tunnel/private-ops';\nimport type { AdmittedFile, DirectoryRoot, OpenAt } from './admission';", 1)
old = COLD_ORIGINAL_CONTENT[COLD_PROOF + "recovery.ts"]
b_content[COLD_DAEMON + "recovery.ts"] = old.replace(
    "// #1440/#1443/#1170 standalone immutable ownership journal; no transfer authority.",
    "// #1170 internal immutable ownership journal; no transfer authority or runtime caller.", 1).replace(
    "import { RecoveryError } from '../../packages/daemon/src/tunnel/recovery-error';\n", "", 1).replace(
    "import type { PrivateOps } from './private-copy';",
    "import type { PrivateOps } from './private-ops';\nimport { RecoveryError } from './recovery-error';", 1)
b_content[COLD_DAEMON + "journal-settlement.ts"] = COLD_ORIGINAL_CONTENT[COLD_PROOF + "journal-settlement.ts"].replace(
    "// #1443/#1170 standalone composition; no shipping caller or transfer authority.",
    "// #1170 internal journal composition; no transfer authority or runtime caller.", 1)
for mutation in ("recovery-mutations.py", "settlement-mutations.py"):
    text = COLD_ORIGINAL_CONTENT[COLD_PROOF + mutation]
    names = ("recovery.ts",) if mutation == "recovery-mutations.py" else ("journal-settlement.ts",)
    for name in names:
        text = text.replace(COLD_PROOF + name, COLD_DAEMON + name)
    b_content[COLD_PROOF + mutation] = text
# Exact helper/C/declaration bytes derive only from published originals.
NATIVE_FULL_BASE = "b9c2e49a0a5e02186737c041551f5548147b9938"
NATIVE_REMOVED_C = COLD_PROOF + "recovery-native.c"
NATIVE_CONTENT = COLD_CONTENT["native-helper"]
NATIVE_CONTENT[COLD_DAEMON + "recovery-native.ts"] = (
    '/// <reference path="./native-assets.d.ts" />\n'
    '// #1170 internal explicit native journal helper; no startup or active transfer caller.\n'
    + COLD_ORIGINAL_CONTENT[COLD_PROOF + "recovery-native.ts"]
)
NATIVE_CONTENT[COLD_DAEMON + "recovery-native.c"] = COLD_ORIGINAL_CONTENT[NATIVE_REMOVED_C]
original_assets = COLD_ORIGINAL_CONTENT[COLD_PROOF + "assets.d.ts"]
asset_boundary = original_assets.index("declare module '*.png'")
NATIVE_CONTENT[COLD_DAEMON + "native-assets.d.ts"] = original_assets[:asset_boundary]
NATIVE_CONTENT[COLD_PROOF + "assets.d.ts"] = (
    '/// <reference path="../../packages/daemon/src/tunnel/native-assets.d.ts" />\n'
    + original_assets[asset_boundary:]
)
NATIVE_CONTENT[COLD_PROOF + "recovery-native.ts"] = "// #1170 proof adapter for the explicit daemon-owned native journal factory.\nexport { recoveryNative } from '../../packages/daemon/src/tunnel/recovery-native';\n"
NATIVE_CONTENT["packages/daemon/tests/tunnel/native-helper-adoption.test.ts"] = "import { expect, test } from 'bun:test';\nimport * as fs from 'node:fs';\nimport { constants, tmpdir } from 'node:os';\nimport * as path from 'node:path';\nimport { recoveryNative as proofRecoveryNative } from '../../../../scripts/tunnel-storage-proof/recovery-native';\nimport { DirectoryRoot } from '../../src/tunnel/admission';\nimport { recoveryNative } from '../../src/tunnel/recovery-native';\n\ntest('proof native helper shares the daemon factory and owns real descriptors and locks', async () => {\n  expect(proofRecoveryNative).toBe(recoveryNative);\n  const bytes = fs.readFileSync(\n    path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof/fixture.png'),\n  );\n  const native = await recoveryNative();\n  const opened = new Set<number>();\n  let directory: string | undefined;\n  let root: DirectoryRoot | null = null;\n  const closeFile = (fd: number) => {\n    fs.closeSync(fd);\n    opened.delete(fd);\n  };\n  try {\n    directory = fs.mkdtempSync(path.join(tmpdir(), 'remi-native-helper-adoption-'));\n    fs.chmodSync(directory, 0o700);\n    root = DirectoryRoot.capture(directory, native.ops.openAt.bind(native.ops));\n    expect(root).toBeInstanceOf(DirectoryRoot);\n    if (!root) throw new Error('actual native helper root capture failed');\n    const directoryFD = root.fd;\n    expect(fs.fstatSync(directoryFD).isDirectory()).toBe(true);\n    const directoryFlags = native.cloexec(directoryFD);\n    expect(directoryFlags).toBeGreaterThanOrEqual(0);\n    expect(directoryFlags & 1).toBe(1);\n    const flags = fs.constants.O_RDWR | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;\n    expect(native.ops.openAt(directoryFD, 'missing.png', flags)).toBe(-constants.errno.ENOENT);\n    expect(native.ops.unlink(directoryFD, 'missing.png')).toBe(-constants.errno.ENOENT);\n    const first = native.ops.create(\n      directoryFD,\n      'owned.png',\n      flags | fs.constants.O_CREAT | fs.constants.O_EXCL,\n      0o600,\n    );\n    expect(first).toBeGreaterThanOrEqual(0);\n    if (first < 0) throw new Error('actual owned file creation failed');\n    opened.add(first);\n    fs.writeFileSync(first, bytes);\n    fs.fsyncSync(first);\n    const firstStat = fs.fstatSync(first, { bigint: true });\n    expect(firstStat.isFile()).toBe(true);\n    expect(Number(firstStat.mode & 0o777n)).toBe(0o600);\n    const firstFlags = native.cloexec(first);\n    expect(firstFlags).toBeGreaterThanOrEqual(0);\n    expect(firstFlags & 1).toBe(1);\n    const second = native.ops.openAt(directoryFD, 'owned.png', flags);\n    expect(second).toBeGreaterThanOrEqual(0);\n    if (second < 0) throw new Error('actual owned file reopen failed');\n    opened.add(second);\n    const secondStat = fs.fstatSync(second, { bigint: true });\n    expect(secondStat.dev).toBe(firstStat.dev);\n    expect(secondStat.ino).toBe(firstStat.ino);\n    const secondFlags = native.cloexec(second);\n    expect(secondFlags).toBeGreaterThanOrEqual(0);\n    expect(secondFlags & 1).toBe(1);\n    expect(fs.readFileSync(second)).toEqual(bytes);\n    expect(native.ops.lock(first)).toBe(0);\n    expect(native.ops.lock(second)).toBe(-constants.errno.EWOULDBLOCK);\n    closeFile(first);\n    expect(native.ops.lock(second)).toBe(0);\n    closeFile(second);\n    expect(() => native.ops.link(directoryFD, 'owned.png', 'alias.png')).toThrow(\n      'recovery link unsupported',\n    );\n    expect(native.ops.unlink(directoryFD, 'owned.png')).toBe(0);\n    expect(native.ops.unlink(directoryFD, 'owned.png')).toBe(-constants.errno.ENOENT);\n    expect(fs.readdirSync(directory)).toEqual([]);\n  } finally {\n    try {\n      for (const fd of opened) fs.closeSync(fd);\n    } finally {\n      try {\n        root?.close();\n      } finally {\n        try {\n          native.close();\n        } finally {\n          if (directory) fs.rmSync(directory, { recursive: true, force: true });\n        }\n      }\n    }\n  }\n});\n"
IMAGE_FULL_BASE = "c1c71ef456d075bd11c6bc01d4648fe6ee24169d"
IMAGE_PROOF = "scripts/tunnel-decoder-proof/"
IMAGE_DAEMON = "packages/daemon/src/tunnel/image-admission.ts"
IMAGE_CONTENT = COLD_CONTENT["image-admission"]
image_body = COLD_ORIGINAL_CONTENT[IMAGE_PROOF + "admission.ts"]
IMAGE_CASTS = (
    ("bitDepth = bytes[offset + 16];", "bitDepth = bytes[offset + 16] as number;", 1),
    ("colorType = bytes[offset + 17];", "colorType = bytes[offset + 17] as number;", 1),
    ("const next = bytes[offset + 1];", "const next = bytes[offset + 1] as number;", 1),
    ("const marker = bytes[offset++];", "const marker = bytes[offset++] as number;", 1),
    ("componentCount = bytes[payload + 5];", "componentCount = bytes[payload + 5] as number;", 1),
    ("const id = bytes[start];", "const id = bytes[start] as number;", 1),
    ("const horizontal = bytes[start + 1] >> 4;", "const horizontal = (bytes[start + 1] as number) >> 4;", 1),
    ("const vertical = bytes[start + 1] & 15;", "const vertical = (bytes[start + 1] as number) & 15;", 1),
    ("bytes[start + 2] > 3", "(bytes[start + 2] as number) > 3", 1),
    ("const components = bytes[payload];", "const components = bytes[payload] as number;", 1),
    ("const spec = bytes[offset++];", "const spec = bytes[offset++] as number;", 2),
    ("const count = bytes[offset++];", "const count = bytes[offset++] as number;", 1),
)
assert sum(count for _, _, count in IMAGE_CASTS) == 13
for before, after, count in IMAGE_CASTS:
    assert image_body.count(before) == count, (before, count)
    image_body = image_body.replace(before, after)
IMAGE_CONTENT[IMAGE_DAEMON] = (
    "// #1170 internal image header admission; no active transfer caller or full pixel validation.\n" + image_body
)
image_matrix = COLD_ORIGINAL_CONTENT[IMAGE_PROOF + "matrix.py"]
for before, after in (
        ("ROOT = Path(__file__).resolve().parent\n", "ROOT = Path(__file__).resolve().parent\nREPO = ROOT.parents[1]\n"),
        ('inputs = json.loads((ROOT / "inputs.json").read_text())\n', 'inputs = json.loads((ROOT / "inputs.json").read_text())\nsnapshot_scripts = "scripts/tunnel-decoder-proof"\n'),
        ("def proof_for(source=ROOT):", "def proof_for(source=REPO):")):
    assert image_matrix.count(before) == 1
    image_matrix = image_matrix.replace(before, after, 1)
old_files = image_matrix[image_matrix.index('        "files": ('):image_matrix.index('        "checks": CHECKS,')]
new_files = '''        "files": (
            "tsconfig.json",
            "package.json",
            "bun.lock",
            "bunfig.toml",
            "scripts/tunnel-storage-proof/matrix.py",
            "scripts/tunnel-storage-proof/storage-approval-mutations.py",
        ),
        "source_trees": (
            "packages/daemon/src",
            "packages/shared/src",
            snapshot_scripts,
        ),
        "source_tree_excludes": (snapshot_scripts + "/node_modules",),
        "entry": snapshot_scripts + "/probe.ts",
        "compile_from_snapshot": True,
'''
image_matrix = image_matrix.replace(old_files, new_files, 1)
IMAGE_CONTENT[IMAGE_PROOF + "matrix.py"] = image_matrix
IMAGE_CONTENT[IMAGE_PROOF + "admission.ts"] = "// #1170 proof adapter for the daemon-owned image header admission.\nexport { MAX_INPUT_BYTES, admitImage } from '../../packages/daemon/src/tunnel/image-admission';\nexport type { Dimensions } from '../../packages/daemon/src/tunnel/image-admission';\n"
IMAGE_CONTENT["packages/daemon/tests/tunnel/image-admission-adoption.test.ts"] = "import { expect, test } from 'bun:test';\nimport * as fs from 'node:fs';\nimport * as path from 'node:path';\nimport * as proofAdmission from '../../../../scripts/tunnel-decoder-proof/admission';\nimport type { Dimensions as ProofDimensions } from '../../../../scripts/tunnel-decoder-proof/admission';\nimport inputs from '../../../../scripts/tunnel-decoder-proof/inputs.json';\nimport { MAX_INPUT_BYTES, admitImage } from '../../src/tunnel/image-admission';\nimport type { Dimensions } from '../../src/tunnel/image-admission';\n\nconst fixture = (name: string) =>\n  fs.readFileSync(path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof', name));\n\ntest('proof image admission shares daemon exports and admits the owned PNG and JPEG headers', () => {\n  expect(proofAdmission.admitImage).toBe(admitImage);\n  expect(proofAdmission.MAX_INPUT_BYTES).toBe(MAX_INPUT_BYTES);\n  expect(MAX_INPUT_BYTES).toBe(10 * 1024 * 1024);\n  for (const [index, mediaType] of (['image/png', 'image/jpeg'] as const).entries()) {\n    const expected = inputs.images[index];\n    if (!expected) throw new Error('owned image fixture metadata missing');\n    const bytes = fixture(expected.filename);\n    expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(expected.inputSha256);\n    const dimensions: Dimensions = admitImage(bytes, mediaType);\n    const proofDimensions: ProofDimensions = proofAdmission.admitImage(bytes, mediaType);\n    expect(dimensions).toEqual({ width: expected.width, height: expected.height });\n    expect(proofDimensions).toEqual(dimensions);\n    expect(Object.isFrozen(dimensions)).toBe(true);\n  }\n});\n\ntest('owned image admission retains input size and format refusals', () => {\n  const png = fixture('fixture.png');\n  const jpeg = fixture('fixture.jpg');\n  for (const mediaType of ['image/png', 'image/jpeg'] as const) {\n    expect(() => admitImage(png.subarray(0, 0), mediaType)).toThrow('IMAGE_ADMISSION_REFUSED');\n    expect(() => admitImage(Buffer.alloc(MAX_INPUT_BYTES + 1), mediaType)).toThrow(\n      'IMAGE_ADMISSION_REFUSED',\n    );\n  }\n  expect(() => admitImage(png, 'image/jpeg')).toThrow('IMAGE_ADMISSION_REFUSED');\n  expect(() => admitImage(jpeg, 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');\n  expect(() => admitImage(png.subarray(0, 32), 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');\n  expect(() => admitImage(jpeg.subarray(0, 32), 'image/jpeg')).toThrow('IMAGE_ADMISSION_REFUSED');\n  expect(() => admitImage(png, 'unsupported' as 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');\n});\n"
for phase, contents in COLD_CONTENT.items():
    for path, text in contents.items():
        blob = subprocess.check_output(["git", "hash-object", "--stdin"], input=text.encode(), stderr=subprocess.PIPE).decode().strip()
        assert blob == module["COLD_RELOCATIONS"][phase]["head"][path][1], (phase, path, blob)

# Exact reviewed token splices against public immutable originals; no candidate commit dependency.
LAUNCH_PUBLIC_BASE = "c1c71ef456d075bd11c6bc01d4648fe6ee24169d"
DECODE_PUBLIC_BASE = "c04f69541be39ea5ed1aac58abe396ce04e8afbc"
LAUNCH_REVIEWED_EDITS = {
    "packages/daemon/src/cli.ts": [
        [
            13290,
            13290,
            "import { isSessionLaunch, resolveLaunchHarness } from './cli/launch-harness.ts';\n"
        ],
        [
            20124,
            20390,
            "// #1473: explicit CLI choice wins over the configured session default.\n// Hub/management commands keep Claude; a hub explicitly selects each child's harness.\nconst { harnessId, remoteHarness } = resolveLaunchHarness(parsedArgs, remiConfig.harness.default);\n"
        ],
        [
            20786,
            20937,
            "    cliHost !== undefined && cliResume !== undefined && isSessionLaunch(parsedArgs);\n"
        ],
        [
            38757,
            38867,
            "if (isSessionLaunch(parsedArgs) && cliHost) {\n"
        ],
        [
            40712,
            41080,
            "      // Explicit choices and configured Codex are named. Implicit Claude retains the legacy\n      // omitted field. The remote daemon still validates the arguments after `--`.\n      harness: remoteHarness,\n"
        ],
        [
            41339,
            41465,
            "if (isSessionLaunch(parsedArgs) && cliRecent && !cliHost) {\n"
        ],
        [
            42360,
            42483,
            "if (isSessionLaunch(parsedArgs) && cliDir && !cliHost) {\n"
        ]
    ],
    "packages/daemon/src/cli/arg-parser.ts": [
        [
            755,
            755,
            "  'claude',\n"
        ],
        [
            13919,
            13972,
            "      subcommand !== 'claude' &&\n      !((arg === 'codex' || arg === 'claude') && subcommand !== undefined)\n"
        ],
        [
            13980,
            14245,
            "      // Once either harness alias is selected, later command-looking words are its arguments.\n      // An alias only starts a command when none was given: `remi stop codex` still stops.\n"
        ],
        [
            15965,
            15995,
            "    (subcommand === 'codex' || subcommand === 'claude') &&\n"
        ],
        [
            16024,
            16048,
            "    harness !== subcommand\n"
        ],
        [
            16054,
            16134,
            "    error = `Error: --harness ${harness} conflicts with the ${subcommand} subcommand.`;\n"
        ]
    ],
    "packages/daemon/src/cli/handlers/create-session-events.ts": [
        [
            6644,
            6839,
            " * read as a remi flag (`--no-auth`). An omitted wire harness explicitly selects Claude so\n * the child CLI configuration cannot change the legacy/native request meaning. `noticeFor` builds what a success\n"
        ],
        [
            7398,
            7485,
            "  if (harness === undefined && args === undefined) {\n    return { ok: true, spawnArgs: ['--harness', 'claude'] };\n  }\n"
        ],
        [
            8817,
            8967,
            "    spawnArgs: ['--harness', id, ...(checked.args.length > 0 ? ['--', ...checked.args] : [])],\n"
        ]
    ],
    "packages/daemon/src/cli/help.ts": [
        [
            3531,
            3572,
            "    'Create a session using [harness] default (Claude unless configured).',\n"
        ],
        [
            4411,
            4489,
            "    entry('--harness ID', 'Override [harness] default: claude or codex'),\n"
        ],
        [
            5023,
            5023,
            "  ],\n  claude: [\n    'Start Claude Code with monitoring, overriding [harness] default.',\n    '',\n    bold('Usage:'),\n    entry('remi claude', 'Start Claude explicitly'),\n    entry('remi claude --dir <path>', 'Start Claude in directory'),\n    entry('remi claude --host <ip> -- --model <name>', 'Create Claude session remotely'),\n    entry('remi claude --resume <id>', 'Resume a Claude session'),\n    '',\n    dim('  Remi options are read before `--`; later words belong to Claude Code.'),\n"
        ],
        [
            17954,
            18005,
            "    entry('remi', 'Start configured harness (Claude by default)'),\n    entry('remi claude', 'Start Claude explicitly'),\n"
        ],
        [
            20911,
            20911,
            "    entry('--harness ID', 'Override session default: claude or codex'),\n"
        ],
        [
            21899,
            22040,
            "    dim('  Set [harness] default = \"codex\" in config to use Codex for plain remi/new.'),\n    dim('  Unrecognized flags are passed through to the selected harness.'),\n"
        ]
    ],
    "packages/daemon/src/config/config.ts": [
        [
            7771,
            7771,
            "/** #1473: the CLI's session launch default; wire/store omission still means Claude. */\nexport interface HarnessConfig {\n  readonly default: 'claude' | 'codex';\n}\n\n"
        ],
        [
            7836,
            7836,
            "  readonly harness: HarnessConfig;\n"
        ],
        [
            8284,
            8284,
            "  harness: { default: 'claude' },\n"
        ],
        [
            12080,
            12080,
            "    harness: mergeSection(base.harness, partial['harness'] as Record<string, unknown> | undefined),\n"
        ],
        [
            14906,
            14906,
            "    validateHarnessTable(parsed['harness'], configPath);\n"
        ],
        [
            15916,
            15916,
            "  }\n}\n\n/** Validate before merging: scalar/array tables and unknown keys must not disappear. */\nfunction validateHarnessTable(table: unknown, configPath: string): void {\n  if (table === undefined) return;\n  if (typeof table !== 'object' || table === null || Array.isArray(table)) {\n    throw new Error(`Invalid harness in ${configPath}: expected a table with default`);\n  }\n  const prototype = Object.getPrototypeOf(table);\n  if (prototype !== Object.prototype && prototype !== null) {\n    throw new Error(`Invalid harness in ${configPath}: expected a table with default`);\n  }\n  if (Object.keys(table).some((key) => key !== 'default')) {\n    throw new Error(`Invalid harness in ${configPath}: only default is supported`);\n  }\n  const value = (table as Record<string, unknown>)['default'];\n  if (value !== undefined && value !== 'claude' && value !== 'codex') {\n    throw new Error(`Invalid harness.default in ${configPath}: expected \"claude\" or \"codex\"`);\n"
        ],
        [
            26825,
            26825,
            "[harness]\n# CLI session launches only; remi claude/remi codex and --harness override this.\ndefault = \"${DEFAULT_CONFIG.harness.default}\"\n\n"
        ],
        [
            31810,
            31810,
            "  lines.push('[harness]');\n  lines.push(`  default = \"${config.harness.default}\"`);\n  lines.push('');\n"
        ]
    ],
    "packages/daemon/src/config/index.ts": [
        [
            312,
            312,
            "  HarnessConfig,\n"
        ]
    ],
    "packages/daemon/tests/cli/arg-parser.test.ts": [
        [
            134,
            134,
            "\ndescribe('explicit Claude alias (#1473)', () => {\n  test('later command names are Claude arguments, including the other alias', () => {\n    for (const word of ['status', 'config', 'new', 'logs', 'stop', 'claude', 'codex']) {\n      const parsed = parseArgs(['claude', word]);\n      expect(parsed.subcommand).toBe('claude');\n      expect(parsed.claudeArgs).toEqual([word]);\n    }\n  });\n\n  test('a Claude word after a management command is never a launch alias', () => {\n    for (const command of ['stop', 'new', 'serve', 'status', 'ls'] as const) {\n      expect(parseArgs([command, 'claude']).subcommand).toBe(command);\n    }\n  });\n\n  test('alias/flag conflicts are symmetric, before or after the alias', () => {\n    for (const args of [\n      ['claude', '--harness', 'codex'],\n      ['--harness', 'codex', 'claude'],\n    ]) {\n      expect(parseArgs(args).error).toContain('conflicts with the claude subcommand');\n    }\n    expect(parseArgs(['claude', '--harness', 'claude']).error).toBeUndefined();\n    expect(parseArgs(['claude', '--harness', 'opencode']).error).toContain('conflicts');\n  });\n\n  test('the separator prevents aliases and flags from becoming Remi commands', () => {\n    const parsed = parseArgs(['claude', '--', 'codex', 'status', '--harness', 'codex']);\n    expect(parsed.subcommand).toBe('claude');\n    expect(parsed.harness).toBeUndefined();\n    expect(parsed.explicitArgs).toEqual(['codex', 'status', '--harness', 'codex']);\n    expect(parseArgs(['--', 'claude', 'status']).subcommand).toBeUndefined();\n  });\n});\n"
        ],
        [
            31549,
            31646,
            "  test('that rule belongs to harness aliases: management subcommands still use the last one', () => {\n"
        ]
    ],
    "packages/daemon/tests/cli/handlers/create-session-events.test.ts": [
        [
            5383,
            5435,
            "        extraArgs: ['--auth', '--bind', '0.0.0.0', '--harness', 'claude'],\n"
        ]
    ],
    "packages/daemon/tests/cli/handlers/create-session-harness.test.ts": [
        [
            908,
            908,
            "import { parseArgs } from '../../../src/cli/arg-parser.ts';\n"
        ],
        [
            1032,
            1032,
            "import { resolveLaunchHarness } from '../../../src/cli/launch-harness.ts';\n"
        ],
        [
            4632,
            4773,
            "    test('a plain request explicitly selects legacy Claude', () => {\n      expect(spawnArgs(undefined)).toEqual(['--harness', 'claude']);\n      expect(spawnArgs({})).toEqual(['--harness', 'claude']);\n      const child = parseArgs(['--daemon', ...spawnArgs(undefined)]);\n      expect(resolveLaunchHarness(child, 'codex').harnessId).toBe('claude');\n"
        ],
        [
            5506,
            5739,
            "    test('arguments with no wire harness explicitly launch Claude, behind a --', () => {\n      expect(spawnArgs({ args: ['--model', 'opus'] })).toEqual([\n        '--harness',\n        'claude',\n        '--',\n        '--model',\n        'opus',\n      ]);\n      expect(spawnArgs({ args: [] })).toEqual(['--harness', 'claude']);\n"
        ],
        [
            6765,
            6856,
            "      expect(spawnArgs({ args: ['--model', 'opus'] })).toEqual([\n        '--harness',\n        'claude',\n        '--',\n        '--model',\n        'opus',\n      ]);\n"
        ],
        [
            8563,
            8611,
            "      expect(spawnArgs(undefined)).toEqual(['--harness', 'claude']);\n"
        ],
        [
            21891,
            21996,
            "    test('a plain request pins Claude after inherited flags regardless of host CLI default', async () => {\n"
        ],
        [
            22114,
            22210,
            "      expect(spawns[0]?.extraArgs).toEqual([\n        '--no-auth',\n        '--no-relay',\n        '--bind',\n        '127.0.0.1',\n        '--harness',\n        'claude',\n      ]);\n"
        ]
    ],
    "packages/daemon/tests/cli/handlers/create-session-start.test.ts": [
        [
            3558,
            3641,
            "        extraArgs: [\n          '--auth',\n          '--bind',\n          '127.0.0.1',\n          '--harness',\n          'claude',\n          '--',\n          '--resume',\n          CLAUDE_ID,\n        ],\n"
        ]
    ],
    "packages/daemon/tests/cli/handlers/create-session-workspace.test.ts": [
        [
            4813,
            4911,
            "    expect(spawns).toEqual([\n      { port: SPAWNED.port, directory: dir, extraArgs: ['--inherited', '--harness', 'claude'] },\n    ]);\n"
        ]
    ],
    "packages/daemon/tests/cli/help.test.ts": [
        [
            133,
            133,
            "\ntest('help describes configured CLI default and explicit Claude/Codex overrides', () => {\n  expect(formatHelp('0.0.0')).toContain('remi claude');\n  expect(formatHelp('0.0.0')).toContain('[harness] default');\n  expect(formatCommandHelp('claude')).toContain('overriding [harness] default');\n  expect(formatCommandHelp('new')).toContain('Override [harness] default');\n});\n"
        ],
        [
            1502,
            1565,
            "    expect(output).toContain('passed through to the selected harness');\n"
        ]
    ],
    "packages/daemon/tests/config.test.ts": [
        [
            593,
            593,
            "\ndescribe('configured CLI harness (#1473)', () => {\n  test('missing and empty harness tables preserve built-in Claude', () => {\n    expect(loadConfig(TEST_CONFIG).harness.default).toBe('claude');\n    fs.writeFileSync(TEST_CONFIG, '[harness]\\n');\n    expect(loadConfig(TEST_CONFIG).harness.default).toBe('claude');\n  });\n\n  test('exact choices load from owned TOML and survive unrelated environment overrides', () => {\n    for (const harness of ['claude', 'codex'] as const) {\n      fs.writeFileSync(TEST_CONFIG, `[harness]\\ndefault = \"${harness}\"\\n`);\n      const config = loadConfig(TEST_CONFIG);\n      expect(config.harness.default).toBe(harness);\n      expect(applyEnvOverrides(config).harness.default).toBe(harness);\n      expect(formatConfig(config, TEST_CONFIG)).toContain(`default = \"${harness}\"`);\n    }\n  });\n\n  test('rejects malformed tables, unknown keys and unsupported or wrong-type defaults', () => {\n    for (const toml of [\n      'harness = \"codex\"',\n      'harness = []',\n      'harness = 1979-05-27',\n      '[[harness]]\\ndefault = \"claude\"',\n      '[harness]\\nunknown = true',\n      '[harness]\\ndefault = \"opencode\"',\n      '[harness]\\ndefault = \"Codex\"',\n      '[harness]\\ndefault = false',\n      '[harness]\\ndefault = 1',\n      '[harness]\\ndefault = [\"codex\"]',\n      '[harness]\\ndefault = { value = \"codex\" }',\n    ]) {\n      fs.writeFileSync(TEST_CONFIG, toml);\n      expect(() => loadConfig(TEST_CONFIG)).toThrow('Invalid harness');\n    }\n  });\n\n  test('generated default round-trips with an explicit Claude choice', () => {\n    const generated = generateDefaultConfig();\n    expect(generated).toContain('[harness]');\n    expect(generated).toContain('default = \"claude\"');\n    fs.writeFileSync(TEST_CONFIG, generated);\n    expect(loadConfig(TEST_CONFIG).harness).toEqual(DEFAULT_CONFIG.harness);\n  });\n});\n"
        ]
    ]
}
LAUNCH_REVIEWED_NEW = {
    "packages/daemon/src/cli/launch-harness.ts": "import type { HarnessId } from '@remi/shared';\nimport type { ParsedArgs } from './arg-parser.ts';\n\ntype LaunchArgs = Pick<\n  ParsedArgs,\n  'subcommand' | 'harness' | 'install' | 'uninstall' | 'showSessions'\n>;\n\n/** #1473: the configured default belongs to CLI session launches, not hub/management commands. */\nexport function isSessionLaunch(args: LaunchArgs): boolean {\n  if (args.install || args.uninstall || args.showSessions) return false;\n  return (\n    args.subcommand === undefined ||\n    args.subcommand === 'new' ||\n    args.subcommand === 'claude' ||\n    args.subcommand === 'codex'\n  );\n}\n\n/** Keep legacy remote omission for implicit Claude; every explicit choice is named. */\nexport function resolveLaunchHarness(\n  args: LaunchArgs,\n  configuredDefault: 'claude' | 'codex',\n): { harnessId: HarnessId; remoteHarness: HarnessId | undefined } {\n  const alias =\n    args.subcommand === 'claude' || args.subcommand === 'codex' ? args.subcommand : undefined;\n  const explicit = args.harness ?? alias;\n  const harnessId = explicit ?? (isSessionLaunch(args) ? configuredDefault : 'claude');\n  return {\n    harnessId,\n    remoteHarness: explicit ?? (harnessId === 'codex' ? 'codex' : undefined),\n  };\n}\n",
    "packages/daemon/tests/cli/default-harness-dispatch.test.ts": "/** Real Remi subprocess early dispatch only; no Claude/Codex invocation or LLM acceptance. */\nimport { expect, test } from 'bun:test';\nimport * as fs from 'node:fs';\nimport { tmpdir } from 'node:os';\nimport * as path from 'node:path';\n\nconst cli = path.resolve(import.meta.dir, '../../src/cli.ts');\nconst cases = [\n  { args: ['--resume', 'missing'], code: 2, text: \"--resume is remi's flag for Claude\" },\n  {\n    args: ['claude', '--host', '127.0.0.1', '--resume', 'missing'],\n    code: 2,\n    text: 'put it after --',\n  },\n  {\n    args: ['--host', '127.0.0.1', '--resume', 'missing'],\n    code: 2,\n    text: 'for Codex put the resume after --',\n  },\n  { args: ['claude', '--harness', 'codex'], code: 1, text: 'conflicts with the claude subcommand' },\n  { args: ['codex', '--harness', 'claude'], code: 1, text: 'conflicts with the codex subcommand' },\n  { args: ['claude', '--host', '127.0.0.1', 'loose'], code: 2, text: 'not sent: loose' },\n  { args: ['serve', '--harness', 'codex'], code: 2, text: 'The hub hosts no session of its own' },\n  { args: ['claude', '--help'], code: 0, text: 'overriding [harness] default' },\n  { args: ['config'], code: 0, text: 'default = \"codex\"' },\n] as const;\n\nasync function run(args: readonly string[], config: string) {\n  const home = fs.mkdtempSync(path.join(tmpdir(), 'remi-default-harness-'));\n  try {\n    fs.writeFileSync(path.join(home, 'config.toml'), config, { mode: 0o600 });\n    const child = Bun.spawn([process.execPath, '--no-env-file', cli, ...args], {\n      cwd: home,\n      env: { ...process.env, REMI_HOME: home },\n      stdin: 'ignore',\n      stdout: 'pipe',\n      stderr: 'pipe',\n    });\n    const timer = setTimeout(() => child.kill('SIGKILL'), 15000);\n    try {\n      const [code, stdout, stderr] = await Promise.all([\n        child.exited,\n        new Response(child.stdout).text(),\n        new Response(child.stderr).text(),\n      ]);\n      return { code, text: stdout + stderr };\n    } finally {\n      clearTimeout(timer);\n    }\n  } finally {\n    fs.rmSync(home, { recursive: true, force: true });\n  }\n}\n\nfor (const scenario of cases) {\n  test(`real CLI configured Codex early dispatch: ${scenario.args.join(' ')}`, async () => {\n    const result = await run(scenario.args, '[harness]\\ndefault = \"codex\"\\n');\n    expect(result.code).toBe(scenario.code);\n    expect(result.text).toContain(scenario.text);\n  });\n}\n\ntest('real CLI refuses invalid config before any session launch', async () => {\n  const result = await run([], '[harness]\\ndefault = \"opencode\"\\n');\n  expect(result.code).toBe(1);\n  expect(result.text).toContain('Invalid harness.default');\n});\n\ntest('explicit Claude directory dispatch still runs before a harness launch', async () => {\n  const owned = fs.mkdtempSync(path.join(tmpdir(), 'remi-default-harness-dir-'));\n  try {\n    const missing = path.join(owned, 'absent');\n    const result = await run(['claude', '--dir', missing], '[harness]\\ndefault = \"codex\"\\n');\n    expect(result.code).toBe(1);\n    expect(result.text).toContain(missing);\n    expect(result.text).not.toContain('Codex');\n  } finally {\n    fs.rmSync(owned, { recursive: true, force: true });\n  }\n});\n\ntest('real CLI management status ignores configured Codex', async () => {\n  const result = await run(['status'], '[harness]\\ndefault = \"codex\"\\n');\n  expect([0, 1]).toContain(result.code);\n  expect(result.text).not.toContain('Codex');\n  expect(result.text).not.toContain('takes no --harness');\n});\n",
    "packages/daemon/tests/cli/launch-harness.test.ts": "import { expect, test } from 'bun:test';\nimport { DEFAULT_HARNESS, createCreateSessionRequest } from '@remi/shared';\nimport { parseArgs } from '../../src/cli/arg-parser';\nimport { isSessionLaunch, resolveLaunchHarness } from '../../src/cli/launch-harness';\n\nconst cases = [\n  { args: [], config: 'claude', local: 'claude', remote: undefined },\n  { args: [], config: 'codex', local: 'codex', remote: 'codex' },\n  { args: ['new'], config: 'codex', local: 'codex', remote: 'codex' },\n  { args: ['--daemon'], config: 'codex', local: 'codex', remote: 'codex' },\n  { args: ['claude'], config: 'codex', local: 'claude', remote: 'claude' },\n  { args: ['codex'], config: 'claude', local: 'codex', remote: 'codex' },\n  { args: ['--harness', 'claude'], config: 'codex', local: 'claude', remote: 'claude' },\n  { args: ['--harness', 'codex'], config: 'claude', local: 'codex', remote: 'codex' },\n  { args: ['serve'], config: 'codex', local: 'claude', remote: undefined },\n  { args: ['status'], config: 'codex', local: 'claude', remote: undefined },\n  { args: ['--install'], config: 'codex', local: 'claude', remote: undefined },\n  { args: ['--uninstall'], config: 'codex', local: 'claude', remote: undefined },\n  { args: ['--sessions'], config: 'codex', local: 'claude', remote: undefined },\n  { args: ['--harness', 'opencode'], config: 'codex', local: 'opencode', remote: 'opencode' },\n] as const;\n\nfor (const scenario of cases) {\n  test(`launch choice ${scenario.config}: ${scenario.args.join(' ') || 'plain remi'}`, () => {\n    const parsed = parseArgs(scenario.args);\n    expect(parsed.error).toBeUndefined();\n    expect(resolveLaunchHarness(parsed, scenario.config)).toEqual({\n      harnessId: scenario.local,\n      remoteHarness: scenario.remote,\n    });\n  });\n}\n\ntest('all four launch forms retain host, recent and directory routing', () => {\n  for (const command of [[], ['new'], ['claude'], ['codex']]) {\n    for (const flags of [['--host', 'host'], ['--recent'], ['--dir', '/owned/project']]) {\n      expect(isSessionLaunch(parseArgs([...command, ...flags]))).toBe(true);\n    }\n  }\n  expect(isSessionLaunch(parseArgs(['serve']))).toBe(false);\n});\n\ntest('actual remote factory preserves legacy omission and explicit/configured selection', () => {\n  for (const scenario of cases.slice(0, 8)) {\n    const parsed = parseArgs([...scenario.args, '--host', 'host', '--', '--model', 'model']);\n    const { remoteHarness } = resolveLaunchHarness(parsed, scenario.config);\n    const message = createCreateSessionRequest('/owned/project', {\n      harness: remoteHarness,\n      args: parsed.explicitArgs,\n    });\n    expect(message.harness).toBe(scenario.remote);\n    expect(message.args).toEqual(['--model', 'model']);\n    if (scenario.remote === undefined) expect(Object.hasOwn(message, 'harness')).toBe(false);\n  }\n  expect(DEFAULT_HARNESS).toBe('claude');\n});\n"
}
DECODE_REVIEWED_EDITS = {
    "scripts/tunnel-decoder-proof/decode.ts": [
        [
            0,
            966,
            "// #1170 proof adapter for the daemon-owned full image decoder.\nexport { decodeImage } from '../../packages/daemon/src/tunnel/image-decode';\n"
        ]
    ],
    "scripts/tunnel-decoder-proof/pngjs.d.ts": [
        [
            0,
            602,
            "/// <reference path=\"../../packages/daemon/src/tunnel/image-codecs.d.ts\" />\n"
        ]
    ],
    "packages/daemon/package.json": [
        [
            689,
            689,
            "    \"jpeg-js\": \"0.4.4\",\n    \"pngjs\": \"7.0.0\",\n"
        ]
    ],
    "bun.lock": [
        [
            726,
            726,
            "        \"jpeg-js\": \"0.4.4\",\n        \"pngjs\": \"7.0.0\",\n"
        ],
        [
            90303,
            90303,
            "    \"jpeg-js\": [\"jpeg-js@0.4.4\", \"\", {}, \"sha512-WZzeDOEtTOBK4Mdsar0IqEU5sMr3vSV2RqkAIzUEV2BHnUfKGyswWFPFwK5EeDo93K3FohSHbLAjj0s1Wzd+dg==\"],\n\n"
        ],
        [
            121677,
            121814,
            "    \"pngjs\": [\"pngjs@7.0.0\", \"\", {}, \"sha512-LKWqWJRhstyYo9pGvgor/ivk2w94eSjE3RGVuzLGlr3NmD8bf7RcYGze1mNdEHRP6TRP6rMuDHk5t44hnTRyow==\"],\n"
        ],
        [
            160431,
            160431,
            "    \"qrcode/pngjs\": [\"pngjs@5.0.0\", \"\", {}, \"sha512-40QW5YalBNfQo5yRYmiw7Yz6TKKVr3h6970B2YE+3fQpsWcrbj1PzJgxeJ19DRQjhMbKPIuMY8rFaXc8moolVw==\"],\n\n"
        ]
    ],
    "scripts/tunnel-decoder-proof/matrix.py": [
        [
            1829,
            1829,
            "            \"packages/daemon/package.json\",\n"
        ]
    ],
    "scripts/tunnel-decoder-proof/approval-matrix.py": [
        [
            964,
            964,
            "            \"packages/daemon/package.json\",\n"
        ]
    ],
    "scripts/tunnel-decoder-proof/THIRD-PARTY-LICENSES.txt": [
        [
            0,
            77,
            "Decoder dependency notices for the standalone proof and internal daemon decoder.\nThe daemon selects these exact versions; active worker and upload integration are pending.\n"
        ]
    ]
}
DECODE_ADOPTION_TEST = "import { expect, test } from 'bun:test';\nimport * as fs from 'node:fs';\nimport * as path from 'node:path';\nimport { decodeImage as proofDecodeImage } from '../../../../scripts/tunnel-decoder-proof/decode';\nimport inputs from '../../../../scripts/tunnel-decoder-proof/inputs.json';\nimport { admitImage } from '../../src/tunnel/image-admission';\nimport { decodeImage } from '../../src/tunnel/image-decode';\n\nconst fixture = (name: string) =>\n  fs.readFileSync(path.resolve(import.meta.dir, '../../../../scripts/tunnel-decoder-proof', name));\nconst sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');\n\ntest('proof decoder shares the daemon function and fully decodes the owned image pixels', () => {\n  expect(proofDecodeImage).toBe(decodeImage);\n  for (const [index, mediaType] of (['image/png', 'image/jpeg'] as const).entries()) {\n    const expected = inputs.images[index];\n    if (!expected) throw new Error('owned image fixture metadata missing');\n    const bytes = fixture(expected.filename);\n    expect(sha256(bytes)).toBe(expected.inputSha256);\n    const decoded = decodeImage(bytes, mediaType);\n    expect({ width: decoded.width, height: decoded.height }).toEqual({\n      width: expected.width,\n      height: expected.height,\n    });\n    expect(decoded.data.byteLength).toBe(expected.pixelBytes);\n    expect(sha256(decoded.data)).toBe(expected.pixelSha256);\n  }\n});\n\ntest('full decoding preserves header refusal and normalized PNG CRC refusal', () => {\n  const png = fixture('fixture.png');\n  const jpeg = fixture('fixture.jpg');\n  for (const mediaType of ['image/png', 'image/jpeg'] as const) {\n    expect(() => decodeImage(png.subarray(0, 0), mediaType)).toThrow('IMAGE_ADMISSION_REFUSED');\n  }\n  expect(() => decodeImage(png, 'image/jpeg')).toThrow('IMAGE_ADMISSION_REFUSED');\n  expect(() => decodeImage(jpeg, 'image/png')).toThrow('IMAGE_ADMISSION_REFUSED');\n  const corrupt = Buffer.from(png);\n  const crcByte = corrupt[29];\n  if (crcByte === undefined) throw new Error('owned PNG CRC byte missing');\n  corrupt[29] = crcByte ^ 1;\n  expect(admitImage(corrupt, 'image/png')).toEqual({ width: 1024, height: 1024 });\n  expect(() => decodeImage(corrupt, 'image/png')).toThrow('IMAGE_DECODE_REFUSED');\n});\n"
TRANSITION_CONTENT = {"CLI-default": {}, "Dormant full-decoder": {}, "Image worker entry": {}}
for name, edits, additions, policy in (
        ("CLI-default", LAUNCH_REVIEWED_EDITS, LAUNCH_REVIEWED_NEW, module["SOAK_LAUNCH_TRANSITION"]),
        ("Dormant full-decoder", DECODE_REVIEWED_EDITS, {}, module["SOAK_DECODE_TRANSITION"])):
    for path, changes in edits.items():
        body = subprocess.check_output(["git", "cat-file", "blob", policy[path]["original"][1]],
                                       stderr=subprocess.PIPE).decode()
        for start, stop, replacement in reversed(changes):
            body = body[:start] + replacement + body[stop:]
        TRANSITION_CONTENT[name][path] = body
    TRANSITION_CONTENT[name].update(additions)
for path, roles in module["SOAK_IMAGE_ENTRY_TRANSITION"].items():
    TRANSITION_CONTENT["Image worker entry"][path] = subprocess.check_output(
        ["git", "cat-file", "blob", roles["head"][1]], stderr=subprocess.PIPE).decode()
IMAGE_ENTRY_DOC_CONTENT = {
    path: subprocess.check_output(["git", "show", f"{module['SOAK_IMAGE_ENTRY_SOURCE_ROOT']}:{path}"],
                                  stderr=subprocess.PIPE).decode()
    for path in module["SOAK_IMAGE_ENTRY_DOCS"]
}
old_decode = subprocess.check_output(["git", "cat-file", "blob", module["SOAK_DECODE_TRANSITION"][
    "scripts/tunnel-decoder-proof/decode.ts"]["original"][1]], stderr=subprocess.PIPE).decode()
TRANSITION_CONTENT["Dormant full-decoder"]["packages/daemon/src/tunnel/image-decode.ts"] = old_decode.replace(
    "// #1170 candidate only. Header admission precedes full decode; process limits are unproved.",
    "// #1170 internal synchronous decoder; active transfers require the owned child path.", 1
).replace("from './admission';", "from './image-admission';", 1)
old_declaration = subprocess.check_output(["git", "cat-file", "blob", module["SOAK_DECODE_TRANSITION"][
    "scripts/tunnel-decoder-proof/pngjs.d.ts"]["original"][1]], stderr=subprocess.PIPE).decode()
TRANSITION_CONTENT["Dormant full-decoder"]["packages/daemon/src/tunnel/image-codecs.d.ts"] = "".join(
    old_declaration.splitlines(keepends=True)[:23])
TRANSITION_CONTENT["Dormant full-decoder"]["packages/daemon/tests/tunnel/image-decode-adoption.test.ts"] = DECODE_ADOPTION_TEST
for name, contents in TRANSITION_CONTENT.items():
    policy = (module["SOAK_LAUNCH_TRANSITION"] if name == "CLI-default" else
              module["SOAK_DECODE_TRANSITION"] if name == "Dormant full-decoder" else
              module["SOAK_IMAGE_ENTRY_TRANSITION"])
    assert set(contents) == set(policy)
    for path, body in contents.items():
        blob = subprocess.check_output(["git", "hash-object", "--stdin"], input=body.encode(),
                                       stderr=subprocess.PIPE).decode().strip()
        assert blob == policy[path]["head"][1], (name, path, blob)

# Exact public original controller/worker copies and explicit proof adapters; no93 candidate reads.
WORKER_CONTENT = {}
old_process = subprocess.check_output(["git", "cat-file", "blob", module["SOAK_DECODE_WORKER_TRANSITION"][
    "scripts/tunnel-decoder-proof/process.ts"]["original"][1]], stderr=subprocess.PIPE).decode()
WORKER_CONTENT["packages/daemon/src/tunnel/image-process.ts"] = old_process.replace(
    "// #1170 private candidate. Process lifetime controls are not a portable memory ceiling.",
    "// #1170 internal decoder controller. Process lifetime controls are not a portable memory ceiling.", 1
).replace("from './admission';", "from './image-admission';", 1)
old_worker = subprocess.check_output(["git", "cat-file", "blob", module["SOAK_DECODE_WORKER_TRANSITION"][
    "scripts/tunnel-decoder-proof/worker.ts"]["original"][1]], stderr=subprocess.PIPE).decode()
WORKER_CONTENT["packages/daemon/src/tunnel/image-worker.ts"] = (
    "// #1170 internal worker functions; no selected production entry.\n" + old_worker
).replace("from './admission';", "from './image-admission';", 1).replace("from './decode';", "from './image-decode';", 1)
WORKER_CONTENT["scripts/tunnel-decoder-proof/process.ts"] = """// #1170 proof adapter for the daemon-owned decoder controller.
export {
  DecoderProcess,
  DecoderProcessError,
  MAX_RESULT_BYTES,
  type DecodedPixels,
  type DecoderChildExit,
  type RepeatedDecodeReady,
} from '../../packages/daemon/src/tunnel/image-process';
"""
WORKER_CONTENT["scripts/tunnel-decoder-proof/worker.ts"] = """// #1170 proof adapter for the daemon-owned worker functions.
export {
  decodeInput,
  decodeRepeatedWorker,
  decodeWorker,
} from '../../packages/daemon/src/tunnel/image-worker';
"""
WORKER_CONTENT["packages/daemon/tests/tunnel/image-worker-adoption.test.ts"] = 'import { expect, test } from \'bun:test\';\nimport assert from \'node:assert/strict\';\nimport * as fs from \'node:fs\';\nimport { tmpdir } from \'node:os\';\nimport * as path from \'node:path\';\nimport inputs from \'../../../../scripts/tunnel-decoder-proof/inputs.json\';\nimport * as proofProcess from \'../../../../scripts/tunnel-decoder-proof/process\';\nimport * as proofWorker from \'../../../../scripts/tunnel-decoder-proof/worker\';\nimport {\n  type DecodedPixels,\n  type DecoderChildExit,\n  DecoderProcess,\n  DecoderProcessError,\n  MAX_RESULT_BYTES,\n  type RepeatedDecodeReady,\n} from \'../../src/tunnel/image-process\';\nimport { decodeInput, decodeRepeatedWorker, decodeWorker } from \'../../src/tunnel/image-worker\';\n\nconst fixture = (name: string) =>\n  fs.readFileSync(path.resolve(import.meta.dir, \'../../../../scripts/tunnel-decoder-proof\', name));\nconst sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher(\'sha256\').update(bytes).digest(\'hex\');\n\nfunction exited(controller: DecoderProcess, code: number | null, signal: string | null) {\n  const observed: DecoderChildExit | undefined = controller.lastChildExit;\n  expect(observed).toBeDefined();\n  if (!observed) throw new Error(\'owned decoder child exit metadata missing\');\n  const proofObserved: proofProcess.DecoderChildExit = observed;\n  const pid = controller.lastChildPID;\n  if (pid === undefined) throw new Error(\'owned decoder child PID missing\');\n  expect(proofObserved.pid).toBe(pid);\n  expect(proofObserved.exitCode).toBe(code);\n  expect(proofObserved.signalCode).toBe(signal);\n  expect(Object.isFrozen(proofObserved)).toBe(true);\n  assert.throws(() => process.kill(proofObserved.pid, 0), { code: \'ESRCH\' });\n}\n\ntest(\'proof adapters share daemon controller and worker with actual owned child round trips\', async () => {\n  expect(proofProcess.DecoderProcess).toBe(DecoderProcess);\n  expect(proofProcess.DecoderProcessError).toBe(DecoderProcessError);\n  expect(proofProcess.MAX_RESULT_BYTES).toBe(MAX_RESULT_BYTES);\n  expect(MAX_RESULT_BYTES).toBe(4096);\n  expect(proofWorker.decodeInput).toBe(decodeInput);\n  expect(proofWorker.decodeRepeatedWorker).toBe(decodeRepeatedWorker);\n  expect(proofWorker.decodeWorker).toBe(decodeWorker);\n  const policyKeys = [\'BUN_JSC_useJIT\', \'BUN_JSC_useBaselineJIT\', \'REMI_DECODER_POLICY_SENTINEL\'];\n  const parentPolicy = policyKeys.map((key) => process.env[key]);\n  const home = fs.mkdtempSync(path.join(tmpdir(), \'remi-image-worker-adoption-\'));\n  const entry = path.join(home, \'entry.ts\');\n  const worker = path.resolve(import.meta.dir, \'../../src/tunnel/image-worker.ts\');\n  const code = [\n    "import assert from \'node:assert/strict\';",\n    `import { decodeRepeatedWorker, decodeWorker } from ${JSON.stringify(worker)};`,\n    "assert.equal(process.env[\'BUN_JSC_useJIT\'], \'0\');",\n    "assert(Object.keys(process.env).filter(key => key.startsWith(\'BUN_JSC_\')).every(key => key === \'BUN_JSC_useJIT\'));",\n    "assert.equal(process.env[\'REMI_DECODER_POLICY_SENTINEL\'], undefined);",\n    "if (process.argv.includes(\'--repeat-decode\')) await decodeRepeatedWorker(process.argv.at(-1));",\n    \'else await decodeWorker(process.argv.at(-1));\',\n  ].join(\'\\n\');\n  const controller = new DecoderProcess([process.execPath, \'--no-env-file\', entry]);\n  let cancellation: AbortController | undefined;\n  let repeated: Promise<{ kind: \'completed\' } | { kind: \'refused\'; error: unknown }> | undefined;\n  try {\n    fs.chmodSync(home, 0o700);\n    fs.writeFileSync(entry, `${code}\\n`, { flag: \'wx\', mode: 0o600 });\n    for (const [index, mediaType] of ([\'image/png\', \'image/jpeg\'] as const).entries()) {\n      const expected = inputs.images[index];\n      if (!expected) throw new Error(\'owned image fixture metadata missing\');\n      const bytes = fixture(expected.filename);\n      expect(sha256(bytes)).toBe(expected.inputSha256);\n      const ownedInput = Buffer.from(bytes);\n      const pending = controller.decode(ownedInput, mediaType);\n      ownedInput.fill(0);\n      const result: DecodedPixels = await pending;\n      const proofResult: proofProcess.DecodedPixels = result;\n      expect(proofResult).toEqual({\n        width: expected.width,\n        height: expected.height,\n        pixelBytes: expected.pixelBytes,\n        pixelSha256: expected.pixelSha256,\n      });\n      exited(controller, 0, null);\n    }\n    const png = fixture(\'fixture.png\');\n    const crc = png[29];\n    if (crc === undefined) throw new Error(\'owned PNG CRC byte missing\');\n    const corrupt = Buffer.from(png);\n    corrupt[29] = crc ^ 1;\n    await expect(controller.decode(corrupt, \'image/png\')).rejects.toMatchObject({\n      code: \'refused\',\n    });\n    exited(controller, 1, null);\n    cancellation = new AbortController();\n    let ready: RepeatedDecodeReady | undefined;\n    repeated = controller\n      .decodeRepeated(fixture(\'fixture.jpg\'), \'image/jpeg\', {\n        signal: cancellation.signal,\n        onReady(result) {\n          ready = result;\n          cancellation?.abort();\n        },\n      })\n      .then(\n        () => ({ kind: \'completed\' as const }),\n        (error: unknown) => ({ kind: \'refused\' as const, error }),\n      );\n    await expect(controller.decode(png, \'image/png\')).rejects.toMatchObject({ code: \'busy\' });\n    const outcome = await repeated;\n    expect(outcome.kind).toBe(\'refused\');\n    if (outcome.kind !== \'refused\')\n      throw new Error(\'owned repeated decoder unexpectedly completed\');\n    expect(outcome.error).toBeInstanceOf(DecoderProcessError);\n    expect(outcome.error).toMatchObject({ code: \'cancelled\' });\n    const proofReady: proofProcess.RepeatedDecodeReady | undefined = ready;\n    const jpeg = inputs.images[1];\n    if (!jpeg) throw new Error(\'owned JPEG fixture metadata missing\');\n    expect(proofReady).toEqual({\n      decodes: 2,\n      width: jpeg.width,\n      height: jpeg.height,\n      pixelBytes: jpeg.pixelBytes,\n      pixelSha256: jpeg.pixelSha256,\n    });\n    exited(controller, null, \'SIGKILL\');\n    const recovered = await controller.decode(png, \'image/png\');\n    const expectedPNG = inputs.images[0];\n    if (!expectedPNG) throw new Error(\'owned PNG fixture metadata missing\');\n    expect(recovered.pixelSha256).toBe(expectedPNG.pixelSha256);\n    exited(controller, 0, null);\n    expect(policyKeys.map((key) => process.env[key])).toEqual(parentPolicy);\n  } finally {\n    cancellation?.abort();\n    if (repeated) await repeated;\n    fs.rmSync(home, { recursive: true, force: true });\n  }\n});\n'
for path, body in WORKER_CONTENT.items():
    blob = subprocess.check_output(["git", "hash-object", "--stdin"], input=body.encode(),
                                   stderr=subprocess.PIPE).decode().strip()
    assert blob == module["SOAK_DECODE_WORKER_TRANSITION"][path]["head"][1], (path, blob)

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


def auth_readiness_controls(soak_tree, transition_updates, owned_missing_transition_objects):
    # Reuse the existing full-tree runner; append only #1480-specific histories.
    def readiness_assert(left, right, label, skip):
        global count
        result = classify(left, right)
        assert selected(result) == gates and result["typecheck"] and result["relay"] and (
            result["relay_soak"] is not skip), (label, result)
        count += 1

    ci_originals = [(path, body, "100644") for path, body in AUTH_READINESS_CI_ORIGINAL_CONTENT.items()]
    ci_finals = [(path, body, "100644") for path, body in AUTH_READINESS_CI_FINAL_CONTENT.items()]
    base = soak_tree(LAUNCH_PUBLIC_BASE, ci_originals)
    assert git("rev-parse", f"{base}:{SOAK_AUTH_PATH}") == module["SOAK_AUTH_READINESS"][0]
    launch = soak_tree(base, transition_updates("CLI-default", base))
    update = (SOAK_AUTH_PATH, AUTH_READINESS_CONTENT, "100644")
    doc = ("docs/owned-auth-readiness.md", "ordinary prose only\n", "100644")
    candidates = {}
    for role, left in (("original CLI", base), ("default CLI", launch)):
        for qualification in (False, True):
            updates = [update, *(ci_finals if qualification else [])]
            candidate = soak_tree(left, updates)
            candidates[(role, qualification)] = candidate
            readiness_assert(left, candidate, ("auth readiness", role, qualification), True)
            readiness_assert(left, soak_tree(left, [*updates, doc]),
                              ("auth readiness ordinary docs", role, qualification), True)
        for kind in ("wrong original", "wrong final", "reverse", "deleted", "renamed", "added", "executable", "symlink"):
            old, updates, removals = left, [update], ()
            if kind == "wrong original":
                old = soak_tree(left, [(SOAK_AUTH_PATH, auth_original, "100644")])
            elif kind == "wrong final":
                updates = [(SOAK_AUTH_PATH, AUTH_READINESS_CONTENT + "\n// unreviewed\n", "100644")]
            elif kind == "reverse":
                old, updates = candidates[(role, False)], [(SOAK_AUTH_PATH, auth_final, "100644")]
            elif kind == "deleted":
                updates, removals = [], (SOAK_AUTH_PATH,)
            elif kind == "renamed":
                updates, removals = [("docs/moved-auth-fixture.md", AUTH_READINESS_CONTENT, "100644")], (SOAK_AUTH_PATH,)
            elif kind == "added":
                old = soak_tree(left, removals=(SOAK_AUTH_PATH,))
            elif kind == "executable":
                updates = [(SOAK_AUTH_PATH, AUTH_READINESS_CONTENT, "100755")]
            elif kind == "symlink":
                updates = [(SOAK_AUTH_PATH, "owned-target", "120000")]
            readiness_assert(old, soak_tree(old, updates, removals), ("auth readiness", role, kind), False)
        for path in ("packages/daemon/src/auth/authenticator.ts", "packages/daemon/src/cli.ts", "package.json"):
            body = git("show", f"{left}:{path}") + "\n// unreviewed input\n"
            drifted = soak_tree(left, [(path, body, "100644")])
            readiness_assert(drifted, soak_tree(drifted, [update]), ("auth readiness upstream drift", role, path), False)
        readiness_assert(left, soak_tree(left, [update, (SOAK_AUTH_PATH.replace("connection-auth", "neighbor-auth"),
                                                        "export {};\n", "100644")]),
                          ("auth readiness mixed test", role), False)
        readiness_assert(left, soak_tree(left, [update, ("packages/shared/src/protocol.ts", "export {};\n", "100644")]),
                          ("auth readiness mixed runtime", role), False)
    readiness_assert(base, soak_tree(base, [update, *transition_updates("CLI-default", base)]),
                      "auth readiness cannot compose with CLI transition", False)
    ci_paths = tuple(AUTH_READINESS_CI_FINAL_CONTENT)
    for choices in ((ci_paths[0],), (ci_paths[1],), (ci_paths[2],),
                    ci_paths[:2], ci_paths[1:], (ci_paths[0], ci_paths[2])):
        readiness_assert(base, soak_tree(base, [update, *[(path, AUTH_READINESS_CI_FINAL_CONTENT[path], "100644")
                                                         for path in choices]]),
                          ("auth readiness partial qualification", choices), False)
    for index, path in enumerate(ci_paths):
        original = AUTH_READINESS_CI_ORIGINAL_CONTENT[path]
        drifted = soak_tree(base, [(path, original + b"\n# unreviewed original\n", "100644")])
        readiness_assert(drifted, soak_tree(drifted, [update, *ci_finals]),
                          ("auth readiness qualification original pin", path), False)
        altered = list(ci_finals)
        altered[index] = (path, AUTH_READINESS_CI_FINAL_CONTENT[path] + b"\n# unreviewed final\n", "100644")
        readiness_assert(base, soak_tree(base, [update, *altered]),
                          ("auth readiness qualification executing-byte pin", path), False)
        altered[index] = (path, AUTH_READINESS_CI_FINAL_CONTENT[path], "100755")
        readiness_assert(base, soak_tree(base, [update, *altered]),
                          ("auth readiness qualification mode", path), False)
    for path in ("packages/daemon/src/owned-auth-reader.ts", "owned-auth-launch.json"):
        body = f"import '{SOAK_AUTH_PATH}';\n" if path.endswith(".ts") else json.dumps({"test": SOAK_AUTH_PATH})
        caller = (path, body, "100644")
        for context in ("head", "both", "base-only"):
            left = base if context == "head" else soak_tree(base, [caller])
            right = soak_tree(base, [update]) if context == "base-only" else soak_tree(
                left, [update, *([caller] if context == "head" else [])])
            readiness_assert(left, right, ("auth readiness caller", path, context), False)
    for path, body in (("owned-auth-scan.txt", b"\xff"), ("owned-auth-scan.txt", b"owned\0text"),
                       ("secrets.json", b"owned refusal sentinel")):
        left = soak_tree(base, [(path, body, "100644")])
        readiness_assert(left, soak_tree(left, [update]), ("auth readiness scan refusal", path, body), False)
    other_fixture = "tests/integration/relay-r3-drain.test.ts"
    old = soak_tree(base, [(other_fixture, SOAK_ORIGINAL_CONTENT[other_fixture], "100644")])
    readiness_assert(old, soak_tree(old, [update, (other_fixture, SOAK_FINAL_CONTENT[other_fixture], "100644")]),
                      "auth readiness cannot compose with legacy fixture", False)
    owned_missing_transition_objects(base, candidates[("original CLI", True)], [
        ("original", SOAK_AUTH_PATH), ("head", SOAK_AUTH_PATH),
        ("original", ci_paths[0]), ("head", ci_paths[1]),
        ("core", "packages/daemon/src/cli.ts"),
        ("core", next(iter(module["SOAK_AUTH_COMMENTS"])))], "auth readiness")


def validation_controls():
    # #1476 uses real checkouts/events and the actual shipping CLI mode, never fabricated diffs.
    global count
    import copy
    import shutil
    import zlib

    previous = Path.cwd()
    source_parent = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=original).decode().strip()
    source_paths = sorted(path for path in subprocess.check_output(
        ["git", "ls-files", "-z"], cwd=original).decode().split("\0")
        if path and module["validation_input"](path))
    source_bytes = {path: (original / path).read_bytes() for path in source_paths}
    with tempfile.TemporaryDirectory(prefix="remi-validation-") as temporary:
        container = Path(temporary)
        repo = container / "repo"
        repo.mkdir()
        try:
            os.chdir(repo)
            git("init", "-q")
            git("config", "user.name", "Owned validator scope control")
            git("config", "user.email", "test@example.com")
            git("fetch", "--quiet", "--no-tags", str(original), source_parent)
            git("fetch", "--quiet", "--no-tags", str(original), module["SOAK_IMAGE_ENTRY_SOURCE_ROOT"])

            def tree(parent, updates=(), removals=()):
                git("read-tree", parent)
                for path, body, mode in updates:
                    body = body.encode() if isinstance(body, str) else body
                    oid = subprocess.check_output(["git", "hash-object", "-w", "--stdin"],
                                                  input=body, stderr=subprocess.PIPE).decode().strip()
                    git("update-index", "--add", "--cacheinfo", f"{mode},{oid},{path}")
                for path in removals:
                    git("update-index", "--force-remove", "--", path)
                return git("commit-tree", git("write-tree"), "-p", parent, "-m", "owned validator input transition")

            baseline = tree(source_parent, [(path, body, "100644") for path, body in source_bytes.items()])
            feature = tree(baseline, [("docs/owned-validation-feature.md", "ordinary feature prose\n", "100644")])

            def decision(left, right, required, label, checkout=None, event=None, environment=None,
                         args=(), dirty=None, script=None, prepared=False):
                global count
                checkout = checkout or right
                if not prepared:
                    git("checkout", "--quiet", "--force", "--detach", checkout)
                payload = event if event is not None else {
                    "pull_request": {"base": {"sha": left}, "head": {"sha": right}, "merge_commit_sha": checkout}
                }
                event_file = container / "event.json"
                event_file.write_text(json.dumps(payload))
                output = container / "output"
                summary = container / "summary"
                output.write_text("")
                summary.write_text("")
                env = os.environ.copy()
                for key in list(env):
                    if key.startswith(("GITHUB_", "GIT_")):
                        env.pop(key)
                env.update(GITHUB_EVENT_NAME="pull_request", GITHUB_EVENT_PATH=str(event_file),
                           GITHUB_WORKSPACE=str(Path.cwd()), GITHUB_SHA=checkout,
                           GITHUB_OUTPUT=str(output), GITHUB_STEP_SUMMARY=str(summary))
                for key, value in (environment or {}).items():
                    if value is None:
                        env.pop(key, None)
                    else:
                        env[key] = value
                if dirty:
                    dirty()
                result = subprocess.run(["python3", str(script or Path.cwd() / ".github/scripts/ci-scope.py"),
                                         "--validation-needed", *args], env=env, capture_output=True, text=True, check=False)
                assert result.returncode == 0, (label, result.stderr)
                answer = json.loads(result.stdout)
                assert set(answer) == {"validation_required", "reason"} and (
                    answer["validation_required"] is required), (label, answer)
                assert output.read_text() == f"validation_required={str(required).lower()}\n", label
                assert summary.read_text().startswith("### CI validator scope\n") and "| Gate |" not in summary.read_text()
                count += 1

            decision(baseline, feature, False, "ordinary head checkout")
            decision(baseline, feature, False, "explicit matching refs",
                     args=("--base", baseline, "--head", feature))
            runtime = tree(baseline, [("packages/daemon/src/owned-validation-runtime.ts", "export {};\n", "100644")])
            decision(baseline, runtime, False, "runtime feature still classified separately")
            unrelated_base = tree(baseline, [("docs/owned-base-note.md", "base prose\n", "100644")])
            merged_tree = git("merge-tree", "--write-tree", unrelated_base, feature).splitlines()[0]
            merged = git("commit-tree", merged_tree, "-p", unrelated_base, "-p", feature, "-m", "owned actual PR merge")
            decision(unrelated_base, feature, False, "actual two-parent checkout", checkout=merged)
            decision(unrelated_base, feature, False, "valid parents with stale merge metadata", checkout=merged,
                     event={"pull_request": {"base": {"sha": unrelated_base}, "head": {"sha": feature},
                                             "merge_commit_sha": feature}})
            decision(unrelated_base, feature, False, "valid parents without merge metadata", checkout=merged,
                     event={"pull_request": {"base": {"sha": unrelated_base}, "head": {"sha": feature}}})
            package = json.loads((original / "package.json").read_bytes())
            package["version"] = "0.7.17-dev.2"
            advanced_base = tree(baseline, [("package.json", json.dumps(package, indent=2) + "\n", "100644")])
            advanced_tree = git("merge-tree", "--write-tree", advanced_base, feature).splitlines()[0]
            advanced_merge = git("commit-tree", advanced_tree, "-p", advanced_base, "-p", feature,
                                 "-m", "owned version-only base advance")
            decision(baseline, feature, False, "version-only advanced first parent", checkout=advanced_merge,
                     event={"pull_request": {"base": {"sha": baseline}, "head": {"sha": feature},
                                             "merge_commit_sha": "0" * 40}})
            changed_ci = ".github/workflows/ci.yml"
            changed_ci_base = tree(baseline, [(changed_ci, source_bytes[changed_ci] + b"\n# base CI drift\n", "100644")])
            changed_ci_tree = git("merge-tree", "--write-tree", changed_ci_base, feature).splitlines()[0]
            changed_ci_merge = git("commit-tree", changed_ci_tree, "-p", changed_ci_base, "-p", feature,
                                   "-m", "owned CI-changing base advance")
            decision(baseline, feature, True, "advanced first parent changed validator inventory",
                     checkout=changed_ci_merge)
            sibling_base = tree(source_parent, [("docs/owned-sibling-base.md", "sibling base\n", "100644")])
            sibling_tree = git("merge-tree", "--write-tree", sibling_base, feature).splitlines()[0]
            sibling_merge = git("commit-tree", sibling_tree, "-p", sibling_base, "-p", feature,
                                "-m", "owned unrelated first parent")
            decision(baseline, feature, True, "unrelated first parent", checkout=sibling_merge)
            decision(baseline, baseline, True, "empty diff")
            for path in source_paths:
                changed = tree(baseline, [(path, source_bytes[path] + b"\n# owned validator input\n", "100644")])
                decision(baseline, changed, True, ("changed validator", path))
                left = tree(baseline, [(path, source_bytes[path] + b"\n# owned validator input\n", "100644")])
                decision(left, feature, True, ("base-only validator drift", path))
            for extension in ("yml", "yaml"):
                added = tree(baseline, [(f".github/workflows/owned-validation.{extension}", "name: owned\n", "100644")])
                decision(baseline, added, True, ("new workflow extension", extension))
            for path in (".github/workflows/ci.yml", "packages/daemon/tests/hooks/fixtures/build-hook-corpus.ts"):
                deleted = tree(baseline, removals=(path,))
                decision(baseline, deleted, True, ("validator deletion", path))
                renamed = tree(baseline, [(path + ".moved", source_bytes[path], "100644")], (path,))
                decision(baseline, renamed, True, ("validator old rename path", path))
                mode = tree(baseline, [(path, source_bytes[path], "100755")])
                decision(baseline, mode, True, ("validator mode", path))
            typed = tree(baseline, [("packages/daemon/src/owned-validation-link.ts", "owned-target", "120000")])
            decision(baseline, typed, True, "unknown symlink mode")
            mode_base = tree(baseline, [("packages/daemon/src/owned-validation-mode.ts", "export {};\n", "100644")])
            mode_head = tree(mode_base, [("packages/daemon/src/owned-validation-mode.ts", "export {};\n", "100755")])
            decision(mode_base, mode_head, True, "non-validator mode change")
            for name in ("push", "workflow_dispatch", "pull_request_target", "unknown", None):
                decision(baseline, feature, True, ("unknown event", name), environment={"GITHUB_EVENT_NAME": name})
            for event in ({}, {"pull_request": None}, {"pull_request": {"base": {"sha": baseline}, "head": {"sha": None}}},
                          {"pull_request": {"base": {"sha": "f" * 40}, "head": {"sha": feature}}},
                          {"pull_request": {"base": {"sha": baseline}, "head": {"sha": "HEAD"}}}):
                decision(baseline, feature, True, ("invalid event/ref", event), event=event)
            decision(baseline, feature, True, "event path absent", environment={"GITHUB_EVENT_PATH": None})
            decision(baseline, feature, True, "event unreadable", environment={"GITHUB_EVENT_PATH": str(container / "absent")})
            for environment in ({"GITHUB_SHA": None}, {"GITHUB_SHA": baseline}, {"GITHUB_WORKSPACE": None},
                                {"GITHUB_WORKSPACE": str(container)}, {"GIT_DIR": str(repo / ".git")}):
                decision(baseline, feature, True, ("unknown checkout context", environment), environment=environment)
            decision(baseline, feature, True, "CLI refs disagree", args=("--base", feature, "--head", baseline))
            reversed_merge = git("commit-tree", merged_tree, "-p", feature, "-p", unrelated_base, "-m", "wrong parent order")
            decision(unrelated_base, feature, True, "unexpected merge parents", checkout=reversed_merge)
            extra_parent_merge = git("commit-tree", merged_tree, "-p", unrelated_base, "-p", feature,
                                     "-p", baseline, "-m", "unexpected extra parent")
            decision(unrelated_base, feature, True, "unexpected extra merge parent", checkout=extra_parent_merge)

            def overwrite(path, data):
                target = Path(path)
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(data)

            for body, label in ((b"{", "malformed JSON"), (b"\xff", "malformed event UTF8"),
                                (b'{"pull_request":null,"pull_request":{}}', "duplicate event key")):
                decision(baseline, feature, True, label,
                         dirty=lambda body=body: overwrite(container / "event.json", body))
            decision(baseline, feature, True, "dirty validator bytes",
                     dirty=lambda: overwrite(".github/ci-scope.md", b"dirty validator input\n"))
            decision(baseline, feature, True, "untracked ignored workflow",
                     dirty=lambda: (overwrite(".git/info/exclude", b"owned-extra.yaml\n"),
                                    overwrite(".github/workflows/owned-extra.yaml", b"name: owned\n")))
            git("clean", "-fdx", "-q")
            decision(baseline, feature, True, "untracked ignored CI script",
                     dirty=lambda: (overwrite(".git/info/exclude", b"owned-reader.py\n"),
                                    overwrite(".github/scripts/owned-reader.py", b"# owned reader\n")))
            git("clean", "-fdx", "-q")
            decision(baseline, feature, True, "shallow input history",
                     dirty=lambda: overwrite(".git/shallow", (baseline + "\n").encode()))
            Path(".git/shallow").unlink()
            decision(baseline, feature, True, "partial clone context",
                     dirty=lambda: git("config", "extensions.partialClone", "owned"))
            git("config", "--unset", "extensions.partialClone")
            for content, label in ((b"\xff", "UTF8"), (b"owned\0input", "NUL")):
                malformed = tree(baseline, [(".github/ci-scope.md", content, "100644")])
                malformed_feature = tree(malformed, [("docs/owned-malformed-feature.md", "feature\n", "100644")])
                decision(malformed, malformed_feature, True, ("unchanged malformed validator", label))

            # Preserve complete public history in private loose stores before withholding/corrupting objects.
            git("checkout", "--quiet", "--force", "--detach", feature)
            pack = subprocess.check_output(["git", "pack-objects", "--stdout", "--revs"],
                                           input=(feature + "\n").encode(), stderr=subprocess.PIPE)
            pristine = container / "pristine"
            pristine.mkdir()
            os.chdir(pristine)
            git("init", "-q")
            subprocess.run(["git", "unpack-objects"], input=pack, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            git("checkout", "--quiet", "--detach", feature)
            os.chdir(repo)
            original_blob = module["ACCOUNTING_ORIGINALS"]["scripts/tunnel-storage-proof/reservations.ts"]
            missing = [module["VALIDATION_PUBLIC_ROOTS"][0], original_blob,
                       git("rev-parse", f"{module['VALIDATION_PUBLIC_ROOTS'][0]}^{{tree}}"),
                       git("rev-parse", f"{feature}:.github/scripts/check-scope-output.py")]
            for oid in missing:
                private = container / ("missing-" + oid[:8])
                shutil.copytree(pristine, private)
                (private / ".git/objects" / oid[:2] / oid[2:]).unlink()
                os.chdir(private)
                decision(baseline, feature, True, ("unavailable declared object", oid), prepared=True)
                os.chdir(repo)
            oid = original_blob
            private = container / "corrupt"
            shutil.copytree(pristine, private)
            corrupt_object = private / ".git/objects" / oid[:2] / oid[2:]
            corrupt_object.chmod(0o600)
            corrupt_object.write_bytes(zlib.compress(b"blob 5\0owned"))
            os.chdir(private)
            decision(baseline, feature, True, "corrupt public object identity", prepared=True)
            os.chdir(repo)

            # Alter both a contract copy and action: literal-false and always-on guards must still refuse.
            saved_contract = WORKFLOW_TOOLS["CONTRACTS"]["scope_action"]
            action = yaml.load(ACTION, Loader=WORKFLOW_TOOLS["UniqueLoader"])
            mutations = []
            for condition in ("steps.validation.outputs.validation_required == 'true'", "false", "", "success()"):
                altered = copy.deepcopy(action)
                altered["runs"]["steps"][3]["if"] = condition
                mutations.append(altered)
            for index in (0, 1, 2, 5, 6):
                altered = copy.deepcopy(action)
                altered["runs"]["steps"][index]["if"] = "steps.validation.outputs.validation_required != 'false'"
                mutations.append(altered)
            for index in (2, 3, 4, 5, 6):
                altered = copy.deepcopy(action)
                altered["runs"]["steps"][index]["continue-on-error"] = "true"
                mutations.append(altered)
            try:
                for altered in mutations:
                    WORKFLOW_TOOLS["CONTRACTS"]["scope_action"] = altered
                    try:
                        WORKFLOW_TOOLS["validate_action"](altered)
                    except AssertionError:
                        count += 1
                    else:
                        raise AssertionError("unsafe validator action accepted")
            finally:
                WORKFLOW_TOOLS["CONTRACTS"]["scope_action"] = saved_contract
        finally:
            os.chdir(previous)


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
        fixture_paths = tuple(SOAK_FINAL_CONTENT)[:2]  # Retain the original 643 control scenarios.
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


        # The third reviewed fixture alone or with either/both prior fixtures omits only the soak.
        auth_paths = (*fixture_paths, SOAK_AUTH_PATH)
        for choices in ((SOAK_AUTH_PATH,), (fixture_paths[0], SOAK_AUTH_PATH),
                        (fixture_paths[1], SOAK_AUTH_PATH), auth_paths):
            for docs in (False, True):
                updates = fixture_updates(choices)
                if docs:
                    updates.append(("docs/owned-auth-note.md", "ordinary prose\n", "100644"))
                result = classify(soak_base, soak_tree(soak_base, updates))
                assert selected(result) == gates and not result["relay_soak"], (choices, result)
                count += 1
        for first, second in ((SOAK_AUTH_PATH, fixture_paths[0]), (fixture_paths[0], SOAK_AUTH_PATH),
                              (SOAK_AUTH_PATH, fixture_paths[1]), (fixture_paths[1], SOAK_AUTH_PATH)):
            old = soak_tree(soak_base, fixture_updates((first,)))
            result = classify(old, soak_tree(old, fixture_updates((second,))))
            assert selected(result) == gates and not result["relay_soak"]
            count += 1
        for state in ("body", "wrong-base", "deleted", "renamed", "mode", "symlink", "addition"):
            old, changes, removals = soak_base, fixture_updates((SOAK_AUTH_PATH,)), ()
            if state == "body":
                changes = [(SOAK_AUTH_PATH, auth_final + "\n// unreviewed test body\n", "100644")]
            elif state == "wrong-base":
                old = soak_tree(soak_base, [(SOAK_AUTH_PATH, auth_original + "\n// unreviewed original\n", "100644")])
            elif state == "deleted":
                changes, removals = [], (SOAK_AUTH_PATH,)
            elif state == "renamed":
                changes, removals = [("docs/moved-auth-fixture.md", auth_final, "100644")], (SOAK_AUTH_PATH,)
            elif state == "mode":
                changes = [(SOAK_AUTH_PATH, auth_final, "100755")]
            elif state == "symlink":
                changes = [(SOAK_AUTH_PATH, "owned-target", "120000")]
            elif state == "addition":
                old = soak_tree(soak_base, removals=(SOAK_AUTH_PATH,))
            result = classify(old, soak_tree(old, changes, removals))
            assert selected(result) == gates and result["relay_soak"], (state, result)
            count += 1
        for directory in ("packages/daemon/src", "packages/shared/src", "packages/signaling/src",
                          "packages/web/src", "packages/native", "packages/macos", "tests", "scripts",
                          ".github/scripts", ".github/workflows", ".github/actions"):
            caller = (f"{directory}/auth-fixture-reader.ts", f"import '{SOAK_AUTH_PATH}';\n", "100644")
            for context in ("new", "both", "removed", "target-base-only"):
                old = soak_tree(soak_base, [caller]) if context != "new" else soak_base
                if context == "target-base-only":
                    candidate = soak_tree(soak_base, fixture_updates((SOAK_AUTH_PATH,)))
                else:
                    candidate = soak_tree(old, [*fixture_updates((SOAK_AUTH_PATH,)), *([caller] if context == "new" else [])],
                                          (caller[0],) if context == "removed" else ())
                result = classify(old, candidate)
                assert selected(result) == gates and result["relay_soak"], (directory, context, result)
                count += 1
        for root_path in ("root-auth-loader.ts", "root-auth-config.json", "root-auth-reader.sh"):
            caller = (root_path, f"import './{SOAK_AUTH_PATH}';\n", "100644")
            for context in ("new", "both", "removed", "target-base-only"):
                old = soak_tree(soak_base, [caller]) if context != "new" else soak_base
                if context == "target-base-only":
                    candidate = soak_tree(soak_base, fixture_updates((SOAK_AUTH_PATH,)))
                else:
                    candidate = soak_tree(old, [*fixture_updates((SOAK_AUTH_PATH,)), *([caller] if context == "new" else [])],
                                          (caller[0],) if context == "removed" else ())
                result = classify(old, candidate)
                assert selected(result) == gates and result["relay_soak"], (root_path, context, result)
                count += 1
        for context in ("base", "head"):
            changed_sample = (".env.example", "owned unreviewed public sample\n", "100644")
            old = soak_tree(soak_base, [changed_sample]) if context == "base" else soak_base
            result = classify(old, soak_tree(old, [*fixture_updates((SOAK_AUTH_PATH,)), *([changed_sample] if context == "head" else [])]))
            assert selected(result) == gates and result["relay_soak"]
            count += 1
        for bad_path, data in (("root-auth-invalid.ts", b"\xff"), ("root-auth-nul.ts", b"\0"),
                               (".env.private-auth-owned", b"owned control, never read")):
            old = soak_tree(soak_base, [(bad_path, data, "100644")])
            result = classify(old, soak_tree(old, fixture_updates((SOAK_AUTH_PATH,))))
            assert selected(result) == gates and result["relay_soak"]
            count += 1
        for comment_path, pin in module["SOAK_AUTH_COMMENTS"].items():
            original_comment = subprocess.check_output(["git", "show", f"{soak_base}:{comment_path}"]).decode()
            for state in ("base-comment", "head-comment", "base-caller", "head-caller"):
                body = original_comment + ("\n// changed commentary\n" if "comment" in state else
                                             f"\nimport '{SOAK_AUTH_PATH}';\n")
                changed_comment = (comment_path, body, "100644")
                old = soak_tree(soak_base, [changed_comment]) if state.startswith("base") else soak_base
                candidate = soak_tree(old, [*fixture_updates((SOAK_AUTH_PATH,)),
                                           *([changed_comment] if state.startswith("head") else [])])
                result = classify(old, candidate)
                assert selected(result) == gates and result["relay_soak"], (comment_path, state, result)
                count += 1
        # Paired private stores validate actual immutable comment readability, with no shared-object removal.
        auth_pin_paths = {**module["SOAK_TRACE"], **{path: pin[0] for path, pin in module["SOAK_AUTH_COMMENTS"].items()}}
        auth_pin_paths.update({path: blobs[0] for path, blobs in module["SOAK_FIXTURES"].items()})
        for path in module["SOAK_VERSION_TRACE"]:
            auth_pin_paths[path] = git("rev-parse", f"{soak_base}:{path}")
        auth_objects = {blob: subprocess.check_output(["git", "cat-file", "blob", blob]) for blob in auth_pin_paths.values()}
        auth_objects[module["SOAK_FIXTURES"][SOAK_AUTH_PATH][1]] = auth_final.encode()
        public_sample = subprocess.check_output(["git", "cat-file", "blob", module["COLD_PUBLIC_SAMPLE"][1]])
        auth_pin_paths[".env.example"] = module["COLD_PUBLIC_SAMPLE"][1]
        auth_objects[module["COLD_PUBLIC_SAMPLE"][1]] = public_sample
        for omitted_path in (None, *module["SOAK_AUTH_COMMENTS"], ".env.example"):
            omitted = auth_pin_paths.get(omitted_path)
            corpus_dir = Path.cwd()
            with tempfile.TemporaryDirectory(prefix="auth-missing-comment-") as private:
                try:
                    os.chdir(private)
                    git("init", "-q")
                    git("config", "user.name", "Owned auth comment control")
                    git("config", "user.email", "test@example.com")
                    for blob, data in auth_objects.items():
                        if blob != omitted:
                            assert git("hash-object", "-w", "--stdin", input=data.decode()) == blob
                    refs = []
                    for final in (False, True):
                        git("read-tree", "--empty")
                        for path, blob in auth_pin_paths.items():
                            if final and path == SOAK_AUTH_PATH:
                                blob = module["SOAK_FIXTURES"][path][1]
                            git("update-index", "--add", "--cacheinfo", f"100644,{blob},{path}")
                        tree = git("write-tree", "--missing-ok")
                        refs.append(git("commit-tree", tree, *(["-p", refs[0]] if refs else []), "-m", "owned comment object control"))
                    result = classify(*refs)
                    assert selected(result) == gates and result["relay_soak"] == (omitted_path is not None), (omitted_path, result)
                    count += 1
                finally:
                    os.chdir(corpus_dir)

        # Full actual published trees: A, B from A, and the ordered combined A -> B diff.
        git("fetch", "--quiet", "--no-tags", str(original), COLD_FULL_BASE)
        def cold_updates(phase):
            policy = module["COLD_RELOCATIONS"][phase]
            return [(path, text, policy["head"][path][0]) for path, text in COLD_CONTENT[phase].items()]
        descriptor_base = COLD_FULL_BASE
        descriptor_head = soak_tree(descriptor_base, cold_updates("descriptor"))
        journal_base = descriptor_head
        journal_head = soak_tree(journal_base, cold_updates("journal"))
        for left, right in ((descriptor_base, descriptor_head), (journal_base, journal_head),
                            (descriptor_base, journal_head)):
            result = classify(left, right)
            assert selected(result) == WRAPPER_GATES and not result["relay_soak"], (left, right, result)
            count += 1
        worker_path = "packages/signaling/src/connection-room.ts"
        worker_text = subprocess.check_output(["git", "show", f"{descriptor_base}:{worker_path}"]).decode()
        assert "from './admission.ts'" in worker_text
        assert not module["cold_reference"](worker_path, worker_text,
                   set(module["COLD_RELOCATIONS"]["descriptor"]["head"]),
                   module["COLD_RELOCATIONS"]["descriptor"]["identifiers"])
        result = classify(descriptor_base, descriptor_head)
        assert selected(result) == WRAPPER_GATES and not result["relay_soak"]
        count += 1
        # Lowercase fields and longer identifiers do not claim the actual tunnel API.
        for phase, left in (("descriptor", descriptor_base), ("journal", journal_base)):
            policy = module["COLD_RELOCATIONS"][phase]
            updates = cold_updates(phase)
            def cold_expect_all(target_base, candidate, context, phase=phase):
                result = classify(target_base, candidate)
                assert selected(result) == gates and result["relay_soak"], (phase, context, result)
            for content in ("const admission = { recovery: true };\n",
                            "const clientDirectoryRoot = true; const clientRecoveryOps = true;\n",
                            "import './unrelated/admission.ts'; import './unrelated/recovery.ts';\n"):
                caller = ("packages/daemon/src/cold-nonconsumer.ts", content, "100644")
                unchanged = soak_tree(left, [caller])
                result = classify(unchanged, soak_tree(unchanged, updates))
                assert selected(result) == WRAPPER_GATES and not result["relay_soak"], (phase, content, result)
                count += 1
            # Exact API names, relative imports, namespace/re-export/require and the real alias.
            target = COLD_DAEMON + ("admission.ts" if phase == "descriptor" else "recovery.ts")
            for content in (f"import '../tunnel/{Path(target).name}';\n",
                            f"export * from '../tunnel/{Path(target).name}';\n",
                            f"import * as candidate from '@remi/daemon/tunnel/{Path(target).stem}';\n",
                            f"const candidate = require('../tunnel/{Path(target).name}');\n",
                            f"const candidate = import('../tunnel/{Path(target).name}');\n",
                            f"import '{Path(target).stem}';\n",
                            f"import '@remi/daemon/./tunnel/{Path(target).stem}';\n",
                            f"import '@remi/daemon/tunnel/../tunnel/{Path(target).stem}';\n",
                            "import '../tunnel/" + r"\u" + f"{ord(Path(target).stem[0]):04x}" + Path(target).stem[1:] + ".ts';\n",
                            "import '@remi/daemon/tunnel/" + r"\u{" + f"{ord(Path(target).stem[0]):x}" + "}" + Path(target).stem[1:] + ".ts';\n",
                            "import '../tunnel/" + r"\x" + f"{ord(Path(target).stem[0]):02x}" + Path(target).stem[1:] + ".ts';\n",
                            f"const path = '{target}';\n",
                            f"import/* owned */'../tunnel/{Path(target).name}';\n",
                            f"export * from/* owned */'../tunnel/{Path(target).name}';\n",
                            f"const candidate = require/* owned */(/* owned */'../tunnel/{Path(target).name}');\n",
                            f"const candidate = import/* owned */(/* owned */'../tunnel/{Path(target).name}');\n"):
                caller = ("packages/daemon/src/entry/cold-consumer.ts", content, "100644")
                for context in ("new", "both", "removed", "target-base-only"):
                    old = soak_tree(left, [caller]) if context != "new" else left
                    if context == "target-base-only":
                        candidate = soak_tree(left, updates)
                    else:
                        candidate = soak_tree(old, [*updates, *([caller] if context == "new" else [])],
                                              (caller[0],) if context == "removed" else ())
                    cold_expect_all(old, candidate, (content, context))
                    count += 1
            for identifier in policy["identifiers"]:
                path = "packages/native/RemiKit/cold-consumer.swift"
                caller = (path, f"// {identifier}\n", "100644")
                old = soak_tree(left, [caller])
                cold_expect_all(old, soak_tree(old, updates), identifier)
                count += 1
            for directory in ("packages/shared/src", "packages/signaling/src", "packages/web/src",
                              "packages/macos", "tests", "scripts", ".github/scripts",
                              ".github/workflows", ".github/actions", ".github/administration"):
                caller = (f"{directory}/cold-reader.yml", f"run: bun test {target}\n", "100644")
                for context in ("new", "both", "removed", "target-base-only"):
                    old = soak_tree(left, [caller]) if context != "new" else left
                    if context == "target-base-only":
                        candidate = soak_tree(left, updates)
                    else:
                        candidate = soak_tree(old, [*updates, *([caller] if context == "new" else [])],
                                              (caller[0],) if context == "removed" else ())
                    cold_expect_all(old, candidate, (directory, context))
                    count += 1
            for root_path in ("root-cold-entry.ts", "root-cold-config.json", "root-cold-launch.sh"):
                caller = (root_path, f"./{target}\n", "100644")
                for context in ("new", "both", "removed", "target-base-only"):
                    old = soak_tree(left, [caller]) if context != "new" else left
                    if context == "target-base-only":
                        candidate = soak_tree(left, updates)
                    else:
                        candidate = soak_tree(old, [*updates, *([caller] if context == "new" else [])],
                                              (caller[0],) if context == "removed" else ())
                    cold_expect_all(old, candidate, (root_path, context))
                    count += 1
            # Every exact producer must transition with its reviewed body and regular mode.
            for producer in policy["head"]:
                without = [u for u in updates if u[0] != producer]
                for state in ("body", "exports", "missing", "deleted", "renamed", "mode", "symlink", "base-state"):
                    old, changes, removals = left, list(without), ()
                    content = COLD_CONTENT[phase][producer]
                    if state == "body":
                        changes.append((producer, content + "\n// unreviewed body\n", policy["head"][producer][0]))
                    elif state == "exports":
                        changes.append((producer, content + "\nexport const unreviewed = true;\n", policy["head"][producer][0]))
                    elif state == "deleted":
                        removals = (producer,)
                    elif state == "renamed":
                        removals = (producer,)
                        changes.append(("docs/cold-renamed.txt", content, policy["head"][producer][0]))
                    elif state == "mode":
                        mode = "100755" if policy["head"][producer][0] == "100644" else "100644"
                        changes.append((producer, content, mode))
                    elif state == "symlink":
                        changes.append((producer, "owned-target", "120000"))
                    elif state == "base-state":
                        old = soak_tree(left, [(producer, content + "\n// wrong original\n", policy["head"][producer][0])])
                        changes = updates
                    cold_expect_all(old, soak_tree(old, changes, removals), (producer, state))
                    count += 1
            # Excluded known consumers/dependencies have immutable whole-file provenance.
            for consumer, pin in policy["original"].items():
                body = subprocess.check_output(["git", "show", f"{left}:{consumer}"]).decode()
                for endpoint in ("base", "head"):
                    changed_consumer = (consumer, body + "\n// unreviewed consumer\n", pin[0])
                    old = soak_tree(left, [changed_consumer]) if endpoint == "base" else left
                    candidate = soak_tree(old, [*updates, *([changed_consumer] if endpoint == "head" else [])])
                    cold_expect_all(old, candidate, (consumer, endpoint))
                    count += 1
            for mixed in ("packages/daemon/src/cli.ts", "packages/daemon/src/tunnel/index.ts",
                          "scripts/tunnel-storage-proof/recovery-native.c", "packages/shared/src/index.ts",
                          "package.json", "docs/PROVISIONING.md", "docs/relay-r7-gates.md", "_typos.toml"):
                candidate = soak_tree(left, [*updates, (mixed, "unreviewed runtime input\n", "100644")])
                cold_expect_all(left, candidate, mixed)
                count += 1
            for bad, data, mode in (("scripts/invalid.py", b"\xff", "100644"),
                                    ("packages/shared/src/invalid.ts", b"\0", "100644"),
                                    ("packages/shared/alias", b"owned", "120000"),
                                    ("packages/shared/credentials", b"never read", "100644"),
                                    (".env.private-owned", b"owned control, never read", "100644")):
                old = soak_tree(left, [(bad, data, mode)])
                cold_expect_all(old, soak_tree(old, updates), bad)
                count += 1
            git("read-tree", left)
            git("update-index", "--add", "--cacheinfo", "100644," + "f" * 40 + ",scripts/unreadable.ts")
            missing_tree = git("write-tree", "--missing-ok")
            missing_base = git("commit-tree", missing_tree, "-p", left, "-m", "missing cold scan blob")
            cold_expect_all(missing_base, soak_tree(missing_base, updates), "missing object")
            count += 1
            assert not module["cold_relocation_paths"](left, "f" * 40, left, list(policy["head"]))
            count += 1
            git("read-tree", left)
            git("update-index", "--add", "--cacheinfo", f"160000,{left},packages/shared/owned-submodule")
            submodule_tree = git("write-tree")
            submodule_base = git("commit-tree", submodule_tree, "-p", left, "-m", "owned submodule reference")
            cold_expect_all(submodule_base, soak_tree(submodule_base, updates), "submodule")
            count += 1
            old = soak_tree(left, [("docs/owned-alias.md", "owned-target", "120000")])
            cold_expect_all(old, soak_tree(old, updates), "ordinary-doc symlink")
            count += 1
            for context in ("base", "head"):
                changed_sample = (".env.example", "unreviewed public sample\n", "100644")
                old = soak_tree(left, [changed_sample]) if context == "base" else left
                candidate = soak_tree(old, [*updates, *([changed_sample] if context == "head" else [])])
                cold_expect_all(old, candidate, ("public sample", context))
                count += 1
            # Private object stores prove exclusions cannot hide unreadable pinned blobs.
            all_pins = {**policy["original"], **policy["head"]}
            object_bytes = {pin[1]: subprocess.check_output(["git", "cat-file", "blob", pin[1]])
                            for pin in (*policy["original"].values(), *policy["head"].values())}
            sample_bytes = subprocess.check_output(["git", "cat-file", "blob", module["COLD_PUBLIC_SAMPLE"][1]])
            known = next(path for path in policy["original"] if path not in policy["head"])
            modified = next(path for path in policy["head"] if path in policy["original"])
            added = next(path for path in policy["head"] if path not in policy["original"])
            missing_cases = [("complete", None), ("original", modified), ("original", known), ("head", added)]
            if phase == "descriptor":
                missing_cases.append(("original", COLD_PROOF + "storage-approval-mutations.py"))
            for endpoint, path in missing_cases:
                omitted = policy[endpoint][path][1] if endpoint != "complete" else None
                corpus_dir = Path.cwd()
                with tempfile.TemporaryDirectory(prefix="cold-missing-pin-") as private:
                    try:
                        os.chdir(private)
                        git("init", "-q")
                        git("config", "user.name", "Owned missing object control")
                        git("config", "user.email", "test@example.com")
                        for blob, data in object_bytes.items():
                            if blob != omitted:
                                assert git("hash-object", "-w", "--stdin", input=data.decode()) == blob
                        sample = git("hash-object", "-w", "--stdin", input=sample_bytes.decode())
                        refs = []
                        for pins in (policy["original"], all_pins):
                            git("read-tree", "--empty")
                            git("update-index", "--add", "--cacheinfo", f"100644,{sample},.env.example")
                            for name, pin in pins.items():
                                git("update-index", "--add", "--cacheinfo", f"{pin[0]},{pin[1]},{name}")
                            tree = git("write-tree", "--missing-ok")
                            refs.append(git("commit-tree", tree, *(["-p", refs[0]] if refs else []),
                                            "-m", "owned missing pinned object"))
                        if endpoint == "complete":
                            result = classify(refs[0], refs[1])
                            assert selected(result) == WRAPPER_GATES and not result["relay_soak"], (phase, result)
                        else:
                            assert not module["cold_relocation_paths"](refs[0], refs[1], refs[0], list(policy["head"]))
                            cold_expect_all(refs[0], refs[1], ("missing pinned object", endpoint, path))
                        count += 1
                    finally:
                        os.chdir(corpus_dir)
            # Ordinary prose companions are allowed; changing execution is handled above.
            candidate = soak_tree(left, [*updates, ("docs/owned-cold-note.md", "ordinary prose\n", "100644")])
            result = classify(left, candidate)
            assert selected(result) == WRAPPER_GATES and not result["relay_soak"]
            count += 1
            # Only the exact new declaration prefix qualifies; runtime bodies remain unchanged.
            test_path = next(path for path in policy["head"] if path.endswith("-adoption.test.ts"))
            declared = COLD_CONTENT[phase][test_path]
            prefix = '/// <reference path="../../../../scripts/tunnel-storage-proof/assets.d.ts" />\n'
            assert declared.startswith(prefix)
            for state, body in (("removed", declared.removeprefix(prefix)),
                                ("altered", declared.replace("assets.d.ts", "unreviewed-assets.d.ts", 1))):
                candidate = soak_tree(left, [*(u for u in updates if u[0] != test_path), (test_path, body, "100644")])
                cold_expect_all(left, candidate, ("declaration", state))
                count += 1
            asset_path = "scripts/tunnel-storage-proof/assets.d.ts"
            asset_body = subprocess.check_output(["git", "show", f"{left}:{asset_path}"]).decode()
            for state in ("base-changed", "head-changed", "base-missing", "head-missing", "base-mode", "head-mode"):
                old, changes, removals = left, list(updates), ()
                change = (asset_path, asset_body + "\n// unreviewed declaration\n" if state.endswith("changed") else asset_body,
                          "100755" if state.endswith("mode") else "100644")
                if state.startswith("base"):
                    old = soak_tree(left, [] if state.endswith("missing") else [change],
                                    (asset_path,) if state.endswith("missing") else ())
                elif state.endswith("missing"):
                    removals = (asset_path,)
                else:
                    changes.append(change)
                cold_expect_all(old, soak_tree(old, changes, removals), ("declaration asset", state))
                count += 1
        # Exact helper relocation: one declared deletion, exact C assets and fixed caller provenance.
        git("fetch", "--quiet", "--no-tags", str(original), NATIVE_FULL_BASE)
        native_policy = module["COLD_RELOCATIONS"]["native-helper"]
        native_updates = [(path, text, native_policy["head"][path][0]) for path, text in NATIVE_CONTENT.items()]
        native_base = NATIVE_FULL_BASE
        native_head = soak_tree(native_base, native_updates, (NATIVE_REMOVED_C,))
        def native_all(left, candidate, context):
            result = classify(left, candidate)
            assert selected(result) == gates and result["relay_soak"], ("native-helper", context, result)
        result = classify(native_base, native_head)
        assert selected(result) == WRAPPER_GATES and not result["relay_soak"], result
        count += 1
        for note in ("docs/owned-native-note.md", "CHANGELOG"):
            candidate = soak_tree(native_base, [*native_updates, (note, "ordinary prose\n", "100644")], (NATIVE_REMOVED_C,))
            result = classify(native_base, candidate)
            assert selected(result) == WRAPPER_GATES and not result["relay_soak"], result
            count += 1
        # Same basename elsewhere is a genuine nonconsumer; longer identifiers also stay distinct.
        for content in ("import './unrelated/recovery-native.c';\n",
                        "import '@remi/daemon/unrelated/recovery-native.c';\n",
                        "const clientrecoveryNative = true;\n"):
            left = soak_tree(native_base, [("packages/daemon/src/native-nonconsumer.ts", content, "100644")])
            result = classify(left, soak_tree(left, native_updates, (NATIVE_REMOVED_C,)))
            assert selected(result) == WRAPPER_GATES and not result["relay_soak"], (content, result)
            count += 1
        # Relative/alias literal C imports and qualified config readers at both endpoints.
        consumer_cases = (
            ("packages/daemon/src/native-reader.ts", "import './tunnel/recovery-native.c';\n"),
            ("packages/daemon/src/native-reader.ts", "export { default } from './tunnel/recovery-native.c';\n"),
            ("packages/daemon/src/native-reader.ts", "require /* owned */ ('./tunnel/recovery-native.c');\n"),
            ("packages/daemon/src/native-reader.ts", "import /* owned */ ('@remi/daemon/tunnel/recovery-native.c');\n"),
            ("packages/daemon/src/native-reader.ts", r"import './tunnel/recovery-nativ\u0065.c';" + "\n"),
            ("packages/daemon/src/native-reader.ts", r"import '@remi/daemon/tunnel/recovery-nativ\x65.c';" + "\n"),
            ("packages/daemon/src/native-reader.ts", r"import './tunnel/recovery-nativ\q.c';" + "\n"),
            ("packages/daemon/src/native-reader.ts", "import 'recovery-" + "native"[:-1] + r"\e.c';" + "\n"),
            ("packages/daemon/src/native-reader.ts", "import '@remi/daemon/unrelated/../tunnel/recovery-native.c';\n"),
            ("scripts/native-reader.ts", "import './tunnel-storage-proof/recovery-native.c';\n"),
            ("scripts/native-reader.ts", r"import './tunnel-storage-proof/recovery-nativ\u{65}.c';" + "\n"),
            ("root-native-config.json", '"packages/daemon/src/tunnel/recovery-native.c"\n'),
            ("root-native-config.json", r'"packages/daemon/src/tunnel/recovery-nativ\u0065.c"' + "\n"),
            ("root-native-config.json", r'"packages\/daemon/src/tunnel/recovery-native.c"' + "\n"),
            ("root-native-config.json", r'"packages/daemon/src/tunnel/recovery-nativ\e.c"' + "\n"),
            ("root-native-launch.sh", "cc scripts/tunnel-storage-proof/recovery-native.c\n"),
            ("packages/native/native-reader.swift", "// recoveryNative\n"),
            ("packages/daemon/src/native-reader.ts", "import './tunnel/recovery-native';\n"),
        )
        # Production cannot launch the helper through these exact verified proof/test callers.
        proof_modules = ("recovery-probe", "settlement-probe", "recovery-entry", "settlement-entry")
        consumer_cases += tuple(
            ("packages/daemon/src/native-reader.ts", f"import '../../../scripts/tunnel-storage-proof/{name}.ts';\n")
            for name in proof_modules
        )
        consumer_cases += (
            ("packages/daemon/src/native-reader.ts", "import '../../../scripts/tunnel-storage-proof/recovery-probe.js';\n"),
            ("packages/daemon/src/native-reader.ts", "require /* owned */ ('../../../scripts/tunnel-storage-proof/settlement-probe');\n"),
            ("packages/daemon/src/native-reader.ts", r"import '../../../scripts/tunnel-storage-proof/recovery-\u0070robe';" + "\n"),
            ("packages/daemon/src/native-reader.ts", "import '@remi/daemon/../../../scripts/tunnel-storage-proof/recovery-entry';\n"),
        )
        consumer_cases += tuple(
            ("packages/daemon/src/native-reader.ts", f"import '../tests/tunnel/{name}.js';\n")
            for name in ("descriptors-adoption.test", "journal-adoption.test", "native-helper-adoption.test")
        )
        consumer_cases += tuple(
            ("packages/daemon/src/native-reader.ts", f"const launch = '{target}';\n")
            for target in sorted(module["COLD_NATIVE_CALLERS"])
        )
        for caller_path, content in consumer_cases:
            caller = (caller_path, content, "100644")
            for context in ("new", "both", "removed", "target-base-only"):
                left = soak_tree(native_base, [caller]) if context != "new" else native_base
                if context == "target-base-only":
                    candidate = soak_tree(native_base, native_updates, (NATIVE_REMOVED_C,))
                else:
                    candidate = soak_tree(left, [*native_updates, *([caller] if context == "new" else [])],
                                          (NATIVE_REMOVED_C, *([caller_path] if context == "removed" else [])))
                native_all(left, candidate, (content, context))
                count += 1
        for producer, content in NATIVE_CONTENT.items():
            without = [update for update in native_updates if update[0] != producer]
            for state in ("body", "missing", "deleted", "renamed", "mode", "symlink", "base-state"):
                left, updates, removals = native_base, list(without), [NATIVE_REMOVED_C]
                if state == "body":
                    updates.append((producer, content + "\n// unreviewed body\n", "100644"))
                elif state == "deleted":
                    removals.append(producer)
                elif state == "renamed":
                    removals.append(producer)
                    updates.append(("docs/native-renamed.txt", content, "100644"))
                elif state in ("mode", "symlink"):
                    updates.append((producer, content if state == "mode" else "owned-target", "100755" if state == "mode" else "120000"))
                elif state == "base-state":
                    left = soak_tree(native_base, [(producer, content + "\n// wrong original\n", "100644")])
                    updates = native_updates
                native_all(left, soak_tree(left, updates, removals), (producer, state))
                count += 1
        # The sole D pin requires the reviewed original regular blob and exact head absence.
        original_c = COLD_ORIGINAL_CONTENT[NATIVE_REMOVED_C]
        native_all(native_base, soak_tree(native_base, native_updates), "old C restored")
        count += 1
        native_all(native_head, soak_tree(native_head, [], (), source=native_base), "reversed relocation")
        count += 1
        for state, body, mode, missing in (
                ("changed", original_c + "\n/* changed */\n", "100644", False),
                ("mode", original_c, "100755", False),
                ("symlink", "owned-target", "120000", False),
                ("missing", original_c, "100644", True)):
            left = soak_tree(native_base, [] if missing else [(NATIVE_REMOVED_C, body, mode)], (NATIVE_REMOVED_C,) if missing else ())
            native_all(left, soak_tree(left, native_updates, (NATIVE_REMOVED_C,)), ("old C", state))
            count += 1
        for caller, pin in native_policy["original"].items():
            text = subprocess.check_output(["git", "show", f"{native_base}:{caller}"]).decode()
            for endpoint in ("base", "head"):
                changed = (caller, text + "\n// unreviewed known consumer\n", pin[0])
                left = soak_tree(native_base, [changed]) if endpoint == "base" else native_base
                updates = [*native_updates, *([changed] if endpoint == "head" else [])]
                removals = () if endpoint == "head" and caller == NATIVE_REMOVED_C else (NATIVE_REMOVED_C,)
                native_all(left, soak_tree(left, updates, removals), (caller, endpoint))
                count += 1
        for other in ("descriptor", "journal"):
            mixed = cold_updates(other)
            path, text, mode = mixed[0]
            mixed[0] = (path, text + "\n// distinct simultaneous producer change\n", mode)
            native_all(native_base, soak_tree(native_base, [*native_updates, *mixed], (NATIVE_REMOVED_C,)), ("composition", other))
            count += 1
        for path, data, mode in (("root-native-invalid.json", b"\xff", "100644"),
                                 ("scripts/native-invalid.py", b"\0", "100644"),
                                 ("packages/native/owned-alias", b"owned", "120000"),
                                 (".env.private-native", b"owned, never read", "100644")):
            for context in ("base", "head"):
                left = soak_tree(native_base, [(path, data, mode)]) if context == "base" else native_base
                updates = [*native_updates, *([(path, data, mode)] if context == "head" else [])]
                native_all(left, soak_tree(left, updates, (NATIVE_REMOVED_C,)), (path, context))
                count += 1
        # Actual missing objects at both scan endpoints, including the deleted original C.
        object_bytes = {pin[1]: subprocess.check_output(["git", "cat-file", "blob", pin[1]])
                        for pin in native_policy["original"].values()}
        for path, text in NATIVE_CONTENT.items():
            pin = native_policy["head"][path]
            object_bytes[pin[1]] = text.encode()
        sample_pin = module["COLD_PUBLIC_SAMPLE"]
        sample_bytes = subprocess.check_output(["git", "cat-file", "blob", sample_pin[1]])
        final_pins = {path: pin for path, pin in {**native_policy["original"], **native_policy["head"]}.items() if pin is not None}
        for endpoint, missing_path in (("complete", None), ("original", NATIVE_REMOVED_C),
                                       ("original", COLD_PROOF + "recovery-probe.ts"),
                                       ("head", COLD_DAEMON + "recovery-native.ts"),
                                       ("head", COLD_DAEMON + "native-assets.d.ts")):
            omitted = native_policy[endpoint][missing_path][1] if endpoint != "complete" else None
            corpus_dir = Path.cwd()
            with tempfile.TemporaryDirectory(prefix="native-missing-pin-") as private:
                try:
                    os.chdir(private)
                    git("init", "-q")
                    git("config", "user.name", "Owned native missing object control")
                    git("config", "user.email", "test@example.com")
                    for blob, data in object_bytes.items():
                        if blob != omitted:
                            assert git("hash-object", "-w", "--stdin", input=data.decode()) == blob
                    assert git("hash-object", "-w", "--stdin", input=sample_bytes.decode()) == sample_pin[1]
                    refs = []
                    for pins in (native_policy["original"], final_pins):
                        git("read-tree", "--empty")
                        git("update-index", "--add", "--cacheinfo", f"{sample_pin[0]},{sample_pin[1]},.env.example")
                        for path, pin in pins.items():
                            git("update-index", "--add", "--cacheinfo", f"{pin[0]},{pin[1]},{path}")
                        tree = git("write-tree", "--missing-ok")
                        refs.append(git("commit-tree", tree, *(["-p", refs[0]] if refs else []), "-m", "owned native missing object"))
                    if endpoint == "complete":
                        result = classify(*refs)
                        assert selected(result) == WRAPPER_GATES and not result["relay_soak"], result
                    else:
                        native_all(refs[0], refs[1], ("missing pinned object", endpoint, missing_path))
                    count += 1
                finally:
                    os.chdir(corpus_dir)
        # D1-specific controls reuse the existing complete actual-Git runner and generic fallback campaign.
        git("fetch", "--quiet", "--no-tags", str(original), IMAGE_FULL_BASE)
        image_policy = module["COLD_RELOCATIONS"]["image-admission"]
        image_updates = [(path, text, image_policy["head"][path][0]) for path, text in IMAGE_CONTENT.items()]
        image_base = IMAGE_FULL_BASE
        image_head = soak_tree(image_base, image_updates)
        def image_all(left, candidate, context):
            result = classify(left, candidate)
            assert selected(result) == gates and result["relay_soak"], ("image-admission", context, result)
        for note in (False, True):
            candidate = soak_tree(image_base, [*image_updates, *([("docs/owned-image-note.md", "ordinary prose\n", "100644")] if note else [])])
            result = classify(image_base, candidate)
            assert selected(result) == WRAPPER_GATES and not result["relay_soak"], result
            count += 1
        for content in ("const clientadmitImage = true; const Dimensions = {};\n",
                        "import './unrelated/image-admission';\n",
                        "import './admission.ts';\n"):
            left = soak_tree(image_base, [("packages/signaling/src/image-nonconsumer.ts", content, "100644")])
            result = classify(left, soak_tree(left, image_updates))
            assert selected(result) == WRAPPER_GATES and not result["relay_soak"], (content, result)
            count += 1
        direct_cases = (
            ("packages/daemon/src/image-reader.ts", "import type { Dimensions } from '../../../scripts/tunnel-decoder-proof/admission';\n"),
            ("packages/daemon/src/image-reader.ts", "export * from './tunnel/image-admission';\n"),
            ("packages/native/image-reader.swift", "// admitImage\n"),
            ("root-image-reader.ts", "const consume = MAX_INPUT_BYTES;\n"),
        )
        for path, text in direct_cases:
            caller = (path, text, "100644")
            for context in ("new", "both", "removed", "target-base-only"):
                left = soak_tree(image_base, [caller]) if context != "new" else image_base
                candidate = soak_tree(image_base, image_updates) if context == "target-base-only" else soak_tree(
                    left, [*image_updates, *([caller] if context == "new" else [])], (path,) if context == "removed" else ())
                image_all(left, candidate, (text, context))
                count += 1
        # Exact traced indirect TS callers are refused only from daemon production source.
        for target in sorted(module["COLD_IMAGE_CALLERS"]):
            specifier = "../../../" + target if target.startswith("scripts/") else "../tests/tunnel/" + Path(target).name
            caller = ("packages/daemon/src/image-reader.ts", f"import '{specifier}';\n", "100644")
            for context in ("both", "target-base-only"):
                left = soak_tree(image_base, [caller])
                candidate = soak_tree(image_base, image_updates) if context == "target-base-only" else soak_tree(left, image_updates)
                image_all(left, candidate, (target, context))
                count += 1
        # Existing resolver spelling rules, plus the exact D1 escaped producer spellings.
        spellings = (
            ("packages/daemon/src/image-reader.ts", r"import '@remi/daemon/tunnel/image-\u0061dmission.js';" + "\n"),
            ("packages/daemon/src/image-reader.ts", "import 'image-" + "\\" + "admission';\n"),
            ("root-image-config.json", r'"scripts/tunnel-decoder-proof/\u0061dmission.ts"' + "\n"),
            ("packages/daemon/src/image-reader.ts", "require /* owned */ ('../../../scripts/tunnel-decoder-proof/decode.js');\n"),
        )
        for path, text in spellings:
            caller = (path, text, "100644")
            for context in ("both", "target-base-only"):
                left = soak_tree(image_base, [caller])
                candidate = soak_tree(image_base, image_updates) if context == "target-base-only" else soak_tree(left, image_updates)
                image_all(left, candidate, (text, context))
                count += 1
        for target in (IMAGE_PROOF + "matrix.py", IMAGE_PROOF + "approval-matrix.py", IMAGE_PROOF + "policy-mutations.py"):
            caller = ("root-image-launch.sh", f"python {target}\n", "100644")
            for context in ("both", "target-base-only"):
                left = soak_tree(image_base, [caller])
                candidate = soak_tree(image_base, image_updates) if context == "target-base-only" else soak_tree(left, image_updates)
                image_all(left, candidate, (target, context))
                count += 1
        # D1 runner asset imports/readers keep their exact .py extension and target identity.
        for target in sorted(module["COLD_IMAGE_RUNNERS"]):
            caller = ("packages/daemon/src/image-reader.ts", f"import runner from '../../../{target}' with {{ type: 'file' }};\n", "100644")
            for context in ("both", "target-base-only"):
                left = soak_tree(image_base, [caller])
                candidate = soak_tree(image_base, image_updates) if context == "target-base-only" else soak_tree(left, image_updates)
                image_all(left, candidate, (target, "relative runner asset", context))
                count += 1
        for text in (
                "const source = Bun.file('../../../scripts/tunnel-decoder-proof/approval-matrix.py');\n",
                "const launch = 'python ../../../scripts/tunnel-decoder-proof/policy-mutations.py';\n",
                r"import runner from '@remi/daemon/../../../scripts/tunnel-decoder-proof/\u006dat rix.py';".replace("at rix", "atrix") + "\n"):
            caller = ("packages/daemon/src/image-reader.ts", text, "100644")
            for context in ("both", "target-base-only"):
                left = soak_tree(image_base, [caller])
                candidate = soak_tree(image_base, image_updates) if context == "target-base-only" else soak_tree(left, image_updates)
                image_all(left, candidate, (text, "runner reader/launch", context))
                count += 1
        unrelated = ("packages/daemon/src/image-reader.ts", "import './unrelated/matrix.py';\n", "100644")
        left = soak_tree(image_base, [unrelated])
        result = classify(left, soak_tree(left, image_updates))
        assert selected(result) == WRAPPER_GATES and not result["relay_soak"], result
        count += 1
        for producer, text in IMAGE_CONTENT.items():
            without = [update for update in image_updates if update[0] != producer]
            for state in ("body", "missing", "deleted", "mode", "base-state"):
                left, changes, removals = image_base, list(without), ()
                if state == "body":
                    changes.append((producer, text + "\n// unreviewed body\n", "100644"))
                elif state == "deleted":
                    removals = (producer,)
                elif state == "mode":
                    changes.append((producer, text, "100755"))
                elif state == "base-state":
                    left = soak_tree(image_base, [(producer, text + "\n// wrong original\n", "100644")])
                    changes = image_updates
                image_all(left, soak_tree(left, changes, removals), (producer, state))
                count += 1
        parser = IMAGE_CONTENT[IMAGE_DAEMON]
        for text in (parser.replace(" as number", "", 1), parser.replace(" as number", " as any", 1)):
            image_all(image_base, soak_tree(image_base, [*(u for u in image_updates if u[0] != IMAGE_DAEMON), (IMAGE_DAEMON, text, "100644")]), "unreviewed cast")
            count += 1
        image_all(image_base, soak_tree(image_base, [*(u for u in image_updates if u[0] != IMAGE_PROOF + "matrix.py"),
                  (IMAGE_PROOF + "matrix.py", IMAGE_CONTENT[IMAGE_PROOF + "matrix.py"].replace('"compile_from_snapshot": True', '"compile_from_snapshot": False'), "100644")]), "runner field")
        count += 1
        image_all(image_head, soak_tree(image_head, [], (), source=image_base), "reversed D1")
        count += 1
        # Fixed dependencies, dispatchers and runner inputs cannot drift at either endpoint.
        for path, pin in image_policy["original"].items():
            if path in image_policy["head"]:
                continue
            data = subprocess.check_output(["git", "show", f"{image_base}:{path}"])
            for context in ("base", "head"):
                changed = (path, data + b"\nowned unreviewed dependency\n", pin[0])
                left = soak_tree(image_base, [changed]) if context == "base" else image_base
                candidate = soak_tree(left, [*image_updates, *([changed] if context == "head" else [])])
                image_all(left, candidate, (path, context))
                count += 1
        package_bytes = subprocess.check_output(["git", "show", f"{image_base}:package.json"]).decode()
        cli_bytes = subprocess.check_output(["git", "show", f"{image_base}:packages/daemon/src/cli.ts"]).decode()
        current_version = json.loads(package_bytes)["version"]
        next_version = current_version + "0"
        version_updates = [
            ("package.json", package_bytes.replace(f'"version": "{current_version}"', f'"version": "{next_version}"', 1), "100644"),
            ("packages/daemon/src/cli.ts", cli_bytes.replace(f"return '{current_version}'; // REMI_COMPILED_VERSION", f"return '{next_version}'; // REMI_COMPILED_VERSION"), "100644"),
        ]
        version_base = soak_tree(image_base, version_updates)
        result = classify(version_base, soak_tree(version_base, image_updates))
        assert selected(result) == WRAPPER_GATES and not result["relay_soak"], result
        count += 1
        for path, changed in (("package.json", package_bytes.replace('"private": true', '"private": false', 1)),
                              ("packages/daemon/src/cli.ts", cli_bytes + "\n// changed runtime body\n")):
            for context in ("base", "head"):
                update = (path, changed, "100644")
                left = soak_tree(image_base, [update]) if context == "base" else image_base
                candidate = soak_tree(left, [*image_updates, *([update] if context == "head" else [])])
                image_all(left, candidate, (path, context))
                count += 1
        mismatch = soak_tree(image_base, version_updates[:1])
        image_all(mismatch, soak_tree(mismatch, image_updates), "unsynchronized metadata")
        count += 1
        for other in ("descriptor", "journal", "native-helper"):
            if other == "native-helper":
                changes = [(path, text, module["COLD_RELOCATIONS"][other]["head"][path][0]) for path, text in NATIVE_CONTENT.items()]
                removals = (NATIVE_REMOVED_C,)
            else:
                changes, removals = cold_updates(other), ()
                path, text, mode = changes[0]
                changes[0] = (path, text + "\n// simultaneous distinct producer change\n", mode)
            image_all(image_base, soak_tree(image_base, [*image_updates, *changes], removals), ("D1 composition", other))
            count += 1
        for fixture in sorted(module["COLD_IMAGE_BINARY"]):
            data = subprocess.check_output(["git", "show", f"{image_base}:{fixture}"])
            left = soak_tree(image_base, [(fixture, data, "100755")])
            image_all(left, soak_tree(left, image_updates), (fixture, "binary mode"))
            count += 1
        # Actual private object stores cover D1-specific unreadable parser/runner/binary/test inputs.
        object_bytes = {pin[1]: subprocess.check_output(["git", "cat-file", "blob", pin[1]])
                        for pin in image_policy["original"].values()}
        for path, text in IMAGE_CONTENT.items():
            object_bytes[image_policy["head"][path][1]] = text.encode()
        metadata_pins = {}
        for path in ("package.json", "packages/daemon/src/cli.ts"):
            blob = subprocess.check_output(["git", "rev-parse", f"{image_base}:{path}"]).decode().strip()
            metadata_pins[path] = ("100644", blob)
            object_bytes[blob] = subprocess.check_output(["git", "cat-file", "blob", blob])
        original_pins = {**image_policy["original"], **metadata_pins}
        final_pins = {**original_pins, **image_policy["head"]}
        missing_cases = (("complete", None), ("original", IMAGE_PROOF + "admission.ts"),
                         ("original", IMAGE_PROOF + "matrix.py"),
                         ("original", "scripts/tunnel-storage-proof/matrix.py"),
                         ("original", IMAGE_PROOF + "fixture.png"), ("original", IMAGE_PROOF + "fixture.jpg"),
                         ("head", IMAGE_DAEMON), ("head", "packages/daemon/tests/tunnel/image-admission-adoption.test.ts"))
        for endpoint, missing_path in missing_cases:
            omitted = image_policy[endpoint][missing_path][1] if endpoint != "complete" else None
            corpus_dir = Path.cwd()
            with tempfile.TemporaryDirectory(prefix="image-missing-pin-") as private:
                try:
                    os.chdir(private)
                    git("init", "-q")
                    git("config", "user.name", "Owned image object control")
                    git("config", "user.email", "test@example.com")
                    for blob, data in object_bytes.items():
                        if blob != omitted:
                            actual = subprocess.check_output(["git", "hash-object", "-w", "--stdin"], input=data).decode().strip()
                            assert actual == blob
                    # Reuse the exact public sample already read by the unchanged preceding native controls.
                    assert git("hash-object", "-w", "--stdin", input=sample_bytes.decode()) == sample_pin[1]
                    refs = []
                    for pins in (original_pins, final_pins):
                        git("read-tree", "--empty")
                        git("update-index", "--add", "--cacheinfo", f"{sample_pin[0]},{sample_pin[1]},.env.example")
                        for path, pin in pins.items():
                            git("update-index", "--add", "--cacheinfo", f"{pin[0]},{pin[1]},{path}")
                        tree = git("write-tree", "--missing-ok")
                        refs.append(git("commit-tree", tree, *(["-p", refs[0]] if refs else []), "-m", "owned image unavailable input"))
                    if endpoint == "complete":
                        result = classify(refs[0], refs[1])
                        assert selected(result) == WRAPPER_GATES and not result["relay_soak"], result
                    else:
                        image_all(refs[0], refs[1], ("missing input", endpoint, missing_path))
                    count += 1
                finally:
                    os.chdir(corpus_dir)
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
        # BEGIN named CLI-default/full-decoder controls: preserve all1608 preceding scenario bodies/order.
        import re
        import shutil

        transition_start = count
        git("fetch", "--quiet", "--no-tags", str(original), LAUNCH_PUBLIC_BASE, DECODE_PUBLIC_BASE,
            module["SOAK_IMAGE_ENTRY_SOURCE_ROOT"])
        def transition_text(refpath):
            return subprocess.check_output(["git", "show", refpath], stderr=subprocess.PIPE).decode()

        def transition_updates(name, parent):
            contents = TRANSITION_CONTENT[name]
            version = json.loads(transition_text(f"{parent}:package.json"))["version"]
            updates = []
            for path, body in contents.items():
                if path == "packages/daemon/src/cli.ts":
                    body = re.sub(r"(?m)^( +return ')[^'\n]+('; // REMI_COMPILED_VERSION)$",
                                  lambda match: match[1] + version + match[2], body)
                elif name == "Image worker entry" and path == "package.json":
                    body, replacements = re.subn(r'(?m)^(  "version": ")([^"\n]+)(",)$',
                                                 lambda match: match[1] + version + match[3], body)
                    assert replacements == 1, (name, path, replacements)
                updates.append((path, body, "100644"))
            if name == "Image worker entry":
                updates.extend((path, body, "100644") for path, body in IMAGE_ENTRY_DOC_CONTENT.items())
            return updates

        def transition_assert(left, right, label, skip):
            global count
            result = classify(left, right)
            assert selected(result) == gates and result["typecheck"] and result["relay"] and (
                result["relay_soak"] is not skip), (label, result)
            if skip:
                assert "ordinary and short relay controls retained" in result["reason"], result
            count += 1

        def owned_missing_transition_objects(public_base, candidate, object_cases, name):
            # One owned pristine loose store, complete actual tree objects, and no historical commits.
            objects = set()
            trees = []
            for ref in (public_base, candidate):
                tree = git("rev-parse", f"{ref}^{{tree}}")
                trees.append(tree)
                objects.add(tree)
                for line in git("ls-tree", "-r", "-t", ref).splitlines():
                    objects.add(line.partition("\t")[0].split()[2])
            pack = subprocess.check_output(["git", "pack-objects", "--stdout"],
                                           input="".join(f"{obj}\n" for obj in sorted(objects)).encode(), stderr=subprocess.PIPE)
            repo_dir = Path.cwd()
            with tempfile.TemporaryDirectory(prefix="named-pristine-") as pristine:
                pristine_repo = Path(pristine)
                try:
                    os.chdir(pristine_repo)
                    git("init", "-q")
                    git("config", "user.name", "Owned unavailable-object control")
                    git("config", "user.email", "test@example.com")
                    subprocess.run(["git", "unpack-objects"], input=pack, check=True,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
                    private_base = git("commit-tree", trees[0], "-m", "owned pristine original")
                    private_head = git("commit-tree", trees[1], "-p", private_base, "-m", "owned pristine final")
                    os.chdir(repo_dir)
                    for endpoint, path in object_cases:
                        ref = public_base if endpoint in ("original", "core", "sample") else candidate
                        omitted = git("rev-parse", f"{ref}:{path}")
                        with tempfile.TemporaryDirectory(prefix="named-missing-") as private:
                            private_repo = Path(private) / "repo"
                            shutil.copytree(pristine_repo, private_repo)
                            (private_repo / ".git/objects" / omitted[:2] / omitted[2:]).unlink()
                            try:
                                os.chdir(private_repo)
                                transition_assert(private_base, private_head, (name, "unavailable", endpoint, path), False)
                            finally:
                                os.chdir(repo_dir)
                finally:
                    os.chdir(repo_dir)

        transition_heads = {}
        for name, public_base, policy in (
                ("CLI-default", LAUNCH_PUBLIC_BASE, module["SOAK_LAUNCH_TRANSITION"]),
                ("Dormant full-decoder", DECODE_PUBLIC_BASE, module["SOAK_DECODE_TRANSITION"])):
            updates = transition_updates(name, public_base)
            candidate = soak_tree(public_base, updates)
            transition_heads[name] = candidate
            transition_assert(public_base, candidate, (name, "complete real tree"), True)
            docs = ("docs/owned-named-transition.md", "ordinary prose only\n", "100644")
            transition_assert(public_base, soak_tree(public_base, [*updates, docs]), (name, "ordinary docs"), True)
            left = soak_tree(public_base, [docs])
            right = soak_tree(left, updates, source=public_base)
            transition_assert(left, right, (name, "target docs only"), True)
            version = json.loads(transition_text(f"{public_base}:package.json"))["version"]
            package = transition_text(f"{public_base}:package.json").replace(f'"version": "{version}"', '"version": "0.7.17-dev.999"')
            cli = transition_text(f"{public_base}:packages/daemon/src/cli.ts").replace(f"return '{version}'; // REMI_COMPILED_VERSION", "return '0.7.17-dev.999'; // REMI_COMPILED_VERSION")
            version_left = soak_tree(public_base, [("package.json", package, "100644"), ("packages/daemon/src/cli.ts", cli, "100644")])
            transition_assert(version_left, soak_tree(version_left, transition_updates(name, version_left)), (name, "synchronized base version"), True)
            version_final_cli = {p: body for p, body, _ in updates}.get("packages/daemon/src/cli.ts", cli)
            version_final_cli = version_final_cli.replace(f"return '{version}'; // REMI_COMPILED_VERSION", "return '0.7.17-dev.999'; // REMI_COMPILED_VERSION")
            transition_assert(public_base, soak_tree(public_base, [*(u for u in updates if u[0] != "packages/daemon/src/cli.ts"),
                              ("package.json", package, "100644"), ("packages/daemon/src/cli.ts", version_final_cli, "100644")]), (name, "synchronized head version"), True)
            for path, roles in policy.items():
                replacement = next(u for u in updates if u[0] == path)
                other = [u for u in updates if u[0] != path]
                transition_assert(public_base, soak_tree(public_base, other), (name, path, "omitted"), False)
                for body, mode, state in ((replacement[1] + "\n// unreviewed body\n", "100644", "head body"),
                                          (replacement[1], "100755", "head mode"),
                                          (replacement[1], "120000", "head symlink")):
                    transition_assert(public_base, soak_tree(public_base, [*other, (path, body, mode)]), (name, path, state), False)
                if roles["original"] is not None:
                    body = transition_text(f"{public_base}:{path}")
                    for changed_body, mode, state in ((body + "\n// changed original\n", "100644", "base body"),
                                                     (body, "100755", "base mode")):
                        left = soak_tree(public_base, [(path, changed_body, mode)])
                        transition_assert(left, soak_tree(left, updates), (name, path, state), False)
                    transition_assert(public_base, soak_tree(public_base, other, (path,)), (name, path, "deleted"), False)
                else:
                    left = soak_tree(public_base, [replacement])
                    transition_assert(left, soak_tree(left, updates), (name, path, "preexisting base"), False)
            # Representative invalid original/merge-base disagreement and rename/type transitions.
            first = next(p for p, roles in policy.items() if roles["original"] is not None and p != "packages/daemon/src/cli.ts")
            original_body = transition_text(f"{public_base}:{first}")
            left = soak_tree(public_base, [(first, original_body + "\n// target drift\n", "100644")])
            transition_assert(left, soak_tree(public_base, updates), (name, "base-only source drift"), False)
            transition_assert(public_base, soak_tree(public_base, [*updates, (first + ".moved", original_body, "100644")], (first,)), (name, "rename"), False)
            transition_assert(public_base, soak_tree(public_base, updates, [*policy]), (name, "reversed/deleted population"), False)
            # Fixed production lifetime/crypto/authority and test-execution inputs are not mere both-end equal pins.
            core_controls = ["packages/daemon/src/remote/hub-relay.ts", "packages/daemon/src/auth/authenticator.ts",
                             "packages/daemon/src/session/session-registry.ts", "packages/daemon/src/harness/claude.ts",
                             "packages/shared/src/relay/channel.ts", "packages/shared/src/relay/primitives.ts",
                             "packages/signaling/src/index.ts", "packages/web/tests/relay-r7-soak.test.ts",
                             ".github/workflows/relay-r7.yml", ".github/workflows/ci.yml", "tsconfig.json"]
            for path in core_controls:
                body = transition_text(f"{public_base}:{path}") + "\n// unreviewed core\n"
                for context in ("head", "base", "base-only"):
                    drift = (path, body, "100644")
                    left = soak_tree(public_base, [drift]) if context != "head" else public_base
                    right = soak_tree(public_base, updates) if context == "base-only" else soak_tree(left, [*updates, *([drift] if context == "head" else [])])
                    transition_assert(left, right, (name, path, context), False)
            for path in ("package.json", "packages/daemon/src/cli.ts"):
                body = transition_text(f"{public_base}:{path}")
                for context in ("base", "head"):
                    drift = (path, body + "\n// unreviewed normalized input\n", "100644")
                    left = soak_tree(public_base, [drift]) if context == "base" else public_base
                    other = [u for u in updates if u[0] != path]
                    right = soak_tree(left, [*other, *([drift] if context == "head" else [u for u in updates if u[0] == path])])
                    transition_assert(left, right, (name, path, context, "byte drift"), False)
            transition_assert(public_base, soak_tree(public_base, [*updates, ("package.json", package, "100644")]), (name, "unsynchronized version"), False)
            base_cli = transition_text(f"{public_base}:packages/daemon/src/cli.ts")
            transition_assert(public_base, soak_tree(public_base, [*(u for u in updates if u[0] != "packages/daemon/src/cli.ts"),
                              ("packages/daemon/src/cli.ts", base_cli + "\n return '" + version + "'; // REMI_COMPILED_VERSION\n", "100644")]), (name, "third compiled return"), False)
            # Actual public sample is read; changed/unknown secret names are refused before content read.
            for context in ("base", "head"):
                drift = (".env.example", "published sample drift\n", "100644")
                left = soak_tree(public_base, [drift]) if context == "base" else public_base
                transition_assert(left, soak_tree(left, [*updates, *([drift] if context == "head" else [])]), (name, "public sample", context), False)
            transition_assert(public_base, soak_tree(public_base, [*updates, (".env.owned-control", "owned corpus content only\n", "100644")]), (name, "unknown env name"), False)
            target = "cli/launch-harness" if name == "CLI-default" else "tunnel/image-decode"
            identifier = "resolveLaunchHarness" if name == "CLI-default" else "decodeImage"
            caller_controls = [
                ("root-loader.ts", f"import './packages/daemon/src/{target}';\n"),
                ("owned-execution.json", json.dumps({"entry": f"./packages/daemon/src/{target}.ts"})),
                ("packages/daemon/src/owned-reference.ts", f"import './{target}';\n"),
                ("packages/daemon/src/owned-reference.ts", f"import/* owned */'./{target}.ts';\n"),
                ("packages/daemon/src/owned-reference.ts", f"export/* owned */{{}}from/* owned */'./{target}';\n"),
                ("packages/daemon/src/owned-reference.ts", f"require/* owned */(/* owned */'./{target}');\n"),
                ("packages/daemon/src/owned-reference.ts", f"import/* owned */(/* owned */'@remi/daemon/{target}');\n"),
                ("packages/daemon/src/owned-reference.ts", f"import '@remi/daemon/./{target}';\n"),
                ("packages/daemon/src/owned-reference.ts", f"import '@remi/daemon/{target.rsplit('/',1)[0]}/../{target}';\n"),
                ("packages/daemon/src/owned-reference.ts", f"import './{target[:-1]}\\u{ord(target[-1]):04x}';\n"),
                ("packages/daemon/src/owned-reference.ts", f"const owned = {identifier};\n"),
            ]
            caller_controls.append(("packages/daemon/src/owned-declaration.d.ts", f'/// <reference path="./{target}.ts" />\n'))
            for index, (path, body) in enumerate(caller_controls):
                update = (path, body, "100644")
                for context in ("new", "both", "base-only"):
                    left = soak_tree(public_base, [update]) if context != "new" else public_base
                    right = soak_tree(public_base, updates) if context == "base-only" else soak_tree(left, [*updates, *([update] if context == "new" else [])])
                    transition_assert(left, right, (name, "caller", index, context), False)
            # Whole-tree equality does not ban genuine unrelated baseline literals / identifier boundaries.
            unrelated = ("packages/signaling/src/owned-nonconsumer.ts", f"import './{target.rsplit('/',1)[-1]}';\nconst {identifier}Suffix = true;\n", "100644")
            # A bare same basename is intentionally conservative; a different relative target remains positive.
            unrelated = (unrelated[0], f"import './different-{target.rsplit('/',1)[-1]}';\nconst {identifier}Suffix = true;\n", "100644")
            left = soak_tree(public_base, [unrelated])
            transition_assert(left, soak_tree(left, updates), (name, "unrelated worker relative/identifier boundary"), True)
            for path in ("packages/daemon/src/owned-runtime.ts", "docs/PROVISIONING.md", "docs/relay-r7-gates.md", "package.json"):
                body = (transition_text(f"{public_base}:{path}") if path != "packages/daemon/src/owned-runtime.ts" else "export {};\n") + "\n// mixed unrelated change\n"
                transition_assert(public_base, soak_tree(public_base, [*updates, (path, body, "100644")]), (name, "mixed", path), False)
            if name == "Dormant full-decoder":
                final_cli_base = soak_tree(public_base, transition_updates("CLI-default", public_base))
                transition_assert(final_cli_base, soak_tree(final_cli_base, updates), (name, "whole final CLI state"), True)
                transition_assert(public_base, soak_tree(public_base, [*updates, *transition_updates("CLI-default", public_base)]), (name, "mixed CLI feature"), False)
                for path in ("scripts/tunnel-decoder-proof/inputs.json", "scripts/tunnel-decoder-proof/package.json", "scripts/tunnel-decoder-proof/worker.ts", "scripts/tunnel-decoder-proof/process.ts", "packages/daemon/src/tunnel/image-admission.ts"):
                    drift = (path, transition_text(f"{public_base}:{path}") + "\n// changed decoder support\n", "100644")
                    for context in ("base", "head"):
                        left = soak_tree(public_base, [drift]) if context == "base" else public_base
                        transition_assert(left, soak_tree(left, [*updates, *([drift] if context == "head" else [])]), (name, path, context), False)
                for path in module["COLD_IMAGE_BINARY"]:
                    data = subprocess.check_output(["git", "show", f"{public_base}:{path}"])
                    for context in ("base", "head"):
                        drift = (path, data + b"owned", "100644")
                        left = soak_tree(public_base, [drift]) if context == "base" else public_base
                        transition_assert(left, soak_tree(left, [*updates, *([drift] if context == "head" else [])]), (name, path, context, "bytes"), False)
                    left = soak_tree(public_base, [(path, data, "100755")])
                    transition_assert(left, soak_tree(left, updates), (name, path, "mode"), False)
                lock_body = TRANSITION_CONTENT[name]["bun.lock"]
                for old, new in (("jpeg-js@0.4.4", "jpeg-js@0.4.5"), ("pngjs@7.0.0", "pngjs@7.0.1"), ("qrcode/pngjs", "qrcode/pngjs-drift"), ("sha512-LKWqWJRh", "sha512-OWNEDRh")):
                    altered = lock_body.replace(old, new, 1)
                    assert altered != lock_body
                    transition_assert(public_base, soak_tree(public_base, [*(u for u in updates if u[0] != "bun.lock"), ("bun.lock", altered, "100644")]), (name, "selected lock identity", old), False)
                for caller in ("scripts/tunnel-decoder-proof/decode.ts", "scripts/tunnel-decoder-proof/worker.ts", "scripts/tunnel-decoder-proof/matrix.py"):
                    path = "packages/daemon/src/owned-decoder-caller.ts"
                    update = (path, f"import '../../../{caller}';\n", "100644")
                    left = soak_tree(public_base, [update])
                    transition_assert(left, soak_tree(left, updates), (name, "active caller", caller), False)
            # Missing pinned original/head/core/sample objects: only owned private copies are modified.
            object_cases = [("original", next(p for p,v in policy.items() if v["original"] and p != "packages/daemon/src/cli.ts")),
                            ("head", next(p for p,v in policy.items() if v["original"] is None)),
                            ("core", "packages/shared/src/relay/channel.ts"), ("sample", ".env.example"),
                            ("head", "package.json"), ("head", "packages/daemon/src/cli.ts")]
            if name == "Dormant full-decoder":
                object_cases.extend(("core", p) for p in ("scripts/tunnel-decoder-proof/worker.ts", "scripts/tunnel-decoder-proof/fixture.png", "scripts/tunnel-decoder-proof/fixture.jpg", "scripts/tunnel-decoder-proof/pngjs.d.ts"))
            owned_missing_transition_objects(public_base, candidate, object_cases, name)
        assert count - transition_start > 200
        # END named CLI-default/full-decoder controls.
        # BEGIN complete D2+D3 alternative controls; D2-only bodies above remain unchanged.
        worker_updates = [(path, body, "100644") for path, body in WORKER_CONTENT.items()]
        decode_updates = transition_updates("Dormant full-decoder", DECODE_PUBLIC_BASE)
        combined_updates = [*decode_updates, *worker_updates]
        combined = soak_tree(DECODE_PUBLIC_BASE, combined_updates)
        transition_assert(DECODE_PUBLIC_BASE, combined, "complete D2+D3 actual tree", True)
        transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, [*combined_updates,
                          ("docs/owned-foundation-note.md", "ordinary foundation prose\n", "100644")]), "complete D2+D3 docs", True)
        final_cli_base = soak_tree(DECODE_PUBLIC_BASE, transition_updates("CLI-default", DECODE_PUBLIC_BASE))
        transition_assert(final_cli_base, soak_tree(final_cli_base, combined_updates), "complete D2+D3 final CLI", True)
        for path, roles in module["SOAK_DECODE_WORKER_TRANSITION"].items():
            other = [u for u in combined_updates if u[0] != path]
            replacement = next(u for u in worker_updates if u[0] == path)
            transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, other), ("D3", path, "omitted"), False)
            for body, mode, state in ((replacement[1] + "\n// changed worker body\n", "100644", "body"),
                                      (replacement[1], "100755", "mode"), (replacement[1], "120000", "symlink")):
                transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, [*other, (path, body, mode)]), ("D3", path, state), False)
            if roles["original"] is None:
                left = soak_tree(DECODE_PUBLIC_BASE, [replacement])
                transition_assert(left, soak_tree(left, combined_updates), ("D3", path, "preexisting"), False)
            else:
                original_body = transition_text(f"{DECODE_PUBLIC_BASE}:{path}")
                for context in ("both", "base-only"):
                    left = soak_tree(DECODE_PUBLIC_BASE, [(path, original_body + "\n// wrong original\n", "100644")])
                    right = soak_tree(DECODE_PUBLIC_BASE, combined_updates) if context == "base-only" else soak_tree(left, combined_updates)
                    transition_assert(left, right, ("D3", path, context), False)
            transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, other, (path,)), ("D3", path, "deleted"), False)
        for path in ("packages/daemon/src/tunnel/image-process.ts", "packages/daemon/src/tunnel/image-worker.ts",
                     "scripts/tunnel-decoder-proof/process.ts", "scripts/tunnel-decoder-proof/worker.ts"):
            caller = ("packages/daemon/src/owned-foundation-caller.ts", f"import '../../../{path}';\n", "100644")
            # Canonical exact asset form exercises both module and launch/config target matching.
            caller = (caller[0], f"const entry = './{path}';\n", "100644")
            for context in ("head", "both", "base-only"):
                left = soak_tree(DECODE_PUBLIC_BASE, [caller]) if context != "head" else DECODE_PUBLIC_BASE
                right = soak_tree(DECODE_PUBLIC_BASE, combined_updates) if context == "base-only" else soak_tree(left, [*combined_updates, *([caller] if context == "head" else [])])
                transition_assert(left, right, ("D3 caller", path, context), False)
        for identifier in ("DecoderProcess", "DecoderProcessError", "MAX_RESULT_BYTES", "decodeInput", "decodeWorker", "decodeRepeatedWorker"):
            caller = ("root-worker-loader.ts", f"const owned = {identifier};\n", "100644")
            left = soak_tree(DECODE_PUBLIC_BASE, [caller])
            transition_assert(left, soak_tree(left, combined_updates), ("D3 identifier", identifier), False)
        transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, worker_updates), "D3 without D2", False)
        transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, [*combined_updates,
                          *transition_updates("CLI-default", DECODE_PUBLIC_BASE)]), "foundation mixed CLI", False)
        for path in ("packages/daemon/src/remote/hub-relay.ts", "scripts/tunnel-decoder-proof/inputs.json", ".github/workflows/relay-r7.yml"):
            drift = (path, transition_text(f"{DECODE_PUBLIC_BASE}:{path}") + "\n// mixed foundation input\n", "100644")
            transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, [*combined_updates, drift]), ("foundation mixed", path), False)
        owned_missing_transition_objects(DECODE_PUBLIC_BASE, combined, [
            ("head", "packages/daemon/src/tunnel/image-process.ts"), ("head", "packages/daemon/src/tunnel/image-worker.ts"),
            ("head", "packages/daemon/tests/tunnel/image-worker-adoption.test.ts"),
            ("original", "scripts/tunnel-decoder-proof/process.ts"), ("original", "scripts/tunnel-decoder-proof/worker.ts")], "D2+D3")
        # END complete D2+D3 alternative controls.
        # BEGIN root indirect decoder entry regressions from independent review.
        decoder_updates = transition_updates("Dormant full-decoder", DECODE_PUBLIC_BASE)
        root_cases = [
            ("root-loader.ts", "import './scripts/tunnel-decoder-proof/probe';\n"),
            ("root-loader.ts", "import/* owned */'./scripts/tunnel-decoder-proof/approval-entry.ts';\n"),
            ("root-loader.ts", "require/* owned */('./scripts/tunnel-decoder-proof/process-probe');\n"),
            ("root-loader.ts", "import('./scripts/tunnel-decoder-proof/palette-probe');\n"),
            ("owned-root-execution.json", json.dumps({"file": "./scripts/tunnel-decoder-proof/probe.ts"})),
            ("owned-root-execution.json", json.dumps({"entry": "./scripts/tunnel-decoder-proof/approval-entry.ts"})),
            ("owned-root-execution.json", '{"file":"./scripts/tunnel-decoder-proof/pr\\u006fbe.ts"}'),
            ("owned-root-execution.json", '{"entry":"./scripts/tunnel-decoder-proof/approval-\\u0065ntry.ts"}'),
            ("owned-root-execution.json", json.dumps({"entry": "./scripts/tunnel-decoder-proof/matrix.py"})),
            ("owned-root-execution.json", json.dumps({"file": "./scripts/tunnel-decoder-proof/approval-matrix.py"})),
        ]
        for index, (path, body) in enumerate(root_cases):
            caller = (path, body, "100644")
            for context in ("head", "both", "base-only"):
                left = soak_tree(DECODE_PUBLIC_BASE, [caller]) if context != "head" else DECODE_PUBLIC_BASE
                right = soak_tree(DECODE_PUBLIC_BASE, decoder_updates) if context == "base-only" else soak_tree(left, [*decoder_updates, *([caller] if context == "head" else [])])
                transition_assert(left, right, ("root indirect decoder", index, context), False)
        for caller in (
                ("packages/signaling/src/owned-unrelated-probe.ts", "import './probe';\n", "100644"),
                ("owned-root-execution.json", json.dumps({"entry": "./packages/signaling/src/probe.ts"}), "100644"),
                ("root-loader.ts", "import './scripts/tunnel-decoder-proof/probeSuffix';\nconst decodeImageSuffix = true;\n", "100644")):
            left = soak_tree(DECODE_PUBLIC_BASE, [caller])
            transition_assert(left, soak_tree(left, decoder_updates), ("unrelated indirect target", caller[0]), True)
        transition_assert(DECODE_PUBLIC_BASE, soak_tree(DECODE_PUBLIC_BASE, [*decoder_updates,
                          *[(path, body, "100644") for path, body in WORKER_CONTENT.items()]]), "review fixed complete D2+D3", True)
        # END root indirect decoder entry regressions.
        validation_controls()
        auth_readiness_controls(soak_tree, transition_updates, owned_missing_transition_objects)
        # BEGIN #1170 image-worker entry transition controls, appended after the
        # original corpus so all 2265 established scenarios retain their order.
        image_entry_start = count
        entry_name = "Image worker entry"
        entry_base = module["SOAK_IMAGE_ENTRY_BASE"]
        entry_policy = module["SOAK_IMAGE_ENTRY_TRANSITION"]
        entry_updates = transition_updates(entry_name, entry_base)
        entry_candidate = soak_tree(entry_base, entry_updates)
        transition_assert(entry_base, entry_candidate, (entry_name, "complete public transition"), True)

        # Every source role is required independently; no partial source set skips.
        for path in entry_policy:
            transition_assert(entry_base, soak_tree(entry_base, [update for update in entry_updates
                              if update[0] != path]), (entry_name, path, "partial"), False)

        # Synchronized version movement is allowed while any other package drift is not.
        current_version = json.loads(transition_text(f"{entry_base}:package.json"))["version"]
        next_version = "0.7.17-dev.999"
        package_base = transition_text(f"{entry_base}:package.json").replace(
            f'"version": "{current_version}"', f'"version": "{next_version}"')
        cli_base = transition_text(f"{entry_base}:packages/daemon/src/cli.ts").replace(
            f"return '{current_version}'; // REMI_COMPILED_VERSION",
            f"return '{next_version}'; // REMI_COMPILED_VERSION")
        assert package_base != transition_text(f"{entry_base}:package.json")
        assert cli_base != transition_text(f"{entry_base}:packages/daemon/src/cli.ts")
        bumped_base = soak_tree(entry_base, [("package.json", package_base, "100644"),
                                             ("packages/daemon/src/cli.ts", cli_base, "100644")])
        bumped_updates = transition_updates(entry_name, bumped_base)
        bumped_head_package = next(body for path, body, _ in bumped_updates if path == "package.json")
        bumped_head_cli = cli_base
        transition_assert(bumped_base, soak_tree(bumped_base, [*bumped_updates,
                          ("packages/daemon/src/cli.ts", bumped_head_cli, "100644")]),
                          (entry_name, "synchronized version companion"), True)

        head_package = next(body for path, body, _ in entry_updates if path == "package.json")
        root_drift_data = json.loads(head_package)
        root_drift_data["scripts"]["remi"] += " --unreviewed"
        transition_assert(entry_base, soak_tree(entry_base, [*(u for u in entry_updates if u[0] != "package.json"),
                          ("package.json", json.dumps(root_drift_data, indent=2) + "\n", "100644")]),
                          (entry_name, "root script drift"), False)
        daemon_package = next(body for path, body, _ in entry_updates if path == "packages/daemon/package.json")
        daemon_drift_data = json.loads(daemon_package)
        daemon_drift_data["name"] = "@remi/daemon-unreviewed"
        transition_assert(entry_base, soak_tree(entry_base, [*(u for u in entry_updates if u[0] != "packages/daemon/package.json"),
                          ("packages/daemon/package.json", json.dumps(daemon_drift_data, indent=2) + "\n", "100644")]),
                          (entry_name, "daemon package field drift"), False)

        # Mixed source with runtime, dependency and relay-workflow changes remains full.
        for path, body in (
                ("packages/daemon/src/owned-entry-drift.ts", "export const changed = true;\n"),
                ("bun.lock", transition_text(f"{entry_base}:bun.lock") + "\n# unrelated lock drift\n"),
                (".github/workflows/relay-r7.yml", transition_text(f"{entry_base}:.github/workflows/relay-r7.yml") + "\n# unrelated workflow drift\n")):
            transition_assert(entry_base, soak_tree(entry_base, [*entry_updates, (path, body, "100644")]),
                              (entry_name, "mixed unrelated", path), False)

        # Exact caller spellings are scanned in base and head trees; expected
        # existing decoder callers are independently pinned in entry support.
        caller_path = "packages/daemon/src/owned-image-entry-caller.ts"
        caller_body = "import { imageWorkerCommand } from './tunnel/image-worker-command';\nvoid imageWorkerCommand;\n"
        caller_update = (caller_path, caller_body, "100644")
        base_with_caller = soak_tree(entry_base, [caller_update])
        transition_assert(base_with_caller, soak_tree(base_with_caller, transition_updates(entry_name, base_with_caller)),
                          (entry_name, "base caller"), False)
        transition_assert(entry_base, soak_tree(entry_base, [*entry_updates, caller_update]),
                          (entry_name, "head caller"), False)
        factory_caller_path = "packages/daemon/src/owned-image-factory-caller.ts"
        factory_caller_body = "import { createImageDecoder } from './tunnel/image-worker-command';\nvoid createImageDecoder;\n"
        factory_caller_update = (factory_caller_path, factory_caller_body, "100644")
        base_and_head_factory_caller = soak_tree(entry_base, [factory_caller_update])
        transition_assert(base_and_head_factory_caller,
                          soak_tree(base_and_head_factory_caller,
                                    transition_updates(entry_name, base_and_head_factory_caller)),
                          (entry_name, "base and head factory caller"), False)

        entry_body = next(body for path, body, _ in entry_updates if path == "packages/daemon/src/entry.ts")
        transition_assert(entry_base, soak_tree(entry_base, [*(u for u in entry_updates if u[0] != "packages/daemon/src/entry.ts"),
                          ("packages/daemon/src/entry.ts", entry_body, "100755")]),
                          (entry_name, "entry executable mode"), False)
        transition_assert(entry_base, soak_tree(entry_base, [u for u in entry_updates
                          if u[0] != "packages/daemon/src/entry.ts"]),
                          (entry_name, "deleted entry"), False)
        transition_assert(entry_base, soak_tree(entry_base,
                          [*entry_updates, ("packages/daemon/src/entry.moved.ts", entry_body, "100644")],
                          ("packages/daemon/src/entry.ts",)), (entry_name, "renamed entry"), False)
        transition_assert(entry_base, soak_tree(entry_base,
                          [*entry_updates, ("docs/extra-executable.md", "unapproved executable doc\n", "100755")]),
                          (entry_name, "unapproved executable doc"), False)
        assert count - image_entry_start == 26, count - image_entry_start
        # END #1170 image-worker entry transition controls.
        assert count == 2291, count
        print(json.dumps({"controls": count, "passed": count, "failed": 0,
                          "scope": "owned real git diffs and event inputs"}))
    finally:
        os.chdir(original)
        os.environ.update(inherited_git)
