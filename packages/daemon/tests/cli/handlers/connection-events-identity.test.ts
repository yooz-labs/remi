/**
 * What `createConnectionHandlers` puts on each hello_ack and re-sent question
 * (#1179): the harness identity, and the harnesses the daemon can start.
 *
 * The handlers are the real ones, over a real `SessionRegistry`; the daemon's
 * harness and its available harnesses are the two values `cli.ts` passes in.
 * The black-box files (`integration/claude-wire-identity.test.ts`,
 * `integration/codex-wire-identity.test.ts`) check the same bytes over a real
 * socket; these pin the branches that need a daemon in a state a process cannot
 * easily be put in (no session record, a command that appears later).
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type {
  HarnessId,
  HelloAckMessage,
  ProtocolMessage,
  QuestionMessage,
  UUID,
} from '@remi/shared';
import { PROTOCOL_VERSION, generateId, identityFromClaudeId } from '@remi/shared';
import type { MessageAPI } from '../../../src/api/message-api.ts';
import { DAEMON_CAPABILITIES } from '../../../src/cli/capabilities.ts';
import type { CurrentOwnedSession } from '../../../src/cli/current-session.ts';
import { createConnectionHandlers } from '../../../src/cli/handlers/connection-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import {
  __resetSessionStateForTests,
  setPrimarySessionId,
} from '../../../src/cli/session-state.ts';
import type { PTYSession } from '../../../src/pty/pty-session.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';

const CID = 'conn0000-0000-0000-0000-000000000001' as UUID;
const THREAD = '01950000-0000-7000-8000-0000000000aa';
const CLAUDE = '22222222-2222-4222-8222-222222222222' as UUID;

const fakePTY = (): PTYSession =>
  ({
    id: generateId(),
    write: () => {},
    submitInput: async () => {},
    close: async () => {},
  }) as unknown as PTYSession;
const fakeMessageAPI = (): MessageAPI =>
  ({ getFullBulletContent: () => null, bulletCount: 0 }) as unknown as MessageAPI;

describe('hello_ack and re-sent questions carry the harness identity (#1179)', () => {
  let sessionRegistry: SessionRegistry;
  let sent: ProtocolMessage[];

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    sent = [];
    configureLogger({ writeLog: () => {} });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    __resetSessionStateForTests();
    await sessionRegistry.shutdown();
  });

  function handlers(opts: {
    harnessId: HarnessId;
    harnesses?: () => readonly HarnessId[];
    current?: () => CurrentOwnedSession | null;
    /** A hub hosts no session, so its session-less ack names no harness. */
    hubMode?: boolean;
    capabilities?: readonly string[];
  }) {
    return createConnectionHandlers({
      sessionRegistry,
      currentOwnedSession: opts.current ?? (() => null),
      hubMode: opts.hubMode ?? false,
      harnessId: opts.harnessId,
      harnesses: opts.harnesses ?? (() => ['codex']),
      ...(opts.capabilities !== undefined && { capabilities: opts.capabilities }),
      trackConnection: () => {},
      untrackConnection: () => {},
      onConnectionAdded: () => {},
      onConnectionRemoved: () => {},
      cancelOrphanTimeout: () => {},
      send: (_connectionId, message) => {
        sent.push(message);
        return true;
      },
      remiVersion: '9.9.9-test',
    });
  }

  const connect = (h: ReturnType<typeof handlers>, mode?: 'query') =>
    h.onConnect(CID, {
      adapterType: 'websocket',
      platformData: mode ? { kind: 'websocket', mode } : { kind: 'websocket' },
    });
  const acks = () => sent.filter((m): m is HelloAckMessage => m.type === 'hello_ack');

  function withPrimarySession(): UUID {
    const sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(), fakeMessageAPI());
    setPrimarySessionId(sessionId);
    return sessionId;
  }

  test('every ack names the harnesses, read at each ack: session-less, attached and query-mode', async () => {
    let offered: readonly HarnessId[] = ['claude'];
    const h = handlers({ harnessId: 'claude', harnesses: () => offered });

    await connect(h); // no primary session: the session-less ack a hub sends
    withPrimarySession();
    offered = ['claude', 'codex'];
    await connect(h); // attaches
    offered = ['codex'];
    await connect(h, 'query'); // acks without attaching

    expect(acks().map((a) => a.harnesses)).toEqual([['claude'], ['claude', 'codex'], ['codex']]);
  });

  test("every ack names the protocol version and the daemon's capabilities (#1237)", async () => {
    const h = handlers({ harnessId: 'claude' });
    await connect(h); // session-less
    withPrimarySession();
    await connect(h); // attaches
    await connect(h, 'query'); // acks without attaching
    expect(acks().map((a) => [a.protocolVersion, a.capabilities])).toEqual([
      [PROTOCOL_VERSION, DAEMON_CAPABILITIES],
      [PROTOCOL_VERSION, DAEMON_CAPABILITIES],
      [PROTOCOL_VERSION, DAEMON_CAPABILITIES],
    ]);
  });

  test('a capability list given to the handlers reaches every ack (#1237)', async () => {
    const h = handlers({ harnessId: 'claude', capabilities: ['x.one', 'x.two'] });
    await connect(h); // session-less
    withPrimarySession();
    await connect(h); // attaches
    await connect(h, 'query'); // acks without attaching
    expect(acks().map((a) => a.capabilities)).toEqual([
      ['x.one', 'x.two'],
      ['x.one', 'x.two'],
      ['x.one', 'x.two'],
    ]);
  });

  test("a hub's session-less ack names no session identity and no harness, only the harnesses", async () => {
    await connect(handlers({ harnessId: 'claude', hubMode: true }));
    const ack = acks()[0] as HelloAckMessage;
    expect(ack.sessionId).toBeNull();
    expect(ack.harnesses).toEqual(['codex']);
    for (const key of ['harness', 'harnessSessionId', 'claudeSessionId', 'transcriptPath']) {
      expect(key in ack).toBe(false);
    }
  });

  test('a daemon that is not a hub names its harness on the ack it sends before its session exists (G9)', async () => {
    // The brief startup window of an ordinary daemon: no primary session yet, so no binding. A
    // Codex daemon must not read as Claude by the absence of a field.
    await connect(handlers({ harnessId: 'codex' }));
    await connect(handlers({ harnessId: 'claude' }));
    const [codex, claude] = acks() as [HelloAckMessage, HelloAckMessage];
    expect(codex.sessionId).toBeNull();
    expect(codex.harness).toBe('codex');
    expect(claude.harness).toBe('claude');
    // Only the harness: no session identity or transcript is invented for a session that is not there.
    for (const ack of [codex, claude]) {
      for (const key of ['harnessSessionId', 'claudeSessionId', 'transcriptPath']) {
        expect(key in ack, key).toBe(false);
      }
    }
  });

  test('a Codex daemon with no resolved session names itself, with a null id and no claudeSessionId', async () => {
    withPrimarySession();
    await connect(handlers({ harnessId: 'codex' }));
    const ack = acks()[0] as HelloAckMessage;
    expect(ack.harness).toBe('codex');
    expect(ack.harnessSessionId).toBeNull();
    expect('claudeSessionId' in ack).toBe(false);
  });

  test('a Claude daemon with no resolved session names itself, with a null id on both fields', async () => {
    withPrimarySession();
    await connect(handlers({ harnessId: 'claude' }));
    const ack = acks()[0] as HelloAckMessage;
    expect(ack.harness).toBe('claude');
    expect(ack.claudeSessionId).toBeNull();
    expect(ack.harnessSessionId).toBeNull();
  });

  test('the identity the resolver reports is what the ack and the re-sent question carry', async () => {
    const sessionId = withPrimarySession();
    const pending = generateId();
    sessionRegistry.addQuestion(sessionId, {
      id: pending,
      text: 'Allow Codex to run: ls',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    const h = handlers({
      harnessId: 'codex',
      current: () => ({
        sessionId,
        claudeSessionId: null,
        transcriptPath: null,
        identity: { harness: 'codex', harnessSessionId: THREAD },
      }),
    });

    await connect(h);

    const ack = acks()[0] as HelloAckMessage;
    expect(ack.harness).toBe('codex');
    expect(ack.harnessSessionId).toBe(THREAD);
    expect('claudeSessionId' in ack).toBe(false);
    const question = sent.find((m): m is QuestionMessage => m.type === 'question');
    expect(question?.question.id).toBe(pending);
    expect(question?.harness).toBe('codex');
    expect(question?.harnessSessionId).toBe(THREAD);
    expect(question).not.toHaveProperty('claudeSessionId');
  });

  test('a Claude identity rides on both ids of the ack and of the re-sent question', async () => {
    const sessionId = withPrimarySession();
    sessionRegistry.addQuestion(sessionId, {
      id: generateId(),
      text: 'Allow Bash: ls',
      options: [],
      allowsFreeText: false,
      isAnswered: false,
    });
    await connect(
      handlers({
        harnessId: 'claude',
        current: () => ({
          sessionId,
          claudeSessionId: CLAUDE,
          transcriptPath: '/p/t.jsonl',
          identity: identityFromClaudeId(CLAUDE),
        }),
      }),
    );
    const ack = acks()[0] as HelloAckMessage;
    expect([ack.claudeSessionId, ack.harnessSessionId, ack.harness]).toEqual([
      CLAUDE,
      CLAUDE,
      'claude',
    ]);
    const question = sent.find((m): m is QuestionMessage => m.type === 'question');
    expect([question?.claudeSessionId, question?.harnessSessionId, question?.harness]).toEqual([
      CLAUDE,
      CLAUDE,
      'claude',
    ]);
  });
});
