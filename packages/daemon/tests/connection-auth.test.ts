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
  fingerprint,
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

    test('exposes connectionClientFingerprint after successful auth (#671)', async () => {
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, { authenticator });

      expect(conn.connectionClientFingerprint).toBeNull();

      const challenge = ws.sentMessages[0] as ProtocolMessage & { challenge: string };
      const challengeData = fromBase64(challenge.challenge);
      const signature = await sign(clientIdentity.privateKey, challengeData);
      const response = createAuthResponse(clientPublicKeyBase64, signature, clientFingerprint);
      conn.handleMessage(serialize(response));
      await new Promise((r) => setTimeout(r, 100));

      // The value bound here is the REAL fingerprint derived from the
      // client's Ed25519 key via the challenge-response, not a client-supplied
      // string — this is what the same-device reclaim check (#671) binds
      // deviceId to, so a peer without this exact key can never produce it.
      expect(conn.connectionClientFingerprint).toBe(clientFingerprint);
    });

    test('two different authenticated clients get different connectionClientFingerprint values (#671)', async () => {
      const otherIdFile = await createIdentity('otherpass');
      const otherIdentity = await unlockIdentity(otherIdFile, 'otherpass');
      await store.addAuthorizedKey(otherIdFile.publicKey, 'Other Client');

      const wsA = new MockWebSocket();
      const connA = new Connection(wsA as unknown as WebSocket, {}, { authenticator });
      const challengeA = wsA.sentMessages[0] as ProtocolMessage & { challenge: string };
      const sigA = await sign(clientIdentity.privateKey, fromBase64(challengeA.challenge));
      connA.handleMessage(
        serialize(createAuthResponse(clientPublicKeyBase64, sigA, clientFingerprint)),
      );
      await new Promise((r) => setTimeout(r, 100));

      const wsB = new MockWebSocket();
      const connB = new Connection(wsB as unknown as WebSocket, {}, { authenticator });
      const challengeB = wsB.sentMessages[0] as ProtocolMessage & { challenge: string };
      const sigB = await sign(otherIdentity.privateKey, fromBase64(challengeB.challenge));
      connB.handleMessage(
        serialize(createAuthResponse(otherIdFile.publicKey, sigB, otherIdFile.fingerprint)),
      );
      await new Promise((r) => setTimeout(r, 100));

      expect(connA.connectionClientFingerprint).toBe(clientFingerprint);
      expect(connB.connectionClientFingerprint).toBe(otherIdFile.fingerprint);
      expect(connA.connectionClientFingerprint).not.toBe(connB.connectionClientFingerprint);
    });

    test('a forged clientFingerprint claim is ignored: the DERIVED fingerprint is bound, not the claim (#671 critical)', async () => {
      // The client's Ed25519 signature only proves possession of
      // clientPublicKey; AuthResponseMessage.clientFingerprint is a
      // client-supplied wire field the signature says nothing about. An
      // already-authorized client lying about its OWN fingerprint (claiming
      // an arbitrary forged value instead of its real one) must still get
      // its REAL, server-derived fingerprint bound to the connection.
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, { authenticator });

      const challenge = ws.sentMessages[0] as ProtocolMessage & { challenge: string };
      const signature = await sign(clientIdentity.privateKey, fromBase64(challenge.challenge));
      const forgedClaim = 'forged-victim-fingerprint-0000';
      conn.handleMessage(
        serialize(createAuthResponse(clientPublicKeyBase64, signature, forgedClaim)),
      );
      await new Promise((r) => setTimeout(r, 100));

      expect(conn.connectionState).toBe('connecting');
      expect(conn.connectionClientFingerprint).toBe(clientFingerprint);
      expect(conn.connectionClientFingerprint).not.toBe(forgedClaim);
    });

    test('PoC: a fresh throwaway keypair cannot bind a forged victim fingerprint via TOFU (#671 critical)', async () => {
      // Reproduces the reported exploit: an attacker who owns no authorized
      // key generates a brand-new keypair, completes a perfectly valid
      // signature over the challenge with it, and claims the VICTIM's real
      // fingerprint in AuthResponseMessage.clientFingerprint. Before the fix,
      // Connection bound that claim directly, so the attacker's connection
      // would present as the victim's authenticated identity — which, paired
      // with the victim's (guessable/replayable) deviceId, would pass the
      // same-device reclaim check in SessionRegistry and evict the victim.
      const tofuAuthenticator = new Authenticator({
        identity: serverIdentity,
        identityStore: store,
        tofuMode: 'auto-accept',
      });

      const attackerIdFile = await createIdentity('attackerpass');
      const attackerIdentity = await unlockIdentity(attackerIdFile, 'attackerpass');
      // Deliberately NOT authorizing attackerIdFile.publicKey up front — TOFU
      // is what lets a never-seen key complete authentication.

      const ws = new MockWebSocket();
      const conn = new Connection(
        ws as unknown as WebSocket,
        {},
        {
          authenticator: tofuAuthenticator,
        },
      );

      const challenge = ws.sentMessages[0] as ProtocolMessage & { challenge: string };
      const signature = await sign(attackerIdentity.privateKey, fromBase64(challenge.challenge));
      // Attacker claims the VICTIM's real fingerprint (clientFingerprint, from
      // the shared beforeEach) while signing with their OWN key.
      conn.handleMessage(
        serialize(createAuthResponse(attackerIdFile.publicKey, signature, clientFingerprint)),
      );
      await new Promise((r) => setTimeout(r, 100));

      // Auth succeeds (TOFU auto-accepts the attacker's own, never-seen key)...
      expect(conn.connectionState).toBe('connecting');
      // ...but the identity bound to the connection is the attacker's OWN
      // derived fingerprint, never the victim's claimed one.
      const attackerDerivedFingerprint = await fingerprint(fromBase64(attackerIdFile.publicKey));
      expect(conn.connectionClientFingerprint).toBe(attackerDerivedFingerprint);
      expect(conn.connectionClientFingerprint).not.toBe(clientFingerprint);

      // The authorized-keys store also recorded the attacker under their OWN
      // correctly-derived fingerprint, not the forged claim (defense in depth
      // in IdentityStore/createAuthorizedKey, unaffected by this fix).
      expect(store.isAuthorized(attackerIdFile.publicKey, attackerDerivedFingerprint)).toBe(true);
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

    test('connectionClientFingerprint stays null with no authenticator (#671)', () => {
      // No authenticator configured (auth disabled daemon-wide, or the peer
      // was loopback-exempted): there is no authenticated identity to bind,
      // so the same-device reclaim check (#671) must fall back to
      // deviceId-only matching for this connection.
      const ws = new MockWebSocket();
      const conn = new Connection(ws as unknown as WebSocket, {}, {});

      const hello = createHello('test-client', '1.0.0');
      conn.handleMessage(serialize(hello));

      expect(conn.connectionState).toBe('connected');
      expect(conn.connectionClientFingerprint).toBeNull();
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
