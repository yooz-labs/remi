# Terminal view and native-send ownership (#1625)

This internal phase extends launch capture with context-owned view handles and a bounded native sender. It adds no production terminal request handler or capability. A handle accounts for resources; signed device/session authority still belongs to the next service phase. The agent PTY remains read-only to this component.

`TerminalCaptureHost` uses its model's exact ledger owner to reserve views. The existing shared ledger enforces one connection, two device, four session and eight home views across processes. All views share one borrowed complete frame per model. Retirement removes availability immediately and keeps accounting until parser and borrowed resources are disposed. Cleanup remains nonblocking and bounded to one metadata transaction per scheduled tick; failed or uncertain cleanup stays charged.

`TerminalSendSlot` reserves one content-free scheduled operation and constructs/sends in a later timer turn outside Bun's automatic message cork. The future service's synchronous original-grant guard must enclose its final context check, borrow, strict encoding and native call. This phase supplies no authority guard or shipping caller. A live native transport must have zero preexisting buffered bytes before encoding. One actually pending projection retains the borrowed model/view slot until a real drain callback confirms zero bytes on an open transport. No second frame or retry is queued.

Ordinary native close is not disposal proof: source controls observed zero buffered bytes and a synchronous close callback, followed by delivery of all queued frames when the peer resumed. Unknown entered-call completion and native close therefore drop the sender's JS references and quarantine fixed model/view charges. They do not close the original shared chat/approval connection. Capture may become unavailable for that process; charged rows remain until process death or independently proved disposal. The old native observations are under the capture evidence directory, not a claim of a previously shipped terminal leak.

## Acceptance boundaries

The seventeen ownership groups construct actual PTYs, filesystem ledgers and native Bun WebSockets. A separate raw TCP peer is stopped with the OS signal and its stopped state is verified. Guard probes wrap actual native methods to introduce errors/reentrant events after real sends; they do not substitute a transport. All owned processes are joined. Terminal contents are never written to proof receipts; the independent peer retains only a bounded digest list. Fixture commands and input-byte receipts live in private owned roots.

The retained-memory gate measures added prepare/start/model state around an actual existing PTY object and initially empty capture host, with four view handles, a fresh sender, the borrowed maximum screen/strict JSON, an actual native-pending frame, the full 64 KiB/eight-operation parser queue, and explicit native-copy, fixture-pressure, envelope and ingress-handoff allowances. Both Latin-1 capacity and UTF-16/escaped maximum-text profiles are required. The preexisting PTY object, initially empty process-level capture host, remote receiver and fixed test network setup precede the baseline; the measured delta includes new model, view and sender state. Existing agent state and OS/kernel buffers are not a screen-model memory claim. An isolated touched 8 MiB backing-store control checks that JSC's heap counter includes external storage. Warmup/baseline variation is retained in receipts; finite retained deltas establish no universal allocator or process/RSS ceiling.

The held-No gate uses the real HookServer, held gate, session registry and input handler, with a separate answer process. It holds eight real views across two actual captured PTYs, attempts at most two reads/sec/view, retains one truly native-pending frame, and keeps accepted maximum-sized PTY bursts progressing. Normal No must complete below 1,000 ms; a deliberately blocked 1,250 ms turn must fail that same limit. It proves optional terminal work does not type into those PTYs, not signed terminal-service, client UI or provider acceptance.

## Preserved fixture failures

- A same-process paused receiver inflated the measured daemon heap and had already lost pending native pressure. The independent receiver and actual stopped-state/buffer checks correct the measurement boundary. No product budget changed.
- Exact net-delta calibration was invalid when GC freed unrelated warm state. The isolated backing-store control verifies absolute external inclusion against its small baseline instead. Both failed calibration receipts remain preserved.
- An early preflight-pressure test filled a real socket before async dispatch; its buffer had drained by preflight. Establishing actual pressure immediately before the unchanged preflight guard removes that fixture timing error.
- The first held producer issued another burst before the previous maximum burst parsed. The retirement trace recorded 64,515 queued bytes plus 3 ingress bytes, then the next input exceeded the unchanged 64 KiB bound. The accepted-load probe now waits for parser completion between maximum-sized bursts; a separately registered resource probe fills the entire queue. No threshold, assertion or overload behavior changed.

