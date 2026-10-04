/**
 * `CodexDecisions` (epic #1175, phase 4 #1178): the state machine of the
 * approval cards, against a REAL `SessionRegistry`, a real `MessageAPI` wired by
 * the daemon's own `createMessageApiForSession` (so a card is stamped `held` and
 * broadcast the way it is in production), and the real input handlers for the
 * "types nothing" group.
 *
 * What is NOT real here, disclosed: the client. `CodexDecisions` only needs
 * `respond(id, result)` of the app-server client, so these tests give it a
 * recording one that can be told the link is down or that it throws. It decides
 * nothing; it is the I/O boundary. The real `AppServerClient`, `ThreadTracker`
 * and `FakeAppServer` run in `codex-first-answer-wins.test.ts`, and the whole
 * daemon in `integration/codex-launch-characterization.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type ProtocolMessage,
  type Question,
  type UUID,
  createQuestionResolved,
} from '@remi/shared';
import type { QuestionMessage, QuestionResolvedMessage } from '@remi/shared/protocol.ts';
import {
  createInputHandlers,
  gateAnswerDeps,
  trackerScreenDeps,
} from '../../../src/cli/handlers/input-events.ts';
import { promptUpDeps } from '../../../src/cli/handlers/prompt-up.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { createMessageApiForSession } from '../../../src/cli/session-phases/message-api-setup.ts';
import type { RequestId } from '../../../src/harness/codex/app-server-protocol.ts';
import { COMMAND_TEXT_MAX } from '../../../src/harness/codex/approval-cards.ts';
import {
  CodexDecisions,
  type CodexDecisionsDeps,
  type ThreadRole,
} from '../../../src/harness/codex/codex-decisions.ts';
import type { ThreadStatus } from '../../../src/harness/codex/thread-protocol.ts';
import type { HeldAnswer } from '../../../src/harness/decision.ts';
import type { DecisionChannel } from '../../../src/harness/types.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { CID, type PtyCapture, errorsOf, fakePTY } from '../../cli/handlers/menu-test-helpers.ts';
import { commandApprovalRequest, fileChangeRequest } from '../../helpers/codex-threads.ts';

const MAIN = '00000000-0000-7000-8000-0000000000c1';
const SUB = '00000000-0000-7000-8000-0000000000c2';
const STRANGER = '00000000-0000-7000-8000-0000000000c3';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until(cond: () => boolean, what: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(10);
  }
}

describe('CodexDecisions', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let sessionId: UUID;
  let decisions: CodexDecisions;
  let sent: ProtocolMessage[];
  let responses: Array<{ id: RequestId; result: unknown }>;
  let logs: string[];
  /** What `respond` says: true is "sent", false is "the link is not ready". */
  let linkUp: boolean;
  let respondThrows: boolean;
  let presentThrows: boolean;
  let roles: Map<string, ThreadRole>;
  let pty: PtyCapture;
  let presented: Question[];
  const toDispose: CodexDecisions[] = [];

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-codex-decisions-'));
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    sessionId = registry.createSessionId();
    sent = [];
    responses = [];
    logs = [];
    presented = [];
    linkUp = true;
    respondThrows = false;
    presentThrows = false;
    roles = new Map([
      [MAIN, 'main'],
      [SUB, 'subagent'],
    ]);
    pty = { writes: [], submits: [] };
    configureLogger({ writeLog: () => {} });
    const { messageApi } = createMessageApiForSession(
      {
        sessionRegistry: registry,
        transcriptWatchers: new Map(),
        deviceTokens: new Map(),
        pushConfig: () => ({ signalingUrl: 'http://127.0.0.1:9' }),
        updateRemiStatus: () => {},
        maxBulletLength: 500,
        sendMessage: (_sid, message) => sent.push(message),
      },
      sessionId,
    );
    registry.registerSession(sessionId, '/test/dir', fakePTY(pty), messageApi);
    registry.attachConnection(sessionId, CID);
    decisions = build();
    toDispose.push(decisions);
    // The same `present` the Codex session wires.
    present = (q) => {
      if (presentThrows) throw new Error('the message API failed');
      presented.push(q);
      messageApi.handleQuestion(q, { held: true });
    };
  });

  afterEach(async () => {
    for (const d of toDispose.splice(0)) d.dispose();
    __resetLoggerForTests();
    await registry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  let present: CodexDecisionsDeps['present'] = () => {};

  function build(over: Partial<CodexDecisionsDeps> = {}): CodexDecisions {
    return new CodexDecisions({
      sessionId,
      client: {
        respond: (id, result) => {
          if (respondThrows) throw new Error('cannot serialize');
          if (!linkUp) return false;
          responses.push({ id, result });
          return true;
        },
      },
      sessionRegistry: registry,
      present: (q) => present(q),
      onQuestionResolved: (sid, qid, reason) => sent.push(createQuestionResolved(sid, qid, reason)),
      threadRole: (id) => roles.get(id) ?? null,
      log: (m) => logs.push(m),
      replayWindowMs: 60,
      disconnectGraceMs: 150,
      ...over,
    });
  }

  const cards = (): QuestionMessage[] =>
    sent.filter((m): m is QuestionMessage => m.type === 'question');
  const resolvedMessages = (): QuestionResolvedMessage[] =>
    sent.filter((m): m is QuestionResolvedMessage => m.type === 'question_resolved');
  const pending = (): Question[] => [
    ...(registry.getSession(sessionId)?.currentQuestions.values() ?? []),
  ];

  /** A command approval of `thread`, delivered the way the client delivers a server request. */
  function request(
    id: number,
    command = 'touch unit-marker',
    thread = MAIN,
    over: Record<string, unknown> = {},
  ): void {
    const { method, params } = commandApprovalRequest(thread, command, over);
    decisions.handleServerRequest({ id, method, params });
  }

  const optionNamed = (q: Question, label: string): HeldAnswer => ({
    kind: 'option',
    option: q.options.find((o) => o.label === label) as Question['options'][number],
  });

  /** The one card that is live, as the registry holds it. */
  const only = (): Question => {
    expect(pending()).toHaveLength(1);
    return pending()[0] as Question;
  };

  describe('what becomes a card', () => {
    test('a plain command approval of the main thread is presented held, with its options, and registered', () => {
      request(5, "/bin/zsh -c 'touch spike-marker-A1'");
      const q = only();
      expect(q.held).toBe(true);
      expect(q.text).toBe("Allow Codex to run: /bin/zsh -c 'touch spike-marker-A1'");
      expect(q.options.map((o) => o.value)).toEqual(['accept', 'cancel']);
      expect(cards()).toHaveLength(1);
      expect(presented).toHaveLength(1);
      expect(decisions.isHeld(q.id)).toBe(true);
      expect(responses).toEqual([]);
    });

    test("another thread's request is never a card and never answered, however it is addressed", () => {
      request(5, 'touch other', STRANGER);
      decisions.handleServerRequest({
        id: 6,
        method: 'item/commandExecution/requestApproval',
        params: {},
      });
      decisions.handleServerRequest({
        id: 7,
        method: 'item/commandExecution/requestApproval',
        params: null,
      });
      decisions.handleServerRequest({
        id: 8,
        method: 'item/commandExecution/requestApproval',
        params: { threadId: 42 },
      });
      expect(pending()).toEqual([]);
      expect(cards()).toEqual([]);
      expect(responses).toEqual([]);
      expect(logs.filter((l) => l.includes('not about this session'))).toHaveLength(4);
    });

    test('a method with no card (the tools, token refresh, attestation, time) is ignored by name only, and never answered', () => {
      for (const method of [
        'item/tool/call',
        'account/chatgptAuthTokens/refresh',
        'attestation/generate',
        'currentTime/read',
        'applyPatchApproval',
      ]) {
        decisions.handleServerRequest({
          id: 1,
          method,
          params: { threadId: MAIN, secret: 'sk-do-not-log-me' },
        });
      }
      expect(pending()).toEqual([]);
      expect(responses).toEqual([]);
      expect(logs).toHaveLength(5);
      expect(logs.join('\n')).toContain('"account/chatgptAuthTokens/refresh"');
      expect(logs.join('\n')).not.toContain('sk-do-not-log-me');
    });

    test("a subagent's request is a terminalOnly card with its agent, never answerable", () => {
      request(5, 'touch sub-marker', SUB);
      const q = only();
      expect(q.terminalOnly).toBe(true);
      expect(q.agentId).toBe(SUB);
      expect(q.options).toEqual([]);
      expect(decisions.isHeld(q.id)).toBe(false);
      expect(decisions.answerHeld(q.id, { kind: 'text', text: 'accept' })).toBe('refused');
      expect(responses).toEqual([]);
    });

    test('the same request delivered again while its card is live is one card', () => {
      request(5);
      request(5);
      expect(cards()).toHaveLength(1);
      expect(pending()).toHaveLength(1);
    });

    test('a card that cannot be shown leaves nothing tracked and nothing answered', () => {
      presentThrows = true;
      request(5);
      expect(pending()).toEqual([]);
      expect(decisions.hasOpenHookPrompt()).toBe(false);
      expect(responses).toEqual([]);
      expect(logs.some((l) => l.includes('could not show the card'))).toBe(true);
    });

    test('the cards of a file change and of a command too long to show are terminalOnly', () => {
      const { method, params } = fileChangeRequest(MAIN, 'edit a file');
      decisions.handleServerRequest({ id: 2, method, params });
      request(3, `echo ${'x'.repeat(COMMAND_TEXT_MAX)}`);
      expect(pending().map((q) => q.terminalOnly)).toEqual([true, true]);
      expect(pending().every((q) => !decisions.isHeld(q.id))).toBe(true);
    });

    test('more requests than the bound dismiss the oldest, which is never answered, and keep the newest', () => {
      // The registry's own cap of eight warns for each card it evicts; not this test's news.
      const warn = console.warn;
      console.warn = () => {};
      try {
        for (let id = 1; id <= 70; id++) request(id, `touch m${id}`);
      } finally {
        console.warn = warn;
      }
      expect(responses).toEqual([]);
      // The registry's own cap keeps the unpinned ones to eight, so count what the channel tracks.
      const held = pending().filter((q) => decisions.isHeld(q.id));
      expect(held.length).toBeLessThanOrEqual(64);
      expect(held.map((q) => q.text)).toContain('Allow Codex to run: touch m70');
      expect(held.map((q) => q.text)).not.toContain('Allow Codex to run: touch m1');
      expect(resolvedMessages().length).toBeGreaterThanOrEqual(6);
      expect(resolvedMessages().every((m) => m.reason === 'cancelled')).toBe(true);
    });

    test('a log line carries no command, no reason and no full thread id', () => {
      request(5, 'echo sk-command-secret', MAIN, { reason: 'because sk-reason-secret' });
      request(6, 'echo sk-sub-secret', SUB);
      const { method, params } = fileChangeRequest(MAIN, 'sk-file-secret');
      decisions.handleServerRequest({ id: 7, method, params });
      const all = logs.join('\n');
      for (const marker of [
        'sk-command-secret',
        'sk-reason-secret',
        'sk-sub-secret',
        'sk-file-secret',
      ]) {
        expect(all).not.toContain(marker);
      }
      expect(all).not.toContain(MAIN);
      expect(all).toContain(MAIN.slice(0, 8));
    });
  });

  describe('answering', () => {
    test('Yes sends exactly accept, once; the answer is resolved; a second answer is closed and sends nothing', () => {
      request(5);
      const q = only();
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('resolved');
      expect(responses).toEqual([{ id: 5, result: { decision: 'accept' } }]);
      expect(decisions.isHeld(q.id)).toBe(false);
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(decisions.answerHeld(q.id, { kind: 'cancel' })).toBe('closed');
      expect(responses).toHaveLength(1);
    });

    test("No and the card's Cancel both send the No decision of the card", () => {
      request(5);
      request(6);
      const [a, b] = pending() as [Question, Question];
      expect(decisions.answerHeld(a.id, optionNamed(a, 'No'))).toBe('resolved');
      expect(decisions.answerHeld(b.id, { kind: 'cancel' })).toBe('resolved');
      expect(responses).toEqual([
        { id: 5, result: { decision: 'cancel' } },
        { id: 6, result: { decision: 'cancel' } },
      ]);
    });

    test('a request that lists decline and not cancel is answered No with decline', () => {
      request(5, 'touch x', MAIN, { availableDecisions: ['accept', 'decline'] });
      const q = only();
      expect(decisions.answerHeld(q.id, optionNamed(q, 'No'))).toBe('resolved');
      expect(responses).toEqual([{ id: 5, result: { decision: 'decline' } }]);
    });

    test('free text, a structured answer, an ambiguous one and a foreign option are refused: nothing is sent and the card stays held', () => {
      request(5);
      const q = only();
      const foreign = {
        ...(q.options[0] as Question['options'][number]),
        value: 'acceptForSession',
      };
      for (const answer of [
        { kind: 'text', text: 'accept' },
        { kind: 'text', text: 'Yes' },
        { kind: 'selections', selections: [{ questionIndex: 0, optionIndices: [0] }] },
        { kind: 'ambiguous' },
        { kind: 'option', option: foreign },
      ] satisfies HeldAnswer[]) {
        expect(decisions.answerHeld(q.id, answer), answer.kind).toBe('refused');
      }
      expect(responses).toEqual([]);
      expect(decisions.isHeld(q.id)).toBe(true);
      expect(pending()).toHaveLength(1);
    });

    test('a terminalOnly card refuses every answer but Cancel, which clears it and sends nothing', () => {
      const { method, params } = fileChangeRequest(MAIN);
      decisions.handleServerRequest({ id: 2, method, params });
      const q = only();
      for (const answer of [
        { kind: 'text', text: 'Yes' },
        { kind: 'ambiguous' },
        { kind: 'selections', selections: [] },
      ] satisfies HeldAnswer[]) {
        expect(decisions.answerHeld(q.id, answer)).toBe('refused');
      }
      expect(decisions.answerHeld(q.id, { kind: 'cancel' })).toBe('closed');
      expect(responses).toEqual([]);
      // Forgotten: it is nothing any more, and a later answer is closed too.
      expect(decisions.hasOpenHookPrompt()).toBe(false);
      expect(decisions.answerHeld(q.id, { kind: 'cancel' })).toBe('closed');
    });

    test('an id this session never showed is closed, never unknown, for every kind of answer', () => {
      const never = crypto.randomUUID() as UUID;
      for (const answer of [
        { kind: 'cancel' },
        { kind: 'text', text: 'x' },
        { kind: 'ambiguous' },
        { kind: 'selections', selections: [] },
      ] satisfies HeldAnswer[]) {
        expect(decisions.answerHeld(never, answer), answer.kind).toBe('closed');
      }
      expect(responses).toEqual([]);
    });

    test('a link that is not ready closes the card and sends nothing; the card is then not tracked', () => {
      request(5);
      const q = only();
      linkUp = false;
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(responses).toEqual([]);
      expect(decisions.isHeld(q.id)).toBe(false);
      expect(logs.some((l) => l.includes('the link is not ready'))).toBe(true);
      // The link comes back: the old card is still not answerable.
      linkUp = true;
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(responses).toEqual([]);
    });

    test('an answer that cannot be sent (respond throws) closes the card, sends nothing and logs only the error name', () => {
      request(5);
      const q = only();
      respondThrows = true;
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(responses).toEqual([]);
      expect(logs.some((l) => l.includes('could not send the answer (Error)'))).toBe(true);
      expect(logs.join('\n')).not.toContain('cannot serialize');
    });

    test("a thread that stopped being the session's (a rotation) cannot be answered through its card", () => {
      request(5);
      const q = only();
      roles.delete(MAIN);
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(responses).toEqual([]);
      expect(decisions.isHeld(q.id)).toBe(false);
    });
  });

  describe('the request resolved', () => {
    test('the TUI answering first dismisses the card for every client, and a late phone answer is closed and sends nothing', () => {
      request(5);
      const q = only();
      decisions.handleResolved({ threadId: MAIN, requestId: 5 });
      expect(pending()).toEqual([]);
      expect(resolvedMessages().map((m) => [m.questionId, m.reason])).toEqual([
        [q.id, 'cancelled'],
      ]);
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(responses).toEqual([]);
    });

    test('our own answer is not dismissed again when its resolved arrives', () => {
      request(5);
      const q = only();
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('resolved');
      decisions.handleResolved({ threadId: MAIN, requestId: 5 });
      expect(resolvedMessages()).toEqual([]);
      // The entry is gone: the same request delivered again is a new card.
      request(5);
      expect(cards()).toHaveLength(2);
    });

    test('a resolved names a request by thread and id: the same id on another thread is another request', () => {
      request(5, 'touch main', MAIN);
      request(5, 'touch sub', SUB);
      expect(pending()).toHaveLength(2);
      decisions.handleResolved({ threadId: SUB, requestId: 5 });
      const left = only();
      expect(left.text).toBe('Allow Codex to run: touch main');
      expect(decisions.isHeld(left.id)).toBe(true);
      decisions.handleResolved({ threadId: STRANGER, requestId: 5 });
      expect(pending()).toHaveLength(1);
      // The main card still answers, with its own id.
      expect(decisions.answerHeld(left.id, optionNamed(left, 'Yes'))).toBe('resolved');
      expect(responses).toEqual([{ id: 5, result: { decision: 'accept' } }]);
    });

    test('a resolved for a request nobody tracks, or a string id that is not the numeric one, changes nothing', () => {
      request(5);
      decisions.handleResolved({ threadId: MAIN, requestId: 6 });
      decisions.handleResolved({ threadId: MAIN, requestId: 'x' });
      expect(pending()).toHaveLength(1);
      expect(resolvedMessages()).toEqual([]);
    });

    test('a failure to remove the card or to tell the clients is logged by error name and does not break the channel', () => {
      const failing = build({
        sessionRegistry: {
          removeQuestion: () => {
            throw new Error('registry down');
          },
        },
        onQuestionResolved: () => {
          throw new Error('broadcast down');
        },
      });
      toDispose.push(failing);
      const { method, params } = commandApprovalRequest(MAIN, 'touch x');
      failing.handleServerRequest({ id: 9, method, params });
      failing.handleResolved({ threadId: MAIN, requestId: 9 });
      expect(logs.some((l) => l.includes('could not remove a card (Error)'))).toBe(true);
      expect(logs.some((l) => l.includes('could not tell the clients (Error)'))).toBe(true);
      expect(logs.join('\n')).not.toContain('registry down');
      expect(failing.hasOpenHookPrompt()).toBe(false);
    });
  });

  describe('the link drops: retire, replay, sweep', () => {
    test('every card is unanswerable at once, and stays on the phone until the replay says; answering it clears it and sends nothing', () => {
      request(5);
      const q = only();
      decisions.handleDisconnected();
      expect(decisions.isHeld(q.id)).toBe(false);
      expect(pending()).toHaveLength(1);
      expect(decisions.hasOpenHookPrompt()).toBe(true);
      // Even if the link were up again, the old card is never answered.
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(decisions.answerHeld(q.id, { kind: 'cancel' })).toBe('closed');
      expect(responses).toEqual([]);
    });

    test('a replayed request makes a new card with a new id, dismisses the retired one at once, and the new one answers', () => {
      request(5);
      const old = only();
      decisions.handleDisconnected();
      decisions.handleReattached();
      request(5);
      const fresh = only();
      expect(fresh.id).not.toBe(old.id);
      expect(cards()).toHaveLength(2);
      expect(resolvedMessages().map((m) => [m.questionId, m.reason])).toEqual([
        [old.id, 'cancelled'],
      ]);
      expect(decisions.answerHeld(old.id, optionNamed(old, 'Yes'))).toBe('closed');
      expect(responses).toEqual([]);
      expect(decisions.answerHeld(fresh.id, optionNamed(fresh, 'Yes'))).toBe('resolved');
      expect(responses).toEqual([{ id: 5, result: { decision: 'accept' } }]);
    });

    test('a request not replayed by the end of the window was resolved while the link was down: its card is dismissed then, and not before', async () => {
      request(5);
      request(6, 'touch two');
      const [one, two] = pending() as [Question, Question];
      decisions.handleDisconnected();
      decisions.handleReattached();
      // Replayed: only request 6 comes back, and its retired card is replaced at once.
      request(6, 'touch two');
      expect(resolvedMessages().map((m) => m.questionId)).toEqual([two.id]);
      // Request 5's retired card is still there, inside the window.
      expect(pending().some((q) => q.id === one.id)).toBe(true);
      await until(() => !pending().some((q) => q.id === one.id), 'the sweep');
      expect(resolvedMessages().map((m) => [m.questionId, m.reason])).toEqual([
        [two.id, 'cancelled'],
        [one.id, 'cancelled'],
      ]);
      // The replayed card is still live and answerable.
      const fresh = pending().find((q) => decisions.isHeld(q.id)) as Question;
      expect(fresh.text).toBe('Allow Codex to run: touch two');
      expect(decisions.answerHeld(fresh.id, optionNamed(fresh, 'Yes'))).toBe('resolved');
      expect(responses).toEqual([{ id: 6, result: { decision: 'accept' } }]);
    });

    test('the replay window, not the grace period, ends the wait once the tracker attached again', async () => {
      // The grace period is a minute: only the window (50 ms) can dismiss the card in time.
      const quick = build({ replayWindowMs: 50, disconnectGraceMs: 60_000 });
      toDispose.push(quick);
      const { method, params } = commandApprovalRequest(MAIN, 'touch x');
      quick.handleServerRequest({ id: 5, method, params });
      const card = only();
      quick.handleDisconnected();
      quick.handleReattached();
      await until(() => pending().length === 0, 'the sweep after the window', 5000);
      expect(resolvedMessages().map((m) => m.questionId)).toEqual([card.id]);
    });

    test('a link that never comes back dismisses its retired cards after the grace period, and a re-attach shortens the wait to the replay window', async () => {
      request(5);
      const q = only();
      decisions.handleDisconnected();
      expect(pending()).toHaveLength(1);
      await until(() => pending().length === 0, 'the grace sweep');
      expect(resolvedMessages().map((m) => m.questionId)).toEqual([q.id]);
      expect(logs.some((l) => l.includes('were not replayed'))).toBe(true);
    });

    test('a second drop inside the window starts the grace over, so a card is not swept while the link is down', async () => {
      const slow = build({ replayWindowMs: 40, disconnectGraceMs: 600 });
      toDispose.push(slow);
      const { method, params } = commandApprovalRequest(MAIN, 'touch x');
      slow.handleServerRequest({ id: 5, method, params });
      slow.handleDisconnected();
      slow.handleReattached();
      slow.handleDisconnected();
      await sleep(250);
      // Past the replay window (40 ms), well inside the grace (600 ms): still there.
      expect(pending()).toHaveLength(1);
      expect(resolvedMessages()).toEqual([]);
    });

    test('an answered request is forgotten at the drop: no card, nothing to sweep, nothing dismissed', async () => {
      request(5);
      const q = only();
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('resolved');
      // The answer handler removes the card.
      registry.removeQuestion(sessionId, q.id);
      decisions.handleDisconnected();
      decisions.handleReattached();
      await sleep(200);
      expect(resolvedMessages()).toEqual([]);
      expect(decisions.hasOpenHookPrompt()).toBe(false);
      // The request is still pending on a re-attach (our answer was lost): it is a new card.
      request(5);
      expect(cards()).toHaveLength(2);
    });

    test('a drop with no cards sets no timer, and a re-attach with none retired sets none either', async () => {
      decisions.handleDisconnected();
      decisions.handleReattached();
      request(5);
      await sleep(250);
      expect(pending()).toHaveLength(1);
      expect(resolvedMessages()).toEqual([]);
    });

    test('after dispose a retired card is dismissed once, and no timer fires later', async () => {
      request(5);
      const q = only();
      decisions.handleDisconnected();
      decisions.dispose();
      expect(resolvedMessages().map((m) => m.questionId)).toEqual([q.id]);
      await sleep(300);
      expect(resolvedMessages()).toHaveLength(1);
      expect(logs.some((l) => l.includes('were not replayed'))).toBe(false);
    });
  });

  describe('what the session reads from it', () => {
    test('isHeld is a live actionable card; hasMainHold is a main-thread request or a flag; hasOpenHookPrompt adds any other card', () => {
      expect(decisions.hasMainHold()).toBe(false);
      expect(decisions.hasOpenHookPrompt()).toBe(false);
      request(5, 'touch sub', SUB);
      const sub = only();
      expect(decisions.isHeld(sub.id)).toBe(false);
      expect(decisions.hasMainHold()).toBe(false);
      expect(decisions.hasOpenHookPrompt()).toBe(true);
      request(6);
      const main = pending().find((q) => q.id !== sub.id) as Question;
      expect(decisions.isHeld(main.id)).toBe(true);
      expect(decisions.hasMainHold()).toBe(true);
      expect(decisions.isHeld(crypto.randomUUID() as UUID)).toBe(false);
      // Answered: nothing is waiting on the phone any more.
      decisions.answerHeld(main.id, optionNamed(main, 'Yes'));
      expect(decisions.isHeld(main.id)).toBe(false);
      expect(decisions.hasMainHold()).toBe(false);
      decisions.handleResolved({ threadId: SUB, requestId: 5 });
      expect(decisions.hasOpenHookPrompt()).toBe(false);
    });

    test("the main thread's waiting flags count as a hold with no card; a subagent's, another thread's and a cleared flag do not", () => {
      const waiting: ThreadStatus = { type: 'active', activeFlags: ['waitingOnApproval'] };
      decisions.handleStatus(SUB, waiting);
      decisions.handleStatus(STRANGER, waiting);
      expect(decisions.hasMainHold()).toBe(false);
      decisions.handleStatus(MAIN, waiting);
      expect(decisions.hasMainHold()).toBe(true);
      expect(decisions.hasOpenHookPrompt()).toBe(true);
      decisions.handleStatus(MAIN, { type: 'active', activeFlags: [] });
      expect(decisions.hasMainHold()).toBe(false);
      decisions.handleStatus(MAIN, waiting);
      decisions.handleStatus(MAIN, { type: 'idle' });
      expect(decisions.hasMainHold()).toBe(false);
    });

    test('an Escape sent through remi changes nothing: only the app-server says a request is over', () => {
      request(5);
      decisions.noteTerminalEscape();
      expect(pending()).toHaveLength(1);
      expect(decisions.isHeld(only().id)).toBe(true);
    });

    test('retireQuestion stops tracking and dismisses nothing (the caller already did)', () => {
      request(5);
      const q = only();
      decisions.retireQuestion(q.id);
      expect(decisions.isHeld(q.id)).toBe(false);
      expect(resolvedMessages()).toEqual([]);
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      decisions.retireQuestion(crypto.randomUUID() as UUID);
    });

    test('forceRelease dismisses every card still shown, retired ones included, and counts them, but not an answered one, and sends nothing', () => {
      request(5);
      request(6, 'touch two');
      decisions.handleDisconnected();
      // After the drop: one new card answered by the phone, one still waiting.
      request(7, 'touch three');
      request(8, 'touch four');
      const answered = pending().find((q) => q.text.endsWith('touch three')) as Question;
      expect(decisions.answerHeld(answered.id, optionNamed(answered, 'Yes'))).toBe('resolved');
      // The answer handler removes the card it answered.
      registry.removeQuestion(sessionId, answered.id);
      decisions.handleStatus(MAIN, { type: 'active', activeFlags: ['waitingOnApproval'] });
      // Two retired (5, 6) and one live (8) are shown; the answered one (7) is not.
      expect(decisions.forceRelease('remi unstick')).toEqual({ resolved: 3 });
      expect(pending()).toEqual([]);
      expect(resolvedMessages().every((m) => m.reason === 'cancelled')).toBe(true);
      expect(resolvedMessages()).toHaveLength(3);
      expect(responses).toHaveLength(1);
      expect(decisions.hasMainHold()).toBe(false);
      expect(decisions.forceRelease('again')).toEqual({ resolved: 0 });
    });

    test('dispose dismisses what is shown, then ignores every event and answer', () => {
      request(5);
      const q = only();
      decisions.dispose();
      expect(pending()).toEqual([]);
      expect(resolvedMessages().map((m) => m.questionId)).toEqual([q.id]);
      request(6);
      decisions.handleResolved({ threadId: MAIN, requestId: 6 });
      decisions.handleDisconnected();
      decisions.handleReattached();
      expect(cards()).toHaveLength(1);
      expect(decisions.answerHeld(q.id, optionNamed(q, 'Yes'))).toBe('closed');
      expect(responses).toEqual([]);
      decisions.dispose();
      expect(resolvedMessages()).toHaveLength(1);
    });
  });

  describe('types nothing, through the real handlers (the same wiring cli.ts builds)', () => {
    let errors: Array<{ connectionId: UUID; message: ProtocolMessage }>;
    let handlers: ReturnType<typeof createInputHandlers>;

    beforeEach(() => {
      errors = [];
      const channel = decisions as DecisionChannel;
      handlers = createInputHandlers({
        sessionRegistry: registry,
        bindingStore: new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json'))),
        send: (connectionId, message) => {
          errors.push({ connectionId, message });
          return true;
        },
        ...gateAnswerDeps(() => channel),
        ...promptUpDeps(
          () => channel,
          () => channel.screen,
        ),
        acceptsTypedChat: () => false,
        onQuestionResolved: (sid, qid) => sent.push(createQuestionResolved(sid, qid, 'answered')),
        ...trackerScreenDeps(() => channel.screen),
      });
    });

    const typed = (): unknown[] => [...pty.writes, ...pty.submits];

    test('every answer variant to a live card is refused or answered through the app-server, and not one byte is typed', async () => {
      request(5);
      const q = only();
      const noExtra = undefined;
      // Free text, an option the card does not carry, a structured answer, a lock-screen relay of text.
      await handlers.onAnswer(CID, sessionId, q.id, 'please approve it', undefined, noExtra);
      await handlers.onAnswer(CID, sessionId, q.id, 'Yes, for this session', undefined, noExtra);
      await handlers.onAnswer(CID, sessionId, q.id, '', undefined, {
        selections: [{ questionIndex: 0, optionIndices: [0] }],
      });
      expect(await handlers.relayAnswer(sessionId, q.id, 'approve')).toBe('stale');
      expect(errorsOf(errors).map((e) => e.code)).toEqual([
        'STALE_ANSWER',
        'STALE_ANSWER',
        'STALE_ANSWER',
      ]);
      expect(responses).toEqual([]);
      expect(pending()).toHaveLength(1);
      expect(typed()).toEqual([]);

      // The card's own options go through the app-server: Yes, then (a second card) Cancel.
      await handlers.onAnswer(CID, sessionId, q.id, 'Yes', undefined, noExtra);
      request(6, 'touch two');
      await handlers.onAnswer(CID, sessionId, only().id, '', undefined, { cancel: true });
      expect(responses).toEqual([
        { id: 5, result: { decision: 'accept' } },
        { id: 6, result: { decision: 'cancel' } },
      ]);
      expect(resolvedMessages().map((m) => m.reason)).toEqual(['answered', 'answered']);
      expect(typed()).toEqual([]);
    });

    test('Cancel on a terminalOnly card clears it, answers nothing and types no Esc', async () => {
      const { method, params } = fileChangeRequest(MAIN);
      decisions.handleServerRequest({ id: 2, method, params });
      const q = only();
      await handlers.onAnswer(CID, sessionId, q.id, 'Yes', undefined, undefined);
      expect(errorsOf(errors)).toHaveLength(1);
      await handlers.onAnswer(CID, sessionId, q.id, '', undefined, { cancel: true });
      expect(pending()).toEqual([]);
      expect(resolvedMessages()).toHaveLength(1);
      expect(responses).toEqual([]);
      expect(typed()).toEqual([]);
    });

    test('an id the channel never showed, with a card the registry holds anyway, is closed: Cancel types no Esc and an answer types no digit', async () => {
      // Something other than this channel put a card in the registry (nothing does, today): the
      // answer and Cancel handlers type only for `unknown`, which the channel never says.
      const stray: Question = {
        id: crypto.randomUUID() as UUID,
        text: 'Allow something',
        options: [
          { label: 'Yes', value: '1', isRecommended: true, isYes: true, isNo: false },
          { label: 'No', value: '2', isRecommended: false, isYes: false, isNo: true },
        ],
        allowsFreeText: false,
        isAnswered: false,
      };
      registry.addQuestion(sessionId, stray);
      await handlers.onAnswer(CID, sessionId, stray.id, '', undefined, { cancel: true });
      expect(typed()).toEqual([]);
      registry.addQuestion(sessionId, stray);
      await handlers.onAnswer(CID, sessionId, stray.id, 'Yes', undefined, undefined);
      await handlers.onAnswer(CID, sessionId, stray.id, '1', undefined, undefined);
      expect(typed()).toEqual([]);
      expect(responses).toEqual([]);
    });

    test('a late phone answer after the TUI answered is STALE_ANSWER, sends nothing and types nothing; a retired card is the same', async () => {
      request(5);
      const q = only();
      decisions.handleResolved({ threadId: MAIN, requestId: 5 });
      await handlers.onAnswer(CID, sessionId, q.id, 'Yes', undefined, undefined);
      expect(errorsOf(errors)[0]?.code).toBe('STALE_ANSWER');

      request(6);
      const retired = only();
      decisions.handleDisconnected();
      await handlers.onAnswer(CID, sessionId, retired.id, 'Yes', undefined, undefined);
      expect(errorsOf(errors).map((e) => e.code)).toEqual(['STALE_ANSWER', 'STALE_ANSWER']);
      expect(responses).toEqual([]);
      expect(typed()).toEqual([]);
    });

    test("chat is refused while a card is up, and a person's raw keystroke is the one thing that reaches the terminal", async () => {
      request(5);
      await handlers.onUserInput(CID, sessionId, 'typed chat', false);
      expect(errorsOf(errors).map((e) => e.code)).toEqual(['PROMPT_WAITING']);
      expect(typed()).toEqual([]);
      // Positive control: the same handler does type a raw write.
      await handlers.onUserInput(CID, sessionId, 'q', true);
      expect(pty.writes).toEqual(['q']);
      expect(pty.submits).toEqual([]);
    });
  });
});
