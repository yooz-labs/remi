import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { generateId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { createTrivialHandlers } from '../../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';

const CID = 'conn0000-0000-0000-0000-000000000000' as UUID;
const REQ = 'req00000-0000-0000-0000-000000000000' as UUID;

interface SendCapture {
  calls: Array<{ connectionId: UUID; message: ProtocolMessage }>;
}

function makeSend(): {
  send: (connectionId: UUID, message: ProtocolMessage) => boolean;
  captured: SendCapture;
} {
  const captured: SendCapture = { calls: [] };
  return {
    send: (connectionId, message) => {
      captured.calls.push({ connectionId, message });
      return true;
    },
    captured,
  };
}

describe('createTrivialHandlers', () => {
  let tmpDir: string;
  let sessionStore: SessionStore;
  let sessionRegistry: SessionRegistry;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-trivial-'));
    sessionStore = new SessionStore(path.join(tmpDir, 'sessions.json'));
    sessionRegistry = new SessionRegistry({ maxReplayHistory: 10 });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test('onRegisterDeviceToken forwards token/platform/connection to the store (#603 P6)', () => {
    // The map + rotation prune + persistence now live in DeviceTokenStore (see
    // device-token-store.test.ts); the handler just forwards.
    const calls: Array<{ token: string; platform: string; connectionId: UUID }> = [];
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: (token, platform, connectionId) =>
        calls.push({ token, platform, connectionId }),
      unregisterDeviceToken: () => {},
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: () => {} });

    handlers.onRegisterDeviceToken(CID, 'ios-device-token-abc', 'ios');

    expect(calls).toEqual([{ token: 'ios-device-token-abc', platform: 'ios', connectionId: CID }]);
  });

  test('onUnregisterDeviceToken forwards token to the store (#690)', () => {
    const calls: string[] = [];
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
      unregisterDeviceToken: (token) => calls.push(token),
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: () => {} });

    handlers.onUnregisterDeviceToken(CID, 'ios-device-token-abc');

    expect(calls).toEqual(['ios-device-token-abc']);
  });

  test('onTerminalResize logs and returns when no session is attached', () => {
    const logs: string[] = [];
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
      unregisterDeviceToken: () => {},
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: (msg) => logs.push(msg) });

    // Real SessionRegistry, no connections -> getSessionForConnection returns undefined
    handlers.onTerminalResize(CID, 80, 24);

    expect(logs.some((m) => m.includes('Terminal resize ignored'))).toBe(true);
  });

  test('resize is last-writer-wins across multiple attached connections (#795)', () => {
    const resizes: Array<{ cols: number; rows: number }> = [];
    const pty = {
      id: generateId(),
      resize: (size: { cols: number; rows: number }) => {
        resizes.push(size);
      },
      close: async () => {},
    } as unknown as PTYSession;
    const messageApi = { bulletCount: 0 } as unknown as MessageAPI;
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', pty, messageApi);
    const connA = generateId();
    const connB = generateId();
    sessionRegistry.attachConnection(sessionId, connA);
    sessionRegistry.attachConnection(sessionId, connB);

    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
      unregisterDeviceToken: () => {},
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: () => {} });

    // Both attached connections can resize; there is no negotiation --
    // whichever call lands LAST wins, regardless of which connection sent it.
    handlers.onTerminalResize(connA, 80, 24);
    handlers.onTerminalResize(connB, 120, 40);
    handlers.onTerminalResize(connA, 100, 30);

    expect(resizes).toEqual([
      { cols: 80, rows: 24 },
      { cols: 120, rows: 40 },
      { cols: 100, rows: 30 },
    ]);
  });

  test('onError writes [error]-prefixed log in wrapper mode', () => {
    const logs: string[] = [];
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
      unregisterDeviceToken: () => {},
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: (msg) => logs.push(msg) });

    handlers.onError(CID, new Error('boom'));

    expect(logs.some((m) => m.startsWith('[error]') && m.includes('boom'))).toBe(true);
  });

  test('onSessionHistoryRequest sends session_history_response with real SessionStore', () => {
    const { send, captured } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
      unregisterDeviceToken: () => {},
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: () => {} });

    handlers.onSessionHistoryRequest(CID, REQ, 5);

    expect(captured.calls).toHaveLength(1);
    expect(captured.calls[0]?.message.type).toBe('session_history_response');
    expect(captured.calls[0]?.connectionId).toBe(CID);
  });

  test('onSessionHistoryRequest clamps limit to a minimum of 1', () => {
    const { send, captured } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
      unregisterDeviceToken: () => {},
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: () => {} });

    handlers.onSessionHistoryRequest(CID, REQ, 0);
    handlers.onSessionHistoryRequest(CID, REQ, -5);

    expect(captured.calls).toHaveLength(2);
    // Empty history, but both should respond (not throw) with a response envelope.
    expect(captured.calls.every((c) => c.message.type === 'session_history_response')).toBe(true);
  });
});
