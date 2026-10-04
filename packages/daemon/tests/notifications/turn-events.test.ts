/**
 * The turn-event sink (#1180, Phase 6 of the Codex epic #1175): the one place a finished turn
 * becomes a push, for any harness. `cli.ts`'s `onTurnStop` (Claude's `Stop` hook) and the Codex
 * adapter's `turn/completed` both end here.
 *
 * Everything under test is real: the sink, the gates (`shouldNotifyTurnComplete`), the text
 * builders and, for a failed turn, a real `NotificationDispatcher`. The only doubles are the
 * network (a recording `send` / `PushFn`, which replace the HTTP call and nothing else) and the
 * device list a test chooses.
 *
 * The last block reads `cli.ts`: `onTurnStop` is a module-private function over daemon state, so
 * its two commitments (the #914 session filter comes first, and the sink does the pushing) are
 * source-wiring pins, the repo's idiom for `cli.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  NotificationDispatcher,
  type PushFn,
} from '../../src/notifications/notification-dispatcher.ts';
import type { PushTriggerOptions } from '../../src/notifications/push-client.ts';
import { DEFAULT_PUSH_PREFERENCES } from '../../src/notifications/push-preferences.ts';
import {
  type TurnEventSink,
  type TurnEventSinkDeps,
  createTurnEventSink,
} from '../../src/notifications/turn-events.ts';
import { turnFailedCollapseId } from '../../src/notifications/turn-failed.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';
import { stripComments } from '../helpers/strip-comments.ts';

const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
const OTHER_SID = 's1111111-1111-1111-1111-111111111111' as UUID;
const LONG_TURN_MS = 5 * 60_000;

interface Sent {
  url: string;
  token: string;
  opts: PushTriggerOptions;
}

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

describe('createTurnEventSink', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let notifiers: Map<UUID, NotificationDispatcher>;
  /** What the push client was asked to send: completed pushes and the failed-turn path alike. */
  let sent: Sent[];
  let logs: string[];
  let errors: unknown[];
  let config: { onTurnComplete: boolean; turnCompleteMinSeconds: number };
  let names: Map<UUID, string | undefined>;
  let signalingUrl: string;
  let pushSecret: string | undefined;
  let failSends: boolean;

  const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

  const pushFn: PushFn = (url, token, opts) => {
    sent.push({ url: url ?? '', token, opts });
    return Promise.resolve();
  };

  function dispatcherFor(sessionId: UUID): NotificationDispatcher {
    return new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({
          signalingUrl: 'ws://dispatcher.test',
          pushSecret: 'dispatcher-secret',
        }),
        getPrimarySessionId: () => null,
        pushFn,
      },
      sessionId,
    );
  }

  function make(over: Partial<TurnEventSinkDeps> = {}): TurnEventSink {
    return createTurnEventSink({
      config: () => config,
      deviceTokens: () => deviceTokens.values(),
      sessionName: (id) => names.get(id),
      notifiers,
      signalingUrl: () => signalingUrl,
      pushSecret: () => pushSecret,
      send: (url, token, opts) => {
        sent.push({ url, token, opts });
        return failSends ? Promise.reject(new Error('push failed')) : Promise.resolve();
      },
      log: (m) => logs.push(m),
      onError: (err) => errors.push(err),
      ...over,
    });
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    deviceTokens = new Map();
    notifiers = new Map();
    sent = [];
    logs = [];
    errors = [];
    config = { onTurnComplete: true, turnCompleteMinSeconds: 60 };
    names = new Map([[SID, 'my-project']]);
    signalingUrl = 'https://signal.test';
    pushSecret = 'shh';
    failSends = false;
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  const finished = (over: Partial<Parameters<TurnEventSink['turnCompleted']>[0]> = {}) => ({
    sessionId: SID,
    elapsedMs: LONG_TURN_MS,
    lastAssistantMessage: 'All done, the tests pass.',
    reentry: false,
    ...over,
  });

  describe('turnCompleted', () => {
    test('pushes a dismiss-only turn_complete notification, titled with the session, carrying the last message', async () => {
      deviceTokens.set('a', device('a'));
      make().turnCompleted(finished());
      await flush();

      expect(sent).toHaveLength(1);
      expect(sent[0]).toEqual({
        url: 'https://signal.test',
        token: 'a',
        opts: {
          title: 'my-project: turn complete',
          body: 'All done, the tests pass.',
          pushSecret: 'shh',
          kind: 'turn_complete',
        },
      });
      // Dismiss-only: nothing to answer, nothing to collapse on.
      expect(sent[0]?.opts.category).toBeUndefined();
      expect(sent[0]?.opts.questionId).toBeUndefined();
      expect(logs).toEqual(['[TurnComplete] my-project: turn complete']);
    });

    test('the body is one line and bounded, like the title', async () => {
      deviceTokens.set('a', device('a'));
      make().turnCompleted(
        finished({ lastAssistantMessage: `line one\n\nline  two ${'x'.repeat(400)}` }),
      );
      await flush();

      const body = sent[0]?.opts.body ?? '';
      expect(body).not.toContain('\n');
      expect(body.startsWith('line one line two ')).toBe(true);
      expect(body.length).toBeLessThanOrEqual(201);
      expect(body.endsWith('…')).toBe(true);
    });

    test('omits the push secret when there is none', async () => {
      deviceTokens.set('a', device('a'));
      pushSecret = undefined;
      make().turnCompleted(finished());
      await flush();

      expect(sent).toHaveLength(1);
      expect('pushSecret' in (sent[0]?.opts ?? {})).toBe(false);
    });

    test('goes to every device that wants it, and only those', async () => {
      deviceTokens.set('wants-1', device('wants-1'));
      deviceTokens.set('muted', device('muted', { turnComplete: false }));
      deviceTokens.set('wants-2', device('wants-2'));
      make().turnCompleted(finished());
      await flush();

      expect(sent.map((s) => s.token).sort()).toEqual(['wants-1', 'wants-2']);
    });

    test('a turn at exactly the minimum is pushed, one millisecond under is not', async () => {
      deviceTokens.set('a', device('a'));
      config = { onTurnComplete: true, turnCompleteMinSeconds: 60 };
      make().turnCompleted(finished({ elapsedMs: 59_999 }));
      await flush();
      expect(sent).toEqual([]);

      make().turnCompleted(finished({ elapsedMs: 60_000 }));
      await flush();
      expect(sent).toHaveLength(1);
    });

    test('the machine-wide switch off pushes nothing, whatever else holds', async () => {
      deviceTokens.set('a', device('a'));
      config = { onTurnComplete: false, turnCompleteMinSeconds: 0 };
      make().turnCompleted(finished());
      await flush();

      expect(sent).toEqual([]);
    });

    test('a stop-hook re-entry is not the turn finishing: nothing is pushed', async () => {
      deviceTokens.set('a', device('a'));
      make().turnCompleted(finished({ reentry: true }));
      await flush();

      expect(sent).toEqual([]);
    });

    test('an unknown duration fails toward silence', async () => {
      deviceTokens.set('a', device('a'));
      make().turnCompleted(finished({ elapsedMs: undefined }));
      await flush();

      expect(sent).toEqual([]);
    });

    test('no message to show fails toward silence: absent, empty or blank', async () => {
      deviceTokens.set('a', device('a'));
      for (const lastAssistantMessage of [undefined, '', '   \n ']) {
        make().turnCompleted(finished({ lastAssistantMessage }));
      }
      await flush();

      expect(sent).toEqual([]);
    });

    test('no device registered, or every one muted, pushes nothing and builds no text', async () => {
      make().turnCompleted(finished());
      deviceTokens.set('muted', device('muted', { turnComplete: false }));
      make().turnCompleted(finished());
      await flush();

      expect(sent).toEqual([]);
      expect(logs).toEqual([]);
    });

    test('a blank or unknown session name reads as Agent', async () => {
      deviceTokens.set('a', device('a'));
      names.set(SID, '');
      make().turnCompleted(finished());
      make().turnCompleted(finished({ sessionId: OTHER_SID }));
      await flush();

      expect(sent.map((s) => s.opts.title)).toEqual([
        'Agent: turn complete',
        'Agent: turn complete',
      ]);
    });

    test('the config, the URL, the secret and the devices are read when the turn ends, not when the sink is built', async () => {
      const sink = make();
      // Nothing registered, switched off: silence.
      config = { onTurnComplete: false, turnCompleteMinSeconds: 60 };
      sink.turnCompleted(finished());
      await flush();
      expect(sent).toEqual([]);

      // Everything changes after the sink exists.
      config = { onTurnComplete: true, turnCompleteMinSeconds: 1 };
      deviceTokens.set('late', device('late'));
      signalingUrl = 'https://moved.test';
      pushSecret = 'rotated';
      sink.turnCompleted(finished({ elapsedMs: 1_000 }));
      await flush();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.url).toBe('https://moved.test');
      expect(sent[0]?.opts.pushSecret).toBe('rotated');
      expect(sent[0]?.token).toBe('late');
    });

    test('a push that fails is reported to onError and never thrown, and the other devices still get theirs', async () => {
      deviceTokens.set('a', device('a'));
      deviceTokens.set('b', device('b'));
      failSends = true;

      expect(() => make().turnCompleted(finished())).not.toThrow();
      await flush();

      expect(sent.map((s) => s.token).sort()).toEqual(['a', 'b']);
      expect(errors).toHaveLength(2);
    });
  });

  describe('turnFailed and turnSucceeded', () => {
    /**
     * A session with a dispatcher. A daemon hosts one session, so the registry takes one; a second
     * id gets a dispatcher of its own and no registry entry (its notice is titled "Agent").
     */
    function register(sessionId: UUID): void {
      if (registry.getSession(sessionId) === undefined && registry.getSession(SID) === undefined) {
        registry.registerSession(
          sessionId,
          '/d',
          {
            id: 'pty',
            write: () => {},
            submitInput: async () => {},
            close: async () => {},
          } as never,
          {
            handleMessage: () => {},
            handleQuestion: () => {},
            handleStatusChange: () => {},
          } as never,
        );
      }
      notifiers.set(sessionId, dispatcherFor(sessionId));
    }

    const failedTurn = (over: Partial<Parameters<TurnEventSink['turnFailed']>[0]> = {}) => ({
      sessionId: SID,
      error: 'usageLimitExceeded',
      errorDetails: 'You have hit your usage limit.',
      agentName: 'Codex',
      ...over,
    });

    test("pushes the session's turn_failed notice, naming the agent that stopped", async () => {
      register(SID);
      deviceTokens.set('a', device('a'));
      const name = registry.getSession(SID)?.name ?? '';
      expect(name).not.toBe('');

      make().turnFailed(failedTurn());
      await flush();

      expect(sent).toHaveLength(1);
      const { opts } = sent[0] as Sent;
      expect(opts.kind).toBe('turn_failed');
      expect(opts.title).toBe(`${name}: Codex stopped`);
      // An unknown code is shown as is, then Codex's own words.
      expect(opts.body).toBe('usageLimitExceeded. You have hit your usage limit.');
      expect(opts.questionId).toBe(turnFailedCollapseId(SID));
      expect(opts.sessionId).toBe(SID);
      expect(opts.category).toBeUndefined();
    });

    test('Claude is named when the agent is Claude', async () => {
      register(SID);
      deviceTokens.set('a', device('a'));
      make().turnFailed(failedTurn({ agentName: 'Claude', error: 'rate_limit' }));
      await flush();

      expect(sent[0]?.opts.title?.endsWith(': Claude stopped')).toBe(true);
      expect(sent[0]?.opts.body?.startsWith('Rate or usage limit reached')).toBe(true);
    });

    test('a failure carries no config gate: the machine-wide turn_complete switch off does not mute it', async () => {
      register(SID);
      deviceTokens.set('a', device('a'));
      config = { onTurnComplete: false, turnCompleteMinSeconds: 9999 };

      make().turnFailed(failedTurn());
      await flush();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.opts.kind).toBe('turn_failed');
    });

    test('only the per-device turnFailed preference mutes it', async () => {
      register(SID);
      deviceTokens.set('wants', device('wants', { turnComplete: false }));
      deviceTokens.set('muted', device('muted', { turnFailed: false }));

      make().turnFailed(failedTurn());
      await flush();

      expect(sent.map((s) => s.token)).toEqual(['wants']);
    });

    test('a failure with nothing but the agent name reads as Unknown error', async () => {
      register(SID);
      deviceTokens.set('a', device('a'));
      make().turnFailed({ sessionId: SID, agentName: 'Codex' });
      await flush();

      expect(sent[0]?.opts.body).toBe('Unknown error');
    });

    test('goes to the failing session only, and a session with no dispatcher is a no-op', async () => {
      register(SID);
      register(OTHER_SID);
      deviceTokens.set('a', device('a'));

      make().turnFailed(failedTurn({ sessionId: OTHER_SID }));
      expect(() => make().turnFailed(failedTurn({ sessionId: 'gone' as UUID }))).not.toThrow();
      await flush();

      expect(sent).toHaveLength(1);
      expect(sent[0]?.opts.questionId).toBe(turnFailedCollapseId(OTHER_SID));
    });

    test('turnSucceeded clears an outstanding failure notice on its collapse key, and sends nothing when none is outstanding', async () => {
      register(SID);
      deviceTokens.set('a', device('a'));
      const sink = make();

      sink.turnSucceeded(SID);
      await flush();
      expect(sent).toEqual([]);

      sink.turnFailed(failedTurn());
      await flush();
      sink.turnSucceeded(SID);
      sink.turnSucceeded(SID);
      await flush();

      const dismissals = sent.filter((s) => s.opts.kind === 'dismiss');
      expect(dismissals).toHaveLength(1);
      expect(dismissals[0]?.opts.questionId).toBe(turnFailedCollapseId(SID));
      expect(dismissals[0]?.opts.dismiss).toBe(true);
    });

    test("turnSucceeded for another session leaves this session's notice alone", async () => {
      register(SID);
      register(OTHER_SID);
      deviceTokens.set('a', device('a'));
      const sink = make();

      sink.turnFailed(failedTurn());
      await flush();
      sink.turnSucceeded(OTHER_SID);
      await flush();

      expect(sent.filter((s) => s.opts.kind === 'dismiss')).toEqual([]);
    });
  });
});

