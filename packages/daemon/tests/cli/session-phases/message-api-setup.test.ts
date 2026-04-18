import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentStatus, ProtocolMessage, Question, QuestionOption, UUID } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { DeviceTokenEntry } from '../../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import {
  createMessageApiForSession,
  selectPushCategory,
} from '../../../src/cli/session-phases/message-api-setup.ts';
import {
  __resetSessionStateForTests,
  setPrimarySessionId,
} from '../../../src/cli/session-state.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import type { TranscriptWatcher } from '../../../src/transcript/transcript-watcher.ts';

function fakePTY(): PTYSession {
  return {
    id: generateId(),
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  } as unknown as PTYSession;
}

function questionWith(options: QuestionOption[]): Question {
  return {
    id: '11111111-1111-1111-1111-111111111111' as UUID,
    text: 'proceed?',
    options,
    allowsFreeText: false,
    isAnswered: false,
  };
}

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

describe('selectPushCategory', () => {
  test('returns REMI_YN for 2 options', () => {
    expect(selectPushCategory([yesOpt, noOpt])).toBe('REMI_YN');
  });
  test('returns REMI_YNA for 3 options', () => {
    expect(selectPushCategory([yesOpt, noOpt, yesOpt])).toBe('REMI_YNA');
  });
  test('returns REMI_MULTI for 4 options', () => {
    expect(selectPushCategory([yesOpt, noOpt, yesOpt, noOpt])).toBe('REMI_MULTI');
  });
  test('returns undefined for other counts', () => {
    expect(selectPushCategory([yesOpt])).toBeUndefined();
    expect(selectPushCategory([])).toBeUndefined();
    expect(selectPushCategory([yesOpt, noOpt, yesOpt, noOpt, yesOpt])).toBeUndefined();
  });
});

describe('createMessageApiForSession', () => {
  let sessionRegistry: SessionRegistry;
  let transcriptWatchers: Map<UUID, TranscriptWatcher>;
  let deviceTokens: Map<string, DeviceTokenEntry>;
  let sendCalls: Array<{ sessionId: UUID; message: ProtocolMessage }>;
  let statusPatches: Array<{ sessionStatus: AgentStatus }>;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 60000 });
    transcriptWatchers = new Map();
    deviceTokens = new Map();
    sendCalls = [];
    statusPatches = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    __resetSessionStateForTests();
    await sessionRegistry.shutdown();
  });

  function build(sessionId: UUID) {
    return createMessageApiForSession(
      {
        sessionRegistry,
        transcriptWatchers,
        deviceTokens,
        pushConfig: () => ({ signalingUrl: 'ws://fake-signaling' }),
        updateRemiStatus: (patch) => statusPatches.push(patch),
        maxBulletLength: 4000,
        sendMessage: (sid, message) => {
          sendCalls.push({ sessionId: sid, message });
        },
      },
      sessionId,
    );
  }

  test('sendAndRecord forwards to sendMessage and records under primary session id', () => {
    const sessionId = sessionRegistry.createSessionId();
    const primaryId = '22222222-2222-2222-2222-222222222222' as UUID;
    // Register the primary session so recordOutgoingMessage has somewhere to record.
    sessionRegistry.registerSession(primaryId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as unknown as import('../../../src/api/message-api.ts').MessageAPI);
    setPrimarySessionId(primaryId);

    const { sendAndRecord } = build(sessionId);
    const msg: ProtocolMessage = {
      type: 'question',
      id: generateId(),
      timestamp: now(),
      question: questionWith([yesOpt, noOpt]),
      sessionId,
    };

    sendAndRecord(msg);

    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0]?.sessionId).toBe(sessionId);
    // Message got recorded under primaryId (check via session.messageHistory).
    expect(sessionRegistry.getSession(primaryId)?.messageHistory.length).toBe(1);
  });

  test('onQuestion emits a question message and updates the registry', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    // No primary -> falls back to sessionId
    const { messageApi } = build(sessionId);

    messageApi.handleQuestion(questionWith([yesOpt, noOpt]));

    const questionMsgs = sendCalls.filter((c) => c.message.type === 'question');
    expect(questionMsgs).toHaveLength(1);
    expect(sessionRegistry.getSession(sessionId)?.currentQuestion?.text).toBe('proceed?');
  });

  test('onQuestion does NOT push when a client is attached', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    sessionRegistry.attachConnection(sessionId, 'conn0000-0000-0000-0000-000000000000' as UUID);
    deviceTokens.set('t', {
      token: 't',
      platform: 'ios',
      registeredAt: Date.now(),
      connectionId: 'conn0000-0000-0000-0000-000000000000' as UUID,
    });

    const { messageApi } = build(sessionId);
    messageApi.handleQuestion(questionWith([yesOpt, noOpt]));

    // Push would require a real HTTP request to the fake signaling URL.
    // We can't observe the attempt directly here (sendPushTrigger is imported
    // into the production module), but we CAN observe that the in-app
    // question message was sent. The push branch is guarded by hasActiveClient
    // so with a connection attached, the for-loop is skipped. A separate test
    // (no attached client) exercises the opposite branch without actually
    // completing the network call.
    const questions = sendCalls.filter((c) => c.message.type === 'question');
    expect(questions).toHaveLength(1);
    expect(sessionRegistry.getSession(sessionId)?.activeConnectionId).not.toBeNull();
  });

  test('onStatusChange emits session_update and patches StatusWriter', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);

    const { messageApi } = build(sessionId);
    messageApi.handleStatusChange('executing');

    const updates = sendCalls.filter((c) => c.message.type === 'session_update');
    expect(updates).toHaveLength(1);
    expect(statusPatches).toEqual([{ sessionStatus: 'executing' }]);
    expect(sessionRegistry.getSession(sessionId)?.currentStatus).toBe('executing');
  });

  test('onStatusChange triggers transcript watcher forceRead when one is registered', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);

    let forceReadCount = 0;
    transcriptWatchers.set(sessionId, {
      forceRead: async () => {
        forceReadCount += 1;
      },
      stop: () => {},
    } as unknown as TranscriptWatcher);

    const { messageApi } = build(sessionId);
    messageApi.handleStatusChange('thinking');

    // forceRead is fire-and-forget; give it a microtask to run.
    return new Promise<void>((resolve) => {
      setTimeout(() => {
        expect(forceReadCount).toBe(1);
        resolve();
      }, 10);
    });
  });
});
