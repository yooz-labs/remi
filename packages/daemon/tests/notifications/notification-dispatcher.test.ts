import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question, QuestionOption, UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  NotificationDispatcher,
  type PushFn,
  selectPushCategory,
} from '../../src/notifications/notification-dispatcher.ts';
import type { PTYSession } from '../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../src/session/session-registry.ts';

const yesOpt: QuestionOption = {
  value: 'y',
  label: 'Yes',
  isRecommended: true,
  isYes: true,
  isNo: false,
};
const noOpt: QuestionOption = {
  value: 'n',
  label: 'No',
  isRecommended: false,
  isYes: false,
  isNo: true,
};

function question(id: string, options: QuestionOption[]): Question {
  return { id: id as UUID, text: 'proceed?', options, allowsFreeText: false, isAnswered: false };
}

function fakePTY(): PTYSession {
  return {
    id: 'pty' as unknown as PTYSession['id'],
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

describe('selectPushCategory', () => {
  test('maps option count to the iOS category', () => {
    expect(selectPushCategory([yesOpt, noOpt])).toBe('REMI_YN');
    expect(selectPushCategory([yesOpt, noOpt, yesOpt])).toBe('REMI_YNA');
    expect(selectPushCategory([yesOpt, noOpt, yesOpt, noOpt])).toBe('REMI_MULTI');
    expect(selectPushCategory([yesOpt])).toBeUndefined();
    expect(selectPushCategory([])).toBeUndefined();
  });
});

describe('NotificationDispatcher.maybePush', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let pushed: Array<{ url: string | undefined; token: string; opts: Record<string, unknown> }>;
  const SID = 's0000000-0000-0000-0000-000000000000' as UUID;

  const pushFn: PushFn = async (url, token, opts) => {
    pushed.push({ url, token, opts: opts as unknown as Record<string, unknown> });
  };

  function register(active: boolean): void {
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    if (active) registry.attachConnection(SID, 'c0000000-0000-0000-0000-000000000000' as UUID);
  }

  function make(): NotificationDispatcher {
    return new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x' }),
        getPrimarySessionId: () => null,
        pushFn,
      },
      SID,
    );
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    deviceTokens = new Map();
    pushed = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('pushes to every registered device when no client is attached', () => {
    register(false);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });
    deviceTokens.set('b', { token: 'b', platform: 'ios', registeredAt: 2, connectionId: SID });

    make().maybePush(SID, question('q1', [yesOpt, noOpt]));

    expect(pushed.map((p) => p.token).sort()).toEqual(['a', 'b']);
    // The dispatcher forwards the raw signaling URL; sendPushTrigger does the
    // wss->https normalization downstream.
    expect(pushed[0]?.url).toBe('ws://x');
    expect(pushed[0]?.opts['category']).toBe('REMI_YN');
    expect(pushed[0]?.opts['options']).toEqual(['y', 'n']);
  });

  test('does NOT push when a client is attached (it sees the question in-app)', () => {
    register(true);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });

    make().maybePush(SID, question('q1', [yesOpt, noOpt]));

    expect(pushed).toHaveLength(0);
  });

  test('does NOT push when no devices are registered', () => {
    register(false);
    make().maybePush(SID, question('q1', [yesOpt, noOpt]));
    expect(pushed).toHaveLength(0);
  });

  test('dedup: a second identical prompt is suppressed; resetDedup re-allows', () => {
    register(false);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });
    const d = make();

    d.maybePush(SID, question('q1', [yesOpt, noOpt]));
    d.maybePush(SID, question('q2', [yesOpt, noOpt])); // same shape -> suppressed
    expect(pushed).toHaveLength(1);

    d.resetDedup(); // prompt cycle ended (status left 'waiting')
    d.maybePush(SID, question('q3', [yesOpt, noOpt]));
    expect(pushed).toHaveLength(2);
  });
});
