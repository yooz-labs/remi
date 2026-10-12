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
    "packages/daemon/tests/connection-auth.test.ts": ("843726b2347cfc5b99718e914e08f8dd5fffc7f3", "e189888fc0f39dd8684d735784c295803e35b807"),
}
SOAK_FIXTURE_TOKENS = ("relay-r3-drain", "push.e2e", "connection-auth")
SOAK_TRACE = {
    "packages/daemon/src/server/connection.ts": "a0bee1003e89109c853e30aa7a8cd6afc2443111",
    "packages/daemon/src/auth/authenticator.ts": "f8a68b408fa1760fd6442369315e440e0d915635",
    "packages/daemon/src/auth/identity-store.ts": "6c4a98a3a0442a500a8f0bd85a269343c80df628",
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


# Three exact immutable comment-only references to the auth fixture, not general comment stripping.
SOAK_AUTH_COMMENTS = {
    "packages/daemon/tests/connection-unregister-ack-order.test.ts": (
        "5bb330b56694c7642a802e477b132b780acef569",
        21,
        "/** Mock WebSocket that captures sent messages (same pattern as connection-auth.test.ts). */",
    ),
    "packages/daemon/tests/server/handle-message-seam-guard.test.ts": (
        "b9400ba9e33ce35462c4b4de33aa3de4bda94af1",
        56,
        " *  connection-auth.test.ts: a real WebSocket-shaped object, not a mock of",
    ),
    "packages/daemon/tests/server/connection-answer-message.test.ts": (
        "99afb022d3f4f716f03bf102fae0d811933f5880",
        7,
        " * connection-auth.test.ts).",
    ),
}

# Exact cold relocations; target paths distinguish tunnel admission from Worker admission.
COLD_RELOCATIONS = {'descriptor': {'original': {'scripts/tunnel-storage-proof/admission.ts': ['100644',
                                                                           'b3f165554abf5a3a6ff8a7cdb8a05a561dc68c2c'],
                             'scripts/tunnel-storage-proof/private-copy.ts': ['100644',
                                                                              'b31e80880f1f73e4198c2629ddcd54c5316992f7'],
                             'scripts/tunnel-storage-proof/admission-probe.ts': ['100644',
                                                                                 '1d88c31c7be8deed30e56a6a3e3af00a652fab64'],
                             'scripts/tunnel-storage-proof/copy-probe.ts': ['100644',
                                                                            '62b55ad1aa00224a49e5a4c7c435598040cf6338'],
                             'scripts/tunnel-storage-proof/journal-settlement.ts': ['100644',
                                                                                    '2d662ff7de2779abf9e0903ba98c1f5dedbd4200'],
                             'scripts/tunnel-storage-proof/recovery-probe.ts': ['100644',
                                                                                'f310d3d29628572a27ce3ecba4088a11de6e699b'],
                             'scripts/tunnel-storage-proof/recovery.ts': ['100644',
                                                                          '266b9db3cdfc1de295c2a7190277da6c11a9e5ff'],
                             'scripts/tunnel-storage-proof/reserved-copy-probe.ts': ['100644',
                                                                                     '7f37292c530cbaebdf19b2540303d70ac000dafa'],
                             'scripts/tunnel-storage-proof/reserved-copy.ts': ['100644',
                                                                               '7dc52af2c8146d8bac3ab0f127818456f1248954'],
                             'scripts/tunnel-storage-proof/settlement-fixture.ts': ['100644',
                                                                                    '0fd828d6765a85743f82090aa9042cfd2fc2bc7d'],
                             'scripts/tunnel-storage-proof/storage-approval-child.ts': ['100644',
                                                                                        '5c101f45514ae284e1a08ab6bf5e138281cf6e52'],
                             'scripts/tunnel-storage-proof/storage-approval-native.ts': ['100644',
                                                                                         '2a8dd22c4468e89cfdff84c4611a453b1356301c'],
                             'scripts/tunnel-storage-proof/storage-approval-mutations.py': ['100755',
                                                                                            'f9e338cbed68841b7aa6c4105bd38a50543f09da'],
                             'scripts/tunnel-storage-proof/assets.d.ts': ['100644',
                                                                          'b6aea9e3b22518239f56d2996e6ecae8b05e7869']},
                'head': {'packages/daemon/src/tunnel/admission.ts': ['100644',
                                                                     '9b6ba62331eae2b52d31a5e5ebb6793acc14fb72'],
                         'packages/daemon/src/tunnel/private-ops.ts': ['100644',
                                                                       '2f9fc8a41331a74e86216c58257847397492f68f'],
                         'scripts/tunnel-storage-proof/admission.ts': ['100644',
                                                                       'fa70712d1cfa04ff8eb28a942c8eb88b3a093713'],
                         'scripts/tunnel-storage-proof/private-copy.ts': ['100644',
                                                                          '95d51d1c639c1ecb25fd615f361c5a3cd6b2d69a'],
                         'packages/daemon/tests/tunnel/descriptors-adoption.test.ts': ['100644',
                                                                                       '173a9bd86c1893d160d849d68492e36c4a4a9003']},
                'identifiers': ['OpenAt', 'DirectoryRoot', 'AdmittedFile', 'FileAdmission', 'PrivateOps']},
 'journal': {'original': {'scripts/tunnel-storage-proof/recovery.ts': ['100644',
                                                                       '266b9db3cdfc1de295c2a7190277da6c11a9e5ff'],
                          'scripts/tunnel-storage-proof/journal-settlement.ts': ['100644',
                                                                                 '2d662ff7de2779abf9e0903ba98c1f5dedbd4200'],
                          'scripts/tunnel-storage-proof/recovery-native.ts': ['100644',
                                                                              '749fedcb836744a55a409f59757ecb191f80ec02'],
                          'scripts/tunnel-storage-proof/recovery-probe.ts': ['100644',
                                                                             'f310d3d29628572a27ce3ecba4088a11de6e699b'],
                          'scripts/tunnel-storage-proof/settlement-fixture.ts': ['100644',
                                                                                 '0fd828d6765a85743f82090aa9042cfd2fc2bc7d'],
                          'scripts/tunnel-storage-proof/settlement-probe.ts': ['100644',
                                                                               'eca0b3d2cc2cb17c5f26b21c8bbc412983948764'],
                          'scripts/tunnel-storage-proof/recovery-mutations.py': ['100755',
                                                                                 'def04c097129b754a394bdae233695da0a0941a8'],
                          'scripts/tunnel-storage-proof/settlement-mutations.py': ['100755',
                                                                                   'a245d6c57204405ae871b59f8022ec96d646b0d4'],
                          'packages/daemon/src/tunnel/admission.ts': ['100644',
                                                                      '9b6ba62331eae2b52d31a5e5ebb6793acc14fb72'],
                          'packages/daemon/src/tunnel/private-ops.ts': ['100644',
                                                                        '2f9fc8a41331a74e86216c58257847397492f68f'],
                          'packages/daemon/tests/tunnel/descriptors-adoption.test.ts': ['100644',
                                                                                        '173a9bd86c1893d160d849d68492e36c4a4a9003'],
                          'packages/daemon/src/tunnel/recovery-error.ts': ['100644',
                                                                           '6855b1b94ede69f9ee85cd6219c813e8f9d0729d'],
                          'packages/daemon/src/tunnel/reservations.ts': ['100644',
                                                                         '4cc18f1200a5f15276cdc0a14377c0985e9d5d7d'],
                          'packages/daemon/src/tunnel/journal-schema.ts': ['100644',
                                                                           'bbabfa4bbcdd60eee532839750b945615dba09e4'],
                          'packages/daemon/tests/tunnel/reservations-adoption.test.ts': ['100644',
                                                                                         'd811bdecf69236b37a7abe840fe7507a147c1e24'],
                          'scripts/tunnel-storage-proof/assets.d.ts': ['100644',
                                                                       'b6aea9e3b22518239f56d2996e6ecae8b05e7869']},
             'head': {'packages/daemon/src/tunnel/recovery.ts': ['100644',
                                                                 '1f5afab7bf9aa6bb80a2d11aed8548023f88f568'],
                      'packages/daemon/src/tunnel/journal-settlement.ts': ['100644',
                                                                           'd3f468de721a52ea782b338bfafd883dcb980643'],
                      'scripts/tunnel-storage-proof/recovery.ts': ['100644',
                                                                   '32c62e286a3327eb9c7b0e18634efe0e1fce35bb'],
                      'scripts/tunnel-storage-proof/journal-settlement.ts': ['100644',
                                                                             'e34ed12f9839a08c611dad5e0b8ea13a25c05c71'],
                      'scripts/tunnel-storage-proof/recovery-mutations.py': ['100755',
                                                                             'a755492d2b9113e69b35afd310b85001d726ce93'],
                      'scripts/tunnel-storage-proof/settlement-mutations.py': ['100755',
                                                                               'f41ae56da627d187229905c8c551ddc59c5297e8'],
                      'packages/daemon/tests/tunnel/journal-adoption.test.ts': ['100644',
                                                                                '2d18e2071d53aa351bfdd83b62ec81b722868eae']},
             'identifiers': ['RecoveryOps',
                             'RecoveryStage',
                             'allocatedBlocks',
                             'RecoveryIntent',
                             'SettlementStage',
                             'SETTLEMENT_STAGES',
                             'JournalWriter',
                             'beginJournal',
                             'settleJournal']}}


# One exact native-helper relocation, including its sole reviewed source deletion.
COLD_RELOCATIONS["native-helper"] = {'original': {'scripts/tunnel-storage-proof/recovery-native.ts': ['100644',
                                                                  '749fedcb836744a55a409f59757ecb191f80ec02'],
              'scripts/tunnel-storage-proof/recovery-native.c': ['100644',
                                                                 'b09becbea00e4cb43ef86c4b755299bc72ce06cc'],
              'scripts/tunnel-storage-proof/assets.d.ts': ['100644',
                                                           'b6aea9e3b22518239f56d2996e6ecae8b05e7869'],
              'scripts/tunnel-storage-proof/recovery-probe.ts': ['100644',
                                                                 'f310d3d29628572a27ce3ecba4088a11de6e699b'],
              'scripts/tunnel-storage-proof/settlement-probe.ts': ['100644',
                                                                   'eca0b3d2cc2cb17c5f26b21c8bbc412983948764'],
              'packages/daemon/tests/tunnel/descriptors-adoption.test.ts': ['100644',
                                                                            '173a9bd86c1893d160d849d68492e36c4a4a9003'],
              'packages/daemon/tests/tunnel/journal-adoption.test.ts': ['100644',
                                                                        '2d18e2071d53aa351bfdd83b62ec81b722868eae'],
              'scripts/tunnel-storage-proof/recovery-entry.ts': ['100644',
                                                                 'd010c680d16338a90358255ec001bc84759236b1'],
              'scripts/tunnel-storage-proof/settlement-entry.ts': ['100644',
                                                                   '529f1be7caa6d925b19494a1fac0f8e21d82b588']},
 'head': {'packages/daemon/src/tunnel/recovery-native.ts': ['100644',
                                                            'e29ab96daefc1f1cb414c55a797c2cd23ef3f50e'],
          'packages/daemon/src/tunnel/recovery-native.c': ['100644',
                                                           'b09becbea00e4cb43ef86c4b755299bc72ce06cc'],
          'packages/daemon/src/tunnel/native-assets.d.ts': ['100644',
                                                            '33c4659e3955d6b8fdae060d29cbcb4170bb8c9a'],
          'scripts/tunnel-storage-proof/recovery-native.ts': ['100644',
                                                              '78cad8cea0b4a05426008679192651a4cd02a797'],
          'scripts/tunnel-storage-proof/recovery-native.c': None,
          'scripts/tunnel-storage-proof/assets.d.ts': ['100644', '924974df4447b0daca0bb7b1d3cdfc9f689c9bf4'],
          'packages/daemon/tests/tunnel/native-helper-adoption.test.ts': ['100644',
                                                                          '2eae8b2ddf984b731ae59f48d82238c6df4f0b23']},
 'identifiers': ['recoveryNative',
                 'remi_recovery_open',
                 'remi_recovery_lock',
                 'remi_recovery_cloexec',
                 'remi_recovery_unlink']}

# One exact D1 header admission adoption, with fixed caller/dependency/runner provenance.
COLD_RELOCATIONS["image-admission"] = {'original': {'scripts/tunnel-decoder-proof/admission.ts': ['100644',
                                                            '28212d027cdd9977568808aac7add66cc46ecfbd'],
              'scripts/tunnel-decoder-proof/matrix.py': ['100644',
                                                         'a0917f2dc2056dea4588eacbfaeec28fad09ee4e'],
              'scripts/tunnel-decoder-proof/decode.ts': ['100644',
                                                         '8cb073735dcbf664ec33ddc36ff79aae5d157ea4'],
              'scripts/tunnel-decoder-proof/process.ts': ['100644',
                                                          '17228b7b3f5baa869408d517d8d922a610a650f1'],
              'scripts/tunnel-decoder-proof/worker.ts': ['100644',
                                                         '88ad8abb4eec306a4bb041fb45d0f3a6d5d1de25'],
              'scripts/tunnel-decoder-proof/probe.ts': ['100644', 'c4785cf9ad96a479ebeb973554d9a1e662a29b3b'],
              'scripts/tunnel-decoder-proof/palette-probe.ts': ['100644',
                                                                'f91327378f75a49d33b477b4cfccc29395518482'],
              'scripts/tunnel-decoder-proof/process-probe.ts': ['100644',
                                                                'c2aaafb7043cca567f69639688c19c2281ce930e'],
              'scripts/tunnel-decoder-proof/approval-probe.ts': ['100644',
                                                                 'a9e7ec481c468ece598fd4e3d10c1390101df939'],
              'scripts/tunnel-decoder-proof/approval-entry.ts': ['100644',
                                                                 '44838a4a998ab3eacc61f2d91de120811bc5c6cd'],
              'scripts/tunnel-decoder-proof/approval-assets.ts': ['100644',
                                                                  '1c452c32c43b8c1e557d7f109c606c5cb9c8100c'],
              'scripts/tunnel-decoder-proof/approval-client.ts': ['100644',
                                                                  'ad6668eb05eee059ab3d9c9b9f1ba331cf9e3f43'],
              'scripts/tunnel-decoder-proof/approval-matrix.py': ['100644',
                                                                  'bdf4a799fb2ca40bd72a499d6dfd0bf6af18c488'],
              'scripts/tunnel-decoder-proof/policy-mutations.py': ['100755',
                                                                   'f68e0f6b27439764f936fa0f027f4dad755b3859'],
              'scripts/tunnel-decoder-proof/inputs.json': ['100644',
                                                           'f82d772753a90f34e5a798917d88f9889c1f98d0'],
              'scripts/tunnel-decoder-proof/package.json': ['100644',
                                                            '2bc1f4285da0a604eaa6482f88c3533aebcd3ec3'],
              'scripts/tunnel-decoder-proof/bun.lock': ['100644', '8c71ddc9da7af35abe29123883aadca38fbbda88'],
              'scripts/tunnel-decoder-proof/pngjs.d.ts': ['100644',
                                                          'f6aacee09c0dcee943fbfd8ecb8414cc293f08b6'],
              'scripts/tunnel-decoder-proof/THIRD-PARTY-LICENSES.txt': ['100644',
                                                                        '327518768c5623a62095dcb05ddf8f6fb75c6d82'],
              'scripts/tunnel-decoder-proof/fixture.png': ['100644',
                                                           '83a5ef463464d7e49609e7245cc0265ce0094c52'],
              'scripts/tunnel-decoder-proof/fixture.jpg': ['100644',
                                                           '4e7bfe33c2206d1b7b915975bacf7244f7ac4e58'],
              'scripts/tunnel-storage-proof/matrix.py': ['100644',
                                                         'c339ae6f3b442f3215d5c1d96bcd5dc79924fdaa'],
              'scripts/tunnel-storage-proof/storage-approval-mutations.py': ['100755',
                                                                             'f9e338cbed68841b7aa6c4105bd38a50543f09da'],
              'tsconfig.json': ['100644', '603cbfaa47e2596dc936907599abb2cf04f0e575'],
              'bunfig.toml': ['100644', '3cdd70fa50576ab11b0ca1d8faeac951c3786196'],
              'bun.lock': ['100644', '49c79ac37de53d49aee967dbdc565634cf9ce541']},
 'head': {'packages/daemon/src/tunnel/image-admission.ts': ['100644',
                                                            '8abf0289a844fa6cf4350eda66b41bc993334164'],
          'scripts/tunnel-decoder-proof/admission.ts': ['100644', '9b8d315456b515dd0e51ec441e908462ec3659eb'],
          'scripts/tunnel-decoder-proof/matrix.py': ['100644', 'c65994103d1bf600ccb54a1e5bec84c618598de3'],
          'packages/daemon/tests/tunnel/image-admission-adoption.test.ts': ['100644',
                                                                            'bc8c20b40b53804175ea7c058968dd55f299dc70']},
 'identifiers': ['admitImage', 'MAX_INPUT_BYTES']}

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


# Exact published public sample only; actual .env/secret files are refused before reads.
COLD_PUBLIC_SAMPLE = ("100644", "c3b51a1265174180067d21b01009507e122a88ce")


# A small target resolver, not an import graph: literal relative and known daemon aliases only.
COLD_TRIVIA = r"(?:\s|/\*[\s\S]*?\*/|//[^\n]*\n)*"
COLD_MODULE_REFERENCE = re.compile(
    r"\b(?:from" + COLD_TRIVIA + r"|import" + COLD_TRIVIA + r"(?:\(" + COLD_TRIVIA + r")?|require" +
    COLD_TRIVIA + r"\(" + COLD_TRIVIA + r")['\"]([^'\"\n]+)['\"]"
)


def cold_reference(path, text, targets, identifiers):
    # Literal necessary conditions avoid repeated whole-text regex scans; exact rules stay unchanged.
    if any(identifier in text for identifier in identifiers) and re.search(
            r"(?<![\w$])(?:" + "|".join(identifiers) + r")(?![\w$])", text):
        return True
    # Exact qualified paths are references even outside import syntax (launch/config readers).
    for target in targets:
        if target.removesuffix(".ts") in text and re.search(
                r"(?<![\w$./-])(?:\./)?" + re.escape(target.removesuffix(".ts")) +
                     r"(?:\.[cm]?[jt]s)?(?![\w$./-])", text):
            return True
    for match in COLD_MODULE_REFERENCE.finditer(text):
        specifier = re.sub(r"\\(?:u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\}|x([0-9a-fA-F]{2}))",
                           lambda escape: chr(int(next(value for value in escape.groups() if value is not None), 16)),
                           match.group(1))
        if "\\" in specifier and specifier.startswith((".", "@remi/daemon/")):
            return True
        leaf = re.sub(r"\.[cm]?[jt]s$", "", specifier.replace("\\", "/").rsplit("/", 1)[-1])
        if leaf not in {Path(target).stem for target in targets}:
            continue
        if "\\" in specifier or "\0" in specifier:
            return True
        if specifier.startswith("."):
            parts = list(Path(path).parent.parts)
            for part in specifier.split("/"):
                if part == "..":
                    if not parts:
                        return True
                    parts.pop()
                elif part not in ("", "."):
                    parts.append(part)
            resolved = "/".join(parts)
        elif specifier.startswith("@remi/daemon/"):
            # Alias dot segments can name this producer; keep such spellings conservative.
            if any(part in (".", "..") for part in specifier.removeprefix("@remi/daemon/").split("/")):
                return True
            resolved = "packages/daemon/src/" + specifier.removeprefix("@remi/daemon/")
        else:
            leaf = re.sub(r"\.[cm]?[jt]s$", "", specifier.rsplit("/", 1)[-1])
            if leaf in {Path(target).stem for target in targets}:
                return True
            continue
        resolved = re.sub(r"\.[cm]?[jt]s$", "", resolved)
        if resolved in {target.removesuffix(".ts") for target in targets}:
            return True
    return False


# Only the native-helper policy owns these exact C asset paths; A/B target semantics stay fixed.
COLD_NATIVE_ASSETS = {
    "scripts/tunnel-storage-proof/recovery-native.c",
    "packages/daemon/src/tunnel/recovery-native.c",
}


# Verified factory-calling proof modules/wrappers/tests, checked only from daemon production source.
COLD_NATIVE_CALLERS = {
    "scripts/tunnel-storage-proof/recovery-probe.ts",
    "scripts/tunnel-storage-proof/settlement-probe.ts",
    "scripts/tunnel-storage-proof/recovery-entry.ts",
    "scripts/tunnel-storage-proof/settlement-entry.ts",
    "packages/daemon/tests/tunnel/descriptors-adoption.test.ts",
    "packages/daemon/tests/tunnel/journal-adoption.test.ts",
    "packages/daemon/tests/tunnel/native-helper-adoption.test.ts",
}


def cold_native_asset_reference(path, text):
    # Any literal target contains this exact filename or an escape requiring inspection.
    if "recovery-native.c" not in text and "\\" not in text:
        return False
    def decoded(value):
        return re.sub(r"\\(?:u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\}|x([0-9a-fA-F]{2}))",
                      lambda escape: chr(int(next(part for part in escape.groups() if part is not None), 16)), value)
    # Qualified launch/config strings, including unambiguous escaped spellings.
    normalized = decoded(text)
    for target in COLD_NATIVE_ASSETS:
        if target in normalized and re.search(
                r"(?<![\w$./-])(?:\./)?" + re.escape(target) + r"(?![\w$./-])", normalized):
            return True
    for match in COLD_MODULE_REFERENCE.finditer(text):
        specifier = decoded(match.group(1))
        if "\\" in specifier and specifier.startswith((".", "@remi/daemon/")):
            return True
        if "\\" in specifier:
            unescaped = re.sub(r"\\(.)", r"\1", specifier)
            if unescaped.rsplit("/", 1)[-1] == "recovery-native.c":
                return True
        if specifier.rsplit("/", 1)[-1] != "recovery-native.c":
            continue
        if specifier.startswith("."):
            parts = list(Path(path).parent.parts)
            for part in specifier.split("/"):
                if part == "..":
                    if not parts:
                        return True
                    parts.pop()
                elif part not in ("", "."):
                    parts.append(part)
            resolved = "/".join(parts)
        elif specifier.startswith("@remi/daemon/"):
            suffix = specifier.removeprefix("@remi/daemon/")
            if any(part in (".", "..") for part in suffix.split("/")):
                return True
            resolved = "packages/daemon/src/" + suffix
        else:
            # Unknown bare imports of this candidate asset remain conservative.
            return True
        if resolved in COLD_NATIVE_ASSETS:
            return True
    # Unknown escapes in qualified C launch/config literals remain conservative.
    for match in re.finditer(r"['\"]([^'\"\n]+)['\"]", normalized):
        value = match.group(1)
        if "\\" in value:
            unescaped = re.sub(r"\\(.)", r"\1", value)
            if any(target in unescaped for target in COLD_NATIVE_ASSETS):
                return True
    return False


COLD_IMAGE_BINARY = {
    "scripts/tunnel-decoder-proof/fixture.png",
    "scripts/tunnel-decoder-proof/fixture.jpg",
}
COLD_IMAGE_PRODUCERS = {
    "scripts/tunnel-decoder-proof/admission.ts",
    "scripts/tunnel-decoder-proof/matrix.py",
    "packages/daemon/src/tunnel/image-admission.ts",
    "packages/daemon/tests/tunnel/image-admission-adoption.test.ts",
}
COLD_IMAGE_RUNNERS = {
    "scripts/tunnel-decoder-proof/matrix.py",
    "scripts/tunnel-decoder-proof/approval-matrix.py",
    "scripts/tunnel-decoder-proof/policy-mutations.py",
}
COLD_IMAGE_CALLERS = {
    "scripts/tunnel-decoder-proof/decode.ts",
    "scripts/tunnel-decoder-proof/process.ts",
    "scripts/tunnel-decoder-proof/worker.ts",
    "scripts/tunnel-decoder-proof/probe.ts",
    "scripts/tunnel-decoder-proof/palette-probe.ts",
    "scripts/tunnel-decoder-proof/process-probe.ts",
    "scripts/tunnel-decoder-proof/approval-probe.ts",
    "scripts/tunnel-decoder-proof/approval-entry.ts",
    "packages/daemon/tests/tunnel/image-admission-adoption.test.ts",
}


# D1's exact Python asset paths retain .py rather than the TS resolver's suffix semantics.
COLD_IMAGE_RUNNER_PATH = re.compile(
    r"(?<![\w$./-])((?:\.\.?/|@remi/daemon/)[\w@./-]+\.py)(?![\w$./-])"
)


def cold_image_runner_reference(path, text):
    specifiers = [match.group(1) for match in COLD_MODULE_REFERENCE.finditer(text)]
    specifiers.extend(match.group(1) for match in COLD_IMAGE_RUNNER_PATH.finditer(text))
    for specifier in specifiers:
        if "\\" in specifier and specifier.startswith((".", "@remi/daemon/")):
            return True
        if specifier.replace("\\", "/").rsplit("/", 1)[-1] not in {Path(target).name for target in COLD_IMAGE_RUNNERS}:
            continue
        if "\\" in specifier or "\0" in specifier:
            return True
        if specifier.startswith("."):
            parts = list(Path(path).parent.parts)
            for part in specifier.split("/"):
                if part == "..":
                    if not parts:
                        return True
                    parts.pop()
                elif part not in ("", "."):
                    parts.append(part)
            resolved = "/".join(parts)
        elif specifier.startswith("@remi/daemon/"):
            suffix = specifier.removeprefix("@remi/daemon/")
            if any(part in (".", "..") for part in suffix.split("/")):
                return True
            resolved = "packages/daemon/src/" + suffix
        else:
            # Unknown bare imports of a declared runner filename stay conservative.
            return True
        if resolved in COLD_IMAGE_RUNNERS:
            return True
    return False


def cold_image_reference(path, text, targets, identifiers):
    if cold_reference(path, text, targets, identifiers) or cold_image_runner_reference(path, text):
        return True
    if "\\" not in text:
        return False
    decoded = re.sub(r"\\(?:u([0-9a-fA-F]{4})|u\{([0-9a-fA-F]+)\}|x([0-9a-fA-F]{2}))",
                     lambda escape: chr(int(next(part for part in escape.groups() if part is not None), 16)), text)
    if cold_reference(path, decoded, targets, identifiers) or cold_image_runner_reference(path, decoded):
        return True
    # Unresolved identity spellings of exact candidate references stay conservative.
    unescaped = re.sub(r"\\(.)", r"\1", decoded)
    return cold_reference(path, unescaped, targets, identifiers) or cold_image_runner_reference(path, unescaped)


def cold_relocation_paths(base, head, merge_base, paths):
    changed = set(paths)
    selected = [policy for policy in COLD_RELOCATIONS.values() if changed & set(policy["head"])]
    if not selected:
        return set()
    image_admission = COLD_RELOCATIONS["image-admission"] in selected
    if image_admission and len(selected) != 1:
        return set()
    native_helper = COLD_RELOCATIONS["native-helper"] in selected
    if native_helper and len(selected) != 1:
        return set()
    original, final, identifiers = {}, {}, set()
    for policy in selected:
        original.update(policy["original"])
        final.update(policy["head"])
        identifiers.update(policy["identifiers"])
    if len(selected) == 2:
        # The ordered combined transition starts before A, not from A's new producer state.
        for path in COLD_RELOCATIONS["descriptor"]["head"]:
            if path not in COLD_RELOCATIONS["descriptor"]["original"]:
                original.pop(path, None)
        original.update(COLD_RELOCATIONS["descriptor"]["original"])
    required = set(final)
    if not required <= changed or any(path not in required and not ordinary_soak_doc(path) for path in changed):
        return set()
    try:
        trees = {}
        for ref in dict.fromkeys((base, head, merge_base)):
            raw = git("ls-tree", "-r", "-z", ref)
            if not raw or not raw.endswith(b"\0"):
                return set()
            tree = {}
            for entry in raw[:-1].split(b"\0"):
                header, separator, name = entry.partition(b"\t")
                if not separator or not re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}", header):
                    return set()
                path = name.decode()
                if any(part in ("", ".", "..") for part in path.split("/")) or any(
                        ord(char) < 32 or ord(char) == 127 for char in path):
                    return set()
                tree[path] = (header.split()[0].decode(), header.split()[-1].decode())
            trees[ref] = tree
            if tree.get(".env.example") != COLD_PUBLIC_SAMPLE:
                return set()
        if image_admission and any(not soak_versions_reviewed(trees[ref]) for ref in dict.fromkeys((base, head, merge_base))):
            return set()
        for ref in (base, merge_base):
            if any(trees[ref].get(path) != tuple(pin) for path, pin in original.items()):
                return set()
        expected_head = {**original, **final}
        if any(trees[head].get(path) != (tuple(pin) if pin is not None else None)
               for path, pin in expected_head.items()):
            return set()
        for path in required:
            kind = "D" if final[path] is None else "M" if path in original else "A"
            if kind == "A" and any(path in trees[ref] for ref in (base, merge_base)):
                return set()
            if git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z",
                   merge_base, head, "--", path) != f"{kind}\0{path}\0".encode():
                return set()
        names = {Path(p).name for p in final if p.endswith(".ts")}
        targets = {p for p in original | final if p.endswith(".ts") and Path(p).name in names}
        if image_admission:
            targets.update(COLD_IMAGE_PRODUCERS | COLD_IMAGE_RUNNERS)
        for ref in dict.fromkeys((base, head, merge_base)):
            scan = {}
            for path, (_, blob) in trees[ref].items():
                name = Path(path).name
                if ((name.startswith(".env") and path != ".env.example") or Path(path).suffix.lower() in {".pem", ".key", ".p12"}
                        or name in {"credentials", "secrets.json"}):
                    return set()
                if ref not in (base, head) and path not in expected_head:
                    continue
                if path in expected_head or path == STAGING_EXECUTABLE_DOC or Path(path).suffix.lower() not in {".md", *STAGING_BINARY}:
                    scan[path] = blob
            data = subprocess.check_output(["git", "cat-file", "--batch"],
                                           input="".join(f"{blob}\n" for blob in scan.values()).encode(),
                                           stderr=subprocess.PIPE)
            stream = io.BytesIO(data)
            for path, blob in scan.items():
                header = stream.readline().decode().split()
                if len(header) != 3 or header[:2] != [blob, "blob"] or not header[2].isdigit():
                    return set()
                content = stream.read(int(header[2]))
                if len(content) != int(header[2]) or stream.read(1) != b"\n":
                    return set()
                if image_admission and path in COLD_IMAGE_BINARY:
                    object_digest = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
                    if object_digest != blob:
                        return set()
                    continue
                text = content.decode()
                if "\0" in text:
                    return set()
                if path not in expected_head and path not in {".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py"} and (
                        (cold_image_reference(path, text, targets, identifiers) if image_admission else
                         cold_reference(path, text, targets, identifiers)) or
                        (image_admission and path.startswith("packages/daemon/src/") and
                         cold_image_reference(path, text, COLD_IMAGE_CALLERS, ())) or
                        (native_helper and (cold_native_asset_reference(path, text) or
                            (path.startswith("packages/daemon/src/") and
                             cold_reference(path, text, COLD_NATIVE_CALLERS, ()))))):
                    return set()
            if stream.read():
                return set()
        return required
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError):
        return set()


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
    auth_changed = "packages/daemon/tests/connection-auth.test.ts" in changed
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
            if auth_changed and trees[ref].get(".env.example") != COLD_PUBLIC_SAMPLE:
                return False
            if any(trees[ref].get(path) != ("100644", pin[0]) for path, pin in SOAK_AUTH_COMMENTS.items()):
                return False
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
                if not auth_changed and not path.startswith((*STAGING_SURFACES, "bunfig.toml", "package.json", "tsconfig")):
                    continue
                name = Path(path).name
                if ((name.startswith(".env") and not (auth_changed and path == ".env.example")) or Path(path).suffix.lower() in {".pem", ".key", ".p12"}
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
            for path, blob in scan.items():
                header = stream.readline().decode().split()
                if len(header) != 3 or header[:2] != [blob, "blob"] or not header[2].isdigit():
                    return False
                content = stream.read(int(header[2]))
                if len(content) != int(header[2]) or stream.read(1) != b"\n":
                    return False
                text = content.decode()
                in_original_surfaces = path.startswith((*STAGING_SURFACES, "bunfig.toml", "package.json", "tsconfig"))
                if "\0" in text or (in_original_surfaces and any(token in text for token in SOAK_FIXTURE_TOKENS[:2])):
                    return False
                if "connection-auth" in text:
                    pin = SOAK_AUTH_COMMENTS.get(path)
                    occurrences = [(number, line) for number, line in enumerate(text.splitlines(), 1)
                                   if "connection-auth" in line]
                    if not pin or occurrences != [(pin[1], pin[2])]:
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
        cold_paths = cold_relocation_paths(base, head, merge_base, paths)
        cold_inputs = set().union(*(policy["head"] for policy in COLD_RELOCATIONS.values()))
        accounting_paths = set(paths) & (set(ACCOUNTING_HEAD) - cold_paths)
        accounting_dormant = bool(accounting_paths) and accounting_relocation_is_dormant(base, head, merge_base, paths)
        if set(paths) & cold_inputs and not cold_paths and not accounting_dormant:
            return all_gates("Cold relocation, consumer or scan failure; running all gates")
        if set(paths) & STAGING_INPUTS and not staging_is_dormant(base, head, merge_base, paths):
            return all_gates("Staging consumer, producer state or scan failure; running all gates")
        if accounting_paths and not accounting_dormant:
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
            elif path in cold_paths or path in STAGING_INPUTS or path in ACCOUNTING_HEAD:
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