## Engine storage and reproducibility

The original published 6.0.0 engine failed the expanded ownership memory gate
on Linux x64 Bun 1.3.11: 1,096,189 bytes against the unchanged 1,048,576 limit.
The original frozen graph, accepted earlier cells and failure remain under
`qualification-platform-peers-original-inputs/` and its corresponding receipt.
Removing round-trip validation, changing row formatting, trimming pending JS
content, selecting an older dependency or changing the bundle entry did not
qualify both required text profiles; those diagnostic results remain preserved.
No native-copy allowance or product limit was reduced to obtain a pass.

The selected derivative keeps exact upstream 6.0.0 sources and changes only
`BufferLine` storage: content remains dense, while foreground/background planes
allocate on first nonzero use. Attributes remain available to the actual engine.
The admitted monochrome wrapper strips styles as before, so its 120 maximum
normal/alternate rows use 115,200 backing-store bytes instead of 345,600.
This is a concrete 230,400-byte storage reduction; full retained-state gates
also include objects, parser work, views, encoding and native pending state.

The original published JavaScript and source maps remain byte-identical in the
dependency as independent controls. The production package entry now selects a
derived bundle; this is a runtime modification, not a license-only patch.
The readable source patch, pinned source manifest and offline generator live
in `scripts/terminal-engine/`. Hash checks cover upstream sources, three omitted
upstream const-enum/type modules, the patch, patched source and generated files.
Locked esbuild 0.27.0 emits the bundle with MIT notices and canonical source maps.
`bun run verify:terminal-engine` reproduces the installed distribution without
network access. The Bun dependency patch contains those generated files.

Characterization commit `13609388` pins all 49 upstream BufferLine cases against
the original class before runtime modification. They also run against the
patched real class. The installed and original published engines are compared
after actual ANSI writes and resizes, including colors, protected and extended
attributes, wide/combined cells, alternate screens and scrolling. These tests
are separate from the actual wrapper, PTY and compiled ownership proofs.

## Qualification receipts

All 94 focused source tests (758 parent assertions) pass on both Mac Bun pins,
including the separate original/patched upstream classes and installed-engine
controls. All five TypeScript configurations, root lint (zero errors and 68
unchanged warnings), spelling, diff and offline reproduction checks pass.

All six compiled host/runtime cells pass the seventeen actual ownership
groups, both maximum-text resource profiles and four held-No scenarios.
Maximum retained increment is 807,477 of 1,048,576 bytes.
Normal No is 0.714–22.369 ms; deliberately blocking controls
are 1250.625–1253.123 ms. Every actual child input count is zero.
All 32 negative controls fail their named causal assertion: 24 guard removals,
six actual one-byte writes and two overlapping parser/native handoffs.
No budget, frame/queue bound, native-copy allowance or latency threshold changed.

The first driver stopped after three accepted cells because copied proof and
entrypoint basenames collided, producing a self-import before any negative
control ran. The corrected driver gives them distinct names. It verified every
unchanged frozen product input and accepted binary before reusing those three
cells; it then ran the remaining cells and all negative controls. The original
failure remains `qualification-lazy-attributes-result.json`; the corrected
complete result is `qualification-lazy-attributes-pathfix-result.json`.
`ownership-final-validation-result.json` links source and compiled receipts.
These and the original diagnostic graphs are retained under
`/Volumes/S1/yooz/remi/artifacts/terminal-send-20261023/`.
Fresh hosted gates and the required review remain merge requirements.

The original approved limits remain: 1 MiB/model, 32 models/32 MiB per home,
240×60, 32 KiB text, 64 KiB frame/queue and eight parser operations.
Five-minute monotonic leases, read-rate enforcement, signed original authority
and encrypted relay/caller integration remain service/caller work.
#1595 stays open.
