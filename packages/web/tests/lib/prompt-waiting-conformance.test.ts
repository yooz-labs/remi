/**
 * Two-sided conformance test for the `PROMPT_WAITING` refusal (#1140, ADR 0014).
 *
 * The daemon refuses a structured `user_input` while Claude shows a numbered
 * menu (typed into it, the text is ignored and the Enter confirms the
 * highlighted option), and the web client marks the refused bubble failed from
 * the error's `details.messageId`. Each end alone proves nothing about the
 * other, so this drives BOTH shipping implementations over one real socket:
 *
 *   - daemon: the real `WebSocketAdapter`, the real `createInputHandlers`
 *     (wired through `trackerScreenDeps`, as `cli.ts` does) and a real
 *     `QuestionPresenceTracker` that observed the real captured Claude dialog
 *     through the real parser;
 *   - client: the real `WebSocketClient` sending a real `createUserInput`, and
 *     the real `promptWaitingRefusedMessageId` that `App.tsx` calls.
 *
 * Only the terminal is a double (it records what would reach the PTY), the
 * same boundary the daemon's own handler tests use. The `App.tsx` branch
 * around the helper (a `rejectSend` and a `setMessages`) is not constructible
 * from a test; it is a few lines that mirror the `SESSION_NOT_FOUND` branch
 * beside it.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import {
  PROMPT_WAITING_ERROR_CODE,
  PROMPT_WAITING_MESSAGE,
  createHello,
  createUserInput,
  generateId,
} from '@remi/shared';
import type { MessageAPI } from '../../../daemon/src/api/message-api.ts';
import { WebSocketAdapter } from '../../../daemon/src/adapters/websocket-adapter.ts';
import { QuestionPresenceTracker } from '../../../daemon/src/api/question-presence-tracker.ts';
import {
  createInputHandlers,
  trackerScreenDeps,
} from '../../../daemon/src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../daemon/src/cli/logger.ts';
import { parseQuestion } from '../../../daemon/src/parser/question-parser.ts';
import type { PTYSession } from '../../../daemon/src/pty/pty-session.ts';
import { SessionBindingStore } from '../../../daemon/src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../daemon/src/session/session-registry.ts';
import { SessionStore } from '../../../daemon/src/session/session-store.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../../../daemon/tests/parser/fixtures/claude-dialogs.ts';
import { reserveRange } from '../../../daemon/tests/session/port-test-helpers.ts';
import { promptWaitingRefusedMessageId } from '../../src/lib/prompt-waiting.ts';
import { WebSocketClient } from '../../src/lib/websocket-client.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!predicate() && Date.now() - start < timeoutMs) {
    await wait(10);
  }
  if (!predicate()) {
    throw new Error(`waitFor: condition not met within ${timeoutMs}ms`);
  }
}

describe('PROMPT_WAITING: real web client <-> real daemon handlers (#1140)', () => {
  let tmpDir: string;
  let registry: SessionRegistry;
  let adapter: WebSocketAdapter;
  let client: WebSocketClient;
  let tracker: QuestionPresenceTracker;
  let sessionId: UUID;
  const submits: string[] = [];
  const writes: string[] = [];
  const received: ProtocolMessage[] = [];

  beforeAll(async () => {
    configureLogger({ writeLog: () => {} });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-prompt-waiting-'));
    registry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    const bindingStore = new SessionBindingStore(
      new SessionStore(path.join(tmpDir, 'sessions.json')),
    );
    sessionId = registry.createSessionId();
    registry.registerSession(
      sessionId,
      '/test/dir',
      {
        id: generateId(),
        write: (content: string) => {
          writes.push(content);
        },
        submitInput: async (content: string) => {
          submits.push(content);
        },
        close: async () => {},
      } as unknown as PTYSession,
      { getFullBulletContent: () => null } as unknown as MessageAPI,
    );

    tracker = new QuestionPresenceTracker((q) => {
      registry.addQuestion(sessionId, q);
      return undefined;
    });

    // The daemon's reply path: `registry.sendRaw` in cli.ts lands on the
    // adapter that owns the connection.
    const port = await reserveRange(1);
    const reply: { adapter?: WebSocketAdapter } = {};
    const handlers = createInputHandlers({
      sessionRegistry: registry,
      bindingStore,
      send: (connectionId, message) => reply.adapter?.sendRaw(connectionId, message) ?? false,
      ...trackerScreenDeps((sid) => (sid === sessionId ? tracker : undefined)),
    });
    adapter = new WebSocketAdapter(
      { port },
      {
        onConnect: (connectionId) => {
          registry.attachConnection(sessionId, connectionId);
        },
        onUserInput: handlers.onUserInput,
      },
    );
    reply.adapter = adapter;
    await adapter.start();

    client = new WebSocketClient(
      // 'localhost', not '127.0.0.1' -- see message-dispatch-conformance.test.ts.
      { url: `ws://localhost:${port}/ws`, heartbeatInterval: 0, connectionTimeout: 2000 },
      { onMessage: (msg) => received.push(msg) },
    );
    client.connect();
    await waitFor(() => client.isConnected || client.isTransportOpen);
    client.send(createHello(generateId(), '0.0.0-test'));
    await waitFor(() => (registry.getSession(sessionId)?.attachedConnections.size ?? 0) > 0);
  });

  afterAll(async () => {
    client.disconnect();
    await adapter.stop();
    __resetLoggerForTests();
    await registry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function errorsFor(code: string, since: number) {
    return received
      .slice(since)
      .filter((m): m is Extract<ProtocolMessage, { type: 'error' }> => m.type === 'error')
      .filter((m) => m.code === code);
  }

  test('chat text sent while the real Claude menu is observed: nothing typed, the client reads which bubble failed', async () => {
    const parsed = parseQuestion(WRAPPED_DIRECTORY_DIALOG);
    if (!parsed.question) throw new Error('the captured dialog did not parse as a prompt');
    tracker.onPTYPromptVisible(parsed.question);
    const messageId = generateId();
    const before = received.length;

    client.send(createUserInput(sessionId, 'please use rm -i', undefined, undefined, messageId));
    await waitFor(() => errorsFor(PROMPT_WAITING_ERROR_CODE, before).length > 0);

    expect(submits).toEqual([]);
    expect(writes).toEqual([]);
    const error = errorsFor(PROMPT_WAITING_ERROR_CODE, before)[0];
    expect(error?.message).toBe(PROMPT_WAITING_MESSAGE);
    // The web side reads the daemon side's details.
    expect(promptWaitingRefusedMessageId(error ?? {})).toBe(messageId);
    // The daemon also acked it before deciding, which is why the bubble needs
    // the failure; the ack is not an error.
    expect(received.slice(before).some((m) => m.type === 'ack')).toBe(true);
  });

  test('a raw Escape from the client reaches the terminal while the menu is up', async () => {
    const before = received.length;

    client.send(createUserInput(sessionId, '\x1b', true));
    await waitFor(() => writes.length > 0);

    expect(writes).toEqual(['\x1b']);
    expect(errorsFor(PROMPT_WAITING_ERROR_CODE, before)).toHaveLength(0);
  });

  test('once the menu is gone the same chat text is typed and no error comes back', async () => {
    tracker.onStatusChange('thinking');
    const before = received.length;

    client.send(createUserInput(sessionId, 'now it is typed', undefined, undefined, generateId()));
    await waitFor(() => submits.length > 0);

    expect(submits).toEqual(['now it is typed']);
    await wait(50);
    expect(errorsFor(PROMPT_WAITING_ERROR_CODE, before)).toHaveLength(0);
  });

  describe('promptWaitingRefusedMessageId reads only PROMPT_WAITING errors that name a message', () => {
    test('another error code, even with a messageId, is not this refusal', () => {
      expect(
        promptWaitingRefusedMessageId({ code: 'SESSION_NOT_FOUND', details: { messageId: 'm' } }),
      ).toBeUndefined();
    });

    test('PROMPT_WAITING with no messageId (a client that sent none) names nothing', () => {
      expect(
        promptWaitingRefusedMessageId({ code: PROMPT_WAITING_ERROR_CODE, details: { sessionId: 's' } }),
      ).toBeUndefined();
      expect(promptWaitingRefusedMessageId({ code: PROMPT_WAITING_ERROR_CODE })).toBeUndefined();
    });

    test('a malformed messageId is ignored', () => {
      expect(
        promptWaitingRefusedMessageId({ code: PROMPT_WAITING_ERROR_CODE, details: { messageId: 7 } }),
      ).toBeUndefined();
      expect(
        promptWaitingRefusedMessageId({ code: PROMPT_WAITING_ERROR_CODE, details: { messageId: '' } }),
      ).toBeUndefined();
    });
  });
});
