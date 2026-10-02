/**
 * The chat guard (#1140) driven from where its bugs lived: the REAL
 * `OutputProcessor` parsing PTY bytes, feeding the REAL
 * `QuestionPresenceTracker`, read by the REAL `createInputHandlers`
 * (`trackerScreenDeps`, the wiring `cli.ts` uses). The callbacks below mirror
 * `cli.ts`'s for a session with no hook server (`onQuestion` ->
 * `tracker.onPTYPromptVisible`, `onStatusChange` -> `tracker.onStatusChange`
 * with no agent, since a PTY-parsed status names none). The terminal is the
 * only double.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { ProtocolMessage, UUID } from '@remi/shared';
import { PROMPT_WAITING_ERROR_CODE } from '@remi/shared';
import { QuestionPresenceTracker } from '../../../src/api/question-presence-tracker.ts';
import { createInputHandlers, trackerScreenDeps } from '../../../src/cli/handlers/input-events.ts';
import { __resetLoggerForTests, configureLogger } from '../../../src/cli/logger.ts';
import { OutputProcessor } from '../../../src/parser/output-processor.ts';
import { SessionBindingStore } from '../../../src/session/session-binding-store.ts';
import { SessionRegistry } from '../../../src/session/session-registry.ts';
import { SessionStore } from '../../../src/session/session-store.ts';
import { WRAPPED_DIRECTORY_DIALOG } from '../../parser/fixtures/claude-dialogs.ts';
import { CID, type PtyCapture, errorsOf, fakeMessageAPI, fakePTY } from './menu-test-helpers.ts';

describe('chat guard driven by the real OutputProcessor (#1140)', () => {
  let sessionRegistry: SessionRegistry;
  let tmpDir: string;
  let sent: Array<{ connectionId: UUID; message: ProtocolMessage }>;
  let pty: PtyCapture;
  let sessionId: UUID;
  let tracker: QuestionPresenceTracker;
  let processor: OutputProcessor;
  let handlers: ReturnType<typeof createInputHandlers>;

  beforeEach(() => {
    sessionRegistry = new SessionRegistry({ orphanTimeoutMs: 1000 });
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'remi-chat-guard-op-'));
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
    processor = new OutputProcessor(
      { sessionId, streamStatusOnly: true },
      {
        onMessage: () => {},
        onQuestion: (question) => tracker.onPTYPromptVisible(question),
        onStatusChange: (status) => tracker.onStatusChange(status),
      },
    );
    handlers = createInputHandlers({
      sessionRegistry,
      bindingStore: new SessionBindingStore(new SessionStore(path.join(tmpDir, 'sessions.json'))),
      send: (connectionId, message) => {
        sent.push({ connectionId, message });
        return true;
      },
      ...trackerScreenDeps((sid) => (sid === sessionId ? tracker : undefined)),
    });
  });

  afterEach(async () => {
    __resetLoggerForTests();
    await sessionRegistry.shutdown();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Feed PTY output and let the processor parse it. */
  function screen(bytes: string): void {
    processor.process(bytes);
    processor.flush();
  }

  const observedValues = () => tracker.observedPromptOptions()?.map((o) => o.value) ?? null;

  describe('which observed prompts refuse chat', () => {
    test('a numbered selection box refuses', async () => {
      screen(WRAPPED_DIRECTORY_DIALOG);
      expect(observedValues()).toEqual(['1', '2', '3']);

      await handlers.onUserInput(CID, sessionId, 'use rm -i instead', false);

      expect(pty.submits).toEqual([]);
      const errors = errorsOf(sent);
      expect(errors).toHaveLength(1);
      expect(errors[0]?.code).toBe(PROMPT_WAITING_ERROR_CODE);
    });

    test('a subprocess (y/n) prompt is observed with options y/n and still takes chat text', async () => {
      screen('Overwrite existing file? (y/n) ');
      expect(observedValues()).toEqual(['y', 'n']);

      await handlers.onUserInput(CID, sessionId, 'y', false);

      expect(pty.submits).toEqual(['y']);
      expect(errorsOf(sent)).toHaveLength(0);
    });

    test('Claude prose ending in (y/n) stays typeable too', async () => {
      screen('The lockfile is out of date, so I can regenerate it. Should I go ahead? (y/n) ');
      expect(observedValues()).toEqual(['y', 'n']);

      await handlers.onUserInput(CID, sessionId, 'yes, but keep the old one', false);

      expect(pty.submits).toEqual(['yes, but keep the old one']);
      expect(errorsOf(sent)).toHaveLength(0);
    });

    test('a free-text waiting prompt observes no options and takes chat text', async () => {
      screen('Please enter your response: ');
      expect(observedValues()).toEqual([]);

      await handlers.onUserInput(CID, sessionId, 'my answer', false);

      expect(pty.submits).toEqual(['my answer']);
      expect(errorsOf(sent)).toHaveLength(0);
    });
  });
});
