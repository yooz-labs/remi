/**
 * Codex turn events (#1180, Phase 6 of the Codex epic #1175): what the app-server's
 * `turn/completed` becomes in the turn-event sink.
 *
 * The first block feeds the real `turn/completed` frames of the spike (`expA-accept.jsonl:74`
 * and `expA-decline.jsonl:141`) to the real `createCodexTurns` and reads what reaches a recording
 * sink: the mapping is exact. The second block puts the real sink and a real
 * `NotificationDispatcher` behind it, so the gates (`on_turn_complete`,
 * `turn_complete_min_seconds`, the per-device preferences) and the notice text ("Codex stopped")
 * are the production ones. The only doubles are the network and the thread roles a test chooses.
 *
 * `lv5.jsonl` adds bounded real completions for a long answer, three interrupted turns and one
 * failed turn. These supplement the synthetic mapper edge cases below; they do not expand the
 * tested model or notification-device matrix.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { createCodexTurns } from '../../../src/harness/codex/codex-turns.ts';
import {
  NotificationDispatcher,
  type PushFn,
} from '../../../src/notifications/notification-dispatcher.ts';
import { DEFAULT_PUSH_PREFERENCES } from '../../../src/notifications/push-preferences.ts';
import { type TurnEventSink, createTurnEventSink } from '../../../src/notifications/turn-events.ts';
import { turnFailedCollapseId } from '../../../src/notifications/turn-failed.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { fixtureFrameAt, loadFixtureFrames } from '../../helpers/codex-fixtures.ts';
import {
  type Json,
  agentMessageItem,
  turnCompletedFrame,
  turnError,
} from '../../helpers/codex-threads.ts';

const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
const MAIN = '00000000-0000-7000-8000-0000000000a1';
const SUB = '00000000-0000-7000-8000-0000000000a2';
const OTHER = '00000000-0000-7000-8000-0000000000a3';

type Role = 'main' | 'subagent' | null;
const ROLES: Record<string, Role> = { [MAIN]: 'main', [SUB]: 'subagent' };

type Recorded =
  | {
      kind: 'completed';
      sessionId: string;
      elapsedMs: number | undefined;
      lastAssistantMessage: string | undefined;
      reentry: boolean;
    }
  // The WHOLE event, so a field nobody should set (an earlier answer on a failure) shows.
  | ({ kind: 'failed' } & Parameters<TurnEventSink['turnFailed']>[0])
  | { kind: 'succeeded'; sessionId: string };

function recordingSink(into: Recorded[]): TurnEventSink {
  return {
    turnCompleted: (e) =>
      into.push({
        kind: 'completed',
        sessionId: e.sessionId,
        elapsedMs: e.elapsedMs,
        lastAssistantMessage: e.lastAssistantMessage,
        reentry: e.reentry,
      }),
    turnFailed: (e) => into.push({ kind: 'failed', ...e }),
    turnSucceeded: (sessionId) => into.push({ kind: 'succeeded', sessionId }),
  };
}

const params = (frame: Json): unknown => frame['params'];

/** A registered device that wants every push class. */
function deviceEntry(token: string): DeviceTokenEntry {
  return {
    token,
    platform: 'ios',
    registeredAt: 1,
    connectionId: 'c0000000-0000-0000-0000-000000000000' as UUID,
    pushPrefs: DEFAULT_PUSH_PREFERENCES,
  };
}

/**
 * The body of the push the REAL sink and dispatcher make for one `turn/completed` of the main
 * thread (a failed turn's `turn_failed`, or with `completed` the `turn_complete` of a turn that
 * passes every gate). Only the network is a double.
 */
async function pushBodyOf(
  turnParams: unknown,
  opts: { completed?: boolean; expectedBodies?: number; mainThread?: string } = {},
): Promise<string> {
  const registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
  registry.registerSession(
    SID,
    '/d',
    { id: 'pty', write: () => {}, submitInput: async () => {}, close: async () => {} } as never,
    { handleMessage: () => {}, handleQuestion: () => {}, handleStatusChange: () => {} } as never,
  );
  configureLogger({ writeLog: () => {} });
  const bodies: Array<string | undefined> = [];
  const deviceTokens = new Map([['a', deviceEntry('a')]]);
  const push: PushFn = (_url, _token, pushOpts) => {
    bodies.push(pushOpts.body);
    return Promise.resolve();
  };
  try {
    const sink = createTurnEventSink({
      config: () => ({ onTurnComplete: true, turnCompleteMinSeconds: 0 }),
      deviceTokens: () => deviceTokens.values(),
      sessionName: (id) => registry.getSession(id)?.name,
      notifiers: new Map([
        [
          SID,
          new NotificationDispatcher(
            {
              sessionRegistry: registry,
              deviceTokens,
              pushConfig: () => ({ signalingUrl: 'https://signal.test' }),
              getPrimarySessionId: () => null,
              pushFn: push,
            },
            SID,
          ),
        ],
      ]),
      signalingUrl: () => 'https://signal.test',
      pushSecret: () => undefined,
      send: (url, token, pushOpts) => push(url, token, pushOpts),
      log: () => {},
      onError: () => {},
    });
    createCodexTurns({
      sessionId: SID,
      sink,
      threadRole: (threadId) => ROLES[threadId] ?? (threadId === opts.mainThread ? 'main' : null),
      log: () => {},
    }).handleNotification('turn/completed', turnParams);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(
      bodies,
      opts.completed === true ? 'a turn_complete push' : 'a turn_failed push',
    ).toHaveLength(opts.expectedBodies ?? 1);
    return bodies[0] ?? '';
  } finally {
    __resetLoggerForTests();
    await registry.shutdown();
  }
}

