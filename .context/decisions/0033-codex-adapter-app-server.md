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
   CI and the release build pin Bun 1.3.11 (`.github/workflows/ci.yml:15`, `.github/workflows/release.yml:16`; the comment above the CI pin explains that 1.3.12 ships broken compiled binaries).
   Bun's WebSocket client gained `ws+unix://` in oven-sh/bun PR #29203, merged 2026-04-12 (title "WebSocket client: support ws+unix:// and wss+unix://").
   Bun 1.3.12 was published 2026-04-10 and 1.3.13 on 2026-04-20, so 1.3.13 is the first release that has it.
   On the local Bun 1.4.2, `new WebSocket("ws+unix://<socket path>")` reached a `Bun.serve({ unix })` echo server and returned the echo; the options form `new WebSocket("ws://localhost/", { unix: path })` fails.
   The repository's installed `bun-types` is 1.3.5 and has no `unix` option on the WebSocket client either.
   The `ws` npm package was not evaluated here.

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
   A frame that does not parse as JSON, or is not a JSON-RPC shape, is dropped and logged by length only.
   The read loop never throws.
3. **Handshake and ids.**
   `initialize` carries `clientInfo.name = "remi"` (plan risk R8: the daemon's originator may follow whoever initializes first), `capabilities {experimentalApi: true, requestAttestation: false}` and no opt-out list until LV-1 shows Codex accepts one; then `initialized`.
   Request ids are numeric from 1, with timeouts of 5 s for `initialize` and 15 s otherwise.
   `ready` is emitted after `initialized` is sent and before any later frame is dispatched, so frames that arrive earlier are queued behind it.
4. **The client answers only with a result.**
   `AppServerClient` has no way to send an error response; it exposes `respond(id, result)` only.
   An unknown server request (`item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read`, anything else) is delivered to the caller and nothing is sent back.
   The reason is the arbitration above: the first answer wins, and what a JSON-RPC error from a second client does to a pending request is unverified (plan risk R5 covers only `cancel`), so remi never sends one.
5. **Reconnect.**
   Backoff 250 ms doubling to 5 s, forever, until `stop()`; the socket path is resolved on every attempt; the first failure is logged and then every tenth; a drop rejects every in-flight request and reports `disconnected`; a success resets both the delay and the failure count.
6. **Never log a body.**
   The client logs method names, truncated ids and lengths, never params or results (plan section 5: frames can carry other threads' metadata).
   A test sends a marker through every drop path and asserts it never appears in a log line.
7. **Fixtures are redacted by an allowlist.**
   `scripts/extract-codex-fixtures.ts` reads the spike's raw logs (a directory given as an argument or `CODEX_SPIKE_DIR`; never copied into the repository), keeps frames on a method allowlist, and rewrites paths, ids, the model and the user agent to placeholders.
   It runs the same `scanForLeaks` as the test suite and writes nothing when it finds a leak.
   `tests/fixtures/codex-app-server/index.json` records each source file, its sha256 and the extractor version, and labels two files as not captured: `report-derived.jsonl` (the `-32600 no rollout found` error, from the spike report) and `synthetic-from-schema.jsonl` (file-change, permissions and elicitation server requests, built from the generated TypeScript schema).
8. **Boundary.**
   `harness-boundary.test.ts` gains two rules: nothing under `harness/codex/` imports a Claude-specific module, and no neutral module imports `harness/codex/`.

## Consequences

- A phone, a lock screen or Telegram can answer a Codex approval in a later phase with no typed bytes, and a reconnect is safe because Codex replays pending requests to a late subscriber (receipts).
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
  Not evaluated: a hand-rolled client avoids a new runtime dependency in a package that ships as a compiled binary.
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
