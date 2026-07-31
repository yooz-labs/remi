/**
 * Tests for single question identity (#887, Q2 of epic #885).
 *
 * Up to THREE ids used to exist for one logical prompt cycle:
 *   - `HookEventBridge.buildPermissionQuestion` mints one at hook arrival
 *     (`hook-event-bridge.ts`).
 *   - The PTY parser mints a FRESH one on every render
 *     (`question-parser.ts:275`), independent of the hook's.
 *   - `QuestionPresenceTracker.consumeAndMerge` used to build the pushed card
 *     from the PTY question (`...ptyQuestion` spread), so the card's `id`
 *     was the PTY's, not the hook's — the gate then had to
 *     `rekeySignatureToRendered` its own bookkeeping (`openQuestionSignatures`)
 *     to follow it (#814/#808).
 *
 * This suite wires the REAL pipeline the way `hook-bridge-setup.ts` does
 * (`HookEventBridge` + `QuestionPresenceTracker` + `AutoApproveGate` +
 * `SessionRegistry`, no mocks) and proves the id-per-prompt-cycle count is 1:
 * the tracker now ADOPTS the hook's id at merge time, so a PTY render that
 * pairs with a parked hook record produces a card carrying the ORIGINAL hook
 * id, and no re-keying is ever needed downstream.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateId } from '@remi/shared';
import type { Question, UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../src/api/question-presence-tracker.ts';
import { AutoApproveGate } from '../../src/auto-approve/auto-approve-gate.ts';
import type { AutoApproveEvaluator } from '../../src/auto-approve/auto-approve-gate.ts';
import type { AutoApproveResult } from '../../src/auto-approve/types.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import { HookEventBridge } from '../../src/hooks/hook-event-bridge.ts';
import type { PermissionRequestHookInput } from '../../src/hooks/index.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

function fakePTY(submits: string[] = []): PTYSession {
  return {
    id: generateId(),
    isRunning: true,
    write: () => {},
    submitInput: async (v: string) => {
      submits.push(v);
    },
    close: async () => {},
  } as unknown as PTYSession;
}

/** A PermissionRequest hook input for a SUBAGENT-tagged Bash command (parks
 *  for PTY arbitration, #751/#814 — the path where identity used to fork). */
function pr(command = 'git push origin main'): PermissionRequestHookInput {
  return {
    session_id: 'claude-session',
    transcript_path: '/tmp/t.jsonl',
    cwd: '/repro',
    permission_mode: 'default',
    hook_event_name: 'PermissionRequest',
    tool_name: 'Bash',
    tool_input: { command },
    agent_id: 'agent-1',
    agent_type: 'code-reviewer',
    prompt_id: 'turn-123',
  };
}

/** What `question-parser.ts` would independently mint for the rendered
 *  prompt: a FRESH id every call (`createQuestion` -> `generateId()`), no
 *  relation at all to the hook's id. This is the id the tracker must now
 *  DISCARD when a hook record is present to pair with. */
function ptyRender(text = 'Do you want to proceed?'): Question {
  return {
    id: generateId(),
    text,
    options: [
      { label: 'Yes', value: '1', isRecommended: true, isYes: false, isNo: false },
      {
        label: "Yes, and don't ask again for git push commands",
        value: '2',
        isRecommended: false,
        isYes: false,
        isNo: false,
      },
      {
        label: 'No, and tell Claude what to do differently (esc)',
        value: '3',
        isRecommended: false,
        isYes: false,
        isNo: false,
      },
    ],
    allowsFreeText: false,
    isAnswered: false,
  };
}

/** Poll until `predicate` is true or `timeoutMs` elapses (never a guessed
 *  sleep, per repo convention). Needed for the #814 arbiter path: its verdict
 *  is awaited OUT of band by `QuestionPresenceTracker` (a fire-and-forget
 *  `void pending.then(...)`), so a test cannot await a promise handle for it
 *  directly and must instead wait for its observable effect (a push). */