describe('createCodexTurns: turn/completed to turn events', () => {
  let events: Recorded[];
  let logs: string[];
  let sinkOverride: TurnEventSink | null;

  function make() {
    return createCodexTurns({
      sessionId: SID,
      sink: sinkOverride ?? recordingSink(events),
      threadRole: (threadId) => ROLES[threadId] ?? null,
      log: (m) => logs.push(m),
    });
  }

  beforeEach(() => {
    events = [];
    logs = [];
    sinkOverride = null;
  });

  test('the real LV-5 turns flow through the mapper and production sink', async () => {
    const turns = loadFixtureFrames('lv5.jsonl')
      .filter((entry) => entry.frame['method'] === 'turn/completed')
      .map(
        (entry) =>
          entry.frame['params'] as {
            threadId: string;
            turn: {
              status: string;
              durationMs: number | null;
              error?: Record<string, unknown> | null;
            };
          },
      );
    expect(turns.map((entry) => entry.turn.status)).toEqual([
      'completed',
      'interrupted',
      'interrupted',
      'interrupted',
      'failed',
    ]);

    const long = turns[0];
    if (!long) throw new Error('Expected the captured long turn');
    expect(long.turn.durationMs).toBe(66965);
    expect(await pushBodyOf(long, { completed: true, mainThread: long.threadId })).toContain(
      'LV5 LONG',
    );

    for (const interrupted of turns.filter((entry) => entry.turn.status === 'interrupted')) {
      const body = await pushBodyOf(interrupted, {
        expectedBodies: 0,
        mainThread: interrupted.threadId,
      });
      expect(body).toBe('');
    }

    const failed = turns.find((entry) => entry.turn.status === 'failed');
    if (!failed) throw new Error('Expected the captured failed turn');
    expect(failed.turn.error).toMatchObject({
      codexErrorInfo: 'other',
      additionalDetails: null,
      misalignment: null,
    });
    const mapped: Recorded[] = [];
    createCodexTurns({
      sessionId: SID,
      sink: recordingSink(mapped),
      threadRole: (threadId) => (threadId === failed.threadId ? 'main' : null),
      log: () => {},
    }).handleNotification('turn/completed', failed);
    expect(mapped).toEqual([
      {
        kind: 'failed',
        sessionId: SID,
        error: 'other',
        errorDetails: `${String(failed.turn.error?.['message']).slice(0, 139)}…`,
        agentName: 'Codex',
      },
    ]);
    const failureBody = await pushBodyOf(failed, { mainThread: failed.threadId });
    expect(failureBody).toContain('Unknown error.');
    expect(failureBody).toContain('invalid_request_error');
  });

  describe('completed', () => {
    test('the real frame of the accept run: elapsed is the turn duration, the message is the final answer, then the failure notice is cleared', () => {
      // expA-accept.jsonl:74, re-addressed: durationMs 5563, one final_answer agentMessage "done".
      make().handleNotification('turn/completed', params(turnCompletedFrame(MAIN)));

      expect(events).toEqual([
        {
          kind: 'completed',
          sessionId: SID,
          elapsedMs: 5563,
          lastAssistantMessage: 'done',
          reentry: false,
        },
        { kind: 'succeeded', sessionId: SID },
      ]);
    });

    test('the real frame of the decline run (the answer was `decline`, not the phone’s `cancel`): a completed turn, with its own final answer', () => {
      const real = JSON.parse(JSON.stringify(fixtureFrameAt('expA-decline.jsonl', 141).frame)) as {
        params: { threadId: string; turn: { status: string; durationMs: number } };
      };
      expect(real.params.turn.status).toBe('completed');
      real.params.threadId = MAIN;

      make().handleNotification('turn/completed', real.params);

      expect(events[0]).toEqual({
        kind: 'completed',
        sessionId: SID,
        elapsedMs: 8735,
        lastAssistantMessage:
          'I couldn’t run it: the request to execute `touch spike-marker-A2` was rejected. Done was not completed.',
        reentry: false,
      });
      expect(events[1]).toEqual({ kind: 'succeeded', sessionId: SID });
    });

    test('the message comes from the agentMessage with phase final_answer, not from commentary or from the last message', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            items: [
              agentMessageItem('m1', 'thinking out loud', 'commentary'),
              agentMessageItem('m2', 'the answer', 'final_answer'),
              agentMessageItem('m3', 'a later aside', 'commentary'),
            ],
          }),
        ),
      );

      expect((events[0] as { lastAssistantMessage?: string }).lastAssistantMessage).toBe(
        'the answer',
      );
    });

    test('with several final answers the last one is the turn’s last word', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            items: [
              agentMessageItem('m1', 'first final', 'final_answer'),
              agentMessageItem('m2', 'second final', 'final_answer'),
            ],
          }),
        ),
      );

      expect((events[0] as { lastAssistantMessage?: string }).lastAssistantMessage).toBe(
        'second final',
      );
    });

    test('no final answer means no message (a phase of null is "unknown", never guessed), so the sink stays silent', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            items: [
              agentMessageItem('m1', 'only commentary', 'commentary'),
              agentMessageItem('m2', 'phase unknown', null),
            ],
          }),
        ),
      );
      make().handleNotification('turn/completed', params(turnCompletedFrame(MAIN, { items: [] })));

      expect(events.filter((e) => e.kind === 'completed')).toEqual([
        expect.objectContaining({ lastAssistantMessage: undefined }),
        expect.objectContaining({ lastAssistantMessage: undefined }),
      ]);
    });

    test('items that are not agent messages never supply the message', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            items: [
              { type: 'reasoning', id: 'r1', summary: ['final_answer'], content: [] },
              { type: 'plan', id: 'p1', text: 'a plan', phase: 'final_answer' },
              { type: 'agentMessage', id: 'x', text: 42, phase: 'final_answer' },
            ],
          }),
        ),
      );

      expect((events[0] as { lastAssistantMessage?: string }).lastAssistantMessage).toBeUndefined();
    });

    test('an unknown duration is passed on as unknown, so the sink fails toward silence', () => {
      for (const durationMs of [null, 'long', Number.NaN, -1]) {
        make().handleNotification(
          'turn/completed',
          params(turnCompletedFrame(MAIN, { durationMs: durationMs as never })),
        );
      }

      expect(events.filter((e) => e.kind === 'completed')).toHaveLength(4);
      for (const e of events) {
        if (e.kind === 'completed') expect(e.elapsedMs).toBeUndefined();
      }
    });

    test('a duration of zero is a duration', () => {
      make().handleNotification(
        'turn/completed',
        params(turnCompletedFrame(MAIN, { durationMs: 0 })),
      );

      expect((events[0] as { elapsedMs?: number }).elapsedMs).toBe(0);
    });
  });

  describe('failed', () => {
    test('a failure turns into turnFailed naming Codex: the error message is the details, a string codexErrorInfo is the code', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            status: 'failed',
            items: [],
            error: turnError('You have hit your usage limit.', 'usageLimitExceeded'),
          }),
        ),
      );

      expect(events).toEqual([
        {
          kind: 'failed',
          sessionId: SID,
          error: 'usageLimitExceeded',
          errorDetails: 'You have hit your usage limit.',
          agentName: 'Codex',
        },
      ]);
    });

    test('a failed turn is not a success: no turn_complete, and the failure notice is not cleared', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            status: 'failed',
            error: turnError('boom', 'internalServerError'),
          }),
        ),
      );

      expect(events.map((e) => e.kind)).toEqual(['failed']);
    });

    test('a failed turn does not carry the earlier final answer as its excerpt', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            status: 'failed',
            items: [agentMessageItem('m1', 'an earlier answer', 'final_answer')],
            error: turnError('stream closed', 'other'),
          }),
        ),
      );

      expect(events[0]).toEqual({
        kind: 'failed',
        sessionId: SID,
        error: 'other',
        errorDetails: 'stream closed',
        agentName: 'Codex',
      });
      expect(events[0]).not.toHaveProperty('lastAssistantMessage');
    });

    test('an object-shaped codexErrorInfo is not a code: only a string is', () => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            status: 'failed',
            error: turnError('connection lost', { httpConnectionFailed: { httpStatusCode: 502 } }),
          }),
        ),
      );

      expect(events[0]).toEqual({
        kind: 'failed',
        sessionId: SID,
        errorDetails: 'connection lost',
        agentName: 'Codex',
      });
      expect(events[0]).not.toHaveProperty('error');
    });

    test('a failure with no error, a null message or a blank one still notifies, with nothing to say', () => {
      for (const error of [
        null,
        { message: null, codexErrorInfo: null },
        { message: '   ', codexErrorInfo: '' },
        'not an object',
      ]) {
        make().handleNotification(
          'turn/completed',
          params(turnCompletedFrame(MAIN, { status: 'failed', error: error as never })),
        );
      }

      expect(events).toHaveLength(4);
      for (const e of events) {
        expect(e).toEqual({
          kind: 'failed',
          sessionId: SID,
          error: undefined,
          errorDetails: undefined,
          agentName: 'Codex',
        });
      }
    });
  });

  describe('interrupted and the rest', () => {
    test('an interrupted turn only clears a stale failure notice: nobody is told it was interrupted', () => {
      make().handleNotification(
        'turn/completed',
        params(turnCompletedFrame(MAIN, { status: 'interrupted', items: [] })),
      );

      expect(events).toEqual([{ kind: 'succeeded', sessionId: SID }]);
    });

    test('an interrupted turn that did produce a final answer is still no turn_complete push', () => {
      make().handleNotification(
        'turn/completed',
        params(turnCompletedFrame(MAIN, { status: 'interrupted' })),
      );

      expect(events.map((e) => e.kind)).toEqual(['succeeded']);
    });

    test('a status remi has no meaning for (inProgress, a new one, none) does nothing and is logged without its value', () => {
      for (const status of ['inProgress', 'someNewStatus', undefined, 7]) {
        make().handleNotification(
          'turn/completed',
          params(turnCompletedFrame(MAIN, { status: status as never })),
        );
      }

      expect(events).toEqual([]);
      // One line per frame, so a turn that ended oddly leaves a trace; the status text is the peer's.
      expect(logs).toHaveLength(4);
      expect(logs.join('\n')).not.toContain('someNewStatus');
    });
  });

  describe('which turns count', () => {
    test("a subagent's turn is not the session's turn", () => {
      make().handleNotification('turn/completed', params(turnCompletedFrame(SUB)));
      make().handleNotification(
        'turn/completed',
        params(turnCompletedFrame(SUB, { status: 'failed', error: turnError('x', 'other') })),
      );

      expect(events).toEqual([]);
    });

    test("another window's thread is ignored, and so is a thread nobody knows", () => {
      make().handleNotification('turn/completed', params(turnCompletedFrame(OTHER)));
      make().handleNotification(
        'turn/completed',
        params(turnCompletedFrame(OTHER, { status: 'failed', error: turnError('x', 'other') })),
      );

      expect(events).toEqual([]);
    });

    test('the role is read when the frame arrives: a thread that becomes main counts from then on', () => {
      const roles: Record<string, Role> = {};
      const turns = createCodexTurns({
        sessionId: SID,
        sink: recordingSink(events),
        threadRole: (threadId) => roles[threadId] ?? null,
        log: (m) => logs.push(m),
      });

      turns.handleNotification('turn/completed', params(turnCompletedFrame(MAIN)));
      expect(events).toEqual([]);
      roles[MAIN] = 'main';
      turns.handleNotification('turn/completed', params(turnCompletedFrame(MAIN)));
      expect(events.map((e) => e.kind)).toEqual(['completed', 'succeeded']);
    });

    test('every other method, and every frame that is not a turn, is ignored', () => {
      const turns = make();
      for (const method of [
        'turn/started',
        'item/completed',
        'thread/status/changed',
        'turn/plan/updated',
        'thread/tokenUsage/updated',
      ]) {
        turns.handleNotification(method, params(turnCompletedFrame(MAIN)));
      }
      for (const bad of [
        undefined,
        null,
        'x',
        42,
        [],
        {},
        { threadId: MAIN },
        { threadId: MAIN, turn: null },
        { threadId: MAIN, turn: [] },
        { threadId: 7, turn: { status: 'completed' } },
        { turn: { status: 'completed' } },
      ]) {
        turns.handleNotification('turn/completed', bad);
      }

      expect(events).toEqual([]);
    });
  });

  describe('robustness and privacy', () => {
    test('a turn/completed that does not parse is logged once and says nothing of what it held', () => {
      make().handleNotification('turn/completed', {
        threadId: 'PRIVATE-THREAD',
        turn: 'PRIVATE-TURN',
      });

      expect(logs).toHaveLength(1);
      expect(logs[0]).not.toContain('PRIVATE');
      expect(events).toEqual([]);
    });

    test('a sink that throws never throws out of the handler, and the throw is logged by name only', () => {
      sinkOverride = {
        turnCompleted: () => {
          throw new TypeError('secret detail from the sink');
        },
        turnFailed: () => {
          throw new RangeError('secret detail from the sink');
        },
        turnSucceeded: () => {
          throw new Error('secret detail from the sink');
        },
      };
      const turns = make();

      expect(() =>
        turns.handleNotification('turn/completed', params(turnCompletedFrame(MAIN))),
      ).not.toThrow();
      expect(() =>
        turns.handleNotification(
          'turn/completed',
          params(turnCompletedFrame(MAIN, { status: 'failed', error: turnError('m', 'other') })),
        ),
      ).not.toThrow();
      expect(() =>
        turns.handleNotification(
          'turn/completed',
          params(turnCompletedFrame(MAIN, { status: 'interrupted' })),
        ),
      ).not.toThrow();

      expect(logs.length).toBeGreaterThan(0);
      expect(logs.join('\n')).toContain('TypeError');
      expect(logs.join('\n')).not.toContain('secret detail');
    });

    test('a throw from turnCompleted does not stop turnSucceeded, and the reverse', () => {
      const seen: string[] = [];
      sinkOverride = {
        turnCompleted: () => {
          seen.push('completed');
          throw new Error('x');
        },
        turnFailed: () => {},
        turnSucceeded: () => {
          seen.push('succeeded');
        },
      };
      make().handleNotification('turn/completed', params(turnCompletedFrame(MAIN)));

      expect(seen).toEqual(['completed', 'succeeded']);
    });

    test('nothing a turn says reaches a log line: not the answer, not the error text, not a thread id', () => {
      const turns = make();
      turns.handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            items: [agentMessageItem('m1', 'PRIVATE-ANSWER-TEXT', 'final_answer')],
          }),
        ),
      );
      turns.handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            status: 'failed',
            error: turnError('PRIVATE-ERROR-TEXT', 'other'),
          }),
        ),
      );
      turns.handleNotification(
        'turn/completed',
        params(turnCompletedFrame(MAIN, { status: 'PRIVATE-STATUS-TEXT' })),
      );

      const log = logs.join('\n');
      expect(log).not.toContain('PRIVATE');
      expect(log).not.toContain(MAIN);
    });
  });
});

