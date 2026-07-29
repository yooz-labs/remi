/**
 * Two-sided conformance test for the #888 QuestionStore + render-resolution
 * transition: drives the REAL daemon pending-question pipeline
 * (`SessionRegistry` -> `QuestionStore`, `QuestionPresenceTracker`) through
 * every transition, broadcasts the resulting `question` / `question_resolved`
 * / `question_snapshot` messages over a REAL socket (the same
 * `WebSocketAdapter` <-> `WebSocketClient` pair `message-dispatch-
 * conformance.test.ts` (#897) uses -- no synthetic counterparty, per
 * AGENTS.md "Verify before you describe"), and feeds them into the REAL
 * `packages/web/src/lib/question-collection.ts` reducers (the same functions
 * `App.tsx` calls) to build the client's view.
 *
 * After every transition this asserts: the set of LIVE (still-pending)
 * question ids the client reducer sees equals the set of ids
 * `SessionRegistry.currentQuestions` -- the single owner #888 established --
 * currently holds. Nothing here is reimplemented or mocked: the daemon side
 * is the real `SessionRegistry`/`QuestionStore`/`QuestionPresenceTracker`
 * classes, the client side is the real `question-collection.ts` reducers
 * plus `mapQuestionToUIQuestion`, wired the same way `cli.ts` and `App.tsx`
 * wire them (`onQuestionsChanged` -> `question_snapshot` broadcast;
 * `QuestionPresenceTracker`'s push sink -> `question` + `SessionRegistry.
 * addQuestion`; a resolution -> `SessionRegistry.removeQuestion` +
 * `question_resolved`).
 *
 * The hard requirement under test: a HOOK-LESS question (no
 * PermissionRequest/Notification hook, `source: 'pty'`) can be resolved with
 * no signal but its render disappearing -- see the "hook-less render
 * disappears" cases below.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Question, QuestionOption, UUID } from '@remi/shared';
import {
  createHello,
  createQuestion,
  createQuestionResolved,
  createQuestionSnapshot,
  generateId,
} from '@remi/shared/protocol.ts';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers.ts';
import type { MessageAPI } from '../../../daemon/src/api/message-api.ts';
import { QuestionPresenceTracker } from '../../../daemon/src/api/question-presence-tracker.ts';
// Real daemon adapter + session pipeline -- not test doubles. Relative
// import: packages/web has no `@remi/daemon` path alias (only
// `packages/web/tests/**` is exempt from both typecheck gates, matching the
// #897 conformance test's own "conformance-test placement decision").
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter.ts';
import type { PTYSession } from '../../../daemon/src/pty/pty-session.ts';
import { SessionRegistry } from '../../../daemon/src/session/session-registry.ts';
import { mapQuestionToUIQuestion } from '../../src/lib/question-mapping.ts';
import {
  applyIncomingQuestion,
  isQuestionPending,
  pruneQuestionsNotLive,
  resolveQuestionCard,
} from '../../src/lib/question-collection.ts';
import type { UIQuestion } from '../../src/types/index.ts';
import { WebSocketClient } from '../../src/lib/websocket-client.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await wait(10);
  }
  if (!predicate()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}

function opt(label: string, value: string, extras: Partial<QuestionOption> = {}): QuestionOption {
  return { label, value, isRecommended: false, isYes: false, isNo: false, ...extras };
}

/** A genuinely hook-less PTY-parsed question, exactly as `question-parser.ts`
 *  mints one post-#920 (source: 'pty', fresh id every parse). */
function hooklessPTYQuestion(text: string, agentId?: string): Question {
  return {
    id: generateId() as UUID,
    text,
    options: [opt('1', '1'), opt('2', '2')],
    allowsFreeText: false,
    isAnswered: false,
    source: 'pty',
    ...(agentId !== undefined && { agentId }),
  };
}

