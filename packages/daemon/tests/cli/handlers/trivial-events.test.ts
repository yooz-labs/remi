import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { createTrivialHandlers } from '../../../src/cli/handlers/trivial-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
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
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: () => {} });

    handlers.onRegisterDeviceToken(CID, 'ios-device-token-abc', 'ios');

    expect(calls).toEqual([{ token: 'ios-device-token-abc', platform: 'ios', connectionId: CID }]);
  });

  test('onTerminalResize logs and returns when no session is attached', () => {
    const logs: string[] = [];
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: (msg) => logs.push(msg) });

    // Real SessionRegistry, no connections -> getSessionForConnection returns undefined
    handlers.onTerminalResize(CID, 80, 24);

    expect(logs.some((m) => m.includes('Terminal resize ignored'))).toBe(true);
  });

  test('onError writes [error]-prefixed log in wrapper mode', () => {
    const logs: string[] = [];
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      registerDeviceToken: () => {},
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