describe('createCodexTurns: what Codex chose is made safe before it leaves remi (#1180 review)', () => {
  let events: Recorded[];
  let logs: string[];

  function make() {
    return createCodexTurns({
      sessionId: SID,
      sink: recordingSink(events),
      threadRole: (threadId) => ROLES[threadId] ?? null,
      log: (m) => logs.push(m),
    });
  }

  beforeEach(() => {
    events = [];
    logs = [];
  });

  const failedWith = (message: unknown, code: unknown = 'other') =>
    params(
      turnCompletedFrame(MAIN, {
        status: 'failed',
        items: [],
        error: turnError(message as string, code),
      }),
    );
  const detailsOf = (): string | undefined =>
    (events[0] as { errorDetails?: string } | undefined)?.errorDetails;
  const codeOf = (): string | undefined => (events[0] as { error?: string } | undefined)?.error;
  const answerOf = (): string | undefined =>
    (events[0] as { lastAssistantMessage?: string } | undefined)?.lastAssistantMessage;
  const answering = (text: string) =>
    params(turnCompletedFrame(MAIN, { items: [agentMessageItem('m1', text, 'final_answer')] }));

  describe('the failure text', () => {
    test('control, invisible and bidirectional characters are written out as visible text, never dropped', () => {
      make().handleNotification(
        'turn/completed',
        failedWith('bad\u001b[31m red \u0007bell \u202eevil\u2066 \u200b'),
      );

      expect(detailsOf()).toBe('bad\\u001B[31m red \\u0007bell \\u202Eevil\\u2066 \\u200B');
    });

    test('ordinary text, tabs, newlines and non-ASCII letters pass through as they are', () => {
      make().handleNotification(
        'turn/completed',
        failedWith('Zeit überschritten:\t日本語\nline 2 😀'),
      );

      expect(detailsOf()).toBe('Zeit überschritten:\t日本語\nline 2 😀');
    });

    test('a long message is cut to what the push shows, with an ellipsis, after counting what each character becomes', () => {
      make().handleNotification('turn/completed', failedWith('x'.repeat(300)));

      expect(detailsOf()).toBe(`${'x'.repeat(139)}…`);
      expect(detailsOf()).toHaveLength(140);
    });

    test('a cut never lands inside an escape: the character whose escape would not fit is left out whole', () => {
      // 137 letters, then a bidi override (written as 6 characters), then more: 137 + 6 > 139.
      make().handleNotification('turn/completed', failedWith(`${'x'.repeat(137)}\u202etail`));

      expect(detailsOf()).toBe(`${'x'.repeat(137)}…`);
      expect(detailsOf()).not.toMatch(/\\u[0-9A-F]{0,3}…?$/);
    });

    test('a message that fits exactly is not cut, and an escape that fits exactly stays', () => {
      make().handleNotification('turn/completed', failedWith('y'.repeat(140)));
      expect(detailsOf()).toBe('y'.repeat(140));

      events.length = 0;
      make().handleNotification('turn/completed', failedWith(`${'z'.repeat(134)}\u202e`));
      expect(detailsOf()).toBe(`${'z'.repeat(134)}\\u202E`);
    });

    test('a code is escaped and bounded the same way, and a known one still names its reason', () => {
      make().handleNotification('turn/completed', failedWith('m', 'bad\u202ecode'));
      expect(codeOf()).toBe('bad\\u202Ecode');

      events.length = 0;
      make().handleNotification('turn/completed', failedWith('m', 'c'.repeat(100)));
      expect(codeOf()).toBe(`${'c'.repeat(39)}…`);

      events.length = 0;
      make().handleNotification('turn/completed', failedWith('m', 'usageLimitExceeded'));
      expect(codeOf()).toBe('usageLimitExceeded');
    });

    test('the same text reaches the push body whole and visible, whatever the cut', async () => {
      const body = await pushBodyOf(failedWith(`${'x'.repeat(137)}\u202e\u001btail`));

      expect(body).not.toContain('\u202e');
      expect(body).not.toContain('\u001b');
      // "Unknown error. " is the reason; what follows is the details, cut before the first escape.
      expect(body).toBe(`Unknown error. ${'x'.repeat(137)}…`);
      expect(body.length).toBeLessThanOrEqual(200);
    });
  });

  describe('the final answer in a turn_complete push', () => {
    test('control characters and every bidi override and isolate are removed', () => {
      const unsafe = [
        '\u001b',
        '\u0007',
        '\u0000',
        '\u007f',
        '\u0085',
        '\u202a',
        '\u202b',
        '\u202c',
        '\u202d',
        '\u202e',
        '\u2066',
        '\u2067',
        '\u2068',
        '\u2069',
        '\u200e',
        '\u200f',
        '\u200b',
        '\u2060',
        '\ufeff',
        '\u{e0041}',
      ];
      for (const ch of unsafe) {
        events.length = 0;
        make().handleNotification('turn/completed', answering(`before${ch}after`));
        expect(answerOf(), `U+${ch.codePointAt(0)?.toString(16)}`).toBe('beforeafter');
      }
    });

    test('a zero-width joiner survives, so an emoji sequence is whole', () => {
      const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
      make().handleNotification('turn/completed', answering(`${family} shipped it`));

      expect(answerOf()).toBe(`${family} shipped it`);
    });

    test('a joiner between plain letters survives too: only what the shared escape would write out is removed, joiner excepted', () => {
      make().handleNotification('turn/completed', answering('a\u200db\u200c\u200dc'));

      // U+200C (zero-width non-joiner) is in the escaped set and goes; U+200D stays.
      expect(answerOf()).toBe('a\u200db\u200dc');
    });

    test('ordinary text, tabs, newlines, non-ASCII letters and variation selectors pass through unchanged', () => {
      const text = 'Fertig:\t日本語 café\nline 2 ❤️';
      make().handleNotification('turn/completed', answering(text));

      expect(answerOf()).toBe(text);
    });

    test('the push body holds none of it: no control, no bidi override, the emoji sequence whole', async () => {
      const family = '\u{1f468}\u200d\u{1f469}\u200d\u{1f467}';
      const body = await pushBodyOf(answering(`\u001b[2J\u202e${family} all\u0007 done`), {
        completed: true,
      });

      expect(body).toBe(`[2J${family} all done`);
    });
  });
});

