/** Real question store, MessageAPI, Codex writer and Unix WebSocket client; synthetic upstream frames only. */
import { afterEach, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import { MessageAPI } from '../../../src/api/message-api.ts';
import { AppServerClient } from '../../../src/harness/codex/app-server-client.ts';
import {
  asyncQuestionHistoryCollector,
  encodeAsyncQuestionReply,
  parseAsyncQuestionSource,
} from '../../../src/harness/codex/async-question-codec.ts';
import { CodexAsyncQuestions } from '../../../src/harness/codex/async-questions.ts';
import { CodexTextWriter } from '../../../src/harness/codex/codex-text-writer.ts';
import { type AnswerCommit, AnswerDeliveryUncertainError } from '../../../src/harness/decision.ts';
import { QuestionStore } from '../../../src/session/question-store.ts';
import { FakeAppServer } from '../../helpers/fake-app-server.ts';

const SID = '00000000-0000-4000-8000-000000000001' as UUID;
const THREAD = '00000000-0000-7000-8000-000000000002';
const TURN = '00000000-0000-7000-8000-000000000003';
const raw = () => ({
  type: 'agentMessage',
  id: 'call_owned_question',
  delivery: 'async',
  text: 'serialized tool input',
  questions: [
    { title: 'Choose a route', options: ['Local', 'Remote'] },
    { title: 'Why?', options: null },
  ],
});
const immediate: AnswerCommit = (effect) => ({ kind: 'committed', value: effect() });
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(timeoutMs = 500) {
  const server = FakeAppServer.start();
  let epoch: object = {};
  let bound = THREAD;
  let ready = false;
  const client = new AppServerClient(
    {
      socketPath: () => server.socketPath,
      clientInfo: { name: 'remi', title: null, version: 'owned-async-question-control' },
      requestTimeoutMs: timeoutMs,
    },
    (event) => {
      if (event.type === 'ready') ready = true;
    },
  );
  const current = () => (client.state === 'ready' ? { threadId: bound, epoch } : null);
  const store = new QuestionStore(SID);
  const api = new MessageAPI({ sessionId: SID }, { onQuestion: (q) => store.add(q) });
  const notices: string[] = [];
  const resolved: string[] = [];
  const writer = new CodexTextWriter({ client, current, blocked: () => false });
  const channel = new CodexAsyncQuestions({
    sessionId: SID,
    current,
    writer,
    registry: {
      getQuestion: (_sid, id) => store.get(id),
      removeQuestion: (_sid, id, signal) => store.remove(id, signal),
    },
    present: (q) => api.handleQuestion(q, { held: true, answerPath: 'structured' }),
    resolved: (_sid, id) => {
      resolved.push(id);
    },
    notice: (text) => notices.push(text),
    log: () => {},
  });
  cleanups.push(async () => {
    channel.dispose();
    writer.close();
    client.stop();
    await server.stop();
  });
  server.onRequest('thread/read', () => ({
    thread: {
      id: THREAD,
      ephemeral: false,
      parentThreadId: null,
      status: { type: 'active', activeFlags: [] },
    },
  }));
  server.onRequest('thread/turns/list', () => ({
    data: [{ id: TURN, status: 'inProgress' }],
    nextCursor: null,
  }));
  server.onRequest('turn/steer', () => ({ turnId: TURN }));
  client.start();
  await server.waitFor(() => ready, 'owned async client admission');
  const show = () => {
    channel.handleNotification('item/completed', { threadId: THREAD, item: raw() });
    const q = [...store.questions.values()][0];
    if (!q) throw new Error('OWNED_QUESTION_NOT_REGISTERED');
    return q;
  };
  return {
    server,
    client,
    channel,
    store,
    notices,
    resolved,
    show,
    replaceEpoch: () => {
      epoch = {};
    },
    replaceThread: () => {
      bound = '00000000-0000-7000-8000-000000000004';
    },
    effects: () =>
      server.received.filter(
        (entry) => entry.frame['method'] === 'turn/steer' || entry.frame['method'] === 'turn/start',
      ),
  };
}
const selections = () => ({
  kind: 'selections' as const,
  selections: [
    { questionIndex: 0, optionIndices: [1] },
    { questionIndex: 1, optionIndices: [], text: 'Owned explanation' },
  ],
});

test('async metadata becomes a real multi-question card and one guarded structured user reply', async () => {
  const f = await fixture();
  const q = f.show();
  expect(q.kind).toBe('multi_question');
  expect(q.questions).toHaveLength(2);
  expect(q.options).toEqual([]);
  expect(q.allowsFreeText).toBe(true);
  expect(q.questions?.[0]?.options.map((o) => o.label)).toEqual(['Local', 'Remote']);
  expect(await f.channel.answerHeld(q.id, selections(), immediate)).toBe('resolved');
  expect(await f.channel.answerHeld(q.id, selections(), immediate)).toBe('closed');
  const effects = f.effects();
  expect(effects).toHaveLength(1);
  const params = effects[0]?.frame['params'] as Record<string, unknown>;
  expect(Object.keys(params).sort()).toEqual([
    'clientUserMessageId',
    'expectedTurnId',
    'input',
    'threadId',
  ]);
  expect(params['expectedTurnId']).toBe(TURN);
  const source = parseAsyncQuestionSource(raw());
  if (!source) throw new Error('OWNED_QUESTION_SOURCE_MISSING');
  expect(params['input']).toEqual([
    {
      type: 'text',
      text: encodeAsyncQuestionReply(source, [
        { questionIndex: 0, answer: 'Remote' },
        { questionIndex: 1, answer: 'Owned explanation' },
      ]),
    },
  ]);
});
test('incomplete selections, missing current device authority and cancel never enqueue input', async () => {
  const f = await fixture();
  const q = f.show();
  expect(await f.channel.answerHeld(q.id, selections())).toBe('authority-refused');
  expect(
    await f.channel.answerHeld(
      q.id,
      { kind: 'selections', selections: [{ questionIndex: 0, optionIndices: [9] }] },
      immediate,
    ),
  ).toBe('refused');
  expect(await f.channel.answerHeld(q.id, selections(), () => ({ kind: 'refused' }))).toBe(
    'authority-refused',
  );
  expect(await f.channel.answerHeld(q.id, { kind: 'cancel' }, immediate)).toBe('closed');
  expect(f.effects()).toEqual([]);
});
test('thread and link epoch changes after metadata starts refuse the possible effect', async () => {
  for (const replace of ['thread', 'epoch'] as const) {
    const f = await fixture();
    const q = f.show();
    f.server.onRequest('thread/read', () => {
      if (replace === 'thread') f.replaceThread();
      else f.replaceEpoch();
      return {
        thread: {
          id: THREAD,
          ephemeral: false,
          parentThreadId: null,
          status: { type: 'active', activeFlags: [] },
        },
      };
    });
    expect(await f.channel.answerHeld(q.id, selections(), immediate)).toBe('closed');
    expect(f.effects()).toEqual([]);
  }
});
test('answered history is reconciled before recovery and emits no pending historical card', async () => {
  const f = await fixture();
  const source = parseAsyncQuestionSource(raw());
  if (!source) throw new Error('OWNED_QUESTION_SOURCE_MISSING');
  const history = asyncQuestionHistoryCollector();
  history.source(source);
  history.reply(
    encodeAsyncQuestionReply(source, [
      { questionIndex: 0, answer: 'Local' },
      { questionIndex: 1, answer: 'Because' },
    ]) ?? '',
  );
  f.channel.reconcile(THREAD, history.finish(true));
  expect(f.store.questions.size).toBe(0);
  expect(f.effects()).toEqual([]);
});
test('a partial external answer replaces the card with exact remaining original indices', async () => {
  const f = await fixture();
  const old = f.show();
  const source = parseAsyncQuestionSource(raw());
  if (!source) throw new Error('OWNED_QUESTION_SOURCE_MISSING');
  f.channel.handleNotification('item/started', {
    threadId: THREAD,
    item: {
      type: 'userMessage',
      id: 'owned-reply',
      content: [
        {
          type: 'text',
          text: encodeAsyncQuestionReply(source, [{ questionIndex: 0, answer: 'Local' }]),
        },
      ],
    },
  });
  const q = [...f.store.questions.values()][0];
  expect(q?.id).not.toBe(old.id);
  expect(q?.questions).toHaveLength(1);
  expect(await f.channel.answerHeld(old.id, selections(), immediate)).toBe('closed');
  if (!q) throw new Error('OWNED_REMAINING_QUESTION_MISSING');
  expect(
    await f.channel.answerHeld(q.id, { kind: 'text', text: 'Remaining answer' }, immediate),
  ).toBe('resolved');
  const params = f.effects()[0]?.frame['params'] as { input: { text: string }[] };
  expect(params.input[0]?.text).toContain('\\"call_owned_question\\",1]');
});
test('lost acceptance is uncertain and cannot cause a second submission', async () => {
  const f = await fixture(100);
  const q = f.show();
  f.server.ignore('turn/steer');
  await expect(f.channel.answerHeld(q.id, selections(), immediate)).rejects.toBeInstanceOf(
    AnswerDeliveryUncertainError,
  );
  expect(f.effects()).toHaveLength(1);
  expect(f.notices.join(' ')).toContain('uncertain');
  expect(await f.channel.answerHeld(q.id, selections(), immediate)).toBe('closed');
  expect(f.effects()).toHaveLength(1);
});
