import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { AgentStatus, ProtocolMessage, Question, QuestionOption, UUID } from '@remi/shared';
import { generateId, now } from '@remi/shared';
import type { DeviceTokenEntry } from '../../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { createMessageApiForSession } from '../../../src/cli/session-phases/message-api-setup.ts';
import {
  __resetSessionStateForTests,
  setPrimarySessionId,
} from '../../../src/cli/session-state.ts';
import { selectPushCategory } from '../../../src/notifications/notification-dispatcher.ts';
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
    const pending = [...(sessionRegistry.getSession(sessionId)?.currentQuestions.values() ?? [])];
    expect(pending[0]?.text).toBe('proceed?');
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

    // Push would fire a real HTTP request to the fake signaling URL if the
    // hasActiveClient branch were bypassed. sendPushTrigger is imported
    // statically by the production module, so tests can't observe that call
    // directly without a mock. What we CAN assert: the in-app question
    // message still went out, and activeConnectionId is non-null (the
    // condition guarding the push for-loop). A follow-up that injects
    // sendPushTrigger via deps would let us assert the opposite branch.
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

  test('sendAndRecord records under sessionId when no primary is set', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);
    // Deliberately do NOT call setPrimarySessionId.

    const { sendAndRecord } = build(sessionId);
    sendAndRecord({
      type: 'session_update',
      id: generateId(),
      timestamp: now(),
      session: {
        id: sessionId,
        name: '',
        startedAt: now(),
        status: 'idle',
        isActive: false,
      },
    });

    expect(sendCalls).toHaveLength(1);
    // Fallback: recorded under sessionId (the only registered session).
    expect(sessionRegistry.getSession(sessionId)?.messageHistory.length).toBe(1);
  });

  test('onQuestion falls back to sessionId for the emitted message when no primary is set', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);

    const { messageApi } = build(sessionId);
    messageApi.handleQuestion(questionWith([yesOpt, noOpt]));

    const questionMsg = sendCalls.find((c) => c.message.type === 'question');
    expect(questionMsg).toBeDefined();
    // Question is routed to the caller's sendMessage bound to sessionId, and
    // the inner message.sessionId falls back to sessionId when primary is null.
    expect(questionMsg?.sessionId).toBe(sessionId);
    expect((questionMsg?.message as { sessionId: UUID }).sessionId).toBe(sessionId);
  });

  test('onStructuredMessage emits structured_agent_output with isUpdate=false', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);

    const { messageApi } = build(sessionId);
    messageApi.handleMessage({
      id: '33333333-3333-3333-3333-333333333333' as UUID,
      sessionId,
      sender: 'agent',
      content: 'hello world',
      createdAt: now(),
      state: 'delivered',
      stateChangedAt: now(),
      isEditing: false,
    });

    const structured = sendCalls.filter((c) => c.message.type === 'structured_agent_output');
    expect(structured.length).toBeGreaterThanOrEqual(1);
    // The first emission on a new message is a create, not an update.
    expect((structured[0]?.message as { isUpdate: boolean }).isUpdate).toBe(false);
  });

  test('onStructuredMessageUpdate emits structured_agent_output with isUpdate=true', () => {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
      handleMessage: () => {},
      handleQuestion: () => {},
      handleStatusChange: () => {},
    } as never);

    const { messageApi } = build(sessionId);
    const msgId = '44444444-4444-4444-4444-444444444444' as UUID;
    messageApi.handleMessage({
      id: msgId,
      sessionId,
      sender: 'agent',
      content: 'first',
      createdAt: now(),
      state: 'delivered',
      stateChangedAt: now(),
      isEditing: true,
    });
    // Reset captures so we can assert the update cleanly.
    sendCalls.length = 0;
    messageApi.handleMessageUpdate(msgId, 'first and more');

    const updates = sendCalls.filter((c) => c.message.type === 'structured_agent_output');
    expect(updates.length).toBeGreaterThanOrEqual(1);
    expect((updates[0]?.message as { isUpdate: boolean }).isUpdate).toBe(true);
  });

  describe('getClaudeSessionId on questions (#429)', () => {
    function buildWithBinding(sessionId: UUID, get: () => UUID | null) {
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
          getClaudeSessionId: get,
        },
        sessionId,
      );
    }

    test('question carries claudeSessionId returned by the lazy getter', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
        handleMessage: () => {},
        handleQuestion: () => {},
        handleStatusChange: () => {},
      } as unknown as import('../../../src/api/message-api.ts').MessageAPI);
      setPrimarySessionId(sessionId);
      const claudeId = '11111111-2222-3333-4444-555555555555' as UUID;
      const { messageApi } = buildWithBinding(sessionId, () => claudeId);

      messageApi.handleQuestion(questionWith([yesOpt, noOpt]));

      const q = sendCalls.find((c) => c.message.type === 'question');
      expect(q).toBeDefined();
      expect((q?.message as { claudeSessionId?: string }).claudeSessionId).toBe(claudeId);
    });

    test('getter rotation: second question reflects the new binding', () => {
      // Simulates /resume rotation between two question emissions —
      // the lazy getter must re-read on each emission, not capture once.
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
        handleMessage: () => {},
        handleQuestion: () => {},
        handleStatusChange: () => {},
      } as unknown as import('../../../src/api/message-api.ts').MessageAPI);
      setPrimarySessionId(sessionId);
      const before = '11111111-2222-3333-4444-555555555555' as UUID;
      const after = '99999999-aaaa-bbbb-cccc-dddddddddddd' as UUID;
      let current: UUID = before;
      const { messageApi } = buildWithBinding(sessionId, () => current);

      messageApi.handleQuestion(questionWith([yesOpt, noOpt]));
      // Force a status reset so questionDedup doesn't suppress the
      // second emission.
      messageApi.handleStatusChange('idle');
      current = after;
      messageApi.handleQuestion(
        questionWith([
          { ...yesOpt, value: 'y2', label: 'Y2' },
          { ...noOpt, value: 'n2', label: 'N2' },
        ]),
      );

      const questions = sendCalls
        .filter((c) => c.message.type === 'question')
        .map((c) => (c.message as { claudeSessionId?: string }).claudeSessionId);
      expect(questions).toEqual([before, after]);
    });

    test('getter returning null omits claudeSessionId from the wire message', () => {
      const sessionId = sessionRegistry.createSessionId();
      sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), {
        handleMessage: () => {},
        handleQuestion: () => {},
        handleStatusChange: () => {},
      } as unknown as import('../../../src/api/message-api.ts').MessageAPI);
      setPrimarySessionId(sessionId);
      const { messageApi } = buildWithBinding(sessionId, () => null);

      messageApi.handleQuestion(questionWith([yesOpt, noOpt]));

      const q = sendCalls.find((c) => c.message.type === 'question');
      expect(q).toBeDefined();
      expect('claudeSessionId' in (q?.message ?? {})).toBe(false);
    });
  });
});