describe('createCodexTurns: a turn/completed delivered twice (#1180 review)', () => {
  let events: Recorded[];
  let logs: string[];

  function make() {
    return createCodexTurns({
      sessionId: SID,
      sink: recordingSink(events),
      threadRole: (threadId) => ROLES[threadId] ?? null,
      log: (m) => logs.push(m),
    });
  }

  beforeEach(() => {
    events = [];
    logs = [];
  });

  const turnWithId = (id: string, over: Parameters<typeof turnCompletedFrame>[1] = {}) => {
    const frame = turnCompletedFrame(MAIN, over) as { params: { turn: Json } };
    frame.params.turn['id'] = id;
    return frame['params'];
  };

  test('the same completed turn twice is announced once', () => {
    const turns = make();
    turns.handleNotification('turn/completed', turnWithId('t1'));
    turns.handleNotification('turn/completed', turnWithId('t1'));

    expect(events.map((e) => e.kind)).toEqual(['completed', 'succeeded']);
  });

  test('the same failed turn twice, and the same interrupted turn twice, are announced once', () => {
    const turns = make();
    const failed = turnWithId('t-failed', { status: 'failed', error: turnError('x', 'other') });
    turns.handleNotification('turn/completed', failed);
    turns.handleNotification('turn/completed', failed);
    const interrupted = turnWithId('t-int', { status: 'interrupted', items: [] });
    turns.handleNotification('turn/completed', interrupted);
    turns.handleNotification('turn/completed', interrupted);

    expect(events.map((e) => e.kind)).toEqual(['failed', 'succeeded']);
  });

  test('two different turns are both announced', () => {
    const turns = make();
    turns.handleNotification('turn/completed', turnWithId('t1'));
    turns.handleNotification('turn/completed', turnWithId('t2'));

    expect(events.map((e) => e.kind)).toEqual(['completed', 'succeeded', 'completed', 'succeeded']);
  });

  test('a turn with no id cannot be told from a repeat, so each one is announced', () => {
    const turns = make();
    for (const id of [undefined, '', 7]) {
      const frame = turnCompletedFrame(MAIN) as { params: { turn: Json } };
      frame.params.turn['id'] = id;
      turns.handleNotification('turn/completed', frame['params']);
      turns.handleNotification('turn/completed', frame['params']);
    }

    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(6);
  });

  test('a turn id that is the word null is an id like any other, and a turn with no id is not mistaken for it', () => {
    const turns = make();
    turns.handleNotification('turn/completed', turnWithId('null'));
    const noId = turnCompletedFrame(MAIN) as { params: { turn: Json } };
    noId.params.turn['id'] = undefined;
    turns.handleNotification('turn/completed', noId['params']);

    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(2);
  });

  test('a turn of a thread that is not the session’s is not remembered: the same id counts once the thread is', () => {
    const roles: Record<string, Role> = {};
    const turns = createCodexTurns({
      sessionId: SID,
      sink: recordingSink(events),
      threadRole: (threadId) => roles[threadId] ?? null,
      log: (m) => logs.push(m),
    });

    turns.handleNotification('turn/completed', turnWithId('t1'));
    roles[MAIN] = 'main';
    turns.handleNotification('turn/completed', turnWithId('t1'));

    expect(events.map((e) => e.kind)).toEqual(['completed', 'succeeded']);
  });

  test('a status that does nothing is not remembered: the same turn later completed is announced', () => {
    const turns = make();
    turns.handleNotification('turn/completed', turnWithId('t1', { status: 'inProgress' }));
    turns.handleNotification('turn/completed', turnWithId('t1'));

    expect(events.map((e) => e.kind)).toEqual(['completed', 'succeeded']);
  });

  test('the memory is the last 64 turns: the oldest of them is still remembered, the one pushed out is not', () => {
    const turns = make();
    for (let i = 0; i < 64; i++) turns.handleNotification('turn/completed', turnWithId(`t${i}`));
    expect(events).toHaveLength(128);

    turns.handleNotification('turn/completed', turnWithId('t0')); // the 64th most recent: remembered
    expect(events).toHaveLength(128);

    turns.handleNotification('turn/completed', turnWithId('t64')); // pushes t0 out
    turns.handleNotification('turn/completed', turnWithId('t0')); // forgotten: announced again
    expect(events).toHaveLength(132);
    turns.handleNotification('turn/completed', turnWithId('t64')); // the newest is remembered
    expect(events).toHaveLength(132);
  });

  test('an id of 200 characters is an id, and a longer one is none: that turn is announced each time and never remembered', () => {
    const turns = make();
    const fits = 'i'.repeat(200);
    turns.handleNotification('turn/completed', turnWithId(fits));
    turns.handleNotification('turn/completed', turnWithId(fits));
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(1);

    const tooLong = 'i'.repeat(201);
    turns.handleNotification('turn/completed', turnWithId(tooLong));
    turns.handleNotification('turn/completed', turnWithId(tooLong));
    expect(events.filter((e) => e.kind === 'completed')).toHaveLength(3);
  });
});

