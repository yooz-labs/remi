/**
 * Regression tests for #730: `AutoApproveService` is a DAEMON-WIDE singleton
 * shared by every session's `AutoApproveGate` (one eval slot, one FIFO queue,
 * one GPU). Before this fix, nothing in the shared slot/queue bookkeeping knew
 * which SESSION an eval belonged to:
 *
 *   - BUG 1: `AutoApproveGate.cancelStale` aborted only the session's own
 *     RUNNING eval, never drained the session's own QUEUED waiters -- a moot
 *     queued eval (for ended/resolved work) could still be promoted onto the
 *     GPU and delay a live request.
 *   - BUG 2: `evalId` is stamped per-gate (`AutoApproveGate.evalSeq`), so two
 *     DIFFERENT sessions can legitimately stamp the same number; a targeted
 *     cancel/drain had no session identity to disambiguate them.
 *   - BUG 3: `cancelStale`'s untargeted (no evalId) cancel matched "whatever
 *     eval is running" with no session check at all -- one session's
 *     SessionEnd could abort a completely different session's live eval.
 *
 * Uses a REAL `AutoApproveService` against a real gated `Bun.serve` fixture
 * (same pattern as serialize.test.ts) -- no mocks. The final two tests drive
 * TWO real `AutoApproveGate` instances sharing ONE real `AutoApproveService`,
 * mirroring the actual daemon-wide singleton wiring (hook-bridge-setup.ts),
 * to prove the fix end-to-end through the real `cancelStale` call path.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { AutoApproveGate } from '../../src/auto-approve/auto-approve-gate.ts';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

interface GatedServer {
  url: string;
  /** Count of inbound LLM requests seen so far. */
  requestCount: () => number;
  /** Resolves the next time a request enters the server. Grab BEFORE the call. */
  awaitNextRequest: () => Promise<void>;
  /** Release the oldest held request with a valid approve response. */
  releaseNext: () => void;
  /** Release ALL currently-held requests (incl. ones whose client aborted --
   *  a cancelled eval still leaves its server-side handler unresolved). */
  releaseAll: () => void;
  stop: () => void;
}

