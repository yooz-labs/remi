# R7 executable v1 retirement (#1202)

First pin: `b49c49d6` (`test: pin executable v1 retirement #1202`).
Removal checkpoint: `43c01edc7dab1da82225e7163d0ae3eb49bb140d`.

## Caller audit and scope

Before deletion, `rg` over production daemon/shared/web sources, scripts and tests
found no callers of `Authenticator.createChallengeWithRelayKex` or
`verifyRelayKex`. Only these dead methods used the public `kexSigningInput` helper.
Only CLI startup used `loadOrCreateAnswerKey`/`setAnswerEncryptionKey`; it generated
and announced an old key although no server path opened the sealed envelope.
The shared `generateAnswerKeyPair`, `sealAnswer`, `openSealedAnswer` and
`isSealedAnswer` exports had no production users after the separate web cleanup.

The three unused modules (`shared/relay-crypto.ts`, `shared/sealed-answer.ts`,
`daemon/auth/answer-key.ts`), their two exclusive shared test files, old methods,
exports and startup creation/announcement are removed. The historical v1 KEX
signing-byte comparator is now private to `relay/signing-inputs.test.ts`, with an
exact byte characterization captured against the original public helper first.
It retains the v2 domain-disjointness evidence without a public legacy export.

Optional auth relay fields, old answer-key fields in historical records, and
factory parameter positions remain solely for decode/additive compatibility.
Their round-trip and `PROTOCOL_VERSION = 1` are characterized. They implement no
relay transport. Relay v2 crypto executable code is unchanged; two stale header
comments were updated. Native answer-seal key managers and real direct signed
`/answer` remain separate. No owner historical `answer-key.json` was read,
modified or deleted; real owned CLI tests prove startup leaves artificial old
file bytes and mode unchanged and creates/announces no new old key.

## Measured gates

The first four-file pin run on **each** Bun version had **34 passed / 5 failed**
at runtime assertions: package exports, removed module presence, actual constructed
Authenticator methods, actual isolated CLI announcement/creation, and historical
key-file mode. The additive compatibility characterization passed on the original
code. The exact historical signing-byte characterization separately passed before
moving the comparator into the test file.

Focused gates on each Bun version: **705 passed, 3 explicit clock-probe skips,
0 failed, 10265 assertions across 45 files**. Bun 1.4.2: 87.10 s; Bun 1.3.11:
86.13 s. They include shared relay vectors/surface/domain tests, actual direct
Authenticator and WebSocket authentication, isolated CLI provisioning and signed
HTTP `/answer`, pairing, daemon R3/R6 remote/native-answer effect tests and all
`relay-r3*.test.ts`. Root/web/web-tests/signaling/R3 integration TypeScript gates
passed. Full Biome had 0 errors and the same 52 warnings; typos passed.
The restored five-file pin/CLI/surface/domain run then passed **44 tests /
495 assertions** on each version (1.4.2: 11.52 s; 1.3.11: 11.96 s).

Twenty-two causal mutation families failed runtime assertions on **both** Bun
versions (**44 detections**): each of five real legacy exports; each of three
actual old Authenticator methods; each of three removed modules; old startup
key generation; old announcement; historical file rewrite and mode change;
historical signing-byte drift; each of five retained optional factory fields;
and protocol-version bump. Real CLI mutations use only the existing isolated
home, restricted child environment and fail-if-launched model executables.
All nine mutation target states were SHA256/absence-checked restored against
`43c01edc` afterward.

Local receipts: `/private/tmp/remi-r7-v1-retirement-receipts/`, including
`pin-old-{142,1311}.log`, `focused-{142,1311}.log`, `restored-{142,1311}.log`,
`mutations.json` and each `mutant-*.log`. These are diagnostics, not required
checkout inputs. Full suites, replay/soak, fresh-clone integration, deployed
Worker, native devices and final R7 acceptance are separate coordinator gates;
this receipt does not claim them.
