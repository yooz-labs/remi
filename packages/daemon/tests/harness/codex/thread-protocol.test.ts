import { describe, expect, test } from 'bun:test';
import {
  parseThread,
  parseThreadItem,
  parseThreadStatus,
  parseTurnCompleted,
} from '../../../src/harness/codex/thread-protocol.ts';
import { fixtureFrameAt, placeholderUuid } from '../../helpers/codex-fixtures.ts';
import {
  agentMessageItem,
  realItem,
  turnCompletedFrame,
  turnError,
  userMessageItem,
} from '../../helpers/codex-threads.ts';

type Json = Record<string, unknown>;

/** The `thread` of a real `thread/started` frame (`expB.jsonl:7` is the TUI's, `:12` the title helper's). */
function realThread(line: 7 | 12): Json {
  const params = fixtureFrameAt('expB.jsonl', line).frame['params'] as { thread: Json };
  return JSON.parse(JSON.stringify(params.thread)) as Json;
}

describe('parseThread', () => {
  test('reads the TUI thread of the real spike frame', () => {
    expect(parseThread(realThread(7))).toEqual({
      id: placeholderUuid(9),
      cwd: '/work/project',
      ephemeral: false,
      createdAtSec: 1700000000,
      parentThreadId: null,
      threadSource: 'user',
      path: '/work/codex-home/sessions/rollout-T3.jsonl',
      environmentCount: 1,
      status: { type: 'idle' },
    });
  });

  test('reads the title helper of the real spike frame: ephemeral, no environments, no path', () => {
    expect(parseThread(realThread(12))).toMatchObject({
      id: placeholderUuid(10),
      ephemeral: true,
      threadSource: 'thread_title',
      environmentCount: 0,
      path: null,
    });
  });

  test('a thread whose `ephemeral` is missing or not a boolean reads as ephemeral (fail closed)', () => {
    for (const ephemeral of [null, 0, 'false', {}]) {
      expect(parseThread({ ...realThread(7), ephemeral })?.ephemeral, String(ephemeral)).toBe(true);
    }
    const { ephemeral: _omitted, ...withoutFlag } = realThread(7);
    expect(parseThread(withoutFlag)?.ephemeral).toBe(true);
    expect(parseThread({ ...realThread(7), ephemeral: false })?.ephemeral).toBe(false);
  });

  test('an id that is not a UUID is not a thread: it is stored and printed in a command line (R3)', () => {
    const hostile = [
      'x; rm -rf ~',
      '$(id)',
      'a',
      ' ',
      '00000000-0000-7000-8000-00000000000g',
      `${placeholderUuid(7)}\n`,
      `${placeholderUuid(7)} && id`,
      `x; ${placeholderUuid(7)}`,
      ` ${placeholderUuid(7)}`,
      `$(id)${placeholderUuid(7)}`,
      placeholderUuid(7).slice(1),
    ];
    for (const id of hostile) {
      expect(parseThread({ ...realThread(7), id }), JSON.stringify(id)).toBeNull();
    }
    // The shape is what counts, not the letter case.
    const upper = placeholderUuid(7).toUpperCase();
    expect(parseThread({ ...realThread(7), id: upper })?.id).toBe(upper);
  });

  test('it is null unless the value is an object with a non-empty string id', () => {
    for (const value of [null, undefined, 'x', 7, [], [realThread(7)], {}, { id: '' }, { id: 5 }]) {
      expect(parseThread(value), JSON.stringify(value)).toBeNull();
    }
  });

  test('a parentThreadId that is neither a string nor null makes the frame unusable', () => {
    expect(parseThread({ ...realThread(7), parentThreadId: 5 })).toBeNull();
    expect(parseThread({ ...realThread(7), parentThreadId: {} })).toBeNull();
    expect(parseThread({ ...realThread(7), parentThreadId: 'parent-1' })?.parentThreadId).toBe(
      'parent-1',
    );
    const { parentThreadId: _omitted, ...withoutParent } = realThread(7);
    expect(parseThread(withoutParent)?.parentThreadId).toBeNull();
  });

  test('missing or mistyped optional fields become null or zero, never a throw', () => {
    expect(
      parseThread({
        id: placeholderUuid(3),
        cwd: 5,
        createdAt: 'now',
        path: 7,
        threadSource: [],
        environments: 3,
      }),
    ).toEqual({
      id: placeholderUuid(3),
      cwd: null,
      ephemeral: true,
      createdAtSec: null,
      parentThreadId: null,
      threadSource: null,
      path: null,
      environmentCount: 0,
      status: null,
    });
    const id = placeholderUuid(3);
    expect(parseThread({ id, createdAt: Number.NaN })?.createdAtSec).toBeNull();
    expect(parseThread({ id, createdAt: Number.POSITIVE_INFINITY })?.createdAtSec).toBeNull();
  });
});

