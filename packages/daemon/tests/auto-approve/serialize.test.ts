/**
 * Tests for AutoApproveService eval serialization (#551).
 *
 * Concurrent permission evals run ONE at a time (one GPU): a second request
 * that arrives while the first is in flight QUEUES and gets its own real
 * decision instead of escalating-on-busy (the regression that produced 496
 * "Concurrent evaluation blocked" escalations in a live log). A waiter that
 * sits in the queue past `queue_timeout` escalates gracefully so a deep burst
 * never risks the Claude Code hook budget.
 *
 * Uses a local Bun.serve gate fixture that holds each request until released
 * (a real server, no mocks) so serialization is observed deterministically by
 * counting inbound LLM requests.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { AutoApproveService } from '../../src/auto-approve/auto-approve-service.ts';
import type { AutoApproveConfig } from '../../src/auto-approve/types.ts';

interface GatedServer {
  url: string;
  /** Count of inbound LLM requests seen so far. */
  requestCount: () => number;
  /** Resolves the next time a request enters the server. Grab BEFORE the call. */
  awaitNextRequest: () => Promise<void>;
  /** Release the oldest held request with a valid approve response. */
  releaseNext: () => void;
  /** Release ALL currently-held requests (incl. ones whose client aborted). */
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

let gate: GatedServer;
beforeEach(() => {
  gate = startGatedServer();
});
afterEach(() => {
  gate.stop();
});

function makeConfig(overrides?: Partial<AutoApproveConfig>): AutoApproveConfig {
  return {
    enabled: true,
    // provider = the bare URL: resolveProviderUrl returns it as-is, so the
    // OpenAI-compat path posts to the local gate (same trick as cancel.test).
    provider: gate.url,
    model: 'test-model',
    api_key: '',
    base_url: gate.url,
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
    ...overrides,
  };
}

const noLog = (_msg: string): void => {};

