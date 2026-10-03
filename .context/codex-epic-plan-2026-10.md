# Codex adapter epic: implementation plan (Sonnet-executable, phase by phase)

**Status:** plan of record for the Codex epic; written 2026-10-03 against `develop` at `6461d673`, after the harness seam (#1161) and the passed spike (#1160).
The spike's raw frame logs are NOT in the repo (they hold local paths, ids and account metadata); they sit in a temporary directory, called `<scratchpad>` below, and Phase 1 extracts redacted fixtures from them.
No personal identifiers (username, hostname, install ids, absolute home paths) may appear in committed code, tests, fixtures or docs; the redaction scan is an allowlist for that reason.

Scope: `remi codex` with a Codex approval reaching the phone, the phone's allow running the command, and the TUI overlay closing. All of it goes through the shared app-server, never typed keys. Read-only exploration of `develop` at `6461d673`. I wrote nothing, ran no Codex, and did not run a Bun experiment, because creating a socket file under /tmp is a write and my mode forbids it. Every "unverified" below is a real gap, not hedging.

---

## 0. Read first

### 0.1 Where the spike and the new evidence overrule the strategy

| # | Strategy / issue text | Evidence | Consequence in this plan |
|---|---|---|---|
| 1 | "Attach with `thread/resume {excludeTurns:true}`" (strategy:94) | Report §3 and §4: `-32600 no rollout found` before the first user message. | Attach is retried and status-driven (Phase 3). |
| 2 | Silent on replay | Report claim 3: a late attacher gets the pending request replayed with the same id (`expB3.jsonl:45-51`). | Reconnect is safe, and the design relies on it. |
| 3 | Request id treated as per-thread | The accept run's request is `id:1` (`expA-accept.jsonl:47`); the decline run's is `id:2` (`expA-decline.jsonl:63`); expB3's is `id:5`; expC's is `id:6`. Ids are a daemon-global counter. | Correlation key is `(threadId, requestId)`, never the id alone. |
| 4 | Any TUI thread with matching cwd is "the thread" | `expB.jsonl:7` is the TUI thread (`ephemeral:false`, `threadSource:"user"`, `path` set). `expB.jsonl:12` is a second `thread/started` about 7 s later, for the same cwd, with `ephemeral:true`, `threadSource:"thread_title"`, `environments:[]`, `path:null`. | Identity discovery must reject ephemeral and non-`user` threads (Phase 3). A cwd-only rule would bind to the title helper after a resume. |
| 5 | "Chat view: rollout JSONL" (strategy:96) | `ts/v2/ThreadReadParams.ts` doc: "prefer a metadata-only read and page with `thread/turns/list` and `thread/items/list`". `thread/resume` results carry `path`, `historyMode:"paginated"` and backwards cursors (`expA-accept.jsonl:38`). | Primary chat source is the app-server's paged items. Rollout JSONL is the documented fallback. Schema-level evidence only, so Phase 6 has a live check. |
| 6 | Ordinary Bun WebSocket | Bun's native `ws+unix://` client landed in PR #29203 (merged 2026-04-12), first released in bun v1.3.13 (2026-04-20). CI pins 1.3.11 (`.github/workflows/ci.yml:15`; corrected in Phase 1: an earlier draft said line 12, which is a comment) and `release.yml:16` pins the same. `bun-types@1.4.2` `WebSocketOptions` has no `unix` option. Third-party Codex adapter happier-dev found that the `ws` npm package under Bun ignores `createConnection` and opens TCP (their PR #401). | Native `ws+unix` cannot be the transport. The `ws` package cannot either. Phase 1 hand-rolls a small RFC 6455 client over `node:net`. Swap to native when the pin moves to >= 1.3.13 and passes the compile smoke test. |
| 7 | `availableDecisions` list; TUI "No" | Spike: under `untrusted` the list is `[accept, acceptWithExecpolicyAmendment, cancel]`; `decline` (unlisted) was honored and the model continued (`expA-decline.jsonl:65-76`). The TUI's "No (esc)" maps to the listed `cancel`. | Phone "No" sends `cancel` when it is listed. See P4 policy. |
| 8 | Strategy's flag list | Spike adds `--search`, `--approve-for-me`, `--no-daemon`; `-a`, `-s`, `-m`, `-C`, `--add-dir` and `--disable daemon_auto_start` stay shared. | Denylist in `codex-args.ts` follows the spike list. |
| 9 | First TUI launch | 0.159.1 blocks on "Trust this folder" in an untrusted dir; 0.160.0 showed no prompt; the "Update available" modal ran an installer when a digit was typed. | remi never types into a Codex PTY, and live-verification steps must clear modals by screen-scrape first. |

### 0.2 Decisions of mine to veto (full list in §6.2)

- Hand-rolled WebSocket client.
- Phone "No" maps to `cancel`.
- v1 actionable cards are command approvals only.
- Phone chat typing is refused for Codex.
- `reservedRows=0`.
- The older-daemon gate is a refusal, not a second store file.
- The Codex-specific `-C/--cd` denial.

---

## 1. Verified ground truth for implementers

Spike files live in `<scratchpad>/codex-spike/`, called `$SPIKE` below.

**Transport**
- WebSocket over the unix socket, text frames, `jsonrpc` optional (`$SPIKE/rpc.py:44-49`, `unix_connect(SOCK, "ws://localhost/", max_size=None)`). The python client offered the library's default extensions; nothing shows what Codex's server requires.
- `~/.codex/app-server-control/` is mode 0700, owned by the user. The socket resolves into `/private/tmp/codex-daemon-<uid>/<hash>`, also 0700. I stat-checked both. Only the same OS user can connect.
- The socket path under `~/.codex` is a symlink to a short /tmp path, so connect to the resolved target, not the link (macOS `sun_path` is 104 bytes).
  **Correction (Phase 1, #1181):** `fs.realpathSync`, `realpathSync.native` and `fs.promises.realpath` throw `EOPNOTSUPP` on a unix socket file and on a symlink to one on macOS, checked on Bun 1.3.11 and 1.4.2; `readlinkSync` and `lstatSync` work, and `realpath` of the parent directory works.
  Phase 3 must `readlink` the link, or `realpath` the parent directory and `readlink` the file; wherever this plan says "realpath the socket", read that.

**Handshake**
- `initialize {clientInfo, capabilities:{experimentalApi:true, requestAttestation:false}}` returns `{userAgent, codexHome, platformFamily, platformOs}` (`expA-accept.jsonl:1-2`), then notification `initialized` (`:4`).
- `capabilities.optOutNotificationMethods?: string[]` exists in the schema (`ts/InitializeCapabilities.ts`). Using it is unverified live.

**Server-request frames**
- Real command-approval frame: `expA-accept.jsonl:47`. `params` has `kind:"command"`, `threadId`, `turnId`, `itemId`, `startedAtMs`, `environmentId`, `command`, `cwd`, `commandActions`, `proposedExecpolicyAmendment`, `availableDecisions`. The real frame has no `approvalId` key at all (corrected in Phase 1; an earlier draft said it is null, and the schema marks it optional), so test it with `== null`, never `=== null`.
- `RequestId = string | number` (`ts/RequestId.ts`).
- Order on every subscriber: `thread/status/changed {active, [waitingOnApproval]}`, then `item/started(commandExecution)`, then the request (`expA-accept.jsonl:45-47`).
- `ServerRequest` also covers `item/tool/call`, `account/chatgptAuthTokens/refresh`, `attestation/generate`, `currentTime/read` and the legacy `applyPatchApproval` and `execCommandApproval` (`ts/ServerRequest.ts`).

**Arbitration**
- B accepts (`:51`). Both subscribers get `serverRequest/resolved {threadId, requestId}` within 1 ms (`:52-53`). Then A's late `accept` (`:62`) is ignored and there is no error frame.
- Decline: `decline` honored (`expA-decline.jsonl:65`), item `status:"declined"` (`:68`), late `accept` ignored (`:76`).

**Late attach**
- Client Z's `thread/resume` (`expB3.jsonl:45`) is answered at `:49`, and the same request id 5 is replayed to it at `:51`.
- An unsubscribed client still gets the broadcast `thread/started` and `thread/status/changed`, but no requests.
- `thread/started` also reaches connections that never subscribed. remi will see metadata for all of the user's Codex threads. See §5.

**Other frames**
- `turn/completed` carries `turn.items` with the final `agentMessage` (`phase:"final_answer"`), `status`, `error`, `durationMs` (`expA-accept.jsonl:74`).
- Blocking `item/tool/requestUserInput` (`isBlocking:true`, `autoResolutionMs:null`) is at `expC.jsonl:31`. Its response is `{answers:{q1:{answers:["Blue"]}}}` (`:34`). `turn/steer` does not resolve it (`:32-33`, resolved at `:35` only after the response).

**Thread frames**
- A bare TUI emits `thread/started` about 0.5-0.8 s after launch (`expFlags.jsonl:11`, `expB.jsonl:7`).
- TUI-created threads show `originator:"remi-spike"` (the spike's client name, `expFlags.jsonl:11`). The daemon's originator looks global to whoever initialized first. See R8.
- The TUI resuming a thread emits no `thread/started`, only status changes (`expB3.jsonl:12-13`).

**Daemon**
- The CLI and the managed daemon can differ in version (0.159.1 against 0.160.0).
- `daemon_auto_start` is a stable, default-enabled feature (`expFlags.jsonl:69`), and `~/.codex/app-server-control/app-server-startup.lock` is dated Sep 25, before the spike. Both are consistent with bare `codex` auto-starting the daemon. Not proven (R2).

**Repo ground truth, current `develop`**

| Item | Where |
|---|---|
| Harness contract | `packages/daemon/src/harness/types.ts:30-46` (ctx), `:55-58` (screen), `:69-85` (`DecisionChannel`), `:94-105` (`HarnessSession`), `:107-135` (`Harness`) |
| `ClaudeLaunchDeps` | `harness/claude-session.ts:83-111` |
| `NO_GATE` | `harness/claude-session.ts:120-128` |
| `ClaudeDecisions` | `harness/claude-session.ts:137-176` |
| `sessionNotifiers.set` inside the Claude launch | `harness/claude-session.ts:217` |
| Neutral shell | `cli.ts:1466-1588`: `createSession` at `:1511`, `harnessSessions.set` at `:1522`, `start()` at `:1558` |
| Harness construction | `cli.ts:1730` (typed `ClaudeHarness`); `onTurnStop` calls `harness.admitsAnySession` at `:1263` |
| Hook-server blocks | `cli.ts:2399-2450` (daemon, `createNewSession` called with no args at `:2450`) and `:2618-2650` (wrapper, args at `:2685`) |
| `installStatusLine` | `cli.ts:2301`, `:2542` |
| `--resume` / `--sessions` / `getMostRecent` | `cli.ts:685-770` (`getMostRecent` at `:730`) |
| PTY spawn | `pty-session-setup.ts`: `outputProcessor` dep `:46`, `buildClaudeChildEnv` `:163`, `command:'claude'` `:204` |
| Held answer path | `input-events.ts:806-906` (`applyHeldAnswer`); a card with `held` left `unknown` falls to typing via `applyAnswer:914-1090`; cancel path `:633-669` types Esc when `held==='unknown' && stillActive` |
| Typed chat | `input-events.ts:1188-1320`, `promptUp` guard at `:1284`, `submitInput` at `~1319` |
| `guardBinding` | `input-events.ts:176-205`: `claudeSessionId===undefined` accepts; a null bound id accepts. Codex answers pass it trivially. |
| `SessionStore` | `session-store.ts`: `assertUniqueSessionIdentities:190`, `resolveStoredSession:236`, `list():701` (purges and writes), `getMostRecent:730`, `updateClaudeSessionId:757` |
| Binding store | `session-binding-store.ts:134` (`preAssign`) |
| Live-sessions entry | `session-registry-file.ts:35-84` has optional `version`; status files carry `pid` and `version` (`daemon-manager.ts:490-499`) |
| Push categories | `notification-dispatcher.ts:49-62` (`isOneTimeYes`/`isStanding`), `:96-112` (`selectPushCategory`), `:134-143` (`pushCategoryFor`), `:170-180` (`selectDynOptions`) |
| Question registration | `message-api.ts:250-263` (`handleQuestion`; `held` bypasses dedup) |
| Transcript handler | `transcript-events.ts:70-234` |
| Existing tests | `tests/harness/harness-boundary.test.ts`; `tests/integration/launch-characterization.test.ts` (real `cli.ts --daemon`, executable fake `claude` on PATH); `tests/integration/hub-test-utils.ts:119` (`spawnDaemon` has no extra-args parameter) |

---

## 2. Architecture and exact signatures

### 2.1 Module map

All new files go under `packages/daemon/src/harness/codex/`, with Codex's side forbidden from importing Claude modules by the boundary test.

| File | Phase | Role |
|---|---|---|
| `ws-frames.ts` | 1 | RFC 6455 client codec |
| `unix-ws.ts` | 1 | Connect, handshake, ping/pong, close |
| `app-server-protocol.ts` | 1 | JSON-RPC framing types and `classifyInbound` |
| `app-server-client.ts` | 1 | Handshake, request/response correlation, reconnect |
| `codex-args.ts` | 2 | Pure arg validation |
| `thread-protocol.ts` | 3 | Narrow `thread/*` parsers |
| `thread-tracker.ts` | 3 | Identity discovery and attach |
| `codex-session.ts` | 3 | The launch |
| `codex.ts` | 3 | `CodexHarness` |
| `approval-cards.ts` | 4 | Server request to `Question` |
| `codex-decisions.ts` | 4 | `DecisionChannel` |
| `codex-turns.ts` | 6 | Turn events |
| `codex-chat.ts` | 6 | Chat history and live items |

Neutral changes are listed per phase below.

### 2.2 Phase 1 signatures

```ts
// ws-frames.ts
export class WsProtocolError extends Error {}
export interface WsFrame { fin: boolean; opcode: number; payload: Uint8Array }
export function computeAcceptKey(secWebSocketKey: string): string;            // base64(sha1(key + GUID))
export function encodeClientFrame(opcode: number, payload: Uint8Array, mask?: Uint8Array): Uint8Array; // masked; random 4-byte mask unless given
export class WsFrameParser {                                                  // server->client frames: unmasked
  constructor(opts?: { maxPayloadBytes?: number });                           // default 32 MiB
  push(chunk: Uint8Array): WsFrame[];                                         // throws WsProtocolError: RSV bits, masked server frame, control frame >125 or fragmented, over limit
}

// unix-ws.ts
export interface WsConnection { send(text: string): void; close(code?: number): void; readonly isOpen: boolean }
export interface WsHandlers {
  onMessage(text: string): void;
  onClose(info: { code: number | undefined; reason: string; clean: boolean }): void;
}
export async function connectUnixWebSocket(
  socketPath: string, handlers: WsHandlers,
  opts?: { host?: string /*'localhost'*/; path?: string /*'/'*/; connectTimeoutMs?: number; handshakeTimeoutMs?: number },
): Promise<WsConnection>;   // sends no Origin and no Sec-WebSocket-Extensions

// app-server-protocol.ts
export type RequestId = string | number;
export type InboundMessage =
  | { kind: 'response'; id: RequestId; result?: unknown; error?: { code: number; message: string; data?: unknown } }
  | { kind: 'request'; id: RequestId; method: string; params: unknown }
  | { kind: 'notification'; method: string; params: unknown };
export function classifyInbound(raw: unknown): InboundMessage | null;          // null for malformed

// app-server-client.ts
export class AppServerRpcError extends Error { constructor(readonly code: number, message: string, readonly data?: unknown) }
export class AppServerDisconnectedError extends Error {}
export class AppServerTimeoutError extends Error {}
export type AppServerEvent =
  | { type: 'ready'; userAgent: string; codexHome: string | null; reconnect: boolean }
  | { type: 'disconnected'; reason: string }
  | { type: 'serverRequest'; id: RequestId; method: string; params: unknown }
  | { type: 'notification'; method: string; params: unknown };
export interface AppServerClientOptions {
  socketPath: () => string;                         // resolved on every attempt (by `readlink`, trust-checked in Phase 3; see the realpath correction in section 1)
  clientInfo: { name: string; title: string | null; version: string };
  optOutNotificationMethods?: readonly string[];    // default none until live-verified
  connect?: typeof connectUnixWebSocket;
  requestTimeoutMs?: number;                        // 15_000
  initializeTimeoutMs?: number;                     // 5_000
  backoff?: { initialMs: number; maxMs: number };   // 250 -> 5_000, doubling, until stop()
  log?: (message: string) => void;
}
export class AppServerClient {
  constructor(opts: AppServerClientOptions, onEvent: (e: AppServerEvent) => void);
  start(): void;                                    // never throws; connect loop
  stop(): void;                                     // idempotent; no reconnect after
  readonly state: 'idle' | 'connecting' | 'ready' | 'closed';
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  respond(id: RequestId, result: unknown): boolean; // false when not ready; frame {jsonrpc:'2.0', id, result}
}
```

Client invariants:
- `ready` fires after `initialized` is sent and before later frames are dispatched.
- A drop rejects all in-flight requests with `AppServerDisconnectedError`.
- The client never sends an error response to a server request. It exposes only `respond`. See §2.4 on why.

### 2.3 Launch, identity and daemon policy (item 1)

```ts
// codex.ts
export interface CodexLaunchDeps {
  sessionRegistry: SessionRegistry; sessionStore: SessionStore; bindingStore: SessionBindingStore;
  liveSessionsRegistry: SessionRegistryFile;
  onQuestionResolved: (sessionId: UUID, questionId: UUID, reason: 'answered' | 'cancelled') => void;
  currentPort: () => number; wsPort: () => number; cleanup: () => Promise<void>;
  env: () => Readonly<Record<string, string | undefined>>;     // CODEX_HOME, PATH
  legacyWriters: () => LegacyWriter[];                          // Phase 2 gate
  turnEvents?: TurnEventSink;                                   // Phase 6
  appServer?: Pick<AppServerClientOptions, 'connect' | 'backoff'>; // test seam (transport only)
}
export class CodexHarness implements Harness {
  readonly gracefulExitInput = null;                            // force-close path; never type /quit
  constructor(deps?: CodexLaunchDeps);
  resumeArgs(threadId: string): string[];                       // ['resume', threadId]; subcommand, placed last
  transcriptPath(): null;                                       // Harness.transcriptPath becomes string | null (Phase 2)
  createSession(ctx: HarnessLaunchContext): HarnessSession;     // throws if no deps
}
```

Launch order inside `createCodexSession` (state-changing steps in this order):
1. `validateCodexArgs(ctx.extraArgs)`. Throws `CodexArgsError`; `cli.ts` prints it and exits 2.
2. `deps.legacyWriters()` gate. If non-empty, throw `LegacyDaemonError` before any record is written (closes #1165 D, see below).
3. `bindingStore.preAssign({... claudeSessionId:null, harness:'codex', harnessSessionId: resumeId ?? null})`.
4. Build `CodexDecisions`, `AppServerClient`, `ThreadTracker`.
5. `createPtySessionForSession({command:'codex', args:['--no-alt-screen', ...args], childEnv:{}, outputSink: NOOP_OUTPUT_SINK})`.
6. Return the `HarnessSession`.

`HarnessSession` for Codex:
- `start()` does `await pty.start()`, then `client.start()`. The PTY goes first because the TUI auto-starts the shared daemon.
- `acceptsTypedChat:false`.
- `dispose()` calls `client.stop()` and is idempotent.

**Launch is exactly `codex --no-alt-screen <validated user args>`, with no override flags.**
- `--no-alt-screen` was in every spike TUI run (`expFlags.py:30`) and stays on the shared daemon.
- Resume is `codex --no-alt-screen resume <uuid>`, the shape the spike used.
- cwd is the session working directory.
- Env is `process.env` plus nothing. In particular `CODEX_HOME` passes through, and no `REMI_PORT` and no Claude variables are set (`buildClaudeChildEnv` is not called).
- `reservedRows` is forced to 0. Codex's inline mode manages its own scroll regions and the reserved status row (#565, #932) was built against Claude's renderer.

**Who starts the shared daemon (DECIDED POLICY): remi never starts, stops, restarts or upgrades it.** It is shared with the user's other Codex sessions, and `daemon stop` leaves a stray `pid-update-loop` child (report §3).
- The TUI auto-starts it (`daemon_auto_start`; unverified for a cold start, R2).
- remi polls the socket through the client's backoff.
- If no `ready` arrives within 30 s of spawn, remi logs once and emits one system-sender message ("Codex approvals are not reaching the phone: the shared app-server was not reachable; the session still works in the terminal"). The session continues as a plain terminal session.
- Version skew: from `initialize.userAgent`, log the daemon version next to `codex --version`. Skew is non-fatal (the spike ran 0.159.1 CLI against 0.160.0 daemon for RPC).
- If a call returns `-32601`, mark that capability unavailable, log, and carry on.
- Fallbacks if R2 fails live are in §6.2 item 8.

**Socket trust (Phase 3).** Before connecting, resolve the socket with `readlink` (`realpath` throws `EOPNOTSUPP` on a socket; see the correction in section 1) and refuse if its parent directory is not owned by the current uid or has any group/other bits (`UntrustedSocketError`, logged, no connect). Socket path is `${CODEX_HOME ?? ~/.codex}/app-server-control/app-server-control.sock`, so profiles that relocate `CODEX_HOME` (#1157) are not precluded.

**Identity after spawn (`ThreadTracker`).**

```ts
// thread-protocol.ts
export type ThreadStatus =
  | { type: 'notLoaded' } | { type: 'idle' } | { type: 'systemError' }
  | { type: 'active'; activeFlags: Array<'waitingOnApproval' | 'waitingOnUserInput'> };
export interface ThreadInfo {
  id: string; cwd: string | null; ephemeral: boolean; createdAtSec: number | null;
  parentThreadId: string | null; threadSource: string | null; path: string | null;
  environmentCount: number; status: ThreadStatus | null;
}
export function parseThread(v: unknown): ThreadInfo | null;
export function parseThreadStatus(v: unknown): ThreadStatus | null;

// thread-tracker.ts
export interface ThreadTrackerDeps {
  client: Pick<AppServerClient, 'request'>;
  sessionCwd: string;                          // realpath
  spawnedAtMs: number;
  expectedThreadId: string | null;             // resume
  claimedByOthers: () => ReadonlySet<string>;  // active non-Claude records in the store
  onIdentity(threadId: string): void;          // persist
  onStatus(threadId: string, status: ThreadStatus): void;
  log: (m: string) => void;
}
export class ThreadTracker {
  constructor(deps: ThreadTrackerDeps);
  handleNotification(method: string, params: unknown): void;
  handleReady(reconnect: boolean): void;       // (re)attach
  readonly threadId: string | null;
  readonly attached: boolean;
  isOurs(threadId: string): boolean;           // tracked, or a descendant via parentThreadId
  dispose(): void;
}
```

Candidate rule on `thread/started` (all must hold):
- `ephemeral === false`.
- `threadSource === 'user'`, or `threadSource === null` together with `path !== null`.
- `environmentCount >= 1`.
- `parentThreadId === null`.
- `realpath(cwd) === sessionCwd`.
- `createdAtSec*1000 >= spawnedAtMs - 5000`.
- Id not in `claimedByOthers()`.
- No tracked thread yet.

The first match wins. If a second candidate arrives within 300 ms with a `createdAt` within 300 ms of the first, bind neither, log, and set no identity (fail closed). Residual risk: a non-remi TUI in the same cwd started in the same window (R4).

On identity:
- `bindingStore.updateHarnessIdentity(sessionId, 'codex', threadId)`.
- Attach with exactly `thread/resume {threadId, excludeTurns:true}` and no overrides (the spike showed overrides persist, report §2). Pin: the frame is exactly that.
- Retry on `-32600` or any error: immediately on `thread/status/changed` to `active` for the tracked thread, otherwise every 1 s for the session's life. Replay delivers a request that arrived before attach (`expB3.jsonl:51`).
- Resume of a known id (`resume <uuid>`): attach on `ready`; `thread/started` is not required (`expB3.jsonl:12-13`).
- Rotation (`/new` inside the TUI): a later candidate matching the same rule rotates the binding only if the tracked thread's status is not `active` (DECIDED POLICY, unverified live, R4). The old id is not retained.
- A server request for a thread that `thread/started` showed as a descendant (parent chain reaches the tracked thread) is accepted as `terminalOnly` (v1). Requests for anything else are ignored.

**Older-daemon hazard, #1165 D (closed in Phase 2, enforced in Phase 3).**
- Fact: any daemon older than the shim drops `harness`/`harnessSessionId` on rewrite, and `list()` and `getMostRecent()` themselves write (`session-store.ts:701-715`, `doPurge`). The shim is in no tagged release; v0.7.15 is the newest tag. The first build containing it is `0.7.16-dev.7`.
- DECIDED POLICY: before the first non-Claude record is written, `findLegacyWriters` scans live-sessions entries (`version` absent or `< 0.7.16-dev.7`, pid alive), the hub status file (`daemon-status.json`: `pid`, `version`, pid alive) and per-port `status-<PORT>.json`. Any hit means `remi codex` refuses to start: "an older remi daemon (vX, pid N) would erase Codex session records; run `remi stop --all` and restart". The hub's `create_session_response` is `success:false` for a Codex request in the same case (Phase 5).
- Why a refusal and not a separate store file: a second store would force a merge in every consumer of `SessionStore` (`list`, `getMostRecent`, `markExited`, the hub session list, `--sessions`).
- Residual (R12): an older CLI binary invoked from another install path that is not registered anywhere. The fallback, if the gate proves leaky, is a sidecar `~/.remi/harness-identities.json` that only this build writes.
- The second half of D (resume awareness) is Phase 2: `--resume`/`getMostRecent`/`resolveStoredSession` become harness-aware before the first record exists.

### 2.4 Decision channel for Codex (item 3)

`approval-cards.ts`:

```ts
export interface PendingRequestSpec {
  key: string;                                   // `${threadId}:${String(requestId)}`
  threadId: string; requestId: RequestId; method: string;
  question: Question;                            // card with a minted UUID
  responses: ReadonlyMap<string, unknown>;       // option.value -> JSON-RPC result
  noResponse: unknown | null;                    // result for the No option (also Cancel)
  actionable: boolean;                           // false => terminalOnly
}
export function buildApprovalCard(
  req: { id: RequestId; method: string; params: unknown },
  mintId: () => UUID,
  opts: { agentId?: string },
): PendingRequestSpec | null;                    // null only for a method remi does not handle
export function responseFor(
  spec: PendingRequestSpec, answer: HeldAnswer,
): { ok: true; result: unknown } | { ok: false; why: 'unknown-option' | 'terminal-only' | 'not-an-option' };
```

`codex-decisions.ts`:

```ts
export interface CodexDecisionsDeps {
  sessionId: UUID;
  client: Pick<AppServerClient, 'respond' | 'state'>;
  sessionRegistry: Pick<SessionRegistry, 'removeQuestion' | 'setQuestionEvictionGuard'>;
  present: (q: Question) => void;                // messageApi.handleQuestion(q, { held: true })
  onQuestionResolved: (sid: UUID, qid: UUID, reason: 'answered' | 'cancelled') => void;
  log: (m: string) => void;
}
export class CodexDecisions implements DecisionChannel {
  constructor(deps: CodexDecisionsDeps);
  handleServerRequest(req: { id: RequestId; method: string; params: unknown }, isOurs: (threadId: string) => boolean): void;
  handleResolved(p: { threadId: string; requestId: RequestId }): void;
  handleStatus(threadId: string, status: ThreadStatus): void;
  handleDisconnected(): void;                    // retire every card
  handleReattached(): void;                      // replay window, then sweep
  // DecisionChannel members below
}
```

**Request-to-card map**

| Method | `Question` | Actionable in v1? |
|---|---|---|
| `item/commandExecution/requestApproval` with `kind:'command'`, `approvalId==null` (loose equality: the real frame omits the key, section 1), no `additionalPermissions`, no `networkApprovalContext`, no `proposedNetworkPolicyAmendments` | `kind:'permission'`, `text:"Allow Codex to run: <command>"` (reason appended), `held` stamped by `handleQuestion` | Yes, verified live |
| Same method with `kind:'writeStdin'`, a non-null `approvalId`, or extra permissions or network context | Same shape, `terminalOnly:true` | No (unexercised, grants more than the command) |
| `item/fileChange/requestApproval` | text with `reason`/`grantRoot`, `terminalOnly:true` | No (schema only). Phase-4 live step may flip it. |
| `item/permissions/requestApproval` | text with `reason`, permission names, `terminalOnly:true` | No |
| `item/tool/requestUserInput` | `kind:'multi_question'`, `questions` mirrored for display, `terminalOnly:true` | No. Blocking form verified by RPC only (`expC.jsonl:31-35`); the TUI overlay closing was not observed. |
| `mcpServer/elicitation/request` | text from `message`/`serverName` (url mode shows the host only), `terminalOnly:true` | No |
| Any other `ServerRequest` method | not a card; log the method name only; never log params; never respond | n/a |
| Known method, unparsable params | generic `terminalOnly` card "Codex is asking for approval; answer it in the terminal" | No (fail closed but visible) |

**Options (by meaning, never by position).**
- `{label:'Yes', value:'accept', isYes:true, isNo:false, isRecommended:true}` if `accept` is listed (or the list is absent).
- `{label:'Yes, for this session', value:'acceptForSession', isYes:true, standingGrant:'session'}` only if `acceptForSession` is listed.
- `{label:'No', value:<No decision>, isNo:true}` where the No decision is `cancel` if listed, else `decline` if the list is absent or lists it, else none (and the card becomes `terminalOnly`).
- The object-form decisions (`acceptWithExecpolicyAmendment`, `applyNetworkPolicyAmendment`) are never offered: they write persistent policy from a phone tap, and Claude's rule (AGENTS.md) is that a phone tap never writes a settings file.
- `standingGrant` gains the value `'session'` (shared `types.ts:389`, web `types/index.ts:204`). The web card hint already reads "This session" for any defined `standingGrant` (`QuestionCard.tsx:108`).

**Lock-screen category.**
- Applied by the existing functions, unchanged. `[Yes, No]` gets `REMI_YN`.
- `[Yes, Yes for this session, No]` has `second.isYes` at index 1, so `isStanding` is true (`notification-dispatcher.ts:62`). `second.standingGrant` is not `'addRules'`, so `selectPushCategory` returns undefined and `selectDynOptions` returns false. That is the never-actionable-while-locked rule with no code change.
- `pushCategoryFor` returns undefined for `terminalOnly` (`:135`).
- The pin test asserts all three outcomes on cards built from the real frame.

**Answer mapping.** `decision` values sent are only ones the request lists.
- `Yes` -> `{decision:'accept'}`.
- `Yes, for this session` -> `{decision:'acceptForSession'}`.
- `No` and the card's universal Cancel -> `{decision:<No decision>}`.
- Free text, `ambiguous` and `selections` -> `refused`.
- Policy on `cancel` versus `decline`: `cancel` is what the TUI's own No sends (spike) and is listed, so the phone matches the terminal. `cancel` was never exercised from a second client. The live gate must exercise it; if it misbehaves, the No mapping flips to `decline` (a one-line change in `buildApprovalCard`). `decline` is the verified-working path but unlisted.

**`DecisionChannel` members**

| Member | Meaning for Codex |
|---|---|
| `answerHeld(qid, a)` | id never seen: `'unknown'`. Known id: never `'unknown'`. Not pending (resolved, retired, disconnected): `'closed'`. Client not `ready`: `'closed'` plus log. `terminalOnly`: `cancel` gives `'closed'` (card dismissed, nothing sent, nothing typed), anything else `'refused'`. Actionable: map via `responseFor`, `client.respond(...)`, then `'resolved'`. |
| `retireQuestion(qid)` | stop tracking; send nothing; the app-server request stays pending for the TUI |
| `isHeld(qid)` | actionable and pending |
| `hasMainHold()` | any pending main-thread request, or the latest status flags for the tracked thread are non-empty |
| `hasOpenHookPrompt()` | same as `hasMainHold()` plus any pending `terminalOnly` request |
| `noteTerminalEscape()` | no-op; the app-server's `serverRequest/resolved` is authoritative |
| `forceRelease(reason)` | dismiss every local card (`question_resolved` `'cancelled'`), stop tracking, send nothing; returns the count |
| `screen` | undefined (no PTY parsing), so any typed path fails closed. `trackerScreenDeps` returns `null` for `observedPromptOptions`. |

**Hold semantics.** Codex is the arbiter. remi holds nothing. No `HeldAnswerOutcome` means "waiting for a deadline".

**First answer wins and dismissal.**
- `serverRequest/resolved` for a tracked key: if remi answered it, nothing more (the handler already removed the card at `input-events.ts:838-840`). Otherwise `sessionRegistry.removeQuestion(sid, qid, 'codex:resolved')` plus `onQuestionResolved(sid, qid, 'cancelled')`. This covers a terminal answer, and the card clears on every client.
- A phone answer that lost the race is ignored by Codex with no error (spike), and the later `resolved` clears the card.
- DECIDED POLICY: on disconnect, retire all cards immediately, because a card the phone cannot answer must not stay answerable. On reconnect the tracker re-resumes and the replayed requests create fresh cards with new ids. A 1.5 s replay window follows each re-resume (the spike's replay arrived in 4 ms, `expB3.jsonl:49-51`), and any pending key not re-seen after it is dismissed.
- A request from a daemon restart can reuse ids, which is harmless because cards are retired on disconnect and keys include the thread.

**Never answer what we do not decide.** The client never sends an error response to a server request it does not handle. A JSON-RPC error from remi would be the "first answer" and could resolve the TUI's request. `account/chatgptAuthTokens/refresh` and `attestation/generate` are never answered or logged beyond the method name.

**Chat guard.**
- `HarnessSession.acceptsTypedChat?: boolean` (default true; Codex false).
- `input-events.ts` refuses non-raw chat text for such a session with `INPUT_NOT_DELIVERED` (`createInputNotDeliveredError`) before the `promptUp` guard at `~1272`.
- `promptUp` stays truthful through `hasMainHold`/`hasOpenHookPrompt` so a future `turn/start` chat path inherits it.
- Raw input from `remi attach`, the web Esc button and Telegram `/interrupt` stays (a person at the terminal; Esc at a Codex overlay is its own "No").

### 2.5 Chat source and turn events (item 4)

**Turn events.**
- The pure functions are already neutral (`shouldNotifyTurnComplete`, `buildTurnCompleteText` in `turn-timer.ts:148-197`, and `buildTurnFailedText` takes a `Pick<StopFailureHookInput,...>`, structurally neutral). Only `onTurnStop(input: StopHookInput)` (`cli.ts:1257-1318`) couples to Claude, in its filter, its timer lookup and `stop_hook_active`.
- New `packages/daemon/src/notifications/turn-events.ts`:

```ts
export interface TurnEventSink {
  turnCompleted(e: { sessionId: UUID; elapsedMs: number | undefined; lastAssistantMessage: string | undefined; reentry: boolean }): void;
  turnFailed(e: { sessionId: UUID; error?: string; errorDetails?: string; lastAssistantMessage?: string; agentName: string }): void;
  turnSucceeded(sessionId: UUID): void;           // dismisses an outstanding turn_failed notice
}
export function createTurnEventSink(deps: { /* config, device tokens, push, notifiers: what onTurnStop uses today */ }): TurnEventSink;
```

- `onTurnStop` keeps the `admitsAnySession` filter and timer lookup, then calls `turnCompleted`. Claude's `StopFailure` wiring (`ClaudeLaunchDeps.pushTurnFailed`/`dismissTurnFailed`) is left alone. `buildTurnFailedText`'s hardcoded "Claude stopped" takes an `agentName` defaulting to `'Claude'`.
- Codex mapping (`codex-turns.ts`):
  - `turn/completed status:'completed'`: `turnCompleted` with `elapsedMs = turn.durationMs` and `lastAssistantMessage` = the `agentMessage` with `phase:'final_answer'` from `turn.items` (real frame `expA-accept.jsonl:74`), then `turnSucceeded`.
  - `status:'failed'`: `turnFailed` with `turn.error.message` as `errorDetails` and `codexErrorInfo` as `error` only if it is a string.
  - `status:'interrupted'`: `turnSucceeded` only.
  - Same config gates apply (`on_turn_complete`, `turn_complete_min_seconds`); a failed turn is never muted by `on_turn_complete`, as for Claude.
- `harness_denied` equivalent: deferred. The Guardian frames (`autoApprovalReview/*`, `guardianWarning`) were skipped by the spike, so no real frame exists. Not designed here.

**Chat.**
- The client-facing contract is already neutral: `transcript_content` (`protocol.ts:827-852`, `createTranscriptContent`). Only its producer is Claude-typed (`TranscriptWatcher`/`TranscriptMessageBridge`).
- Minimal seam, shaped by Codex as the Phase-2 ADR said it would be:

```ts
// harness/types.ts (neutral)
export interface HarnessChat {
  /** Replay the thread's history oldest-first. Resolves with the count. */
  readHistory(emit: (m: TranscriptContentMessage) => void): Promise<number>;
}
// HarnessSession gains: readonly chat?: HarnessChat;
// transcript-events.ts gains dep: chatFor?: (remiSessionId: UUID) => HarnessChat | undefined
```

- Live updates stay internal to the harness (it emits `transcript_content` through `ctx.sendAndRecord`), as Claude's binder does.
- Codex source: `thread/items/list {threadId, sortDirection:'asc', limit, cursor}` pages, plus live `item/completed`.
  - `userMessage` becomes role `user`.
  - `agentMessage` becomes role `assistant`.
  - `commandExecution` becomes an assistant `contentBlocks` tool entry (name `shell`).
  - `reasoning` is skipped.
  - Frames for `userMessage` and `agentMessage` are real (`expA-accept.jsonl:35-36,67`).
- `thread/items/list` and `thread/turns/list` are schema-only. Phase 6 gates on a live read. Fallback if it fails: tail the rollout at `thread.path` (known from `thread/started`), not built unless needed.
- History for an exited Codex session is out of scope (a live daemon owns it).

### 2.6 Wire and CLI surface (item 5)

- **`remi codex`**
  - Add `'codex'` to `SUBCOMMAND_LIST` (`arg-parser.ts:10-31`).
  - Stray tokens fall through to `claudeArgs` (field name kept to avoid churn).
  - The parser reads remi flags anywhere before `--` (`:181-187`). Codex flags colliding with remi's (`-h`, `-v`, `--dir`, `--port`, `--resume`...) must be written after `--`.
  - `remi -c` stays Claude's `--continue`.
  - Hidden flag `--harness <id>` (validated by `isHarnessId`; error if it conflicts with the subcommand) is how a child daemon is told its harness.
- **Hub.** The hub stays Claude-only and session-less. A create request with a harness spawns `--daemon --harness <id> -- <args>` with `--` last (so remote args cannot smuggle `--no-auth`), through `spawnRemiDaemon`'s existing `extraArgs` (`daemon-manager.ts:544`).
- **Wire**
  - Dual-emit `harness`/`harnessSessionId` on `hello_ack`, `question` and `DiscoverableSession` (#1165 A).
  - `create_session_request` gains `harness`/`args` (#1165 B), threaded through both transports (`connection.ts:555`, `relay-adapter.ts:588`) and `client-message-events.ts:80,124`.
  - `hello_ack.harnesses` carries the available ids.
- **Web (minimum).** A harness label on the session card and chat header, and the `standingGrant` union value. `Question.answerPath` is not added (no consumer yet).
- **`remi status`/`attach`/`ls`.** Unchanged, except `LiveSessionEntry.harness?` (Phase 5).

---

## 3. Tests, fixtures, live verification (item 6)

### 3.1 Rules applied

- No mock replaces business logic. The transport double is a real WebSocket server speaking real RFC 6455 framing.
- A test named for a component constructs that component. `AppServerClient` tests construct the real client, `CodexDecisions` tests drive the real input handlers and `SessionRegistry`.
- Every test must be able to fail on its claim, so each phase lists its mutation checks.
- CI has no Codex login, so nothing in CI starts Codex.

### 3.2 Fake app-server (`tests/helpers/fake-app-server.ts`, a protocol-speaking replay)

- `Bun.serve({unix, fetch: upgrade, websocket})` in a temp dir, behind a symlink from a fake `CODEX_HOME/app-server-control/app-server-control.sock` to a short path (this exercises resolving the link with `readlink`; `realpath` cannot be used on a socket, see section 1).
- Frames come from redacted spike fixtures. Behavior is modeled only where a spike claim backs it:
  - `initialize` returns the fixture result.
  - `thread/resume` returns the fixture result and subscribes the client. It errors `-32600 no rollout found for thread id X` until `createRollout(threadId)`.
  - A newly subscribed client is replayed pending requests (`expB3.jsonl:49-51`).
  - First response to a request id wins; a `serverRequest/resolved` goes to every subscriber; later responses are dropped silently (`expA-accept.jsonl:51-62`).
  - `thread/started` and `thread/status/changed` are broadcast to all connections; requests only to subscribers.
  - Ids come from a daemon-global counter.
  - `server.dropClient(id)` closes a socket abruptly.
- Test API: `emit(frame, {threadId?, broadcast?})`, `request(frame, threadId)`, `createRollout`, `dropClient`, `received`.
- The model is not remi business logic. Its fidelity to Codex is what the live steps check.

### 3.3 Fixtures (`tests/fixtures/codex-app-server/`, data excluded from line counts)

- One redacted line per frame, `{client, dir, frame}`, with `index.json` recording provenance (spike file, source sha256, extractor version).
- Extractor `scripts/extract-codex-fixtures.ts` (dev tool, not CI) reads `$SPIKE/*.jsonl`.
- Keep an allowlist of methods:
  - `initialize` result, `initialized`.
  - `thread/started` (the TUI one and the title helper from `expB.jsonl:7,12`).
  - `thread/status/changed`, the `thread/resume` result, `thread/closed`, `thread/unsubscribe` result.
  - `item/commandExecution/requestApproval` (accept `expA-accept.jsonl:47`, decline `expA-decline.jsonl:63`, replay `expB3.jsonl:51`).
  - `serverRequest/resolved`, `turn/started`, `turn/completed`, `item/started|completed` (userMessage, agentMessage, commandExecution including `declined`).
  - `item/tool/requestUserInput` (`expC.jsonl:31`).
- The `-32600` error is not in the logs. It is synthesized from the report text and labeled `report-derived`.
- File-change, permissions and elicitation have no real frames. Tests use schema-derived frames labeled `synthetic-from-schema` and assert only no-crash, `terminalOnly` and dismissal.
- Drop: `mcpServer/*`, `account/*`, `remoteControl/*`, `configWarning`, `warning`, `thread/tokenUsage/updated`, `item/reasoning/*`, `*Delta`.
- Placeholders:
  - Ids map to sequential UUID-shaped placeholders (`00000000-0000-7000-8000-00000000000N`).
  - All paths become `/work/project`, `/work/codex-home` and `/work/codex-home/sessions/rollout-T1.jsonl`.
  - Model becomes `test-model`.
  - `userAgent` becomes `remi/0.160.0 (test)`.
  - Drop `installationId`, `serverName`, `planType`, rate limits, `instructionSources` and MCP server names.
  - Keep `cliVersion:"0.160.0"` (the verified version).

**Redaction scan (`fixtures-redaction.test.ts`)** is an allowlist, not a denylist.
- Every absolute path must start with `/work/`.
- Every UUID must be in the placeholder set.
- Fail on `/Users/`, the username, `/private/`, `/var/folders`, `<hostname>`, the terminal emulator's name, `installationId`, `planType`, `eyJ`, `Bearer`, `sk-`, `auth`, `token`, `@`, and on opaque `rs_`/`msg_` ids.
- Mutation check: a seeded fixture copy containing each of those must fail.
- Spike frames the scan must catch (I saw them): `/Users/<user>/.codex/AGENTS.md`, the rollout `path`, `installationId` (a UUID), `serverName`, `userAgent` (it carries the client, the OS version, the CPU architecture and the terminal emulator with its version), `planType`, rate-limit percentages, MCP server names (puppeteer, node_repl, ...), model names (`gpt-...`).

### 3.4 What stays unverified without a real Codex

1. That Codex's server accepts the hand-rolled client's handshake (tungstenite quirks, extension negotiation, keepalive).
2. That bare `codex` auto-starts the shared daemon on a cold start.
3. `cancel` from a second client.
4. What a mid-approval subscriber disconnect does to a pending request. If it cancels the request, remi becomes harmful on any socket blip (R1).
5. `/new` rotation, subagent threads, file-change, permissions and elicitation behavior, async questions.
6. `thread/items/list` and `thread/turns/list` paging, and a failed-turn `turn/completed` frame.
7. `optOutNotificationMethods`.
8. Headless (daemon-mode) startup behavior.

### 3.5 Live verification protocol (owner or a spike agent against the installed Codex, never CI)

Safety rules for any agent driving the TUI:
- Run from a scratch cwd. Never read `~/.codex/auth.json`. Never run `codex login` or `logout`. Do not touch the user's live sessions or processes.
- Before typing any key, screen-scrape the PTY (pyte, as `$SPIKE/tui.py` does) and abort without sending keys if it matches `Update available|enter continue|esc skip|Trust this folder|Update now`.
- Send keys only after `Ask Codex to do anything` is visible. Never send a digit or Enter otherwise. If a modal appears, stop and ask the owner to dismiss it by hand.
- `-c` is not usable to disable the update check (it forces an embedded server), so this screen-scrape is the only guard.
- Model turns cost tokens (the spike used 7 at max effort). Use the smallest prompts.

| Step | Phase | Checks | Cost |
|---|---|---|---|
| LV-1 | 1 | The hand-rolled client does `initialize`, `initialized`, `thread/loaded/list` and `server/diagnostics` against the real socket, idles 120 s (keepalive), and `optOutNotificationMethods` is accepted. Compare the result with the python client. | none |
| LV-2 | 3 | `remi codex` in a scratch dir (a) with the daemon already running and (b), optionally, with it stopped to test auto-start; `thread/started` for cwd within about 2 s; the title-helper thread is ignored; identity recorded after the first message; `thread/resume` retry resolves; no `.claude/settings.local.json` written; the TUI is untouched. | one tiny turn |
| LV-3 | 4 | The epic gate: (a) phone allow runs the command and the overlay closes; (b) the TUI answering first dismisses the phone card; (c) phone No (`cancel`) behaves like the TUI's; (d) a probe client mimicking remi (not remi) is `kill -9`'d while an approval is pending: the TUI overlay must stay up and answerable, and the request must not auto-cancel (R1); (e) `thread/unsubscribe` from remi at exit is harmless. | a few turns |
| LV-4 | 5 | A Codex session created from a hub request in an already-trusted directory reaches the prompt headless. | one launch |
| LV-5 | 6 | `thread/items/list` ascending paging; an interrupted turn and a failed turn (`turn/start` with a bad model) produce the `turn/completed` statuses assumed. | one or two turns |

---

## 4. Phases

Common gate for every phase: `bun run typecheck`, `bunx biome check`, `bun test`, `typos` green; `git diff -U0 -- 'packages/**/*.test.ts' | grep '^-[^-]'` shows imports and one-for-one setup lines only, each disclosed in the PR; the CI run on Bun 1.3.11 passes. Agents are Sonnet only. Line counts are net, non-generated, and tests are counted separately.

### Phase 1: App-server transport and client, no daemon behavior change

Lines: about 500 source, about 120 tooling (extractor), about 700 tests, plus fixture data.

Files to create:
- `harness/codex/{ws-frames,unix-ws,app-server-protocol,app-server-client}.ts`
- `tests/harness/codex/{ws-frames,unix-ws,app-server-client,fixtures-redaction}.test.ts`
- `tests/helpers/{fake-app-server,codex-fixtures}.ts`
- `tests/fixtures/codex-app-server/*`
- `scripts/extract-codex-fixtures.ts`
- `.context/decisions/0033-codex-adapter-app-server.md` (status proposed, with the Bun-pin finding and the §1 evidence)

Files to modify: `tests/harness/harness-boundary.test.ts` (add: nothing under `harness/codex/` may import a Claude module; neutral modules may not import `harness/codex/`).

Deliverables:
1. Codec with RFC 6455 vectors: masked "Hello" `81 85 37 fa 21 3d 7f 9f 4d 51 58`, unmasked `81 05 48 65 6c 6c 6f`, fragmented `01 03 48 65 6c` + `80 02 6c 6f`, ping `89 05 48 65 6c 6c 6f`, 16-bit and 64-bit lengths.
2. `connectUnixWebSocket`.
3. `classifyInbound`.
4. `AppServerClient`.
5. Fake server, fixtures, extractor, redaction scan.
6. Boundary-test amendment.
7. ADR.

DECIDED POLICY:
- Hand-rolled client over `node:net`; no `ws` package; no native `ws+unix` until the pin is >= 1.3.13 and the compile smoke test passes.
- No extensions offered, no `Origin`, `Host: localhost`, path `/`.
- Text frames only (binary dropped with a log); max payload 32 MiB; a violation closes 1002.
- A frame that fails JSON parse is dropped and logged; the read loop never throws.
- The client never answers a server request with an error.
- `clientInfo.name` is `remi` (R8).
- `capabilities` are `{experimentalApi:true, requestAttestation:false}` with no opt-out list until LV-1 confirms it.
- Request ids numeric from 1; timeouts 5 s for initialize, 15 s otherwise.
- Reconnect backoff 250 ms doubling to 5 s forever until `stop()`; log the first failure and then every tenth.

Pin test first: the RFC 6455 vectors, then the integration test against a real `Bun.serve({unix})` WebSocket server (handshake in both directions, ping/pong, close).

Mutation checks (each must fail a named test): a flipped mask bit, a dropped pong, a skipped accept-key check, no request timeout, correlating a response by the wrong id, the client sending an error frame to an unknown server request (assert zero frames sent).

Gate: all tests green on 1.3.11 (CI) and 1.4.2 (local); the redaction scan green and its seeded-leak mutation red; LV-1 passed before Phase 3 starts (Phase 1 itself may merge first).

Agent budget: 1 implementer, 1 reviewer, 1 spike agent for LV-1 (or the owner).

Out of scope: any change to `cli.ts`, stores or protocol.

### Phase 2: Foundations, zero behavior change for Claude

Lines: about 430 source, about 600 tests.

Files to create:
- `session/legacy-writers.ts`
- `harness/codex/codex-args.ts`

Files to modify:
- `session/session-store.ts`
- `session/session-binding-store.ts`
- `harness/types.ts`
- `cli/current-session.ts`
- `cli/handlers/session-events.ts`
- `cli/handlers/transcript-events.ts`
- `cli/session-phases/pty-session-setup.ts`
- `harness/claude-session.ts`
- `cli.ts`
- `tests/harness/harness-boundary.test.ts`

Deliverables:
1. `SessionStore.updateHarnessIdentity(remiSessionId, harness, harnessSessionId): StoredSession | null` (next to `:757`) and `findByHarnessSessionId(harness, id)`. `assertUniqueSessionIdentities` (`:190`) also rejects two active records with the same non-Claude pair. `SessionBindingStore.updateHarnessIdentity`. `preAssign` skips the "index seed deferred" log for non-Claude records (`session-binding-store.ts:134`).
2. Harness-aware reads (#1165 D second half):
   - `--sessions` prints `codex:<8>` for non-Claude records (`cli.ts:708`).
   - `getMostRecent(harness?)`; the call at `cli.ts:730` becomes `getMostRecent('claude')`.
   - `resolveStoredSession(sessions, query, {harness})` matches `claudeSessionId` only among Claude records. A non-Claude record found by remi id or prefix exits 1 with "this session ran under codex: use `remi codex resume <id>`".
3. `session/legacy-writers.ts`:
```ts
export const IDENTITY_SHIM_MIN_VERSION = '0.7.16-dev.7';
export function compareRemiVersion(a: string, b: string): number;   // X.Y.Z[-dev.N]; a release > any dev of the same X.Y.Z; unparsable => -1 (old)
export interface LegacyWriter { source: 'live-session' | 'hub' | 'session-daemon'; pid: number; version: string | undefined }
export function findLegacyWriters(deps: {
  liveSessions: Pick<SessionRegistryFile, 'listLive'>;
  statusFiles: () => Array<{ file: string; pid?: number; version?: string }>;
  isAlive?: (pid: number) => boolean; selfPid: number;
}): LegacyWriter[];
```
   Dead or absent pids are ignored; the caller's own pid is excluded.
4. `Harness.transcriptPath` becomes `string | null` (`types.ts:128`). Claude is unchanged. Adapt `current-session.ts:56-58`, `session-events.ts:149` and the `transcript-events.ts` durable-index load to treat null as "no file". `claude-session.ts` untouched.
5. `createPtySessionForSession` takes `command?: string` (default `'claude'`), `childEnv?: Record<string,string>` (default `buildClaudeChildEnv(wsPort, reservedRows)`), and `outputSink: PtyOutputSink` (`{process(text:string):void; flush():void}`) in place of `outputProcessor` (`:46`); export `NOOP_OUTPUT_SINK`. `claude-session.ts` passes its `OutputProcessor`. `onExit`'s `markClaudeChildExited` is neutral in effect. Boundary-test allowlist: `harness/codex/*` may import `cli/session-phases/pty-session-setup.ts` and nothing else under `cli/session-phases/`. Alternative: `git mv` the file to `pty/`, which renames imports in three tests.
6. #1165 E: move `sessionNotifiers.set(sessionId, notifications)` from `claude-session.ts:217` into `createNewSession` just before `harness.createSession` (`cli.ts:1511`). `ClaudeLaunchDeps.sessionNotifiers` stays as a read-only reference for the lazy `pushTerminalNotice` closures.
7. `validateCodexArgs(args): {ok:true; args; resumeThreadId: string | null} | {ok:false; error}` (pure):
   - **Denylist** (names matched also as `--flag=value`, and any attached short form `-cX`, `-pX`, `-CX`): `-c`, `--config`, `--enable`, `--disable`, `-p`, `--profile`, `--strict-config`, `--dangerously-bypass-hook-trust`, `--no-daemon`, `--search`, `--approve-for-me`, `--remote`, `--remote-auth-token-env`, `--oss`, `--local-provider`, `-C`, `--cd`. `--no-alt-screen` is accepted and deduplicated.
   - **Subcommands:** only `resume <uuid>` is allowed, and it requires an explicit uuid. `fork`, `exec`, `login`, `logout`, `mcp`, `mcp-server`, `app-server`, `proxy`, `completion`, `debug`, `apply`, `cloud`, `sandbox` and `review` are refused ("remi codex runs the interactive TUI only"). Refresh this list from `codex --help` on the owner's installed version at implementation time (I could not run it).
   - **Remote (default-deny, used by Phase 5):** `-m/--model <[A-Za-z0-9._:\[\]-]{1,64}>`, `resume <uuid>`, `-a untrusted|on-request`, `-s read-only|workspace-write`; at most 16 args, at most 256 chars each, no NUL.
   - The working directory is `realpath`-normalized and must exist and be a directory.
8. ADR 0033 amendment.

DECIDED POLICY:
- A refusal, not a second store file, closes the older-daemon hazard.
- `-C/--cd` is denied because identity matching uses the session cwd.
- Local `remi codex` uses a denylist (the user is the principal); remote uses the allowlist.
- A bare prompt positional is passed through.

Pin tests first (before any change):
- Characterize the current mixed-store behavior: a record with `harness:'codex'` and null `claudeSessionId` is returned by `getMostRecent()` today, and `--resume` of it errors "no Claude session ID".
- `launch-characterization.test.ts` and `transcript-path-golden.test.ts` pass unmodified.
- `session-events-harness.test.ts` and `transcript-events-harness.test.ts` stay green (type widening only).
- Add a source-order pin that `sessionNotifiers.set` precedes `harness.createSession` in `cli.ts`, plus a behavioral pin that a real held prompt reaches `sessionNotifiers.get(sid)`.

Mutation checks: version comparison off by one; absent version treated as new; the dead-pid filter removed; `getMostRecent` ignoring its harness filter; each denylist entry removed (one failing case per entry).

Gate: Claude launch characterization unchanged; the new store, gate and args tests green.

Agent budget: 1 implementer, 1 reviewer.

Out of scope: any Codex launch.

### Phase 3: `remi codex` launch, identity and status (observe-only: no cards)

Lines: about 480 source (including about 120 of `cli.ts` and `arg-parser.ts` wiring), about 650 tests.

Files to create: `harness/codex/{thread-protocol,thread-tracker,codex-session,codex}.ts`, `tests/integration/codex-launch-characterization.test.ts`, `tests/harness/codex/thread-tracker.test.ts`.

Files to modify:
- `harness/index.ts` (export `CodexHarness`)
- `cli/arg-parser.ts`
- `cli.ts`
- `tests/integration/hub-test-utils.ts` (`spawnDaemon` optional `extraArgs`; test-helper setup line)
- `tests/harness/harness-boundary.test.ts`

Deliverables:
1. `'codex'` subcommand and hidden `--harness <id>` flag (§2.6).
2. `harnessId` in `cli.ts` (`parsedArgs.harness ?? (cliSubcommand==='codex' ? 'codex' : 'claude')`; top-level `validateCodexArgs` exits 2). Harness construction: keep `const claudeHarness = new ClaudeHarness(...)` at `:1730`, add `const codexHarness = harnessId==='codex' ? new CodexHarness(...) : undefined`, `const harness: Harness = codexHarness ?? claudeHarness`, and switch `onTurnStop` to `claudeHarness.admitsAnySession` (`:1263`).
3. Gate the Claude-only startup on `harnessId==='claude'`: both hook-server/`HookConfigManager` blocks (`:2399-2450`, `:2618-2650`), `installStatusLine` (`:2301`, `:2542`), and the reserved status row (`reservedRows=0` for Codex). `remi codex --host ...` is refused until Phase 5.
4. `ThreadTracker` per §2.3 (identity, retry, rotation, descendants, claimed-by-others from active non-Claude store records).
5. `createCodexSession` per §2.3. Status mapping through `messageApi.handleStatusChange`: `active` with flags -> `'waiting'`; `active` without flags -> `'thinking'`; `idle`, `notLoaded`, `systemError` -> `'idle'`. Status is for the tracked thread and descendants only.
6. 30 s link-unavailable watchdog (one log plus one system message).
7. Socket trust check (§2.3), applied inside the client's `socketPath()`.

DECIDED POLICY:
- remi never starts the daemon (§2.3).
- One `thread/resume` shape, no overrides.
- No rotation while the tracked thread is `active`.
- The daemon-mode launch passes no args until Phase 5.
- remi logs thread ids truncated to 8 characters and never logs thread frames of other threads.

Pin test first: `launch-characterization.test.ts` (Claude) passes unmodified before and after the `cli.ts` gating. Then write `codex-launch-characterization.test.ts` first against the spec, with the same shape (real `cli.ts --daemon --harness codex` in an isolated `$HOME`, an executable fake `codex` on PATH recording argv, cwd and env, the fake app-server on a symlinked `CODEX_HOME`, and the test playing the TUI by emitting the real `thread/started`/status frames). It asserts:
- argv is exactly `--no-alt-screen` (and `--no-alt-screen resume <uuid>` for a resume).
- No `.claude/settings.local.json` is written.
- `sessions.json` holds `{harness:'codex', claudeSessionId:null}`, gains `harnessSessionId` after the TUI-thread frame, and ignores the title-helper frame.
- The first `thread/resume` frame is exactly `{threadId, excludeTurns:true}`, is retried on the synthesized `-32600`, and succeeds after `createRollout`.
- The `waitingOnApproval` status becomes status `waiting`.
- The fake `codex`'s stdin receives zero bytes.
- The daemon exits when the fake codex exits.
- A legacy live-sessions entry makes it refuse with exit 1 before any record is written.

Mutation checks: cwd rule removed (binds the helper), `ephemeral` check removed, `threadSource` check removed, override params added to `thread/resume`, retry removed, the legacy gate removed.

Gate: both characterization tests green; LV-2 passed.

Agent budget: 1 implementer, 1 reviewer, 1 spike agent for LV-2 (one tiny turn).

Out of scope: cards, answers, chat, turn pushes, wire fields.

### Phase 4: Approvals reach the phone and the phone's answer closes the overlay (the epic gate)

Lines: about 450 source, about 700 tests.

Files to create:
- `harness/codex/{approval-cards,codex-decisions}.ts`
- `tests/harness/codex/{approval-cards,codex-decisions,codex-first-answer-wins}.test.ts`

Files to modify:
- `harness/codex/codex-session.ts` (wire `CodexDecisions`, `present = messageApi.handleQuestion(q,{held:true})`, `setQuestionEvictionGuard(sessionId, id => decisions.isHeld(id))`, and `tracker.onNotification` into `handleResolved`/`handleStatus`/`handleDisconnected`/`handleReattached`)
- `harness/types.ts` (`HarnessSession.acceptsTypedChat?`)
- `cli/handlers/input-events.ts` (typed-chat refusal at `~1272`; dep wired from `harnessSessions.get(id)?.acceptsTypedChat` in `cli.ts`)
- `shared/src/types.ts:389` and `web/src/types/index.ts:204` (`standingGrant` union plus `'session'`)
- `AGENTS.md` (a "Codex" subsection stating only what is verified)

Deliverables: §2.4 in full.

DECIDED POLICY (all in §2.4, restated as the checklist the reviewer uses):
- Command approvals only are actionable.
- The No decision is `cancel`, with the live fallback to `decline`.
- Object-form decisions are never offered.
- The client never answers a request it does not handle.
- Cards are retired on disconnect and re-created from replay.
- `answerHeld` is never `unknown` for a known id.
- Phone chat typing is refused with `INPUT_NOT_DELIVERED`.
- `held` is stamped so the push always goes to the lock screen and free text is refused.
- A terminal-answered request dismisses the card with reason `'cancelled'`, for parity with Claude's terminal answers.

Pin tests first:
- A golden table of real fixture frames to `Question` JSON (accept `:47`, decline `:63`, replay `expB3.jsonl:51`, user-input `expC.jsonl:31` as `terminalOnly`).
- The lock-screen pin: `[Yes, No]` -> `REMI_YN`; `[Yes, Yes for this session, No]` -> no category and no `dynOptions`; a `terminalOnly` card -> none.
- Typed-bytes-zero: with the real handlers and a fake `codex` child that records stdin, send every answer, cancel, free-text and chat variant through `onAnswer`/`onUserInput` and assert the child's stdin stays empty (only an explicit `raw` write reaches it).

Scenario tests (real `SessionRegistry`, real input handlers, fake app-server): phone accepts first; terminal answers first and the card clears on every client with `question_resolved`; a late phone answer gets `STALE_ANSWER` from the real handler; the server drops the socket mid-approval, the card is retired, and the replay after reconnect creates a new card whose answer works; a request resolved while disconnected is swept after the replay window; two sequential requests with distinct daemon-global ids; terminalOnly cards refuse everything but Cancel and never type Esc.

Mutation checks: `answerHeld` returning `'unknown'` for a known id, sending an unlisted decision, offering an object-form decision, the No mapping, correlation by id alone, not retiring on disconnect, the replay-window sweep removed, the typed-chat refusal removed, `held` unstamped.

Gate: all of the above green, plus LV-3 (a) through (e), run before merge. If LV-3(d) shows a dropped subscriber cancels or declines the pending request, do not merge: redesign around fewer reconnects and report to the owner.

Agent budget: 1 implementer, 2 reviewers (one security-focused on "never answers what it does not decide" and typed bytes), 1 spike agent for LV-3.

Out of scope: file-change, permissions, user-input and elicitation answering; subagent answering; chat history; turn pushes.

### Phase 5: Wire, CLI surface, web label

Lines: about 480 source, about 600 tests, plus regenerated golden fixtures (additions only).

Files to create: none. `tests/` additions only.

Files to modify:
- `shared/src/protocol.ts`
- `shared/src/index.ts`
- `daemon/src/cli/handlers/{create-session-events,connection-events,session-events,resume-session-events}.ts`
- `daemon/src/server/connection.ts` (`:555`)
- `daemon/src/server/client-message-events.ts` (`:80,124`)
- `daemon/src/remote/relay-adapter.ts` (`:588`)
- `daemon/src/cli/remote-new-client.ts`
- `daemon/src/cli/arg-parser.ts`
- `daemon/src/cli.ts` (`createNewSession` at `:2450` receives `explicitArgs`; `liveSessionsRegistry.register` adds `harness`; the `--host` path accepts `codex`)
- `daemon/src/session/session-registry-file.ts` (optional `harness`)
- `daemon/src/cli/handlers/message-api-setup.ts` (identity dep for `question`)
- `web/src/types/index.ts`, `web/src/components/session/SessionCard.tsx`, `web/src/components/chat/ChatHeader.tsx`
- `shared/tests/harness.test.ts` (the one deliberate change: it currently asserts the factories emit neither identity key)
- `tests/macos-fixture-conformance.test.ts` stays green

Deliverables (#1165 A and B):
1. Dual-emit `harness` and `harnessSessionId` on `hello_ack`, `question` and `DiscoverableSession`. For Claude `harnessSessionId` equals `claudeSessionId`, including null. For Codex `claudeSessionId` is omitted and `harnessSessionId` is null until learned. The first production caller of `getIdentity` is the session-list decoration. Client-to-daemon messages keep echoing only `claudeSessionId` (the Worker rebuilds the answer from a fixed list, `connection-room.ts:124-176`; no new client-to-daemon fields). Regenerate goldens with `generate.ts` then `bunx biome check --write packages/shared/tests/fixtures/protocol/`; the diff must be additions only.
2. `create_session_request.harness?: HarnessId`, `.args?: readonly string[]`; `hello_ack.harnesses?: readonly HarnessId[]` on every ack including the hub's session-less one (`connection-events.ts:181`), so a new client can detect an old hub that would ignore `harness:'codex'` and start Claude. Availability = the command resolves on PATH.
3. Trust-boundary validation: `isHarnessId`; registry membership (unavailable returns `create_session_response{success:false}` without spawning); `args` rules from the Phase 2 remote list for Codex and #1165's Claude allowlist; the legacy-writer gate before a Codex spawn.
4. `explicitArgs` (tokens after `--` only) added to the parser and passed to `createNewSession` in daemon mode; stray tokens stay ignored so existing LaunchAgent plists do not change.
5. Child spawn appends `--harness <id>` and then `-- <args>` last.
6. `remote-new-client.ts` gets a real sender (`remi codex --host` and `remi new --host --harness codex`), so the conformance test is two-sided (ADR 0014) over both transports.
7. Refuse `resume_session_request` on a non-Claude daemon with `UNSUPPORTED`, like the hub (`resume-session-events.ts`).
8. Web: harness label on the session card and chat header; no other UI.

DECIDED POLICY:
- Identity may be null on a hello_ack sent before the thread id is learned. Nothing depends on it, because answers are addressed by `questionId`.
- The hub stays Claude-only and session-less.
- `Question.answerPath` is not added.

Pin tests first: the additive-golden regeneration (diff reviewed as additions only), and a test that Claude's hello_ack, question and session list are unchanged except the added fields.

Mutation checks: `--` placed before `--harness`, a Claude allowlist entry removed, `harnesses` missing from the session-less ack, `harnessSessionId` diverging from `claudeSessionId`.

Gate: conformance tests green on both transports; LV-4 (headless launch) passed.

Agent budget: 1 implementer, 1 reviewer.

Out of scope: profiles, OpenCode, a typed chat path for Codex, hub-spawned `resume`.

### Phase 6: Turn events and chat

Lines: about 470 source, about 600 tests.

Files to create:
- `notifications/turn-events.ts`
- `harness/codex/{codex-turns,codex-chat}.ts`
- `tests/notifications/turn-events.test.ts`
- `tests/harness/codex/{codex-turns,codex-chat}.test.ts`

Files to modify:
- `cli.ts` (`onTurnStop` calls the sink)
- `notifications/turn-failed.ts` (`agentName`, default `'Claude'`)
- `harness/types.ts` (`HarnessChat`, `HarnessSession.chat?`)
- `cli/handlers/transcript-events.ts` (`chatFor` dep)
- `harness/codex/codex-session.ts`
- `tests/harness/harness-boundary.test.ts` (debt list unchanged)

Deliverables: §2.5.

DECIDED POLICY:
- Same config gates as Claude for turn-complete.
- A failed Codex turn pushes "Codex stopped".
- Chat history is read from the app-server, not the rollout.
- History exists only for live sessions.

Pin tests first: pure tests of `shouldNotifyTurnComplete`/`buildTurnCompleteText` pass unmodified; add a source-wiring pin (the repo's idiom) that `onTurnStop` keeps the admits filter and calls the sink; then the sink tests, then Codex mapping tests on real `turn/completed` frames (`expA-accept.jsonl:74`, `expA-decline.jsonl:141`).

Mutation checks: the `admitsAnySession` filter removed from `onTurnStop`, wrong `final_answer` item chosen, `interrupted` pushing, `failed` not pushing, history order reversed.

Gate: green, plus LV-5.

Agent budget: 1 implementer, 1 reviewer, 1 spike agent for LV-5.

Out of scope: a `harness_denied` equivalent, subagent chat, exited-session history.

---

## 5. Security and privacy (item 8)

- **Credentials.** remi never reads, stores, copies, prints or relays `~/.codex/auth.json` or any token. The client holds none. `account/chatgptAuthTokens/refresh` and `attestation/generate` server requests are ignored without logging params. The client never logs frame bodies, only method names and truncated ids.
- **Other threads' metadata.** Codex broadcasts `thread/started` and `thread/status/changed` to every connection, and `thread/resume` results carry `preview` (the first user message). remi uses frames only for its own tracked thread and descendants; it never logs, stores or relays other threads' frames.
- **Fixtures.** The extractor, redaction allowlist and seeded-leak mutation in §3.3. Reviewers diff the fixture directory by eye before merge.
- **Socket.** Both directories are mode 0700 and owned by the user, so only the same OS user connects. The socket itself has no authentication, so any same-user process can answer approvals; that is Codex's property. remi adds the phone as a principal, as for Claude. remi refuses a socket whose directory is not owned by the current uid or has group/other bits.
- **The Update modal hazard.** remi never types into a Codex PTY on its own: `acceptsTypedChat:false`, no `screen`, `answerHeld` never `unknown` for Codex ids, and the typed-bytes-zero pin. Raw input comes only from a person (attach, web Esc, Telegram `/interrupt`). The live steps follow the screen-scrape rule in §3.5.
- **Push text.** A Codex approval push carries the command (up to 120 characters in the title, 200 in the body). It travels in plaintext to the signaling Worker and APNS, the same posture as Claude permission cards, `turn_complete` and `turn_failed` (AGENTS.md "Push text is plaintext to the Worker and APNS"). The fix is outside this epic: relay E2E (#881, still open and the relay is latent) and push encryption (strategy §9 item 4). Codex adds no new exposure class but raises volume. Commands can embed secrets, so the owner may want a per-class option (open call 12). cwd is not in the push.
- **Originator.** If remi initializes before the TUI on a fresh daemon, the daemon's global originator may read "remi" on the user's later threads (R8).

---

## 6. Risks, open calls, unverified

### 6.1 Facts that would break the plan if wrong

| # | Fact assumed | Check | If wrong |
|---|---|---|---|
| R1 | A non-answering subscriber disconnecting does not cancel the pending request | LV-3(d) | Do not ship Phase 4; remi becomes harmful on any socket blip. Redesign to minimize reconnects and tell the owner. |
| R2 | Bare `codex` auto-starts the shared daemon (`daemon_auto_start`, the lock file dated Sep 25) | LV-2(b) | The watchdog fires and approvals never arrive. Fallbacks: run `codex app-server daemon start` before spawn, or spawn with `--remote unix://<socket>` (verified shared in the spike). Owner pick. |
| R3 | A hand-rolled client interoperates with Codex's server | LV-1 | Fix the codec, or move the pin to >= 1.3.13 and use native `ws+unix`. |
| R4 | cwd plus `threadSource`/`ephemeral`/time identifies the TUI thread and `/new` rotates | LV-2, tests | Fail closed (no identity, no cards, logged). A non-remi TUI in the same cwd started in the same window is a residual. |
| R5 | `cancel` from a second client resolves the request like the TUI's No | LV-3(c) | Flip the No mapping to `decline` (listed or not). |
| R6 | `thread/items/list` pages history | LV-5 | Fall back to the rollout at `thread.path`. |
| R7 | A headless Codex launch reaches the prompt | LV-4 | The Trust and Update modals block with nobody to answer. Mitigation: the hub advertises `codex` only after LV-4, and a user can `remi attach`. |
| R8 | `clientInfo.name` does not become the daemon's global originator for later TUI threads | Check `originator` after remi connects first | Delay the first connect about 1.5 s after the first PTY output so the TUI initializes first, or rename the client. |
| R9 | Schema drift under `experimentalApi:true` (CLI and daemon already differ by a patch version) | Fixtures versioned to 0.160.0; narrow parsers ignore unknown fields | Parsers fail closed to `terminalOnly` cards rather than dropping requests. |
| R10 | Request ids are unique per daemon lifetime only | Spike (ids 1, 2, 5, 6 across runs) | Already handled by the `(threadId, requestId)` key and retire-on-disconnect. |
| R11 | Push text is plaintext | AGENTS.md; #881 | Owner decision on a per-class option. |
| R12 | The older-daemon gate sees every legacy writer | Phase 2 tests | An older CLI binary elsewhere and an unregistered process slip through. Fall back to the sidecar identity file. |
| R13 | The reserved status row works with Codex | Not attempted (`reservedRows=0`) | n/a; revisit only if wanted. |
| R14 | Live runs cost tokens | n/a | Use the smallest prompts. |

### 6.2 Judgment calls I resolved unilaterally (owner can veto)

1. Hand-rolled WebSocket client now, native later, no new dependency.
2. Chat source is the app-server's paged items, not the rollout (contradicts strategy:96; schema evidence only).
3. `thread/resume` carries no overrides, ever.
4. Phone "No" sends `cancel` (decline as fallback).
5. Only command approvals are actionable in v1; everything else is a `terminalOnly` card that still notifies and dismisses.
6. Object-form decisions (persistent policy amendments) are never offered from the phone.
7. Phone chat typing to Codex is refused (`INPUT_NOT_DELIVERED`), not routed through `turn/start`.
8. remi never starts or stops the daemon; if R2 fails the fallback is run `daemon start` or `--remote` (owner picks).
9. `remi codex` accepts only the interactive TUI and `resume <uuid>`; `fork` and `resume --last`/picker are refused; `-C/--cd` is denied.
10. Local `remi codex` args use a denylist; remote args use a default-deny allowlist.
11. The older-daemon hazard is closed by refusing to start, not by a second store file.
12. Lock-screen `REMI_YN` applies to Codex `[Yes, No]` cards at parity with Claude, unless the owner wants no category.
13. `reservedRows=0` and no status bar for Codex.
14. Cards are retired on any disconnect and re-created from replay (new ids).
15. A terminal-answered Codex request dismisses with reason `'cancelled'`.
16. `harness_denied` equivalent is out of scope until Guardian frames are captured.
17. `hello_ack.harnesses` advertises `codex` by PATH presence; the owner may want it gated until LV-4.
18. The `standingGrant: 'session'` union value.

### 6.3 What I could not verify

- Anything about Codex at runtime beyond the spike's frames.
- The Bun 1.3.11 behavior of `node:net` over a unix socket and of the hand-rolled codec (no experiment; read-only mode). The Phase 1 tests are the first proof.
- The installed `codex --help` subcommand list.
- Whether bare `codex` auto-starts the daemon.
- iOS handling of an unknown `standingGrant` value. It travels only in the web path, and iOS reads push option labels.
- The `-32600` error text beyond the spike report (not in the committed logs).

---

### Critical Files for Implementation

- `packages/daemon/src/harness/types.ts`
- `packages/daemon/src/cli.ts`
- `packages/daemon/src/harness/claude-session.ts`
- `packages/daemon/src/cli/handlers/input-events.ts`
- `packages/daemon/src/cli/session-phases/pty-session-setup.ts`