describe('createCodexTurns: a completed turn with nothing to show (#1180 review)', () => {
  let events: Recorded[];
  let logs: string[];

  function make() {
    return createCodexTurns({
      sessionId: SID,
      sink: recordingSink(events),
      threadRole: (threadId) => ROLES[threadId] ?? null,
      log: (m) => logs.push(m),
    });
  }

  beforeEach(() => {
    events = [];
    logs = [];
  });

  test('says so once, without content, and names the items view when Codex gave one', () => {
    make().handleNotification(
      'turn/completed',
      params(
        turnCompletedFrame(MAIN, {
          durationMs: 120_000,
          items: [agentMessageItem('m1', 'PRIVATE-COMMENTARY', 'commentary')],
        }),
      ),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no final_answer');
    expect(logs[0]).toContain('summary');
    expect(logs[0]).not.toContain('PRIVATE');
    expect(logs[0]).not.toContain(MAIN);
  });

  test('a phase of null is the same: a model that sends none is not announced, and the log says why', () => {
    make().handleNotification(
      'turn/completed',
      params(turnCompletedFrame(MAIN, { items: [agentMessageItem('m1', 'text', null)] })),
    );

    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain('no final_answer');
  });

  test.each([
    ['only zero-width joiners', '\u200d\u200d\u200d'],
    ['only characters that are removed', '\u202e\u0007\u001b\u200b'],
    ['joiners among removed characters', '\u200d\u202e\u200d'],
    ['only whitespace', ' \n\t '],
  ])(
    'a final answer of %s has nothing to show once made safe: no message, and one line without content says so',
    (_name, answer) => {
      make().handleNotification(
        'turn/completed',
        params(
          turnCompletedFrame(MAIN, {
            durationMs: 120_000,
            items: [agentMessageItem('m1', answer, 'final_answer')],
          }),
        ),
      );

      expect(events.map((e) => e.kind)).toEqual(['completed', 'succeeded']);
      expect((events[0] as { lastAssistantMessage?: string }).lastAssistantMessage).toBeUndefined();
      expect(logs).toHaveLength(1);
      expect(logs[0]).toContain('no visible text');
      expect(logs[0]).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u200b-\u200f\u202a-\u202e]/);
    },
  );

  test('a final answer with one visible character among the invisible ones is still the message', () => {
    make().handleNotification(
      'turn/completed',
      params(
        turnCompletedFrame(MAIN, {
          items: [agentMessageItem('m1', '\u200d\u202eok\u200d', 'final_answer')],
        }),
      ),
    );

    expect((events[0] as { lastAssistantMessage?: string }).lastAssistantMessage).toBe(
      '\u200dok\u200d',
    );
    expect(logs).toEqual([]);
  });

  test('an items view that is not one of Codex’s three is not repeated', () => {
    const frame = turnCompletedFrame(MAIN, { items: [] }) as { params: { turn: Json } };
    frame.params.turn['itemsView'] = 'PRIVATE-VIEW';
    make().handleNotification('turn/completed', frame['params']);

    expect(logs).toHaveLength(1);
    expect(logs[0]).not.toContain('PRIVATE');
    expect(logs[0]).not.toContain('items view');
  });

  test('a turn with a final answer, a failed one and an interrupted one log nothing of the kind', () => {
    const turns = make();
    turns.handleNotification('turn/completed', params(turnCompletedFrame(MAIN)));
    turns.handleNotification(
      'turn/completed',
      params(
        turnCompletedFrame(MAIN, { status: 'failed', items: [], error: turnError('x', 'other') }),
      ),
    );
    turns.handleNotification(
      'turn/completed',
      params(turnCompletedFrame(MAIN, { status: 'interrupted', items: [] })),
    );

    expect(logs).toEqual([]);
  });
});

