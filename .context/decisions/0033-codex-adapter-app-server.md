# ADR 0033: Codex adapter through the app-server, with a hand-rolled unix-socket WebSocket client

**Status:** proposed (Phase 1 of epic #1175, issue #1181; accepted when the epic merges and live step LV-1 has passed)
**Date:** 2026-10-03
**Owner:** Yahya

## Context

Epic #1175 makes `remi codex` a first-class harness: a Codex approval reaches the phone, the phone's answer runs the command, and the Codex TUI overlay closes.
It must happen through Codex's own app-server, never typed keys and never a remi-side permission judgment (ADR 0030).
The harness seam it plugs into is ADR 0032; the plan of record is `.context/codex-epic-plan-2026-10.md`; the spike that gates it passed in #1160.

Two things decide this phase.

1. **Codex already shares its approvals.**
   The spike ran several clients against one Codex daemon over its control socket.
   Every subscriber of a thread receives the same server request with the same id, the first answer wins, every subscriber is told it resolved, and a late answer is ignored without an error frame.
   The evidence is under "Receipts" below.
   A second client can therefore answer an approval without touching the TUI.
2. **The transport is a WebSocket over a unix socket, and Bun 1.3.11 cannot speak it natively.**
   CI and the release build pin Bun 1.3.11, in five workflow files (`ci.yml:15`, `release.yml:16`, `auto-bump-dev.yml:22`, `close-on-develop.yml:37`, `macos-app.yml:27`); the comment above the CI pin explains that 1.3.12 ships broken compiled binaries.
   Bun's WebSocket client gained `ws+unix://` in oven-sh/bun PR #29203, merged 2026-04-12 (title "WebSocket client: support ws+unix:// and wss+unix://").
   Bun 1.3.12 was published 2026-04-10 and 1.3.13 on 2026-04-20, so 1.3.13 is the first release that has it.
   On the local Bun 1.4.2, `new WebSocket("ws+unix://<socket path>")` reached a `Bun.serve({ unix })` echo server and returned the echo; the options form `new WebSocket("ws://localhost/", { unix: path })` fails.
   The repository's installed `bun-types` is 1.3.5 and has no `unix` option on the WebSocket client either.
   The `ws` npm package is no way around it either, by reviewer B's measurement (reported, not repeated here): under Bun it resolves to Bun's own native client, so the 1.3.11 error `Wrong url scheme for WebSocket ws+unix` is Bun's, `ws+unix` works only on 1.4.2, and the `createConnection` and `socketPath` options fail on both versions.

## Decision

Phase 1 adds the transport and the client, and changes no daemon behavior.

1. **Hand-roll the client over `node:net`.**
   `harness/codex/ws-frames.ts` (RFC 6455 client codec), `unix-ws.ts` (connect, upgrade, ping/pong, reassembly, close), `app-server-protocol.ts` (`classifyInbound`) and `app-server-client.ts` (handshake, correlation, reconnect).
   No `ws` package, and no native `ws+unix` until CI and release pin Bun 1.3.13 or later and the compiled-binary smoke test passes with it.
   At that point `unix-ws.ts` and `ws-frames.ts` are deleted and `AppServerClient` takes the native client behind the same `connect` option.
2. **Wire policy.**
   No extension is offered and none is accepted, no `Origin` is sent, `Host: localhost`, path `/`.
   Text frames only: a binary message is dropped with a log.
   A payload over 32 MiB, in one frame or reassembled, an RSV bit, a masked server frame, an unknown opcode, a fragmented or oversized control frame, or a continuation error closes the connection with 1002; invalid UTF-8 closes with 1007.
   An oversize frame and an over-limit reassembly close with 1002 by decided policy, although RFC 6455 section 7.4.1 would say 1009 (message too big); the decision was to have one code for every framing violation.
   A close frame must have no payload or a 2-byte code with an optional UTF-8 reason: a 1-byte payload and any code outside 1000 to 1003, 1007 to 1014 and 3000 to 4999 close with 1002, a reason that is not UTF-8 closes with 1007, the echo carries the original reason bytes, and `close(code)` refuses 1005, 1006, 1015 and the unassigned codes.
   The request path and host are validated before any connect (they go into the request line and the `Host` header), a socket path must be a non-empty absolute string, only `HTTP/1.1 101` is an upgrade, the response header block is capped at 16 KiB however it arrives, and a leading byte order mark stays in a text message.
   A frame that does not parse as JSON, or is not a JSON-RPC shape, is dropped and logged by length only; peer-controlled text that reaches a log (a close reason, an initialize error, a refused status line) is quoted with JSON escapes and cut.
   After the first violation nothing the peer sends is read, parsed or logged.
   The read loop never throws, and the peer closing or ending its socket is reported as a close whichever of 'end' or 'close' arrives first.
3. **Handshake and ids.**
   `initialize` carries `clientInfo.name = "remi"` (plan risk R8: the daemon's originator may follow whoever initializes first), `capabilities {experimentalApi: true, requestAttestation: false}` and no opt-out list until LV-1 shows Codex accepts one; then `initialized`.
   Request ids are numeric from 1, with timeouts of 5 s for `initialize` and 15 s otherwise.
   `ready` is emitted after `initialized` is sent and before any later frame is dispatched, so frames that arrive earlier are queued behind it (at most 256 frames or 4 MiB; beyond that the session fails).
   Only a response received after `initialize` was sent can be its reply, so a forged reply delivered in the same chunk as the `101` is held back and later ignored.
4. **The client answers only with a result.**
   `AppServerClient` has no way to send an error response; it exposes `respond(id, result)` only.
   An unknown server request (`item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`, anything else) is delivered to the caller and nothing is sent back.
   The reason is the arbitration above: the first answer wins, and what a JSON-RPC error from a second client does to a pending request is unverified (plan risk R5 covers only `cancel`), so remi never sends one.
5. **Liveness and reconnect.**
   A WebSocket ping every 30 s with a 10 s pong deadline; a missed pong ends the session like a drop.
   It is the backstop for Bun 1.3.11 leaving a connection looking open after the peer is gone.
   Backoff 250 ms doubling to 5 s, forever, until `stop()`; the socket path is resolved on every attempt; the first failure is logged and then every tenth; a drop rejects every in-flight request and reports `disconnected`.
   A connection resets the delay and the failure count only after it stayed up for 5 s, so a server that is ready and then closes cannot hold the delay at its minimum.
   `stop()` aborts an attempt still waiting for the upgrade (an `AbortSignal` replaces the old connect timeout, which no test could reach) and wakes the backoff wait.
   `request()` rejects params that cannot be serialized with `AppServerSerializationError` before using an id, and `respond()` throws it for such a result, so a caller's bug is distinguishable from a down link (`false`).
6. **Never log a body.**
   The client logs method names, truncated ids and lengths, never params or results (plan section 5: frames can carry other threads' metadata).
   A test sends a marker through every drop path and asserts it never appears in a log line.
7. **Fixtures are redacted structurally, and free text fails closed.**
   `scripts/extract-codex-fixtures.ts` reads the spike's raw logs (a directory given as an argument or `CODEX_SPIKE_DIR`; never copied into the repository), keeps frames on a method allowlist, and rewrites paths, ids, the model and the user agent to placeholders.
   It runs the same `scanForLeaks` as the test suite and writes nothing when it finds a leak.
   The scan decides per field, from the parsed frame: single-valued fields hold one value, place fields are null or `/work` paths without `..`, ids are placeholders, timestamps sit at a fictional epoch, and every other string is a plain token.
   Prose and commands (message text, previews, titles, commands, question and option text) must be in the reviewed `approved-free-text.json`, so extracting a real session cannot carry anything personal through; the extractor refuses, and echoes the refused text only under `--show-unapproved`.
   A pattern list then covers every string and key (home paths, URLs, percent-encoding, Windows and UNC paths, long hex, base64, cloud tokens, IPs, MAC addresses, phone numbers, remote URLs, model names, rate-limit fields, OS and CPU strings).
   The machine's user, home and host name come from the process and generic ones (`unknown` under `env -i`) are skipped.
   `tests/fixtures/codex-app-server/index.json` records each source file, its sha256 and the extractor version, and labels two files as not captured: `report-derived.jsonl` (the `-32600 no rollout found` error, from the spike report) and `synthetic-from-schema.jsonl` (file-change, permissions and elicitation server requests, built from the generated TypeScript schema).
8. **Boundary, as allowlists.**
   `harness-boundary.test.ts` gains two: only `harness/codex/` and `cli.ts` may import `harness/codex/` (checked over every file under `src`), and a file under `harness/codex/` may import only its own files, `node:*`, `@remi/shared` and the named entries of `CODEX_MAY_IMPORT` (the harness contract, `cli/session-phases/pty-session-setup` and nothing else under `cli/session-phases/`, and the session stores), each with the phase that needs it.
   That Codex never reaches a Claude module is a consequence of the list.

## Consequences

- A phone, a lock screen or Telegram can answer a Codex approval in a later phase with no typed bytes, and a late subscriber is replayed a pending request (receipts).
  Whether a reconnect is safe depends on plan risk R1, what happens to a pending request when its subscriber disconnects, which live step LV-3(d) checks; the spike's replay happened while another subscriber stayed attached.
- remi carries its own WebSocket client until the pin moves (about 400 lines of code in `ws-frames.ts` and `unix-ws.ts`, comments and blank lines excluded), and the first proof that it interoperates with Codex's server is the live step LV-1 (plan risk R3).
  Until LV-1 passes, what is verified is the client against a real `Bun.serve` WebSocket server and a byte-level peer, not against Codex.
- **Every export has no production caller in this PR, and that is intended.**
  `connectUnixWebSocket`, `classifyInbound`, `AppServerClient` and its error classes, `WsFrameParser`, `encodeClientFrame` and `computeAcceptKey` are consumed by Phase 3 (`remi codex` launch, #1177 and onward); `cli.ts` is out of scope here, as it was for `getIdentity` in ADR 0032.
  `ws-frames.ts` and `unix-ws.ts` are reached today only through `AppServerClient`, which only tests construct.
  Delete any of them that Phase 3 does not use.
- **Phase 3 cannot use `fs.realpathSync` on the socket.**
  On Bun 1.4.2 on macOS, `realpathSync`, `realpathSync.native` and `fs.promises.realpath` throw `EOPNOTSUPP` on a unix socket file and on a symlink to one, while `readlinkSync` and `lstatSync` work.
  The plan says to "connect to the realpath"; it records, from the spike, that Codex's control socket under `~/.codex` is a symlink to a short path, and macOS `sun_path` is 104 bytes.
  The tests therefore resolve the symlink with `readlinkSync`.
  Phase 3 must do the same (or `realpath` the parent directory and `readlink` the file).
  Checked on both Bun 1.3.11 and 1.4.2: identical.
  The plan carries the same correction inline.
- **The tests found a test-runner hazard.**
  `expect(promise).rejects` blocks the whole `bun test` process at 100 percent CPU when a broken implementation leaves the promise pending.
  The new tests use `rejection()` from `tests/helpers/fake-app-server.ts`, which fails after 3 s instead.
- The fake app-server models only what a spike frame backs (see Receipts).
  Its fidelity to Codex is what the live steps check, so a passing test here is a claim about remi's client, not about Codex.

## Alternatives considered

- **The `ws` package.**
  Rejected: by reviewer B's measurement it resolves to Bun's native client under Bun (so it cannot reach a unix socket on 1.3.11), and it would be a new runtime dependency in a package that ships as a compiled binary.
- **Native `ws+unix://` now, by raising the pin.**
  Rejected for this phase: CI and release share one pin on purpose, because 1.3.12 shipped broken `bun build --compile` binaries (the comment at `ci.yml:9`).
  Moving the pin needs a compiled-binary smoke test, which is its own change; the client sits behind a `connect` option so the swap is small.
- **Drive Codex through the TUI (type the answer).**
  Rejected by the epic: the spike agent reported, and the lead confirmed (the installed Codex moved from 0.159.1 to 0.160.0 and the release symlink was repointed during the spike run), that a digit typed into the TUI while an "Update available" modal had focus ran Codex's installer.
  ADR 0031 also keeps remi from typing an answer into a prompt it can answer through a hook.
- **Spawn a private `codex app-server` per session.**
  Rejected by the plan (section 1), not tried: the approval to answer belongs to a thread on the shared daemon, which a private app-server does not hold.
- **Answer unknown server requests with a JSON-RPC error so Codex does not wait.**
  Rejected (decision 4): the first answer wins, and the effect of an error answer on a pending request is unverified.

## Receipts

- Epic #1175, this phase #1181, plan `.context/codex-epic-plan-2026-10.md` sections 0 to 3 and 5 to 6; spike #1160.
- **Where the frames are.**
  The raw spike logs are not in the repository (they hold local paths, thread ids and account metadata).
  The redacted fixtures keep each frame's source line in a `line` field; citations below are `<file>:<source line>`, found in `packages/daemon/tests/fixtures/codex-app-server/<file>`.
  Codex 0.160.0 produced them.
- **Handshake.**
  `initialize` result `{userAgent, codexHome, platformFamily, platformOs}` at `expA-accept.jsonl:2`; the client's `initialized` notification at `:4`.
- **Server request frame.**
  `item/commandExecution/requestApproval` at `expA-accept.jsonl:47`, id 1, params `kind`, `threadId`, `turnId`, `itemId`, `startedAtMs`, `environmentId`, `command`, `cwd`, `commandActions`, `proposedExecpolicyAmendment`, `availableDecisions` `[accept, {acceptWithExecpolicyAmendment}, cancel]`.
  The frame has no `approvalId` key at all (the plan says it is null; the schema marks it optional).
- **Order on a subscriber.**
  `thread/status/changed` with `activeFlags: ["waitingOnApproval"]` (`expA-accept.jsonl:45`), then `item/started` for the command (`:46`), then the request (`:47`).
- **First answer wins.**
  Client B answers `accept` (`expA-accept.jsonl:51`); both clients get `serverRequest/resolved {threadId, requestId}` (`:52`, `:53`); client A's late `accept` is sent at `:62` and no error frame follows.
  `expA-decline.jsonl` shows the same with `decline` at `:65` (honored: the item completes as `declined` at `:68`), resolved at `:66` and `:67`, and a late `accept` at `:76`.
- **Ids are one daemon-global counter, not per thread.**
  Approval request ids 1 (`expA-accept.jsonl:47`), 2 (`expA-decline.jsonl:63`), 5 (`expB3.jsonl:41`) and, for a user-input request, 6 (`expC.jsonl:31`), across different threads and clients.
- **Late attach is replayed.**
  Client Y holds request 5 at `expB3.jsonl:41`; client Z's `thread/resume` (`:45`) is answered at `:49` and the same request, id 5, is delivered to Z at `:51`.
  Y answers it at `:54`.
- **A second thread appears beside the TUI's.**
  `expB.jsonl:7` is the TUI thread (`ephemeral: false`, `threadSource: "user"`, a rollout `path`); `expB.jsonl:12` is a title-helper thread for the same cwd about 7 s later (`ephemeral: true`, `threadSource: "thread_title"`, `environments: []`, `path: null`).
- **A blocking question.**
  `item/tool/requestUserInput` at `expC.jsonl:31` (`isBlocking: true`, `autoResolutionMs: null`), answered at `:34` with `{answers: {q1: {answers: ["Blue"]}}}`, resolved at `:35`.
- **Not captured, labeled as such.**
  The `-32600 no rollout found for thread id <id>` error (the spike report, not a log); file-change, permissions and elicitation requests (generated schema only).
  These were gaps at the Phase 1 spike date: `cancel` from a second client, what a mid-approval subscriber disconnect does to a pending request (plan risk R1), `/new` rotation, `optOutNotificationMethods`, failed-turn `turn/completed`, and keepalive on an idle connection. Later LV-1–LV-3 results and the idle-keepalive amendment below record which were resolved; LV-5 results and `lv5.jsonl` add the failed-turn frame.
- **What the Phase 1 tests prove, by mutation.**
  Each of these fails a named test when applied: a flipped mask bit, a dropped pong, a skipped accept-key check, no request timeout, correlating a response by the wrong id, the client sending an error frame to an unknown server request.
  A summary of the roughly 100 mutants is in the PR description.
- **APIs used.**
  `node:net` (`createConnection`, `createServer` on a unix path), `node:crypto`, `Bun.serve` with `unix` and `websocket` handlers (`open`, `message`, `close`, `pong`) and `ServerWebSocket.ping`, `close`, `terminate`, all present in `bun-types` 1.3.5 and therefore before 1.3.11.
  Run on Bun 1.4.2 and, after the Bun 1.3.11 findings below, on 1.3.11 (the CI pin).

## Phase 1 amendment: what the CI-pinned Bun 1.3.11 showed

The first run of the new tests on the CI pin, Bun 1.3.11 (official release binary), gave 131 pass and 6 fail; on 1.4.2 all passed.
The six failures had two causes, and a third finding turned up while running the whole suite.
Everything below was measured with `bun test` on both versions; none of it is a claim about Codex.

1. **Four hook timeouts: `Bun.serve`'s `stop()` never resolves on 1.3.11 after the server itself closes a WebSocket.**
   A probe stopped a `Bun.serve({ unix })` server in each state.
   With the client still open, `stop(true)` resolved.
   After a client-initiated close, it resolved.
   After the server called `ws.close()` or `ws.terminate()` on the connection, `stop(true)` and `stop()` both hung on 1.3.11 and resolved at once on 1.4.2.
   The listener was shut in every case (a later connect was refused).
   `FakeAppServer.stop()` awaited it, so every `afterEach` after a `closeClient` or `dropClient` test timed out after 5 s: two tests in `unix-ws.test.ts` and two in `app-server-client.test.ts`.
   The helper now starts the stop and removes its temp directory without waiting (commit "Do not await Bun.serve stop in the fake server").
   Undoing that change alone brings back exactly those four failures on 1.3.11.
   This is a test-peer teardown difference, not a transport bug.
2. **Two ENOENT failures: a failing connect can emit `'error'` synchronously under `bun test` on 1.3.11.**
   `net.createConnection({ path })` to a socket file that does not exist emitted `'error'` synchronously, before the call returned.
   A listener attached afterwards never saw it, and the runner reported it as an uncaught `connect ENOENT` against the running test.
   Bun 1.4.2 defers the event.
   Whether 1.3.11 emits it synchronously depends on runner state: in a probe file the first failing connects in the process did, and so did the next failing connect after a timed-out hook (which is how the original run hit it, right after cause 1); a failing connect after a successful one did not.
   It did not reproduce in a plain `bun script` child process: the pre-fix code, run as a fresh process, rejected cleanly with ENOENT.
   So there is no evidence of a daemon crash, and the original commit message for the fix, which said there was, overstated it (corrected in the follow-up commit).
   `connectUnixWebSocket` now builds a bare `Socket`, attaches every listener, and then calls `connect`, which is correct whichever way the event arrives.
   The guard is a test that observes `Socket.prototype.connect` (delegating to it, replacing nothing) and asserts the error, close and data listeners exist when it runs; it fails on the pre-fix code on both 1.3.11 and 1.4.2.
   A test that runs the connection in a fresh child process was tried and removed, because it could not fail on either version.
3. **`fs.realpath` on a socket fails on 1.3.11 too.**
   `realpathSync`, `realpathSync.native` and `fs.promises.realpath` throw `EOPNOTSUPP` on a unix socket file and on a symlink to one, identically on 1.3.11 and 1.4.2; `readlinkSync`, `lstatSync` and `realpath` of the parent directory work.
4. **The extractor tests now spawn asynchronously with a 30 s kill.**
   They used `Bun.spawnSync`, which blocks the runner while the child runs.
   This was changed while chasing finding 5 and is kept as hygiene: a child that never finishes now fails one test instead of stalling the runner.
   It is not the cause of finding 5.
5. **A full `bun test` on 1.3.11 intermittently stalls at 100 percent CPU in an existing test, not in this PR's files.**
   Three of 27 full runs on 1.3.11 hung with no output and no test timeout firing; 24 completed, 23 with 4838 pass and 0 fail and one with the single failure of finding 6.
   A run with a per-test trace (a preload printing a dot per test, so the runner prints each file header) stalled inside `packages/daemon/tests/hooks/corpus-replay.test.ts`, on its fourth test, at file 186 of 256.
   None of the five new `harness/codex` test files had run by then (the only file of this PR that had is `harness-boundary.test.ts`, a static scan), and this PR does not touch `corpus-replay.test.ts` or anything under `tests/hooks/`.
   The earlier two stalls ended after the same last file that had printed output, `cli/session-phases/structured-answers-e2e.test.ts`, which is consistent with the same place.
   `corpus-replay.test.ts` run alone passes (900 of 900 with `--rerun-each 60`), and every one of the 254 test files passes when run on its own on 1.3.11, so the stall needs the state left by earlier files in one process.
   A macOS `sample` of the stalled process shows the main thread in nested JavaScript-to-native frames polling `kevent64`, with the binary's symbols stripped.
   Not fixed here: it is outside this PR.
6. **One load-sensitive existing test fails on 1.3.11 about one run in five.**
   `ClaudeHarness.createSession > a wrapper session runs claude on the reduced terminal and feeds the local-terminal observer` (`tests/harness/claude-session.test.ts:315`) failed 5 of 25 runs of `packages/daemon/tests/harness` on 1.3.11 and 0 of 25 on 1.4.2, with `Expected: "39 120"` and `Received: ""` in the one failure whose text was captured.
   The test waits for the fake `claude` to create a `size` file and then reads it at once, so it can read the file before the child has written it.
   It is most likely the one-off `168 pass / 1 fail` seen earlier on 1.4.2 in the same directory, which was not captured by name: it is the only failing test seen in 50 runs of the directory and about 27 full runs.
   Not fixed here: it is outside this PR.

The new tests, run as a group (`tests/harness/codex` and `harness-boundary.test.ts`): 10 of 10 clean runs on each of 1.3.11 and 1.4.2, plus one run of each under CPU load, and each file alone 3 of 3 on 1.3.11.

## Phase 1 amendment: the review round

Two reviewers read PR #1183 at `3d7aa5d2` (transport and client correctness; fixtures, redaction, privacy, docs and test hygiene).
What they found, and what changed, in the order the reviewers ranked it:

1. **A write racing the peer's close left the link looking open for ever on 1.3.11.**
   With the peer destroying or ending its socket in the same timer tick as a client write, bare `node:net` emitted only `connect` and `end`.
   `connectUnixWebSocket` never called `onClose`, `AppServerClient` stayed `ready`, `request()` rejected only after its 15 s timeout, and `respond()` returned `true` for an answer that was lost (an approval answered into a dead socket).
   Fixed twice: the transport reports the close from whichever of `end` or `close` arrives first, and the client pings every 30 s and drops a link that misses a pong.
   Tests reproduce both peers' behavior (`end` and `destroy`, in one tick) and a peer that stops answering pings; the transport test fails on 1.3.11 without the `end` handler (it passes on 1.4.2, which reports EPIPE and `close`).
2. **`bun run typecheck` failed on a clean frozen install.**
   The typings bun-types brings in give `net.Server` no `once`, so `RawUnixPeer.start` did not compile.
   An older `node_modules` in a parent directory of the development checkout hid it; it reproduced in a copy outside any ancestor `node_modules`, which is how the gates now run.
3. **A forged reply could make the client ready without `initialized`**, and a hostile peer could grow a buffer and flood the log after a framing violation (the parser kept being fed).
   Both fixed (see decisions 2 and 3); the flood test counts what reaches a parser instead of measuring process memory.
4. **Mutants that survived with real consequence are now pinned**: the initialize timer cleared on the reply, a connection that resolves after `stop()` being closed, the backoff reset after a stable connection (and not after a flap), `stop()` waking the backoff wait, a string id never answering a numeric request, only `101` accepted, the header cap, the request and response timers cleared, the defaults (5 s, 15 s, 30 s, 10 s, 1 s), `send` refused while closing, an event handler that throws not breaking `stop()`.
   Judged equivalent, with the reason: the `if (done) return` at the top of the client's `onMessage` (the transport already ignores data frames once the client has called `close()`), the second `violated` check inside `violate()` and in the frame loop (the data handler and the closing phase already stop reading and delivering), and removing `finalize()` from the `end` handler (`destroy()` then raises `close`, which reports it).
5. **The fixture scan was a denylist in the allowlist's clothing, and the redaction test carried real spike values**, calling them invented (a thread id, the creation time it encodes, a command id, timestamps, the user agent with its OS, architecture and terminal emulator).
   The scan is now structural (decision 7), the tests use only values invented at run time, and the plan's redaction notes no longer name any.
   A mechanical check of the branch diff and commit messages against the raw spike logs (UUIDs and their prefixes, epoch values, opaque ids, model names, user agents, home user names, terminal and OS strings, server names, installation ids, rollout stamps) finds no hit.
   The earlier values stay reachable in the branch's pushed history; they are not secrets but they identify a session, so the owner was told.
6. **The fake server modeled behavior nothing backed or tested**; it is now labeled and pinned (`tests/helpers/fake-app-server.test.ts`).

Not reproduced, so not acted on: an extractor child process that exited 133 once while the reviewers ran many fuzzers at the same time.
It did not recur in the full-suite runs on either Bun version, and nothing in the extractor produces that code, so it is most likely a signal from the reviewers' load rather than the extractor.

## Phase 2 amendment

Phase 2 amendment: foundations, zero behavior change for Claude (#1176).

1. The older-daemon hazard (#1165 D) is narrowed by a refusal, not closed, and not by a second store file.
`findLegacyWriters` (`session/legacy-writers.ts`) lists every live process, other than the caller, that is older than `IDENTITY_SHIM_MIN_VERSION` (`0.7.16-dev.7`) or records no usable version, from the live-sessions entries, the hub's `daemon-status.json` and each `status-<PORT>.json`; a dead or absent pid is ignored, a record written before the process now holding its pid started is ignored as a recycled pid (an undeterminable time keeps the writer, reported unverified, with its file), and a process named in several records is reported once. The Codex launch will refuse to start (Phase 3) while the list is not empty, before `preAssign` writes the first non-Claude record. It sees only older processes alive at launch: an older binary started later (`remi --sessions`, `--resume`, any wrapper start, a LaunchAgent hub restarting on its old binary) can still rewrite `sessions.json` and erase `harness` and `harnessSessionId`, and residual R12 (an older binary registered nowhere) also slips through; the Codex launch must tell the user, and no sidecar identity file is planned. Every commit of the seam epic branch carries the shim at `0.7.16-dev.6`, so a locally built seam-era binary and a PR-stamped build such as `0.7.16-p1182.1` are refused (fail-safe). A second store file would force a merge in every consumer of `SessionStore`.
2. The reads are harness-aware (#1165 D, second half).
`getMostRecent(harness?)` filters by the stored harness (absence means Claude), `remi --resume` asks for `claude`, `resolveStoredSession(..., {harness})` throws `SessionHarnessMismatchError` for a Remi id or prefix that names another harness's record and matches the harness's own session id only among that harness's records (changed by #1179: the option is Claude-only now, the non-Claude branch was deleted because nothing called it), `--sessions` prints `claude:<first 8>` or `<harness>:<last 8>` (a Codex id is a UUIDv7; `<harness>:-` before the id is known), and `findByClaudeSessionId` and `updateClaudeSessionId` are Claude-only. This supersedes the last Consequences bullet of ADR 0032.
3. Store writes for a non-Claude identity.
`SessionStore.updateHarnessIdentity` fills in the id of a record created naming its harness; it refuses `claude` and a record naming another harness. `findByHarnessSessionId` found a record by pair and preferred the single active owner; it had no production caller and was deleted in the Phase 5 review (G14), since its throw on two exited rows is wrong for every lookup a caller would make (Phase 6 can add one that returns a list). `assertUniqueSessionIdentities` rejects two active records with the same non-Claude pair, for an unknown harness string too.
4. Argument policy: default-deny in both modes.
`validateCodexArgs` allows `-m/--model`, `-a/--ask-for-approval`, `-s/--sandbox`, `--add-dir`, `-i/--image`, `--dangerously-bypass-approvals-and-sandbox`/`--yolo`, `-h/--help`, `-V/--version` and `--no-alt-screen`, and refuses every other flag by name; its denylist (`--worktree`, `-C/--cd`, `-c/--config`, `--enable`, `--disable`, `-p/--profile`, `--strict-config`, `--dangerously-bypass-hook-trust`, `--no-daemon`, `--remote*`, `--approve-for-me`, `--not-so-yolo`, `--search`, `--oss`, `--local-provider`) only chooses the message. `-C/--cd` and `--worktree` are refused because identity matching uses the session cwd. The returned arguments are `[...flags, 'resume', uuid]` or `[...flags, '--', ...promptWords]`, so Codex cannot read a prompt as a subcommand whatever its spelling; the subcommand name list is a message only. A valued flag never takes a flag-shaped token as its value. `validateCodexRemoteArgs` is the default-deny allowlist for a request over the wire: `-m/--model`, `-a untrusted|on-request`, `-s read-only|workspace-write`, `resume <uuid>`, at most 16 arguments of at most 256 characters, no NUL, total over any input (changed twice since: the Phase 5 review cut it to `-a untrusted` and `-s read-only`, and LV-4 showed Codex 0.160.0 rejects `-a untrusted`, so it now allows `-m`, `-s read-only` and `resume <uuid>` and refuses `-a` in every form; see H3 and "LV-4 results"). Unverified when written, because remi must not run Codex: the lists came from the plan, the spike and a read-only look at Codex 0.160.0's embedded help strings, and the `-a untrusted` spelling was wrong. The arg parser drops a user's `--` today, which Phase 3 owns.
5. Neutral PTY spawn.
`createPtySessionForSession` takes `outputSink` (`PtyOutputSink`; `NOOP_OUTPUT_SINK` was Codex's, a no-op, until LV-4 showed that a startup failure then left no trace; Codex now passes a sink that keeps the first and last 1 KB (`startup-output.ts`), and the no-op sink is deleted, see "LV-4 results") and an optional `launch: {command, childEnv}` with both members required, so a non-Claude command never inherits `buildClaudeChildEnv`; absent, it is the Claude launch. `onExit`'s `markClaudeChildExited` is neutral in effect: the `claudeChild*` fields name the harness's child whichever command it is.
6. The notifier registration moved (#1165 E).
`createNewSession` registers the session's dispatcher in `sessionNotifiers` before `harness.createSession`; `ClaudeLaunchDeps.sessionNotifiers` stays as a read-only reference for the lazy terminal-notice closures. This supersedes Phase 3 amendment items 5 and 9 of ADR 0032 (the launch fills it) and the claim in item 2 that the launch context carries the notifier; the field is removed.
7. `Harness.transcriptPath` returns `string | null`; null means the harness names no transcript file, and the three readers (`current-session.ts`, the session-list decoration, the durable-index load) treat it as no file.
8. Boundary: `harness/codex/*` may import `cli/session-phases/pty-session-setup.ts` and nothing else under `cli/session-phases/`, and `pty-session-setup.ts` is held neutral. The general rule that nothing under `harness/codex/` imports a Claude module is Phase 1's.
9. Exports with no production caller until Phase 3 or 5: see the list in the PR body.
10. Receipts: pins first (commit `374f43ad`), the mutation list above, `launch-characterization.test.ts` unmodified and green 10 of 10 plus 4 concurrent, the base-against-head comparison on a Claude-only store (0 differences), 4974 tests passing on Bun 1.4.2 and 1.3.11.

## Phase 3 amendment: `remi codex` launch, identity and status (#1177)

Phase 3 is observe-only: `remi codex` launches Codex, finds which thread of the shared app-server is the session's, and reports that thread's status.
No approval card, answer, turn push or wire field exists yet (phases 4 to 6), and chat typed from a client is refused (item 12).
Nothing here was run against a real Codex: every claim below about Codex's behavior comes from the spike's frames or is listed under "Not verified".

1. **The launch.**
`codex --no-alt-screen <validated arguments>` in a PTY, in the session's working directory, with `process.env` plus `FORCE_COLOR` and `TERM`, which the PTY layer sets for every launch, and nothing else (no `REMI_PORT`, none of Claude's variables; the characterization test pins the child's whole environment against the parent's), no override flag, and no reserved status row.
The steps that change state run in this order: `validateCodexArgs` (a refusal is exit 2), the older-daemon gate (exit 1), the working directory check (exit 1), `preAssign` of `{harness: 'codex', claudeSessionId: null, harnessSessionId: <thread or null>}`, the PTY, and only then the app-server client, because the TUI is what starts the shared daemon.
Nothing under `harness/codex/` types into the PTY: the child's stdin sees only what is typed at the terminal and raw input (an attach client's keystrokes, the Escape button, `/interrupt`), which the client marks `raw` and the daemon cannot tell from a script (E3; the characterization test counts the bytes of a phone message: zero), and phone chat is refused before it reaches the PTY (item 12).
A Stop force-closes the session (`gracefulExitInput` is null), and `HarnessSession.decisions` holds nothing and answers nothing.
2. **Identity (`ThreadTracker`).**
A `thread/started` is a candidate only if its id is a UUID (`parseThread` returns null for anything else, because the id is stored in `sessions.json` and printed in the resume line, R3), it is not ephemeral, comes from `threadSource` `user` (or has none and a rollout `path`), has an environment and no parent, has a cwd that `realpath` resolves to the session's, was created at most 5 s before the spawn, and is not held by an active non-Claude record of another remi session.
The title helper that appears about 7 s after the TUI thread (`expB.jsonl:12`) fails three of those (it is ephemeral, from another source, and has no environment), and each rule has a frame that breaks only it.
The first candidate waits 300 ms, and a second DISTINCT candidate that ARRIVES inside that window means two Codex windows started in the directory together, so neither binds and a session without an identity keeps none (fail closed, plan risk R4).
Arrival decides, not `createdAt`: the real frames carry whole seconds, so no comparison of `createdAt` at 300 ms is possible, and none is made (an earlier draft of this item and of the plan said otherwise).
A repeat of the pending thread's id is the same candidate, not a second, and does not trip the latch.
When the window ends the claim is checked again, and so is the sibling guard (E1, E2): a `thread/started` carries nothing that says which session it is for, so a FIRST bind is refused while another live remi codex session in the same directory has no thread id and started under 60 s ago (an older one no longer blocks, and a start time that cannot be read counts as young), and a ROTATION is refused while ANY other live non-Claude remi session shares the directory, bound or not.
A refused candidate is dropped, not retained, since after a block keeping it would bind a guess; the session says so once, with what to do, and logs each block.
A thread the store refuses at the write (`ThreadClaimedError`, another session took it first) is remembered and never retried.
A later candidate rotates the binding (`/new`), but not while the tracked thread is `active` and not past the sibling guard above, and every rotation logs `rotated from <last 8> to <last 8>` (the last eight characters of a UUIDv7, whose first eight are a timestamp); the old id is not kept.
With two remi codex sessions in one directory that means a `/new` in either is followed by neither (E1, a known limit), and the first session also declines the other's first thread, once, with the same message.
Descendants, followed by parent links, count as the session's: at most 256 ids known to be ours and at most 512 links whose parent is not yet known to be ours, first in first out, so another window's threads can only fill the second memory; a descendant pushed out of the first is reported idle (R7), since its frames are ignored from then on.
Identity is persisted with `SessionBindingStore.updateHarnessIdentity`; for a resume the record already names the thread.
3. **Attach.**
`thread/resume {threadId, excludeTurns: true}` and nothing else, ever (the spike showed an override persists on the thread).
It is retried on any error, `-32600` being the one expected, at once when the tracked thread turns `active`, otherwise every second and every five seconds after ten failures, and once more after every reconnect; a `-32601` (the server has no `thread/resume`) stops the retries for that connection.
The result's thread status is applied.
Only the first failure and every thirtieth are logged, and no thread frame of another thread, no cwd and no thread id beyond its last eight characters is ever logged (a UUIDv7 starts with a timestamp that two threads created within about 65 s share, so the last eight tell them apart; the startup line of a headless Codex, added after LV-4, is the one exception, redacted, see "LV-4 results").
4. **Status.**
The session's status is the aggregate of the tracked thread and its descendants: `waiting` if any is `active` with a flag (an unknown flag counts), else `thinking` if any is `active`, else `idle`; it is reported through `messageApi.handleStatusChange` only when it changes.
Other threads never change it.
A drop of the link and a rotation forget the descendants' statuses, since their frames can no longer be trusted to arrive, and they are not fetched again (E4): a subagent that is still waiting reads as not waiting until its next frame; in phase 4 a subagent's approval is always a `terminalOnly` card, and whether it is replayed to a connection that resumed only the main thread is unverified.
5. **The shared daemon.**
remi never starts, stops, restarts or upgrades it.
If no connection is ready 30 s after the spawn, or the link drops and stays down 30 s, one log line and one system-sender message say so, once per session, and the session carries on as a plain terminal session.
A link counts as up only after it has stayed up 5 s, so a connection that is accepted and dropped at once does not cancel the notice; the edge is that a first connection that becomes ready in the last 5 s of the 30 s window does not cancel it in time, and the notice is sent although the link is then up.
The wording differs for a socket that exists but was refused as not private: it says the control directory is not private and that the log names it.
A session that is connected but never learns its thread says so once, 30 s after the link came up, if it still has none and no candidate is inside its window; with one inside it, it looks once more when that window is over (R8), so a candidate that is then refused still reaches the user.
Every one of these messages is a `structured_agent_output` with `sender: 'system'`; the web client renders chat from `transcript_content` and uses that message only to mark the session active, so it does not show there today (unverified elsewhere, a wire change is out of scope), and the log line is the record that always exists.
6. **Socket trust.**
`${CODEX_HOME ?? ~/.codex}/app-server-control/app-server-control.sock` is a symlink to a short path.
`realpath` throws `EOPNOTSUPP` on a socket (and a link to one) on Bun, so the directories are resolved with `realpath` and the link is read with `readlink`, one hop; a chain, a file or a missing target is refused.
Both the link's directory and the socket's must be owned by the current uid with no group or other bit, or `UntrustedSocketError` is raised and nothing connects; its message names the directory, its mode in octal, its owner and `chmod 700`.
The check is applied inside the client's `socketPath()`, so it runs on every reconnect attempt.
Two limits are documented, not closed (D6): the check runs before `connect`, so the directory could change between the two (a check-to-connect window, and the socket itself has no authentication), and only those two directories are checked, not their ancestors (no ancestor walk).
This is in `codex-socket.ts`, a file the issue did not list.
7. **The older-daemon gate.**
`checkCodexLaunch` runs before the first record is written, twice: in `cli.ts` before a daemon boots or a wrapper takes the terminal (where console output goes to the log), and again in `createCodexSession` before `preAssign`.
The refusal names each writer's file and pid identity (`delete <file>` when it could not be verified), the minimum version `0.7.16-dev.7`, that a version which does not parse (a PR-stamped build) counts as older, and `remi stop --all`, which also ends interactive remi sessions.
The launch prints once that an older remi started later (`remi --sessions`, `--resume`, a restarted hub on an old binary) erases Codex identities, which the gate cannot prevent.
There is no marker field in the record to tell a daemon that erases from one that does not (D7): the refusal's wording is what explains it.
`findLegacyWriters` is not read-only: its `listLive()` deletes live-sessions entries whose pid is dead or whose JSON is invalid.
8. **Arguments, the user's own `--`, and `--harness`.**
The parser keeps the user's `--` in a new `passthroughArgs`, and `remi codex` hands those to `validateCodexArgs`, so a prompt of words that look like flags reaches Codex after an inserted `--`.
`remi -c` stays Claude's `--continue`; `codex` is a subcommand only when no other was given, so `remi stop codex` and `remi new codex` keep their own subcommand (a second `codex` after it is a stray word), and once `codex` is the subcommand a later word that names a remi subcommand (`remi codex stop`) is a Codex word.
`--harness <id>` is hidden and tells a child daemon its harness; it conflicts with a different subcommand harness, and this build has adapters for Claude and Codex only.
`-i/--image` (in all four spellings) is refused together with `resume`: the validator's output has no `--` before `resume`, so if the flag takes several values (unverified) Codex would read `resume` and the id as image paths and start a fresh session while remi expects the thread.
`remi --recent` validates the Codex arguments before it shows the picker, so a refusal is exit 2 before any prompt.
The carry-over from Phase 2 said Codex flags that collide with remi's must be written after `--`.
That is not what ships: the validator makes everything after `--` prompt text, so such a flag cannot be passed through remi at all, and the help and the README say so.
`remi codex --daemon` takes no arguments until the hub can pass them (phase 5), `--host`, `--resume`, and the hub with a harness are refused with exit 2. (Changed by #1179: `remi codex --daemon` takes arguments after `--` and `--host` is accepted; `--resume` and the hub with a harness are still refused. See the Phase 5 amendment.)
9. **Purge before recording.**
`updateHarnessIdentity` and a `preAssign` that names a thread now purge dead holders first, in the binding store, because a record whose process died without exiting cleanly kept counting as an active holder of its thread and made the write refuse a free thread (Phase 2 review).
`remi codex resume <uuid>` also refuses a thread another live remi session holds, after the same purge, and resumes a thread that has several exited rows.
10. **Resume and the mismatch pointer.**
`remi codex resume <uuid>` works (`codex --no-alt-screen resume <uuid>`, attaching on ready with no `thread/started`), so `SessionHarnessMismatchError` names it, with the whole thread id for a Codex record that has one, and `--sessions` prints `resume: cd <directory> && remi codex resume <id>` under each exited Codex record, because its label cuts the id to eight characters and the resume looks the thread up from the session's own directory.
`remi codex resume` takes the whole thread id only: `resolveStoredSession`'s Codex branch (a remi id or prefix) had no production caller and was deleted in #1179, and the refusal of `resume_session_request` on a non-Claude daemon shipped there too.
11. **Deviations from the issue.**
`CodexHarness` is not exported from `harness/index.ts`: the boundary test allows only `cli.ts` to import `harness/codex/`, and the rule is not loosened.
`codex-socket.ts` is a new file.
The daemon version is logged from `initialize.userAgent` only; remi never runs `codex --version`.
`thread-protocol.ts` types an active thread's flags as strings, so an unknown flag still reads as waiting.
`ThreadTracker.handleReady` takes no argument and a `handleDisconnected` was added.
`CodexLaunchDeps` has a `log`, a `remiVersion` and test seams (`appServer`, `linkWatchdogMs`, `linkStableMs`, `tracker`), and no `onQuestionResolved` or `turnEvents` yet.
12. **Chat is refused in this phase.**
`HarnessSession.acceptsTypedChat` (absent means true) is false for Codex, and `onUserInput` refuses non-raw text for such a session before the `promptUp` guard, with code `PROMPT_WAITING` and the message "This session does not take typed messages from the app yet; type in the terminal." (D1).
Without it a message from a phone, Telegram or the relay would have been typed, plus its Enter, into whatever the Codex TUI had focused (an approval overlay, the Update modal), the failure the spike's Update-modal incident showed (a typed digit ran an installer): `promptUp` reads "nothing up" for a session with no screen reads and no decision channel.
Raw input (an attach client's keystrokes, the web Escape button, Telegram `/interrupt`) still reaches the terminal: `raw: true` is set by the client, the daemon cannot tell a person from a script, and an attach client's keystrokes must reach Codex, which is accepted by design (E3).
For such a session the line at the top of `onUserInput` that logs every user input logs the length only, raw input included, and the refusal logs the length too (R6); Claude's line is unchanged.
13. **Not verified, for LV-2 (run live on 2026-10-04: the Phase 4 amendment's item 11 gives the results; only the cold start (R2), `-- exec x`, `-- login` and a `/resume` of an unloaded thread were still not seen; LV-4 then saw the cold start, see "LV-4 results").**
That Codex's server accepts the hand-rolled client's handshake (LV-1 is the same question); that bare `codex` starts the shared daemon on a cold start (R2); that `thread/started` for the TUI thread arrives within about 2 s and the title helper is ignored; that the attach succeeds after the first message; that a dropped subscriber leaves the TUI untouched; that no `.claude/settings.local.json` appears; whether the system message shows anywhere; whether `thread/started` carries any client marker that would tell a non-remi window apart; that `remi codex -- login` and `remi codex -- exec x` send those words as prompt text (the inserted `--` in `codex-args.ts` is unverified, and so is item 8's claim that it makes every word a prompt); `-i` together with `resume`; that TUI-internal `/resume` emits no `thread/started` (the spike's `expB3.jsonl:12-13` shows none, so the tracker keeps the old thread, a known limit); and `kill -9` of remi in the middle of an approval.
14. **Exports with no production caller in this PR.**
`UntrustedSocketError` (read as an `instanceof` only by the launch's notice wording and tests), `validateCodexRemoteArgs` (phase 5: the hub calls it, #1179), `SessionBindingStore.getIdentity` (phase 5: the session list and every question emission call it, #1179) (`SessionStore.findByHarnessSessionId`, which had none, was deleted in the Phase 5 review), `resolveStoredSession`'s Codex branch (deleted in #1179), and the client's `AppServerDisconnectedError`, `AppServerTimeoutError` and `AppServerSerializationError` (phase 4 reads them when it answers).
The tracker's test-only accessors were removed.
`shellQuote` moved to `session/shell-quote.ts` and is called by `codex-session.ts` (the resume line) and `session-store.ts` (the mismatch pointer); `codex-args.ts`'s `UUID_PATTERN` is now exported and used by `thread-protocol.ts`.
`ThreadClaimedError`, `codexLaunchRefusal` and `codexResumeCommand` have callers in `cli.ts` or the launch.
Everything else this phase added or inherited from phase 2 has a caller in `cli.ts` or the launch: see the table in the PR.
15. **Receipts.**
Pins first: `codex-launch-characterization.test.ts` was committed red before any implementation, and `launch-characterization.test.ts` passes unmodified before and after the `cli.ts` gating.
About 130 mutants were applied, each to a committed tree and reverted with `git apply -R`: all killed except the equivalent ones listed in the PR (two guards that each hide the other, a claim filter that was then removed, a memory-hygiene delete, a path the store normalizes).
The review rework (W1 to W21) and its second round (R1 to R9) wrote each failing test before its fix and ran mutants on their new logic: see the PR.
Gate results and the removed-line check are in the PR.

### Decisions recorded in the review rework

- **D1, chat.**
Phone chat for Codex is refused in this phase through `acceptsTypedChat`, with code `PROMPT_WAITING` and a Codex-specific message, because the web client fails the refused bubble only for that code (`web/src/lib/prompt-waiting.ts`).
The plan placed `acceptsTypedChat` in phase 4; it ships here.
- **D2, rotation.**
A later same-directory thread rotates the binding while the tracked thread is not active, but never onto a thread another session holds, never while another live session shares the directory (E1, which replaced the first guard, a sibling still without a thread), and the claim is re-checked at commit.
Residual: a plain non-remi `codex` window opened in the same directory while the session is idle is indistinguishable from `/new` and re-binds it; every rotation logs `rotated from <last 8> to <last 8>`; the plain-window re-bind was seen live on 2026-10-04.
TUI-internal `/resume` emits no `thread/started`, so the tracker keeps the old thread (a known limit).
Both are LV-2 items and plan risk R4.
- **D3, ambiguity.**
Decided by arrival inside the 300 ms window; `createdAt` is not compared (whole-second resolution).
- **D4, the latch.**
Once two candidates were ambiguous and no identity is held, the session binds nothing for good; a duplicate frame for the same thread id does not trip it.
- **D5, no `thread/list`.**
A session that never learns its thread is told so after 30 s instead; a follow-up issue, gated by LV-2, may add a `thread/list` recovery.
- **D6, the socket.**
The check-to-connect window and the unchecked ancestor directories are documented (item 6), not closed, and there is no ancestor walk.
- **D7, older daemons.**
The gate has no marker field to read; the refusal text explains what it can and cannot see (item 7).

### Decisions recorded in review rework round 2

- **E1, rotation against any sibling.**
A rotation fails closed against ANY other live non-Claude remi session in the same directory, bound or not.
A `/new` frame cannot be attributed to a session: with two bound idle sessions A and B, a `/new` in B reaches both trackers, and whichever commit timer fired first (A, the older connection, nearly always) rotated onto B's thread while B stayed on its own.
So a `/new` in either is followed by neither (a known limit); each logs it and tells its user once, "a new thread appeared; another remi codex session shares this directory; not following it".
The plain-window residual of D2 stays.
- **E2, the first-bind window.**
An unbound sibling blocks a first bind only while its `startedAt` is under 60 s old (its first-thread window); a 6 hour old row with no thread no longer blocks anyone.
A blocked candidate is dropped, not retained, and the notice says what to do ("restart one of them if this persists").
- **E3, raw input.**
`raw: true` is set by the client, and the daemon cannot tell a person from a script; an attach client's keystrokes must reach Codex.
This is accepted by design: the claim is that remi types only raw input (an attach client's keystrokes, the Escape button, `/interrupt`) into a Codex PTY, which the client marks, not that a person is behind it.
- **E4, subagent status after a blip.**
A subagent's status is forgotten when the link drops and is not fetched again; a still-waiting subagent reads as not waiting until its next frame.
In phase 4 a subagent's approval is a `terminalOnly` card, and whether it is replayed to a connection that resumed only the main thread is unverified (LV-3 (h)).
- **E5, hub requests.**
`resume_session_request` and `create_session_request` on a Codex daemon stay phase 5 item 7 (tracked in #1179); this phase does not touch them. (Done in #1179: see the Phase 5 amendment.)

## Phase 4 amendment: approvals reach the phone (#1178)

Phase 4 shows the app-server's command approvals as phone cards and sends the phone's answer back to the app-server.
remi relays the approval and Codex decides (ADR 0030): nothing is judged, nothing is typed into the PTY for an answer, and a request remi does not handle is never answered.
At the first delivery nothing here had been run against a real Codex. On 2026-10-04 live steps LV-1, LV-2 and LV-3 were run against the owner's real Codex 0.160.0 by a spike agent, and the epic gate holds: a dropped subscriber does not cancel a pending approval (item 11 lists what was verified, what was corrected and what is still not seen). Claims about Codex's behavior outside item 11's list still rest on the spike's frames or the stand-in app-server.
The review rework of PR #1188 is items 12 to 14, and the live round is item 15; where either changed an earlier item, the item says so.

1. **What becomes a card.**
`CodexDecisions` (`codex-decisions.ts`) is the session's `DecisionChannel`, and `approval-cards.ts` builds the cards.
A server request about the session's own thread becomes one: the tracked thread (`ThreadTracker.role` says `main`) or a descendant (`subagent`).
A request about any other thread, one that does not name its thread, and a method with no card (`item/tool/call`, token refresh, attestation, time, the legacy approvals) is ignored and logged by method name only, and never answered; `AppServerClient` has no way to send an error response (decision 4 of this ADR).
Request ids are one daemon-global counter, so a request is keyed `(threadId, requestId)`, and the thread's role is read again when an answer arrives, so a card that outlived a rotation cannot be answered.
2. **What is answerable.**
Only a plain command approval of the main thread: `kind: 'command'`, no `approvalId`, no extra permissions, no network context, no proposed network policy amendment (a missing key counts as null, the real frame has none).
Options are built by meaning from the request's own `availableDecisions`, which absent means `accept` and `decline`: Yes is `accept`; "Yes, and don't ask again for this command this session" is `acceptForSession`, offered only when listed (`standingGrant: 'session'`, a new union value; it carries no suggestion index; the dispatcher gives the card no lock-screen category and no dynamic options); No is `cancel` when listed (what the TUI's own No sends), else `decline`, else the card cannot be answered.
Codex has never offered `acceptForSession`: none of 7 real command approvals on Codex 0.160.0 (the spike's and the live run's) listed it (they listed `accept`, an `acceptWithExecpolicyAmendment` object and `cancel`), so the option is unreachable in practice there and what Codex does with it is unknown (LV-3 (f)); the code and its unverified label stay, and remi writes no rule or settings file either way.
The object-form decisions are never offered: they write a persistent policy from a phone tap, and a phone tap never writes a settings file.
A card without a Yes or without a No is `terminalOnly`.
A phone No, and the header X (Cancel), send `cancel`, which is Codex's own No: verified live (2026-10-04, LV-3 (c), F7) that Codex declines the command, does not run it and INTERRUPTS the turn ("Conversation interrupted"), exactly like the TUI's No, so a phone No ends the turn.
3. **The command text, and what else is on the card.**
The card text is `Allow Codex to run: <command>` (Codex's own command text is `/bin/zsh -lc '<command>'` as seen live, so the shell wrapper counts toward the 120-character cut below), then, when the command runs somewhere other than the session's own directory, `In directory: <cwd>`, then Codex's stated reason (cut at 300 characters).
The directory is compared with `resolve`, which does not follow symlinks: if Codex reported a logical path rather than the realpath for a command run in the session's directory, every card would show the line and lose its lock-screen buttons (fail-safe, but a regression; LV-3 (k)).
A request whose `cwd` is missing, null, empty or not text is `terminalOnly` (T6): the person could not see where the command runs.
All six real command approvals of the spike carry `cwd` as a non-empty string (`expA-accept.jsonl:16` and `:47`, `expA-decline.jsonl:22` and `:23`, `expB3.jsonl:20` and `:25`), so there is no real frame to keep a one-tap Yes for.
A command longer than 120 characters is cut the way Claude's hook cards cut one (`truncateSummary`: the first 80 characters, a count of what is hidden, the last 30), because a command's dangerous part is as likely at its end, and the whole command goes in `detail`, which the app shows in full.
The cut is made on the escaped text and never lands inside an escape: a head or tail boundary that falls inside one moves to its end, and the count is what lies between (T5; Claude's own cut is unchanged).
A card with `detail` (a cut command, or a directory that differs) gets no lock-screen category and no dynamic buttons, so Yes needs the app, where the whole card is; its push shows the ask (both ends of the command), not the start of the detail.
Telegram shows the text and the whole command, with its buttons, when they fit in one message; when they do not it says "Command truncated", shows the cut ask, and offers no buttons.
Before the review, the text was the whole command and the lock screen and Telegram cut it from the end while still offering Yes (S1).
A command whose escaped text is longer than 20000 characters is `terminalOnly` and is not shown cut.
Every string the server chose is bounded (free text 2000 characters, labels and names 200, option descriptions 500, the directory 500, the host of an elicitation's URL 200, a command's reason 300; at most 8 questions of 12 options and 20 permission names), and every cut says so: a cut text ends with "[N characters hidden]", a dropped list item with "[N more options hidden]", "[N more questions hidden]" or, for permission names, "[N more hidden]", and the command's middle is Claude's "… [N chars hidden] …" (S7, T1, T7). Text is cut before it is escaped, so a cut never lands inside an escape.
Everything is escaped (S5, T2): `escapeUnsafeText` in `@remi/shared` writes each character of the set below as visible text, never dropped: `\uXXXX` in the Basic Multilingual Plane, `\u{XXXXX}` above it. The set, listed once here (the helper's header and its test spell out the same ranges): the C0 controls but tab and newline (U+0000 to U+0008, U+000B to U+001F); U+007F to U+009F; U+00AD (soft hyphen); U+061C (Arabic letter mark); U+180E (Mongolian vowel separator); U+200B to U+200F (zero-width space and joiners, direction marks); U+2028 to U+202E (line and paragraph separators, bidi embeddings and overrides); U+2060 to U+206F (word joiner, invisible operators, bidi isolates, deprecated format characters); U+FEFF; and the Tags block U+E0000 to U+E007F.
It is not every invisible character: variation selectors (emoji need U+FE0F), the combining grapheme joiner and the Hangul filler letters are shown as they are, and an emoji sequence joined with U+200D is escaped at the joiner. Escaping twice gives what escaping once does.
The attach client's banner applies the same escape to the question text and the option labels, which also hardens Claude's banner; Claude's hook cards build their own text and have the same hole, not changed here.
4. **Everything else is `terminalOnly`.**
A file change, extra permissions, a user-input question (`kind: 'multi_question'`, questions mirrored for display), an MCP elicitation (a `url` shows its host only), a command that asks for more than itself, a subagent's request (always, with `agentId`), a known method whose fields do not parse (a generic card), and a command too long to show.
Such a card says what Codex asks and has no answer controls; every answer is refused, and Cancel clears it from the phone and sends nothing, so the TUI's overlay stays.
It carries `cancelDismissesOnly`, so the app's Cancel reads "Dismiss (answer in the terminal)", never "Decline tool call" (Claude's terminal-only cards keep that label, their Cancel denies), and a card with no options shows "Answer this in the terminal." and no text input (S6).
5. **Nothing is typed, by construction.**
The answer and Cancel handlers write to the PTY only when `answerHeld` says `unknown` (Cancel types an Esc for a card still in the registry).
`CodexDecisions.answerHeld` never says it, for any id: a card it never showed reads `closed`.
The plan's table said `unknown` for an id never seen; that left an Esc typed for any card something else put in the registry, which nothing does today and a test now does on purpose (deviation D1, accepted by the review).
There is also no `screen`, so a typed answer's guards fail closed, and chat is refused before it (`acceptsTypedChat`, phase 3).
`hasMainHold` and `hasOpenHookPrompt` say false: the chat guard and Stop read them and neither can reach a Codex session (chat is refused earlier, a Stop force-closes), so the review removed the state behind them (the status hand-off, `mainWaiting`, the per-entry main flag); a typed path (phase 6) adds what it needs.
6. **First answer wins, and an answer Codex does not confirm.**
A `serverRequest/resolved` for a card remi did not answer dismisses it on every client (`question_resolved`, reason `cancelled`, as for Claude's terminal answers); one for a card remi answered changes nothing; a phone answer that arrives after it is `STALE_ANSWER` from the real answer handler.
The answer is held in state `answered` until the resolved arrives, so a second answer cannot be sent: a second Yes, or a second client's Cancel before `question_resolved` reaches it, is closed and leaves the entry and its confirmation timer alone, so the notice below still comes (T3).
Codex ignores the loser of a race without an error (spike), so a phone answer that lost still reads "answered" on the phone.
Verified live (2026-10-04): the TUI answering first sent `question_resolved` reason `cancelled` to every phone client and a late phone Yes got `STALE_ANSWER` from remi itself; that Codex ignores a late answer was not re-tested here (the spike covers it).
"Delivered" is a frame written to a socket, not Codex's decision: ten seconds after a delivered answer with no resolved, the person gets the system message "Codex has not confirmed the answer; check the terminal" and the entry is forgotten (S8).
A send that fails (a result that could not be encoded, or a link that did not take the frame) is logged by cause and tells the person to try again from the new card, if one appears, or answer in the terminal (S10).
7. **The link.**
When it drops, every card is retired at once: not answerable, `answerHeld` says `closed` even after the client is ready again (a reconnect can bring a different daemon whose ids repeat), but still shown.
The tracker's `onAttached` (after a successful `thread/resume`) starts a 3 s replay window (it was 1.5 s; a slow replay then flickers less, F6): the app-server replays a pending request to a client that attaches (spike: same id, 4 ms, `expB3.jsonl:49-51`), and the replayed request makes a new card with a new id and dismisses the retired one in its place; a retired card nothing replayed by the end of the window was resolved while the link was down and is dismissed then.
A link that never comes back dismisses the retired cards after 30 s (deviation D4), so no dead card outlives it.
An answered entry is forgotten at the drop.
The timers run on an injectable, unref'd scheduler: a pending sweep never holds the daemon's event loop, and tests observe the timers that are set and cleared.
A rotation, `remi unstick`, and the session ending (`dispose`) dismiss every card.
Verified live (2026-10-04, R1, LV-3 (d) and (i)): a dropped subscriber, a probe or real remi killed with -9 and even remi and the TUI together, does not cancel or decline a pending request: the prompt stays up and the same request id is replayed to the next `thread/resume`. An Esc in the TUI, `turn/interrupt` and an RPC `cancel` each produce `serverRequest/resolved` (LV-3 (g)), so no status-based dismissal is needed.
The live run also found that Codex answers EVERY WebSocket ping with TWO identical pongs, which dropped the link every 70 s or so with the old keepalive: `onPong` now ignores a pong with no ping outstanding and `armPing` never leaves two timers (item 15).
8. **Logs and what persists.**
No command, cwd, prompt or full thread id: a thread id is shown as its last eight characters (UUIDv7 prefixes collide: a live log read `rotated from 01a106f2 to 01a106f2`), a decision is logged as an id and a thread, never a command. A string request id and a method name, which the server chooses, are cut and escaped in a log line (T9). The one exception, added after LV-4, is the startup line of a headless Codex that exits within 10 seconds of its spawn before it names a thread: the first and last 1 KB of its output, redacted (every UUID to its last eight characters, the session's directories and the home directory to `<cwd>` and `~`) and escaped, which can still hold anything else Codex printed (`startup-output.ts`; "LV-4 results").
Two neutral log lines printed the start of a card's text, which for Codex is a command: the question-detected line (`message-api-setup.ts`) and the registry's cap-eviction warning (`question-store.ts`).
Both now log a length when the daemon hosts Codex (`redactQuestionLogs`, from `cli.ts`), and are unchanged for Claude (deviation D8).
The text itself also reached the live-sessions registry file as a "label" (the first 140 characters of `Allow Codex to run: <command>`, read by the hub census and the macOS menu-bar notifications): a card now carries a fixed `pendingLabel` ("Permission: Codex command", or "Codex asks for approval" for every other kind), which `buildPendingQuestionLabel` returns as it is (S2).
Where a card's text or detail leaves memory, and whether it should: the card to connected clients over supported transports (WebSocket and Telegram), intended, because the person must see it; the push, intended, the cut ask (title 120 and body 200 characters) in plaintext to the signaling Worker and APNS; the relay is off by default and no shipped client can join a relay room. Since #1193, the daemon creates no relay adapter or Worker connection without authenticated permanent-code setup; `sendRaw` refuses outbound messages until session keys exist and encrypts them before sending. The Phase 1 plaintext-relay concern is preserved as historical F8 below and was superseded by #1193; push remains a separate plaintext path; the replay buffer, memory only, intended; the attach client's terminal banner, escaped; the live-sessions file, a fixed label only; `sessions.json`, no question data; the opt-in question trace, ids and signals only; a log, a length only; the history store, none (Codex chat history is phase 6).
9. **Deviations from the plan and the issue.**
- D1, `answerHeld` is never `unknown` (item 5).
- D2, `CodexDecisions` takes `threadRole` as a dependency, returning `main`, `subagent` or null, where the plan passed `isOurs` as a boolean per call: a boolean cannot tell a subagent from the main thread, and the answer-time re-check needs it stored. The tracker gains `role()`; plan 2.3 said it has no such accessor, which phase 3's tests relied on, and phase 4 has the production caller.
- D3, the tracker gains `onAttached`; the plan wired "`tracker.onNotification` into `handleReattached`", and no tracker event said an attach succeeded.
- D4, retired cards stay shown and a 30 s grace dismisses them if no re-attach comes (item 7).
- D5, `CodexDecisions` has `dispose()` (dismiss all, ignore later events and cancel the timers; the session's `dispose` calls it), its client dependency is `Pick<AppServerClient, 'respond'>` (a failed `respond` already says the link is not ready) and its registry dependency is `removeQuestion` only: the session installs the eviction guard, so a wiring test can catch its removal.
- D6, `buildApprovalCard` returns null for a request that does not name its thread as well as for an unhandled method (nothing could say it is the session's); a command too long to show and a subagent's command are `terminalOnly`.
- D7, `onQuestionResolved` is a `CodexLaunchDeps` member (the plan's 2.3 listed it; phase 3 left it out).
- D8, the two log lines of item 8, and `SessionRegistryConfig.redactQuestionLogs` and `QuestionStoreOptions.redactText` to carry it.
- D9, `FakeAppServer` gained `resolve()`, `isPending()` and `ignoreAnswers()`, test helpers.
- `forceRelease` returns `{resolved}` (the harness contract), not a bare count.
- The review rework added two optional fields to `Question` (`pendingLabel`, `cancelDismissesOnly`), the shared `escapeUnsafeText`, `CodexDecisionsDeps.notice`, `sessionDirectory` and `scheduler`, an `hooks/tool-summary` entry on the Codex import allowlist (a test pins that the file imports nothing), and a change to `formatOptionList` (a value longer than three characters is not shown) and to Telegram's cut notice (`Command`, not `Plan`, for a command).
10. **Exports with no production caller in this PR.**
None, with one note: `buildApprovalCard`, `responseFor`, `requestKey`, `requestThreadId` and `isApprovalMethod` are called by `codex-decisions.ts`, `parseResolved` by `codex-session.ts`, `ThreadTracker.role` and `onAttached` by `codex-session.ts`, `escapeUnsafeText` by the card builders and the banner, and `COMMAND_TEXT_MAX` and `realScheduler` are exported so the tests can check the bound `commandCard` reads and the unref of the clock `CodexDecisions` defaults to.
11. **Live verification of 2026-10-04, and what is still not seen.**
Run against the owner's real Codex 0.160.0 by a spike agent (LV-1, LV-2, LV-3); the epic gate holds.
Verified: (a) a phone Yes (`accept`) ran the command and the overlay closed, and both phone clients got `question_resolved` reason `answered`; (b) the TUI answering first sent `question_resolved` reason `cancelled` to every phone client, and a late phone Yes got `STALE_ANSWER` from remi; (c) a phone No sends `cancel` (it is in `availableDecisions`): Codex marks the item declined and the turn interrupted ("Conversation interrupted"), the command does not run, like the TUI's own No, so a phone No ends the turn; (d) R1: a dropped subscriber (a probe and real remi killed with -9) does not cancel or decline a pending approval: the overlay stays up, the SAME request id is replayed to the next `thread/resume`, and answering it in the TUI produces `serverRequest/resolved`; (g) an Esc in the TUI on an approval, `turn/interrupt` over RPC and an RPC `cancel` each produce `serverRequest/resolved` and the card is dismissed, so F3 is settled (no status-based dismissal is needed); (i) a pending request survives a subscriber drop, even remi and the TUI together, and is replayed with the same id; (j) a plain `codex` window in the same directory re-binds an idle remi session (residual R4 confirmed), and the rotation message reached the phone client; (k) Codex reports the realpath as `cwd` (the frame, the TUI's directory line and `thread/started`) even when launched from a symlinked path, so a session's own directory shows no "In directory" line and keeps Yes and No.
(e) is a correction: remi sends no `thread/unsubscribe` anywhere (`dispose` only closes the socket), so a normal exit leaves the thread loaded; a probe's `thread/unsubscribe` is harmless. The earlier sentences that said remi unsubscribes at exit were wrong.
(f) is unchanged: `acceptForSession` was not in `availableDecisions` in any of 7 real command approvals on 0.160.0, so what Codex does with it is unknown.
LV-1: the handshake of the hand-rolled client works against the real server (`initialize` answered in 2 ms with result keys `userAgent`, `codexHome`, `platformFamily`, `platformOs`; the 101 response carries `x-codex-websocket-max-unfragmented-message-bytes: 16777216` and no extensions; `optOutNotificationMethods` is accepted and effective; `thread/loaded/list` and `server/diagnostics` are answered; R3 is answered), except the keepalive (item 15).
LV-2: `thread/started` for the TUI thread arrives within about 0.8 s of the spawn, with `cwd` equal to the scratch directory's realpath, and the identity is written to `sessions.json` at that moment, before any message; the ephemeral `threadSource: "thread_title"` helper thread (0 environments, no path) appears about 1 s after the first message and is ignored; `thread/resume` fails -32600 "no rollout found for thread id <uuid>" before the first message (the exact text of the fixture) and succeeds about 1 s after it; no `.claude/settings.local.json` is written and `~/.claude/settings.json` is unchanged; `thread/started` carries no client marker (a plain window and a remi-spawned one are indistinguishable; `source` is "vscode", `originator` is daemon-global); a TUI `/resume` of a thread already loaded in the daemon emits no `thread/started`; words after `--` are read as prompt text (checked only with `help` and `completion bash`; `-- exec x` and `login` were not run); and `-i <missing.png> resume <uuid>` makes clap swallow `resume` and the uuid as image paths, so the TUI started a fresh session and auto-submitted the images, a verified hazard that confirms remi's refusal of `-i` with `resume`.
Facts seen live: a `kill -9` of remi also ends the user's Codex TUI (the child gets SIGHUP when remi's PTY master closes, the same wrapper-owns-the-PTY posture as Claude) while the pending approval stays pending on the daemon; with Codex's "Approve for me" (approvalPolicy on-request with the default reviewer, status line "Read Only (Approve for me)") Codex's Guardian approves a command automatically and sends NO `requestApproval` to any client, so remi shows nothing and cannot answer, and the Guardian frames that now exist (`item/autoApprovalReview/started`, `item/autoApprovalReview/completed`, a `guardianWarning` text) are not handled (the plan's statement that no Guardian frames were captured was wrong); `originator` is daemon-global, set by the first client that initialized (after a `remi` client initialized first, later TUI-created threads read "remi", R8); server request ids start at 0.
Still not seen: (h) a subagent's request (whether it is addressed to a connection that resumed only the main thread, and replayed); LV-2 (b), the cold start of the daemon with it stopped (R2; seen by LV-4, see "LV-4 results"); `-- exec x` and `-- login`; a TUI `/resume` of an unloaded thread.
12. **Decisions of the review rework (F1 to F8).**
- F1, no per-card deadline for Codex: Claude's holds are bounded by hook timeouts remi cannot lift, but a Codex request waits in the app-server without a deadline and the card mirrors it, so expiring the card would strand a request that is still pending. The consequence, stated plainly: a card on a lock screen stays answerable for as long as Codex waits. There is no timer.
- F2, rotation keeps approval authority (residual R4): a plain non-remi `codex` window in the same directory, opened while the session is idle, looks like a `/new` and re-binds it, and approvals then come from that thread. It is not closed here (same user, same machine, not a security boundary), but never silent: every rotation sends the system message "remi now follows a new Codex thread; approvals come from it", once per rotation event, next to the log line `rotated from <last 8> to <last 8>`. Confirmed live on 2026-10-04: a plain `codex` window re-bound an idle session and the message reached the phone.
- F3, no status-based dismissal of a live card: that a main-thread status leaving `waiting` means the request is over would be an unverified inference, and a wrong dismissal strands a pending request. The only dismissal signals are `serverRequest/resolved`, a link drop, a rotation, `remi unstick` and the session ending. Settled live (2026-10-04, LV-3 (g)): an Esc in the TUI, `turn/interrupt` and an RPC `cancel` each produce a resolved, so none is needed.
- F4, a card dismissed by Cancel (a `terminalOnly` card) or by `remi unstick` comes back at the next replay (a reconnect or a re-attach) because the request is still pending: intended.
- F5, a flapping link pushes the card again at each replay, and more than 64 requests at once dismiss the oldest live cards (they stay answerable in the terminal): intentional and fail-safe, not changed.
- F6, the replay window is 3 s.
- F7, a phone No and the header X send `cancel`, which in Codex also interrupts the turn (verified live, 2026-10-04: the item is declined, the turn is interrupted, the command does not run, like the TUI's own No).
- F8 (historical, superseded by #1193): the Phase 1 concern that the relay and Worker would carry the full command in plaintext. Today the relay is off by default, has no shipped client, requires authenticated permanent-code setup, and `sendRaw` refuses until session keys exist before encrypting outbound messages (item 8). This does not cover push, which remains a separate plaintext path.
13. **Review findings, by item.**
S1 (a cut command, item 3), S2 (the fixed label, item 8), S3 (rotation message, F2), S4 (no deadline, F1), S5 (escaping, item 3), S6 (Cancel label and no input, item 4), S7 (bounds, item 3), S8 (unconfirmed answer, item 6), S9 (the push body reads labels, not Codex's words), S10 (send failure, item 6), S11 (the directory, item 3), S12 (the grant label, item 2).
L2 (a subagent's approval is `terminalOnly`, and whether it is replayed to a connection that resumed only the main thread is unverified: this corrects the sentences of the phase 3 amendment, E4, and the plan that said the replay re-delivers a card a person can act on), L3 (unverified behavior now carries its label in the README, `--help`, the type comments and the lists), L4 to L6, L8 to L11 (tests that could not fail, or claimed more than they did, now do and can), L12 (two Codex test files leaked temp directories; `codex-session.test.ts` waited for nothing before removing a directory the PTY exit handler writes into).
14. **Receipts.**
Pins first, in their own red commit: the golden table of real frames to `Question` JSON, the lock-screen category pin and the black-box typed-bytes-zero run of the whole daemon with a real websocket phone and a fake `codex` that counts its stdin (with a raw `q` as the positive control); then the implementation turned them green.
The scenario tests (`codex-first-answer-wins.test.ts`) run the real client, tracker, registry, message API, input handlers and a stand-in app-server.
**Fault injection, all of it.** In `codex-decisions.test.ts` (the unit file) these stand in for a collaborator, and none replaces `CodexDecisions` or the card builder: a recording client that can be told the link is down or that its `respond` throws; a `roles` map standing in for `ThreadTracker.role`; a `present` that throws before it reaches `handleQuestion`; a `removeQuestion` and an `onQuestionResolved` that throw; a `notice` collector; and a recording scheduler that fires only the timers the test chooses (it replaces the clock, never the logic). The real `AppServerClient`, `ThreadTracker` and `FakeAppServer` are constructed only in `codex-first-answer-wins.test.ts`, and the whole daemon only in `integration/codex-launch-characterization.test.ts`.
Mutants of the new logic and of each wiring line, with the tests that kill them, are in the PR.
15. **The live round: what changed (Q1 to Q6).**
- Q1, the keepalive: Codex answers every ping with two identical pongs. `onPong` re-armed the ping timer on each without clearing the previous one, so two ping timers existed and a later ping overwrote `pongTimer`, leaking a timer that fired "no pong within 10000 ms"; the link dropped about every 70 s and a pending card was re-created with a new id each time. `onPong` now ignores a pong when no ping is outstanding (an unsolicited pong is legal, RFC 6455) and `armPing` clears a previous ping timer, so two can never exist. The fake server gained `doublePong()`. The other handlers in `unix-ws.ts` have no keepalive state: the ping handler answers each ping with one pong and the pong handler only calls `onPong`.
- Q2, ids: every shortened thread id (logs, notices, the `codex:<id>` label of `--sessions`, the claimed-thread and ambiguous-identity errors) is its last eight characters (`shortThreadId`), because a UUIDv7 starts with a timestamp; whole ids stay in resume commands and mismatch pointers; remi's and Claude's v4 ids keep their first eight.
- Q4, request id 0: the first real request id was 0; the fake server counts from 0 and tests pin the client, the decision channel and the card key (no falsy check on an id exists).
- Q3 and Q4, documentation: the live results above replace "unverified" for exactly the items listed there; the rest stays unverified.

## Phase 5 amendment: wire identity, `create_session` with a harness, web label (#1179)

Phase 5 puts the harness on the wire and lets a client ask a hub for a Codex or Claude session with arguments.
When it was written, nothing here had been run against a real Codex: every black-box test spawns the real `cli.ts`, hub and child daemons and a real WebSocket client, but the agents are fake `claude` and `codex` executables on a PATH of fakes plus `/usr/bin:/bin`, and the app-server is the stand-in; those tests are still what the suite runs.
LV-4 (a Codex session created from a hub request, in an already-trusted directory, reaches the prompt headless) then ran on 2026-10-04, partly: see "LV-4 results" below.
The prompt, the identity, a resume, the cold start and PATH resolution passed; `-a untrusted` failed (fixed in the follow-up); an approval card on a hub-created session, the Update and Trust modals through `remi attach`, `remi codex --host` from a second machine and the web label were NOT RUN.
Item 13 lists what was asked.

1. **Dual-emit, from one value.**
`hello_ack` (on the acks that carry the binding), `question` and the daemon's own session-list entry carry `harness` and `harnessSessionId`.
`createHelloAck` takes `binding: {identity, transcriptPath}` and `createQuestion` takes an `identity`, and each derives both ids from it: Claude's id is `claudeSessionId` AND `harnessSessionId` (a `hello_ack` keeps null on both), another harness's id is `harnessSessionId` alone and `claudeSessionId` is omitted.
A question or a list entry has no null: with the id unknown it names the harness and no id.
The Codex id is null on a `hello_ack` sent before `thread/started` and nothing depends on it, because answers are addressed by `questionId` and a client still echoes only `claudeSessionId` (the signaling Worker rebuilds an answer from a fixed list, so no client-to-daemon field was added; a Codex client sends none and `guardBinding` accepts that).
`CurrentOwnedSession` gained `identity` (from `identityOfRecord`, which `SessionBindingStore.getIdentity` now also calls; a record that names a harness this build does not know, or no record, falls back to the daemon's own harness with a null id, never to a guess at Claude).
`getIdentity` has two production callers, the session list (`session-events.ts`) and every question emission (`cli.ts`'s `getIdentity` for the message API); the issue named the first.
The Claude transcripts a daemon finds on disk (`source: 'transcript'`) are not decorated: the #1162 discovery test pins that they carry no identity, and absence reads as Claude (see item 11).
2. **`hello_ack.harnesses` on every ack, and the registry.**
`HarnessRegistry` (`harness/registry.ts`, neutral) maps an id to `{command, validateRemoteArgs, launchRefusal?, headlessNotice?}`; `cli.ts` builds it because the validators sit behind the import boundary.
A harness is offered when the registry has a spec for it and its command resolves on the PATH the process has NOW, in `HARNESS_IDS` order; `opencode` has no spec, so no daemon offers it.
The command is never run (a test makes it write a marker and checks it never does).
`Bun.which` reads the PATH the process started with and ignores a later change to `process.env.PATH` (checked on Bun 1.3.11 and 1.4.2), and every daemon changes it at boot (`resolveShellPath`), so the PATH is passed explicitly; a test points `process.env.PATH` at a directory after startup and would fail without it.
The list is read at each ack, so a command installed later is offered without a restart.
Every ack the production daemon sends carries it: the three in `connection-events.ts` (attached, query-mode, and the session-less one a hub sends) and both in `resume-session-events.ts`; `Connection`'s own ack (`connection.ts`, library consumers only, `skipHelloAck` is always set by the daemon) does not.
Codex is advertised by PATH presence (plan open call 17); LV-4 ran on 2026-10-04, partly ("LV-4 results"), and the owner may still want it gated.
3. **The trust boundary for a create request** (`checkHarnessRequest`, before a port is probed or anything spawned), in this order: a known harness id (`isHarnessId`), an adapter in the registry, its command on PATH (only when a harness is named: a request that names none keeps Claude's old behavior, a spawn that fails inside the child if there is no `claude`), `args` against that harness's remote allowlist, then for a named harness its older-daemon gate (`legacyWriterRefusal`, the Phase 3 text).
A refusal is `create_session_response{success:false, error}` and nothing spawned.
What the client reads is short and host-free (changed by the Phase 5 review, G8): the log, not the response, has the whole reason, escaped.
The child is started with the inherited flags, then `--harness <id>`, then `--` and the arguments, last (a request that names no harness appends no `--harness`; one with no arguments appends no `--`).
Claude's allowlist (`harness/claude-args.ts`, default deny, each slot once, at most 16 arguments of at most 256 characters, no NUL): `--resume`/`-r <uuid>` (lowercased), `--fork-session` only beside a resume, `--model <name>`.
(Changed by the Phase 5 review, H4: `--continue`/`-c` was on this list, from #1165 B, and was dropped.)
It is tighter than #1165 B in one place: the model name may not start with a hyphen, which the issue's pattern allows and which would let a flag stand in as the value.
`validateCodexRemoteArgs` (Phase 2) also allows `resume <uuid>`, so a hub request can ask for a Codex resume; the validators decide and the issue lists hub-spawned `resume` as out of scope, so this is allowed by the validator; LV-4 ran it headless against the real Codex ("LV-4 results").
(Changed by the Phase 5 review, H3: it allowed `-a untrusted` and `-s read-only` only, and the hub refuses a resume of a thread a live session holds before it spawns, H2. Changed again after LV-4: `-a untrusted` is not a Codex value, so it allows `-s read-only` and no `-a` at all, H3.)
4. **`explicitArgs`.**
`ParsedArgs.explicitArgs` is the tokens after the first `--` and nothing else.
`passthroughArgs` (Phase 3) is the wrapper's: strays and the `--` itself, which `validateCodexArgs` needs to tell a prompt from flags, and which would turn a hub's `-m x` into prompt text if a daemon read it.
A daemon passes `explicitArgs` to `createNewSession` (Claude) or to the local Codex validator (`remi codex --daemon`, whose "takes no arguments yet" refusal is gone); for Claude a stray word elsewhere is still ignored, so an existing LaunchAgent plist starts as before, while a loose word on a Codex daemon is refused (exit 2) and `--host` refuses one before sending (the Phase 5 review amendment below).
The hub validated the arguments with the remote allowlist and the child validates them again with the local one; a Claude child does not re-validate (a person running `remi --daemon -- <args>` is the principal, as for a wrapper).
5. **The sender and the mixed-version guard.**
`remote-new-client.ts` sends `harness` and `args` (`remi codex --host`, `remi new --host --harness codex`; the Phase 3 refusal of `--host` for a harness is gone) and only to a daemon whose `hello_ack` lists the harness (arguments with no harness are Claude's and need `claude` listed): an older daemon omits `harnesses` and would ignore both fields and start a plain Claude session, so the client refuses with "does not offer X; nothing was started".
The conformance is two-sided over both transports as far as each allows (ADR 0014): over the direct WebSocket the shipping sender (`createRemoteSession`) runs against a real `WebSocketAdapter`, and the real web `WebSocketClient` sends the factory's request to a real `WebSocketAdapter` in the conformance test; over the relay the shipping factory's request goes through `RelayAdapter`'s `createTransport` seam, labeled as the transport-seam test it is (#881: no real relay client exists).
6. **Resume.**
A `resume_session_request` to a daemon that hosts anything but Claude is answered `UNSUPPORTED` (`resume_session_response{success:false, errorCode:'UNSUPPORTED'}`, text naming `remi codex resume <thread id>`, the request never echoed) before any path runs; `harnessId` is a required dependency of the handler, like `hubMode`.
7. **The live-sessions entry.**
`LiveSessionEntry.harness?` (a string; absent means Claude): a Claude daemon writes none, so its entry is byte-identical to before (a test reads the file), and a Codex daemon or wrapper writes `codex`.
`couldBeClaudeEntry` excludes only an entry that names a KNOWN other harness; absent, `claude` and a harness this build does not know count, the fail-safe `claudeChildLooksAlive` already uses for a legacy entry.
Three readers use it, each with a test that fails when its check is removed: `TranscriptBinder.hasSiblingInDir`, the binder's stored-port reclaim check (`portClaimedByLiveSibling`) and `ForeignSessionEscalator.classifyOwnership` (its two signals read one filtered list).
No Codex-side reader of live-sessions entries exists (`ThreadTracker`'s sibling guard and `claimedByOthers` read the store, which is harness-aware through `isClaudeRecord`), so nothing needed the "a Claude entry must not count as a Codex one" half.
`isValidEntry` rejects a `harness` that is not a string like any other malformed field, which removes the entry.
8. **`resolveStoredSession`'s Codex branch is deleted**, with its three tests (the fallback on a thread id among Codex records, several Codex owners as an ambiguity, one active owner winning over exited history).
`opts.harness` is `'claude'` only, by type (a `@ts-expect-error` test) and by a runtime refusal for a cast around it; `SessionHarnessMismatchError`, the exact and prefix Remi id paths and the Claude fallback are unchanged.
9. **What a headless success does not say.**
`success` on `create_session_response` means the child daemon was spawned and registered, not that the harness reached its prompt (the same for Claude, which may sit at its trust prompt in an untrusted directory).
For a harness whose spec has a `headlessNotice` (Codex) the success carries an optional `notice`, built by the hub from the new session (changed by the Phase 5 review, G11).
Line one is the condition: Codex was started without a terminal, remi cannot tell whether it reached its prompt, and it may be waiting at an Update or Trust prompt, or may already have exited (the hub answers once the child has registered, before it launches Codex).
Line two is the way out, naming this session by the address `remi attach` accepts (`remi attach <host>:<port>/<id8>`; a bare `remi attach` takes the newest session, which may be another) with the hedge that this has not been checked against a real Codex.
The CLI prints line one only, since it attaches itself, and prints it escaped; the web client does not show the notice (no UI in this phase), and a refusal or a Claude success carries none.
Why the notice and not silence or `success:false`: the hub cannot know either way, and remi never types into a Codex PTY, so the only truthful words are the unknown and the way out.
`remi attach` reaching such a prompt is the claim LV-4 had to check, and it did not: no Update or Trust modal appeared in any launch, so the claim is still unverified and the notice's second line keeps its hedge ("LV-4 results").
10. **Web.**
`UISession.harness` is copied from `hello_ack` (an existing session's patch and a new one's entry) and from each list entry; a source pin reads the three copies in `App.tsx`.
`harnessLabel` (in `session-display.ts`, the single source for session display): `claude` and an absent harness are no label, `codex` is "Codex", `opencode` is "OpenCode".
The card and the chat header show a small chip beside the status pill; a Claude session renders markup identical to before (tested with the real components), and a Codex session differs by that chip alone.
The header's binding button still reads `claudeSessionId`, so a Codex session has none; the thread id is not shown anywhere (a label for it would carry its last eight characters, `shortThreadId`).
11. **Deviations from the issue and the plan, and contradictions found.**
- `harness/registry.ts` is new; ADR 0032 said the id-keyed registry arrives with the first caller that needs one, which is this.
- `create_session_response.notice` is a new daemon-to-client field the issue does not list (carry-over item (d)).
- The Claude model name may not start with a hyphen (item 3).
- The issue lists `cli/handlers/message-api-setup.ts`; the file is `cli/session-phases/message-api-setup.ts`.
- The transcript-discovered list entries carry no harness (item 1), against a literal reading of "dual-emit on `DiscoverableSession`".
- A Codex `hello_ack` used to carry `claudeSessionId: null` (through the Claude-shaped binding); it is now omitted, as the issue says; the Phase 3 characterization test reads it with `?? null` and stayed green.
- The Phase 3 test that pinned `remi codex --host` as an exit-2 refusal now pins that it asks the remote daemon (exit 1 with none listening).
- The plan's section 2.6 and the issue say a request carrying `resume` is out of scope; the Phase 2 validator allows `resume <uuid>` and was not narrowed (item 3).
- Plan open call 17 (advertise Codex only after LV-4) is not applied: availability is PATH presence, as the issue says; LV-4 has since run, partly ("LV-4 results").
- The plan's "exports with no production caller" rule: none in this PR; `SessionStore.findByHarnessSessionId` (Phase 2) had none and was deleted in the Phase 5 review (G14), with its tests; a lookup by thread id, if a later phase needs one, should return a list.
12. **Test changes to existing files, all disclosed in the PR:** `harness.test.ts` (the declared change: the factories no longer emit neither key), setup lines in `binding-protocol.test.ts` (the binding's shape), the new required dependencies added to each handler constructor in the existing tests, `message-api-setup.test.ts` (`getClaudeSessionId` became `getIdentity`), the `--host` test in `codex-launch-characterization.test.ts`, and the three deleted tests of item 8.
13. **What LV-4 had to verify (run live on 2026-10-04: the results are in "LV-4 results", below; this list is what was asked, as written before the run).**
(a) a Codex session created from a hub request in an already-trusted directory reaches its prompt with no terminal attached, learns its thread, and shows an approval card that the phone's answer closes;
(b) what Codex does headless at an Update prompt and at a Trust prompt in an untrusted directory, and that `remi attach` on the host dismisses them, so the notice's advice is true;
(c) that `-m`, `-a untrusted` and `-s read-only` are accepted by the real Codex as the validators assume (the spellings come from embedded help strings, never from a run; LV-4, by the exit code of `codex <flags> --help`: `-a untrusted` is REJECTED, the other two parse), and that `resume <uuid>` through a hub request works at all (the Phase 5 review narrowed the list, H3, and added items (g) and (h) below);
(d) that the daemon cold start (R2) works from a hub child with no terminal;
(e) that `codex` resolves on the hub's PATH after `resolveShellPath` to the binary the child runs;
(f) the web app's label on a real Codex session, and `remi codex --host` from a second machine;
(g) Claude's `--resume <uuid>` through a hub, and whether a resumed session keeps a permissive permission mode from its earlier life (the Claude half; unknown);
(h) the headless Update and Trust prompts, and `remi attach <host>:<port>/<id8>` as the way out of them.
14. **Receipts.**
Pins first, in their own commits, red where they pin new behavior: the additive-golden test (the four, later five, messages that gained fields keep every legacy field with its value, and the added fields are exactly the named ones), the black-box test of what a real Claude daemon sends (legacy keys unchanged, identity added), and the readiness-notice pins.
The golden diff is additions only (the parsed diff, checked by `protocol-fixtures-additive.test.ts`); three pre-existing lines show as changed in the text diff only because the last field of an object gained a trailing comma (`directory`, `daemonVersion`, `port`; the values are unchanged).
`macos-fixture-conformance.test.ts` is green, and the real Swift decoders were checked directly: the real `HubProtocol.swift` was compiled with `swiftc` and decoded the regenerated `hello_ack` golden, a Codex-shaped ack (no `claudeSessionId`, null `harnessSessionId`, `harnesses`) and the other four frames HubClient decodes; a synthesized `Decodable` ignores unknown keys.
Mutants, gates and the removed-line check are in the PR.

### LV-4 results (live, 2026-10-04)

This section sits here, with the Phase 5 amendment it gates, though the run came after the rework and round 2 below.
It records what was observed, as plain facts.
The open questions it raises are filed as issues, #1207 (a hub-created Codex session has no first prompt), #1208 (Claude's resume restores the earlier permission mode) and a comment on #1192 (the host's posture decides whether approvals appear, and a remote request cannot set the approval policy); no decision is written for them here.

The run was made by a spike agent against the owner's installed Codex 0.160.0 and Claude Code 2.1.289, with remi 0.7.16-dev.7 from the epic branch at ea25b980 (Phase 5 merged), on Bun 1.4.2.
The hub ran from source with an isolated `REMI_HOME`, with no relay and no mDNS, loopback only, on ports well away from the owner's own remi sessions.
The budget spent was 3 Codex turns and 1 Claude turn.
The shared Codex daemon was stopped before the run (its control directory held only the startup lock file and no Codex process) and stopped again afterward.
Before every key typed through `remi attach`, the screen matched none of the Update, Trust or modal markers and the composer placeholder was visible; no digit was sent.

Status per item of item 13 (the letters are that list's):

- **(a) A Codex session created from a hub request: PASS for the prompt and the identity; the approval card is NOT RUN.**
  A `create_session_request {harness: "codex", args: ["-s", "read-only"]}` was answered with success about 0.3 s after the spawn (the hub answers once the child registered, before Codex launches).
  The request was a raw one; no live run used the CLI sender (`remi codex --host`, `remi new --host --harness codex`) against a real Codex.
  The child ran `codex --no-alt-screen -s read-only` in a PTY with no terminal.
  `remi attach`, read only, showed the Codex banner, the directory and the composer, and no modal.
  The child's log shows `could not connect (attempt 1): the Codex control socket does not exist (yet)`, then the app-server version, `identity: thread` with the last eight characters of the thread id (`shortThreadId`), `Status: idle`, `thread/resume failed (code -32600); retrying` (no rollout before the first message, as in LV-2) and `attached to thread` after the first message.
  The child's `hello_ack` had `harness: "codex"`, a `harnessSessionId` equal to the thread id, no `claudeSessionId` and `harnesses: ["claude", "codex"]`; its session-list entry had `harness: "codex"` and `canResume: false`; the hub's own list was session-less with `daemonPorts`.
  `create_session_response.notice` was present for Codex and absent for Claude.
  Three turns raised no approval (observed).
  The host's configured posture in this run was `danger-full-access` with Codex's own "Approve for me" (observed in its configuration); that a plain session therefore never asks is an inference from those three turns.
  With `-s read-only` a write was blocked and the model did not escalate (observed).
  The approval card's JSON shape and its closing after a phone answer were therefore not observed for a hub-created session (they were observed live in LV-3 for a TUI-launched `remi codex`).
- **(b) The Update prompt and the Trust prompt: NOT RUN.**
  None appeared in any launch.
  One footer, `1 warning · f2 to view`, showed on every session, with or without remi's flags; it was not opened.
- **(c) Flags against the real Codex: FAIL for `-a untrusted` (fixed here); PASS (the flag parses) for the rest.**
  Codex 0.160.0 rejects `-a untrusted` with exit 2 (`invalid value 'untrusted' for '--ask-for-approval' [possible values: on-request, never]`).
  It was the only `-a` value the hub's remote validator allowed, so every remote request with `-a` produced a dead child, and the client saw "The session could not be started on the host; the host's remi log has the reason."
  The spelling had come from embedded help strings and was wrong for this value.
  `-a on-request`, `-a never`, `-s read-only`, `-s workspace-write` and `-m <model>` parse: the method was the exit code of `codex <flags> --help`, so clap read the flags, and none of `-s workspace-write`, `-a on-request` and `-a never` was run in a session.
  Through the hub, `-m` and `-s read-only` were accepted and the child came up; `-a on-request` and `-s workspace-write` were refused by the hub (H3), as designed.
  The fix: the remote allowlist carries no `-a` at all (H3, changed after LV-4).
  The startup failure was also opaque: the child's PTY output went to `NOOP_OUTPUT_SINK`, so only `exited with code 2` reached a log.
  Fixed here: a headless session keeps the first and last 1 KB of the child's output until it has named a thread, and logs them once when the PTY exits within about 10 seconds of the spawn (`startup-output.ts`).
  This line is the one exception to the log rule above (no cwd, no prompt, no full thread id), so it is redacted: every UUID-shaped token is cut to its last eight characters, and the session's directories and the home directory become `<cwd>` and `~`.
  It is escaped, on one line, capped at 4096 characters after escaping plus a `[cut]` marker when truncated, and cut nowhere inside a surrogate pair.
  After redaction it can still hold anything else Codex printed (a config excerpt, a URL, a prompt it echoed), and a path or id cut by the 1 KB limit can show as a fragment.
  A wrapper session captures nothing (its terminal already shows the error), and a stop or shutdown that remi asked for, or a session that has named its thread, logs nothing.
  The captured copy is only logged: an attached client reads the same bytes as raw PTY frames, by design, and a test pins that it receives them once and that no other message carries them.
  `resume <uuid>` through a hub request: PASS (item 13 (c), second half).
  It was refused with the H2/P4 text while a live remi session held the thread; after that session stopped, the same request resumed headless, with the same thread and the earlier turns replayed and no model turn.
- **(d) The daemon cold start (R2) from a hub child with no terminal: PASS.**
  With the daemon stopped, the child came up and the client connected after its first attempt failed, as the log lines in (a) show.
- **(e) `codex` on the hub's PATH: PASS.**
  The hub-spawned child ran the same Codex binary the owner's login shell resolves, and `resolveShellPath` with a minimal LaunchAgent-like PATH resolved `codex` and `claude` to the same real paths.
- **(f) The web label and `remi codex --host` from a second machine: NOT RUN.**
- **(g) Claude through a hub: PASS for the spawn and for `--resume <id>`.**
  The spawn carried no `harness` field, the entry read `harness: "claude"`, and `--model` worked.
  Refused as designed: `--permission-mode`, `--continue`, and `--resume` of an id a live session holds.
  A session started directly with `--permission-mode acceptEdits` and then resumed through the hub with `--resume` came back in `accept edits` mode, although the hub child's arguments named no mode and the account default differs: Claude restores the session's earlier mode on resume.
  That was seen with `acceptEdits` only; `bypassPermissions` was not tried.
  A `resume_session_request` sent to the hub is UNSUPPORTED, as documented (#1124, #1129).
- **(h) The headless Update and Trust prompts, and `remi attach` as the way out: NOT RUN.**
  No modal appeared, so `create_session_response.notice`'s sentence that `remi attach` lets the user answer an Update or Trust prompt is still UNVERIFIED and keeps its hedge.

NOT RUN, listed once so nothing is read as passed: an approval card on a hub-created session; the Update and Trust modals through `remi attach`; `remi codex --host` from a second machine; the web label.

What the run showed, as facts and not as decisions:

- A hub-created Codex session has no first prompt by construction: a remote request's `args` may not contain `--`, and phone chat to a Codex session is refused (W1), so the first turn needs a person at the terminal or at `remi attach`.
- The host's Codex posture decides whether any approval appears at all: with `danger-full-access` and "Approve for me" nothing asks, so no approval reaches the phone without a host configuration that asks.
  A remote request with no arguments inherits that posture; H3 lets a request only tighten it, and the only tightening Codex 0.160.0 takes from a flag is `-s read-only`.
- On a cold start the Codex TUI itself started the shared daemon, not remi.
  The control socket appeared as a symlink to a socket in a per-user temporary directory; `codex app-server --listen unix:// --managed-daemon` and `codex app-server daemon pid-update-loop` both had the TUI as their parent, each in its own process group, so both outlived the TUI and the remi child.
  The child's argv has no `--remote`.
- `codex app-server daemon stop` stops the app-server but leaves its `pid-update-loop` helper running, with parent pid 1, until it is killed by pid.
  That is Codex's own behavior, recorded here as a fact and not filed.
- Claude restores the earlier permission mode on `--resume` (seen with `acceptEdits`), as (g) says.

### Decisions recorded in the Phase 5 review rework

Two fresh reviewers (the wire and trust boundary; the daemon wiring, tests and docs) found no critical defect: `--` is last in the only spawn path, both remote allowlists are default deny with no bypass found, the goldens are additions only, every ack carries `harnesses`, and Claude's paths are unchanged.
They found real work, G1 to G18, and the lead decided H1 to H5.

- **H1, Codex stays advertised by PATH presence.**
There is no opt-in switch: the PR targets the epic branch, nothing reaches users from it, and LV-4 is a HARD gate on merging the epic.
If LV-4 shows trouble, the lead gates the advertisement then (LV-4 ran on 2026-10-04, partly; "LV-4 results" says what it showed and what it did not run, and the decision stays the lead's).
- **H2, a remote Codex `resume <uuid>` stays in the validator, and the hub refuses a held thread.**
It fails closed, it is the Phase 2 capability and it has tests; it was unverified headless when decided, and LV-4 then ran it ("LV-4 results").
The hub refuses a thread a live session already holds BEFORE it spawns; before, the child refused and the client saw only "Daemon process exited unexpectedly".
(Changed in round 2 of the PR review, P4: the client reads a generic text, "That Codex thread is already open in a live remi session on the host", with no id and no port, because the first rework's text named another session's first eight id characters and its port; the hub's log has the holder, escaped. The person running `remi codex resume` at the machine keeps the full text, with an address they can paste into a shell, `remi attach localhost:<port>/<id8>` (P9), since a `<host>` placeholder is a redirect there.)
- **H3, a remote Codex request may only tighten the host's posture.**
`-s read-only`, `-m` and `resume <uuid>` are allowed, and `-s workspace-write` and `-a` in every form are refused remotely.
A remote client must not loosen what the host chose, as Claude's allowlist leaves out `--permission-mode`; widening needs a person at the terminal, where `remi codex` still allows `-s workspace-write` and `-a`.
(Changed after LV-4: H3 first allowed `-a untrusted`, as the one value that asks for every command. Codex 0.160.0 rejects it with exit 2, since `--ask-for-approval` accepts only `on-request` and `never`, so every remote request with `-a` produced a dead child. The lead's decision: the remote rule is now no `-a` at all, any value, because neither accepted value can be shown to tighten a posture remi cannot read, and the host's own configuration may already be stricter than `on-request`. The refusal says why. `REMOTE_APPROVAL_POLICY` is removed. The local validator still passes `-a` through unchanged, a person at their own terminal, and Codex reports its own error for a value it does not take.)
- **H4, the Claude allowlist drops `--continue`, which amends #1165 B's list.**
The launch injects `--session-id` for a session with none of its own (`claude-binding.ts`), and Claude Code very likely rejects `--session-id` beside `--continue` unless `--fork-session` is given; unverified, so it fails closed.
`--fork-session` is refused unless a `--resume <uuid>` is also present, for the same reason.
`-r/--resume <uuid>` and `--model` stay. `--resume` through a hub was unverified when decided; LV-4 ran it, and a resumed session came back in the permission mode of its earlier life ("LV-4 results").
- **H5, the older-daemon gate in a hub-spawned child excludes its parent hub.**
With `REMI_SPAWNED_CHILD=1` the gate also excludes `process.ppid`: the hub started the child from its own command, so it is the same build, but a version that does not parse (a PR-stamped build, which AGENTS.md recommends for test builds) read as older and the hub refused its own child.
(Superseded in round 2 of the PR review, P1: any SIBLING of the same PR-stamped build tripped the gate too, so a Claude session created from the phone made the next Codex create fail with a false "an older remi is running", which blocks LV-4.
The gate now takes `ownVersion` and skips a record whose version string is exactly the daemon's own, since the same build has the same shim; the one assumption is that a version string identifies a build, which fails only for two different builds stamped with the same string.
H5's pid rule is dropped as redundant: the parent hub is of the same build, so it is covered, and a pid rule would also have skipped a parent hub of a genuinely older version.
A record with no version, another version that does not parse, or a lower parsable version is still a writer.)

What the review changed, one line each (the commit of each is in the PR):

- **G1.** The exclusion above, with a hub test that starts a Codex child under a hub whose version is `0.7.16-p1204.1`.
The child's own refusal text is not relayed to the client: it holds pids, files and paths, which G8 keeps off the wire, so a child that exits in its preflight shows the client the short "could not be started" text and the full text is in the host's log.
- **G2.** `remi codex --host` and `remi new --host` refuse a word that is not after `--` (exit 2, nothing sent, the words named), for Claude too: the host's own defaults would otherwise apply with no warning.
- **G3.** `remi codex --daemon` refuses a loose word (exit 2) again, with a message that says the arguments go after `--` (the Phase 3 text, "takes no arguments yet", stopped being true); a Claude daemon still ignores loose words.
- **G4, G5.** The allowlists as H3 and H4 say, UUIDs lowercased in both, and the mutants that survived are pinned: the leading anchor of the UUID pattern, case folding of flag names, `--continue` by name, a model name keeping its case.
- **G6.** The hub-side refusal of a held thread (H2), with the client text of P4.
- **G7.** The `directory` of every create request is refused when it is not a string, starts with a hyphen (a child would re-parse it as a flag), or holds a control character (round 2, P3: any C0 control, DEL or C1 control, where the first round had only NUL, newline and carriage return, so an escape sequence passed), and the hub's log lines that carry it are escaped; this also covers the plain Claude request, and no real client sends such a value.
- **G8.** The client reads short, host-free texts: the older-daemon gate says an older remi is running and to update or stop it, a failed spawn says only that the session could not be started, and the pids, files, paths and the failure go to the hub's log.
- **G9.** The session-less ack of a daemon that is not a hub names its `harness` alone, so a Codex daemon never reads as Claude by an absent field; a hub, which hosts nothing, names none.
- **G10.** Everything a daemon sends that the CLI prints is safe to print: errors and the notice are escaped (`escapeUnsafeText`; round 2, P2: a field that is not a string reads as a fixed fallback and `harnesses` counts only as an array, so no JSON a daemon sends can throw inside the socket handler), and a success whose session id is not a UUID or whose port is not an integer from 1 to 65535 is refused (both are printed and the port is attached to), which the reviewers did not name and which I found while checking the claim.
- **G11.** The notice as item 9 now says.
- **G12.** The messages a Codex session sends itself name `remi attach` with this session's address when the session was not launched with a terminal (`TerminalWords`), and keep the terminal wording for a wrapper session; the missing-thread notice also names an Update or Trust prompt.
- **G13.** The web label shows a harness this build does not know as its own name, cut to 16 characters with control and bidi characters written out.
- **G14.** `SessionStore.findByHarnessSessionId` is deleted with its five tests: it had no production caller and its throw on two exited rows is wrong for any lookup a caller would make.
A later phase can add a lookup that returns a list.
- **G15.** The transport adapters' `sendQuestion`, which built a question with no identity and which nothing called, is removed; a source scan pins that every `createQuestion` call in the daemon passes an identity, so the claim that one value produces both ids holds for every path.
- **G16.** `create_session_request_plain.json` is a second golden, the pre-Phase 5 request, beside the registry fixture that became a Codex request; the golden diff stays additions only.
- **G17.** `--harness` is no longer called hidden, `new --host` help says what the `--` rule is, and comments say that `Connection`'s own ack never reaches a client in production and that a discovered transcript carries no harness because absence means Claude by construction.
- **G18.** This record, and the list of what is still not verified.

What was still not verified, for LV-4, when the rework was written (G18; item 13 has the rest; the outcomes are in "LV-4 results": (a) PASS, (b) PASS, with the earlier permission mode restored on resume (`acceptEdits` only; `bypassPermissions` not tried), (c) NOT RUN, (d) `-a untrusted` REJECTED, `-m` and `-s read-only` parse):
(a) a remote Codex `resume <uuid>` headless;
(b) Claude's `--resume <uuid>` through a hub, and whether a permissive permission mode carries over;
(c) the headless Update and Trust prompts, and `remi attach` as the way out;
(d) `-m`, `-a untrusted` and `-s read-only` accepted by the real Codex as the validators assume.

### Decisions recorded in round 2 of the PR review

A fresh re-review found no critical defect, confirmed the first rework's fixes (its own fuzz of both remote validators, 169 thousand inputs, found no loosening), and found one important gap and a few smaller ones (P1 to P10).

- **P1, the older-daemon gate and a PR-stamped build.**
See the note under H5 above: `ownVersion` replaces H5's pid rule.
- **P2, the sender reads any JSON.**
Daemon text is escaped only when it is a string; the notice is kept only when it is a string; `harnesses` counts only as an array.
- **P3, control characters and logs.**
`directoryRefusal` refuses any C0 control, DEL and any C1 control, and the hub's log lines that carry the directory write it escaped.
- **P4, a generic client text for a held Codex thread**, with the holder and its port in the hub's log (the note under H2 above).
- **P5, `--resume` with `--host`.**
`remi new --host h --resume X` (and `remi codex --host h --resume X`) is refused with exit 2 before any local lookup, and says to put it after `--`: `parseArgs` consumes `--resume` as a remi flag, so it is not a loose word, and the Claude path used to look the id up in the LOCAL store (or, if a local session held the id, start a fresh remote session with no warning), the silent-drop class of G2.
- **P6 to P8, small ones.**
Three doc statements corrected (`--harness` is not hidden, the directory rule, the help's unverified label for `--resume` through a hub); the `FIXTURE_VARIANTS` block no longer sits between a doc comment and its const; and the G15 source scan now reads every `.ts` file under `packages/daemon/src` for `createQuestion`, however it was imported, and refuses a literal `undefined` or `null` identity, a spread, an alias, a re-export and a use as a value (synthetic offending source for each shows the scan can fail).
- **P9, the local held-thread text** names `remi attach localhost:<port>/<id8>`; `<host>` stays only in the hub's notice and in the messages a headless session sends its clients (`TerminalWords`), where it is a placeholder, and the notice adds that the address works from a machine that can reach that port (it does not through a single-port SSH tunnel or the relay).
- **P10, a Claude `--resume` through a hub is refused when a live session holds the id** (a judgment call, decided): the Claude allowlist returns the session it names, the check runs whether or not the request names the harness, the client text is generic ("That Claude session is already open in a live remi session on the host"), the holder is in the log, and `START_FAILED_TEXT` stays opaque.
Claude `--resume` through a hub was still unverified against a real Claude then; LV-4 ran it ("LV-4 results").

- **P11, a flake in our own test.**
The fake `claude` and `codex` wrote `argv` with a shell redirect, which creates the file empty and fills it as the loop runs, so a test that waited for the file to EXIST read half the argument list (seen on Bun 1.3.11).
The fakes now write `cwd`, `pid` and `argv` under temporary names and rename them into place, `argv` last, so a reader that sees a file sees all of it; `waitForRecordedArgv` is the one waiting helper, and `FAKE_AGENT_RECORD_DELAY` lets the helper's own test make the old race certain.
The same race was in two Phase 3 tests, `codex-session.test.ts` "spawns codex --no-alt-screen with the validated arguments after it" and "a prompt is passed after --, and a resume as the subcommand last", whose fake wrote `argv` with a redirect; they are fixed in the follow-up to round 2 (Q1): that fake now uses the shared recorder (`RECORD_FILES`, `WAIT_FOR_RELEASE`) and the two tests wait with `waitForRecordedArgv`, proven by a fake that pauses between arguments.
The other Codex tests were read for the pattern and are safe as written: the launch characterization fake writes its files in sequence with `pid` after the others and `stdin` after `pid`, its waits need both, and a test pins that order; the first-answer-wins fake creates only an empty `stdin` counter, which is complete when it exists.
Q2: `startHub` in the hub test now cleans its isolated directories and the fake app-server when `spawnHub` throws, and `spawnHub` kills a hub that is still running when its readiness wait ends.
A second flake of the same run, found by the twenty-run loops and the fresh-clone Bun 1.3.11 verification: `hub-create-session.test.ts` failed once in twenty with "Hub exited early with code 1", because the hub could not bind the port `findTestPort` gave it.
`findTestPort` hands the lowest free port from 19200 to every caller, so a second test process on the machine (another worktree's run, another agent's) can be given the same one; the same collision failed `hub-lifecycle.test.ts` twice in one full run, tests this PR does not own.
`spawnHub` now takes the port as an option and puts what the hub printed in its early-exit error, and this PR's hub test takes a random, probed port from `reserveRange`, as `spawnDaemon` already does.

## Phase 6 amendment: turn events and chat (#1180)

Phase 6 pushes how a Codex turn ended and serves the Codex session's chat.
The automated tests do not launch Codex: they use captured frames, the stand-in app-server and test doubles for cases not captured. A bounded live LV-5 check ran on 2026-10-05 against Codex 0.160.0, GPT-6.1-Sol and one controlled account. Item 9 records the evidence and its limits. No physical iPhone or APNS delivery was tested.
Items 12 to 15 record the review rework of PR #1209 (two fresh reviewers, no critical finding).

1. **One sink for both harnesses.**
`createTurnEventSink` (`notifications/turn-events.ts`) holds what `cli.ts`'s `onTurnStop` did inline: the `turn_complete` gate (`shouldNotifyTurnComplete`), who wants the push (`tokensWanting`), the text and the fan-out, plus `turnFailed` and `turnSucceeded` for the `turn_failed` notice.
It is built once in `cli.ts` and reads the config, the devices, the signaling endpoint, the push secret and the session name when a turn ends, never when it is built.
Claude's half is `createClaudeTurnStop` (`notifications/claude-turn-stop.ts`), which `cli.ts` registers as the second `Stop` listener (`onTurnStop`): the #914 session filter FIRST (an early return, so a sibling's Stop neither reads nor clears this session's timer mark), then the turn's elapsed time from the timer and the mark's clearing (a re-entry keeps the mark), then `turnCompleted`.
It is built from the harness's filter, the turn timer, the primary session id and the sink, so a test runs it with the real timer and the real sink; before the review it was a function inside `cli.ts` that only source pins could reach, and mutants of the elapsed time, the unbound session's title, the re-entry flag and the filter order survived.
Claude's `StopFailure` wiring (`createTurnFailedRoutes` from the hook bridge, `ClaudeLaunchDeps.pushTurnFailed` and `dismissTurnFailed`) is unchanged; the sink calls the same function over the same map (`createTurnFailedRoutes(sessionNotifiers)`) for the failure it is handed, and the routes' `push` gained an optional agent name.
`buildTurnFailedText`, `NotificationDispatcher.pushTurnFailed` and the routes take an `agentName` that defaults to `Claude`, so a failed Codex turn reads "Codex stopped" and no Claude test changed.
One placeholder keeps the old behavior exactly: the handler passes `getPrimarySessionId() ?? 'unbound'` as the session, which the sink titles "Agent", as the inline code did before a primary id existed (`onHarnessDenied` uses the same idiom).
2. **The turn mapping** (`codex-turns.ts`, fed every notification of the app-server by the session).
Only a `turn/completed` of the session's own thread counts (`ThreadTracker.role` is `main`); a subagent's turns end many times inside the main turn and another window's thread is not this session's.
A turn id that was already announced is not announced again (the last 64 are remembered; an id over 200 characters is treated as no id; a turn with no id cannot be told from a repeat, so each is announced): nothing shows that Codex repeats a `turn/completed`, but a re-attach must not push twice if it does.
`completed`: `turnCompleted` with `elapsedMs = turn.durationMs` (unknown unless a finite number of at least zero) and `lastAssistantMessage` the text of the LAST `agentMessage` whose `phase` is `final_answer`, then `turnSucceeded`.
`failed`: `turnFailed` with `agentName: 'Codex'`, `turn.error.message` as `errorDetails` (when it is not blank) and `codexErrorInfo` as `error` only when it is a string; the object variants (`httpConnectionFailed` and the like) carry no single code, so they read "Unknown error" plus the message.
A failed turn carries no earlier answer (`TurnFailedEvent` has no such field since the review: nothing set it).
`interrupted`: `turnSucceeded` only.
Any other status (`inProgress`, a status a newer Codex adds, a missing one) is logged WITHOUT its value and does nothing.
The sink applies the same gates as for Claude, and a failed turn is never muted by `on_turn_complete`.
3. **Decisions inside that mapping.**
A turn with no `final_answer` message has nothing to show, so it is silent, as an empty `last_assistant_message` is for Claude; a message with `phase: null` is "unknown" (the schema says callers must treat it so) and is not guessed to be final. LV-5 saw a `final_answer` on the sampled model only; it does not establish behavior for other models or for a model that sends no phase.
Since the review a completed turn with no final answer logs ONE line without content, naming the turn's `itemsView` when Codex gave one of its three values, so that silence is not a mystery.
An answer made only of removed characters, whitespace or zero-width joiners also has nothing visible to show: no push and one content-free log line.
An interrupted turn is not announced.
That Codex reports a turn ended by the phone's No (`cancel`), by Esc or by `turn/interrupt` as `interrupted` is an ASSUMPTION: no recorded frame shows it.
The spike's decline run answered `decision: "decline"` (`expA-decline.jsonl:65`), which is not what the phone's No sends (`cancel`), and its `turn/completed` says `completed` (`:141`); live step LV-3 (c) saw the item declined and the turn "interrupted" on the TUI, not the frame.
A `turn/started` does not clear a stale failure notice (Claude's `UserPromptSubmit` does); the next completed or interrupted turn does.
A turn that ended while remi was not attached, before the first attach or while the link was down, is never seen: it pushes nothing, and a stale "Codex stopped" stays until the next completed or interrupted turn.
4. **The chat seam.**
`HarnessChat.readHistory(emit): Promise<number>` and `HarnessSession.chat?` (`harness/types.ts`); the transcript handler takes an optional `chatFor(remiSessionId)` and asks it BEFORE any file lookup, so a transcript file that happens to bear the id is not read in its place.
It streams what the chat emits to the requesting connection, then sends `transcript_load_complete` with the count the chat returned and the request id, or `LOAD_FAILED` when the read fails (what was sent before stays sent; a synchronous throw is the same failure).
A send to the requester that is refused (its connection is gone) ends the read at once, with no error sent to a dead connection, so no page more is asked for on its behalf.
Claude's sessions have no chat and take the transcript-file path unchanged.
5. **History** (`codex-chat.ts`) is `thread/items/list {threadId, sortDirection: 'asc', limit: 100, cursor}`, oldest first, following `nextCursor` until it is null, each page emitted as it arrives.
The schema (`ThreadItemsListResponse`: `data` of `ThreadItemEntry {turnId, item, startedAtMs, completedAtMs}`, `nextCursor`, `backwardsCursor`) is the only evidence of the response shape; a page with no `nextCursor` key reads as the last page.
The read builds its own MessageAPI, so it adds nothing to the session's message stream; the same item twice in one read is emitted once.
It is bounded: a cursor that comes back, ANY earlier one and not only the last (A, B, A ends at the third request), ends it, and so do 1000 pages (the constant, pinned without a seam by a server that never ends); both are logged.
An explicit read also stops after 60 seconds, checked after each non-final page: an in-flight request can exceed that deadline up to its own 15-second timeout; a waiting read does not inherit the running read's failure.
One explicit read of a session runs at a time with one waiting (two phones that connect together both ask for the history, and both are served), and a third is refused with a clear error (a client that asks in a loop is not queued without end).
"no rollout found" (code -32600, the text `thread/resume` answers before the first message, LV-2) on the FIRST page is an empty history; the same text on a later page, and every other failure, is a `CodexHistoryError` whose text carries the code and none of the server's words (they may name a thread or a path, and the handler logs and sends the message).
A page that is not a page (no `data` list, a cursor that is a number or empty) is an error and never an empty history; an entry of a page that is not an object with an `item` is skipped.
A session that has not learned its thread has no history and asks nothing.
6. **The mapping of an item** (shared by history, the catch-up and live).
`userMessage` is a user message (its `text` parts joined by a newline; the type tag decides, never a `text` field on another part); `agentMessage` is an assistant message, commentary and final answer alike (the TUI shows both); a finished `commandExecution` is an assistant tool entry named `shell`: `tools: ['shell']`, no text, the structured message `Used shell` (as Claude's tool-only entries read), a `tool_use` block with `{command}` and a `tool_result` with the output, both cut to 500 code points (whole characters, unlike Claude's code-unit cut) and THEN written out with every control, invisible and bidirectional character visible (`escapeUnsafeText`, cut first and escape after, as the Phase 4 cards do, so the cut never lands inside an escape; the input stays valid JSON), and `isError` for `failed`, `declined` or a non-zero exit.
One still `inProgress` is skipped: its completion arrives live, and a client keeps the first copy of an entry it sees, so sending it early would hide its result.
`reasoning`, plans, hook prompts, file changes, tool calls, blank and image-only messages and any item type remi does not know are skipped.
The entry id is the item id, so a history read, a catch-up and a live frame of one item carry the same `entryUuid` and a client drops the second.
Message PROSE (a user's or the agent's text) is deliberately NOT escaped: it is shown as the model or the person wrote it, and escaping would break an emoji sequence at its zero-width joiner (U+200D), which `escapeUnsafeText` writes out.
Claude's transcript bridge shows Claude's text the same way, and Claude's `last_assistant_message` in a `turn_complete` push has the same exposure to control and bidirectional characters today; that is not changed here and is left to its own issue (the lead files it).
Message text is not bounded (as Claude's is not); the push text is.
7. **Live and the catch-up.**
Each `item/completed` of the main thread goes to every client through the launch context's `sendAndRecord`, structured by the session's own MessageAPI as Claude's binder does (so the structured agent output goes out too), once per item (the last 1024 ids are remembered; an item is remembered only after its send succeeded, so a failed send is tried again if the item is delivered again).
A subagent's items and another window's are not this chat.
What completed BEFORE remi attached is never announced live: item and turn frames reach only the connection that is attached (`expA-accept.jsonl`: the second connection never receives the first `userMessage` `item/completed` or `turn/started`), so the first prompt of every new thread, and anything between a drop and a re-attach, would be missing, and the web client asks for history only when it has no messages while the daemon's replay usually makes it have some.
The hold starts BEFORE `thread/resume` is sent (`ThreadTracker.onAttaching`), so an item in the same socket chunk as the resume response is held before the attach callback runs; a failed attach releases the held items in arrival order unless a catch-up is still reading.
After each successful attach (`ThreadTracker.onAttached`: the first attach, a retry, a reconnect, a rotation), the session calls `catchUp`: ONE page requested with `limit: 100`, a 3-second request timeout and a hard limit of 100 raw returned entries, including non-chat or malformed entries.
Only a complete thread within that bound is delivered; an oversized page, a continuing cursor or a repeated cursor is skipped with one content-free line and left to an explicit read.
Catch-up entries go through a MessageAPI of their own as `transcript_content` ONLY: the web client renders the structure inside that message, and an additional structured output would double the replay and fan out one Telegram message per entry.
Live items are held up to 256. On overflow the held queue is flushed in arrival order, then the overflowing item; the collected history is discarded, logged without content, and left to an explicit read.
That abandonment lasts until the whole hold ends, including any follow-up read or attach spanning it; a later separate attach can start a fresh catch-up.
When the tracked thread rotates during a read, its collected history is skipped with one content-free line; held items are filtered by their current role, and a follow-up read catches up the new thread.
Each read times out after 3 seconds, but another attach may keep the hold for a follow-up read; repeated attaches have no overall hold deadline, and overflow still bounds the held queue.
A failure never breaks the attach; a reconnect sends nothing twice (the last 1024 delivered ids are remembered); requests during a running catch-up are coalesced into one follow-up; and disposal drops both held and collected items before they can build either transcript or structured output.
A failed live send keeps its built message for retry (the last 64), so it does not rebuild and duplicate the structured output.
Item ids over 200 characters are rejected before becoming chat; unlike a turn without a usable id, such an item is not shown.
Typed chat stays refused (`acceptsTypedChat: false`): Phase 6 gives Codex a chat to read, not one to type into.
8. **Boundary, as allowlists.**
`CODEX_MAY_IMPORT` gains `api/message-api` (the history's bullet structurer) and `notifications/turn-events`, which a new test pins as imported only as a type by every Codex module; the debt list is unchanged.
9. **LV-5 live evidence and limits** (redacted capture: `packages/daemon/tests/fixtures/codex-app-server/lv5.jsonl`; index provenance marks reasoning-item strings redacted).
(a) Two real `thread/items/list` requests used `sortDirection: "asc"` and `limit: 100`; both responses had `data` entries with `turnId`, `item`, `startedAtMs`, and `completedAtMs`, plus `nextCursor` and `backwardsCursor`. One page held the controlled first prompt and its `final_answer`; a second held six rows. A separate ascending `limit: 1` check on the same owned thread followed the returned cursor from a `userMessage` page to an `agentMessage` page and ended with `nextCursor: null`; those request/results are private receipts and are not in `lv5.jsonl`. Larger histories were not checked.
(b) Before the first user message, `thread/items/list` returned -32601 and `thread/resume` returned -32600; after the first write both worked. The list error is specific to this method and state, not evidence that the app-server generally lacks the method.
(c) Those two pages from this GPT-6.1-Sol/account sample had no injected environment or instruction message; this does not establish a model-wide rule.
(d) A local WebSocket protocol client exercising the daemon phone-No path, a real TUI Esc and `turn/interrupt` each produced `status: "interrupted"` (24638, 15572 and 12091 ms). The first interrupt attempt returned -32600; a retry after the turn started succeeded. A bad-model turn reported `failed` after 243 ms with `codexErrorInfo: "other"`, the captured message, and null `additionalDetails` and `misalignment`.
(e) The observer received one `turn/completed` for each of five subscribed turns: one long completed, three interrupted and one failed. The first minimal completed turn preceded observer subscription. Only the sampled model/account was checked; no general once-per-connection or no-`final_answer` claim follows.
(f) The long turn's `durationMs` and observer wall time were both 66965 ms; it ran `sleep 61`, not a CPU workload.
(g) The command `item/completed` id appears exactly once in the second captured list page.
(h) Initial-attach event ordering was not measured. A later successful resume catch-up delivered ten `transcript_content` entries including the first prompt exactly once and no `structured_agent_output`.
10. **Deviations from the plan.**
`parseTurnCompleted` and `parseThreadItem` live in `thread-protocol.ts` (the plan listed no parser file); the history error is a `CodexHistoryError` (the plan said nothing of error text); the turn sink's `config` dependency is `{onTurnComplete, turnCompleteMinSeconds}` read per event; `startDaemon` in the characterization test takes optional extra arguments; the history is bounded (the plan had no bound); and Claude's `onTurnStop` is extracted into `createClaudeTurnStop` (the plan left `onTurnStop` in `cli.ts` and said it keeps its filter and timer lookup).
The plan's mapping of `completed` said "`lastAssistantMessage` from the `agentMessage` with `phase:'final_answer'`": the last one is taken when there are several.
`TurnFailedEvent` has no `lastAssistantMessage` (the plan's signature had one; nothing set it).
The plan estimated about 470 source lines.
At Phase 6 head `99c725db`, measured against the Phase 5 follow-up base `7a2e8c2e`, in `packages/daemon/src`: +1564/-106 lines (1458 net), and +944/-55 (889 net) excluding blank lines and lines whose trimmed text starts with `//`, `/*`, `*` or `*/` from `git diff --unified=0`.
This is a line-count estimate rather than a parser-based code count; the largest block is `codex-chat.ts` (history, catch-up and read limits), not the parsers.
11. **Receipts.**
Pins first, in their own commit, red (the modules did not exist): the sink and the `onTurnStop` and `cli.ts` source pins, the Codex mapping on the real `turn/completed` frames (`expA-accept.jsonl:74`, `expA-decline.jsonl:141`), the chat on real items through the real client and the stand-in app-server, the `chatFor` seam, and the session wiring.
The earlier review rework used red pin commits before changes that altered behavior.
The final hard 100-entry regression was reproduced before its fix and committed with the passing fix.
Mutants of the new logic were applied to a committed tree, each run with `bun test --bail` and reverted with `git apply -R`; the PR lists each with the test that kills it.
"Of the new logic" is the claim: the wiring lines in `cli.ts` are reached by source pins and by the black-box daemon tests, and the mutants of the lines those tests cannot see (the exact-string pins would survive a reformat that keeps the text) are not claimed.
The first run was 125 mutants (the five the plan names, the `admitsAnySession` filter removed from `onTurnStop`, the wrong `final_answer` item, `interrupted` pushing, `failed` not pushing and the history order reversed, among them); seven survived at first and each was pinned: five edge cases of the two parsers, an unparsable `turn/completed` that was not logged, and a history page with no `nextCursor` key.
The review rework added 86 more for its own code, and five of those survived at first and were pinned (a tool output escaped before its cut, the explicit-read slot never freed or its waiting flag never cleared, a catch-up asking for a session with no thread, and a turn with no id taken for one whose id is the word null).
At that review run none survived, and none was judged equivalent; those counts describe that recorded run, rather than a fresh run of every mutation on a later head.
12. **Review rework: what the reviewers found and what changed** (PR #1209; the commit of each is in the PR's disposition table).
Important: (1) the Claude hand-off to the sink was weakly pinned, so it is extracted and tested with the real timer and sink, and the black-box daemon now carries a push secret and a non-default session name and checks the log line and a refused push; (2) `remi codex --help` said turn notifications do not reach the phone, so it now says they are pushed and the history is read-only; (3) the interrupted-status evidence was misdescribed (item 3); (4) the live chat missed everything completed before the attach (item 7); (5) control and bidirectional characters in Codex-chosen text reached the push and the chat unescaped (item 13).
Suggestions, all applied: a repeated `turn/completed` is dropped by turn id; dead code removed (`TurnFailedEvent.lastAssistantMessage`, `CodexHistoryError.code`); the history limits of item 5; the content-free log for a silent completed turn; the missed-turns sentences; the LV-5 lists made to agree; the docs wording and the size claim; one shared `describeError` and an honest name for the log-privacy test.
13. **What Codex chose is made safe before it leaves remi** (`harness/codex/safe-text.ts`).
`boundedEscape` writes every character of `escapeUnsafeText`'s set as visible text and cuts to a bound AFTER counting the escapes, character by character, so a cut never leaves a fragment such as `\u20`; a failure's details are bounded to 140 (what the push shows of them) and its code to 40.
`pushProse` removes the same set from the final answer in a `turn_complete` push (no use for an escape sequence, a bell or a bidi override in a notification) EXCEPT the zero-width joiner, so an emoji sequence survives; only the first 4000 characters are read.
Tag characters (U+E0020 to U+E007F) are removed, so subdivision-flag emoji lose their tags.
`boundedEscape` reads lazily at most the bound plus one code point, rather than materializing the whole frame.
The Codex failure text reads like Claude's: the string `codexErrorInfo` values with a clear reason have phrases (`usageLimitExceeded` is "Usage limit reached"; new keys only, the documented Claude codes' phrases are unchanged), any other is shown as is, and Codex's own words follow.
14. **Considered, not changed** (reasons in the PR).
Binding the sink to one session (`forSession(id, agentName)`): the plan passes `sessionId` per event, a daemon runs exactly one harness, `hookServer` is null in Codex mode and `codex-turns` fixes both values; revisit if a daemon ever hosts two harnesses.
Exact-string source pins in `cli.ts`: the repo's idiom, Biome formatting is deterministic, and the black-box tests sit next to them.
Claude's `turnCompleted` device-list refresh (#690) differing from `turnFailed`'s is pre-existing and filed separately.
15. **Unchanged by design.**
`thread-tracker.ts` keeps its own `describeError` (it also reads an RPC error's code).

16. **Round-2 rework.**
The corrected behavior is in items 2, 3, 5, 6, 7 and 13: disposal drops both output types, the hold begins before resume, overflow preserves live arrival order and abandons old history, rotation skips old-thread history, catch-up is transcript-only and bounded to one complete page of at most 100 raw entries, ids and text processing are bounded, and invisible final answers log without pushing.
Tests pin the stated 1024-item and 64-turn memories, the 3-second default catch-up timeout and the waiting read's independent failure handling.
The Claude black-box Stop test reaches the real CLI with an isolated executable stand-in and push endpoint, checking session admission, the real timer, session title, push secret, re-entry and absent-answer silence; no real Claude or Codex is run.
The `remi codex` help names the completion duration, final-answer and device gates; README and AGENTS describe the first 200 characters of an answer.
The four exported structural types in public signatures and the session-lifetime growth of `MessageAPI.messages` are intentionally retained; the latter also exists in Claude's bridge and is outside this phase's duplicate-id bounds.
Claude's device-list refresh (#1210) and push-body escaping (#1211) remain separate changes.
