/**
 * Tests for Connection auth state machine.
 * Uses real crypto operations (no mocks).
 *
 * Tests the state transitions:
 *   With auth:    authenticating -> connecting -> connected -> disconnected
 *   Without auth: connecting -> connected -> disconnected
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createAnswer,
  createAuqAnswer,
  createAuthResponse,
  createCancelQuestion,
  createHello,
  createIdentity,
  createPing,
  createUserInput,
  deserialize,
  fromBase64,
  serialize,
  sign,
  unlockIdentity,
} from '@remi/shared';
import type { AnswerExtras, ProtocolMessage, UUID, UnlockedIdentity } from '@remi/shared';
import { Authenticator } from '../src/auth/authenticator.ts';
import { IdentityStore } from '../src/auth/identity-store.ts';
import { Connection } from '../src/server/connection.ts';

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'remi-conn-auth-test-'));
}

/** Mock WebSocket that captures sent messages */
class MockWebSocket {
  readyState = WebSocket.OPEN;
  sentMessages: ProtocolMessage[] = [];
  closed = false;

  send(data: string): void {
    const msg = deserialize(data);
    if (msg) this.sentMessages.push(msg);
  }

  close(): void {
    this.closed = true;
  }

  /** Get last sent message of a given type */
  lastOfType(type: string): ProtocolMessage | undefined {
    return [...this.sentMessages].reverse().find((m) => m.type === type);
  }
}

