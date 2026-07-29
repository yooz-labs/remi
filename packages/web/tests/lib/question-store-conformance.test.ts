/**
 * Two-sided conformance test for the #888 QuestionStore + render-resolution
 * transition: drives the REAL daemon pending-question pipeline
 * (`SessionRegistry` -> `QuestionStore`, `MessageAPI` -> real `QuestionDedup`,
 * `QuestionPresenceTracker`) through every transition, broadcasts the
 * resulting `question` / `question_resolved` / `question_snapshot` messages
 * over a REAL socket (the same `WebSocketAdapter` <-> `WebSocketClient` pair
 * `message-dispatch-conformance.test.ts` (#897) uses -- no synthetic
 * counterparty, per AGENTS.md "Verify before you describe"), and feeds them
 * into the REAL `packages/web/src/lib/question-collection.ts` reducers (the
 * same functions `App.tsx` calls) to build the client's view.
 *
 * Review of the first version of this suite found it wired the tracker's
 * push sink straight to `adapter.sendRaw` + `sessionRegistry.addQuestion`,
 * skipping `MessageAPI`/`QuestionDedup` entirely -- production (`cli.ts`)
 * wires the push sink to `messageApi.handleQuestion`. Per ADR 0011 ("a test
 * named for a component must construct it"), that gap meant this suite's
 * "conformance" claim did not cover dedup interaction at all. This version
 * constructs the real `MessageAPI` too, and adds the flap-then-redraw
 * reproduction end to end over the real socket into the real client reducer.
 *
 * After every transition this asserts: the set of LIVE (still-pending)
 * question ids the client reducer sees equals the set of ids
 * `SessionRegistry.currentQuestions` -- the single owner #888 established --
 * currently holds.
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
import { MessageAPI } from '../../../daemon/src/api/message-api.ts';
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
 *  mints one post-#920 (source: 'pty', fresh id every parse). `optionCount`
 *  lets a test build a "richer" redraw QuestionDedup lets through even
 *  within its window, without waiting out or faking the real 5s clock. */
function hooklessPTYQuestion(text: string, agentId?: string, optionCount = 2): Question {
  const options: QuestionOption[] = [];
  for (let i = 1; i <= optionCount; i++) options.push(opt(String(i), String(i)));
  return {
    id: generateId() as UUID,
    text,
    options,
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
  let messageApi: MessageAPI;
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

    // Real MessageAPI, real QuestionDedup inside it -- NOT bypassed (#888
    // review fix). Mirrors message-api-setup.ts's own onQuestion callback:
    // send the wire 'question' message via the adapter's own factory
    // (createQuestion is applied inside handleQuestion's caller in
    // production; here the onQuestion event IS the confirmation a push
    // landed, so build+send the message from it directly), then register.
    messageApi = new MessageAPI(
      { sessionId: SID, initialBulletId: 1 },
      {
        onQuestion: (question) => {
          if (connectionId !== null) {
            adapter.sendRaw(connectionId, createQuestion(question, SID));
          }
          sessionRegistry.addQuestion(SID, question, question.source ?? 'unknown');
        },
      },
    );

    tracker = new QuestionPresenceTracker(
      (q, opts) => messageApi.handleQuestion(q, opts),
      {
        hasLiveQuestions: () => (sessionRegistry.getSession(SID)?.currentQuestions.size ?? 0) > 0,
        // The #888/#920 hard requirement's wiring, mirroring cli.ts exactly.
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
        // Confirmation gate (#888 review fix): only a push that actually
        // landed in the store (survived QuestionDedup) is evidence of
        // supersession.
        isQuestionLive: (id) => sessionRegistry.getQuestion(SID, id as UUID) !== null,
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

  test('hard requirement: a hook-less question resolves when a CONFIRMED replacement supersedes it', async () => {
    const first = hooklessPTYQuestion('First orphan prompt');
    tracker.onPTYPromptVisible(first);
    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([first.id]));

    // No hook, no tool signature, nothing but a new (distinct-fingerprint,
    // so not deduped) render taking its place -- the #920 leak's exact
    // shape. The tracker's render-resolution transition is the only thing
    // that can clear this.
    const second = hooklessPTYQuestion('Second orphan prompt');
    tracker.onPTYPromptVisible(second);

    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([second.id]));
    // The FIRST id must be gone from the client too -- not just no longer
    // "the latest", but actually resolved (question_resolved observed).
    expect(clientQuestions.get(`${SID}#main`)?.id).not.toBe(first.id);
  });

  test('#888 review fix: a flap-then-redraw whose replacement is DEDUPED does not swallow the original, end to end', async () => {
    // Reproduces the chain review found, over the REAL socket into the REAL
    // client reducer: a PTY-text-parsed status flap (no paired dedup
    // reset -- see cli.ts's `!hookServer` asymmetry) followed by the SAME
    // prompt redrawing under a fresh id, deduped by the real QuestionDedup.
    // The prior version of this mechanism resolved the original anyway; the
    // fixed version must not.
    const text = 'Allow this agent-team teammate to proceed?';
    const a = hooklessPTYQuestion(text, undefined, 2);
    tracker.onPTYPromptVisible(a);
    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([a.id]));

    // False-positive status flap and flap-back -- deliberately NOT calling
    // messageApi.handleStatusChange, mirroring cli.ts's hookServer-truthy
    // branch (tracker.onStatusChange is unconditional; the dedup reset is
    // not).
    tracker.onStatusChange('executing');
    tracker.onStatusChange('waiting');

    // Same text, fresh id, SAME option count (not richer) -- the real
    // QuestionDedup suppresses it.
    const redraw = hooklessPTYQuestion(text, undefined, 2);
    tracker.onPTYPromptVisible(redraw);

    // Give the (non-)broadcast a moment, then assert convergence on the
    // ORIGINAL still being the sole live id -- neither client nor store
    // ever saw a resolution for `a`, and the redraw never registered.
    await wait(50);
    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([a.id]));
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

    // A genuinely NEW hook-less render for the main agent supersedes
    // `main` (CONFIRMED delivery -- distinct fingerprint); the unrelated
    // subagent question must be untouched.
    const replacement = hooklessPTYQuestion('Main hook-less prompt, replaced');
    tracker.onPTYPromptVisible(replacement);
    await assertConverges();
    expect(storeLiveIds()).toEqual(new Set([sub.id, replacement.id]));

    // Clean up for the next test.
    sessionRegistry.removeQuestion(SID, sub.id, 'test-cleanup');
    adapter.sendRaw(connectionId as string, createQuestionResolved(SID, sub.id, 'cancelled'));
    sessionRegistry.removeQuestion(SID, replacement.id, 'test-cleanup');
    adapter.sendRaw(connectionId as string, createQuestionResolved(SID, replacement.id, 'cancelled'));
    await assertConverges();
  });
});
