/**
 * Integration tests for Model B "hold the hook" (#573) over a REAL loopback
 * HookServer wired to a REAL AutoApproveGate (no mocks). Asserts the HTTP
 * response Claude blocks on is WITHHELD while the gate holds a binary
 * escalation, then carries the allow/deny verdict once the user answers via
 * `resolveHeld` — and that a multi-choice escalation passes through immediately.
 *
 * Mirrors the gated-server pattern in serialize.test.ts: a real Bun.serve fixture
 * (here, the daemon's own HookServer) is driven over the loopback so timing is
 * observed deterministically rather than stubbed.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import {
  type AutoApproveEvaluator,
  AutoApproveGate,
} from '../../src/auto-approve/auto-approve-gate.ts';
import type { AutoApproveResult } from '../../src/auto-approve/types.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { HookServer } from '../../src/hooks/hook-server.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

const escalate: AutoApproveResult = {
  decision: 'escalate',
  reasoning: 't',
  durationMs: 0,
  model: 'm',
};

function evaluator(result: AutoApproveResult): AutoApproveEvaluator {
  return { evaluate: async () => result, cancel: () => true };
}

function permissionBody(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'claude-test',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/d',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command: 'git push' },
    ...over,
  });
}

describe('Model B hold over a real HookServer (#573)', () => {
  const SID = generateId() as UUID;
  let server: HookServer;
  let registry: SessionRegistry;
  let gate: AutoApproveGate;
  let lastQuestionId: UUID | undefined;

  beforeEach(() => {
    configureLogger({ writeLog: () => {} });
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    lastQuestionId = undefined;
    gate = new AutoApproveGate(
      {
        service: evaluator(escalate),
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => {
          lastQuestionId = generateId();
          return lastQuestionId;
        },
        holdMs: 60_000,
        alwaysEscalateTools: new Set(['AskUserQuestion', 'ExitPlanMode']),
      },
      SID,
    );
    server = new HookServer({ port: 0 });
    server.setPermissionResolver((input) => gate.resolvePermission(input));
    server.start();
  });

  afterEach(async () => {
    server.stop();
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('binary escalate WITHHOLDS the HTTP response until resolveHeld -> allow', async () => {
    const post = fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: permissionBody(),
    });

    // Wait for the gate to escalate (creates the question id) without the POST
    // having resolved yet — the hook server is blocked on the held promise.
    await waitFor(() => lastQuestionId !== undefined);
    let responded = false;
    void post.then(() => {
      responded = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(responded).toBe(false); // response is withheld (held hook)

    // The user answers Yes -> the held hook resolves allow and the POST returns
    // the allow decision body.
    expect(gate.resolveHeld(lastQuestionId as UUID, 'allow')).toBe(true);
    const res = await post;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });

  test('held hook -> deny body when the user answers No', async () => {
    const post = fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: permissionBody(),
    });
    await waitFor(() => lastQuestionId !== undefined);
    expect(gate.resolveHeld(lastQuestionId as UUID, 'deny')).toBe(true);
    const res = await post;
    expect(await res.json()).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
    });
  });

  test('multi-choice escalate returns the passthrough body immediately (no hold)', async () => {
    const res = await fetch(server.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: permissionBody({ permission_suggestions: ['Alpha', 'Beta', 'Gamma', 'Delta'] }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({}); // passthrough = bare {}
  });

  test('#733: hold timeout fires onHoldTimeout once, then fails open to passthrough', async () => {
    // Dedicated gate/server with a FAST hold so the timeout path runs for real.
    const timeoutCue: UUID[] = [];
    let qid: UUID | undefined;
    const fastGate = new AutoApproveGate(
      {
        service: evaluator(escalate),
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => {
          qid = generateId();
          return qid;
        },
        onHoldTimeout: (id) => timeoutCue.push(id),
        holdMs: 80,
        alwaysEscalateTools: new Set<string>(),
      },
      SID,
    );
    const fastServer = new HookServer({ port: 0 });
    fastServer.setPermissionResolver((input) => fastGate.resolvePermission(input));
    fastServer.start();
    try {
      const res = await fetch(fastServer.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: permissionBody(),
      });
      // The hold expired unanswered: handoff cue fired exactly once with the
      // held question's id, BEFORE the fail-open resolved the hook to
      // passthrough (bare {}).
      expect(await res.json()).toEqual({});
      expect(qid).toBeDefined();
      expect(timeoutCue).toEqual([qid as UUID]);
    } finally {
      fastServer.stop();
    }
  });

  test('#733: with delivery gating ON, a CONFIRMED delivery still fires the cue on timeout', async () => {
    // The cue is gated on the user having been reachable: confirmed delivery
    // ('pushed') + hold expiry => handoff fires. (The inverse — unconfirmed
    // delivery never fires it — is pinned by the delivery-gating describe
    // block's afterEach invariant in auto-approve-gate.test.ts.)
    const timeoutCue: UUID[] = [];
    let qid: UUID | undefined;
    const gatedGate = new AutoApproveGate(
      {
        service: evaluator(escalate),
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => {
          qid = generateId();
          return qid;
        },
        onHoldTimeout: (id) => timeoutCue.push(id),
        holdMs: 120,
        awaitDelivery: () => Promise.resolve('pushed' as const),
        deliveryConfirmMs: 5000,
        alwaysEscalateTools: new Set<string>(),
      },
      SID,
    );
    const gatedServer = new HookServer({ port: 0 });
    gatedServer.setPermissionResolver((input) => gatedGate.resolvePermission(input));
    gatedServer.start();
    try {
      const res = await fetch(gatedServer.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: permissionBody(),
      });
      expect(await res.json()).toEqual({}); // timed out -> passthrough
      expect(qid).toBeDefined();
      expect(timeoutCue).toEqual([qid as UUID]);
    } finally {
      gatedServer.stop();
    }
  });

  test('#733: an answered hold never fires onHoldTimeout', async () => {
    const timeoutCue: UUID[] = [];
    let qid: UUID | undefined;
    const cueGate = new AutoApproveGate(
      {
        service: evaluator(escalate),
        sessionRegistry: registry,
        tracker: new QuestionPresenceTracker(() => {}),
        isInSubagentContext: () => false,
        escalate: () => {
          qid = generateId();
          return qid;
        },
        onHoldTimeout: (id) => timeoutCue.push(id),
        holdMs: 120,
        alwaysEscalateTools: new Set<string>(),
      },
      SID,
    );
    const cueServer = new HookServer({ port: 0 });
    cueServer.setPermissionResolver((input) => cueGate.resolvePermission(input));
    cueServer.start();
    try {
      const post = fetch(cueServer.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: permissionBody(),
      });
      await waitFor(() => qid !== undefined);
      cueGate.resolveHeld(qid as UUID, 'allow');
      const body = (await (await post).json()) as {
        hookSpecificOutput?: { decision?: { behavior?: string } };
      };
      expect(body.hookSpecificOutput?.decision?.behavior).toBe('allow');
      // Give the (cancelled) hold timer window a chance to elapse: the cue must
      // stay silent because the hold was answered, not timed out.
      await new Promise((r) => setTimeout(r, 200));
      expect(timeoutCue).toEqual([]);
    } finally {
      cueServer.stop();
    }
  });
});

/** Poll `cond` up to ~1s; throw if it never becomes true (real timing, no mock). */
async function waitFor(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: condition not met within 1s');
}
