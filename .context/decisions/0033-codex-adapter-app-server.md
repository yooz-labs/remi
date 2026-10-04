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
  Not in any fixture, and still unverified without a real Codex: `cancel` from a second client, what a mid-approval subscriber disconnect does to a pending request (plan risk R1), `/new` rotation, `optOutNotificationMethods`, a failed-turn `turn/completed`, and keepalive on an idle connection.
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
`getMostRecent(harness?)` filters by the stored harness (absence means Claude), `remi --resume` asks for `claude`, `resolveStoredSession(..., {harness})` throws `SessionHarnessMismatchError` for a Remi id or prefix that names another harness's record and matches the harness's own session id only among that harness's records, `--sessions` prints `<harness>:<8>` (`<harness>:-` before the id is known), and `findByClaudeSessionId` and `updateClaudeSessionId` are Claude-only. This supersedes the last Consequences bullet of ADR 0032.
3. Store writes for a non-Claude identity.
`SessionStore.updateHarnessIdentity` fills in the id of a record created naming its harness; it refuses `claude` and a record naming another harness. `findByHarnessSessionId` finds a record by pair and prefers the single active owner. `assertUniqueSessionIdentities` rejects two active records with the same non-Claude pair, for an unknown harness string too.
4. Argument policy: default-deny in both modes.
`validateCodexArgs` allows `-m/--model`, `-a/--ask-for-approval`, `-s/--sandbox`, `--add-dir`, `-i/--image`, `--dangerously-bypass-approvals-and-sandbox`/`--yolo`, `-h/--help`, `-V/--version` and `--no-alt-screen`, and refuses every other flag by name; its denylist (`--worktree`, `-C/--cd`, `-c/--config`, `--enable`, `--disable`, `-p/--profile`, `--strict-config`, `--dangerously-bypass-hook-trust`, `--no-daemon`, `--remote*`, `--approve-for-me`, `--not-so-yolo`, `--search`, `--oss`, `--local-provider`) only chooses the message. `-C/--cd` and `--worktree` are refused because identity matching uses the session cwd. The returned arguments are `[...flags, 'resume', uuid]` or `[...flags, '--', ...promptWords]`, so Codex cannot read a prompt as a subcommand whatever its spelling; the subcommand name list is a message only. A valued flag never takes a flag-shaped token as its value. `validateCodexRemoteArgs` is the default-deny allowlist for a request over the wire: `-m/--model`, `-a untrusted|on-request`, `-s read-only|workspace-write`, `resume <uuid>`, at most 16 arguments of at most 256 characters, no NUL, total over any input. Unverified, because remi must not run Codex: the lists come from the plan, the spike and a read-only look at Codex 0.160.0's embedded help strings. The arg parser drops a user's `--` today, which Phase 3 owns.
5. Neutral PTY spawn.
`createPtySessionForSession` takes `outputSink` (`PtyOutputSink`, with `NOOP_OUTPUT_SINK` for a harness that reads no PTY output) and an optional `launch: {command, childEnv}` with both members required, so a non-Claude command never inherits `buildClaudeChildEnv`; absent, it is the Claude launch. `onExit`'s `markClaudeChildExited` is neutral in effect: the `claudeChild*` fields name the harness's child whichever command it is.
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
A later candidate rotates the binding (`/new`), but not while the tracked thread is `active` and not past the sibling guard above, and every rotation logs `rotated from <8> to <8>`; the old id is not kept.
With two remi codex sessions in one directory that means a `/new` in either is followed by neither (E1, a known limit), and the first session also declines the other's first thread, once, with the same message.
Descendants, followed by parent links, count as the session's: at most 256 ids known to be ours and at most 512 links whose parent is not yet known to be ours, first in first out, so another window's threads can only fill the second memory; a descendant pushed out of the first is reported idle (R7), since its frames are ignored from then on.
Identity is persisted with `SessionBindingStore.updateHarnessIdentity`; for a resume the record already names the thread.
3. **Attach.**
`thread/resume {threadId, excludeTurns: true}` and nothing else, ever (the spike showed an override persists on the thread).
It is retried on any error, `-32600` being the one expected, at once when the tracked thread turns `active`, otherwise every second and every five seconds after ten failures, and once more after every reconnect; a `-32601` (the server has no `thread/resume`) stops the retries for that connection.
The result's thread status is applied.
Only the first failure and every thirtieth are logged, and no thread frame of another thread, no cwd and no id longer than eight characters is ever logged.
4. **Status.**
The session's status is the aggregate of the tracked thread and its descendants: `waiting` if any is `active` with a flag (an unknown flag counts), else `thinking` if any is `active`, else `idle`; it is reported through `messageApi.handleStatusChange` only when it changes.
Other threads never change it.
A drop of the link and a rotation forget the descendants' statuses, since their frames can no longer be trusted to arrive, and they are not fetched again (E4): a subagent that is still waiting reads as not waiting until its next frame, and phase 4's replay re-delivers its approval card, which is the part a person can act on.
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
`remi codex --daemon` takes no arguments until the hub can pass them (phase 5), `--host`, `--resume`, and the hub with a harness are refused with exit 2.
9. **Purge before recording.**
`updateHarnessIdentity` and a `preAssign` that names a thread now purge dead holders first, in the binding store, because a record whose process died without exiting cleanly kept counting as an active holder of its thread and made the write refuse a free thread (Phase 2 review).
`remi codex resume <uuid>` also refuses a thread another live remi session holds, after the same purge, and resumes a thread that has several exited rows.
10. **Resume and the mismatch pointer.**
`remi codex resume <uuid>` works (`codex --no-alt-screen resume <uuid>`, attaching on ready with no `thread/started`), so `SessionHarnessMismatchError` names it, with the whole thread id for a Codex record that has one, and `--sessions` prints `resume: cd <directory> && remi codex resume <id>` under each exited Codex record, because its label cuts the id to eight characters and the resume looks the thread up from the session's own directory.
`remi codex resume` takes the whole thread id only: `resolveStoredSession`'s Codex branch (a remi id or prefix) still has no production caller, and the hub's refusal of `resume_session_request` on a non-Claude daemon is phase 5.
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
13. **Not verified, for LV-2.**
That Codex's server accepts the hand-rolled client's handshake (LV-1 is the same question); that bare `codex` starts the shared daemon on a cold start (R2); that `thread/started` for the TUI thread arrives within about 2 s and the title helper is ignored; that the attach succeeds after the first message; that a dropped subscriber leaves the TUI untouched; that no `.claude/settings.local.json` appears; whether the system message shows anywhere; whether `thread/started` carries any client marker that would tell a non-remi window apart; that `remi codex -- login` and `remi codex -- exec x` send those words as prompt text (the inserted `--` in `codex-args.ts` is unverified, and so is item 8's claim that it makes every word a prompt); `-i` together with `resume`; that TUI-internal `/resume` emits no `thread/started` (the spike's `expB3.jsonl:12-13` shows none, so the tracker keeps the old thread, a known limit); and `kill -9` of remi in the middle of an approval.
14. **Exports with no production caller in this PR.**
`UntrustedSocketError` (read as an `instanceof` only by the launch's notice wording and tests), `validateCodexRemoteArgs` (phase 5), `SessionBindingStore.getIdentity` and `SessionStore.findByHarnessSessionId` (phase 5, the session list and the resume lookup), `resolveStoredSession`'s Codex branch (phase 5), and the client's `AppServerDisconnectedError`, `AppServerTimeoutError` and `AppServerSerializationError` (phase 4 reads them when it answers).
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
Residual: a plain non-remi `codex` window opened in the same directory while the session is idle is indistinguishable from `/new` and re-binds it; every rotation logs `rotated from <8> to <8>`.
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
Phase 4's replay re-delivers its approval card, which is the actionable part.
- **E5, hub requests.**
`resume_session_request` and `create_session_request` on a Codex daemon stay phase 5 item 7 (tracked in #1179); this phase does not touch them.
