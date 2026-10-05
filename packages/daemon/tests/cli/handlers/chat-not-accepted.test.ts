/**
 * A session that does not take typed messages (#1177, review finding W1): a
 * Codex session in phase 3 has no screen reads and no decision channel, so the
 * chat guard's `promptUp` reads "nothing up" and a phone's `user_input` was
 * typed, plus Enter, into whatever the Codex TUI had focused (an approval
 * overlay, the Update modal). `acceptsTypedChat` says no first.
 *
 * These drive the REAL `createInputHandlers` over a real `SessionRegistry` and
 * binding store; the terminal is the same recording transport the other
 * handler tests use.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PROMPT_WAITING_ERROR_CODE,
  type ProtocolMessage,
  type UUID,
  generateId,
} from '@remi/shared';
import { createInputHandlers } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { CID, type PtyCapture, errorsOf, fakeMessageAPI, fakePTY } from './menu-test-helpers.ts';

describe('a session that does not take typed chat (#1177)', () => {
  let sessionRegistry: SessionRegistry;
  let bindingStore: SessionBindingStore;
  let tmpDir: string;
  let sent: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let logged: string[];
  let pty: PtyCapture;
  let sessionId: UUID;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-chat-not-accepted-'));
    bindingStore = new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json')));
    sent = [];
    logged = [];
    configureLogger({ writeLog: (line) => logged.push(line) });
    pty = { writes: [], submits: [] };
    sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(pty), fakeMessageAPI());
    sessionRegistry.attachConnection(sessionId, CID);
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function handlers(acceptsTypedChat?: (id: UUID) => boolean | undefined) {
    return createInputHandlers({
      sessionRegistry,
      bindingStore,
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
      ...(acceptsTypedChat ? { acceptsTypedChat } : {}),
    });
  }

  test('chat text is refused with PROMPT_WAITING, naming the bubble, and nothing is typed', async () => {
    const messageId = generateId();
    await handlers(() => false).onUserInput(
      CID,
      sessionId,
      'secret chat text',
      false,
      undefined,
      messageId,
    );

    expect(pty.submits).toEqual([]);
    expect(pty.writes).toEqual([]);
    const errors = errorsOf(sent);
    expect(errors).toHaveLength(1);
    // The web client only fails the bubble for this code.
    expect(errors[0]?.code).toBe(PROMPT_WAITING_ERROR_CODE);
    expect(errors[0]?.message).toBe(
      'This session does not take typed messages from the app yet; type in the terminal.',
    );
    expect(errors[0]?.details).toEqual({ sessionId, messageId });
    expect(sent[0]?.connectionId).toBe(CID);
  });

  test('raw input (an attach client, the Escape button, /interrupt) still reaches the terminal', async () => {
    await handlers(() => false).onUserInput(CID, sessionId, '\x1b', true);
    await handlers(() => false).onUserInput(CID, sessionId, 'q', true);

    expect(pty.writes).toEqual(['\x1b', 'q']);
    expect(pty.submits).toEqual([]);
    expect(errorsOf(sent)).toHaveLength(0);
  });

  test('nothing in the log carries the text, only its length (R6)', async () => {
    // The line that logs every user input runs before the refusal, so it is part of the claim.
    await handlers(() => false).onUserInput(CID, sessionId, 'sk-do-not-log-this', false);
    await handlers(() => false).onUserInput(CID, sessionId, 'sk-raw-do-not-log', true);
    const everything = logged.join('\n');
    expect(everything).not.toContain('sk-do-not-log-this');
    expect(everything).not.toContain('sk-raw-do-not-log');
    const refusal = logged.filter((l) => l.includes('refusing') && l.includes('chat'));
    expect(refusal).toHaveLength(1);
    expect(refusal[0]).toContain(`${'sk-do-not-log-this'.length} chars`);
    expect(logged.some((l) => l.includes(`${'sk-raw-do-not-log'.length} chars`))).toBe(true);
  });

  test('a session that does take chat still has its text in the log, as before', async () => {
    await handlers(() => true).onUserInput(CID, sessionId, 'plain chat text', false);
    expect(logged.some((l) => l.includes('plain chat text'))).toBe(true);
  });

  test('the dep is asked about this session, and true, undefined or no dep type as before', async () => {
    const asked: UUID[] = [];
    await handlers((id) => {
      asked.push(id);
      return true;
    }).onUserInput(CID, sessionId, 'one', false);
    await handlers(() => undefined).onUserInput(CID, sessionId, 'two', false);
    await handlers().onUserInput(CID, sessionId, 'three', false);

    expect(asked).toEqual([sessionId]);
    expect(pty.submits).toEqual(['one', 'two', 'three']);
    expect(errorsOf(sent)).toHaveLength(0);
  });
});
