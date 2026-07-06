import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Question, QuestionOption, UUID } from '@remi/shared';
import type { DeviceTokenEntry } from '../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../src/cli/logger.ts';
import {
  NotificationDispatcher,
  type PushFn,
  buildPushText,
  isDelivered,
  isRetriablePushError,
  isTokenInvalidError,
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

  test('#718: the honest 2-option Yes/No fallback selects REMI_YN, not REMI_YNA', () => {
    // Category correctness falls out of the count-based mapping once the
    // daemon's fallback is a genuine 2-set instead of a fabricated 3-set —
    // no dispatcher change was needed, this just pins the observable result.
    expect(selectPushCategory([yesOpt, noOpt])).toBe('REMI_YN');
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

  // #628: prefer the auto-approve LLM's lock-screen summary over raw tool text.
  test('prefers the summary over the raw tool text when present', () => {
    const q: Question = {
      id: 'q' as UUID,
      text: 'Allow Bash: git push --force origin main',
      options: defaultThreeSet,
      allowsFreeText: false,
      isAnswered: false,
      summary: 'Force-push to main?',
    };
    const { title, body } = buildPushText('proj', q);
    expect(title).toBe('proj: Force-push to main?');
    expect(body.startsWith('Force-push to main?')).toBe(true);
    expect(body).toContain('1. Yes  2. Yes, always  3. No');
  });

  // #626: a multi-question AskUserQuestion summarizes its SCOPE on the lock screen.
  test('multi-question summarizes the topics instead of one option list', () => {
    const q: Question = {
      id: 'q' as UUID,
      text: 'Collab PI: Who is the PI?',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
      kind: 'multi_question',
      questions: [
        { header: 'Collab PI', text: 'Who is the PI?', multiSelect: false, options: [] },
        { header: 'Software focus', text: 'Which tools?', multiSelect: true, options: [] },
        { header: 'Scaffold', text: 'Scaffold now?', multiSelect: false, options: [] },
      ],
    };
    const { title, body } = buildPushText('proj', q);
    expect(title).toBe('proj: 3 questions');
    expect(body).toBe('1. Collab PI\n2. Software focus\n3. Scaffold');
  });

  test('single-question AskUserQuestion still uses the normal option-list body', () => {
    const q: Question = {
      id: 'q' as UUID,
      text: 'DB: Which database?',
      options: [
        { value: '1', label: 'Postgres', isRecommended: true, isYes: false, isNo: false },
        { value: '2', label: 'SQLite', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: false,
      isAnswered: false,
      kind: 'multi_question',
      questions: [
        {
          header: 'DB',
          text: 'Which database?',
          multiSelect: false,
          options: [
            { value: '1', label: 'Postgres', isRecommended: true, isYes: false, isNo: false },
            { value: '2', label: 'SQLite', isRecommended: false, isYes: false, isNo: false },
          ],
        },
      ],
    };
    const { title, body } = buildPushText('proj', q);
    expect(title).toBe('proj: DB: Which database?');
    expect(body).toBe('DB: Which database?\n1. Postgres  2. SQLite');
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

  // #626: an AskUserQuestion must NOT get a count-based category (REMI_YN/YNA
  // would mislabel arbitrary picks as Yes/No); the lock screen opens the app.
  test('multi-question (AskUserQuestion) pushes with NO category', () => {
    register(false);
    deviceTokens.set('a', { token: 'a', platform: 'ios', registeredAt: 1, connectionId: SID });

    const mq: Question = {
      id: 'q1' as UUID,
      text: 'Collab PI: Who is the PI?',
      // Three options would normally select REMI_YNA — proving the kind guard wins.
      options: [
        { value: '1', label: 'Scott', isRecommended: true, isYes: false, isNo: false },
        { value: '2', label: 'Arnaud', isRecommended: false, isYes: false, isNo: false },
        { value: '3', label: 'Other', isRecommended: false, isYes: false, isNo: false },
      ],
      allowsFreeText: false,
      isAnswered: false,
      kind: 'multi_question',
      questions: [
        {
          header: 'Collab PI',
          text: 'Who is the PI?',
          multiSelect: false,
          options: [],
        },
        { header: 'Software focus', text: 'Which tools?', multiSelect: true, options: [] },
      ],
    };
    make().maybePush(SID, mq);

    expect(pushed).toHaveLength(1);
    expect(pushed[0]?.opts['category']).toBeUndefined();
    expect(pushed[0]?.opts['title']).toContain('2 questions');
    expect(pushed[0]?.opts['body']).toBe('1. Collab PI\n2. Software focus');
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

describe('NotificationDispatcher delivery outcome (#603 Phase 1)', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  const SID = 's0000000-0000-0000-0000-000000000000' as UUID;

  function register(active: boolean): void {
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    if (active) registry.attachConnection(SID, 'c0000000-0000-0000-0000-000000000000' as UUID);
  }

  function make(pushFn: PushFn): NotificationDispatcher {
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

  const okPush: PushFn = async () => {};
  const addToken = (t: string): void => {
    deviceTokens.set(t, { token: t, platform: 'ios', registeredAt: 1, connectionId: SID });
  };

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    deviceTokens = new Map();
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('in_app when a client is attached (no push, but the user is reachable)', async () => {
    register(true);
    addToken('a');
    expect(await make(okPush).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('in_app');
  });

  test('no_channel when there is no client and no device token', async () => {
    register(false);
    expect(await make(okPush).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('no_channel');
  });

  test('pushed when a device accepts; awaitDelivery returns the same outcome', async () => {
    register(false);
    addToken('a');
    const d = make(okPush);
    const q = question('q1', [yesOpt, noOpt]);
    expect(await d.maybePush(SID, q)).toBe('pushed');
    expect(await d.awaitDelivery(q.id)).toBe('pushed');
  });

  test('deduped when a second identical prompt is suppressed', async () => {
    register(false);
    addToken('a');
    const d = make(okPush);
    expect(await d.maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('pushed');
    expect(await d.maybePush(SID, question('q2', [yesOpt, noOpt]))).toBe('deduped');
  });

  test('failed when the only device push fails', async () => {
    register(false);
    addToken('a');
    const failPush: PushFn = async () => {
      throw new Error('Push trigger failed: 502 {"error":"APNS 400: BadDeviceToken"}');
    };
    expect(await make(failPush).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('failed');
  });

  test('a permanent BadDeviceToken (502) is NOT retried', async () => {
    register(false);
    addToken('a');
    let calls = 0;
    const failPush: PushFn = async () => {
      calls++;
      throw new Error('Push trigger failed: 502 {"error":"APNS 400: BadDeviceToken"}');
    };
    expect(await make(failPush).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('failed');
    expect(calls).toBe(1);
  });

  test('a transient 429 is retried with backoff, then succeeds -> pushed', async () => {
    register(false);
    addToken('a');
    let calls = 0;
    const flakyPush: PushFn = async () => {
      calls++;
      if (calls === 1) throw new Error('Push trigger failed: 429 rate limited');
    };
    expect(await make(flakyPush).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('pushed');
    expect(calls).toBe(2);
  });

  test('a retriable error exhausts MAX_PUSH_RETRIES (3 attempts) then -> failed', async () => {
    register(false);
    addToken('a');
    let calls = 0;
    const always429: PushFn = async () => {
      calls++;
      throw new Error('Push trigger failed: 429 rate limited');
    };
    expect(await make(always429).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('failed');
    expect(calls).toBe(3); // 1 initial + MAX_PUSH_RETRIES (2)
  });

  test('multi-token: one dead token + one live token still resolves pushed (the 2-token case)', async () => {
    register(false);
    addToken('dead');
    addToken('live');
    const mixedPush: PushFn = async (_url, token) => {
      if (token === 'dead') {
        throw new Error('Push trigger failed: 502 {"error":"APNS 400: BadDeviceToken"}');
      }
    };
    expect(await make(mixedPush).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('pushed');
  });

  test('multi-token: every token failing resolves failed', async () => {
    register(false);
    addToken('a');
    addToken('b');
    const allFail: PushFn = async () => {
      throw new Error('Push trigger failed: 502 {"error":"APNS 400: BadDeviceToken"}');
    };
    expect(await make(allFail).maybePush(SID, question('q1', [yesOpt, noOpt]))).toBe('failed');
  });

  test('awaitDelivery is undefined for an unknown question id', () => {
    expect(
      make(okPush).awaitDelivery('zzzzzzzz-0000-0000-0000-000000000000' as UUID),
    ).toBeUndefined();
  });
});

describe('NotificationDispatcher held escalation (#603 Phase 3)', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let pushed: string[];
  const SID = 's0000000-0000-0000-0000-000000000000' as UUID;

  function register(active: boolean): void {
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    if (active) registry.attachConnection(SID, 'c0000000-0000-0000-0000-000000000000' as UUID);
  }

  const capturePush: PushFn = async (_url, token) => {
    pushed.push(token);
  };
  function make(): NotificationDispatcher {
    return new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x' }),
        getPrimarySessionId: () => null,
        pushFn: capturePush,
      },
      SID,
    );
  }
  const addToken = (t: string): void => {
    deviceTokens.set(t, { token: t, platform: 'ios', registeredAt: 1, connectionId: SID });
  };

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

  test('a held escalation pushes to the lock screen EVEN when a client is attached', async () => {
    register(true); // client attached
    addToken('a');
    const outcome = await make().maybePush(SID, question('q1', [yesOpt, noOpt]), { held: true });
    // Pushed despite the attached client (it may be backgrounded), and the
    // outcome gates on the PUSH result, not the socket -> 'pushed'.
    expect(pushed).toEqual(['a']);
    expect(outcome).toBe('pushed');
  });

  test('a held escalation with an attached client whose push FAILS reports failed (no false in_app)', async () => {
    register(true); // client attached, but...
    addToken('a');
    const failPush: PushFn = async () => {
      throw new Error('Push trigger failed: 502 {"error":"APNS 400: BadDeviceToken"}');
    };
    const d = new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x' }),
        getPrimarySessionId: () => null,
        pushFn: failPush,
      },
      SID,
    );
    // The attached client may be backgrounded, so a dead token must NOT mask as
    // in_app — it reports failed so the held hook fails open fast (#603 Phase 3).
    expect(await d.maybePush(SID, question('q1', [yesOpt, noOpt]), { held: true })).toBe('failed');
  });

  test('a non-held push with a client attached still does NOT push (unchanged)', async () => {
    register(true);
    addToken('a');
    const outcome = await make().maybePush(SID, question('q1', [yesOpt, noOpt]));
    expect(pushed).toEqual([]);
    expect(outcome).toBe('in_app');
  });

  test('a held escalation bypasses dedup: a second identical held push still fires', async () => {
    register(false);
    addToken('a');
    const d = make();
    await d.maybePush(SID, question('q1', [yesOpt, noOpt]), { held: true });
    await d.maybePush(SID, question('q2', [yesOpt, noOpt]), { held: true }); // same shape
    expect(pushed).toEqual(['a', 'a']); // both fired — not deduped
  });

  test('a held escalation with no client and no token is no_channel (no false confirm)', async () => {
    register(false);
    const outcome = await make().maybePush(SID, question('q1', [yesOpt, noOpt]), { held: true });
    expect(pushed).toEqual([]);
    expect(outcome).toBe('no_channel');
  });
});

describe('isRetriablePushError / isDelivered (#603 Phase 1)', () => {
  test('permanent APNS token rejections are NOT retriable (even wrapped as 502)', () => {
    expect(
      isRetriablePushError(
        new Error('Push trigger failed: 502 {"error":"APNS 400: BadDeviceToken"}'),
      ),
    ).toBe(false);
    expect(
      isRetriablePushError(new Error('Push trigger failed: 410 {"reason":"Unregistered"}')),
    ).toBe(false);
    expect(isRetriablePushError(new Error('Push trigger failed: 400 DeviceTokenNotForTopic'))).toBe(
      false,
    );
  });

  test('a transient 429 / 5xx is retriable', () => {
    expect(isRetriablePushError(new Error('Push trigger failed: 429 rate limited'))).toBe(true);
    expect(isRetriablePushError(new Error('Push trigger failed: 503 unavailable'))).toBe(true);
    expect(isRetriablePushError(new Error('Push trigger failed: 500 internal'))).toBe(true);
  });

  test('network-level errors (no HTTP response) are retriable', () => {
    expect(isRetriablePushError(new TypeError('Failed to fetch'))).toBe(true);
    expect(isRetriablePushError(new Error('connect ECONNREFUSED 127.0.0.1:8787'))).toBe(true);
    expect(isRetriablePushError(new Error('getaddrinfo ENOTFOUND remi-signaling'))).toBe(true);
  });

  test('a permanent reason wins even if the message also carries a 5xx status', () => {
    // The Worker wraps a BadDeviceToken as 502; the permanent reason must take
    // precedence over the retriable 5xx status.
    expect(isRetriablePushError(new Error('Push trigger failed: 502 BadDeviceToken'))).toBe(false);
  });

  test('a 4xx (non-token) is not retriable', () => {
    expect(isRetriablePushError(new Error('Push trigger failed: 401 unauthorized'))).toBe(false);
    expect(isRetriablePushError(new Error('Push trigger failed: 400 bad request'))).toBe(false);
  });

  test('isDelivered: in_app/pushed reach the user; deduped/no_channel/failed do not', () => {
    expect(isDelivered('in_app')).toBe(true);
    expect(isDelivered('pushed')).toBe(true);
    // deduped is NOT treated as confirmed (the deduped-against push may have failed).
    expect(isDelivered('deduped')).toBe(false);
    expect(isDelivered('no_channel')).toBe(false);
    expect(isDelivered('failed')).toBe(false);
  });
});

describe('NotificationDispatcher token pruning (#603 Phase 6)', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let pruned: string[];
  const SID = 's0000000-0000-0000-0000-000000000000' as UUID;

  function register(): void {
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
  }
  function make(pushFn: PushFn): NotificationDispatcher {
    return new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x' }),
        getPrimarySessionId: () => null,
        pushFn,
        pruneToken: (t) => pruned.push(t),
      },
      SID,
    );
  }
  const addToken = (t: string): void => {
    deviceTokens.set(t, { token: t, platform: 'ios', registeredAt: 1, connectionId: SID });
  };

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    deviceTokens = new Map();
    pruned = [];
    configureLogger({ writeLog: () => {} });
  });
  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('a BadDeviceToken push prunes the dead token', async () => {
    register();
    addToken('dead');
    const fail: PushFn = async () => {
      throw new Error(
        'Push trigger failed: 502 {"error":"APNS 400: BadDeviceToken","tokenInvalid":true}',
      );
    };
    await make(fail).maybePush(SID, question('q1', [yesOpt, noOpt]));
    expect(pruned).toEqual(['dead']);
  });

  // (A transient 429/5xx classifies as not-token-invalid -> no prune; covered
  // instantly by the 401 case below + the isTokenInvalidError unit tests, so the
  // slow real-backoff 429 path is not re-tested here.)
  test('a 401 (non-token) failure does NOT prune the token', async () => {
    register();
    addToken('t');
    const fail: PushFn = async () => {
      throw new Error('Push trigger failed: 401 unauthorized');
    };
    await make(fail).maybePush(SID, question('q1', [yesOpt, noOpt]));
    expect(pruned).toEqual([]);
  });
});

describe('NotificationDispatcher.refreshDeviceTokens (#690)', () => {
  let registry: SessionRegistry;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  const SID = 's0000000-0000-0000-0000-000000000000' as UUID;

  function register(): void {
    registry.registerSession(SID, '/d', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
  }

  beforeEach(() => {
    registry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    deviceTokens = new Map();
    configureLogger({ writeLog: () => {} });
  });
  afterEach(async () => {
    __resetLoggerForTests();
    await registry.shutdown();
  });

  test('is called before every push decision when wired', async () => {
    register();
    deviceTokens.set('tok', { token: 'tok', platform: 'ios', registeredAt: 1, connectionId: SID });
    let calls = 0;
    const dispatcher = new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x' }),
        getPrimarySessionId: () => null,
        pushFn: async () => {},
        refreshDeviceTokens: () => {
          calls++;
        },
      },
      SID,
    );
    await dispatcher.maybePush(SID, question('q1', [yesOpt, noOpt]));
    expect(calls).toBe(1);
  });

  test('a sibling-recorded removal picked up by refreshDeviceTokens drops the push channel', async () => {
    register();
    deviceTokens.set('tok', { token: 'tok', platform: 'ios', registeredAt: 1, connectionId: SID });
    let pushed = false;
    const dispatcher = new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x' }),
        getPrimarySessionId: () => null,
        pushFn: async () => {
          pushed = true;
        },
        // Simulates DeviceTokenStore.refreshFromDisk() finding a sibling
        // daemon's tombstone for this token and dropping it from the SAME
        // shared map the dispatcher reads.
        refreshDeviceTokens: () => {
          deviceTokens.delete('tok');
        },
      },
      SID,
    );
    const outcome = await dispatcher.maybePush(SID, question('q1', [yesOpt, noOpt]));
    expect(outcome).toBe('no_channel');
    expect(pushed).toBe(false);
  });

  test('absent refreshDeviceTokens is a no-op (backward compatible)', async () => {
    register();
    deviceTokens.set('tok', { token: 'tok', platform: 'ios', registeredAt: 1, connectionId: SID });
    let pushed = false;
    const dispatcher = new NotificationDispatcher(
      {
        sessionRegistry: registry,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://x' }),
        getPrimarySessionId: () => null,
        pushFn: async () => {
          pushed = true;
        },
      },
      SID,
    );
    const outcome = await dispatcher.maybePush(SID, question('q1', [yesOpt, noOpt]));
    expect(outcome).toBe('pushed');
    expect(pushed).toBe(true);
  });
});

describe('isTokenInvalidError (#603 Phase 6)', () => {
  test('matches the structured tokenInvalid flag and the APNS token reasons', () => {
    expect(isTokenInvalidError(new Error('502 {"error":"x","tokenInvalid":true}'))).toBe(true);
    expect(isTokenInvalidError(new Error('APNS 400: BadDeviceToken'))).toBe(true);
    expect(isTokenInvalidError(new Error('410 {"reason":"Unregistered"}'))).toBe(true);
    expect(isTokenInvalidError(new Error('DeviceTokenNotForTopic'))).toBe(true);
  });

  test('does NOT match transient / auth / network errors', () => {
    expect(isTokenInvalidError(new Error('Push trigger failed: 429 rate limited'))).toBe(false);
    expect(isTokenInvalidError(new Error('Push trigger failed: 401 unauthorized'))).toBe(false);
    expect(isTokenInvalidError(new Error('Push trigger failed: 503 unavailable'))).toBe(false);
    expect(isTokenInvalidError(new TypeError('Failed to fetch'))).toBe(false);
  });
});