describe('Connection auth state machine', () => {
  let tmpDir: string;
  let store: IdentityStore;
  let serverIdentity: UnlockedIdentity;
  let authenticator: Authenticator;
  let clientIdentity: UnlockedIdentity;
  let clientPublicKeyBase64: string;
  let clientFingerprint: string;

  beforeEach(async () => {
    tmpDir = makeTmpDir();
    store = new IdentityStore(tmpDir);

    await store.generate('serverpass');
    serverIdentity = await store.unlock('serverpass');

    const clientIdFile = await createIdentity('clientpass');
    clientIdentity = await unlockIdentity(clientIdFile, 'clientpass');
    clientPublicKeyBase64 = clientIdFile.publicKey;
    clientFingerprint = clientIdFile.fingerprint;

    await store.addAuthorizedKey(clientPublicKeyBase64, 'Test Client');

    authenticator = new Authenticator({
      identity: serverIdentity,
      identityStore: store,
    });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      /* ignore */
    }
  });

  describe('with auth', () => {
    test('starts in authenticating state and sends auth_challenge', () => {
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, { authenticator });

      expect(conn.connectionState).toBe('authenticating');
      expect(ws.sentMessages.length).toBe(1);
      expect(ws.sentMessages[0]?.type).toBe('auth_challenge');
    });

    test('transitions to connecting after valid auth_response', async () => {
      const ws = new MockWebSocket();
      let authSuccess = false;
      const conn = new Connection(
        ws as unknown as WebSocket,
        {
          onAuthSuccess: () => {
            authSuccess = true;
          },
        },
        { authenticator },
      );

      // Get the challenge from the sent message
      const challenge = ws.sentMessages[0] as ProtocolMessage & { challenge: string };

      // Client signs the challenge
      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(clientIdentity.privateKey, challengeData);
      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);

      // Send auth_response to connection
      conn.handleMessage(serialize(response));

      // Wait for async auth processing
      await new Promise((r) => setTimeout(r, 100));

      expect(conn.connectionState).toBe('connecting');
      expect(authSuccess).toBe(true);

      // Should have sent auth_result(success)
      const result = ws.lastOfType('auth_result') as ProtocolMessage & { success: boolean };
      expect(result).toBeDefined();
      expect(result.success).toBe(true);
    });

    test('full handshake: auth -> hello -> connected', async () => {
      const ws = new MockWebSocket();
      let connectedSessionId: string | null = null;
      const conn = new Connection(
        ws as unknown as WebSocket,
        {
          onConnect: (sessionId) => {
            connectedSessionId = sessionId;
          },
        },
        { authenticator, skipHelloAck: false },
      );

      // Auth phase
      const challenge = ws.sentMessages[0] as ProtocolMessage & { challenge: string };
      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(clientIdentity.privateKey, challengeData);
      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);
      conn.handleMessage(serialize(response));
      await new Promise((r) => setTimeout(r, 100));

      expect(conn.connectionState).toBe('connecting');

      // Hello phase
      const hello = createHello('test-client', '1.0.0');
      conn.handleMessage(serialize(hello));

      expect(conn.connectionState).toBe('connected');
      expect(String(connectedSessionId)).toBe(conn.id);

      // Should have sent hello_ack
      const helloAck = ws.lastOfType('hello_ack');
      expect(helloAck).toBeDefined();
    });

    test('rejects non-auth messages during authenticating state', () => {
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, { authenticator });

      // Try sending user_input during authenticating state
      const hello = createHello('test-client', '1.0.0');
      conn.handleMessage(serialize(hello));

      // Should get AUTH_REQUIRED error
      const errorMsg = ws.lastOfType('error') as ProtocolMessage & { code: string };
      expect(errorMsg).toBeDefined();
      expect(errorMsg.code).toBe('AUTH_REQUIRED');
      expect(conn.connectionState).toBe('authenticating');
    });

    test('allows ping during authenticating state', () => {
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, { authenticator });

      const ping = createPing();
      conn.handleMessage(serialize(ping));

      // Should get pong back (not AUTH_REQUIRED)
      const pong = ws.lastOfType('pong');
      expect(pong).toBeDefined();
    });

    test('closes connection on failed auth', async () => {
      const ws = new MockWebSocket();
      let authFailed = false;
      const conn = new Connection(
        ws as unknown as WebSocket,
        {
          onAuthFailed: () => {
            authFailed = true;
          },
          onDisconnect: () => {},
        },
        { authenticator },
      );

      // Create unauthorized client
      const unknownId = await createIdentity('unknown');
      const unknownUnlocked = await unlockIdentity(unknownId, 'unknown');

      const challenge = ws.sentMessages[0] as ProtocolMessage & { challenge: string };
      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(unknownUnlocked.privateKey, challengeData);
      const response = createAuthResponse(unknownId.publicKey, signature, unknownId.fingerprint);

      conn.handleMessage(serialize(response));
      await new Promise((r) => setTimeout(r, 100));

      expect(authFailed).toBe(true);
      expect(conn.connectionState).toBe('disconnected');

      // Should have sent auth_result(failure)
      const result = ws.lastOfType('auth_result') as ProtocolMessage & {
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
    });

    test('sends auth_result(false) on internal auth error', async () => {
      const ws = new MockWebSocket();
      const conn = new Connection(
        ws as unknown as WebSocket,
        {
          onError: () => {},
          onDisconnect: () => {},
        },
        { authenticator },
      );

      // Send a malformed auth_response (valid structure but garbage signature)
      const malformed = createAuthResponse(
        clientPublicKeyBase64,
        'not-valid-base64!!!',
        clientFingerprint,
      );
      conn.handleMessage(serialize(malformed));
      await new Promise((r) => setTimeout(r, 100));

      // Should have sent auth_result(false) with INTERNAL_AUTH_ERROR
      const result = ws.lastOfType('auth_result') as ProtocolMessage & {
        success: boolean;
        error?: string;
      };
      expect(result).toBeDefined();
      expect(result.success).toBe(false);
      expect(conn.connectionState).toBe('disconnected');
    });
  });

  describe('without auth', () => {
    test('starts in connecting state', () => {
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, {});

      expect(conn.connectionState).toBe('connecting');
      // No auth_challenge sent
      expect(ws.sentMessages.length).toBe(0);
    });

    test('accepts hello and transitions to connected', () => {
      const ws = new MockWebSocket();
      let connectedSessionId: string | null = null;
      const conn = new Connection(
        ws as unknown as WebSocket,
        {
          onConnect: (sessionId) => {
            connectedSessionId = sessionId;
          },
        },
        { skipHelloAck: false },
      );

      const hello = createHello('test-client', '1.0.0');
      conn.handleMessage(serialize(hello));

      expect(conn.connectionState).toBe('connected');
      expect(String(connectedSessionId)).toBe(conn.id);
    });

    test('rejects messages before hello', () => {
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, {});

      const input = createUserInput('session-1', 'test');
      conn.handleMessage(serialize(input));

      // Should get NOT_CONNECTED error
      const errorMsg = ws.lastOfType('error') as ProtocolMessage & { code: string };
      expect(errorMsg).toBeDefined();
      expect(errorMsg.code).toBe('NOT_CONNECTED');
    });
  });

  describe('connection timeout', () => {
    test('times out during authenticating state', async () => {
      const ws = new MockWebSocket();
      let disconnected = false;
      new Connection(
        ws as unknown as WebSocket,
        {
          onDisconnect: () => {
            disconnected = true;
          },
        },
        { authenticator, connectionTimeout: 50 },
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(disconnected).toBe(true);
    });

    test('times out during connecting state (no hello received)', async () => {
      const ws = new MockWebSocket();
      let disconnected = false;
      new Connection(
        ws as unknown as WebSocket,
        {
          onDisconnect: () => {
            disconnected = true;
          },
        },
        { connectionTimeout: 50 },
      );

      await new Promise((r) => setTimeout(r, 100));
      expect(disconnected).toBe(true);
    });
  });

  describe('cleanup', () => {
    test('removes pending auth challenge on close during auth', () => {
      const ws = new MockWebSocket();
      const conn = new Connection(
        ws as unknown as WebSocket,
        {
          onDisconnect: () => {},
        },
        { authenticator },
      );

      // Close during authenticating state
      conn.handleClose();

      expect(conn.connectionState).toBe('disconnected');
    });
  });
});

