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
# #1480: one additional success/error-readiness slice, not a general auth-test exemption.
SOAK_AUTH_READINESS = ("e189888fc0f39dd8684d735784c295803e35b807", "298fdc4d698e2c236279c132d38b7328f1e29dc8")
SOAK_AUTH_READINESS_CI_ORIGINALS = {
    ".github/scripts/ci-scope.py": "18848e51dcf2be15b55c9e73c56bac89813defca",
    ".github/scripts/check-ci-scope.py": "219a49ae6b885a926bcdd87948d53e75df576d10",
    ".github/ci-scope.md": "fec66e6a5a6d51f52f732974ee3b18b066ee29ff",
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
# Separately named, whole reviewed transitions skip only the attached-session soak.
# Exact immutable original/final objects; no directory-wide CLI or dependency exemption.
SOAK_LAUNCH_TRANSITION = {'packages/daemon/src/cli.ts': {'original': ['100644', '3f5c9164ab334223c383381786338b9f80b4186d'],
                                'head': ['100644', '8b48ff687e9d7919edadf815e56191fd1b4bc5d9']},
 'packages/daemon/src/cli/arg-parser.ts': {'original': ['100644', '63ca4b6ef4dafd8a3a7327b556ee745500bbdbd0'],
                                           'head': ['100644', '39a5a83fb52b3c2db50a765f9562a95a0360dbfb']},
 'packages/daemon/src/cli/handlers/create-session-events.ts': {'original': ['100644',
                                                                            'b3ab5d2ba6c317ef6572b3c87cb15f26fda966ea'],
                                                               'head': ['100644',
                                                                        '96900004d7676010ce8a4fcd23ca0a7d4eac5775']},
 'packages/daemon/src/cli/help.ts': {'original': ['100644', '542b9239df9dce57eaa8f427b11c4dfe01f1d8bc'],
                                     'head': ['100644', '89fb1685d96fd1ac00461f1a3ea45ab025aa7c3e']},
 'packages/daemon/src/config/config.ts': {'original': ['100644', 'bf3d041e60f2c2cfaeb9d6687f8b286369513502'],
                                          'head': ['100644', '84898a6ed0122b6fd8f3f52eda51da85ebbcc877']},
 'packages/daemon/src/config/index.ts': {'original': ['100644', 'e6837d1ec9f1cc0fc02b92bcc5ba4aaff3e1ad46'],
                                         'head': ['100644', 'd1d6b33c89e9c09dd71af5f6e52c4f763381262d']},
 'packages/daemon/tests/cli/arg-parser.test.ts': {'original': ['100644',
                                                               'e6d92fae92406e646ff01711256fae368dc69cd4'],
                                                  'head': ['100644',
                                                           '31334c50547fe19b062a40f9ca724fe1b9225166']},
 'packages/daemon/tests/cli/handlers/create-session-events.test.ts': {'original': ['100644',
                                                                                   '60be75159a0ad59a0ad7aaace8070d2adc4de42a'],
                                                                      'head': ['100644',
                                                                               'cd95c919ade56cdd0079c6a60bfa1c89f3912a10']},
 'packages/daemon/tests/cli/handlers/create-session-harness.test.ts': {'original': ['100644',
                                                                                    'f31ff4dc0459566176114a476e9ecc63acdbf421'],
                                                                       'head': ['100644',
                                                                                '52a5dfae90295dd7bf6d388036e2186a3f3d4771']},
 'packages/daemon/tests/cli/handlers/create-session-start.test.ts': {'original': ['100644',
                                                                                  '4a151fb6ad61b98ab95be48ad0eb58dbefa65914'],
                                                                     'head': ['100644',
                                                                              '803b4e348ec6a808f2841f537ded7becf166bf61']},
 'packages/daemon/tests/cli/handlers/create-session-workspace.test.ts': {'original': ['100644',
                                                                                      'd6f18d7073c96cf07472743c560b69bbc02034ad'],
                                                                         'head': ['100644',
                                                                                  '627ff97e456afb344547a522693f426153a8576c']},
 'packages/daemon/tests/cli/help.test.ts': {'original': ['100644',
                                                         'fe62561faaa68470dd37082c23ede476fc393c81'],
                                            'head': ['100644', '8471a5e51fbcef0dbcbcf82283b45e6f25c18223']},
 'packages/daemon/tests/config.test.ts': {'original': ['100644', 'a226aee6fa50885b3c3a392d3c67e65d4a619f30'],
                                          'head': ['100644', '0167ee092e8ee44269b78531940561b207b937e5']},
 'packages/daemon/src/cli/launch-harness.ts': {'original': None,
                                               'head': ['100644',
                                                        'b8cc96c43042a2b53daf71d40d7c651a8ea16e9b']},
 'packages/daemon/tests/cli/default-harness-dispatch.test.ts': {'original': None,
                                                                'head': ['100644',
                                                                         '23b30b7dc2c2b16af0e0b6018fbb8aedbcda90da']},
 'packages/daemon/tests/cli/launch-harness.test.ts': {'original': None,
                                                      'head': ['100644',
                                                               '90c33ec54c6848752f6e8c3cdf36020c3aa27497']}}

SOAK_TRANSITION_CORE = {'.github/workflows/ci.yml': ['100644', 'f1e6b81d801d1982009fba8a0a7da8e4436c37d9'],
 '.github/workflows/macos-app.yml': ['100644', '6ac97a3c8cdf5494f0e13f9cd3cd40560e6d6c29'],
 '.github/workflows/relay-r7.yml': ['100644', '20bfc74dc79e2485908da8872f0a542a3a36bc6c'],
 'bun.lock': ['100644', '49c79ac37de53d49aee967dbdc565634cf9ce541'],
 'bunfig.toml': ['100644', '3cdd70fa50576ab11b0ca1d8faeac951c3786196'],
 'packages/daemon/package.json': ['100644', '17e53aa7653b3035c947ba58428413c8bfa75ef5'],
 'packages/daemon/src/auth/authenticator.ts': ['100644', 'f8a68b408fa1760fd6442369315e440e0d915635'],
 'packages/daemon/src/auth/capability-token.ts': ['100644', 'f929cbf0505ef072a353cb2971a6f3368c5daf0f'],
 'packages/daemon/src/auth/identity-store.ts': ['100644', '6c4a98a3a0442a500a8f0bd85a269343c80df628'],
 'packages/daemon/src/cli/handlers/connection-events.ts': ['100644',
                                                           '1f30465f9cf1f3de36c6c80e5b147ae7446a0dae'],
 'packages/daemon/src/cli/handlers/resume-session-events.ts': ['100644',
                                                               'f8235e28aa8b70bc14453e0554a1713a37b69e61'],
 'packages/daemon/src/cli/handlers/session-events.ts': ['100644', 'a5ac415a44fd9cdbb28dface5ad174539866bf64'],
 'packages/daemon/src/cli/pty-quiescence-gate.ts': ['100644', '7f60896799c6193ead7d5851da36bc718e60d676'],
 'packages/daemon/src/cli/remote-new-client.ts': ['100644', '8fa803aa17936bcaafe7e0c7ac174f7880f3a406'],
 'packages/daemon/src/cli/session-phases/pty-session-setup.ts': ['100644',
                                                                 'e852d2b1db5032e514db2d6a4eb334a320af8671'],
 'packages/daemon/src/cli/startup-env.ts': ['100644', 'd77788e1fad103720001f88f1ae55550c3502236'],
 'packages/daemon/src/cli/suspend-handler.ts': ['100644', '9cb31a9ae267df274757ba1ebb7f4f31a7cea926'],
 'packages/daemon/src/cli/wrapper-state.ts': ['100644', 'db6b791a5ce1ab391322ef7d2c937f0104c8e425'],
 'packages/daemon/src/harness/claude-args.ts': ['100644', '69dc77c474d36faea0760ad84c835abd171d0543'],
 'packages/daemon/src/harness/claude-session.ts': ['100644', '1d7362041dcc5c05fcd27057afe4c745b14fdbdf'],
 'packages/daemon/src/harness/claude-transcript-path.ts': ['100644',
                                                           'ef9ce428e53cec6da98567a4812214ac55d47e95'],
 'packages/daemon/src/harness/claude.ts': ['100644', 'e89ea479b43b49c367656a10630db45074487d36'],
 'packages/daemon/src/harness/codex/app-server-client.ts': ['100644',
                                                            '6ecf80bc50ac7509a7a83d472095905351e1d7c5'],
 'packages/daemon/src/harness/codex/app-server-protocol.ts': ['100644',
                                                              '55f78c4ec04be6207b1dafd0346d8c9afdf056fb'],
 'packages/daemon/src/harness/codex/approval-cards.ts': ['100644',
                                                         '853098bd80b8d4d46eed4afd8bc89e9236b22db9'],
 'packages/daemon/src/harness/codex/attach-hint.ts': ['100644', '883bdbb5429b8b3fd4fe76f22fcc8ab803b612f5'],
 'packages/daemon/src/harness/codex/codex-args.ts': ['100644', 'b813c10a27d90c6d09ba564e9030cea5a6c6e00a'],
 'packages/daemon/src/harness/codex/codex-chat.ts': ['100644', '6e76f6a81174d94fc72febb0a372cf6ad528f016'],
 'packages/daemon/src/harness/codex/codex-decisions.ts': ['100644',
                                                          'c502557a0c2cd4967904f54196c57fa6ee0bd4c7'],
 'packages/daemon/src/harness/codex/codex-session.ts': ['100644', '8409518303eb8e1be39d7bd0352e7d06c95beeaf'],
 'packages/daemon/src/harness/codex/codex-socket.ts': ['100644', '2694d71eee5ac9c9f91fd439c05e4e86f67e4e24'],
 'packages/daemon/src/harness/codex/codex-turns.ts': ['100644', 'e84752489e3f376db573c9b265d455bdea214061'],
 'packages/daemon/src/harness/codex/codex.ts': ['100644', '17fc9707c872684d39a66c2cc5e984a090d32097'],
 'packages/daemon/src/harness/codex/describe-error.ts': ['100644',
                                                         'af315b407659cdf6a8063ba5d29a4f3a84dcb7c6'],
 'packages/daemon/src/harness/codex/safe-text.ts': ['100644', 'f223f460eb8aa214414c89c41b44d2168aca7084'],
 'packages/daemon/src/harness/codex/startup-output.ts': ['100644',
                                                         '66ae30df7a5a9300cbda30cd2f59826b4ff870eb'],
 'packages/daemon/src/harness/codex/terminal-words.ts': ['100644',
                                                         'eb9c608c510e9694a0f96c89ce388ac259a36730'],
 'packages/daemon/src/harness/codex/thread-id.ts': ['100644', '3c2ecac64b41573708fc92239f09895c5444e3cc'],
 'packages/daemon/src/harness/codex/thread-protocol.ts': ['100644',
                                                          'd741c51c7e13133648368862daedf7e4dd66fd0b'],
 'packages/daemon/src/harness/codex/thread-tracker.ts': ['100644',
                                                         '08c583da4b17c7844a5db98a978bc64ad69e6d37'],
 'packages/daemon/src/harness/codex/unix-ws.ts': ['100644', '814cedf9443ba0d58c742e8edf2fc6a3532f65a7'],
 'packages/daemon/src/harness/codex/ws-frames.ts': ['100644', 'a1857aecd0319f59bb238a3cd0f94fc978ce86a0'],
 'packages/daemon/src/harness/decision.ts': ['100644', 'c51b0c0f2f45370c6cb3660ba4dbf0ba9cd35f38'],
 'packages/daemon/src/harness/index.ts': ['100644', '6731514b12fdad0762e29b2d2a3e15414e58c58b'],
 'packages/daemon/src/harness/registry.ts': ['100644', '9a3f5ae0fe512d948b1f54062087805f0ffaa565'],
 'packages/daemon/src/harness/types.ts': ['100644', 'e98f687aab397f6ba8b9a1f00d481193f0bc0cde'],
 'packages/daemon/src/notifications/secure-push-transport.ts': ['100644',
                                                                '1f4e10710f067d78f13a250f75de1e7aacf233ea'],
 'packages/daemon/src/notifications/turn-timer.ts': ['100644', '4741d4e8a0e7bcfebb9df0248b98bf6966be1104'],
 'packages/daemon/src/remote/child-proxy.ts': ['100644', 'b0eecb7ace831ced3d80e5f783f9673bba0a05ae'],
 'packages/daemon/src/remote/hub-relay.ts': ['100644', 'b7140f1463541708b73d63ee524bc8c0a17fec1b'],
 'packages/daemon/src/remote/native-answer-ledger.ts': ['100644', 'f7b9c97ee7d984caf1c23d639d5c8b1f88bf29a4'],
 'packages/daemon/src/remote/relay-device-store.ts': ['100644', '1e037163ac4d403824062229fec43ef42e9e8838'],
 'packages/daemon/src/remote/relay-url.ts': ['100644', '583585d1ad406ada6f4504e48d21736a65c6bf60'],
 'packages/daemon/src/remote/worker-control.ts': ['100644', '87c8261dc84054a9e496fa6ccef25899b5d18457'],
 'packages/daemon/src/server/answer-results.ts': ['100644', '2ada4133a85b1a0f32137538dc013531b6dacdd2'],
 'packages/daemon/src/server/client-message-events.ts': ['100644',
                                                         '88e1780e2dc124c45f3063e8213b1c496050b2cb'],
 'packages/daemon/src/server/connection.ts': ['100644', 'a0bee1003e89109c853e30aa7a8cd6afc2443111'],
 'packages/daemon/src/server/websocket-server.ts': ['100644', '186da5f237c6783602c832633d8e9fa21006f872'],
 'packages/daemon/src/session/index.ts': ['100644', '4fd56f7c3f2b7f4a30bd9e647cbc931c4e0c36bd'],
 'packages/daemon/src/session/legacy-writers.ts': ['100644', 'b59f67e5b27e482cf525e03a5ba396764b69f073'],
 'packages/daemon/src/session/pending-question-created-at-tracker.ts': ['100644',
                                                                        '7051b1ad41dd4b152084ed152a7367323bb40e17'],
 'packages/daemon/src/session/pending-question-label.ts': ['100644',
                                                           '6ee851b9a581b9542db483f4a8939cf0a6bdf302'],
 'packages/daemon/src/session/port-utils.ts': ['100644', 'c9a8af94b6b7d7a31e85688276e6566a41eb4f14'],
 'packages/daemon/src/session/process-alive.ts': ['100644', '459c67f8c0cf1dfea6761f3bc5f78b3cce910a12'],
 'packages/daemon/src/session/question-store.ts': ['100644', 'c3f70c9877f24ceb13308b27c88a1de6ca1e7cd6'],
 'packages/daemon/src/session/question-trace.ts': ['100644', '6598b66870c98761b7b9738aa6fdf0b082abd15b'],
 'packages/daemon/src/session/session-binding-store.ts': ['100644',
                                                          '51047d43c27b9046ca04086fa321c1b1c1454cc7'],
 'packages/daemon/src/session/session-name.ts': ['100644', '9d5c9434c92bc84e980ae4f201c2e68b0e0ecc55'],
 'packages/daemon/src/session/session-registry-file.ts': ['100644',
                                                          '0f96f4ddde50359095700538e930d030ae6a5de3'],
 'packages/daemon/src/session/session-registry.ts': ['100644', '99e97f2339898bf15e6d341d480f332cd00256bb'],
 'packages/daemon/src/session/session-store.ts': ['100644', '9c5c5c9cab4696003a76a0abb59e603032591028'],
 'packages/daemon/src/session/shell-quote.ts': ['100644', 'ef81253c90f6c9359e1b8fbff0a47a8e5b6bef9f'],
 'packages/daemon/src/session/transcript-index.ts': ['100644', '1604be004ceebbbb705e3dcad59e68e7237fdac2'],
 'packages/shared/package.json': ['100644', '8189dd3c4837465936e6d2402dc3bc4c4511c204'],
 'packages/shared/src/harness.ts': ['100644', '41650234e78992aa2ab70ba5bce6176d8906c0dc'],
 'packages/shared/src/index.ts': ['100644', '8dc617a1964b84e6920fefb63af3531f58ffc62c'],
 'packages/shared/src/protocol.ts': ['100644', '2a0bf202aff551d159e7aeb1587aa6cd1a08cd03'],
 'packages/shared/src/relay/bytes.ts': ['100644', '9f44a6e8eaf73d74f0d5f118392204b260382511'],
 'packages/shared/src/relay/channel.ts': ['100644', 'eaefa6f57c3e1bc0c2dbf3a8a48fc1a1887200e9'],
 'packages/shared/src/relay/constants.ts': ['100644', 'd50ceb1bdb8219dd809b2860f4cee437bdbe201f'],
 'packages/shared/src/relay/deterministic.ts': ['100644', '98c403c1044fcd846847a8d0a4b91da26d0d8274'],
 'packages/shared/src/relay/envelope.ts': ['100644', '64d9980ec5312b5c6e5e528f216d23b51c8dc144'],
 'packages/shared/src/relay/errors.ts': ['100644', '16836dc4edccef52c23df5b635c6b3c727bae4f5'],
 'packages/shared/src/relay/handshake.ts': ['100644', 'cf58383ce6af7b3d57ec13bfaa7e9aa732c8ac13'],
 'packages/shared/src/relay/index.ts': ['100644', 'fa2c8365c701d774baa501329ec06d9f960e146a'],
 'packages/shared/src/relay/internal.ts': ['100644', 'd925c04c0687904a1f6d71518205bd589a89fc0b'],
 'packages/shared/src/relay/native-answer.ts': ['100644', '60cd4ab2efff2bec763075bbdf9d6dd11270afa8'],
 'packages/shared/src/relay/pairing.ts': ['100644', 'dc3ec378b667afd420fd1cc51d9dde9f6bef9ba4'],
 'packages/shared/src/relay/primitives.ts': ['100644', '16066615c18269c54de56e2cc7c3155ad3434234'],
 'packages/shared/src/relay/push.ts': ['100644', '2e0a4a18d146277c610bd92982a2dbc566128d02'],
 'packages/shared/src/relay/seal.ts': ['100644', '9c524aa07dc2fac1bedc13f53da8555e5f784875'],
 'packages/shared/src/relay/small-order.ts': ['100644', 'af66d5b95f0cc8b5b02ba752a341c1267d6fcb67'],
 'packages/shared/src/relay/strict-json.ts': ['100644', '460e2ebaa82492b7fb2071e142474d6f4396191e'],
 'packages/shared/src/relay/worker-wire.ts': ['100644', 'aa1d36699f2ca229f213f714956164b171a1c846'],
 'packages/signaling/package.json': ['100644', 'd9d9adf58b99873f04eeaff3ff8a5c3026250305'],
 'packages/signaling/src/admission.ts': ['100644', 'e6aa32f1cb2d157fd4e3bdb88440b3b9b72ac76e'],
 'packages/signaling/src/apns.ts': ['100644', 'c1c699ec4c88c43a51f877ef3aadc0c5837d8a0d'],
 'packages/signaling/src/bearer.ts': ['100644', '27c4b716e903d5dfb8de3754edb50ad2ee9125dc'],
 'packages/signaling/src/connection-room.ts': ['100644', 'da13ef5fe90c5e452eb29dc039eca1b2afbe1eb7'],
 'packages/signaling/src/enrollment.ts': ['100644', 'd9b76976161bf42fb415237f90ab48f9fceb63e2'],
 'packages/signaling/src/index.ts': ['100644', 'a9fc71866c3d172598554f98cd5ad9a8c8e1e868'],
 'packages/signaling/src/limiter.ts': ['100644', 'a5e60022d06229cf41381aee45e89a8726dfc461'],
 'packages/signaling/src/limits.ts': ['100644', 'fcb2fd3dcb9fe0c85c14489fc1f487d4e75fa2b5'],
 'packages/signaling/src/push-gateway.ts': ['100644', '5a3edd565eef97f75df6dc7cc784f68570536e25'],
 'packages/signaling/src/push-storage.ts': ['100644', '7de116d157e3fda50159a1d24e82c59ba6c32686'],
 'packages/signaling/src/rate-limiter.ts': ['100644', '5d312efc19e656c935b325a8d2711776a9390fdd'],
 'packages/signaling/tests/e2e/endpoints.ts': ['100644', '95efbb070e2cae88b306fa9ea1aa50207e95b7e9'],
 'packages/signaling/tests/e2e/harness.ts': ['100644', 'df152a92fd95d8dcfd5176e79c3110aa7b500628'],
 'packages/signaling/tests/e2e/test-entry.ts': ['100644', 'be546df77024a1e7e3a32023ac53e5175627f526'],
 'packages/web/package.json': ['100644', '4baf5ddc324c0b25b4cf13a27c0d1c4a9f43b00c'],
 'packages/web/src/lib/relay-machine-channel.ts': ['100644', 'ea1ca3127869e3d82cd85967a2f953bea6d31a25'],
 'packages/web/src/lib/relay-requests.ts': ['100644', '118751c5c072a51bfcd921cf68696e1d425209c0'],
 'packages/web/tests/helpers/relay-hub.ts': ['100644', 'c7cbf893b5cc3365952da29bed6403b32cda0d52'],
 'packages/web/tests/relay-r7-soak.test.ts': ['100644', '62563dd6a34518982397ca0cfb0c8f99a387b412'],
 'tsconfig.json': ['100644', '603cbfaa47e2596dc936907599abb2cf04f0e575']}

SOAK_DECODE_TRANSITION = {'packages/daemon/src/tunnel/image-decode.ts': {'original': None,
                                                'head': ['100644',
                                                         '25ae95a288670b82cf31fe6001e5645f4d4a2f15']},
 'packages/daemon/src/tunnel/image-codecs.d.ts': {'original': None,
                                                  'head': ['100644',
                                                           'c50870abd8214f2fcdb5a2b6072da9b31066f0f5']},
 'scripts/tunnel-decoder-proof/decode.ts': {'original': ['100644',
                                                         '8cb073735dcbf664ec33ddc36ff79aae5d157ea4'],
                                            'head': ['100644', 'b62df2279fb59d141f5b62cf133467d8b81fbd72']},
 'scripts/tunnel-decoder-proof/pngjs.d.ts': {'original': ['100644',
                                                          'f6aacee09c0dcee943fbfd8ecb8414cc293f08b6'],
                                             'head': ['100644', '1a662b41f542b64f98b3461addf2b98b00fdfd81']},
 'packages/daemon/package.json': {'original': ['100644', '17e53aa7653b3035c947ba58428413c8bfa75ef5'],
                                  'head': ['100644', '063226a265e95c4e2373597db71b8f887eb89a45']},
 'bun.lock': {'original': ['100644', '49c79ac37de53d49aee967dbdc565634cf9ce541'],
              'head': ['100644', '050863afa48b7cbb21fe70f36ee15457523c820a']},
 'scripts/tunnel-decoder-proof/matrix.py': {'original': ['100644',
                                                         'c65994103d1bf600ccb54a1e5bec84c618598de3'],
                                            'head': ['100644', 'abf3a6744fc4bdfc5f59c1e060b1619a68facb5b']},
 'scripts/tunnel-decoder-proof/approval-matrix.py': {'original': ['100644',
                                                                  'bdf4a799fb2ca40bd72a499d6dfd0bf6af18c488'],
                                                     'head': ['100644',
                                                              '4149b35c7cc2ee9d56d647cc3e03c6310d685a29']},
 'packages/daemon/tests/tunnel/image-decode-adoption.test.ts': {'original': None,
                                                                'head': ['100644',
                                                                         '9a999f774491bb38def97d4b99089ef409823482']},
 'scripts/tunnel-decoder-proof/THIRD-PARTY-LICENSES.txt': {'original': ['100644',
                                                                        '327518768c5623a62095dcb05ddf8f6fb75c6d82'],
                                                           'head': ['100644',
                                                                    '8c0cfe6ca437665a04f278c832d148f658368c69']}}

SOAK_DECODE_SUPPORT = {'scripts/tunnel-decoder-proof/admission.ts': ['100644', '9b8d315456b515dd0e51ec441e908462ec3659eb'],
 'scripts/tunnel-decoder-proof/process.ts': ['100644', '17228b7b3f5baa869408d517d8d922a610a650f1'],
 'scripts/tunnel-decoder-proof/worker.ts': ['100644', '88ad8abb4eec306a4bb041fb45d0f3a6d5d1de25'],
 'scripts/tunnel-decoder-proof/probe.ts': ['100644', 'c4785cf9ad96a479ebeb973554d9a1e662a29b3b'],
 'scripts/tunnel-decoder-proof/palette-probe.ts': ['100644', 'f91327378f75a49d33b477b4cfccc29395518482'],
 'scripts/tunnel-decoder-proof/process-probe.ts': ['100644', 'c2aaafb7043cca567f69639688c19c2281ce930e'],
 'scripts/tunnel-decoder-proof/approval-probe.ts': ['100644', 'a9e7ec481c468ece598fd4e3d10c1390101df939'],
 'scripts/tunnel-decoder-proof/approval-entry.ts': ['100644', '44838a4a998ab3eacc61f2d91de120811bc5c6cd'],
 'scripts/tunnel-decoder-proof/approval-assets.ts': ['100644', '1c452c32c43b8c1e557d7f109c606c5cb9c8100c'],
 'scripts/tunnel-decoder-proof/approval-client.ts': ['100644', 'ad6668eb05eee059ab3d9c9b9f1ba331cf9e3f43'],
 'scripts/tunnel-decoder-proof/policy-mutations.py': ['100755', 'f68e0f6b27439764f936fa0f027f4dad755b3859'],
 'scripts/tunnel-decoder-proof/inputs.json': ['100644', 'f82d772753a90f34e5a798917d88f9889c1f98d0'],
 'scripts/tunnel-decoder-proof/package.json': ['100644', '2bc1f4285da0a604eaa6482f88c3533aebcd3ec3'],
 'scripts/tunnel-decoder-proof/bun.lock': ['100644', '8c71ddc9da7af35abe29123883aadca38fbbda88'],
 'scripts/tunnel-decoder-proof/fixture.png': ['100644', '83a5ef463464d7e49609e7245cc0265ce0094c52'],
 'scripts/tunnel-decoder-proof/fixture.jpg': ['100644', '4e7bfe33c2206d1b7b915975bacf7244f7ac4e58'],
 'scripts/tunnel-storage-proof/matrix.py': ['100644', 'c339ae6f3b442f3215d5c1d96bcd5dc79924fdaa'],
 'scripts/tunnel-storage-proof/storage-approval-mutations.py': ['100755',
                                                                'f9e338cbed68841b7aa6c4105bd38a50543f09da'],
 'tsconfig.json': ['100644', '603cbfaa47e2596dc936907599abb2cf04f0e575'],
 'bunfig.toml': ['100644', '3cdd70fa50576ab11b0ca1d8faeac951c3786196'],
 'packages/daemon/src/tunnel/image-admission.ts': ['100644', '8abf0289a844fa6cf4350eda66b41bc993334164'],
 'packages/daemon/tests/tunnel/image-admission-adoption.test.ts': ['100644',
                                                                   'bc8c20b40b53804175ea7c058968dd55f299dc70']}

SOAK_DECODE_WORKER_TRANSITION = {'packages/daemon/src/tunnel/image-process.ts': {'original': None,
                                                 'head': ['100644',
                                                          '2044a8e538b748c7d64e1e3c3aa388033dca0b89']},
 'packages/daemon/src/tunnel/image-worker.ts': {'original': None,
                                                'head': ['100644',
                                                         'b5500f17c8499d76876e5c0a61c7ece825f1113e']},
 'scripts/tunnel-decoder-proof/process.ts': {'original': ['100644',
                                                          '17228b7b3f5baa869408d517d8d922a610a650f1'],
                                             'head': ['100644', 'cd885edf0d140d2eef2d2117288b69f1532cde8e']},
 'scripts/tunnel-decoder-proof/worker.ts': {'original': ['100644',
                                                         '88ad8abb4eec306a4bb041fb45d0f3a6d5d1de25'],
                                            'head': ['100644', 'b890efc6d27a6695e2896ff2628be85e9338912a']},
 'packages/daemon/tests/tunnel/image-worker-adoption.test.ts': {'original': None,
                                                                'head': ['100644',
                                                                         '4b520ecb09a68b2af9dfceafea7822c355e64e60']}}

# Exact #1170 source-entry publication: 12 source paths plus two named prose docs.
# The commit is a public reconstruction root, not an unpublished local candidate.
SOAK_IMAGE_ENTRY_SOURCE_ROOT = "b65935ca91b88e879c7912caa2995365faf684a9"
SOAK_IMAGE_ENTRY_BASE = "ecf97af4349a7bbad24a4328c301097f59ed944e"
# Public ecf97/b659 source pins for the entry transition. These four blobs
# advanced in the published source reconciliation; prior transition maps stay
# frozen for their own controls.
SOAK_IMAGE_ENTRY_CORE = {
    **SOAK_TRANSITION_CORE,
    "bun.lock": ["100644", "050863afa48b7cbb21fe70f36ee15457523c820a"],
    "packages/daemon/package.json": ["100644", "063226a265e95c4e2373597db71b8f887eb89a45"],
}
SOAK_IMAGE_ENTRY_SUPPORT = {
    **SOAK_DECODE_SUPPORT,
    "scripts/tunnel-decoder-proof/process.ts": ["100644", "cd885edf0d140d2eef2d2117288b69f1532cde8e"],
    "scripts/tunnel-decoder-proof/worker.ts": ["100644", "b890efc6d27a6695e2896ff2628be85e9338912a"],
    # Existing decoder test is an approved baseline caller, pinned byte-for-byte.
    "packages/daemon/tests/tunnel/image-decode-adoption.test.ts": ["100644", "9a999f774491bb38def97d4b99089ef409823482"],
    # Existing worker adoption test is likewise a pinned caller of proof helpers.
    "packages/daemon/tests/tunnel/image-worker-adoption.test.ts": ["100644", "4b520ecb09a68b2af9dfceafea7822c355e64e60"],
}
SOAK_IMAGE_ENTRY_DOCS = {".context/plan.md", "docs/FILE-TUNNEL.md"}
SOAK_IMAGE_ENTRY_CALLERS = ("--internal-image-worker", "imageWorkerCommand", "createImageDecoder")
SOAK_IMAGE_ENTRY_VERSION_TRACE = {
    "packages/daemon/src/cli.ts": "64dfa90caf54d92b98fee3ed39cf5f5f058758cb82acc539d8531415401d1fa2",
    "package.json": "406d8dcec0c16794fbbf97d4d77b1030c856da213ec551a802f8d6dc31022168",
}
SOAK_IMAGE_ENTRY_TRANSITION = {
    ".github/workflows/release.yml": {"original": ["100644", "d02019f51640b15c0f374891096d513b6d64e34a"],
                                      "head": ["100644", "d2c3e2189418d6b36f9e3efb898f3e0f72d20816"]},
    "package.json": {"original": ["100644", "38805e9810a53d2c941094bfe2e599812d015a49"],
                     "head": ["100644", "dc807854e06666da706d4d6984c1dd11716ac21b"]},
    "packages/daemon/package.json": {"original": ["100644", "063226a265e95c4e2373597db71b8f887eb89a45"],
                                     "head": ["100644", "db898b9c969f69b6a60561fae7e44b2e10690f9d"]},
    "packages/daemon/src/cli/daemon-manager.ts": {"original": ["100644", "adbc1bc8228685ad4a0b1e9aa754615264ebe0ae"],
                                                  "head": ["100644", "02642b62146955e1ddcfdb7d84bea70b9f8ddf5e"]},
    "packages/daemon/src/entry.ts": {"original": None, "head": ["100644", "9819108666d5c86a5543268ee5687c685be00905"]},
    "packages/daemon/src/tunnel/image-process.ts": {"original": ["100644", "2044a8e538b748c7d64e1e3c3aa388033dca0b89"],
                                                    "head": ["100644", "c68a187eaffa1f95b1954b4709b6852f217c6f65"]},
    "packages/daemon/src/tunnel/image-worker-command.ts": {"original": None,
                                                           "head": ["100644", "9b889c11a3a03c4dd8dd3f6d729ba00bdbc4a4dc"]},
    "packages/daemon/tests/cli/daemon-manager-command.test.ts": {"original": None,
                                                                 "head": ["100644", "62260c5fa1b3e97783f296e116b1f8a358a039b0"]},
    "packages/daemon/tests/tunnel/image-entry.test.ts": {"original": None,
                                                         "head": ["100644", "46e6746319b428e0e464c652dc688ad7c16cb41f"]},
    "scripts/third-party-notices.ts": {"original": ["100644", "ccc990c2dd94a2dbd1f75b95bb78d1efdccb436f"],
                                       "head": ["100644", "f051e09f223f6416adffc58a43547e06c0b3d9ea"]},
    "tests/integration/Dockerfile": {"original": ["100644", "47a44e6aa3b10949d70a031aba6af9dabdc67c7c"],
                                     "head": ["100644", "f6471a40e332a23711e406ba47982df008be7756"]},
    "tests/integration/image-worker-entry.ts": {"original": None,
                                                "head": ["100644", "11df757dfe0088d9debb2427f6a4571276173cc3"]},
}

SOAK_LAUNCH_VERSION_TRACE = {
    **SOAK_VERSION_TRACE,
    "packages/daemon/src/cli.ts": "64dfa90caf54d92b98fee3ed39cf5f5f058758cb82acc539d8531415401d1fa2",
}

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


# #1476 public reconstruction inputs only; candidate head objects are reconstructed by the corpus.
VALIDATION_PUBLIC_ROOTS = (
    "a0f0c8502a518aa41ef48145eef3b0cd87a1e593",
    "b9c2e49a0a5e02186737c041551f5548147b9938",
    "c04f69541be39ea5ed1aac58abe396ce04e8afbc",
    "c1c71ef456d075bd11c6bc01d4648fe6ee24169d",
    "f22bf6e360a16a8c3ae7c1ae0fe9a49eea612ab7",
    SOAK_IMAGE_ENTRY_SOURCE_ROOT,
)
VALIDATION_PUBLIC_BLOBS = (
    "08c583da4b17c7844a5db98a978bc64ad69e6d37",
    "0f96f4ddde50359095700538e930d030ae6a5de3",
    "0fd828d6765a85743f82090aa9042cfd2fc2bc7d",
    "118751c5c072a51bfcd921cf68696e1d425209c0",
    "1604be004ceebbbb705e3dcad59e68e7237fdac2",
    "16066615c18269c54de56e2cc7c3155ad3434234",
    "16836dc4edccef52c23df5b635c6b3c727bae4f5",
    "17228b7b3f5baa869408d517d8d922a610a650f1",
    "173a9bd86c1893d160d849d68492e36c4a4a9003",
    "17e53aa7653b3035c947ba58428413c8bfa75ef5",
    "17fc9707c872684d39a66c2cc5e984a090d32097",
    "186da5f237c6783602c832633d8e9fa21006f872",
    "18848e51dcf2be15b55c9e73c56bac89813defca",
    "1c452c32c43b8c1e557d7f109c606c5cb9c8100c",
    "1d7362041dcc5c05fcd27057afe4c745b14fdbdf",
    "1d88c31c7be8deed30e56a6a3e3af00a652fab64",
    "1e037163ac4d403824062229fec43ef42e9e8838",
    "1f30465f9cf1f3de36c6c80e5b147ae7446a0dae",
    "1f4e10710f067d78f13a250f75de1e7aacf233ea",
    "1f5afab7bf9aa6bb80a2d11aed8548023f88f568",
    "20bfc74dc79e2485908da8872f0a542a3a36bc6c",
    "219a49ae6b885a926bcdd87948d53e75df576d10",
    "266b9db3cdfc1de295c2a7190277da6c11a9e5ff",
    "2694d71eee5ac9c9f91fd439c05e4e86f67e4e24",
    "27c4b716e903d5dfb8de3754edb50ad2ee9125dc",
    "28212d027cdd9977568808aac7add66cc46ecfbd",
    "2a0bf202aff551d159e7aeb1587aa6cd1a08cd03",
    "2a8dd22c4468e89cfdff84c4611a453b1356301c",
    "2ada4133a85b1a0f32137538dc013531b6dacdd2",
    "2bc1f4285da0a604eaa6482f88c3533aebcd3ec3",
    "2d18e2071d53aa351bfdd83b62ec81b722868eae",
    "2d662ff7de2779abf9e0903ba98c1f5dedbd4200",
    "2e0a4a18d146277c610bd92982a2dbc566128d02",
    "2eae8b2ddf984b731ae59f48d82238c6df4f0b23",
    "2f070d8de7da9247e8dc153f211dad76732b5d33",
    "2f4e404747aac4d1409bb2882cd23731ae5f38ce",
    "2f9fc8a41331a74e86216c58257847397492f68f",
    "327518768c5623a62095dcb05ddf8f6fb75c6d82",
    "32c62e286a3327eb9c7b0e18634efe0e1fce35bb",
    "33c4659e3955d6b8fdae060d29cbcb4170bb8c9a",
    "3c2ecac64b41573708fc92239f09895c5444e3cc",
    "3cdd70fa50576ab11b0ca1d8faeac951c3786196",
    "3f5c9164ab334223c383381786338b9f80b4186d",
    "41650234e78992aa2ab70ba5bce6176d8906c0dc",
    "41fbabaef6a051bde704610c36bf144ac8a7ca21",
    "44838a4a998ab3eacc61f2d91de120811bc5c6cd",
    "459c67f8c0cf1dfea6761f3bc5f78b3cce910a12",
    "460e2ebaa82492b7fb2071e142474d6f4396191e",
    "4741d4e8a0e7bcfebb9df0248b98bf6966be1104",
    "49c79ac37de53d49aee967dbdc565634cf9ce541",
    "4a151fb6ad61b98ab95be48ad0eb58dbefa65914",
    "4baf5ddc324c0b25b4cf13a27c0d1c4a9f43b00c",
    "4cc18f1200a5f15276cdc0a14377c0985e9d5d7d",
    "4e7bfe33c2206d1b7b915975bacf7244f7ac4e58",
    "4fd56f7c3f2b7f4a30bd9e647cbc931c4e0c36bd",
    "51047d43c27b9046ca04086fa321c1b1c1454cc7",
    "5183f291018ec6e71d63708c35edcaddc926eb09",
    "529f1be7caa6d925b19494a1fac0f8e21d82b588",
    "53b28599c90c3ed31433293b7d600939c9db9bbe",
    "542b9239df9dce57eaa8f427b11c4dfe01f1d8bc",
    "5505b2f8ab4556e86d36b32e13c28f85009db7d7",
    "55f78c4ec04be6207b1dafd0346d8c9afdf056fb",
    "57cb869399e9da0173e8cd8ae11a8b9f8348229a",
    "583585d1ad406ada6f4504e48d21736a65c6bf60",
    "58eb6eb4e197887c88599bbde71c179c95fe0637",
    "5a3edd565eef97f75df6dc7cc784f68570536e25",
    "5bb330b56694c7642a802e477b132b780acef569",
    "5c101f45514ae284e1a08ab6bf5e138281cf6e52",
    "5d312efc19e656c935b325a8d2711776a9390fdd",
    "603cbfaa47e2596dc936907599abb2cf04f0e575",
    "60be75159a0ad59a0ad7aaace8070d2adc4de42a",
    "60cd4ab2efff2bec763075bbdf9d6dd11270afa8",
    "62563dd6a34518982397ca0cfb0c8f99a387b412",
    "62b55ad1aa00224a49e5a4c7c435598040cf6338",
    "63ca4b6ef4dafd8a3a7327b556ee745500bbdbd0",
    "64d9980ec5312b5c6e5e528f216d23b51c8dc144",
    "6598b66870c98761b7b9738aa6fdf0b082abd15b",
    "66288af72b9522b04d7fd846e97789b4307b2e7b",
    "66ae30df7a5a9300cbda30cd2f59826b4ff870eb",
    "6731514b12fdad0762e29b2d2a3e15414e58c58b",
    "6855b1b94ede69f9ee85cd6219c813e8f9d0729d",
    "69dc77c474d36faea0760ad84c835abd171d0543",
    "6ac97a3c8cdf5494f0e13f9cd3cd40560e6d6c29",
    "6b5fed29e5575fb4da1efd1c05e539dfa45c23bf",
    "6c4a98a3a0442a500a8f0bd85a269343c80df628",
    "6e76f6a81174d94fc72febb0a372cf6ad528f016",
    "6ecf80bc50ac7509a7a83d472095905351e1d7c5",
    "6ee851b9a581b9542db483f4a8939cf0a6bdf302",
    "7051b1ad41dd4b152084ed152a7367323bb40e17",
    "71b2cb846cca049e8f0a87ccb86d50d07fb89847",
    "749fedcb836744a55a409f59757ecb191f80ec02",
    "7568a1b1da3e696a169b2197d0aaf3c46d8bd75f",
    "78cad8cea0b4a05426008679192651a4cd02a797",
    "7dc52af2c8146d8bac3ab0f127818456f1248954",
    "7de116d157e3fda50159a1d24e82c59ba6c32686",
    "7f37292c530cbaebdf19b2540303d70ac000dafa",
    "7f60896799c6193ead7d5851da36bc718e60d676",
    "803c290594d7d7db47428bdb0182fe6695355066",
    "814cedf9443ba0d58c742e8edf2fc6a3532f65a7",
    "8189dd3c4837465936e6d2402dc3bc4c4511c204",
    "83a5ef463464d7e49609e7245cc0265ce0094c52",
    "8409518303eb8e1be39d7bd0352e7d06c95beeaf",
    "843726b2347cfc5b99718e914e08f8dd5fffc7f3",
    "853098bd80b8d4d46eed4afd8bc89e9236b22db9",
    "8619bb6b4c833708590061046338183a636aa652",
    "87c8261dc84054a9e496fa6ccef25899b5d18457",
    "883bdbb5429b8b3fd4fe76f22fcc8ab803b612f5",
    "88ad8abb4eec306a4bb041fb45d0f3a6d5d1de25",
    "88e1780e2dc124c45f3063e8213b1c496050b2cb",
    "8abf0289a844fa6cf4350eda66b41bc993334164",
    "8c71ddc9da7af35abe29123883aadca38fbbda88",
    "8cb073735dcbf664ec33ddc36ff79aae5d157ea4",
    "8dc617a1964b84e6920fefb63af3531f58ffc62c",
    "8fa803aa17936bcaafe7e0c7ac174f7880f3a406",
    "917d6178be63d0b7428c8228366a359b429342a1",
    "924974df4447b0daca0bb7b1d3cdfc9f689c9bf4",
    "95d51d1c639c1ecb25fd615f361c5a3cd6b2d69a",
    "95efbb070e2cae88b306fa9ea1aa50207e95b7e9",
    "98c403c1044fcd846847a8d0a4b91da26d0d8274",
    "99afb022d3f4f716f03bf102fae0d811933f5880",
    "99e97f2339898bf15e6d341d480f332cd00256bb",
    "9a3f5ae0fe512d948b1f54062087805f0ffaa565",
    "9b6ba62331eae2b52d31a5e5ebb6793acc14fb72",
    "9b8d315456b515dd0e51ec441e908462ec3659eb",
    "9c524aa07dc2fac1bedc13f53da8555e5f784875",
    "9c5c5c9cab4696003a76a0abb59e603032591028",
    "9cb31a9ae267df274757ba1ebb7f4f31a7cea926",
    "9d5c9434c92bc84e980ae4f201c2e68b0e0ecc55",
    "9f44a6e8eaf73d74f0d5f118392204b260382511",
    "a0917f2dc2056dea4588eacbfaeec28fad09ee4e",
    "a0bee1003e89109c853e30aa7a8cd6afc2443111",
    "a1857aecd0319f59bb238a3cd0f94fc978ce86a0",
    "a226aee6fa50885b3c3a392d3c67e65d4a619f30",
    "a245d6c57204405ae871b59f8022ec96d646b0d4",
    "a5ac415a44fd9cdbb28dface5ad174539866bf64",
    "a5e60022d06229cf41381aee45e89a8726dfc461",
    "a68854f97a72610171ce86ce4b016398cd6d8e2b",
    "a755492d2b9113e69b35afd310b85001d726ce93",
    "a9e7ec481c468ece598fd4e3d10c1390101df939",
    "a9fc71866c3d172598554f98cd5ad9a8c8e1e868",
    "aa1d36699f2ca229f213f714956164b171a1c846",
    "ad6668eb05eee059ab3d9c9b9f1ba331cf9e3f43",
    "af315b407659cdf6a8063ba5d29a4f3a84dcb7c6",
    "af66d5b95f0cc8b5b02ba752a341c1267d6fcb67",
    "b09becbea00e4cb43ef86c4b755299bc72ce06cc",
    "b0eecb7ace831ced3d80e5f783f9673bba0a05ae",
    "b31e80880f1f73e4198c2629ddcd54c5316992f7",
    "b3ab5d2ba6c317ef6572b3c87cb15f26fda966ea",
    "b3f165554abf5a3a6ff8a7cdb8a05a561dc68c2c",
    "b59f67e5b27e482cf525e03a5ba396764b69f073",
    "b6aea9e3b22518239f56d2996e6ecae8b05e7869",
    "b7140f1463541708b73d63ee524bc8c0a17fec1b",
    "b813c10a27d90c6d09ba564e9030cea5a6c6e00a",
    "b9400ba9e33ce35462c4b4de33aa3de4bda94af1",
    "bbabfa4bbcdd60eee532839750b945615dba09e4",
    "bc8c20b40b53804175ea7c058968dd55f299dc70",
    "bdf4a799fb2ca40bd72a499d6dfd0bf6af18c488",
    "be546df77024a1e7e3a32023ac53e5175627f526",
    "bf3d041e60f2c2cfaeb9d6687f8b286369513502",
    "c0747830bac50fed23d96c057df3dc68f98078ea",
    "c1c699ec4c88c43a51f877ef3aadc0c5837d8a0d",
    "c2aaafb7043cca567f69639688c19c2281ce930e",
    "c339ae6f3b442f3215d5c1d96bcd5dc79924fdaa",
    "c3b51a1265174180067d21b01009507e122a88ce",
    "c3f70c9877f24ceb13308b27c88a1de6ca1e7cd6",
    "c4785cf9ad96a479ebeb973554d9a1e662a29b3b",
    "c502557a0c2cd4967904f54196c57fa6ee0bd4c7",
    "c51b0c0f2f45370c6cb3660ba4dbf0ba9cd35f38",
    "c65994103d1bf600ccb54a1e5bec84c618598de3",
    "c7cbf893b5cc3365952da29bed6403b32cda0d52",
    "c9a8af94b6b7d7a31e85688276e6566a41eb4f14",
    "cf58383ce6af7b3d57ec13bfaa7e9aa732c8ac13",
    "d010c680d16338a90358255ec001bc84759236b1",
    "d3f468de721a52ea782b338bfafd883dcb980643",
    "d47d41995742cbc20f993005b4f002c3f6a0898f",
    "d50ceb1bdb8219dd809b2860f4cee437bdbe201f",
    "d6f18d7073c96cf07472743c560b69bbc02034ad",
    "d741c51c7e13133648368862daedf7e4dd66fd0b",
    "d77788e1fad103720001f88f1ae55550c3502236",
    "d811bdecf69236b37a7abe840fe7507a147c1e24",
    "d925c04c0687904a1f6d71518205bd589a89fc0b",
    "d9b76976161bf42fb415237f90ab48f9fceb63e2",
    "d9d9adf58b99873f04eeaff3ff8a5c3026250305",
    "da13ef5fe90c5e452eb29dc039eca1b2afbe1eb7",
    "db6b791a5ce1ab391322ef7d2c937f0104c8e425",
    "dc3ec378b667afd420fd1cc51d9dde9f6bef9ba4",
    "def04c097129b754a394bdae233695da0a0941a8",
    "df152a92fd95d8dcfd5176e79c3110aa7b500628",
    "e0e598b09ea569730495b91e42a485e0541fafd2",
    "e189888fc0f39dd8684d735784c295803e35b807",
    "e29ab96daefc1f1cb414c55a797c2cd23ef3f50e",
    "e34ed12f9839a08c611dad5e0b8ea13a25c05c71",
    "e6837d1ec9f1cc0fc02b92bcc5ba4aaff3e1ad46",
    "e6aa32f1cb2d157fd4e3bdb88440b3b9b72ac76e",
    "e6d92fae92406e646ff01711256fae368dc69cd4",
    "e84752489e3f376db573c9b265d455bdea214061",
    "e852d2b1db5032e514db2d6a4eb334a320af8671",
    "e89ea479b43b49c367656a10630db45074487d36",
    "e98f687aab397f6ba8b9a1f00d481193f0bc0cde",
    "ea1ca3127869e3d82cd85967a2f953bea6d31a25",
    "eaefa6f57c3e1bc0c2dbf3a8a48fc1a1887200e9",
    "eb9c608c510e9694a0f96c89ce388ac259a36730",
    "eca0b3d2cc2cb17c5f26b21c8bbc412983948764",
    "ef81253c90f6c9359e1b8fbff0a47a8e5b6bef9f",
    "ef9ce428e53cec6da98567a4812214ac55d47e95",
    "f1e6b81d801d1982009fba8a0a7da8e4436c37d9",
    "f223f460eb8aa214414c89c41b44d2168aca7084",
    "f310d3d29628572a27ce3ecba4088a11de6e699b",
    "f31ff4dc0459566176114a476e9ecc63acdbf421",
    "f41ae56da627d187229905c8c551ddc59c5297e8",
    "f68e0f6b27439764f936fa0f027f4dad755b3859",
    "f6aacee09c0dcee943fbfd8ecb8414cc293f08b6",
    "f7b9c97ee7d984caf1c23d639d5c8b1f88bf29a4",
    "f8235e28aa8b70bc14453e0554a1713a37b69e61",
    "f82d772753a90f34e5a798917d88f9889c1f98d0",
    "f898c79be3ea9b76aa772b34c066f8a0e0e08374",
    "f8a68b408fa1760fd6442369315e440e0d915635",
    "f91327378f75a49d33b477b4cfccc29395518482",
    "f929cbf0505ef072a353cb2971a6f3368c5daf0f",
    "f9e338cbed68841b7aa6c4105bd38a50543f09da",
    "fa2c8365c701d774baa501329ec06d9f960e146a",
    "fa70712d1cfa04ff8eb28a942c8eb88b3a093713",
    "fcb2fd3dcb9fe0c85c14489fc1f487d4e75fa2b5",
    "fe62561faaa68470dd37082c23ede476fc393c81",
    "fec66e6a5a6d51f52f732974ee3b18b066ee29ff",
)
VALIDATION_REQUIRED_FILES = CI_TOOLS | set(HOOK_TEST_COMMENTS) | {
    ".github/workflows/ci.yml", ".github/workflows/relay-r7.yml", ".github/workflows/macos-app.yml",
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


def soak_versions_reviewed(tree, reviewed=None):
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
    return all(hashlib.sha256(data).hexdigest() == (SOAK_VERSION_TRACE if reviewed is None else reviewed)[path]
               for path, data in normalized.items())


def soak_fixture_only(base, head, merge_base, paths):
    changed = set(paths) & set(SOAK_FIXTURES)
    auth_path = "packages/daemon/tests/connection-auth.test.ts"
    auth_changed = auth_path in changed
    ci_paths = set(paths) & set(SOAK_AUTH_READINESS_CI_ORIGINALS)
    readiness_inputs = (changed == {auth_path} and (not ci_paths or ci_paths == set(SOAK_AUTH_READINESS_CI_ORIGINALS)) and
                        all(path in changed or path in ci_paths or ordinary_soak_doc(path) for path in paths))
    legacy_inputs = bool(changed) and all(path in changed or ordinary_soak_doc(path) for path in paths)
    if not readiness_inputs and not legacy_inputs:
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
        readiness = readiness_inputs and all(trees[ref].get(auth_path) == ("100644", SOAK_AUTH_READINESS[role])
                                             for ref, role in ((base, 0), (merge_base, 0), (head, 1)))
        if not readiness and not legacy_inputs:
            return False
        refs = tuple(dict.fromkeys((base, head, merge_base))) if readiness else (base, head)
        fixture_pins = {**SOAK_FIXTURES, auth_path: SOAK_AUTH_READINESS} if readiness else SOAK_FIXTURES
        if readiness:
            # Bind the whole known CLI state, not just the argv selector or a few tokens.
            states = []
            for role, trace in (("original", SOAK_VERSION_TRACE), ("head", SOAK_LAUNCH_VERSION_TRACE)):
                if all(all(path == "packages/daemon/src/cli.ts" or
                           trees[ref].get(path) == (tuple(values[role]) if values[role] is not None else None)
                           for path, values in SOAK_LAUNCH_TRANSITION.items()) and
                       soak_versions_reviewed(trees[ref], trace) for ref in refs):
                    states.append(role)
            if len(states) != 1:
                return False
            # Actual original/final fixture bodies must be readable, not merely named in a tree.
            contents = validation_objects(dict.fromkeys(SOAK_AUTH_READINESS, "blob"))
            if any("\0" in body.decode() for body in contents.values()):
                return False
            if ci_paths:
                # Changed CI is reviewed/frozen policy input, not evidence of its own trust.
                # Full validator execution remains mandatory for these CI input changes (#1476).
                source_root = Path(__file__).resolve().parents[2]
                originals = validation_objects(dict.fromkeys(SOAK_AUTH_READINESS_CI_ORIGINALS.values(), "blob"))
                if any("\0" in body.decode() for body in originals.values()):
                    return False
                for path, original in SOAK_AUTH_READINESS_CI_ORIGINALS.items():
                    if any(trees[ref].get(path) != ("100644", original) for ref in (base, merge_base)):
                        return False
                    source = source_root / path
                    if source.is_symlink() or source.resolve(strict=True) != source or not source.is_file() or (
                            source.stat().st_mode & 0o777) != 0o644:
                        return False
                    content = source.read_bytes()
                    if len(content) > 8 * 1024 * 1024 or "\0" in content.decode():
                        return False
                    final = hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest()
                    if trees[head].get(path) != ("100644", final):
                        return False
                    status = git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z",
                                 merge_base, head, "--", path)
                    if status != f"M\0{path}\0".encode():
                        return False
                    if validation_objects({final: "blob"})[final] != content:
                        return False
        for ref in refs:
            if auth_changed and trees[ref].get(".env.example") != COLD_PUBLIC_SAMPLE:
                return False
            if any(trees[ref].get(path) != ("100644", pin[0]) for path, pin in SOAK_AUTH_COMMENTS.items()):
                return False
            if any(trees[ref].get(path) != ("100644", blob) for path, blob in SOAK_TRACE.items()):
                return False
            if not readiness and not soak_versions_reviewed(trees[ref]):
                return False
        for path, (old, new) in fixture_pins.items():
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
            return {p: value for p, value in tree.items() if p not in changed and
                    (not readiness or p not in ci_paths) and not ordinary_soak_doc(p)}
        if any(remaining(trees[ref]) != remaining(trees[base]) for ref in refs):
            return False
        for ref in refs:
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
                if (len(header) != 3 or header[:2] != [blob, "blob"] or not header[2].isdigit() or
                        (readiness and int(header[2]) > 8 * 1024 * 1024)):
                    return False
                content = stream.read(int(header[2]))
                if (len(content) != int(header[2]) or stream.read(1) != b"\n" or
                        (readiness and hashlib.sha1(f"blob {len(content)}\0".encode() + content).hexdigest() != blob)):
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


def reviewed_launch_or_decode_only(base, head, merge_base, paths):
    # Match complete changed-path populations before reading the unchanged published graph.
    launch_paths = set(SOAK_LAUNCH_TRANSITION)
    decode_paths = set(SOAK_DECODE_TRANSITION)
    image_entry_paths = set(SOAK_IMAGE_ENTRY_TRANSITION)
    changed = set(paths)
    worker = False
    if launch_paths <= changed:
        name, policy = "CLI-default", SOAK_LAUNCH_TRANSITION
    elif decode_paths <= changed:
        name, policy = "Dormant full-decoder", SOAK_DECODE_TRANSITION
        if changed & set(SOAK_DECODE_WORKER_TRANSITION):
            worker = True
            policy = {**SOAK_DECODE_TRANSITION, **SOAK_DECODE_WORKER_TRANSITION}
    elif image_entry_paths <= changed:
        name, policy = "Image worker entry", SOAK_IMAGE_ENTRY_TRANSITION
    else:
        return None
    required = set(policy)
    if name == "Image worker entry":
        allowed = required | SOAK_IMAGE_ENTRY_DOCS | {"packages/daemon/src/cli.ts"}
        if not required <= changed or not SOAK_IMAGE_ENTRY_DOCS <= changed or changed - allowed:
            return None
    elif not required <= changed or any(path not in required and path not in {"package.json", "packages/daemon/src/cli.ts"} and not ordinary_soak_doc(path)
                                        for path in changed):
        return None
    try:
        trees = {}
        for ref in dict.fromkeys((base, head, merge_base)):
            raw = git("ls-tree", "-r", "-z", ref)
            if not raw or not raw.endswith(b"\0"):
                return None
            tree = {}
            for entry in raw[:-1].split(b"\0"):
                header, separator, path_bytes = entry.partition(b"\t")
                if not separator or not re.fullmatch(rb"100(?:644|755) blob [0-9a-f]{40}", header):
                    return None
                path = path_bytes.decode()
                if any(part in ("", ".", "..") for part in path.split("/")) or any(
                        ord(char) < 32 or ord(char) == 127 for char in path) or path in tree:
                    return None
                mode, _, blob = header.decode().split()
                tree[path] = (mode, blob)
            trees[ref] = tree
        for path, roles in policy.items():
            for ref, role in ((base, "original"), (merge_base, "original"), (head, "head")):
                expected = roles[role]
                if ((name == "CLI-default" and path == "packages/daemon/src/cli.ts") or
                        (name == "Image worker entry" and path == "package.json")):
                    if trees[ref].get(path, (None,))[0] != "100644":
                        return None  # Whole reviewed bytes are normalized below, not weakened.
                elif trees[ref].get(path) != (tuple(expected) if expected is not None else None):
                    return None
            expected_status = "M" if roles["original"] is not None else "A"
            status = git("diff", "--no-ext-diff", "--no-renames", "--name-status", "-z",
                         merge_base, head, "--", path)
            if status != f"{expected_status}\0{path}\0".encode():
                return None
        # The image-entry transition uses its separately reviewed public source
        # baseline, which includes the already-published lock/package/support updates.
        fixed = ({path: value for path, value in SOAK_IMAGE_ENTRY_CORE.items() if path not in required}
                 if name == "Image worker entry" else
                 {path: value for path, value in SOAK_TRANSITION_CORE.items() if path not in required})
        if name in {"Dormant full-decoder", "Image worker entry"}:
            support = SOAK_IMAGE_ENTRY_SUPPORT if name == "Image worker entry" else SOAK_DECODE_SUPPORT
            fixed.update({path: value for path, value in support.items() if path not in required})
        for path, value in fixed.items():
            if any(trees[ref].get(path) != tuple(value) for ref in trees):
                return None
        # Everything else, including root entry/config/consumers and gate files, stays identical.
        exceptional = required | {"package.json", "packages/daemon/src/cli.ts"}
        def remaining(tree):
            return {path: value for path, value in tree.items()
                    if path not in exceptional and not ordinary_soak_doc(path)}
        if any(remaining(trees[ref]) != remaining(trees[merge_base]) for ref in trees):
            return None
        if name == "Dormant full-decoder":
            # Never admit the CLI feature mixed into this separate decoder transition.
            launch_role = None
            for role, trace in (("original", SOAK_VERSION_TRACE), ("head", SOAK_LAUNCH_VERSION_TRACE)):
                if all(all(path == "packages/daemon/src/cli.ts" or
                           trees[ref].get(path) == (tuple(roles[role]) if roles[role] is not None else None)
                           for path, roles in SOAK_LAUNCH_TRANSITION.items()) and
                       soak_versions_reviewed(trees[ref], trace) for ref in trees):
                    launch_role = role
                    break
            if launch_role is None:
                return None
        elif name == "Image worker entry":
            if not all(soak_versions_reviewed(trees[ref], SOAK_LAUNCH_VERSION_TRACE)
                       for ref in dict.fromkeys((base, merge_base))) or not soak_versions_reviewed(
                           trees[head], SOAK_IMAGE_ENTRY_VERSION_TRACE):
                return None
        else:
            if not all(soak_versions_reviewed(trees[ref], SOAK_VERSION_TRACE)
                       for ref in dict.fromkeys((base, merge_base))) or not soak_versions_reviewed(
                           trees[head], SOAK_LAUNCH_VERSION_TRACE):
                return None
        # Pins prove bytes only after successful type/size/UTF-8/NUL/object reads.
        # Known published .env.example is a public sample; actual secret-named files are refused unread.
        scan = {}
        for tree in trees.values():
            for path, (mode, blob) in tree.items():
                filename = Path(path).name
                if ((filename.startswith(".env") and path != ".env.example") or
                        Path(path).suffix.lower() in {".pem", ".key", ".p12"} or
                        filename in {"credentials", "secrets.json"}):
                    return None
                if path == ".env.example" and (mode, blob) != COLD_PUBLIC_SAMPLE:
                    return None
                if path in fixed or path in required or path in {"package.json", "packages/daemon/src/cli.ts"} or (
                        not ordinary_soak_doc(path) and Path(path).suffix.lower() not in STAGING_BINARY):
                    scan[blob] = path
        data = subprocess.check_output(["git", "cat-file", "--batch"],
                                       input="".join(f"{blob}\n" for blob in scan).encode(), stderr=subprocess.PIPE)
        stream = io.BytesIO(data)
        content_by_blob = {}
        for blob, path in scan.items():
            header = stream.readline().decode().split()
            if (len(header) != 3 or header[:2] != [blob, "blob"] or not header[2].isdigit() or
                    int(header[2]) > 8 * 1024 * 1024):
                return None
            content = stream.read(int(header[2]))
            if len(content) != int(header[2]) or stream.read(1) != b"\n" or hashlib.sha1(
                    f"blob {len(content)}\0".encode() + content).hexdigest() != blob:
                return None
            if name in {"Dormant full-decoder", "Image worker entry"} and path in COLD_IMAGE_BINARY:
                continue  # Exact binary fixture mode/blob fixed at all3refs above.
            text = content.decode()
            if "\0" in text:
                return None
            content_by_blob[blob] = text
        if stream.read():
            return None
        if name == "CLI-default":
            targets = {"packages/daemon/src/cli/launch-harness.ts"}
            identifiers = ("resolveLaunchHarness", "isSessionLaunch", "HarnessConfig")
            known = required
        elif name == "Image worker entry":
            targets = {"packages/daemon/src/entry.ts", "packages/daemon/src/tunnel/image-worker-command.ts"}
            identifiers = SOAK_IMAGE_ENTRY_CALLERS
            known = required | set(SOAK_IMAGE_ENTRY_SUPPORT)
        else:
            targets = {"packages/daemon/src/tunnel/image-decode.ts", "packages/daemon/src/tunnel/image-codecs.d.ts",
                       "scripts/tunnel-decoder-proof/decode.ts"}
            identifiers = ("decodeImage",)
            if worker:
                targets |= {"packages/daemon/src/tunnel/image-process.ts", "packages/daemon/src/tunnel/image-worker.ts",
                            "scripts/tunnel-decoder-proof/process.ts", "scripts/tunnel-decoder-proof/worker.ts"}
                identifiers += ("DecoderProcess", "DecoderProcessError", "MAX_RESULT_BYTES", "decodeInput",
                                "decodeWorker", "decodeRepeatedWorker", "DecodedPixels", "DecoderChildExit", "RepeatedDecodeReady")
            known = required | set(SOAK_DECODE_SUPPORT)
        for tree in trees.values():
            for path, (_, blob) in tree.items():
                if path in known or path in {".github/scripts/ci-scope.py", ".github/scripts/check-ci-scope.py"} or (
                        ordinary_soak_doc(path) or Path(path).suffix.lower() in STAGING_BINARY):
                    continue
                text = content_by_blob[blob]
                # Triple-slash declarations/config entry fields can contain literal relative asset paths.
                asset_literals = re.findall(r"\b(?:path|entry|file)[\"']?\s*[:=]\s*[\"']([^\"'\n]+)[\"']", text)
                if asset_literals:
                    text += "\n" + "\n".join(f"import '{literal}';" for literal in asset_literals)
                if (cold_image_reference(path, text, targets, identifiers) if name == "Dormant full-decoder" else
                        cold_reference(path, text, targets, identifiers)):
                    return None
                if name in {"Dormant full-decoder", "Image worker entry"} and cold_image_reference(
                        path, text, COLD_IMAGE_CALLERS | COLD_IMAGE_RUNNERS, ()):
                    return None
        return name + (" with complete owned worker" if worker else "")
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError):
        return None


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
        transition = reviewed_launch_or_decode_only(base, head, merge_base, paths)
        if transition:
            return {**all_gates(f"Exact reviewed {transition} transition; ordinary and short relay controls retained"),
                    "relay_soak": False}
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