describe('parseThreadStatus', () => {
  test('the three flat statuses and an active one with its flags', () => {
    expect(parseThreadStatus({ type: 'notLoaded' })).toEqual({ type: 'notLoaded' });
    expect(parseThreadStatus({ type: 'idle' })).toEqual({ type: 'idle' });
    expect(parseThreadStatus({ type: 'systemError' })).toEqual({ type: 'systemError' });
    expect(parseThreadStatus({ type: 'active', activeFlags: [] })).toEqual({
      type: 'active',
      activeFlags: [],
    });
    expect(parseThreadStatus({ type: 'active', activeFlags: ['waitingOnApproval'] })).toEqual({
      type: 'active',
      activeFlags: ['waitingOnApproval'],
    });
  });

  test('an unknown flag is kept, because it still means the thread waits on someone', () => {
    expect(
      parseThreadStatus({ type: 'active', activeFlags: ['waitingOnApproval', 'someNewFlag', 5] }),
    ).toEqual({ type: 'active', activeFlags: ['waitingOnApproval', 'someNewFlag'] });
  });

  test('an active status with no usable flag list has no flags', () => {
    expect(parseThreadStatus({ type: 'active' })).toEqual({ type: 'active', activeFlags: [] });
    expect(parseThreadStatus({ type: 'active', activeFlags: 'waitingOnApproval' })).toEqual({
      type: 'active',
      activeFlags: [],
    });
  });

  test('the status of the real spike frames', () => {
    const status = (line: number): unknown =>
      (fixtureFrameAt('expB.jsonl', line).frame['params'] as Json)['status'];
    expect(parseThreadStatus(status(8))).toEqual({ type: 'active', activeFlags: [] });
    expect(parseThreadStatus(status(68))).toEqual({ type: 'idle' });
    expect(parseThreadStatus(status(70))).toEqual({ type: 'notLoaded' });
  });

  test('an unknown type, a missing type and a non-object are null', () => {
    for (const value of [{ type: 'paused' }, { type: 5 }, {}, null, undefined, 'idle', [], 3]) {
      expect(parseThreadStatus(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe('parseTurnCompleted (#1180)', () => {
  const params = (frame: Json): unknown => frame['params'];

  test('reads the real turn/completed of the spike (expA-accept.jsonl:74)', () => {
    expect(parseTurnCompleted(params(turnCompletedFrame(placeholderUuid(1))))).toEqual({
      threadId: placeholderUuid(1),
      turnId: placeholderUuid(2),
      status: 'completed',
      durationMs: 5563,
      finalAnswer: 'done',
      itemsView: 'summary',
      errorMessage: null,
      errorCode: null,
    });
  });

  test('the turn id is its non-empty text; anything else is unknown, so the turn cannot be told from a repeat', () => {
    const idOf = (id: unknown) => {
      const frame = turnCompletedFrame('t') as { params: { turn: Json } };
      frame.params.turn['id'] = id;
      return parseTurnCompleted(frame.params)?.turnId;
    };

    expect(idOf('turn-7')).toBe('turn-7');
    for (const bad of ['', 7, null, undefined, {}]) expect(idOf(bad), String(bad)).toBeNull();
  });

  test('an id of up to 200 characters is kept and a longer one is no id at all: it would fill the set that remembers ids', () => {
    const idOf = (id: string) => {
      const frame = turnCompletedFrame('t') as { params: { turn: Json } };
      frame.params.turn['id'] = id;
      return parseTurnCompleted(frame.params)?.turnId;
    };

    expect(idOf('t'.repeat(200))).toBe('t'.repeat(200));
    expect(idOf('t'.repeat(201))).toBeNull();
    expect(idOf('t'.repeat(1_000_000))).toBeNull();
  });

  test('the items view is one of Codex’s three, and anything else is unknown (it may be logged, so it is never free text)', () => {
    const viewOf = (view: unknown) => {
      const frame = turnCompletedFrame('t') as { params: { turn: Json } };
      frame.params.turn['itemsView'] = view;
      return parseTurnCompleted(frame.params)?.itemsView;
    };

    for (const view of ['notLoaded', 'summary', 'full']) expect(String(viewOf(view))).toBe(view);
    for (const bad of ['everything', '', 7, null, undefined]) {
      expect(viewOf(bad), String(bad)).toBeNull();
    }
  });

  test('reads a failure: the message, and the code only when it is a string', () => {
    const failed = (error: unknown) =>
      parseTurnCompleted(
        params(turnCompletedFrame('t', { status: 'failed', items: [], error: error as never })),
      );

    expect(failed(turnError('out of credit', 'usageLimitExceeded'))).toMatchObject({
      status: 'failed',
      errorMessage: 'out of credit',
      errorCode: 'usageLimitExceeded',
    });
    expect(failed(turnError('x', { httpConnectionFailed: { httpStatusCode: 502 } }))).toMatchObject(
      {
        errorMessage: 'x',
        errorCode: null,
      },
    );
    expect(failed(turnError('   ', ''))).toMatchObject({ errorMessage: null, errorCode: null });
    expect(failed(null)).toMatchObject({ errorMessage: null, errorCode: null });
    expect(failed('boom')).toMatchObject({ errorMessage: null, errorCode: null });
  });

  test('the final answer is the last agent message whose phase is final_answer', () => {
    const answer = (items: Json[]) =>
      parseTurnCompleted(params(turnCompletedFrame('t', { items })))?.finalAnswer;

    expect(
      answer([
        agentMessageItem('a', 'one', 'final_answer'),
        agentMessageItem('b', 'two', 'final_answer'),
        agentMessageItem('c', 'aside', 'commentary'),
      ]),
    ).toBe('two');
    expect(answer([agentMessageItem('a', 'phase unknown', null)])).toBeNull();
    expect(answer([{ type: 'plan', id: 'p', text: 'x', phase: 'final_answer' }])).toBeNull();
    expect(answer([{ type: 'agentMessage', id: 'a', text: 5, phase: 'final_answer' }])).toBeNull();
    expect(answer([])).toBeNull();
  });

  test('a duration is a finite number of at least zero, and anything else is unknown', () => {
    const duration = (durationMs: unknown) =>
      parseTurnCompleted(params(turnCompletedFrame('t', { durationMs: durationMs as never })))
        ?.durationMs;

    expect(duration(0)).toBe(0);
    expect(duration(1234)).toBe(1234);
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY, '5', null, undefined]) {
      expect(duration(bad), String(bad)).toBeNull();
    }
  });

  test('a status that is not text is null', () => {
    for (const status of [7, null, undefined, {}]) {
      expect(
        parseTurnCompleted(params(turnCompletedFrame('t', { status: status as never })))?.status,
      ).toBeNull();
    }
  });

  test('params that are not {threadId, turn} are null', () => {
    const turn = { status: 'completed' };
    for (const bad of [
      undefined,
      null,
      'x',
      7,
      [],
      {},
      { threadId: '', turn },
      { threadId: 5, turn },
      { threadId: 't' },
      { threadId: 't', turn: null },
      { threadId: 't', turn: [] },
      { threadId: 't', turn: 'x' },
    ]) {
      expect(parseTurnCompleted(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('parseThreadItem (#1180)', () => {
  test('reads the three real items of the spike', () => {
    expect(parseThreadItem(realItem('userMessage'))).toEqual({
      type: 'userMessage',
      id: placeholderUuid(3),
      text: 'Run exactly this shell command, nothing else, then say done: touch spike-marker-A1',
    });
    expect(parseThreadItem(realItem('agentMessage'))).toEqual({
      type: 'agentMessage',
      id: 'msg-id-1',
      text: 'done',
    });
    expect(parseThreadItem(realItem('commandExecution'))).toEqual({
      type: 'commandExecution',
      id: 'exec-00000000-0000-7000-8000-000000000004',
      command: "/bin/zsh -c 'touch spike-marker-A1'",
      output: null,
      status: 'completed',
      exitCode: 0,
    });
  });

  test('a user message keeps its text parts only, joined by a newline: the type tag decides, not a text field', () => {
    const item = realItem('userMessage', {
      content: [
        { type: 'text', text: 'one', text_elements: [] },
        { type: 'localImage', path: '/work/a.png', text: 'NOT-TEXT' },
        { type: 'skill', name: 's', path: '/work/s', text: 'NOT-TEXT' },
        { type: 'text', text: 'two', text_elements: [] },
        { type: 'text', text: 3 },
        'x',
        null,
      ],
    });

    expect(parseThreadItem(item)).toMatchObject({ text: 'one\ntwo' });
    expect(parseThreadItem(realItem('userMessage', { content: 'not a list' }))).toMatchObject({
      text: '',
    });
    expect(parseThreadItem(userMessageItem('u', 'plain'))).toMatchObject({ text: 'plain' });
  });

  test('an item with no usable id, or of a kind that is not chat, is null', () => {
    for (const bad of [
      realItem('agentMessage', { id: '' }),
      realItem('agentMessage', { id: 7 }),
      realItem('agentMessage', { id: undefined }),
      realItem('agentMessage', { text: 5 }),
      realItem('commandExecution', { command: 5 }),
      { type: 'reasoning', id: 'r', summary: [], content: [] },
      { type: 'plan', id: 'p', text: 'x' },
      { type: 'fileChange', id: 'f', changes: [], status: 'completed' },
      { type: 'brandNew', id: 'n', text: 'x' },
      { id: 'no-type', text: 'x' },
      null,
      undefined,
      'x',
      [],
    ]) {
      expect(parseThreadItem(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  test('an id of up to 200 characters is kept and an item with a longer one is not chat: the id is copied into every message and remembered', () => {
    expect(parseThreadItem(userMessageItem('i'.repeat(200), 'x'))).toMatchObject({
      id: 'i'.repeat(200),
    });
    expect(parseThreadItem(userMessageItem('i'.repeat(201), 'x'))).toBeNull();
    expect(parseThreadItem(agentMessageItem('i'.repeat(201), 'x', 'final_answer'))).toBeNull();
    expect(parseThreadItem(realItem('commandExecution', { id: 'i'.repeat(201) }))).toBeNull();
  });

  test('a command keeps its status, output and a finite exit code; a code that is not a number is unknown', () => {
    const command = (over: Json) => parseThreadItem(realItem('commandExecution', over));

    expect(command({ status: 'declined', exitCode: null, aggregatedOutput: 'out' })).toMatchObject({
      status: 'declined',
      output: 'out',
      exitCode: null,
    });
    expect(command({ exitCode: 3 })).toMatchObject({ exitCode: 3 });
    for (const exitCode of [Number.NaN, Number.POSITIVE_INFINITY, '1', undefined]) {
      expect(command({ exitCode }), String(exitCode)).toMatchObject({ exitCode: null });
    }
    expect(command({ status: 7, aggregatedOutput: 7 })).toMatchObject({
      status: null,
      output: null,
    });
  });
});