function startGatedServer(): GatedServer {
  let count = 0;
  const held: Array<(r: Response) => void> = [];
  let nextResolver: (() => void) | null = null;
  let next: Promise<void> = new Promise<void>((r) => {
    nextResolver = r;
  });
  const approve = (): Response =>
    new Response(
      JSON.stringify({
        choices: [{ message: { content: '{"decision":"approve","reasoning":"ok"}' } }],
        model: 'test-model',
      }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  const server = Bun.serve({
    port: 0,
    fetch: (): Promise<Response> => {
      count++;
      nextResolver?.();
      next = new Promise<void>((r) => {
        nextResolver = r;
      });
      return new Promise<Response>((resolve) => {
        held.push(resolve);
      });
    },
  });
  return {
    url: `http://localhost:${server.port}/v1`,
    requestCount: () => count,
    awaitNextRequest: () => next,
    releaseNext: () => {
      const r = held.shift();
      if (r) r(approve());
    },
    releaseAll: () => {
      while (held.length > 0) {
        held.shift()?.(approve());
      }
    },
    stop: () => server.stop(true),
  };
}

function makeConfig(server: GatedServer): AutoApproveConfig {
  return {
    enabled: true,
    provider: server.url,
    model: 'test-model',
    api_key: '',
    base_url: server.url,
    timeout: 30,
    log_decisions: false,
    allow: [],
    deny: [],
    approve_groups: [],
    deny_groups: [],
    instructions: '',
    multichoice: 'skip',
    multichoice_model: '',
    escalate_model: '',
    escalate_timeout: 0,
    queue_timeout: 240,
    disable_thinking: false,
    always_escalate_tools: [],
    hold_timeout: 0,
    push_hold_timeout: 0,
    delivery_confirm_timeout: 0,
    hold_unconfirmed_timeout: 0,
  };
}

const noLog = (_msg: string): void => {};

describe('AutoApproveService scope isolation (#730)', () => {
  let server: GatedServer;

  beforeEach(() => {
    server = startGatedServer();
  });
  afterEach(() => {
    server.stop();
  });

  test("cancel(reason, undefined, scope) aborts only that scope's running eval (#730 BUG 3)", async () => {
    const svc = new AutoApproveService(makeConfig(server), noLog);
    const r1 = server.awaitNextRequest();
    // Scope A's eval acquires the slot; scope B's queues behind it.
    const aP = svc.evaluate(
      'Bash',
      { command: 'cmdA' },
      undefined,
      undefined,
      undefined,
      undefined,
      'session-A',
    );
    const bP = svc.evaluate(
      'Bash',
      { command: 'cmdB' },
      undefined,
      undefined,
      undefined,
      undefined,
      'session-B',
    );
    await r1;
    expect(server.requestCount()).toBe(1); // only A reached the LLM; B is queued

    // A scoped, untargeted (no evalId) cancel for session B must NOT touch
    // session A's running eval -- the old code had no scope check at all.
    expect(svc.cancel('SessionEnd', undefined, 'session-B')).toBe(false);

    // Grab the "next request" listener BEFORE triggering the cancel that
    // frees the slot (matches serialize.test.ts's ordering) -- otherwise B's
    // request can reach the server in the window before we start listening.
    const r2 = server.awaitNextRequest();
    // The scoped cancel for session A DOES abort it.
    expect(svc.cancel('SessionEnd', undefined, 'session-A')).toBe(true);
    const a = await aP;
    expect(a.decision).toBe('cancelled');

    // B is granted the freed slot and completes normally -- untouched.
    await r2;
    expect(server.requestCount()).toBe(2);
    // releaseAll (not releaseNext): A's aborted fetch left its server-side
    // handler unresolved (orphaned in `held`); releaseNext() would pop that
    // stale holder instead of B's real one.
    server.releaseAll();
    const b = await bP;
    expect(b.decision).toBe('approve');
  });

  test("drainScope(scope) drains only that scope's queued waiters (#730 BUG 1)", async () => {
    const svc = new AutoApproveService(makeConfig(server), noLog);
    const r1 = server.awaitNextRequest();
    const running = svc.evaluate(
      'Bash',
      { command: 'running' },
      undefined,
      undefined,
      undefined,
      undefined,
      'holder',
    );
    const aQ1 = svc.evaluate('Bash', { command: 'aQ1' }, undefined, undefined, undefined, 101, 'A');
    const aQ2 = svc.evaluate('Bash', { command: 'aQ2' }, undefined, undefined, undefined, 102, 'A');
    const bQ1 = svc.evaluate('Bash', { command: 'bQ1' }, undefined, undefined, undefined, 201, 'B');
    await r1;
    expect(server.requestCount()).toBe(1); // only 'running' reached the LLM

    expect(svc.drainScope('A')).toBe(2);
    const a1 = await aQ1;
    const a2 = await aQ2;
    expect(a1.decision).toBe('escalate');
    expect(a2.decision).toBe('escalate');
    // Distinct reasoning from a global force-release drain (#730): a log
    // reader must never be told "remi unstick" for a scoped session drain.
    expect(a1.reasoning).toContain('session queue drained');
    expect(a1.reasoning).not.toContain('remi unstick');
    expect(server.requestCount()).toBe(1); // neither A waiter ever reached the LLM

    // B's queued waiter is untouched: once the running eval releases, B is
    // granted the slot in turn and completes normally.
    const r2 = server.awaitNextRequest();
    server.releaseNext();
    expect((await running).decision).toBe('approve');
    await r2;
    expect(server.requestCount()).toBe(2);
    server.releaseNext();
    const b = await bQ1;
    expect(b.decision).toBe('approve');
  });

  test('drainScope(scope, {mainOnly:true}) spares a subagent-tagged queued waiter (#711/#730)', async () => {
    const svc = new AutoApproveService(makeConfig(server), noLog);
    const r1 = server.awaitNextRequest();
    const running = svc.evaluate(
      'Bash',
      { command: 'running' },
      undefined,
      undefined,
      undefined,
      undefined,
      'holder',
    );
    const mainQ = svc.evaluate(
      'Bash',
      { command: 'main' },
      undefined,
      undefined,
      undefined,
      301,
      'A',
      false,
    );
    const subQ = svc.evaluate(
      'Bash',
      { command: 'sub' },
      undefined,
      undefined,
      undefined,
      302,
      'A',
      true,
    );
    await r1;
    expect(server.requestCount()).toBe(1);

    expect(svc.drainScope('A', { mainOnly: true })).toBe(1);
    const mainResult = await mainQ;
    expect(mainResult.decision).toBe('escalate');

    // The subagent-tagged waiter is spared -- still queued, not settled.
    let subSettled = false;
    void subQ.then(() => {
      subSettled = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(subSettled).toBe(false);

    // Release the running eval; the subagent waiter is granted next and
    // completes normally, proving it was never dropped.
    const r2 = server.awaitNextRequest();
    server.releaseNext();
    expect((await running).decision).toBe('approve');
    await r2;
    server.releaseNext();
    expect((await subQ).decision).toBe('approve');
  });

  test("evalId collision across scopes: a targeted cancel from scope B never touches scope A's same-numbered eval (#730 BUG 2)", async () => {
    const svc = new AutoApproveService(makeConfig(server), noLog);
    const r1 = server.awaitNextRequest();
    // Both scopes independently stamp evalId 1 -- exactly how two
    // AutoApproveGate instances behave today (evalSeq is per-gate).
    const aP = svc.evaluate('Bash', { command: 'cmdA' }, undefined, undefined, undefined, 1, 'A');
    const bP = svc.evaluate('Bash', { command: 'cmdB' }, undefined, undefined, undefined, 1, 'B');
    await r1;
    expect(server.requestCount()).toBe(1); // A holds the slot; B (evalId 1 too) is queued

    // Session B answers its own question (evalId 1): must drop ONLY B's
    // queued waiter, never A's running eval of the same numbered id.
    expect(svc.cancel('user-answered', 1, 'B')).toBe(true);
    const b = await bP;
    expect(b.decision).toBe('escalate');
    expect(server.requestCount()).toBe(1); // B never reached the LLM

    // A's running eval (also evalId 1) is untouched -- completes normally.
    server.releaseNext();
    const a = await aP;
    expect(a.decision).toBe('approve');
  });
});

describe('AutoApproveGate cross-session isolation via shared AutoApproveService (#730)', () => {
  let server: GatedServer;
  let tracker: QuestionPresenceTracker;
  // SessionRegistry allows only ONE session per instance (throws otherwise --
  // see session-registry.ts), so two concurrent sessions each get their OWN
  // registry (mirrors the existing "per-session isolation" pattern in
  // auto-approve-gate.test.ts). Both share the ONE real AutoApproveService
  // under test, exactly like the daemon-wide singleton in production
  // (hook-bridge-setup.ts).
  let registries: SessionRegistry[];

  function fakePTY(): PTYSession {
    return {
      id: generateId(),
      isRunning: true,
      write: () => {},
      submitInput: async () => {},
      close: async () => {},
    } as unknown as PTYSession;
  }

  function pr(cmd: string): PermissionRequestHookInput {
    return {
      session_id: 'claude-test',
      transcript_path: '/tmp/t.jsonl',
      cwd: '/d',
      permission_mode: 'default',
      hook_event_name: 'PermissionRequest',
      tool_name: 'Bash',
      tool_input: { command: cmd },
    };
  }

  function makeGate(service: AutoApproveService, sid: UUID): AutoApproveGate {
    const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registries.push(registry);
    registry.registerSession(sid, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    return new AutoApproveGate(
      {
        service,
        sessionRegistry: registry,
        tracker,
        isInSubagentContext: () => false,
        escalate: () => generateId(),
      },
      sid,
    );
  }

  beforeEach(() => {
    server = startGatedServer();
    registries = [];
    tracker = new QuestionPresenceTracker(() => {});
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    server.stop();
    await Promise.all(registries.map((r) => r.shutdown()));
  });

  test("cancelStale never touches a sibling session's QUEUED eval (#730 cross-session isolation)", async () => {
    const service = new AutoApproveService(makeConfig(server), noLog);
    const SID_A = generateId() as UUID;
    const SID_B = generateId() as UUID;
    const gateA = makeGate(service, SID_A);
    const gateB = makeGate(service, SID_B);

    // A's eval acquires the only GPU slot.
    const rA = server.awaitNextRequest();
    const pendingA = gateA.resolvePermission(pr('echo a'));
    await rA;
    expect(server.requestCount()).toBe(1);

    // B's eval queues behind A -- never reaches the LLM.
    const pendingB = gateB.resolvePermission(pr('echo b'));
    await new Promise((r) => setTimeout(r, 20));

    // Grab the "next request" listener BEFORE the teardown that frees the
    // slot (matches serialize.test.ts's ordering) -- otherwise B's request
    // can reach the server in the window before we start listening.
    const rB = server.awaitNextRequest();

    // Session A tears down: its OWN running eval is cancelled and its own
    // (empty) queue is drained. Session B's merely-queued eval must survive.
    gateA.cancelStale('SessionEnd');
    expect(await pendingA).toBe('passthrough');

    // B is promoted once A's slot frees and gets a REAL LLM verdict -- proof
    // it was never swept up by A's teardown (a drained eval never reaches
    // the LLM at all).
    await rB;
    expect(server.requestCount()).toBe(2);
    // releaseAll (not releaseNext): A's aborted fetch left its server-side
    // handler unresolved (orphaned in `held`); releaseNext() would pop that
    // stale holder instead of B's real one.
    server.releaseAll();
    expect(await pendingB).toBe('allow');
  });

  // This single scenario proves BOTH named bugs end-to-end: A's own QUEUED
  // eval is drained by A's cancelStale and never reaches the LLM (BUG 1 --
  // requestCount stays 1), while B's RUNNING eval survives A's untargeted
  // SessionEnd cancel (BUG 3).
  test("cancelStale drains its OWN queued eval (#730 BUG 1) and spares a sibling's RUNNING eval (#730 BUG 3)", async () => {
    const service = new AutoApproveService(makeConfig(server), noLog);
    const SID_A = generateId() as UUID;
    const SID_B = generateId() as UUID;
    const gateA = makeGate(service, SID_A);
    const gateB = makeGate(service, SID_B);

    // B's eval runs FIRST and holds the only GPU slot.
    const rB = server.awaitNextRequest();
    const pendingB = gateB.resolvePermission(pr('echo b'));
    await rB;
    expect(server.requestCount()).toBe(1);

    // A's eval queues behind B, then A's session ends before its own eval
    // ever ran.
    const pendingA = gateA.resolvePermission(pr('echo a'));
    await new Promise((r) => setTimeout(r, 20));

    // The old untargeted `service.cancel(reason)` matched "whatever is
    // running" with no session check -- it would have aborted session B's
    // live eval here. The fix scopes the cancel to session A.
    gateA.cancelStale('SessionEnd');
    expect(await pendingA).toBe('passthrough'); // A's own queued eval drained

    // Session B's eval was NEVER aborted: it resolves to a REAL verdict. (An
    // aborted eval can only resolve 'cancelled' -> 'passthrough', never
    // 'allow'.)
    server.releaseNext();
    expect(await pendingB).toBe('allow');
    expect(server.requestCount()).toBe(1); // B was never retried or re-run
  });
});
