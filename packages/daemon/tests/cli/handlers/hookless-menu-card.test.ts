/**
 * #1140: a hook-less prompt (an agent-team permission, or any session with no
 * hook record) keeps the PARSER's card, whose `allowsFreeText` used to be true
 * for every Claude selection box. That let `handleAnswer` type free text into
 * the menu, where Claude ignores it and the Enter confirms the highlighted
 * option. The parser now says a selection box takes a pick, so the existing
 * `free-text-into-menu` guard (#1134) covers these cards.
 *
 * Real tracker, real parser, real handlers (`trackerScreenDeps` is the wiring
 * `cli.ts` uses); the terminal is a recording double.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { createInputHandlers, trackerScreenDeps } from '../../../src/cli/handlers/input-events.ts';
import { promptUpDeps } from '../../../src/cli/handlers/prompt-up.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import {
  CID,
  type PtyCapture,
  claudeMenu,
  errorsOf,
  fakeMessageAPI,
  fakePTY,
} from './menu-test-helpers.ts';

describe('hook-less card from the parser (#1140)', () => {
  let sessionRegistry: SessionRegistry;
  let tmpDir: string;
  let sent: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let pty: PtyCapture;
  let sessionId: UUID;
  let tracker: QuestionPresenceTracker;
  let handlers: ReturnType<typeof createInputHandlers>;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-hookless-card-'));
    sent = [];
    configureLogger({ writeLog: () => {} });
    pty = { writes: [], submits: [] };
    sessionId = sessionRegistry.createSessionId();
    sessionRegistry.registerSession(sessionId, '/test/dir', fakePTY(pty), fakeMessageAPI());
    sessionRegistry.attachConnection(sessionId, CID);
    tracker = new QuestionPresenceTracker((q) => {
      sessionRegistry.addQuestion(sessionId, q);
      return undefined;
    });
    handlers = createInputHandlers({
      sessionRegistry,
      bindingStore: new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json'))),
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
      ...trackerScreenDeps((sid) => (sid === sessionId ? tracker : undefined)),
      ...promptUpDeps(
        () => undefined,
        (sid) => (sid === sessionId ? tracker : undefined),
      ),
    });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function registeredCard() {
    const card = [...(sessionRegistry.getSession(sessionId)?.currentQuestions.values() ?? [])][0];
    if (!card) throw new Error('the hook-less card was not registered');
    return card;
  }

  test('the parsed menu takes no free text, and the tracker pushes it that way', () => {
    const question = claudeMenu();
    expect(question.allowsFreeText).toBe(false);

    tracker.onPTYPromptVisible(question);

    expect(registeredCard().source).toBe('pty');
    expect(registeredCard().allowsFreeText).toBe(false);
  });

  test('free text answered on it is refused by the existing free-text-into-menu guard', async () => {
    tracker.onPTYPromptVisible(claudeMenu());
    const card = registeredCard();
    const logs: string[] = [];
    configureLogger({ writeLog: (msg) => logs.push(msg) });

    await handlers.onAnswer(CID, sessionId, card.id as UUID, 'no, use rm -i instead');

    expect(pty.submits).toEqual([]);
    const errors = errorsOf(sent);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.code).toBe('STALE_ANSWER');
    expect(logs.some((m) => m.includes('free-text-into-menu; 21 characters'))).toBe(true);
  });

  test('an option answered on that card still types its digit', async () => {
    tracker.onPTYPromptVisible(claudeMenu());
    const card = registeredCard();

    await handlers.onAnswer(CID, sessionId, card.id as UUID, '3');

    expect(pty.submits).toEqual(['3']);
    expect(errorsOf(sent)).toHaveLength(0);
  });
});
