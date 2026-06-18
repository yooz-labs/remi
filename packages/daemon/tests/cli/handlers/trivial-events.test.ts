import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import {
  type DeviceTokenEntry,
  createTrivialHandlers,
} from '../../../src/cli/handlers/trivial-events.ts';
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

  test('onRegisterDeviceToken stores the token in the shared map', () => {
    const deviceTokens = new Map<string, DeviceTokenEntry>();
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      deviceTokens,
      sessionStore,
      sessionRegistry,
      send,
    });
    configureLogger({ writeLog: () => {} });

    handlers.onRegisterDeviceToken(CID, 'ios-device-token-abc', 'ios');

    expect(deviceTokens.size).toBe(1);
    const entry = deviceTokens.get('ios-device-token-abc');
    expect(entry).toBeDefined();
    expect(entry?.platform).toBe('ios');
    expect(entry?.connectionId).toBe(CID);
    expect(typeof entry?.registeredAt).toBe('number');
  });

  test('onRegisterDeviceToken: registering the same token twice yields ONE entry (#585 P7)', () => {
    const deviceTokens = new Map<string, DeviceTokenEntry>();
    const { send } = makeSend();
    const handlers = createTrivialHandlers({ deviceTokens, sessionStore, sessionRegistry, send });
    configureLogger({ writeLog: () => {} });

    handlers.onRegisterDeviceToken(CID, 'same-token', 'ios');
    handlers.onRegisterDeviceToken(CID, 'same-token', 'ios');

    expect(deviceTokens.size).toBe(1);
    expect(deviceTokens.has('same-token')).toBe(true);
  });

  test('onRegisterDeviceToken: a rotated token from the same connection prunes the old one (#585 P7)', () => {
    // APNS token rotation: the same physical device (same client connection)
    // re-registers a NEW token while the old one is still live -> a push would
    // otherwise fan out to BOTH (the 2x duplicate). The old token from this
    // connection is pruned, leaving only the new one.
    const deviceTokens = new Map<string, DeviceTokenEntry>();
    const { send } = makeSend();
    const handlers = createTrivialHandlers({ deviceTokens, sessionStore, sessionRegistry, send });
    configureLogger({ writeLog: () => {} });

    handlers.onRegisterDeviceToken(CID, 'old-token', 'ios');
    handlers.onRegisterDeviceToken(CID, 'new-token', 'ios');

    expect(deviceTokens.size).toBe(1);
    expect(deviceTokens.has('new-token')).toBe(true);
    expect(deviceTokens.has('old-token')).toBe(false);
  });

  test('onRegisterDeviceToken: a different connection keeps its own token (no cross-device prune)', () => {
    const OTHER = 'conn1111-1111-1111-1111-111111111111' as UUID;
    const deviceTokens = new Map<string, DeviceTokenEntry>();
    const { send } = makeSend();
    const handlers = createTrivialHandlers({ deviceTokens, sessionStore, sessionRegistry, send });
    configureLogger({ writeLog: () => {} });

    handlers.onRegisterDeviceToken(CID, 'token-a', 'ios');
    handlers.onRegisterDeviceToken(OTHER, 'token-b', 'ios');

    // Two genuinely distinct devices on different connections must both survive.
    expect(deviceTokens.size).toBe(2);
    expect(deviceTokens.has('token-a')).toBe(true);
    expect(deviceTokens.has('token-b')).toBe(true);
  });

  test('onTerminalResize logs and returns when no session is attached', () => {
    const logs: string[] = [];
    const { send } = makeSend();
    const handlers = createTrivialHandlers({
      deviceTokens: new Map(),
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
      deviceTokens: new Map(),
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
      deviceTokens: new Map(),
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
      deviceTokens: new Map(),
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