def validation_input(path):
    return (path in VALIDATION_REQUIRED_FILES or path.startswith((".github/scripts/", ".github/actions/ci-scope/")) or
            (path.startswith(".github/workflows/") and path.endswith((".yml", ".yaml"))))


def validation_inventory(ref):
    raw = git("ls-tree", "-r", "-z", ref)
    if not raw or not raw.endswith(b"\0"):
        raise ValueError("unreadable validator inventory")
    inventory = {}
    seen = set()
    for entry in raw[:-1].split(b"\0"):
        header, separator, encoded = entry.partition(b"\t")
        fields = header.decode().split()
        path = encoded.decode()
        if (not separator or len(fields) != 3 or fields[1] not in {"blob", "commit"} or
                not re.fullmatch(r"[0-9a-f]{40}", fields[2]) or path in seen or
                any(part in {"", ".", ".."} for part in path.split("/")) or
                any(ord(char) < 32 or ord(char) == 127 for char in path)):
            raise ValueError("unknown tree entry")
        seen.add(path)
        if validation_input(path):
            if fields[0] not in {"100644", "100755"} or fields[1] != "blob":
                raise ValueError("unknown validator mode/type")
            inventory[path] = (fields[0], fields[2])
    if not VALIDATION_REQUIRED_FILES <= inventory.keys():
        raise ValueError("missing validator input")
    return inventory