describe('Codex turns through the real sink and dispatcher', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let notifiers: Map<UUID, NotificationDispatcher>;
  let sent: Array<{ token: string; opts: Record<string, unknown> }>;
  let config: { onTurnComplete: boolean; turnCompleteMinSeconds: number };

  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));
  const pushFn: PushFn = (_url, token, opts) => {
    sent.push({ token, opts: opts as unknown as Record<string, unknown> });
    return Promise.resolve();
  };

  function device(
    token: string,
    prefs: Partial<typeof DEFAULT_PUSH_PREFERENCES> = {},
  ): DeviceTokenEntry {
    return {
      token,
      platform: 'ios',
      registeredAt: 1,
      connectionId: 'c0000000-0000-0000-0000-000000000000' as UUID,
      pushPrefs: { ...DEFAULT_PUSH_PREFERENCES, ...prefs },
    };
  }

  function turns() {
    const sink = createTurnEventSink({
      config: () => config,
      deviceTokens: () => deviceTokens.values(),
      sessionName: (id) => registry.getSession(id)?.name,
      notifiers,
      signalingUrl: () => 'https://signal.test',
      pushSecret: () => undefined,
      send: (_url, token, opts) => {
        sent.push({ token, opts: opts as unknown as Record<string, unknown> });
        return Promise.resolve();
      },
      log: () => {},
      onError: () => {},
    });
    return createCodexTurns({
      sessionId: SID,
      sink,
      threadRole: (threadId) => ROLES[threadId] ?? null,
      log: () => {},
    });
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    registry.registerSession(
      SID,
      '/d',
      { id: 'pty', write: () => {}, submitInput: async () => {}, close: async () => {} } as never,
      { handleMessage: () => {}, handleQuestion: () => {}, handleStatusChange: () => {} } as never,
    );
    deviceTokens = new Map();
    notifiers = new Map([
      [
        SID,
        new NotificationDispatcher(
          {
            sessionRegistry: registry,
            deviceTokens,
            pushConfig: () => ({ signalingUrl: 'https://signal.test' }),
            getPrimarySessionId: () => null,
            pushFn,
          },
          SID,
        ),
      ],
    ]);
    sent = [];
    config = { onTurnComplete: true, turnCompleteMinSeconds: 60 };
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  const longTurn = (over: Parameters<typeof turnCompletedFrame>[1] = {}) =>
    params(turnCompletedFrame(MAIN, { durationMs: 120_000, ...over }));

  test('a long completed turn pushes "turn complete" with the final answer, and nothing else', async () => {
    deviceTokens.set('a', device('a'));
    const name = registry.getSession(SID)?.name ?? '';

    turns().handleNotification('turn/completed', longTurn());
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.opts['kind']).toBe('turn_complete');
    expect(sent[0]?.opts['title']).toBe(`${name}: turn complete`);
    expect(sent[0]?.opts['body']).toBe('done');
  });

  test('the real 5.5-second turn is under the default minimum: no push; at a 5-second minimum it is pushed', async () => {
    deviceTokens.set('a', device('a'));

    turns().handleNotification('turn/completed', params(turnCompletedFrame(MAIN)));
    await flush();
    expect(sent).toEqual([]);

    config = { onTurnComplete: true, turnCompleteMinSeconds: 5 };
    turns().handleNotification('turn/completed', params(turnCompletedFrame(MAIN)));
    await flush();
    expect(sent).toHaveLength(1);
  });

  test('the machine-wide on_turn_complete switch mutes the "done" push but never the failure', async () => {
    deviceTokens.set('a', device('a'));
    config = { onTurnComplete: false, turnCompleteMinSeconds: 0 };

    turns().handleNotification('turn/completed', longTurn());
    await flush();
    expect(sent).toEqual([]);

    turns().handleNotification(
      'turn/completed',
      longTurn({ status: 'failed', items: [], error: turnError('limit', 'usageLimitExceeded') }),
    );
    await flush();
    expect(sent).toHaveLength(1);
    expect(sent[0]?.opts['kind']).toBe('turn_failed');
  });

  test('a failed Codex turn pushes "Codex stopped" with the reason and Codex’s own words, collapsing per session', async () => {
    deviceTokens.set('a', device('a'));
    const name = registry.getSession(SID)?.name ?? '';

    turns().handleNotification(
      'turn/completed',
      longTurn({
        status: 'failed',
        items: [],
        error: turnError('You have hit your usage limit.', 'usageLimitExceeded'),
      }),
    );
    await flush();

    expect(sent).toHaveLength(1);
    expect(sent[0]?.opts['kind']).toBe('turn_failed');
    expect(sent[0]?.opts['title']).toBe(`${name}: Codex stopped`);
    expect(sent[0]?.opts['body']).toBe('Usage limit reached. You have hit your usage limit.');
    expect(sent[0]?.opts['questionId']).toBe(turnFailedCollapseId(SID));
  });

  test('a later completed or interrupted turn clears the failure notice; a failed one does not', async () => {
    deviceTokens.set('a', device('a'));
    const failed = () =>
      longTurn({ status: 'failed', items: [], error: turnError('limit', 'usageLimitExceeded') });
    const dismissals = () => sent.filter((s) => s.opts['kind'] === 'dismiss');

    turns().handleNotification('turn/completed', failed());
    await flush();
    turns().handleNotification('turn/completed', failed());
    await flush();
    expect(dismissals()).toEqual([]);

    turns().handleNotification('turn/completed', longTurn({ status: 'interrupted' }));
    await flush();
    expect(dismissals()).toHaveLength(1);
    expect(dismissals()[0]?.opts['questionId']).toBe(turnFailedCollapseId(SID));

    turns().handleNotification('turn/completed', failed());
    await flush();
    turns().handleNotification('turn/completed', longTurn());
    await flush();
    expect(dismissals()).toHaveLength(2);
  });

  test('an interrupted turn pushes nothing by itself', async () => {
    deviceTokens.set('a', device('a'));

    turns().handleNotification('turn/completed', longTurn({ status: 'interrupted', items: [] }));
    await flush();

    expect(sent).toEqual([]);
  });

  test('a subagent’s long turn pushes nothing', async () => {
    deviceTokens.set('a', device('a'));

    turns().handleNotification(
      'turn/completed',
      params(turnCompletedFrame(SUB, { durationMs: 120_000 })),
    );
    await flush();

    expect(sent).toEqual([]);
  });
});
