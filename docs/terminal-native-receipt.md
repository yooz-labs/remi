# Terminal native TLS receipt (#1646)

This fixes an accepted finding in ownership PR #1642 before adoption.
It adds no application wire shape, terminal handler, capability, PTY input or resize.
Signed service and encrypted relay/caller integration remain later gates.

The earlier native ownership qualification used plain WebSockets.
On the exact Bun 1.4.2 runtime, an actual 41,560-byte WSS projection was reported
accepted with zero plaintext buffering and released before its OS-stopped peer
resumed. The owned sender/receiver buffers were each 4,096 bytes; kernel output
was zero, leaving at least 37,464 plaintext bytes outside those kernel bounds.
The same Bun 1.3.11 control retained 41,564 pending bytes and kept ownership.
Both later delivered the full frame digest and reaped their zero-input PTYs.
The pinned Rust-to-uWS-to-TLS caller trace explains the distinction: the public
count excludes ciphertext spill. These are unadopted component controls, not a
claim about a shipped terminal data path.

`TerminalSendSlot` now requires trusted plain/TLS completion provenance from
the listener owner. Unknown provenance or missing TLS ping capability schedules
nothing. Plain WS retains its qualified completion behavior. TLS sends a fresh
random 16-byte native ping after the strict terminal frame in the same ordered
stream. A matching native pong and open/zero plaintext buffering release the
borrowed projection. A drain, timer, domain ACK, logical disconnect or foreign
pong cannot establish that proof. It confirms transport progress, not UI display.

The future synchronous original-grant guard encloses encoding and both native
writes. The extra 18-byte control frame is reserved inside the existing native
capacity; insufficient room refuses the unsent operation without truncation.
Close, entered ping failure and uncertain completion drop JS content and
quarantine fixed model/view charge without closing the approval socket.
Logical retirement cancels unsent work; a later genuine receipt can still
settle already entered ownership. It does not restart or replay an operation.

The new owned native proof exercises ordered, short/wrong/stale and reentrant
pongs; late receipt after retirement; entered ping error; actual close during
ping or while pending; missing capability and unknown completion mode.
Its sockets, private CA, independent stopped peer, native methods, packet
framing, ledger and launch-captured PTY are real. Fault controls wrap actual
native methods. Receipts contain only bounded metadata/digests, never screen text.

The memory gate remains 1,048,576 bytes. All original native-copy, parser,
ingress, fixture-pressure and envelope allowances remain. A further 198,666-byte
TLS working allowance was registered before measurement: 131,072 bytes for the
pinned doubling ciphertext batch capacity, 65,546 for spill and 2,048 for framing.
It applies conservatively to both pins. This finite retained-state control
is not an OS/RSS or allocator ceiling.

The final source cohort passes 148 tests and 994 parent assertions on each Mac
Bun pin. All five TypeScript configurations, lint (zero errors, 68 unchanged
warnings), spelling, whitespace, both pinned offline engine reproductions and
20-package bundle notices pass. All six compiled platform/runtime cells pass
17 plain ownership groups, both maximum-text profiles over plain WS and WSS,
four held-No scenarios for each transport, and nine TLS receipt scenarios.
The retained increment peaks at 942,111/1,048,576 bytes, including all
original allowances and the additional pre-registered TLS working allowance.
Normal No is 0.664–13.423 ms. With the unchanged 1,250 ms
injected busy loop, observed blocking No is 1248.189–1255.290 ms;
every control crosses the original 1,000 ms failure threshold.
All 46 named negatives discriminate: 24 original guard removals, six plain
one-byte writes, two overlapping handoffs, 12 TLS guard removals and two actual
TLS one-byte writes.

The held TLS lane uses eight real CA-verified TLS channels and two captures.
Seven fast clients share the process, matching the original plain fast-client
strategy; the slow receiver remains an independent OS-stopped process.
The earlier seven-independent-fast-process fixture hit Linux ARM posix_spawn
EAGAIN under the unchanged 128-task cap. Its instantaneous task count was not
captured. The correction keeps the same 512 MiB/128-task container and all
application limits; the entire final matrix ran fresh, with no profile reuse.
Read attempts remain two per second; borrowed-frame pressure can refuse optional
views. These measurements do not promise full-rate snapshots for every view.

Earlier grouped plaintext-positive pending observations were insufficient for
TLS. Final resource evidence checks actual retained frame/unconfirmed receipt,
open native socket, independently stopped peer and no decoded peer frame;
registered allowances cover native storage even when the public count is zero.
The initial grouped assertion failure did not identify its failing bit. The
separate native TLS counterexample establishes why plaintext zero cannot prove
disposal, not the exact cause of that earlier grouped failure.

The [compact qualification receipt](terminal-native-receipt-qualification.json)
records exact source/binary hashes, per-cell values and causal negatives.
The single fix-only R2 completed without Critical or Important findings. Parent
integration and final-head hosted gates remain required before adoption.
Raw evidence is retained under
`/Volumes/S1/yooz/remi/artifacts/terminal-native-receipt-20261023/`;
the original counterexample and pinned primary source hashes remain under
`/Volumes/S1/yooz/remi/artifacts/terminal-service-20261023/tls-native/` and
`tls-source/`. Private CA keys and PEM inputs are not committed.
No earlier failed gate is relabeled as a pass.