def validation_objects(objects):
    # Read the declared objects, not just their names; missing/corrupt bodies cannot justify a skip.
    data = subprocess.check_output(["git", "cat-file", "--batch"],
                                   input="".join(f"{oid}\n" for oid in objects).encode(),
                                   stderr=subprocess.PIPE)
    stream = io.BytesIO(data)
    contents = {}
    for oid, kind in objects.items():
        header = stream.readline().decode().split()
        if (len(header) != 3 or header[:2] != [oid, kind] or not header[2].isdigit() or
                int(header[2]) > 8 * 1024 * 1024):
            raise ValueError("unreadable declared object")
        content = stream.read(int(header[2]))
        if (len(content) != int(header[2]) or stream.read(1) != b"\n" or
                hashlib.sha1(f"{kind} {len(content)}\0".encode() + content).hexdigest() != oid):
            raise ValueError("invalid declared object body")
        contents[oid] = content
    if stream.read():
        raise ValueError("unexpected declared object bytes")
    return contents


def validation_needed(base=None, head=None):
    full = {"validation_required": True, "reason": "Validator inputs/context unavailable; running full validation"}
    if os.environ.get("GITHUB_EVENT_NAME") != "pull_request":
        return {**full, "reason": "Non-PR event retains full validation"}
    try:
        def unique(pairs):
            value = {}
            for key, item in pairs:
                if key in value:
                    raise ValueError("duplicate event key")
                value[key] = item
            return value

        event = json.loads(Path(os.environ["GITHUB_EVENT_PATH"]).read_text(), object_pairs_hook=unique)
        pr = event["pull_request"]
        left, right = pr["base"]["sha"], pr["head"]["sha"]
        if (not isinstance(left, str) or not isinstance(right, str) or
                not re.fullmatch(r"[0-9a-f]{40}", left) or not re.fullmatch(r"[0-9a-f]{40}", right) or
                (base is not None and base != left) or (head is not None and head != right)):
            return full
        base, head = left, right
        if any(key.startswith("GIT_") for key in os.environ):
            return full  # Environment overrides could redirect Git away from the checked-out action.
        partial = subprocess.run(["git", "config", "--local", "--get-regexp",
                                  r"^(extensions\.partialclone|remote\..*\.promisor)$"],
                                 capture_output=True, check=False)
        if partial.returncode != 1:
            return full  # Availability checks must not lazily fetch missing promised objects.
        workspace = Path(os.environ["GITHUB_WORKSPACE"]).resolve(strict=True)
        checkout = os.environ["GITHUB_SHA"]
        if (Path.cwd().resolve() != workspace or
                Path(__file__).resolve() != workspace / ".github/scripts/ci-scope.py" or
                Path(git("rev-parse", "--show-toplevel").decode().strip()).resolve() != workspace or
                not re.fullmatch(r"[0-9a-f]{40}", checkout) or
                git("rev-parse", "--is-shallow-repository").strip() != b"false" or
                git("rev-parse", "HEAD").decode().strip() != checkout):
            return full
        for ref in (base, head, checkout):
            if git("rev-parse", "--verify", f"{ref}^{{commit}}").decode().strip() != ref:
                return full
        checkout_parent = None
        if checkout != head:
            parents = git("rev-list", "--parents", "-n", "1", checkout).decode().split()
            if len(parents) != 3 or parents[0] != checkout or parents[2] != head:
                return full
            checkout_parent = parents[1]
            if git("rev-parse", "--verify", f"{checkout_parent}^{{commit}}").decode().strip() != checkout_parent:
                return full
            # The test merge can use a newer first parent than the event's base.
            # Accept it only when it descends from that exact event base; the tree
            # inventory below still has to match at both commits.
            git("merge-base", "--is-ancestor", base, checkout_parent)
        merge_base = git("merge-base", base, head).decode().strip()
        if not re.fullmatch(r"[0-9a-f]{40}", merge_base):
            return full
        raw = git("diff", "--no-ext-diff", "--no-renames", "--raw", "--no-abbrev", "-z",
                  merge_base, head, "--")
        if not raw or not raw.endswith(b"\0"):
            return full
        entries = raw[:-1].split(b"\0")
        if len(entries) % 2:
            return full
        changed = set()
        for index in range(0, len(entries), 2):
            header, path = entries[index].decode(), entries[index + 1].decode()
            match = re.fullmatch(r":(000000|100644|100755) (000000|100644|100755) "
                                 r"([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD])", header)
            if (not match or path in changed or any(part in {"", ".", ".."} for part in path.split("/")) or
                    any(ord(char) < 32 or ord(char) == 127 for char in path)):
                return full
            old_mode, new_mode, old, new, status = match.groups()
            zero = "0" * 40
            if ((status == "A" and (old_mode != "000000" or old != zero or new_mode == "000000" or new == zero)) or
                    (status == "D" and (new_mode != "000000" or new != zero or old_mode == "000000" or old == zero)) or
                    (status == "M" and (old_mode != new_mode or old_mode == "000000" or old == zero or new == zero))):
                return full
            changed.add(path)
        if any(validation_input(path) for path in changed):
            return {**full, "reason": "Validator policy/tests/execution inputs changed; running full validation"}
        inventory_refs = [base, head, merge_base, checkout]
        if checkout_parent is not None:
            inventory_refs.append(checkout_parent)
        inventories = [validation_inventory(ref) for ref in dict.fromkeys(inventory_refs)]
        inventory = inventories[0]
        if any(value != inventory for value in inventories[1:]):
            return full
        # A merge checkout or local edits must not silently execute a different validator/action.
        dirty = git("status", "--porcelain=v1", "-z", "--untracked-files=all")
        for item in dirty.split(b"\0"):
            if item and (len(item) < 4 or validation_input(item[3:].decode())):
                return full
        for options in (("--others", "--exclude-standard"), ("--others", "--ignored", "--exclude-standard")):
            untracked = git("ls-files", *options, "-z")
            if any(validation_input(path.decode()) for path in untracked.split(b"\0") if path):
                return full
        for extension in ("*.yml", "*.yaml"):
            for path in (workspace / ".github/workflows").glob(extension):
                if path.relative_to(workspace).as_posix() not in inventory:
                    return full
        # The corpus needs these published roots, their history/tree closure and exact original blobs.
        closure = git("rev-list", "--objects", "--no-object-names", "--missing=print", *VALIDATION_PUBLIC_ROOTS)
        if not closure or any(not re.fullmatch(rb"[0-9a-f]{40}", oid) for oid in closure.splitlines()):
            return full
        objects = dict.fromkeys(VALIDATION_PUBLIC_BLOBS, "blob")
        objects.update(dict.fromkeys(VALIDATION_PUBLIC_ROOTS, "commit"))
        objects.update({blob: "blob" for _, blob in inventory.values()})
        contents = validation_objects(objects)
        for path, (mode, blob) in inventory.items():
            source = workspace / path
            if source.is_symlink() or source.resolve(strict=True) != source:
                return full
            stat = source.stat()
            if not source.is_file() or ("100755" if stat.st_mode & 0o111 else "100644") != mode:
                return full
            content = source.read_bytes()
            if content != contents[blob] or "\0" in content.decode():
                return full
        return {"validation_required": False,
                "reason": "Readable PR and checkout; validator inputs and public reconstruction objects unchanged"}
    except (subprocess.CalledProcessError, OSError, ValueError, UnicodeError, KeyError, TypeError):
        return full


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base")
    parser.add_argument("--head")
    parser.add_argument("--validation-needed", action="store_true")
    args = parser.parse_args()
    if args.validation_needed:
        result = validation_needed(args.base, args.head)
    elif args.base is not None or args.head is not None:
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
            if args.validation_needed:
                stream.write(f"### CI validator scope\n\n{result['reason']}\n\n")
                return
            stream.write(f"### CI scope\n\n{result['reason']}\n\n")
            stream.write("| Gate | Selected |\n| --- | --- |\n")
            for key in (*GATES, "relay_soak"):
                stream.write(f"| {key} | {'Run' if result[key] else 'Scoped skip'} |\n")


if __name__ == "__main__":
    main()