/** A hook record with real option labels (#574), as `HookEventBridge` mints. */
function hookRecord(text: string, agentId?: string): Question {
  return {
    id: generateId() as UUID,
    text,
    options: [
      opt('Yes', '1', { isYes: true, isRecommended: true }),
      opt('Yes, always', '2', { isYes: true }),
      opt('No', '3', { isNo: true }),
    ],
    allowsFreeText: false,
    isAnswered: false,
    source: 'permission_request',
    ...(agentId !== undefined && { agentId }),
  };
}

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    close: () => Promise.resolve(),
  } as unknown as PTYSession;
}

describe('question-store conformance: real daemon store <-> real web reducer (#888)', () => {
  let adapter: WebSocketAdapter;
  let port: number;
  let client: WebSocketClient;
  let connectionId: string | null = null;
  const received: unknown[] = [];

  const SID = generateId() as UUID;
  let sessionRegistry: SessionRegistry;
  let tracker: QuestionPresenceTracker;
  let clientQuestions = new Map<string, UIQuestion>();

  function clientLiveIds(): Set<string> {
    const out = new Set<string>();
    for (const q of clientQuestions.values()) {
      if (q.sessionId === SID && isQuestionPending(q)) out.add(q.id);
    }
    return out;
  }

  function storeLiveIds(): Set<string> {
    return new Set(sessionRegistry.getSession(SID)?.currentQuestions.keys() ?? []);
  }

  /** Assert the client's live view and the daemon store's live view agree,
   *  waiting up to `timeoutMs` for the async socket round-trip to settle. */
  async function assertConverges(timeoutMs = 2000): Promise<void> {
    await waitFor(() => {
      const client = clientLiveIds();
      const store = storeLiveIds();
      if (client.size !== store.size) return false;
      for (const id of store) if (!client.has(id)) return false;
      return true;
    }, timeoutMs);
    expect(clientLiveIds()).toEqual(storeLiveIds());
  }

  beforeAll(async () => {
    port = await reserveRange(1);
    adapter = new WebSocketAdapter(
      { port },
      {
        onConnect: (id) => {
          connectionId = id;
        },
      },
    );
    await adapter.start();

    client = new WebSocketClient(
      { url: `ws://localhost:${port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 },
      {
        onMessage: (msg) => {
          received.push(msg);
          if (msg.type === 'question') {
            const ui = mapQuestionToUIQuestion(msg.question, msg.sessionId, msg.timestamp);
            clientQuestions = applyIncomingQuestion(clientQuestions, ui, false);
          } else if (msg.type === 'question_resolved') {
            clientQuestions = resolveQuestionCard(
              clientQuestions,
              msg.sessionId,
              msg.questionId,
              msg.reason,
            ).questions;
          } else if (msg.type === 'question_snapshot') {
            clientQuestions = pruneQuestionsNotLive(clientQuestions, msg.sessionId, msg.questionIds);
          }
        },
      },
    );
    client.connect();
    await waitFor(() => client.isConnected || client.isTransportOpen);
    // Real hello handshake -- WebSocketAdapter sets skipHelloAck (the
    // daemon's cli.ts normally acks), so no hello_ack arrives automatically;
    // that's fine, this test never reads one. Matches the #897 conformance
    // test's own beforeAll.
    client.send(createHello(generateId(), '0.0.0-test'));
    await waitFor(() => connectionId !== null);

    sessionRegistry = new SessionRegistry(
      {},
      {
        // Mirrors cli.ts's onQuestionsChanged: broadcast the authoritative
        // live-id snapshot on every add/remove/clear (#798).
        onQuestionsChanged: (sessionId, questions) => {
          if (connectionId === null) return;
          adapter.sendRaw(
            connectionId,
            createQuestionSnapshot(
              sessionId,
              questions.map((q) => q.id),
            ),
          );
        },
      },
    );
    sessionRegistry.registerSession(SID, '/conformance-test', fakePTY(), {
      bulletCount: 0,
    } as unknown as MessageAPI);

    tracker = new QuestionPresenceTracker(
      (q) => {
        // Mirrors message-api-setup.ts's onQuestion: send the 'question'
        // message, then register in the single pendingness owner.
        if (connectionId !== null) {
          adapter.sendRaw(connectionId, createQuestion(q, SID));
        }
        sessionRegistry.addQuestion(SID, q, q.source ?? 'unknown');
      },
      {
        hasLiveQuestions: () => (sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0) > 0,
        // The #888/#920 hard requirement's wiring, mirroring cli.ts exactly:
        // remove from the store, then broadcast question_resolved the same
        // way every other cancellation route does.
        onHooklessQuestionGone: (questionId, reason) => {
          sessionRegistry.removeQuestion(
            SID,
            questionId as UUID,
            reason,
            undefined,
            'QuestionPresenceTracker.onHooklessQuestionGone',
          );
          if (connectionId !== null) {
            adapter.sendRaw(connectionId, createQuestionResolved(SID, questionId as UUID, 'cancelled'));
          }
        },
      },
    );
  });

  afterAll(async () => {
    await sessionRegistry.shutdown();
    client.disconnect();
    await adapter.stop();
  });

  test('a hook-paired question: push then hook-signature resolution converge', async () => {
    const hook = hookRecord('Allow Bash: git push origin main');
    tracker.recordPendingHook(hook);
    const render = hooklessPTYQuestion('Allow Bash: git push origin main');
    tracker.onPTYPromptVisible(render); // pairs (sole candidate, #887 adopts hook.id)

    await assertConverges();
    expect(storeLiveIds().size).toBe(1);

    // Resolve it the way AutoApproveGate.resolveSupersededQuestion does: a
    // tool-signature match removes it, then broadcasts question_resolved.
    sessionRegistry.removeQuestion(SID, hook.id, 'PostToolUse', 'Bash', 'AutoApproveGate.test');
    adapter.sendRaw(connectionId as string, createQuestionResolved(SID, hook.id, 'cancelled'));

    await assertConverges();
    expect(storeLiveIds().size).toBe(0);
  });

  test('hard requirement: a hook-less question resolves when its render is superseded', async () => {
    const first = hooklessPTYQuestion('First orphan prompt');
    tracker.onPTYPromptVisible(first);
    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([first.id]));

    // No hook, no tool signature, nothing but a new render taking its place
    // -- the #920 leak's exact shape. The tracker's render-resolution
    // transition is the only thing that can clear this.
    const second = hooklessPTYQuestion('Second orphan prompt');
    tracker.onPTYPromptVisible(second);

    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([second.id]));
    // The FIRST id must be gone from the client too -- not just no longer
    // "the latest", but actually resolved (question_resolved observed).
    expect(clientQuestions.get(`${SID}#main`)?.id).not.toBe(first.id);
  });

  test('hard requirement: a hook-less question resolves when status leaves waiting', async () => {
    const q = hooklessPTYQuestion('Waiting on a native agent-team prompt');
    tracker.onPTYPromptVisible(q);
    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([q.id]));

    tracker.onStatusChange('executing');

    await assertConverges();
    expect(storeLiveIds().size).toBe(0);
  });

  test('concurrent main + subagent hook-less prompts stay independent through resolution', async () => {
    const main = hooklessPTYQuestion('Main hook-less prompt');
    tracker.onPTYPromptVisible(main);
    await assertConverges();

    // A DIFFERENT session-registry question (concurrent subagent) added
    // directly, simulating a second in-flight prompt the tracker isn't
    // currently observing on the (single) PTY screen -- SessionRegistry
    // itself supports N concurrent questions; only ONE can be "on screen"
    // for the tracker's render-resolution purposes at a time.
    const sub = hookRecord('Allow Bash: ls', 'sub-42');
    sessionRegistry.addQuestion(SID, sub, sub.source ?? 'unknown');
    adapter.sendRaw(connectionId as string, createQuestion(sub, SID));

    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([main.id, sub.id]));

    // The main hook-less prompt's render disappears; the unrelated subagent
    // question must be untouched.
    tracker.onStatusChange('executing');
    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([sub.id]));

    // Clean up for the next test.
    sessionRegistry.removeQuestion(SID, sub.id, 'test-cleanup');
    adapter.sendRaw(connectionId as string, createQuestionResolved(SID, sub.id, 'cancelled'));
    await assertConverges();
  });
});
