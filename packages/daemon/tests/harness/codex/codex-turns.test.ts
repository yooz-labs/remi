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
 * What no real frame shows, and live step LV-5 checks: a FAILED and an INTERRUPTED
 * `turn/completed`. The decline run answered `decline` (`expA-decline.jsonl:65`), not the
 * `cancel` the phone's No sends, and its `turn/completed` says `completed`; no recorded frame
 * shows the status of a turn that `cancel`, Esc or `turn/interrupt` ended. Those two are the
 * real frame with `status` and `error` set to the shapes of the generated schema
 * (`helpers/codex-threads.ts`).
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
import { fixtureFrameAt } from '../../helpers/codex-fixtures.ts';
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
  | {
      kind: 'failed';
      sessionId: string;
      error: string | undefined;
      errorDetails: string | undefined;
      lastAssistantMessage: string | undefined;
      agentName: string;
    }
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
    turnFailed: (e) =>
      into.push({
        kind: 'failed',
        sessionId: e.sessionId,
        error: e.error,
        errorDetails: e.errorDetails,
        lastAssistantMessage: e.lastAssistantMessage,
        agentName: e.agentName,
      }),
    turnSucceeded: (sessionId) => into.push({ kind: 'succeeded', sessionId }),
  };
}

const params = (frame: Json): unknown => frame['params'];

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
          lastAssistantMessage: undefined,
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

      expect((events[0] as { lastAssistantMessage?: string }).lastAssistantMessage).toBeUndefined();
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

      expect(events[0]).toEqual(
        expect.objectContaining({ error: undefined, errorDetails: 'connection lost' }),
      );
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
          lastAssistantMessage: undefined,
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

  test('a failed Codex turn pushes "Codex stopped" with the code and Codex’s own words, collapsing per session', async () => {
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
    expect(sent[0]?.opts['body']).toBe('usageLimitExceeded. You have hit your usage limit.');
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
