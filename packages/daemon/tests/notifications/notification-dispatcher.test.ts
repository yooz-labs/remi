import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question, QuestionOption, UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  NotificationDispatcher,
  type PushFn,
  buildPushText,
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

function question(id: string, options: QuestionOption[], text = 'proceed?'): Question {
  return { id: id as UUID, text, options, allowsFreeText: false, isAnswered: false };
}

const yesAlwaysOpt: QuestionOption = {
  value: '2',
  label: 'Yes, always',
  isRecommended: false,
  isYes: true,
  isNo: false,
};
const defaultThreeSet: QuestionOption[] = [
  { value: '1', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
  yesAlwaysOpt,
  { value: '3', label: 'No', isRecommended: false, isYes: false, isNo: true },
];

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

describe('buildPushText (#574 issues 3+4)', () => {
  test('title carries session + clean hook ask; body lists the real option labels', () => {
    const { title, body } = buildPushText(
      'my-project',
      question('q', defaultThreeSet, 'Allow Bash: git push origin main'),
    );
    expect(title).toBe('my-project: Allow Bash: git push origin main');
    // Body leads with the ask, then the real labels (not numeric indices).
    expect(body).toBe('Allow Bash: git push origin main\n1. Yes  2. Yes, always  3. No');
  });

  test('regression: a raw collapsed PTY prompt is NEVER emitted as the body', () => {
    // The PTY screen text collapses to a run-together string after ANSI strip
    // ("Doyouwanttoproceed?"); normalization must keep word separators and the
    // dispatcher must never surface that exact garble. Here the hook text is
    // the clean source; even a garbled question.text must be whitespace-safe.
    const { title, body } = buildPushText(
      'agent',
      question('q', defaultThreeSet, 'Do  you\twant\nto   proceed?'),
    );
    // Collapsed whitespace -> single spaces, never the no-space run-together form.
    expect(body).not.toContain('Doyouwanttoproceed');
    expect(title).not.toContain('Doyouwanttoproceed');
    expect(body.startsWith('Do you want to proceed?')).toBe(true);
  });

  test('free-text prompt (no options): body is just the ask, no trailing list', () => {
    const { body } = buildPushText('agent', question('q', [], 'What should I name it?'));
    expect(body).toBe('What should I name it?');
  });

  test('empty question text falls back to a generic ask, never blank', () => {
    const { title, body } = buildPushText('agent', question('q', defaultThreeSet, '   '));
    expect(title).toBe('agent: Allow this action?');
    expect(body.startsWith('Allow this action?')).toBe(true);
  });

  test('option prefix is the actual VALUE, not the positional index (FIX 3C)', () => {
    // StopFailure-style y/n options carry non-index values; the prefix must
    // reflect the real value ("y. Yes  n. No") so it stays accurate.
    const ynOpts: QuestionOption[] = [
      { value: 'y', label: 'Yes', isRecommended: true, isYes: true, isNo: false },
      { value: 'n', label: 'No', isRecommended: false, isYes: false, isNo: true },
    ];
    const { body } = buildPushText('agent', question('q', ynOpts, 'Retry?'));
    expect(body).toBe('Retry?\ny. Yes  n. No');
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
    // #574: options carry the human-readable LABELS for display, not the
    // numeric values; answer routing resolves a label back to the option.
    expect(pushed[0]?.opts['options']).toEqual(['Yes', 'No']);
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

  test('sends option LABELS for display, not numeric values (#574 issue 4)', () => {
    register(false);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });

    make().maybePush(SID, question('q1', defaultThreeSet, 'Allow Bash: git push'));

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.opts['options']).toEqual(['Yes', 'Yes, always', 'No']);
    expect(pushed[0]?.opts['category']).toBe('REMI_YNA');
  });

  test('body shows the ask + real labels and is never the collapsed PTY garble (#574 issue 3)', () => {
    register(false);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });

    // A garbled PTY-derived text must not surface run-together on the wire.
    make().maybePush(SID, question('q1', defaultThreeSet, 'Do  you\twant to proceed?'));

    expect(pushed).toHaveLength(1);
    const body = pushed[0]?.opts['body'] as string;
    expect(body).not.toContain('Doyouwanttoproceed');
    expect(body).toContain('1. Yes  2. Yes, always  3. No');
  });

  test('falls back to the option value when a label is empty', () => {
    register(false);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });

    const blankLabel: QuestionOption = { ...yesOpt, label: '' };
    make().maybePush(SID, question('q1', [blankLabel, noOpt]));

    expect(pushed[0]?.opts['options']).toEqual(['y', 'No']);
  });
});

describe('NotificationDispatcher.dismiss (#585 P7)', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let pushed: Array<{ token: string; opts: Record<string, unknown> }>;
  const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
  const QID = 'q0000000-0000-0000-0000-000000000000' as UUID;

  const pushFn: PushFn = async (_url, token, opts) => {
    pushed.push({ token, opts: opts as unknown as Record<string, unknown> });
  };

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

  test('fires a dismiss push (dismiss flag + questionId) to every device', () => {
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    // Attach a client: dismiss must STILL fire (unlike maybePush) — the card may
    // be on another device's lock screen.
    registry.attachConnection(SID, 'c0000000-0000-0000-0000-000000000000' as UUID);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });
    deviceTokens.set('b', { token: 'b', platform: 'ios', registeredAt: 2, connectionId: SID });

    make().dismiss(SID, QID);

    expect(pushed.map((p) => p.token).sort()).toEqual(['a', 'b']);
    expect(pushed[0]?.opts['dismiss']).toBe(true);
    expect(pushed[0]?.opts['questionId']).toBe(QID);
  });

  test('no-op when no device tokens are registered', () => {
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    make().dismiss(SID, QID);
    expect(pushed).toHaveLength(0);
  });
});
