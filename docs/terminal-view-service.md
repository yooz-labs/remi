# Signed direct terminal view service (#1643)

This branch implements the existing strict terminal open/read/close contract on
signed public WSS. The CLI composes the handler, but does not advertise
`terminal_view`. Encrypted relay adoption and a real shipping caller remain B4;
the existing native pane source stays available for that integration.
Input stays in chat and approval controls. This service has no terminal input,
resize, attachment, provider or account operation.

Admission captures the current original device key/grant epoch, exact Connection,
attachment token, ManagedSession, PTY, harness runtime, capture context and
Claude/Codex binding. Plain WS, local capability and proxy identity do not qualify.
The nonblocking original-grant lock encloses the final checks, borrow, strict
encoding and both ordered native writes: terminal frame, then receipt ping.
No await, retry or alternate authority occurs after effect entry.

Every response, including opened/unchanged/closed/refused, borrows the same real
model/view capacity. There is one record per reserved connection view; the shared
1/2/4/8 quotas remain. No phantom model, uncounted control-response pool or
parallel reply queue exists. If eligible capture/view/native capacity or current
authority is unavailable, optional silence leaves the caller's bounded timeout
to report it. The shared chat/approval connection stays available.

One new explicit Open creates a collision-checked 16-byte opaque ID and five
monotonic minutes. Wall time formats expiresAt. Reads are spaced by 500 monotonic
ms and use current complete snapshots/revisions. No output history is retained.
A short closed/expired/refused receipt consumes its existing view for one logical
second. Logical expiry does not pretend that pending native bytes were disposed;
uncertain ownership can keep fixed charge after the receipt becomes inaccessible.

TLS ownership follows #1646: only an actual matching pong for a fresh native ping
ordered after the frame, plus open/zero plaintext buffering, can release it.
Socket-owned data routes native drain/pong/close even after the active Connection
map removes its entry. Domain ACK/pong, timers, logical disconnect and
foreign/stale/reentrant pongs establish no disposal or domain authority.
Close or uncertain native entry quarantines fixed charge without closing the
approval connection or replaying an operation.

A client can receive a response before its native receipt reaches the host.
Retain at most one first-time strict same-view read/close metadata intent while
that preceding frame is pending. It contains no screen, encoded response or raw
body. Clear it before its first schedule and on retirement; the scheduled effect
rechecks all original authority, lease and rate conditions. Additional pressure
is omitted. This is not a retry of an entered effect.

Original UTF8/JSON units reach strict ingress before generic ACK/deduplication.
The raw byte limit precedes decoding; malformed correlation retains only bounded
IDs/operation. No terminal text, body, file path, key or account detail enters
logs, replay, push or scratch files. Current grant/binding/runtime/attachment or
capture loss retires the old view. No old incarnation follows a new grant.

## Source qualification and remaining gates

The [source receipt](terminal-view-service-source-qualification.json) records
256 passing cases on each Mac Bun pin (3,181/3,179 parent assertions), five
TypeScript configurations, lint (zero errors/68 unchanged warnings), exact
CItypos1.28.4, whitespace and bundle notices. Real private-CA signed WSS, identities,
registry/binding, launch-captured zero-input PTYs and actual native packets cover
both harness bindings, native/domain pong separation, native close after logical
removal, one held intent and original grant/binding/runtime/attachment retirement.
Both independent source lease controls ran five actual monotonic minutes, then
refused the old ID and admitted a new explicit Open without clock injection.

A test initially assumed service-map removal synchronously removed its ledger
row. An actual unchanged cleanup probe observed a safe, settled, unborrowed row
queued for filesystem cleanup, then its later removal. The corrected assertion
waits for both map and physical ledger under its original deadline. Production
cleanup cadence and ownership guards stay unchanged.

An earlier runner made the existing browser producer's UNIX-socket path114bytes,
which correctly failed its104byte guard. Actual A/B/A controls preserve the
long-root failure, valid-short-root pass and restored-long-root failure. The full
source suite now uses a private short canonical TMPDIR and fresh private HOME.
The earlier Mac wrapper cleanup/reset failures remain preserved; their cause is
not claimed fixed. No source gate is waived by the older B1-only exception.

These are source and lease controls. Expanded service/controller/native-pending/
full-parser memory, actual held-No load, all six compiled host/Bun cells, the
single full C2 review and final-head hosted/actual-soak gates remain before
adoption. All existing model/frame/queue/view/latency/container bounds and native/
TLS allowances remain unchanged. Finite retained state is not an OS/RSS ceiling.
Native rendering, signed hardware, deployed Worker and provider acceptance remain
separate. #1595 stays open.