describe('cli.ts wires the sink (source pins)', () => {
  const CLI = stripComments(
    fs.readFileSync(path.join(import.meta.dir, '..', '..', 'src', 'cli.ts'), 'utf8'),
  );

  /** The text of the top-level function `name`, to its closing brace. */
  function functionBody(name: string): string {
    const start = CLI.indexOf(`function ${name}(`);
    expect(start, `cli.ts has function ${name}`).toBeGreaterThanOrEqual(0);
    const end = CLI.indexOf('\n}\n', start);
    return CLI.slice(start, end);
  }

  test('onTurnStop applies the #914 session filter first, then hands the turn to the sink', () => {
    const body = functionBody('onTurnStop');
    const admitted = body.indexOf('claudeHarness.admitsAnySession(input)');
    const handed = body.indexOf('turnEvents.turnCompleted(');
    expect(admitted).toBeGreaterThanOrEqual(0);
    expect(handed).toBeGreaterThan(admitted);
    // The filter is an early return, not a condition around something else.
    expect(body.slice(admitted - 5, admitted)).toBe('if (!');
    expect(body).toContain('if (!claudeHarness.admitsAnySession(input)) return;');
  });

  test('onTurnStop keeps the timer: it reads the elapsed time and clears the mark except on a re-entry', () => {
    const body = functionBody('onTurnStop');
    expect(body).toContain('turnTimer.elapsedMs(input.prompt_id)');
    expect(body).toContain('if (!input.stop_hook_active)');
    expect(body).toContain('turnTimer.clear(input.prompt_id)');
    expect(body).toContain('elapsedMs');
    expect(body).toContain('reentry: input.stop_hook_active');
    expect(body).toContain('lastAssistantMessage: input.last_assistant_message');
  });

  test('onTurnStop no longer pushes by itself: the sink owns the gate, the text and the fan-out', () => {
    const body = functionBody('onTurnStop');
    expect(body).not.toContain('sendPushTrigger');
    expect(body).not.toContain('shouldNotifyTurnComplete');
    expect(body).not.toContain('buildTurnCompleteText');
  });

  test("the Codex harness is built with the daemon's sink, and Claude's StopFailure routes are untouched", () => {
    const codex = CLI.slice(CLI.indexOf('new CodexHarness({'));
    expect(codex.slice(0, codex.indexOf('})'))).toContain('turnEvents,');
    // Claude's StopFailure wiring stays exactly as it was (#1153).
    expect(CLI).toContain('pushTurnFailed: turnFailedRoutes.push,');
    expect(CLI).toContain('dismissTurnFailed: turnFailedRoutes.dismiss,');
    expect(CLI).toContain('createTurnFailedRoutes(sessionNotifiers)');
  });

  test('the sink reads the same config, devices and endpoint the inline code did', () => {
    const start = CLI.indexOf('createTurnEventSink({');
    expect(start).toBeGreaterThanOrEqual(0);
    const call = CLI.slice(start, CLI.indexOf('\n});', start));
    expect(call).toContain('remiConfig.notifications.on_turn_complete');
    expect(call).toContain('remiConfig.notifications.turn_complete_min_seconds');
    expect(call).toContain('deviceTokens.values()');
    expect(call).toContain('notifiers: sessionNotifiers');
    expect(call).toContain('cliSignalingUrl ?? remiConfig.network.signaling_url');
    expect(call).toContain('send: sendPushTrigger');
  });
});