describe('AutoApproveService - eval serialization (#551)', () => {
  test('a second eval queues behind the first and runs only after it releases', async () => {
    const svc = new AutoApproveService(makeConfig(), noLog);
    const firstReq = gate.awaitNextRequest();
    const aP = svc.evaluate('Bash', { command: 'cmdA' });
    const bP = svc.evaluate('Bash', { command: 'cmdB' });

    await firstReq; // A reached the LLM and holds the single slot
    // Give B a chance to (wrongly) run concurrently. With serialization it
    // stays queued, so the server has still only seen ONE request.
    await new Promise((r) => setTimeout(r, 50));
    expect(gate.requestCount()).toBe(1);

    const secondReq = gate.awaitNextRequest();
    gate.releaseNext(); // A resolves -> releases its slot -> B is granted
    const a = await aP;
    await secondReq; // B reaches the LLM only AFTER A finished
    expect(gate.requestCount()).toBe(2);

    gate.releaseNext(); // B resolves
    const b = await bP;

    // Both got real decisions; B was never escalate-on-busy.
    expect(a.decision).toBe('approve');
    expect(b.decision).toBe('approve');
    expect(b.reasoning).not.toBe('Concurrent evaluation in progress');
  });

  test('a waiter past queue_timeout escalates gracefully without hitting the LLM', async () => {
    // 0.05s = 50ms queue deadline.
    const svc = new AutoApproveService(makeConfig({ queue_timeout: 0.05 }), noLog);
    const firstReq = gate.awaitNextRequest();
    const aP = svc.evaluate('Bash', { command: 'cmdA' });
    const bP = svc.evaluate('Bash', { command: 'cmdB' });

    await firstReq; // A holds the slot (server keeps the request open)
    const b = await bP; // B waits 50ms in the queue, then escalates
    expect(b.decision).toBe('escalate');
    expect(b.reasoning).toContain('queue wait exceeded');
    expect(gate.requestCount()).toBe(1); // B never reached the LLM

    gate.releaseNext(); // let A finish cleanly
    const a = await aP;
    expect(a.decision).toBe('approve');
  });

  test('three concurrent evals all get real decisions, draining FIFO', async () => {
    const svc = new AutoApproveService(makeConfig(), noLog);
    const r1 = gate.awaitNextRequest();
    const p1 = svc.evaluate('Bash', { command: 'c1' });
    const p2 = svc.evaluate('Bash', { command: 'c2' });
    const p3 = svc.evaluate('Bash', { command: 'c3' });

    await r1;
    expect(gate.requestCount()).toBe(1); // only the first runs; 2 + 3 queued

    const r2 = gate.awaitNextRequest();
    gate.releaseNext();
    expect((await p1).decision).toBe('approve');
    await r2;
    expect(gate.requestCount()).toBe(2);

    const r3 = gate.awaitNextRequest();
    gate.releaseNext();
    expect((await p2).decision).toBe('approve');
    await r3;
    expect(gate.requestCount()).toBe(3);

    gate.releaseNext();
    expect((await p3).decision).toBe('approve');
  });

  test('drainQueue() escalates queued waiters without hitting the GPU (#617 force-release)', async () => {
    const svc = new AutoApproveService(makeConfig(), noLog);
    const r1 = gate.awaitNextRequest();
    const p1 = svc.evaluate('Bash', { command: 'c1' }); // holds the slot
    const p2 = svc.evaluate('Bash', { command: 'c2' }); // queued
    const p3 = svc.evaluate('Bash', { command: 'c3' }); // queued

    await r1;
    expect(gate.requestCount()).toBe(1); // only c1 reached the LLM

    // Force-release drains the two queued waiters: each takes the not-acquired
    // path and escalates to the user instead of seizing the freed GPU.
    expect(svc.drainQueue()).toBe(2);
    const d2 = await p2;
    const d3 = await p3;
    expect(d2.decision).toBe('escalate');
    expect(d3.decision).toBe('escalate');
    // The reasoning names force-release, not a phantom "queue wait exceeded".
    expect(d2.reasoning).toContain('force-released');
    expect(d2.reasoning).not.toContain('queue wait exceeded');
    expect(gate.requestCount()).toBe(1); // drained evals never reached the LLM

    // c1 is still in flight; cancel it (as force-release also does) to finish.
    expect(svc.cancel('force-release')).toBe(true);
    expect((await p1).decision).toBe('cancelled');
    gate.releaseAll(); // clean up c1's orphaned server holder
  });

  test('drainQueue() returns 0 when nothing is queued', () => {
    const svc = new AutoApproveService(makeConfig(), noLog);
    expect(svc.drainQueue()).toBe(0);
  });

  test('cancel(reason, evalId) drops a QUEUED eval (answered before it reached the GPU) (#617)', async () => {
    const svc = new AutoApproveService(makeConfig(), noLog);
    const r1 = gate.awaitNextRequest();
    // eval id 1 acquires the slot and runs; id 2 queues behind it.
    const p1 = svc.evaluate('Bash', { command: 'c1' }, undefined, undefined, undefined, 1);
    const p2 = svc.evaluate('Bash', { command: 'c2' }, undefined, undefined, undefined, 2);

    await r1;
    expect(gate.requestCount()).toBe(1); // only c1 reached the LLM

    // The user answers the question whose eval (id 2) is still QUEUED. cancel
    // targets the running eval first (id 1 != 2, untouched), then drops the
    // queued waiter — so c2 escalates and never burns a pointless GPU call.
    expect(svc.cancel('user-answered', 2)).toBe(true);
    const d2 = await p2;
    expect(d2.decision).toBe('escalate');
    expect(gate.requestCount()).toBe(1); // c2 never reached the LLM

    gate.releaseNext(); // c1 finishes cleanly, untouched by the cancel
    expect((await p1).decision).toBe('approve');
  });

  test('cancel() during a queued burst aborts the in-flight eval and drains the rest', async () => {
    const svc = new AutoApproveService(makeConfig(), noLog);
    const r1 = gate.awaitNextRequest();
    const p1 = svc.evaluate('Bash', { command: 'c1' });
    const p2 = svc.evaluate('Bash', { command: 'c2' });

    await r1; // c1 holds the slot
    expect(svc.cancel('PostToolUse')).toBe(true); // abort the in-flight c1
    const d1 = await p1;
    expect(d1.decision).toBe('cancelled');

    // c1's slot is released on cancel -> c2 is granted and reaches the LLM.
    const r2 = gate.awaitNextRequest();
    await r2;
    expect(gate.requestCount()).toBe(2);
    // releaseAll drains c1's orphaned (aborted) holder AND resolves c2.
    gate.releaseAll();
    expect((await p2).decision).toBe('approve');
  });
});
