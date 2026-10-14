# ADR 0045: Explicit direct file downloads

**Status:** accepted fields and limits; HTTPS/WSS required before direct release; runtime adoption pending
**Date:** 2026-10-14
**Owner:** Yahya

## Context

An attached client needs to save a project file mentioned by an agent.
The existing [file-tunnel plan](../../docs/FILE-TUNNEL.md#egress-lifecycle-and-credential-denial)
already requires one explicit relative file, descriptor confinement, a validated
private copy and inert client handling. Image staging and insertion have shipped;
neither supplies a file-download handler.

Reuse `FileAdmission`/`AdmittedFile`, the existing reservation ledger and
`beginJournal`/`JournalWriter`/`JournalRead`/`settleJournal`. The managed journal
already holds arbitrary nonempty bytes; its writer and closed reader own the
same private artifact. The separate private-copy publication prototype is not
selected: the managed path needs no additional hard-link factory or cleanup format.

The owner accepted the fields, limits, cleanup rules and `file_download` name on
2026-10-14, then explicitly retained the 10 MiB ceiling and required HTTPS/WSS
before the first direct link/download release. Full relay tunneling follows.
This document adds no models, registry entries, capability or runtime caller.
Browser-link fields are separately accepted in ADR 0044 (#1508).

## Decision

### 1. Explicit download and scope

A person requests one project-relative regular file in the attached live session.
The host prepares and validates a bounded private copy. The client receives that
copy, verifies its exact size and digest, displays the escaped basename and size,
and offers an explicit Save action through its platform's download/save UI.
It never previews, executes, opens or extracts the received content automatically.

The candidate additive capability is `file_download` under protocol version 1.
Advertise it only with accepted strict codecs/goldens, an authenticated handler
and one shipping client caller. Native implementation/conformance belongs to the
Xcode track and does not become available through this document.

Initial release requires an HTTPS/WSS direct connection with normal certificate
and hostname validation, the existing signed device authentication, and a known
live Claude or Codex binding. The daemon supplies an optional `[daemon.tls]`
HTTPS/WSS listener; the download handler and client remain separate integration.
Its signed `ws://` transport alone does not satisfy this prerequisite. Tailscale,
a VPN or an SSH tunnel does not waive the owner's HTTPS/WSS requirement for this
release. This amends ADR 0009 for the new link/download features; it does not claim
that unconfigured direct connections are encrypted by Remi.

Downloading does not type into either harness or call a model, and may proceed
while a permission is held if answer responsiveness passes. No automatic
plaintext fallback is permitted for this feature. Relay bytes follow direct
release and require separate actual encrypted hub/child/client acceptance.

### 2. Exact envelope and encodings

Every frame contains exactly `type`, `id`, `timestamp`, `sessionId` and the listed
additional fields. Responses also contain `requestId`, the initiating request's
`id`. No field in these shapes is optional.

| Field | Required shape |
|---|---|
| `id`, `requestId`, `beginId` | Lowercase canonical UUID v4. `beginId` names the original begin request on this connection/session. |
| `sessionId` | Lowercase canonical UUID of the actual attached live Remi session. |
| `timestamp`, `expiresAt` | Real UTC instant in exact 24-character `YYYY-MM-DDTHH:mm:ss.sssZ` spelling. Client time grants no authority. |
| `binding` | Exactly `{harness:"claude"\|"codex",harnessSessionId:<string>}`; nonempty scalar text, at most 200 UTF-8 bytes, no controls. Compare exact bytes to the current binding. |
| `relativePath` | Unicode scalar string, 1 through 4,096 UTF-8 bytes; slash-separated, at most 64 nonempty components, each at most 255 UTF-8 bytes. Apply the existing admission refusal policy without normalization or decoding that changes its spelling. |
| `fileName` | Exactly the admitted last path component; no directory or absolute host path. Treat it as display/save-name data, never a client filesystem path. |
| `transferId` | Host-generated 16 random bytes, canonical unpadded base64url (22 characters), collision-checked before publication. |
| `byteLength` | Integer 1 through 10,485,760. Empty files are explicitly unavailable in this first contract; current reservations require positive bytes. |
| `mediaType` | Exactly `application/octet-stream`; no content sniffing or inferred preview permission. |
| `digest` | SHA-256 of the validated private copy, canonical unpadded base64url (43 characters, 32 decoded bytes). |
| `seq` | Integer 0 through 319, exactly the next chunk index. |
| `receivedBytes` | Integer 0 through 10,485,760; exact cumulative count verified by transfer state. Zero is used only by the first read. |
| `data` | Canonical unpadded base64url, decoded size exactly `min(32768, remaining bytes)` and never zero. |

Limit raw frames to 65,536 UTF-8 bytes before JSON/base64 conversion. Reuse the
existing bounded strict JSON scanner; reject invalid UTF-8/scalars, duplicate
decoded members at every depth, unknown fields, wrong types, noninteger/out-of-range
numbers and noncanonical encodings. No coercion. Shape checks do not grant access.

### 3. Messages, pull flow and cancellation

The table lists all additional fields. A read request acknowledges the previous
chunk and pulls one next chunk, keeping one correlated response in flight. This
replaces the older unaccepted `file_fetch_chunk/ack` placeholder with an explicit
request/response operation; no unsolicited content or separate transport ack is
treated as completed client receipt.

| Direction and type | Additional fields | Meaning |
|---|---|---|
| Client `file_fetch_begin` | `binding`, `relativePath` | Begin a new explicit read. Capture authority, reserve capacity and prepare/validate the private copy before acceptance. |
| Host `file_fetch_accepted` | `transferId`, `fileName`, `byteLength`, `mediaType`, `digest`, `expiresAt` | The complete private copy passed validation; no content has been sent. Correlate `requestId` to the begin ID. |
| Client `file_fetch_read` | `transferId`, `seq`, `receivedBytes` | First read is `seq:0,receivedBytes:0`. Each later read acknowledges every byte of the preceding chunk and requests the exact next chunk. |
| Host `file_fetch_chunk` | `transferId`, `seq`, `data` | One bounded read of the already validated private copy. Never reopen/read the project path to answer it. |
| Client `file_fetch_complete` | `transferId`, `receivedBytes`, `digest` | Acknowledge the final chunk and claim local exact-length/digest verification. Requires all chunks sent and the accepted total/digest. |
| Host `file_fetch_result` | `transferId`, `outcome:"complete"` | The owner's host copy was closed, confirmed deleted and settled. This does not prove an OS Save action or durable client storage. |
| Client `file_fetch_cancel` | `beginId` | Cancel the owned operation even during preparation, before a transfer ID exists. |
| Host `file_fetch_cancel_result` | `beginId`, `outcome:"cancelled"` | No future content will be queued and the owned copy was confirmed cleaned/settled. Already sent bytes cannot be retracted. |
| Host `file_fetch_refused` | `operation`, `code` | Correlated short refusal; `operation` is one of the four client types above. No path, transfer ID, filename, diagnostics or existence detail. |

Refusal codes are exactly `malformed`, `unavailable`, `busy`, `conflict`, `sequence`,
`integrity`, `empty_file`, `expired`, `binding_changed`, and `cleanup_failed`.
Unknown paths/IDs, denied names, another owner, lost authority and unreadable
authority state use `unavailable`. More specific lifecycle codes require the
currently authorized owning operation. Uncorrelatable malformed envelopes end
the transfer connection without a reply.

Only the next read with its exact cumulative count may advance a transfer.
A duplicate, stale or gapped read terminates that owned transfer with `sequence`;
no chunk response is replayed. Completion mismatch terminates it with `integrity`.
A client never retransmits begin/read/complete/cancel automatically. Disconnect,
lost responses or reattachment require a new explicit Download with a fresh ID
and a new copy; no resume or replay onto another connection.

A repeated begin ID while its operation is active returns `conflict` without
another reservation/copy. Terminal begin IDs are not an unbounded retry ledger:
a later begin can create a fresh current copy. The operation offers no general
at-most-once begin guarantee. Retired host transfer IDs cannot revive a copy.

Accept/read/complete/cancel and their sends use one serialized operation state.
Cancellation during preparation marks it terminal before the next bounded effect,
suppresses later acceptance/chunks and settles only its own journal. A client
ignores late responses for its cancelled begin/transfer. An unknown/retired cancel
returns `unavailable`; confirmed cancellation is never guessed after cleanup failure.

### 4. Admission, ownership and lifetime

Capture device key, authorization grant incarnation, original connection and
attachment, session, child runtime, known binding and trusted project root.
Recheck that exact context before each open/read/write/response effect, including
between yielded copy chunks and at the actual serialized send. Revoke/regrant,
binding/runtime change, disconnect or reattachment retires the operation.
Capabilities/local loopback alone do not authorize this file service.

Reuse the existing component policy: refuse dot-prefixed components, `.`/`..`,
empty components, controls/bidirectional text, backslashes, drive/UNC/colon syntax,
`node_modules`, credential names and `.key/.pem/.p12/.pfx/.keystore` files.
Apply the captured Remi/Claude/Codex/configured protected roots, including root
overlap and replacement. Refuse symlinks at every component, hard links,
directories, devices, sockets and FIFOs; no listing, glob or recursive fetch.
There is no general secret detector: ordinary allowed files can contain secrets.
Beyond that existing denial policy, regular files of any content type are inert
downloads; image decoding is not required or selected by the filename.

Read at most the admitted length plus one byte from the same source descriptor.
Reuse its before/after metadata and current-name checks, then validate the closed
private copy's exact length and actual digest before any content frame. Stream
only its managed descriptor. This describes the validated copy, not an atomic
snapshot or proof that every concurrent source edit was detected.

Use existing combined image/download budgets: at most two active operations per
device, four per session, eight per hub, 100 MiB reserved per Remi home, 128 artifacts
per home and 32 per device, with at least 4 KiB charged per artifact and actual
allocation when greater. Reserve before creation; counts span connections and
child processes. Cleanup debt remains charged.

Total lifetime is five monotonic minutes from begin admission, including private
copy preparation. The accepted `expiresAt` reflects that original deadline;
there is no new deadline at acceptance/retry. After acceptance, 30 seconds without
valid progress retires the copy; only advancing read or valid completion counts.
Each source/private read or write is bounded to 32 KiB with an event-loop yield
between copy chunks. Preserve the existing 1,000 ms held-answer gate.

Success, cancellation, expiry, authority loss and session/process exit retire the
host copy through existing journal settlement/recovery. No 24-hour download
retention or image artifact is created. Failed cleanup retains its reservation;
uncertain write/close poisoning keeps its existing process-death ownership rule.
No sensitive content, relative/absolute paths, filenames or digest enters logs.

The client discards unverified partials on cancellation, failure or disconnection.
Locally verified bytes may still be saved if host settlement fails; a host
cleanup result is not a client-integrity or Save receipt. An explicit client
cancel discards its bytes too. The final OS-chosen file then belongs to the user,
outside host transfer retention. No preview, HTML/SVG render or archive extraction.

## Verification and implementation order

Owner review accepted the fields, pull/cancel semantics, arbitrary inert regular-file
policy, nonempty first version, 10 MiB limit and `file_download` name. The later
HTTPS/WSS-first decision is a release prerequisite. Use one implementation lead
and one independent reviewer per bounded PR:

0. Implement and verify direct HTTPS/WSS, preserving device authentication,
   local CLI and hub/child operation, endpoint discovery and certificate validation.
   Native URL construction/conformance remains with the Xcode track. Gate actual
   download availability on the completed secure transport and its shipping client.

1. Characterize/extract one admitted-read validation core from the existing
   private-copy proof; reuse it with the managed writer, without a second copy
   loop, publication factory or recovery format. Bind native callbacks to their
   receiver. Preserve the original proof/removed-guard controls before refactoring.
2. Prove managed copy/recovery/cancellation, quota debt, mutation/replacement,
   exact completed size/digest and held-answer responsiveness on the three
   supported compiled targets and both recorded Bun gates. Measure before adding
   a disposable worker; none is selected by this proposal.
3. Add strict TypeScript codec/goldens and registry/direction handling only after
   the accepted contract. Add malformed/boundary/duplicate/sequence/cancellation vectors.
4. Add authenticated direct dispatch and one explicit web Save caller, with real
   generated files through the shipping daemon/client endpoint. Exercise both
   known harness bindings without consuming model quota, current/revoked grants,
   disconnect, source races, slow consumers and a held answer.
5. Render web progress/cancel/error/Save on phone/tablet/desktop. Native runs the
   same goldens plus its Save/share/device acceptance. Relay gets its own actual
   ciphertext-only Worker/hub/child/client controls after the direct release.

No protocol, download availability or native completion is established by review
of this document. Empty-file support is deferred explicitly; changing the shared
reservation invariant needs its own reviewed implementation and controls.

## Alternatives considered

- **Reuse image upload frames backwards:** their write acknowledgments and image
  decode/staging lifetime do not describe a read-only download.
- **Host pushes content immediately:** a pull response provides explicit bounded
  backpressure and correlation with one chunk in flight.
- **Add another private publication helper:** the existing managed journal owns
  generic bytes and already supplies recovery/read/settlement.
- **Stream the project file directly:** the existing plan requires validating the
  complete private copy before disclosing content.

## Receipts

Original proposal source at develop `a3eda3a9`: `tunnel/admission.ts` supplies descriptor admission;
`tunnel/journal-settlement.ts` bounds reads and owns the journal lifecycle;
`tunnel/reservations.ts` requires positive byte admission. There is no production
`FileAdmission` constructor or file-fetch handler/caller at that source.

Existing 43-group private-copy/reservation controls passed six compiled cells;
the later default managed-journal characterization passed arbitrary nonempty
bytes and settlement on both recorded Mac Bun gates, while preserving its
original zero-byte refusal. These are prerequisite observations, not download
acceptance. Exact manifests/receipts remain under
`/Volumes/S1/yooz/remi/artifacts/2026-10-14-private-copy-baseline/` and
`/Volumes/S1/yooz/remi/artifacts/2026-10-14-journal-reuse/`.