async function waitFor(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`waitFor: predicate did not become true within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

const escalate: AutoApproveResult = {
  decision: 'escalate',
  reasoning: 't',
  durationMs: 0,
  model: 'm',
};

/** Builds the real pipeline (SessionRegistry + QuestionPresenceTracker +
 *  HookEventBridge + AutoApproveGate) the way `hook-bridge-setup.ts` wires
 *  it, minus the transcript/binder machinery this test does not exercise.
 *  `service` mirrors the gate's own dep: `null` for the no-auto-approve path
 *  (a parked render pushes straight through `pushMerged`, pre-#814
 *  behavior), or a real evaluator for the arbiter path
 *  (`arbitrateParkedRender` / `escalateRenderedParked`). */
function buildPipeline(
  service: AutoApproveEvaluator | null,
  submits: string[] = [],
): {
  SID: UUID;
  registry: SessionRegistry;
  tracker: QuestionPresenceTracker;
  gate: AutoApproveGate;
  pushed: Question[];
} {
  const SID = generateId() as UUID;
  const registry = new SessionRegistry({ orphanTimeoutMs: 60_000 });
  registry.registerSession(SID, '/repro', fakePTY(submits), {
    handleMessage: () => {},
    handleQuestion: () => {},
    handleStatusChange: () => {},
  } as never);

  const pushed: Question[] = [];
  const tracker = new QuestionPresenceTracker(
    (q) => {
      pushed.push(q);
      registry.addQuestion(SID, q, 'tracker-push');
    },
    { hasLiveQuestions: () => (registry.getSession(SID)?.currentQuestions.size ?? 0) > 0 },
  );

  const hookBridge = new HookEventBridge(SID, {
    onStatusChange: () => {},
    onQuestion: (q) => {
      if (q.source === 'permission_request' || q.source === 'notification') {
        tracker.recordPendingHook(q);
      }
    },
  });

  const gate = new AutoApproveGate(
    {
      service,
      sessionRegistry: registry,
      tracker,
      isInSubagentContext: () => false,
      escalate: (i, summary) => hookBridge.handlePermissionRequest(i, summary),
      parkForPTY: (i) => {
        const q = hookBridge.buildPermissionQuestion(i);
        tracker.parkAwaitingPTY(q);
        return q.id;
      },
    },
    SID,
  );

  if (service) {
    tracker.setParkedRenderArbiter((ctx) =>
      gate.arbitrateParkedRender(ctx.parkedQuestionId as UUID, ctx.rendered, ctx.ptyPrompt),
    );
  }

  return { SID, registry, tracker, gate, pushed };
}

describe('single question identity across hook -> PTY-render (#887)', () => {
  beforeEach(() => {
    configureLogger({ writeLog: () => {} });
  });
  afterEach(async () => {
    __resetLoggerForTests();
  });

  test('parking never registers or pushes a question (park is silent, #751)', async () => {
    const { registry, gate, SID, pushed } = buildPipeline(null);
    const decision = await gate.resolvePermission(pr());
    expect(decision).toBe('passthrough'); // #807: subagent permissions never hold
    expect(pushed).toHaveLength(0);
    expect(registry.getSession(SID)?.currentQuestions.size ?? 0).toBe(0);
    await registry.shutdown();
  });

  test('a parked prompt that renders pushes under the HOOK id, not a fresh PTY id (no auto-approve configured)', async () => {
    const { registry, tracker, gate, SID, pushed } = buildPipeline(null);
    await gate.resolvePermission(pr());

    // The PTY parser independently mints its OWN id for the same logical
    // prompt (question-parser.ts:275) -- this is the id pre-#887 code would
    // have pushed the card under.
    const render = ptyRender();
    tracker.onOrphanPTYPrompt(render);

    expect(pushed).toHaveLength(1);
    const pushedId = pushed[0]?.id as UUID;
    expect(pushedId).not.toBe(render.id); // the PTY-minted id was discarded
    expect(registry.getSession(SID)?.currentQuestions.size).toBe(1);
    expect([...(registry.getSession(SID)?.currentQuestions.keys() ?? [])]).toEqual([pushedId]);
    await registry.shutdown();
  });

  test('exactly ONE id is ever registered for a parked-then-rendered prompt cycle, add through remove (acceptance criterion)', async () => {
    const { registry, tracker, gate, SID, pushed } = buildPipeline(null);
    await gate.resolvePermission(pr());
    const render = ptyRender();
    tracker.onOrphanPTYPrompt(render);
    expect(pushed).toHaveLength(1);
    const pushedId = pushed[0]?.id as UUID;

    // The subagent's tool now runs (approved in the terminal) -- the
    // external-resolution path that used to require the pushed card's id to
    // have been re-keyed to be findable at all.
    gate.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'git push origin main' }, agentId: 'agent-1' },
      'PreToolUse-subagent',
    );

    expect(registry.getQuestion(SID, pushedId)).toBeNull();
    // Only ONE distinct id ever touched the registry for this whole cycle.
    expect(pushed.map((q) => q.id)).toEqual([pushedId]);
    await registry.shutdown();
  });

  test('the same id-adoption holds through the #814 arbiter path (auto-approve escalates)', async () => {
    const evalCalls: string[] = [];
    const service: AutoApproveEvaluator = {
      evaluate: async (toolName) => {
        evalCalls.push(toolName);
        return escalate;
      },
      cancel: () => true,
    };
    const { registry, tracker, gate, SID, pushed } = buildPipeline(service);
    await gate.resolvePermission(pr());

    const render = ptyRender();
    tracker.onOrphanPTYPrompt(render); // the real routing path for hooked sessions

    // arbitrateParkedRender runs asynchronously off the PTY-parse callback
    // (fire-and-forget from the tracker's side); wait for its push to land.
    await waitFor(() => pushed.length > 0);

    expect(evalCalls).toEqual(['Bash']);
    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.id).not.toBe(render.id);
    expect(registry.getSession(SID)?.currentQuestions.size).toBe(1);
    await registry.shutdown();
  });

  test('no `rekey` mechanism remains: openQuestionSignatures resolves the pushed id directly', async () => {
    // Regression guard for the deleted `rekeySignatureToRendered`: prove the
    // gate's own external-resolution bookkeeping (`openQuestionSignatures`,
    // keyed at park time) already matches the id of whatever card gets
    // pushed -- no intermediate step required.
    const { registry, tracker, gate, SID, pushed } = buildPipeline(null);
    await gate.resolvePermission(pr('rm -rf build'));
    const render = ptyRender('reviewer · Bash: rm -rf build');
    tracker.onOrphanPTYPrompt(render);
    const pushedId = pushed[0]?.id as UUID;

    gate.cancelExternallyResolved(
      { toolName: 'Bash', toolInput: { command: 'rm -rf build' }, agentId: 'agent-1' },
      'PostToolUse-subagent',
    );
    expect(registry.getQuestion(SID, pushedId)).toBeNull();
    await registry.shutdown();
  });
});