describe('Connection answer extraction (#627)', () => {
  function connectedConn(
    onAnswer: (
      sessionId: UUID,
      questionId: UUID,
      answer: string,
      claudeSessionId?: UUID,
      extra?: AnswerExtras,
    ) => void,
  ): Connection {
    const ws = new MockWebSocket();
    const conn = new Connection(ws as unknown as WebSocket, { onAnswer }, { skipHelloAck: false });
    conn.handleMessage(serialize(createHello('c', '1.0.0')));
    return conn;
  }
  const SID = 's0000000-0000-0000-0000-000000000000' as UUID;
  const QID = 'q0000000-0000-0000-0000-000000000000' as UUID;

  test('a cancel message forwards extra.cancel = true', () => {
    let captured: AnswerExtras | undefined;
    let called = false;
    const conn = connectedConn((_s, _q, _a, _c, extra) => {
      called = true;
      captured = extra;
    });
    conn.handleMessage(serialize(createCancelQuestion(SID, QID)));
    expect(called).toBe(true);
    expect(captured).toEqual({ selections: undefined, cancel: true });
  });

  test('a selections message forwards extra.selections (no cancel)', () => {
    const sels = [{ questionIndex: 0, optionIndices: [1] }];
    let captured: AnswerExtras | undefined;
    const conn = connectedConn((_s, _q, _a, _c, extra) => {
      captured = extra;
    });
    conn.handleMessage(serialize(createAuqAnswer(SID, QID, sels)));
    expect(captured?.selections).toEqual(sels);
    expect(captured?.cancel).toBeUndefined();
  });

  test('a plain answer forwards undefined extra', () => {
    let captured: AnswerExtras | undefined = { cancel: true }; // sentinel != undefined
    const conn = connectedConn((_s, _q, _a, _c, extra) => {
      captured = extra;
    });
    conn.handleMessage(serialize(createAnswer(SID, QID, 'y')));
    expect(captured).toBeUndefined();
  });
});
